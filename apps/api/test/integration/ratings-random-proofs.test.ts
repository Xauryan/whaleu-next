import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ratingRuntimeFixture } from '../support/rating-runtime-fixture.js';
import { RatingCompletePoolRepository } from '../../src/ratings/random/complete-pool.repository.js';

test('R3R rejects unselected score threshold changes and ABA after the complete scan', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor();
  const catalog = await f.catalog(owner, { count: 3 });
  const target = catalog.targets[0]!;
  const score = async (value: number, revision: string | null) => {
    const result = await f
      .auth(
        request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
        owner,
      )
      .send({
        clientRequestId: randomUUID(),
        regionId: null,
        expectedTargetRevision: target.revision,
        expectedRevision: revision,
        score: value,
      });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.outcome, 'applied', JSON.stringify(result.body));
    return result.body.revision as string;
  };
  let revision = await score(1, null);
  const pool = f.app.get(RatingCompletePoolRepository);
  const complete = pool.complete.bind(pool);
  for (const aba of [false, true]) {
    let once = false;
    pool.complete = async (handle, tx) => {
      if (!once) {
        once = true;
        revision = await score(5, revision);
        if (aba) revision = await score(1, revision);
      }
      return complete(handle, tx);
    };
    const result = await f
      .auth(request(f.http).get('/v1/ratings/random-target'), owner)
      .query({ categoryId: catalog.rootId, minimumAverage: 4 });
    assert.equal(
      result.body.error.code,
      'RATING_UNAVAILABLE',
      JSON.stringify(result.body),
    );
    assert.equal(result.body.item, undefined);
    pool.complete = complete;
    if (!aba) revision = await score(1, revision);
  }
  const stable = await f
    .auth(request(f.http).get('/v1/ratings/random-target'), owner)
    .query({ categoryId: catalog.rootId, minimumAverage: 4 });
  assert.equal(stable.status, 200, JSON.stringify(stable.body));
  assert.equal(stable.body.candidateCount, 0);
});

test('R3R final fences reject in-flight unselected score and binding writers without blocking', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    catalog = await f.catalog(owner, { count: 2 });
  const pool = f.app.get(RatingCompletePoolRepository),
    complete = pool.complete.bind(pool);
  for (const statement of [
    'UPDATE whaleu_ratings.scores SET score=score WHERE false',
    'UPDATE whaleu_community.rating_approval_bindings SET digest=digest WHERE false',
  ]) {
    const holder = await f.pool.connect();
    await holder.query('BEGIN');
    let once = false;
    pool.complete = async (handle, tx) => {
      await complete(handle, tx);
      if (!once) {
        once = true;
        await holder.query(statement);
      }
    };
    try {
      const result = await f
        .auth(request(f.http).get('/v1/ratings/random-target'), owner)
        .query({ categoryId: catalog.rootId })
        .timeout({ deadline: 5000 });
      assert.equal(result.status, 503, JSON.stringify(result.body));
      assert.ok(
        ['RATING_UNAVAILABLE', 'CONTENT_REVIEW_UNAVAILABLE'].includes(
          result.body.error.code,
        ),
      );
      assert.equal(result.body.item, undefined);
    } finally {
      pool.complete = complete;
      await holder.query('ROLLBACK');
      holder.release();
    }
  }
});

test('R3R epoch mutations and truncation cannot manufacture or erase proof', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  for (const table of [
    'whaleu_ratings.random_pool_epoch',
    'whaleu_community.rating_review_binding_epoch',
  ]) {
    for (const statement of [
      `UPDATE ${table} SET epoch=epoch+1`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table}`,
    ])
      await assert.rejects(f.pool.query(statement));
    const rows = (
      await f.pool.query(`SELECT singleton,version,epoch::text FROM ${table}`)
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].singleton, true);
    assert.equal(rows[0].version, 1);
  }
});

test('R3R authority writer waits for Safety before pool epoch, so an already-authorized normal score can finish', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    catalog = await f.catalog(owner),
    target = catalog.targets[0]!;
  const { RatingsRepository } = await import('../../src/ratings/repository.js');
  const records = f.app.get(RatingsRepository),
    original = records.setScore.bind(records);
  let entered!: () => void, resume!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumePromise = new Promise<void>((resolve) => {
    resume = resolve;
  });
  records.setScore = async (...args) => {
    entered();
    await resumePromise;
    return original(...args);
  };
  const score = f
    .auth(
      request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
      owner,
    )
    .send({
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: target.revision,
      expectedRevision: null,
      score: 5,
    })
    .timeout({ deadline: 5000 })
    .then((response) => response);
  const authority = await f.pool.connect();
  let writer: Promise<unknown> | undefined;
  try {
    await enteredPromise;
    await authority.query('BEGIN');
    await authority.query("SET LOCAL lock_timeout='3s'");
    const pid = (
      await authority.query<{ pid: number }>('SELECT pg_backend_pid() pid')
    ).rows[0]!.pid;
    writer = authority.query(
      'UPDATE whaleu_ratings.targets SET active=active WHERE false',
    );
    // Observe the real PostgreSQL barrier instead of assuming a sleep means
    // the conflicting writer reached its lock. The normal score already holds
    // shared Safety and is paused immediately before its causal score write.
    const deadline = Date.now() + 2000;
    while (true) {
      const blocked = (
        await f.pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) waiting",
          [pid],
        )
      ).rows[0]!.waiting;
      if (blocked) break;
      if (Date.now() >= deadline)
        assert.fail('authority writer did not reach Safety barrier');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    resume();
    const response = await score;
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'applied',
      JSON.stringify(response.body),
    );
    await writer;
    await authority.query('ROLLBACK');
  } finally {
    records.setScore = original;
    resume();
    await writer?.catch(() => undefined);
    await authority.query('ROLLBACK');
    authority.release();
  }
});
