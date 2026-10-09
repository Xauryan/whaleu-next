import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { ApplicationError } from '../src/http/application-error.js';
import { ratingNoticeSchema } from '../src/notifications/ratings/contracts.js';
import {
  ratingLikeNoticeSchema,
  ratingLikeNoticeTargetSchema,
  ratingLikeUpdatesPageSchema,
} from '../src/notifications/ratings/like-contracts.js';
import type { RatingLikeNoticeEvent } from '../src/notifications/ratings/like-contracts.js';
import { RatingUpdatesRepository } from '../src/notifications/ratings/repository.js';
import type { StoredRatingLikeNotice } from '../src/notifications/ratings/repository.js';
import { RatingLikeUpdatesReadService } from '../src/notifications/ratings/like-read.service.js';
import { ratingUpdatesCursorScope } from '../src/notifications/ratings/cursor.js';
import { RatingUpdatesWorker } from '../src/notifications/ratings/worker.js';
import { RatingsUpdatesSourceFacade } from '../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../src/ratings/updates-source/projection.js';

const instant = '2026-10-09T01:00:00.123456Z';
const later = '2026-10-09T01:00:01.654321Z';
const actor = {
  mode: 'named' as const,
  profileId: randomUUID(),
  displayName: 'Synthetic liker',
};
function event(replyId: string | null = null): RatingLikeNoticeEvent {
  return {
    kind: 'like',
    id: randomUUID(),
    sequence: '9007199254740993',
    occurredAt: instant,
    actorAccountId: randomUUID(),
    target: {
      regionId: null,
      targetId: randomUUID(),
      rootId: randomUUID(),
      replyId,
    },
    recipients: [{ accountId: randomUUID(), reason: 'like' }],
  };
}
function client(
  query: (sql: string, values: unknown[]) => unknown = () => ({ rows: [] }),
): PoolClient {
  return {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string, values: unknown[] = []) =>
      sql === 'SELECT current_database() AS name'
        ? { rows: [{ name: 'whaleu_test' }] }
        : query(sql, values),
  } as unknown as PoolClient;
}
function available() {
  return {
    noticeId: randomUUID(),
    createdAt: instant,
    readAt: null,
    status: 'available' as const,
    domain: 'ratings' as const,
    kind: 'like' as const,
    reason: 'like' as const,
    actor,
    target: event().target,
    preview: { text: 'Synthetic subject' },
  };
}
test('Rating like notice DTO is named-only, root/reply typed, generic unavailable and isolated from legacy reply DTO', () => {
  const value = available();
  assert.deepEqual(ratingLikeNoticeSchema.parse(value), value);
  assert.equal(
    ratingLikeNoticeSchema.safeParse({
      ...value,
      target: { ...value.target, replyId: randomUUID() },
    }).success,
    true,
  );
  assert.equal(ratingNoticeSchema.safeParse(value).success, false);
  for (const invalid of [
    { ...value, kind: 'reply' },
    { ...value, reason: 'direct_root' },
    { ...value, actor: { ...actor, accountId: randomUUID() } },
    {
      ...value,
      actor: {
        mode: 'anonymous',
        targetId: value.target.targetId,
        personaId: randomUUID(),
        displayName: 'Hidden',
      },
    },
    { ...value, preview: { ...value.preview, author: actor } },
    { ...value, recipientAccountId: randomUUID() },
    { ...value, target: { ...value.target, likeId: randomUUID() } },
    { ...value, preview: { text: ' padded ' } },
    { ...value, createdAt: '2026-10-09T01:00:00.1234567Z' },
  ])
    assert.equal(ratingLikeNoticeSchema.safeParse(invalid).success, false);
  const unavailable = {
    noticeId: value.noticeId,
    createdAt: instant,
    readAt: later,
    status: 'unavailable',
  };
  assert.deepEqual(ratingLikeNoticeSchema.parse(unavailable), unavailable);
  for (const extra of [
    { target: value.target },
    { actor },
    { preview: value.preview },
    { kind: 'like' },
  ])
    assert.equal(
      ratingLikeNoticeSchema.safeParse({ ...unavailable, ...extra }).success,
      false,
    );
  assert.equal(
    ratingLikeUpdatesPageSchema.safeParse({
      items: [value, value],
      nextCursor: null,
      unreadCount: 1,
    }).success,
    false,
  );
  assert.equal(
    ratingLikeNoticeTargetSchema.safeParse({
      noticeId: value.noticeId,
      status: 'available',
      target: value.target,
    }).success,
    true,
  );
});
test('Rating notice repository keeps reply-only defaults and explicit like filters for page, count, own, states and read', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const id = randomUUID(),
    account = randomUUID();
  const tx = client((sql, values) => {
    calls.push({ sql, values });
    return {
      rows: sql.includes('count(*)')
        ? [{ count: 0 }]
        : [{ id, read_at: later }],
    };
  });
  const records = new RatingUpdatesRepository();
  for (const kind of ['reply', 'like'] as const) {
    const optional = kind === 'reply' ? ([] as const) : (['like'] as const);
    await records.page(account, 20, null, tx, ...optional);
    await records.count(account, tx, ...optional);
    await records.own(account, id, tx, ...optional);
    await records.states(account, [id], tx, ...optional);
    await records.markRead(account, id, tx, ...optional);
    const group = calls.splice(0);
    assert.equal(group.length, 5);
    assert.ok(
      group.every(
        (call) => /kind=\$\d/.test(call.sql) && call.values.at(-1) === kind,
      ),
    );
  }
});
test('Rating like once-key existing receipt binds original ID without rewriting read state or source', async () => {
  const source = event(),
    noticeId = randomUUID(),
    calls: { sql: string; values: unknown[] }[] = [];
  const tx = client((sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.startsWith('SELECT id') ? [{ id: noticeId }] : [] };
  });
  assert.equal(
    await new RatingUpdatesRepository().materializeLike(
      source,
      source.recipients[0]!,
      tx,
    ),
    'existing',
  );
  assert.equal(calls.length, 2);
  assert.match(
    calls[0]!.sql,
    /kind='like'.*recipient_account_id=\$1.*like_actor_account_id=\$2.*root_id=\$4.*reply_id IS NULL/,
  );
  assert.deepEqual(calls[0]!.values, [
    source.recipients[0]!.accountId,
    source.actorAccountId,
    source.target.targetId,
    source.target.rootId,
  ]);
  assert.deepEqual(calls[1]!.values, [
    source.id,
    source.recipients[0]!.accountId,
    'like',
    'existing',
    null,
    noticeId,
  ]);
  assert.ok(
    calls.every(
      (call) =>
        !/UPDATE|INSERT INTO whaleu_notifications\.rating_notices/.test(
          call.sql,
        ),
    ),
  );
});
test('Rating like first materialization captures exactly one typed notice and exact notice receipt', async () => {
  for (const source of [event(), event(randomUUID())]) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const tx = client((sql, values) => {
      calls.push({ sql, values });
      return { rows: [] };
    });
    assert.equal(
      await new RatingUpdatesRepository().materializeLike(
        source,
        source.recipients[0]!,
        tx,
      ),
      'materialized',
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[1]!.values[6], source.target.replyId);
    assert.equal(calls[1]!.values[7], source.actorAccountId);
    assert.equal(calls[1]!.values[8], instant);
    assert.deepEqual(calls[2]!.values, [
      source.id,
      source.recipients[0]!.accountId,
      'like',
      'materialized',
      null,
      calls[1]!.values[0],
    ]);
  }
});
test('Rating source accepts only precise v2 positive obligations, privately resolves named liker and ignores unlike', async () => {
  const e = event();
  let kind = 'content_liked',
    recipients = e.recipients;
  const tx = client((sql) => ({
    rows: sql.includes('effect_events')
      ? [
          {
            id: e.id,
            source_version: 2,
            event_kind: kind,
            actor_account_id: e.actorAccountId,
            subject_author_id: e.recipients[0]!.accountId,
            region_id: null,
            target_id: e.target.targetId,
            root_id: e.target.rootId,
            reply_id: null,
            sequence: e.sequence,
            occurred_at: instant,
            expected_direct_notice_obligations: 1,
          },
        ]
      : recipients,
  }));
  const source = new RatingsUpdatesSourceFacade();
  assert.deepEqual(await source.event(e.id, tx), { status: 'ready', event: e });
  recipients = [{ accountId: randomUUID(), reason: 'like' }];
  await assert.rejects(() => source.event(e.id, tx), /obligations/);
  kind = 'content_unliked';
  assert.deepEqual(await source.event(e.id, tx), {
    status: 'ignored',
    code: 'no_direct_updates',
  });
});

test('Rating like projection authorizes anonymous subject without a hidden named-author oracle, ignores quote and membership, and projects current named liker', async () => {
  const e = event(randomUUID()),
    recipient = e.recipients[0]!,
    calls: string[] = [];
  let hidden = false,
    safety: 'allow' | 'deny' | 'unavailable' = 'allow';
  const root = {
    account_id: recipient.accountId,
    author_mode: 'anonymous',
    body: 'Root',
  };
  const reply = {
    ...root,
    body: 'Current liked reply',
    reply_to_id: randomUUID(),
  };
  const projection = new RatingUpdatesProjectionFacade(
    {
      resolveAccount: async (id: string) => {
        assert.equal(id, recipient.accountId);
        calls.push('access');
      },
    } as never,
    {
      enable: () => {},
      catalog: async () => ({}),
      comment: async () => {
        calls.push('root');
        return root;
      },
    } as never,
    {
      reply: async (id: string) => {
        assert.equal(id, e.target.replyId);
        calls.push('reply');
        return reply;
      },
    } as never,
    {
      target: async () => {},
      content: async (row: unknown) => {
        calls.push('content');
        return hidden && row === root ? null : { mode: 'anonymous' };
      },
    } as never,
    {
      named: async (viewer: string, liker: string) => {
        assert.equal(viewer, recipient.accountId);
        assert.equal(liker, e.actorAccountId);
        calls.push('liker-safety');
        return { kind: safety };
      },
    } as never,
    {
      findRatingPublic: async (id: string) => {
        assert.equal(id, e.actorAccountId);
        return { profileId: actor.profileId, displayName: actor.displayName };
      },
    } as never,
  );
  assert.deepEqual(
    await projection.eligibleLike(
      e.target,
      recipient,
      e.actorAccountId,
      client(),
    ),
    { outcome: 'eligible', actor, preview: { text: reply.body } },
  );
  assert.deepEqual(calls, [
    'access',
    'root',
    'content',
    'reply',
    'content',
    'liker-safety',
  ]);
  safety = 'deny';
  assert.equal(
    (
      await projection.eligibleLike(
        e.target,
        recipient,
        e.actorAccountId,
        client(),
      )
    ).outcome,
    'suppressed',
  );
  safety = 'unavailable';
  assert.equal(
    (
      await projection.eligibleLike(
        e.target,
        recipient,
        e.actorAccountId,
        client(),
      )
    ).outcome,
    'unavailable',
  );
  hidden = true;
  calls.length = 0;
  assert.equal(
    (
      await projection.eligibleLike(
        e.target,
        recipient,
        e.actorAccountId,
        client(),
      )
    ).outcome,
    'suppressed',
  );
  assert.equal(calls.includes('reply'), false);
});
function workerFixture(
  outcome: 'eligible' | 'suppressed' | 'unavailable' = 'eligible',
) {
  const e = event(),
    calls: string[] = [];
  let existing = false;
  const tx = client();
  const worker = new RatingUpdatesWorker(
    {
      transaction: async (run: (tx: PoolClient) => Promise<unknown>) => run(tx),
    } as never,
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://local:local@127.0.0.1/whaleu_test',
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      RATINGS_UPDATES_PROCESSING: 'manual',
    }),
    { event: async () => ({ status: 'ready', event: e }) } as never,
    {
      eligibleLike: async () => {
        calls.push('projection');
        return outcome === 'eligible'
          ? { outcome, actor, preview: { text: 'Current content' } }
          : { outcome, code: 'authority_unavailable' };
      },
    } as never,
    {
      eventReceipt: async () => null,
      owner: async () => calls.push('owner'),
      materializeLike: async () => {
        calls.push('materialize');
        return existing ? 'existing' : 'materialized';
      },
      existingLike: async () => {
        calls.push('existing');
        return existing ? randomUUID() : null;
      },
      settleEvent: async () => calls.push('complete'),
      settleRecipient: async () => calls.push('suppressed'),
      retryable: async () => calls.push('retry'),
    } as never,
  );
  return {
    e,
    worker,
    calls,
    existing: () => {
      existing = true;
    },
  };
}
test('Rating like worker separates existing from materialized after projection-before-owner and dry-run writes nothing', async () => {
  const f = workerFixture();
  assert.equal(
    (await f.worker.run({ mode: 'apply', eventIds: [f.e.id] })).materialized,
    1,
  );
  assert.deepEqual(f.calls, ['projection', 'owner', 'materialize', 'complete']);
  f.existing();
  f.calls.length = 0;
  const reused = await f.worker.run({ mode: 'apply', eventIds: [f.e.id] });
  assert.equal(reused.existing, 1);
  assert.equal(reused.materialized, 0);
  f.calls.length = 0;
  assert.equal((await f.worker.run({ eventIds: [f.e.id] })).existing, 1);
  assert.deepEqual(f.calls, ['projection', 'existing']);
});
test('Rating like unknown authority is retryable with no terminal owner receipt; explicit denial is suppressed', async () => {
  const f = workerFixture('unavailable');
  const result = await f.worker.run({ mode: 'apply', eventIds: [f.e.id] });
  assert.equal(result.retryable, 1);
  assert.equal(result.processed, 0);
  assert.deepEqual(f.calls, ['projection', 'retry']);
  const denied = workerFixture('suppressed');
  assert.equal(
    (await denied.worker.run({ mode: 'apply', eventIds: [denied.e.id] }))
      .suppressed,
    1,
  );
  assert.deepEqual(denied.calls, [
    'projection',
    'owner',
    'suppressed',
    'complete',
  ]);
});
test('Rating like cursor cannot replay a legacy reply cursor scope', () => {
  const account = randomUUID(),
    session = randomUUID();
  assert.notEqual(
    ratingUpdatesCursorScope(account, session, 'token', 20),
    ratingUpdatesCursorScope(account, session, 'token', 20, 'like'),
  );
});
test('Rating like reader keeps private source IDs out of DTO and rereads state after parents; read bypasses content', async () => {
  const e = event(),
    recipient = e.recipients[0]!,
    calls: string[] = [];
  const row: StoredRatingLikeNotice = {
    id: randomUUID(),
    event_id: e.id,
    recipient_account_id: recipient.accountId,
    kind: 'like',
    reason: 'like',
    region_id: null,
    target_id: e.target.targetId,
    root_id: e.target.rootId,
    reply_id: null,
    like_actor_account_id: e.actorAccountId,
    ordinal: '999',
    created_at: instant,
    read_at: null,
  };
  const checkKind = (kind: unknown) => {
    assert.equal(kind, 'like');
  };
  let unavailable = false;
  const service = new RatingLikeUpdatesReadService(
    {
      transaction: async (run: (tx: PoolClient) => Promise<unknown>) =>
        run(client()),
    } as never,
    {
      session: async () => {
        calls.push('session');
        return { accountId: recipient.accountId, sessionId: randomUUID() };
      },
    } as never,
    {
      page: async (
        _a: unknown,
        _l: unknown,
        _b: unknown,
        _t: unknown,
        kind: unknown,
      ) => {
        checkKind(kind);
        calls.push('page');
        return [row];
      },
      own: async (_a: unknown, _n: unknown, _t: unknown, kind: unknown) => {
        checkKind(kind);
        return row;
      },
      owner: async () => calls.push('owner'),
      states: async (
        _a: unknown,
        _ids: unknown,
        _t: unknown,
        kind: unknown,
      ) => {
        checkKind(kind);
        calls.push('states');
        return new Map([[row.id, later]]);
      },
      count: async (_a: unknown, _t: unknown, kind: unknown) => {
        checkKind(kind);
        calls.push('count');
        return 0;
      },
      markRead: async (
        _a: unknown,
        _id: unknown,
        _t: unknown,
        kind: unknown,
      ) => {
        checkKind(kind);
        calls.push('read');
        return { ...row, read_at: later };
      },
    } as never,
    {
      eligibleLike: async () => {
        calls.push('projection');
        return unavailable
          ? { outcome: 'unavailable', code: 'authority_unavailable' }
          : {
              outcome: 'eligible',
              actor,
              preview: { text: 'Current subject' },
            };
      },
    } as never,
    {} as never,
  );
  const page = await service.list('token', { limit: 20 });
  assert.equal(page.items[0]!.readAt, later);
  assert.deepEqual(calls, [
    'session',
    'page',
    'projection',
    'session',
    'owner',
    'states',
    'count',
  ]);
  for (const privateId of [recipient.accountId, e.actorAccountId, e.id])
    assert.equal(JSON.stringify(page).includes(privateId), false);
  unavailable = true;
  calls.length = 0;
  assert.deepEqual(await service.target('token', row.id), {
    noticeId: row.id,
    status: 'unavailable',
  });
  assert.equal(calls.includes('read'), false);
  calls.length = 0;
  assert.deepEqual(await service.markRead('token', row.id), {
    noticeId: row.id,
    readAt: later,
    unreadCount: 0,
  });
  assert.deepEqual(calls, ['session', 'owner', 'read', 'count']);
});
test('Rating like repository rejects foreign-kind targets without a content lookup', async () => {
  await assert.rejects(
    () =>
      new RatingUpdatesRepository().own(
        randomUUID(),
        randomUUID(),
        client(),
        'like',
      ),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'NOTICE_NOT_FOUND',
  );
});
