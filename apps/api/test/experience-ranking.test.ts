import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import {
  checkTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  emptyBodySchema,
  rankingQuerySchema,
} from '../src/experience-ranking/contracts.js';
import { ExperienceRankingController } from '../src/experience-ranking/controller.js';
import { ExperienceRankingService } from '../src/experience-ranking/service.js';
import { ExperienceRankingSourceFacade } from '../src/experience/ranking-source.facade.js';
import type { RankingCandidate } from '../src/experience/ranking-source.facade.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { AuthorDisplayService } from '../src/profile/author-display.service.js';
import type { ProfileVisibilityFacade } from '../src/safety/profile-visibility.facade.js';
import { ApplicationError } from '../src/http/application-error.js';

const display = {
  level: { status: 'known', value: 1 },
  title: { status: 'unavailable', value: null },
  color: { status: 'unavailable', value: null },
} as const;
function fixture(count: number, hasMore = false) {
  const calls: string[] = [];
  const values: unknown[][] = [];
  const proofFacts: string[] = [];
  const proof = {
    maximumFacts: 50,
    failureCode: 'SAFETY_UNAVAILABLE' as const,
    validate: async (facts: readonly string[]) => {
      proofFacts.push(...facts);
    },
  };
  const state = {
    afterSafety: (_id: string) => {},
    absent: new Set<string>(),
    inactive: new Set<string>(),
    denied: new Set<string>(),
    failure: null as Error | null,
    authFailure: null as Error | null,
  };
  const tx = {
    query: async (sql: string, args: unknown[] = []) => {
      calls.push(sql);
      values.push(args);
      if (sql.includes('current_setting'))
        return { rows: [{ statement_timeout: '50ms', lock_timeout: '0' }] };
      if (sql.includes('clock_timestamp'))
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const source = {
    read: async () => ({
      candidates: Array.from({ length: count }, (_, i): RankingCandidate => ({
        accountId: `account-${i}`,
        experienceDisplay: display,
      })),
      hasMore,
    }),
  } as ExperienceRankingSourceFacade;
  const database = {
    transaction: async (
      fn: (tx: PoolClient) => Promise<unknown>,
      options: unknown,
    ) => {
      assert.deepEqual(options, { isolationLevel: 'read committed' });
      startTransactionDeadlines(tx);
      enableRequiredTransactionProof(tx, proof);
      try {
        const result = await fn(tx);
        await checkTransactionDeadlines(tx);
        return result;
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as unknown as DatabaseService;
  const identity = {
    session: async (token: string) => {
      calls.push(`session:${token}`);
      if (state.authFailure) throw state.authFailure;
      return { accountId: 'viewer' };
    },
    activeAccount: async (id: string) => {
      calls.push(`active:${id}`);
      return !state.inactive.has(id);
    },
  } as unknown as IdentityService;
  const profiles = {
    find: async (id: string) => {
      calls.push(`profile:${id}`);
      return state.absent.has(id)
        ? null
        : {
            profileId: `public-${id}`,
            displayName: `name-${id}`,
            private: 'must not leak',
          };
    },
  } as unknown as AuthorDisplayService;
  const safety = {
    read: async (_viewer: string | null, id: string) => {
      calls.push(`safety:${id}`);
      registerRequiredTransactionFact(tx, proof, id, id);
      state.afterSafety(id);
      if (state.failure) throw state.failure;
      return { status: state.denied.has(id) ? 'unavailable' : 'available' };
    },
  } as unknown as ProfileVisibilityFacade;
  return {
    service: new ExperienceRankingService(
      database,
      identity,
      profiles,
      safety,
      source,
    ),
    state,
    calls,
    values,
    proofFacts,
  };
}

test('ranking query accepts only decimal limits 1–50; body is empty', () => {
  assert.deepEqual(rankingQuerySchema.parse({}), { limit: 50 });
  for (let limit = 1; limit <= 50; limit++)
    assert.equal(
      rankingQuerySchema.parse({ limit: String(limit) }).limit,
      limit,
    );
  for (const limit of [
    '0',
    '51',
    '01',
    '+1',
    '-1',
    '1.0',
    ' 1',
    '',
    ['1', '2'],
    1,
  ])
    assert.equal(rankingQuerySchema.safeParse({ limit }).success, false);
  assert.equal(
    rankingQuerySchema.safeParse({ cursor: 'anything' }).success,
    false,
  );
  assert.equal(emptyBodySchema.safeParse({ limit: 1 }).success, false);
  assert.deepEqual(emptyBodySchema.parse(undefined), {});
});

test('controller never downgrades present invalid authorization to guest', async () => {
  const f = fixture(0);
  const controller = new ExperienceRankingController(f.service);
  assert.equal(
    (await controller.ranking(undefined, { limit: 50 }, {})).items.length,
    0,
  );
  for (const header of ['', null, [], 'Basic x', 'Bearer'])
    assert.throws(() => controller.ranking(header, { limit: 50 }, {}));
  f.state.authFailure = new ApplicationError('SESSION_REVOKED');
  await assert.rejects(
    controller.ranking(`Bearer wu_a_${'a'.repeat(43)}`, { limit: 50 }, {}),
    {
      code: 'SESSION_REVOKED',
    },
  );
});

test('refills excluded candidates, returns exact safe allowlist and retains snapshot display', async () => {
  const f = fixture(6);
  f.state.absent.add('account-0');
  f.state.inactive.add('account-1');
  f.state.denied.add('account-2');
  const result = await f.service.ranking('valid', { limit: 2 });
  assert.deepEqual(result, {
    scope: 'global',
    population: 'known_participants',
    populationCompleteness: 'incomplete',
    selectionStatus: 'limit_reached',
    items: [3, 4].map((i) => ({
      profileId: `public-account-${i}`,
      displayName: `name-account-${i}`,
      experienceDisplay: display,
    })),
  });
  assert.equal(
    f.calls.filter((sql) => sql === 'ROLLBACK TO SAVEPOINT ranking_candidate')
      .length,
    2,
  );
  assert.equal(f.calls.filter((sql) => sql === 'session:valid').length, 2);
  assert.equal(f.calls.includes('profile:account-5'), false);
  assert.deepEqual(
    f.values.find((args) => args[0] === '50ms'),
    ['50ms', '100ms'],
  );
  assert.deepEqual(f.values.filter((args) => args.length > 0).at(-1), [
    '50ms',
    '0',
  ]);
});

test('selection statuses distinguish available exhaustion, limit reached and bounded scan', async () => {
  for (const count of [0, 1, 256]) {
    const f = fixture(count);
    f.state.inactive = new Set(
      Array.from({ length: count }, (_, i) => `account-${i}`),
    );
    assert.equal(
      (await f.service.ranking(null, { limit: 50 })).selectionStatus,
      'available_candidates_exhausted',
    );
  }
  const f = fixture(256, true);
  f.state.inactive = new Set(
    Array.from({ length: 256 }, (_, i) => `account-${i}`),
  );
  const result = await f.service.ranking(null, { limit: 50 });
  assert.equal(result.selectionStatus, 'scan_limited');
  assert.deepEqual(result.items, []);
  const filled = fixture(256, true);
  assert.equal(
    (await filled.service.ranking(null, { limit: 50 })).items.length,
    50,
  );
  assert.equal(
    filled.calls.filter((sql) => sql.startsWith('active:')).length,
    50,
  );
  assert.equal(
    (await fixture(1).service.ranking(null, { limit: 1 })).selectionStatus,
    'limit_reached',
  );
});

test('unknown safety coverage and arbitrary failures abort rather than exclude', async () => {
  const f = fixture(2);
  f.state.failure = new ApplicationError('SAFETY_UNAVAILABLE');
  await assert.rejects(f.service.ranking('valid', { limit: 50 }), {
    code: 'SAFETY_UNAVAILABLE',
  });
  assert.equal(
    f.calls.includes('ROLLBACK TO SAVEPOINT ranking_candidate'),
    false,
  );
  f.state.failure = new Error('database failure');
  await assert.rejects(
    f.service.ranking(null, { limit: 50 }),
    /database failure/,
  );
});

test('source performs one bounded ordered SELECT, maps zero and bigint, discards sentinel and private facts', async () => {
  const calls: string[] = [];
  const rows = Array.from({ length: 257 }, (_, i) => ({
    account_id: `account-${i}`,
    appearance_present: false,
    title_key: null,
    title_owned: false,
    title_name: null,
    color_id: null,
    catalog_color_id: null,
    balance_known: true,
    balance: i === 0 ? '9223372036854775807' : '0',
  }));
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      calls.push(sql);
      assert.deepEqual(values, [257]);
      return { rows };
    },
  } as unknown as PoolClient;
  const result = await new ExperienceRankingSourceFacade().read(tx);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /ORDER BY s.balance DESC,s.owner_id ASC/);
  assert.doesNotMatch(calls[0]!, /FOR (?:UPDATE|SHARE)|INSERT|UPDATE|DELETE/);
  assert.equal(result.hasMore, true);
  assert.equal(result.candidates.length, 256);
  assert.equal(result.candidates[1]?.experienceDisplay.level.value, 1);
  assert.deepEqual(Object.keys(result.candidates[0]!).sort(), [
    'accountId',
    'experienceDisplay',
  ]);
  rows[0]!.balance = '-1';
  await assert.rejects(new ExperienceRankingSourceFacade().read(tx), {
    code: 'EXPERIENCE_RANKING_UNAVAILABLE',
  });
});

test('elapsed safety attempt removes its proof and preserves earlier accepted facts', async (t) => {
  let monotonic = 0;
  t.mock.method(performance, 'now', () => monotonic);
  const f = fixture(3);
  f.state.afterSafety = (id) => {
    if (id === 'account-1') monotonic = 1001;
  };
  const result = await f.service.ranking('valid', { limit: 50 });
  assert.equal(result.selectionStatus, 'scan_limited');
  assert.deepEqual(
    result.items.map((x) => x.profileId),
    ['public-account-0'],
  );
  assert.deepEqual(f.proofFacts, ['account-0']);
  assert.equal(
    f.calls.filter((sql) => sql === 'ROLLBACK TO SAVEPOINT ranking_candidate')
      .length,
    1,
  );
});
