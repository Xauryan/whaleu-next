/** Successor-only real PostgreSQL contention tests. No sleeps, mocked SQL,
 * disabled guards, or synthetic source inserts. Run only in the serialized
 * disposable whaleu_test lane alongside account-deletion-follow-social. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { CommunitySocialSourceFacade } from '../../src/community/social-source/facade.js';
import { SocialUpdatesCursors } from '../../src/notifications/social/cursor.js';
import { COOLING_MS } from '../../src/account-deletion/contracts.js';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
import {
  accountDeletionFollowSocialFixture,
  deletionRequest,
} from '../support/account-deletion-follow-social-fixture.js';
import type { AccountDeletionFollowSocialFixture } from '../support/account-deletion-follow-social-fixture.js';

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nowait = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  error.code === '55P03' &&
  !/timeout|deadlock/i.test(error.message);

async function phase(f: AccountDeletionFollowSocialFixture, id: string) {
  return (
    (
      await f.pool.query<{ phase: number }>(
        'SELECT phase FROM whaleu_account_deletion.follow_scopes WHERE request_id=$1',
        [id],
      )
    ).rows[0]?.phase ?? 0
  );
}
async function advanceTo(
  f: AccountDeletionFollowSocialFixture,
  id: string,
  wanted: number,
) {
  for (let n = 0; n < 30; n++) {
    const current = await phase(f, id);
    if (current === wanted) return;
    assert.ok(
      current < wanted,
      `Skipped populated phase ${wanted}: ${current}`,
    );
    await f.worker.tick(id);
  }
  assert.fail(`Could not reach phase ${wanted}`);
}
// A whole-table snapshot is deliberate in this small isolated race fixture:
// it catches peer revision, unrelated notice and evidence mutations as well.
async function snapshot(f: AccountDeletionFollowSocialFixture) {
  const result: Record<string, unknown[]> = {};
  for (const relation of [
    'whaleu_identity.accounts',
    'whaleu_account_deletion.requests',
    'whaleu_account_deletion.owner_causes',
    'whaleu_account_deletion.owner_receipts',
    'whaleu_account_deletion.follow_scopes',
    'whaleu_account_deletion.follow_pages',
    'whaleu_account_deletion.follow_mutations',
    'whaleu_account_deletion.follow_head_advances',
    'whaleu_account_deletion.follow_source_intents',
    'whaleu_account_deletion.follow_source_retirements',
    'whaleu_account_deletion.follow_source_erasures',
    'whaleu_community.user_follows',
    'whaleu_community.follow_heads',
    'whaleu_community.follow_requests',
    'whaleu_community.social_sources',
    'whaleu_community.discovery_cursors',
    'whaleu_notifications.social_work',
    'whaleu_notifications.social_receipts',
    'whaleu_notifications.social_notices',
    'whaleu_notifications.owners',
  ])
    result[relation] = (
      await f.pool.query(
        `SELECT to_jsonb(t)::text row FROM ${relation} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  return result;
}
async function held(
  f: AccountDeletionFollowSocialFixture,
  lock: (tx: PoolClient) => Promise<unknown>,
  action: () => Promise<void>,
) {
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN');
    await lock(tx); // Completion is the acquisition barrier, not elapsed time.
    await action();
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
}

async function graph(f: AccountDeletionFollowSocialFixture) {
  const owner = await f.create(),
    first = await f.create(),
    second = await f.create();
  const profile = await f.profile(owner),
    peer = await f.profile(first);
  await f.following.set(first.accessToken, profile, true, randomUUID());
  await f.following.set(second.accessToken, profile, true, randomUUID());
  const incoming = await f.sources(null, owner);
  await f.settle(incoming.map((row) => row.id));
  await f.following.set(owner.accessToken, peer, true, randomUUID());
  const outgoing = (await f.sources(owner, first))[0]!;
  const page = await f.socialReads.list(owner.accessToken, {
    category: 'followers',
    limit: 1,
  });
  assert.ok(page.nextCursor);
  const command = deletionRequest();
  await f.service.request(f.assertion(owner), command);
  await f.advance(COOLING_MS);
  return {
    owner,
    first,
    incoming,
    outgoing,
    cursor: page.nextCursor,
    id: command.requestId,
  };
}

test(
  '0173 deterministic held-lock rollback, late worker and cursor races',
  { timeout: 900000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture();
    t.after(() => f.close());
    for (const kind of [
      'peer-lifecycle',
      'peer-head',
      'source',
      'owner',
      'notice',
      'retirement-work',
      'cursor-quota',
    ] as const) {
      await t.test(
        `held ${kind} returns NOWAIT without advancing any progress`,
        async () => {
          const g = await graph(f);
          const wanted = {
            'peer-lifecycle': 0,
            'peer-head': 0,
            source: 2,
            owner: 3,
            notice: 4,
            'retirement-work': 7,
            'cursor-quota': 9,
          }[kind];
          await advanceTo(f, g.id, wanted);
          const before = await snapshot(f);
          await held(
            f,
            async (tx) => {
              if (kind === 'peer-lifecycle')
                return tx.query(
                  'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE',
                  [g.first.accountId],
                );
              if (kind === 'peer-head')
                return tx.query(
                  'SELECT account_id FROM whaleu_community.follow_heads WHERE account_id=$1 FOR UPDATE',
                  [g.first.accountId],
                );
              if (kind === 'source')
                return tx.query(
                  'SELECT id FROM whaleu_community.social_sources WHERE id=$1 FOR UPDATE',
                  [g.incoming[0]!.id],
                );
              if (kind === 'owner')
                return tx.query(
                  'SELECT account_id FROM whaleu_notifications.owners WHERE account_id=$1 FOR UPDATE',
                  [g.owner.accountId],
                );
              if (kind === 'notice')
                return tx.query(
                  'SELECT id FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1 FOR UPDATE',
                  [g.owner.accountId],
                );
              if (kind === 'retirement-work')
                return tx.query(
                  'SELECT source_id FROM whaleu_notifications.social_work WHERE source_id=$1 FOR UPDATE',
                  [g.outgoing.id],
                );
              return tx.query(
                'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
                [
                  `whaleu:discovery:quota:v1:${discoveryCursorBucket(g.owner.accountId).hash}`,
                ],
              );
            },
            async () => {
              await assert.rejects(f.worker.tick(g.id), nowait);
              assert.deepEqual(await snapshot(f), before);
            },
          );
          // Lock release, not timing, allows the exact same page to retry.
          await f.complete(g.id);
          assert.equal(await phase(f, g.id), 11);
        },
      );
    }
    await t.test(
      'late worker cannot rematerialize incoming intent or retired outgoing work; old cursor cannot restore history',
      async () => {
        const g = await graph(f);
        await advanceTo(f, g.id, 3); // Incoming intents committed, receipts still present.
        const before = await snapshot(f);
        const late = await f.socialWorker.run({
          mode: 'apply',
          sourceIds: g.incoming.map((row) => row.id),
        });
        assert.equal(late.retryable, g.incoming.length);
        assert.equal(late.materialized, 0);
        assert.deepEqual(await snapshot(f), before);
        await assert.rejects(
          f.socialReads.list(g.owner.accessToken, {
            category: 'followers',
            limit: 1,
            cursor: g.cursor,
          }),
        );
        await f.complete(g.id);
        const after = await snapshot(f);
        const replay = await f.socialWorker.run({
          mode: 'apply',
          sourceIds: [...g.incoming.map((row) => row.id), g.outgoing.id],
        });
        assert.equal(replay.missing, g.incoming.length);
        assert.equal(replay.alreadyProcessed, 1);
        assert.equal(replay.materialized, 0);
        assert.equal(replay.retryable, 0);
        await assert.rejects(
          f.socialReads.list(g.owner.accessToken, {
            category: 'followers',
            limit: 1,
            cursor: g.cursor,
          }),
        );
        assert.deepEqual(await snapshot(f), after);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1',
              [discoveryCursorBucket(g.owner.accountId).hash],
            )
          ).rowCount,
          0,
        );
      },
    );
  },
);

test(
  '0173 simultaneous peer deletion holds both own lifecycle fences before either progresses',
  { timeout: 900000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture();
    t.after(() => f.close());
    const a = await f.create(),
      b = await f.create();
    const pa = await f.profile(a),
      pb = await f.profile(b);
    await f.following.set(a.accessToken, pb, true, randomUUID());
    await f.following.set(b.accessToken, pa, true, randomUUID());
    const sources = [
      ...(await f.sources(a, b)),
      ...(await f.sources(b, a)),
    ].map((row) => row.id);
    await f.settle(sources);
    const ca = deletionRequest(),
      cb = deletionRequest();
    await f.service.request(f.assertion(a), ca);
    await f.service.request(f.assertion(b), cb);
    await f.advance(COOLING_MS);
    const lockAccount = f.repository.lockAccount.bind(f.repository);
    const ready = barrier();
    let arrived = 0;
    f.repository.lockAccount = async (tx, account) => {
      const row = await lockAccount(tx, account);
      if (account === a.accountId || account === b.accountId) {
        if (++arrived === 2) ready.resolve();
        await ready.promise;
      }
      return row;
    };
    let results: PromiseSettledResult<
      Awaited<ReturnType<typeof f.worker.tick>>
    >[];
    try {
      results = await Promise.allSettled([
        f.worker.tick(ca.requestId),
        f.worker.tick(cb.requestId),
      ]);
    } finally {
      f.repository.lockAccount = lockAccount;
    }
    assert.equal(
      arrived,
      2,
      'Both real transactions acquired their own lifecycle rows',
    );
    assert.ok(
      results.some((result) => result.status === 'rejected'),
      'Competing fences must retry, never wait in a cycle',
    );
    for (const result of results)
      if (result.status === 'rejected')
        assert.ok(nowait(result.reason), String(result.reason));
    await f.complete(ca.requestId);
    await f.complete(cb.requestId);
    for (const id of [ca.requestId, cb.requestId]) {
      assert.equal(
        (
          await f.pool.query<{ complete: boolean }>(
            'SELECT whaleu_account_deletion.follow_social_complete($1) complete',
            [id],
          )
        ).rows[0]?.complete,
        true,
      );
    }
    for (const relation of [
      'whaleu_community.social_sources',
      'whaleu_notifications.social_work',
      'whaleu_notifications.social_receipts',
      'whaleu_notifications.social_notices',
    ]) {
      assert.equal(
        (await f.pool.query(`SELECT 1 FROM ${relation}`)).rowCount,
        0,
        relation,
      );
    }
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_community.user_follows'))
        .rowCount,
      0,
    );
    const replay = await f.socialWorker.run({
      mode: 'apply',
      sourceIds: sources,
    });
    assert.equal(replay.missing, sources.length);
    assert.equal(replay.retryable, 0);
  },
);

test(
  '0173 worker located before recipient deletion cannot recreate erased history',
  { timeout: 900000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture();
    t.after(() => f.close());
    const actor = await f.create(),
      recipient = await f.create();
    await f.following.set(
      actor.accessToken,
      await f.profile(recipient),
      true,
      randomUUID(),
    );
    const source = (await f.sources(actor, recipient))[0]!;
    const facade = f.app.get(CommunitySocialSourceFacade);
    const locate = facade.locate.bind(facade);
    const located = barrier(),
      resume = barrier();
    let heldOnce = false;
    facade.locate = async (id, tx) => {
      const result = await locate(id, tx);
      if (id === source.id && !heldOnce) {
        heldOnce = true;
        assert.ok(result);
        located.resolve();
        await resume.promise;
      }
      return result;
    };
    const late = f.socialWorker.run({ mode: 'apply', sourceIds: [source.id] });
    try {
      await Promise.race([
        located.promise,
        late.then(() => {
          throw new Error('Worker exited before locator barrier');
        }),
      ]);
      const command = deletionRequest();
      await f.service.request(f.assertion(recipient), command);
      await f.advance(COOLING_MS);
      await f.complete(command.requestId);
      const before = await snapshot(f);
      resume.resolve();
      const result = await late;
      assert.equal(result.missing, 1);
      assert.equal(result.retryable, 0);
      assert.equal(result.materialized, 0);
      assert.deepEqual(await snapshot(f), before);
    } finally {
      resume.resolve();
      facade.locate = locate;
      await late;
    }
  },
);

test(
  '0173 cursor resolved before actor deletion reprojects retained notice after retirement',
  { timeout: 900000 },
  async (t) => {
    const f = await accountDeletionFollowSocialFixture();
    t.after(() => f.close());
    const actor = await f.create(),
      recipient = await f.create(),
      newer = await f.create();
    const profile = await f.profile(recipient);
    await f.following.set(actor.accessToken, profile, true, randomUUID());
    const source = (await f.sources(actor, recipient))[0]!;
    await f.settle([source.id]);
    const notice = (await f.sources(actor, recipient))[0]!.notice_id!;
    const read = await f.socialReads.markRead(
      recipient.accessToken,
      notice,
      'followers',
    );
    await f.following.set(newer.accessToken, profile, true, randomUUID());
    await f.settle((await f.sources(newer, recipient)).map((row) => row.id));
    const first = await f.socialReads.list(recipient.accessToken, {
      category: 'followers',
      limit: 1,
    });
    assert.ok(first.nextCursor);
    assert.notEqual(first.items[0]?.noticeId, notice);
    const cursors = f.app.get(SocialUpdatesCursors),
      get = cursors.get.bind(cursors);
    const resolved = barrier(),
      resume = barrier();
    cursors.get = async (cursor, scope, tx) => {
      const position = await get(cursor, scope, tx);
      resolved.resolve();
      await resume.promise;
      return position;
    };
    const reading = f.socialReads.list(recipient.accessToken, {
      category: 'followers',
      limit: 1,
      cursor: first.nextCursor,
    });
    try {
      await Promise.race([
        resolved.promise,
        reading.then(() => {
          throw new Error('Reader exited before cursor barrier');
        }),
      ]);
      const command = deletionRequest();
      await f.service.request(f.assertion(actor), command);
      await f.advance(COOLING_MS);
      await f.complete(command.requestId);
      resume.resolve();
      const page = await reading;
      assert.equal(page.items.length, 1);
      assert.deepEqual(page.items[0], {
        noticeId: notice,
        createdAt: page.items[0]!.createdAt,
        readAt: read.readAt,
        status: 'unavailable',
      });
      const again = await f.socialReads.markRead(
        recipient.accessToken,
        notice,
        'followers',
      );
      assert.equal(again.readAt, read.readAt);
    } finally {
      resume.resolve();
      cursors.get = get;
      await reading;
    }
  },
);
