import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { SocialSource } from '../src/community/social-source/contracts.js';
import { CommunitySocialSourceFacade } from '../src/community/social-source/facade.js';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import { SocialUpdatesRepository } from '../src/notifications/social/repository.js';
import { SocialUpdatesWorker } from '../src/notifications/social/worker.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});

function fixture() {
  const source: SocialSource = {
    id: randomUUID(),
    kind: 'follow',
    actorAccountId: '00000000-0000-4000-8000-000000000002',
    recipientAccountId: '00000000-0000-4000-8000-000000000001',
    resourceKind: 'profile',
    resourceId: randomUUID(),
    postId: null,
    rootCommentId: null,
    replyId: null,
    targetReplyId: null,
    sourceEpochId: randomUUID(),
    occurredAt: '2026-10-20T00:00:00.000001Z',
  };
  const state = {
    lifecycle: 'active',
    retired: false,
    erasing: false,
    present: true,
    work: 'pending' as 'pending' | 'completed' | null,
    receipt: null as null | {
      outcome: 'materialized' | 'account_deleted';
      notice_id: string | null;
    },
    accountLock: true,
    sourceLock: true,
    onLocate: null as (() => void) | null,
    onOwner: null as (() => void) | null,
    onSettle: null as (() => void) | null,
  };
  const events: string[] = [];
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql === 'SELECT current_database() AS name')
        return { rows: [{ name: 'whaleu_test' }], rowCount: 1 };
      if (sql.startsWith('SELECT id,lifecycle')) {
        events.push('accounts');
        if (!state.accountLock)
          throw Object.assign(new Error('busy'), { code: '55P03' });
        return {
          rows: (params[0] as string[]).map((id) => ({
            id,
            lifecycle:
              id === source.actorAccountId ? state.lifecycle : 'active',
          })),
          rowCount: 2,
        };
      }
      if (sql.startsWith('SELECT pg_try_advisory')) {
        events.push('source-gate');
        return { rows: [{ locked: state.sourceLock }], rowCount: 1 };
      }
      if (sql.includes('follow_source_retired')) {
        events.push('deletion');
        return {
          rows: [{ retired: state.retired, erasing: state.erasing }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        return await operation(tx);
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const sources = {
    locate: async () => {
      events.push('locator');
      if (!state.present) return null;
      state.onLocate?.();
      return {
        actorAccountId: source.actorAccountId,
        recipientAccountId: source.recipientAccountId,
      };
    },
    source: async () => {
      events.push('source');
      return state.present ? source : null;
    },
  } as unknown as CommunitySocialSourceFacade;
  const records = {
    receipt: async () => {
      events.push('receipt');
      return state.receipt;
    },
    workState: async () => {
      events.push('work');
      return state.work;
    },
    owner: async () => {
      events.push('owner');
      state.onOwner?.();
    },
    existing: async () => {
      events.push('existing');
      return null;
    },
    settle: async () => {
      events.push('settle');
      state.onSettle?.();
      state.receipt = { outcome: 'materialized', notice_id: randomUUID() };
      state.work = 'completed';
      return 'materialized';
    },
    retry: async () => {
      events.push('retry');
    },
  } as unknown as SocialUpdatesRepository;
  const worker = new SocialUpdatesWorker(database, config, sources, records);
  return {
    worker,
    source,
    state,
    events,
    queries,
    run: () => worker.run({ mode: 'apply', sourceIds: [source.id] }),
  };
}

test('worker locks ordered lifecycle accounts before source and owner, then rereads all settlement facts', async () => {
  const f = fixture();
  assert.equal((await f.run()).materialized, 1);
  assert.deepEqual(f.events.slice(0, 4), [
    'locator',
    'accounts',
    'source-gate',
    'source',
  ]);
  assert.ok(f.events.indexOf('source-gate') < f.events.indexOf('owner'));
  assert.deepEqual(f.events.slice(f.events.indexOf('owner') + 1), [
    'source',
    'deletion',
    'receipt',
    'work',
    'settle',
  ]);
  const account = f.queries.find(({ sql }) =>
    sql.startsWith('SELECT id,lifecycle'),
  )!;
  assert.match(account.sql, /ORDER BY id FOR SHARE NOWAIT$/);
  assert.deepEqual(account.params, [
    [f.source.recipientAccountId, f.source.actorAccountId],
  ]);
  assert.equal((await f.run()).alreadyProcessed, 1);
  assert.equal(f.events.filter((event) => event === 'settle').length, 1);
});

test('cooling pauses materialization and retry metadata; explicit cancellation can resume pending work', async () => {
  const f = fixture();
  f.state.lifecycle = 'cooling';
  assert.equal((await f.run()).retryable, 1);
  assert.equal(f.state.receipt, null);
  assert.equal(f.state.work, 'pending');
  assert.ok(
    !f.events.some((event) => ['owner', 'settle', 'retry'].includes(event)),
  );
  f.state.lifecycle = 'active';
  assert.equal((await f.run()).materialized, 1);
});

test('deletion-terminal replay is alreadyProcessed without recreating an owner or visible notice', async () => {
  const f = fixture();
  f.state.lifecycle = 'completed';
  f.state.retired = true;
  f.state.receipt = { outcome: 'account_deleted', notice_id: null };
  f.state.work = 'completed';
  assert.equal((await f.run()).alreadyProcessed, 1);
  assert.ok(
    !f.events.some((event) => ['owner', 'settle', 'retry'].includes(event)),
  );
});

test('recipient graph erasure is retryable while staged and missing after removal', async () => {
  const f = fixture();
  f.state.erasing = true;
  f.state.receipt = { outcome: 'materialized', notice_id: randomUUID() };
  f.state.work = 'completed';
  assert.equal((await f.run()).retryable, 1);
  assert.ok(
    !f.events.some((event) => ['owner', 'settle', 'retry'].includes(event)),
  );
  f.state.present = false;
  assert.equal((await f.run()).missing, 1);
});

test('deletion winning after the untrusted locator cannot materialize stale source data', async () => {
  for (const remove of [false, true]) {
    const f = fixture();
    f.state.onLocate = () => {
      f.state.lifecycle = 'erasing';
      f.state.present = !remove;
    };
    const result = await f.run();
    assert.equal(remove ? result.missing : result.retryable, 1);
    assert.ok(
      !f.events.some((event) => ['owner', 'settle', 'retry'].includes(event)),
    );
  }
});

test('account or source contention is retryable without waiting or writing a receipt', async () => {
  for (const lock of ['accountLock', 'sourceLock'] as const) {
    const f = fixture();
    f.state[lock] = false;
    assert.equal((await f.run()).retryable, 1);
    assert.ok(
      !f.events.some((event) => ['owner', 'settle', 'retry'].includes(event)),
    );
  }
});

test('retirement and work are reread after owner acquisition before settling', async () => {
  const f = fixture();
  f.state.onOwner = () => {
    f.state.retired = true;
  };
  assert.equal((await f.run()).retryable, 1);
  assert.ok(!f.events.some((event) => ['settle', 'retry'].includes(event)));
});

test('retry path obtains fresh lifecycle/source authority and never revives a newly terminal source', async () => {
  for (const retired of [false, true]) {
    const f = fixture();
    f.state.onSettle = () => {
      if (retired) {
        f.state.retired = true;
        f.state.receipt = { outcome: 'account_deleted', notice_id: null };
        f.state.work = 'completed';
      }
      throw new Error('transient settlement failure');
    };
    assert.equal((await f.run()).retryable, 1);
    assert.equal(f.events.filter((event) => event === 'accounts').length, 2);
    assert.equal(f.events.includes('retry'), !retired);
  }
});

test('source locator contains endpoint IDs only and grants no row lock', async () => {
  let query = '';
  const tx = {
    query: async (sql: string) => {
      query = sql;
      return { rows: [] };
    },
  } as unknown as PoolClient;
  assert.equal(
    await new CommunitySocialSourceFacade().locate(randomUUID(), tx),
    null,
  );
  assert.match(
    query,
    /^SELECT actor_account_id AS "actorAccountId",recipient_account_id AS "recipientAccountId"/,
  );
  assert.doesNotMatch(query, /FOR |profile|display_name/i);
});

test('notification owners are never recreated for unavailable lifecycle accounts', async () => {
  const repository = new SocialUpdatesRepository();
  for (const lifecycle of ['cooling', 'erasing', 'completed']) {
    const queries: string[] = [];
    const tx = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ lifecycle }] };
      },
    } as unknown as PoolClient;
    await assert.rejects(
      repository.owner(randomUUID(), tx, true),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'COMMUNITY_UNAVAILABLE',
    );
    assert.equal(queries.length, 1);
    assert.match(queries[0]!, /FOR SHARE NOWAIT$/);
  }
});
