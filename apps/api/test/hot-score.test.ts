import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { manualProcessingConfig } from '../src/config/manual-processing.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  HOT_SCORE_COMPONENTS,
  counterSchema,
  hotScoreInputsSchema,
  hotScoreOptionsSchema,
  parseHotScoreCommand,
  validateHotScoreSnapshot,
} from '../src/community/hot-score/contracts.js';
import type {
  HotScoreInputs,
  HotScoreSnapshot,
} from '../src/community/hot-score/contracts.js';
import {
  HotScoreEvaluator,
  HotScoreNumericError,
} from '../src/community/hot-score/evaluator.js';
import {
  HOT_SCORE_FORMULA,
  HOT_SCORE_FORMULA_FINGERPRINT,
  HOT_SCORE_EXPRESSION_FINGERPRINT,
  HOT_SCORE_NUMERIC_PROFILE,
  HOT_SCORE_NUMERIC_SQL,
} from '../src/community/hot-score/formula.js';
import {
  HotScoreRepository,
  HOT_SCORE_SNAPSHOT_SQL,
} from '../src/community/hot-score/repository.js';
import {
  HotScoreService,
  assertLocalHotScore,
  assertLocalHotScoreConnection,
} from '../src/community/hot-score/service.js';

const id = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333';
const zeroInputs: HotScoreInputs = {
  views: '0',
  postLikes: '0',
  subscriptions: '0',
  rawRootComments: '0',
  rawReplies: '0',
  eligibleComments: '0',
  uniqueEligibleAccounts: '0',
};
function fixture(): HotScoreSnapshot {
  const baseline = {
    postId: id,
    ownerId: owner,
    sourceRequestId: request,
    creationXid: '123',
    createdAt: '2026-10-08T00:00:00Z',
    componentVersion: 1,
    origin: 'native_post_creation',
    openingCounts: ['0'],
    publicationVerified: true,
  } as const;
  const state = {
    postId: id,
    counts: ['0'],
    processedHead: '0',
    capturedHead: '0',
    lastReceiptId: null,
    terminalReceiptValid: true,
    unresolvedSequence: null,
    invalidReceipt: false,
  };
  return structuredClone({
    postId: id,
    ownerId: owner,
    creationXid: '123',
    snapshotAt: '2026-10-08T01:00:00Z',
    baselines: {
      subscription: { ...baseline, openingCounts: ['0'] },
      like: { ...baseline, openingCounts: ['0'] },
      comment: { ...baseline, openingCounts: ['0', '0', '0', '0'] },
      view: { ...baseline, openingCounts: ['0'] },
    },
    states: {
      subscription: { ...state },
      like: { ...state },
      comment: { ...state, counts: ['0', '0', '0', '0'] },
      view: { postId: id, count: '0' },
    },
  });
}

for (const component of HOT_SCORE_COMPONENTS) {
  test(`internal score independently requires ${component} coverage and state`, () => {
    const snapshot = fixture();
    snapshot.baselines[component] = null;
    assert.deepEqual(validateHotScoreSnapshot(snapshot), {
      status: 'blockedCoverage',
    });
    const missingState = fixture();
    missingState.states[component] = null;
    assert.deepEqual(validateHotScoreSnapshot(missingState), {
      status: 'unavailable',
    });
  });
  test(`internal score checks exact ${component} publication provenance`, () => {
    for (const patch of [
      { postId: owner },
      { ownerId: id },
      { sourceRequestId: owner },
      { creationXid: '124' },
      { componentVersion: 2 },
      { origin: 'historical_import' },
      { publicationVerified: false },
      { openingCounts: ['1'] },
    ]) {
      const snapshot = fixture();
      Object.assign(snapshot.baselines[component]!, patch);
      assert.deepEqual(validateHotScoreSnapshot(snapshot), {
        status: 'unavailable',
      });
    }
  });
}
test('internal known-zero baseline is ready, without treating unknown as zero', () => {
  const result = validateHotScoreSnapshot(fixture());
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') assert.deepEqual(result.inputs, zeroInputs);
  const snapshot = fixture();
  for (const component of HOT_SCORE_COMPONENTS)
    snapshot.baselines[component] = null;
  assert.deepEqual(validateHotScoreSnapshot(snapshot), {
    status: 'blockedCoverage',
  });
});
for (const component of ['subscription', 'like', 'comment'] as const) {
  test(`internal ${component} source freshness is independent from live counts`, () => {
    const snapshot = fixture();
    Object.assign(snapshot.states[component]!, {
      capturedHead: '9007199254741011',
      unresolvedSequence: '9007199254740993',
    });
    assert.deepEqual(validateHotScoreSnapshot(snapshot), {
      status: 'blockedFreshness',
    });
    snapshot.states[component]!.unresolvedSequence = null;
    assert.deepEqual(validateHotScoreSnapshot(snapshot), {
      status: 'blockedFreshness',
    });
    Object.assign(snapshot.states[component]!, {
      processedHead: '9007199254741011',
      lastReceiptId: request,
    });
    assert.equal(validateHotScoreSnapshot(snapshot).status, 'ready');
  });
  test(`internal ${component} malformed heads and receipt association fail closed`, () => {
    for (const patch of [
      { terminalReceiptValid: false },
      { invalidReceipt: true },
      { processedHead: '1' },
      { lastReceiptId: request },
      { processedHead: '2', capturedHead: '1', lastReceiptId: request },
      { counts: component === 'comment' ? ['1', '0', '0', '0'] : ['1'] },
      { capturedHead: '1', unresolvedSequence: '2' },
      { capturedHead: '1', unresolvedSequence: '0' },
    ]) {
      const snapshot = fixture();
      Object.assign(snapshot.states[component]!, patch);
      assert.deepEqual(validateHotScoreSnapshot(snapshot), {
        status: 'unavailable',
      });
    }
  });
}
test('independent nonzero source heads and sequence gaps never require a common watermark', () => {
  const snapshot = fixture();
  for (const [component, sequence] of [
    ['subscription', '3'],
    ['like', '9007199254740993'],
    ['comment', '9223372036854775807'],
  ] as const)
    Object.assign(snapshot.states[component]!, {
      processedHead: sequence,
      capturedHead: sequence,
      lastReceiptId: request,
    });
  assert.equal(validateHotScoreSnapshot(snapshot).status, 'ready');
});
const invalidCounters = [
  '-1',
  '01',
  '+1',
  '1.0',
  '1e3',
  ' 1',
  '1 ',
  'NaN',
  'Infinity',
  '',
  'bad',
  '9223372036854775808',
];
for (const value of invalidCounters)
  test(`counter ${JSON.stringify(value)} fails safely without BigInt throwing`, () => {
    assert.equal(counterSchema.safeParse(value).success, false);
    for (const field of Object.keys(zeroInputs) as (keyof HotScoreInputs)[])
      assert.equal(
        hotScoreInputsSchema.safeParse({ ...zeroInputs, [field]: value })
          .success,
        false,
      );
    const snapshot = fixture();
    snapshot.states.comment!.counts[2] = value;
    assert.deepEqual(validateHotScoreSnapshot(snapshot), {
      status: 'unavailable',
    });
    snapshot.baselines.comment!.creationXid = value;
    assert.deepEqual(validateHotScoreSnapshot(snapshot), {
      status: 'unavailable',
    });
  });
test('canonical input validation keeps full bigint range and exact raw-sum arithmetic', () => {
  for (const value of ['0', '9007199254740993', '9223372036854775807'])
    assert.equal(counterSchema.safeParse(value).success, true);
  const max = '9223372036854775807';
  assert.equal(
    hotScoreInputsSchema.safeParse(
      Object.fromEntries(Object.keys(zeroInputs).map((k) => [k, max])),
    ).success,
    true,
  );
  assert.equal(
    hotScoreInputsSchema.safeParse({
      ...zeroInputs,
      rawRootComments: '1',
      eligibleComments: '2',
    }).success,
    false,
  );
  assert.equal(
    hotScoreInputsSchema.safeParse({
      ...zeroInputs,
      uniqueEligibleAccounts: '1',
    }).success,
    false,
  );
});
test('score options are explicit bounded normalized selections and default advisory', () => {
  assert.deepEqual(parseHotScoreCommand([]), { mode: 'dry-run', postIds: [] });
  assert.deepEqual(parseHotScoreCommand([`--post-id=${id}`]), {
    mode: 'dry-run',
    postIds: [id],
  });
  assert.deepEqual(parseHotScoreCommand(['compute', `--post-id=${id}`]), {
    mode: 'compute',
    postIds: [id],
  });
  for (const args of [
    ['compute'],
    ['apply'],
    ['--all'],
    ['--post-id=bad'],
    [`--post-id=${id}`, `--post-id=${id}`],
  ])
    assert.throws(() => parseHotScoreCommand(args));
  const ids = Array.from(
    { length: 51 },
    (_, n) => `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`,
  );
  assert.equal(
    hotScoreOptionsSchema.safeParse({
      mode: 'compute',
      postIds: ids.slice(0, 50),
    }).success,
    true,
  );
  assert.equal(
    hotScoreOptionsSchema.safeParse({ mode: 'compute', postIds: ids }).success,
    false,
  );
  assert.equal(
    hotScoreOptionsSchema.safeParse({
      postIds: [ids[0], ids[0]!.toUpperCase()],
    }).success,
    false,
  );
  assert.equal(hotScoreOptionsSchema.safeParse({ all: true }).success, false);
});
test('pinned formula identity names source constants separately from rewrite numeric profile', () => {
  assert.equal(HOT_SCORE_FORMULA.sourceFormulaVersion, 6);
  assert.deepEqual(HOT_SCORE_FORMULA.weights, {
    views: '7.6',
    postLikes: '24.0',
    comments: '10.0',
    subscriptions: '2.0',
  });
  assert.deepEqual(HOT_SCORE_FORMULA.supportThresholds, {
    views: '200',
    postLikes: '10',
  });
  assert.equal(HOT_SCORE_FORMULA.aggregateCommentCapMultiplier, '3');
  assert.equal(HOT_SCORE_FORMULA.viewExponent, '0.4');
  assert.equal(HOT_SCORE_NUMERIC_PROFILE, 'pg18-numeric40-round4-v1');
  assert.equal(
    HOT_SCORE_FORMULA_FINGERPRINT,
    'd13db20fa6b3db237bbf58b0d1158b023bb63db00649308adeec8300d2ed0508',
  );
  assert.equal(
    HOT_SCORE_EXPRESSION_FINGERPRINT,
    '889310ad4cdd3400804d56df8c5cd72057ee330c3b928106d10bc51c30964af1',
  );
  assert.match(HOT_SCORE_NUMERIC_SQL, /least\(eligible, actors \* cap\)/);
  assert.match(HOT_SCORE_NUMERIC_SQL, /ln\(one \+ likes\)/);
  assert.doesNotMatch(
    HOT_SCORE_NUMERIC_SQL,
    /\blog\(|double precision|::bigint/,
  );
  assert.equal((HOT_SCORE_NUMERIC_SQL.match(/round\(/g) ?? []).length, 1);
  assert.match(HOT_SCORE_NUMERIC_SQL, /numeric\(24,4\)::text/);
});
test('numeric evaluator passes canonical decimal strings unchanged and rejects nonfinite/negative/bad-scale outputs', async () => {
  const evaluator = new HotScoreEvaluator();
  const queries: { sql: string; values: unknown[] }[] = [];
  let score = '0.0000',
    version = 180006;
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return { rows: [{ score, server_version: version }] };
    },
  } as unknown as PoolClient;
  assert.equal(await evaluator.evaluate(zeroInputs, tx), '0.0000');
  assert.deepEqual(queries[0]?.values, ['0', '0', '0', '0', '0']);
  for (const output of [
    'NaN',
    'Infinity',
    '-0.0001',
    '1',
    '1.000',
    '01.0000',
    '1.00000',
  ]) {
    score = output;
    await assert.rejects(
      evaluator.evaluate(zeroInputs, tx),
      HotScoreNumericError,
    );
  }
  score = '1234.5678';
  version = 190000;
  await assert.rejects(
    evaluator.evaluate(zeroInputs, tx),
    HotScoreNumericError,
  );
  version = 180005;
  await assert.rejects(
    evaluator.evaluate(zeroInputs, tx),
    HotScoreNumericError,
  );
  version = 180006;
  assert.equal(await evaluator.evaluate(zeroInputs, tx), '1234.5678');
  const before = queries.length;
  await assert.rejects(
    evaluator.evaluate({ ...zeroInputs, views: 'NaN' }, tx),
    HotScoreNumericError,
  );
  assert.equal(queries.length, before);
});

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://localhost/whaleu_test',
  HOT_SCORE_COMPUTATION: 'manual_only',
});
function harness(
  options: {
    snapshot?: HotScoreSnapshot | null;
    covered?: boolean;
    missing?: boolean;
    failure?: string;
    score?: string;
  } = {},
) {
  const statements: string[] = [];
  const isolation: unknown[] = [];
  const tx = {
    host: 'localhost',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string) => {
      statements.push(sql);
      if (options.failure && sql.includes(options.failure))
        throw new Error('secret database error');
      if (sql === 'SELECT current_database() AS name')
        return { rows: [{ name: 'whaleu_test' }] };
      if (sql === HOT_SCORE_SNAPSHOT_SQL)
        return {
          rows:
            options.snapshot === null
              ? []
              : [{ snapshot: options.snapshot ?? fixture() }],
        };
      if (sql === HOT_SCORE_NUMERIC_SQL)
        return {
          rows: [{ score: options.score ?? '0.0000', server_version: 180006 }],
        };
      if (sql.endsWith('AS covered'))
        return { rows: [{ covered: options.covered ?? true }] };
      if (sql.includes('FROM whaleu_community.posts'))
        return { rows: options.missing ? [] : [{ id }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(
      work: (tx: PoolClient) => Promise<T>,
      settings: unknown,
    ) => {
      isolation.push(settings);
      return work(tx);
    },
  } as unknown as DatabaseService;
  return {
    statements,
    isolation,
    tx,
    service: new HotScoreService(
      config,
      database,
      new HotScoreRepository(),
      new HotScoreEvaluator(),
    ),
    database,
  };
}
test('compute takes parent, coverage, fixed four state locks, one snapshot and frozen-input arithmetic', async () => {
  const h = harness();
  const result = await h.service.inspect(id, 'compute');
  assert.equal(result.status, 'computed');
  assert.deepEqual(h.isolation, [{ isolationLevel: 'read committed' }]);
  const locks = h.statements.filter((s) => s.includes('FOR UPDATE'));
  assert.deepEqual(locks, [
    `SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE`,
    ...HOT_SCORE_COMPONENTS.map(
      (c) =>
        `SELECT post_id FROM whaleu_post_hotness.${c}_states WHERE post_id=$1 FOR UPDATE`,
    ),
  ]);
  assert.equal(
    h.statements.filter((s) => s === HOT_SCORE_SNAPSHOT_SQL).length,
    1,
  );
  assert.ok(
    h.statements.indexOf(HOT_SCORE_SNAPSHOT_SQL) >
      h.statements.indexOf(locks.at(-1)!),
  );
  assert.ok(
    h.statements.some((s) => s.includes("transaction_timeout='5000ms'")),
  );
  assert.doesNotMatch(
    h.statements.join('\n'),
    /\b(?:INSERT|DELETE|UPDATE\s+whaleu|nextval|setval)\b/i,
  );
  if (result.status === 'computed') {
    assert.equal(result.advisory, false);
    assert.equal(result.score, '0.0000');
    assert.equal(result.snapshot.states.view?.count, '0');
    assert.equal(
      result.viewIntegrity,
      'trusted_reporting_owner_and_access_controls',
    );
  }
});
test('dry-run starts read only and never takes mutation-oriented locks', async () => {
  const h = harness();
  const result = await h.service.inspect(id);
  assert.equal(result.status, 'computed');
  assert.equal(result.advisory, true);
  assert.equal(h.statements[0], 'SET TRANSACTION READ ONLY');
  assert.doesNotMatch(
    h.statements.join('\n'),
    /FOR UPDATE|FOR SHARE|LOCK TABLE/,
  );
});
test('missing, coverage, freshness, inconsistent and numeric errors never contain a score', async () => {
  const stale = fixture();
  stale.states.like!.capturedHead = '1';
  stale.states.like!.unresolvedSequence = '1';
  const malformed = fixture();
  malformed.states.comment!.terminalReceiptValid = false;
  for (const [options, status] of [
    [{ missing: true }, 'missing'],
    [{ covered: false }, 'blockedCoverage'],
    [{ snapshot: stale }, 'blockedFreshness'],
    [{ snapshot: malformed }, 'unavailable'],
    [{ score: 'NaN' }, 'numericFailure'],
    [{ failure: 'FOR UPDATE' }, 'failed'],
  ] as const) {
    const h = harness(options);
    const result = await h.service.inspect(id, 'compute');
    assert.deepEqual(result, { postId: id, status, advisory: false });
    if (status !== 'numericFailure')
      assert.equal(h.statements.includes(HOT_SCORE_NUMERIC_SQL), false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});
test('run emits bounded category summary only', async () => {
  const h = harness();
  const result = await h.service.run({ mode: 'compute', postIds: [id] });
  assert.deepEqual(result, {
    mode: 'compute',
    advisory: false,
    requested: 1,
    computed: 1,
    missing: 0,
    blockedCoverage: 0,
    blockedFreshness: 0,
    unavailable: 0,
    numericFailure: 0,
    failed: 0,
  });
  assert.equal(JSON.stringify(result).includes(id), false);
});
test('disabled is default and cannot be promoted by manual isolation; every unrelated owner is disabled', async () => {
  const defaults = loadConfig({
    DATABASE_URL: 'postgresql://localhost/whaleu_test',
  });
  assert.equal(defaults.HOT_SCORE_COMPUTATION, 'disabled');
  assert.throws(() =>
    loadConfig({
      DATABASE_URL: defaults.DATABASE_URL,
      HOT_SCORE_COMPUTATION: 'automatic',
    }),
  );
  assert.equal(
    manualProcessingConfig(defaults, 'hotScore').HOT_SCORE_COMPUTATION,
    'disabled',
  );
  const selected = manualProcessingConfig(config, 'hotScore');
  for (const [key, value] of Object.entries(selected))
    if (key.endsWith('_PROCESSING')) assert.equal(value, 'disabled');
  assert.equal(selected.HOT_SCORE_COMPUTATION, 'manual_only');
  for (const owner of [
    'updates',
    'jury',
    'experience',
    'subscriptions',
    'likes',
    'comments',
  ] as const)
    assert.equal(
      manualProcessingConfig(config, owner).HOT_SCORE_COMPUTATION,
      'disabled',
    );
  const h = harness();
  const service = new HotScoreService(
    defaults,
    h.database,
    new HotScoreRepository(),
    new HotScoreEvaluator(),
  );
  await assert.rejects(service.inspect(id, 'compute'), /disabled/);
  assert.equal(h.statements.length, 0);
  assert.equal((await service.inspect(id, 'dry-run')).status, 'computed');
});
test('local guards refuse remote URLs, production, unexpected database and remote actual peer', async () => {
  for (const altered of [
    { NODE_ENV: 'production' as const },
    { DATABASE_URL: 'postgresql://example.com/whaleu_test' },
    { DATABASE_URL: 'postgresql://localhost/real_data' },
  ])
    assert.throws(() => assertLocalHotScore({ ...config, ...altered }));
  assert.doesNotThrow(() => assertLocalHotScore(config));
  const h = harness();
  await assertLocalHotScoreConnection(h.tx);
  const remote = {
    host: 'localhost',
    connection: { stream: { remoteAddress: '192.0.2.1' } },
    query: async () => {
      throw new Error('must not read');
    },
  } as unknown as PoolClient;
  await assert.rejects(
    assertLocalHotScoreConnection(remote),
    /actual loopback/,
  );
  const wrong = {
    host: 'localhost',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async () => ({ rows: [{ name: 'real_data' }] }),
  } as unknown as PoolClient;
  await assert.rejects(
    assertLocalHotScoreConnection(wrong),
    /disposable database/,
  );
});
test('snapshot SQL verifies source identity, terminal after-counts and exact saved obligation without membership queries', () => {
  assert.match(
    HOT_SCORE_SNAPSHOT_SQL,
    /r\.after_count=subscription_state\.count/,
  );
  assert.match(HOT_SCORE_SNAPSHOT_SQL, /r\.after_count=like_state\.count/);
  assert.match(
    HOT_SCORE_SNAPSHOT_SQL,
    /r\.after_unique_actor_count=comment_state\.unique_actor_count/,
  );
  assert.match(HOT_SCORE_SNAPSHOT_SQL, /obligation\.status='completed'/);
  assert.match(
    HOT_SCORE_SNAPSHOT_SQL,
    /obligation\.local_creation_transaction=src\.source_transaction/,
  );
  assert.match(
    HOT_SCORE_SNAPSHOT_SQL,
    /r\.root_id IS NOT DISTINCT FROM src\.root_id/,
  );
  assert.match(
    HOT_SCORE_SNAPSHOT_SQL,
    /r\.positive_source_id IS NOT DISTINCT FROM src\.positive_source_id/,
  );
  assert.match(
    HOT_SCORE_SNAPSHOT_SQL,
    /creation_xid=p\.local_creation_transaction/,
  );
  assert.doesNotMatch(
    HOT_SCORE_SNAPSHOT_SQL,
    /FOR UPDATE|_memberships|comment_contributions|SET status|author_interactions/,
  );
});
test('score module remains absent from the public application graph', async () => {
  for (const path of [
    '../src/app.module.ts',
    '../src/community/community.module.ts',
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /hot-score|HotScore/);
  }
  const cli = await readFile(
    new URL('../src/community/hot-score/compute-score.ts', import.meta.url),
    'utf8',
  );
  assert.match(cli, /manualProcessingConfig\(config, 'hotScore'\)/);
  assert.match(cli, /logger: false/);
  assert.doesNotMatch(cli, /error\.message|console\.error/);
});
