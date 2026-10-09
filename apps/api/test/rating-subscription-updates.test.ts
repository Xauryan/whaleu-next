import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { RatingSubscriptionUpdatesWorker } from '../src/notifications/ratings/subscription-worker.js';
import { RatingSubscriptionUpdatesReadService } from '../src/notifications/ratings/subscription-read.service.js';
import { RatingSubscriptionUpdatesRepository } from '../src/notifications/ratings/subscription-repository.js';
import type {
  RatingSubscriptionJob,
  RatingSubscriptionWork,
  StoredRatingSubscriptionNotice,
} from '../src/notifications/ratings/subscription-repository.js';
import {
  ratingSubscriptionNoticeSchema,
  ratingSubscriptionNoticeTargetSchema,
  ratingSubscriptionUpdatesQuerySchema,
} from '../src/notifications/ratings/subscription-contracts.js';
import type {
  RatingSubscriptionSource,
  RatingSubscriptionEpoch,
} from '../src/ratings/updates-source/subscription-contracts.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../src/ratings/updates-source/subscription-facade.js';
const instant = '2026-10-09T01:00:00.123456Z',
  later = '2026-10-09T01:00:01.654321Z';
const author = () => ({
  mode: 'named' as const,
  profileId: randomUUID(),
  displayName: 'Synthetic author',
});
const local = () =>
  ({
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async () => ({ rows: [{ name: 'whaleu_test' }] }),
  }) as unknown as PoolClient;
function notice() {
  return {
    noticeId: randomUUID(),
    createdAt: instant,
    readAt: null,
    status: 'available' as const,
    domain: 'ratings' as const,
    kind: 'subscription' as const,
    reason: 'target_subscription' as const,
    activity: 'root' as const,
    target: {
      regionId: null,
      targetId: randomUUID(),
      rootId: randomUUID(),
      replyId: null,
    },
    preview: { text: 'Synthetic root', author: author() },
  };
}
test('subscription contract distinguishes root/reply ancestry, safe unavailable, exact anonymous persona and read locator', () => {
  const v = notice();
  assert.deepEqual(ratingSubscriptionNoticeSchema.parse(v), v);
  const reply = {
    ...v,
    activity: 'reply',
    target: { ...v.target, replyId: randomUUID() },
  };
  assert.equal(ratingSubscriptionNoticeSchema.safeParse(reply).success, true);
  const unavailable = {
    noticeId: v.noticeId,
    createdAt: instant,
    readAt: later,
    status: 'unavailable',
  };
  assert.deepEqual(
    ratingSubscriptionNoticeSchema.parse(unavailable),
    unavailable,
  );
  for (const x of [
    { ...v, activity: 'reply' },
    { ...reply, activity: 'root' },
    { ...v, kind: 'reply' },
    { ...v, reason: 'direct_root' },
    { ...unavailable, target: v.target },
    { ...unavailable, preview: v.preview },
    { ...v, recipientAccountId: randomUUID() },
  ])
    assert.equal(ratingSubscriptionNoticeSchema.safeParse(x).success, false);
  const anonymous = {
    mode: 'anonymous',
    targetId: v.target.targetId,
    personaId: randomUUID(),
    displayName: 'Synthetic persona',
  };
  assert.equal(
    ratingSubscriptionNoticeSchema.safeParse({
      ...v,
      preview: { text: 'Test', author: anonymous },
    }).success,
    true,
  );
  for (const a of [
    { ...anonymous, targetId: randomUUID() },
    { ...anonymous, accountId: randomUUID() },
  ])
    assert.equal(
      ratingSubscriptionNoticeSchema.safeParse({
        ...v,
        preview: { text: 'Test', author: a },
      }).success,
      false,
    );
  assert.equal(
    ratingSubscriptionNoticeTargetSchema.safeParse({
      noticeId: v.noticeId,
      status: 'unavailable',
      target: v.target,
    }).success,
    false,
  );
  assert.deepEqual(ratingSubscriptionUpdatesQuerySchema.parse({}), {
    limit: 20,
  });
  assert.equal(
    ratingSubscriptionUpdatesQuerySchema.safeParse({ limit: 21 }).success,
    false,
  );
});
function fixture(count = 3) {
  const event: RatingSubscriptionSource = {
    id: randomUUID(),
    sequence: '9007199254740993',
    occurredAt: instant,
    actorAccountId: randomUUID(),
    targetOrder: '999',
    coverage: 'complete',
    activity: 'root',
    target: {
      regionId: null,
      targetId: randomUUID(),
      rootId: randomUUID(),
      replyId: null,
    },
  };
  const epochs: RatingSubscriptionEpoch[] = Array.from(
    { length: count },
    (_, i) => ({
      epochId: randomUUID(),
      accountId: randomUUID(),
      startOrder: String(i + 1),
      eligible: true,
    }),
  );
  let job: RatingSubscriptionJob = {
      event_id: event.id,
      last_page: 0,
      cursor_order: null,
      cursor_epoch_id: null,
      scan_finished: false,
    },
    complete = false,
    fail: string | null = null,
    unknown: string | null = null;
  let work: RatingSubscriptionWork[] = [],
    notices: string[] = [];
  const calls: string[] = [],
    tx = local();
  let serial = 0;
  const database = {
    transaction: async (fn: (t: PoolClient) => Promise<unknown>) => {
      const before = structuredClone({ job, complete, work, notices });
      const id = ++serial;
      calls.push(`begin:${id}`);
      try {
        const r = await fn(tx);
        calls.push(`commit:${id}`);
        return r;
      } catch (e) {
        ({ job, complete, work, notices } = before);
        calls.push(`rollback:${id}`);
        throw e;
      }
    },
  };
  const source = {
    event: async () => event,
    lockTarget: async () => {},
    rawPage: async (_id: string, order: string | null) =>
      epochs
        .filter((e) => BigInt(e.startOrder) > BigInt(order ?? '0'))
        .slice(0, 51),
  };
  const records = {
    completed: async () => complete,
    job: async () => ({ ...job }),
    addPage: async (
      _job: RatingSubscriptionJob,
      raw: RatingSubscriptionEpoch[],
    ) => {
      calls.push('page');
      const selected = raw.slice(0, 50);
      for (const e of selected.filter((e) => e.eligible))
        work.push({
          event_id: event.id,
          target_id: event.target.targetId,
          recipient_account_id: e.accountId,
          epoch_id: e.epochId,
          page_number: job.last_page + 1,
          status: 'pending',
          attempts: 0,
          code: null,
        });
      const last = selected.at(-1);
      job = {
        ...job,
        last_page: job.last_page + 1,
        cursor_order: last?.startOrder ?? job.cursor_order,
        cursor_epoch_id: last?.epochId ?? job.cursor_epoch_id,
        scan_finished: raw.length <= 50,
      };
    },
    nextWork: async () => work.find((w) => w.status === 'pending') ?? null,
    pending: async (_id: string, limit: number) =>
      work
        .filter((w) => ['pending', 'retry'].includes(w.status))
        .slice(0, limit),
    work: async (_id: string, account: string) =>
      work.find((w) => w.recipient_account_id === account) ?? null,
    owner: async (id: string) => {
      calls.push(`owner:${id}`);
    },
    retry: async (w: RatingSubscriptionWork) => {
      calls.push(`retry:${w.recipient_account_id}`);
      w.status = 'retry';
    },
    settle: async (w: RatingSubscriptionWork) => {
      w.status = 'suppressed';
      calls.push('suppressed');
    },
    materialize: async (_e: unknown, w: RatingSubscriptionWork) => {
      notices.push(w.recipient_account_id);
      w.status = 'materialized';
      calls.push(`notice:${w.recipient_account_id}`);
      if (w.recipient_account_id === fail) throw Error('crash');
    },
    status: async () => ({
      scanFinished: job.scan_finished,
      pending: work.some((w) => ['pending', 'retry'].includes(w.status)),
      retryable: work.some((w) => w.status === 'retry'),
    }),
    finish: async () => {
      if (
        job.scan_finished &&
        work.every((w) => ['materialized', 'suppressed'].includes(w.status))
      ) {
        complete = true;
        calls.push('complete');
        return true;
      }
      return false;
    },
  };
  const projection = {
    eligible: async (_target: unknown, account: string) => {
      calls.push(`proof:${account}`);
      return account === unknown
        ? { outcome: 'unavailable', code: 'authority_unavailable' }
        : {
            outcome: 'eligible',
            preview: { text: 'Synthetic', author: author() },
          };
    },
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://local:local@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    RATINGS_UPDATES_PROCESSING: 'manual',
  });
  const make = () =>
    new RatingSubscriptionUpdatesWorker(
      database as never,
      config,
      source as never,
      projection as never,
      records as never,
    );
  return {
    make,
    event,
    epochs,
    calls,
    snapshot: () => structuredClone({ job, work, notices, complete }),
    setUnknown: (id: string | null) => {
      unknown = id;
    },
    setFail: (id: string | null) => {
      fail = id;
    },
    retryNow: () => {
      work = work.map((w) =>
        w.status === 'retry' ? { ...w, status: 'pending' } : w,
      );
    },
  };
}
test('durable fanout resumes multi-page scans and individually commits bounded recipient work', async () => {
  const f = fixture(104);
  const first = await f.make().run({
    mode: 'apply',
    eventIds: [f.event.id],
    maxPages: 1,
    maxRecipients: 7,
  });
  assert.equal(first.processed, 0);
  assert.equal(first.partial, 1);
  assert.equal(first.materialized, 7);
  assert.equal(f.snapshot().job.cursor_order, '50');
  assert.equal(f.snapshot().work.length, 50);
  const second = await f.make().run({
    mode: 'apply',
    eventIds: [f.event.id],
    maxPages: 2,
    maxRecipients: 1000,
  });
  assert.equal(second.processed, 1);
  assert.equal(second.materialized, 97);
  assert.equal(f.snapshot().work.length, 104);
  assert.equal(new Set(f.snapshot().notices).size, 104);
  assert.equal(
    (await f.make().run({ mode: 'apply', eventIds: [f.event.id] }))
      .alreadyProcessed,
    1,
  );
  const transactions = f.calls.filter((c) => c.startsWith('commit:'));
  assert.ok(transactions.length >= 104);
});
test('true dry-run forecasts without owner/page/work/attempt/cursor/completion writes', async () => {
  const f = fixture(57),
    before = f.snapshot();
  const out = await f
    .make()
    .run({ eventIds: [f.event.id], maxPages: 2, maxRecipients: 100 });
  assert.equal(out.wouldMaterialize, 57);
  assert.equal(out.materialized, 0);
  assert.equal(out.processed, 0);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(
    f.calls.some((c) => /^(owner:|notice:|page|retry:|complete)/.test(c)),
    false,
  );
});
test('unknown and recipient crash do not roll back other recipients or record suppression/completion', async () => {
  const f = fixture(4);
  f.setUnknown(f.epochs[1]!.accountId);
  f.setFail(f.epochs[2]!.accountId);
  const out = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(out.materialized, 2);
  assert.equal(out.suppressed, 0);
  assert.equal(out.partial, 1);
  assert.equal(out.retryable, 1);
  assert.equal(out.failed, 1);
  assert.equal(f.snapshot().notices.length, 2);
  assert.equal(f.snapshot().complete, false);
  assert.equal(f.snapshot().work.filter((w) => w.status === 'retry').length, 2);
  f.setUnknown(null);
  f.setFail(null);
  f.retryNow();
  const resumed = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(resumed.processed, 1);
  assert.equal(resumed.materialized, 2);
  assert.equal(f.snapshot().notices.length, 4);
});
test('unknown coverage cannot invent a zero-recipient completion', async () => {
  const f = fixture(0);
  f.event.coverage = 'unknown';
  const before = f.snapshot();
  const out = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(out.blocked, 1);
  assert.equal(out.retryable, 1);
  assert.equal(out.processed, 0);
  assert.deepEqual(f.snapshot(), before);
});
test('empty complete audience needs the exact final page before completion', async () => {
  const f = fixture(0);
  const out = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(out.pages, 1);
  assert.equal(out.processed, 1);
  assert.equal(f.snapshot().job.last_page, 1);
  assert.equal(f.snapshot().notices.length, 0);
});
test('subscription read keeps source checks before owner, exact timestamps and no membership requirement', async () => {
  const v = notice();
  const row: StoredRatingSubscriptionNotice = {
    id: v.noticeId,
    event_id: randomUUID(),
    recipient_account_id: randomUUID(),
    epoch_id: randomUUID(),
    kind: 'subscription',
    reason: 'target_subscription',
    activity: 'root',
    region_id: null,
    target_id: v.target.targetId,
    root_id: v.target.rootId,
    reply_id: null,
    ordinal: '9007199254740993',
    created_at: instant,
    read_at: null,
  };
  const order: string[] = [];
  let unavailable = false;
  const tx = local();
  const service = new RatingSubscriptionUpdatesReadService(
    {
      transaction: async (fn: (t: PoolClient) => Promise<unknown>) => fn(tx),
    } as never,
    {
      session: async () => {
        order.push('session');
        return { accountId: row.recipient_account_id, sessionId: randomUUID() };
      },
    } as never,
    {
      page: async () => [row],
      own: async () => row,
      owner: async () => {
        order.push('owner');
      },
      states: async () => new Map([[row.id, later]]),
      count: async () => 0,
      markRead: async () => ({ ...row, read_at: later }),
    } as never,
    {
      eligible: async (...args: unknown[]) => {
        assert.equal(args.length, 3);
        order.push('projection');
        return unavailable
          ? { outcome: 'suppressed', code: 'target_inaccessible' }
          : { outcome: 'eligible', preview: v.preview };
      },
    } as never,
    {} as never,
  );
  const page = await service.list('token', { limit: 20 });
  assert.equal(page.items[0]!.readAt, later);
  assert.equal(page.items[0]!.createdAt, instant);
  assert.deepEqual(order, ['session', 'projection', 'session', 'owner']);
  unavailable = true;
  assert.deepEqual(await service.target('token', row.id), {
    noticeId: row.id,
    status: 'unavailable',
  });
  order.length = 0;
  assert.deepEqual(await service.markRead('token', row.id), {
    noticeId: row.id,
    readAt: later,
    unreadCount: 0,
  });
  assert.deepEqual(order, ['session', 'owner']);
});
test('subscription raw scanning and recipient selection are query bounded and preserve bigint', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  await new RatingsSubscriptionUpdatesSourceFacade().rawPage(
    randomUUID(),
    '9007199254740993',
    randomUUID(),
    tx,
  );
  assert.match(calls[0]!.sql, /subscription_fanout_raw_page/);
  assert.equal(calls[0]!.values[1], '9007199254740993');
  await new RatingSubscriptionUpdatesRepository().nextWork(randomUUID(), tx);
  assert.match(calls[1]!.sql, /LIMIT 1/);
  await new RatingSubscriptionUpdatesRepository().page(
    randomUUID(),
    20,
    '9007199254740993',
    tx,
  );
  assert.equal(calls[2]!.values[2], 21);
  assert.match(calls[2]!.sql, /HH24:MI:SS.US/);
});
