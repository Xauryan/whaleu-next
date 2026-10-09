import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { RatingRandomDraw } from '../../src/ratings/random/draw.js';
import {
  ratingRuntimeFixture,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';

test('R3R normal HTTP samples complete descendant pool and exact score eligibility', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    noPhone = await f.actor({ phone: 'unverified' });
  const c = await f.catalog(owner, { count: 3, depth: 3 });
  const select = (query: Record<string, unknown> = {}, actor = owner) =>
    f
      .auth(request(f.http).get('/v1/ratings/random-target'), actor)
      .query({ categoryId: c.rootId, ...query });
  assert.equal(
    (
      await request(f.http)
        .get('/v1/ratings/random-target')
        .query({ categoryId: c.rootId })
    ).status,
    401,
  );
  assert.equal(
    (await select({}, noPhone)).body.error.code,
    'PHONE_VERIFICATION_REQUIRED',
  );
  const initial = await select();
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.candidateCount, 3);
  assert.equal(initial.body.context.campusId, null);
  assert.equal(initial.body.item.regionId, null);
  assert.ok(
    c.targets.some((target) => target.id === initial.body.item.target.id),
  );
  assert.equal(initial.body.item.target.categoryId, c.categoryId);
  assert.equal(initial.body.item.summary.count, 0);
  assert.equal(initial.headers['cache-control'], 'no-store');
  const zero = await select({ minimumAverage: 1 });
  assert.equal(zero.status, 200, JSON.stringify(zero.body));
  assert.equal(zero.body.candidateCount, 0);
  assert.equal(zero.body.item, null);
  const target = c.targets[1]!;
  const score = await f
    .auth(
      request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
      owner,
    )
    .send({
      clientRequestId: randomUUID(),
      regionId: null,
      expectedTargetRevision: target.revision,
      expectedRevision: null,
      score: 4,
    });
  assert.equal(score.status, 200, JSON.stringify(score.body));
  const exact = await select({ minimumAverage: 4 });
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  assert.equal(exact.body.candidateCount, 1);
  assert.equal(exact.body.item.target.id, target.id);
  assert.equal((await select({ minimumAverage: 4.1 })).body.item, null);
  await setRatingReviewState(f.pool, c.targets[0]!.approval.decisionId, 'held');
  assert.equal((await select()).body.candidateCount, 2);
  for (const query of [
    { limit: 1 },
    { regionId: randomUUID() },
    { minimumAverage: '4e0' },
    { campusId: randomUUID() },
  ]) {
    const result = await select(query);
    assert.notEqual(result.status, 200, JSON.stringify(result.body));
  }
});
test('R3R unknown coverage is retained without threshold and blocks the whole filtered pool', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor();
  const c = await f.catalog(owner, { count: 2, baseline: false });
  const get = (minimumAverage?: number) =>
    f.auth(request(f.http).get('/v1/ratings/random-target'), owner).query({
      categoryId: c.rootId,
      ...(minimumAverage === undefined ? {} : { minimumAverage }),
    });
  const unfiltered = await get();
  assert.equal(unfiltered.status, 200, JSON.stringify(unfiltered.body));
  assert.equal(unfiltered.body.candidateCount, 2);
  assert.equal(unfiltered.body.item.summary.status, 'unavailable');
  assert.equal(unfiltered.body.item.target.allowedActions.setScore, false);
  const filtered = await get(1);
  assert.equal(filtered.body.error.code, 'RATING_SCORE_UNAVAILABLE');
  assert.equal(filtered.body.item, undefined);
});
test('R3R complete pool reaches the last of 1001 and 2048 targets beyond the first page', async (t) => {
  for (const size of [1001, 2048])
    await t.test(`${size} complete candidates`, async (t) => {
      const f = await ratingRuntimeFixture();
      t.after(() => f.close());
      const owner = await f.actor();
      const catalog = await f.catalog(owner, { count: size, depth: 3 });
      const draw = f.app.get(RatingRandomDraw);
      const original = draw.index.bind(draw);
      const requested: number[] = [];
      draw.index = (maximum) => {
        requested.push(maximum);
        return maximum - 1;
      };
      t.after(() => {
        draw.index = original;
      });
      const result = await f
        .auth(request(f.http).get('/v1/ratings/random-target'), owner)
        .query({ categoryId: catalog.rootId });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.candidateCount, size);
      assert.deepEqual(requested, [size]);
      assert.equal(
        result.body.item.target.id,
        catalog.targets
          .map((target) => target.id)
          .sort()
          .at(-1),
      );
      const detail = await f.auth(
        request(f.http).get(
          `/v1/ratings/targets/${result.body.item.target.id}`,
        ),
        owner,
      );
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
      assert.deepEqual(result.body.item.target, detail.body);
      if (size === 2048) {
        const ordered = [...catalog.targets].sort((a, b) =>
          a.id.localeCompare(b.id),
        );
        for (const target of ordered.slice(0, 128))
          await setRatingReviewState(
            f.pool,
            target.approval.decisionId,
            'held',
          );
        draw.index = (maximum) => {
          assert.equal(maximum, size - 128);
          return 0;
        };
        const afterDeny = await f
          .auth(request(f.http).get('/v1/ratings/random-target'), owner)
          .query({ categoryId: catalog.rootId });
        assert.equal(afterDeny.status, 200, JSON.stringify(afterDeny.body));
        assert.equal(afterDeny.body.candidateCount, size - 128);
        assert.equal(afterDeny.body.item.target.id, ordered[128]!.id);
      }
    });
});
