import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { RuntimeConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import type { ProviderIdentity } from '../src/identity/contracts.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  M1_MANIFEST_SHA256,
  M1_SYNTHETIC_APP,
  readExactM1Migrations,
  requireM1TestConfig,
  requireM1SyntheticIdentity,
  retainExactM1,
  guardedM1Database,
} from './support/historical-m1/boundary.js';
import {
  requireOrdinarySourceParent,
  withReviewedTextSource,
} from './support/historical-m1/text-source-publication.js';
import {
  m1ProducerImport,
  m1ProducerResolver,
  installM1ProducerMapping,
} from './support/historical-m1/loader.js';
import {
  authorizeDiscussionPublication as authorizeHistoricalDiscussion,
  requireLegacyDiscussionTarget,
  withDiscussionPublicationMedia as historicalDiscussionMedia,
} from './support/historical-m1/discussion-publication-target.js';
import { withDiscussionPublicationMedia as currentDiscussionMedia } from '../src/community/discussion/publication-target.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import type { EffectiveContentEnvelopeDraft } from '../src/community/content-review/contracts.js';

import { restoreAcceptedHistoricalConfig } from './support/historical-lifecycle-identity/config-compatibility.js';
import { restoreAcceptedHistoricalErrors } from './support/historical-lifecycle-identity/application-error-compatibility.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const provenance = JSON.parse(
  await readFile(
    new URL('./support/historical-m1/provenance.json', import.meta.url),
    'utf8',
  ),
) as {
  baseline: string;
  snapshots: {
    path: string;
    originalPath: string;
    commit: string;
    blob: string;
    sha256: string;
  }[];
  importAdapters: {
    snapshot: string;
    adapter: string;
    originalDependency: string;
    sha256: string;
  }[];
  migrationManifestSha256: string;
  dependencies: Record<
    string,
    { sha256: string; predecessors: Record<string, string> }
  >;
};
const expectedSnapshots = [
  [
    '2f9f77260119664af3a06c488963153fdc12dab3',
    'b1104ba337eb15f290c9330cd307b523804a1938',
    '1d0b8d9f79bb95b0884baa26dcf7788ea028f6d8521be1d8282db9fe4dd8c446',
  ],
  [
    'f21bd371680c84849c92ac2360607f2084f2b56e',
    '4b6686991f12f326856169c6ca648d7f91e99ee1',
    '2fa72f4f3bd71874fb0eaac4529225158dbf616a40202b925a18def65d17440f',
  ],
  [
    'f21bd371680c84849c92ac2360607f2084f2b56e',
    '82d832dea030e763ad832a0007da27308c96a1ac',
    '51a99a1f741422248f2d96587a4dcb330e6acabf8221943a27f5158346247825',
  ],
];

test('M1 complete producer sources restore exactly, including dynamic type imports', async () => {
  assert.equal(provenance.baseline, 'fedf39f0bddbfb3974adb3ab88c542121c2fa137');
  assert.equal(provenance.snapshots.length, 3);
  for (const [index, record] of provenance.snapshots.entries()) {
    assert.deepEqual(
      [record.commit, record.blob, record.sha256],
      expectedSnapshots[index],
    );
    const snapshot = path.join(root, record.path),
      original = path.join(root, record.originalPath);
    const bytes = await readFile(snapshot, 'utf8');
    const restored = bytes.replace(
      /((?:from\s+|import\()')([^']+)(')/g,
      (whole, prefix: string, specifier: string, suffix: string) => {
        if (!specifier.startsWith('.')) return whole;
        let target = path.resolve(path.dirname(snapshot), specifier);
        const adapter = provenance.importAdapters.find(
          (edge) =>
            edge.snapshot === record.path &&
            target === path.join(root, edge.adapter).replace(/\.ts$/, '.js'),
        );
        if (adapter)
          target = path
            .join(root, adapter.originalDependency)
            .replace(/\.ts$/, '.js');
        const dependency = path
          .relative(root, target)
          .split(path.sep)
          .join('/')
          .replace(/\.js$/, '.ts');
        assert.ok(
          provenance.dependencies[dependency],
          `Unreviewed snapshot import ${dependency}`,
        );
        let relative = path
          .relative(path.dirname(original), target)
          .split(path.sep)
          .join('/');
        if (!relative.startsWith('.')) relative = './' + relative;
        return prefix + relative + suffix;
      },
    );
    assert.equal(hash(restored), record.sha256);
    const gitBlob = createHash('sha1')
      .update(`blob ${Buffer.byteLength(restored)}\0`)
      .update(restored)
      .digest('hex');
    assert.equal(gitBlob, record.blob);
    assert.notEqual(
      hash(restored + '\n'),
      record.sha256,
      'Even a non-import snapshot change is detected',
    );
  }
});

// These current imports differ from the source owner's commit. Their reviewed
// semantics and tested V6 branches are recorded in README.md; not "unchanged".
const reviewedChangedDependencies = [
  'apps/api/src/community/community.repository.ts',
  'apps/api/src/community/content-review/contracts.ts',
  'apps/api/src/community/contracts.ts',
  'apps/api/src/community/publication.repository.ts',
  'apps/api/src/community/related-sync/service.ts',
  'apps/api/src/community/text-review/runtime.ts',
  'apps/api/src/community/text-source/protocol.ts',
  'apps/api/src/community/text-source/publication.ts',
  'apps/api/src/community/text-source/repository.ts',
  'apps/api/src/config/config.ts',
];
test('M1 direct and current-reader seam dependency review is finite and byte-pinned', async () => {
  assert.equal(Object.keys(provenance.dependencies).length, 51);
  const changed = [];
  for (const [name, record] of Object.entries(provenance.dependencies)) {
    const dependency = await readFile(path.join(root, name));
    assert.equal(
      hash(
        name === 'apps/api/src/config/config.ts'
          ? restoreAcceptedHistoricalConfig(dependency)
          : name === 'apps/api/src/http/application-error.ts'
            ? restoreAcceptedHistoricalErrors(dependency)
            : dependency,
      ),
      record.sha256,
      `Review changed dependency ${name}`,
    );
    if (
      Object.values(record.predecessors).some(
        (value) => value !== record.sha256,
      )
    )
      changed.push(name);
  }
  assert.deepEqual(changed.sort(), reviewedChangedDependencies);
});

test('M1 manifest is the exact shared 175-file predecessor, never an arbitrary prefix', async () => {
  const migrations = await readExactM1Migrations();
  assert.equal(migrations.length, 175);
  assert.equal(migrations.at(-1)?.name, '0175_community_text_sources.sql');
  assert.equal(provenance.migrationManifestSha256, M1_MANIFEST_SHA256);
  const records = migrations.map(({ name, checksum }) => ({ name, checksum }));
  assert.equal(hash(JSON.stringify(records)), M1_MANIFEST_SHA256);
  assert.notEqual(
    hash(JSON.stringify(records.slice(0, -1))),
    M1_MANIFEST_SHA256,
  );
  assert.notEqual(
    hash(
      JSON.stringify([
        ...records,
        { name: '0176_fake.sql', checksum: '0'.repeat(64) },
      ]),
    ),
    M1_MANIFEST_SHA256,
  );
});

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
test('M1 composition is test-only, loopback-only, exact disposable DB, no SSL overrides', () => {
  requireM1TestConfig(config);
  for (const patch of [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'development' },
    { DATABASE_URL: 'postgres://fixture@example.com/whaleu_test' },
    { DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu' },
    {
      DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test?sslmode=disable',
    },
    {
      DATABASE_URL:
        'postgres://fixture@127.0.0.1/whaleu_test?host=remote.example',
    },
    {
      DATABASE_URL:
        'postgres://fixture@127.0.0.1/whaleu_test?database=production',
    },
    {
      DATABASE_URL:
        'postgres://fixture@127.0.0.1/whaleu_test?service=production',
    },
    {
      DATABASE_URL:
        'postgres://fixture@127.0.0.1/whaleu_test?options=-csearch_path=public',
    },
    { PG_SSL_MODE: 'verify-full' },
  ])
    assert.throws(() =>
      requireM1TestConfig({ ...config, ...patch } as RuntimeConfig),
    );
});

test('M1 synthetic identity inputs are exact immutable own-data snapshots, never real credentials', () => {
  const identity: ProviderIdentity = {
    provider: 'wechat',
    appId: M1_SYNTHETIC_APP,
    subject: randomUUID(),
  };
  const tokens = { access: 'a'.repeat(64), refresh: 'b'.repeat(64) };
  const saved = requireM1SyntheticIdentity(identity, tokens);
  assert.notEqual(saved.identity, identity);
  assert.notEqual(saved.tokens, tokens);
  assert.ok(Object.isFrozen(saved.identity) && Object.isFrozen(saved.tokens));
  const originalSubject = identity.subject;
  Object.assign(identity, { subject: randomUUID() });
  tokens.access = 'c'.repeat(64);
  assert.equal(saved.identity.subject, originalSubject);
  assert.equal(saved.tokens.access, 'a'.repeat(64));
  for (const invalid of [
    { ...identity, appId: 'real-wechat-application' },
    { ...identity, subject: 'external-provider-subject' },
    { ...identity, unionSubject: 'not-permitted' },
    Object.assign(Object.create({ unionSubject: 'inherited' }), identity),
    Object.defineProperty({ ...identity }, 'unionSubject', {
      value: 'hidden',
      enumerable: false,
    }),
    Object.defineProperty({ ...identity }, 'subject', {
      get: () => originalSubject,
      enumerable: true,
    }),
    Object.assign({ ...identity }, { [Symbol('hidden')]: 'value' }),
  ])
    assert.throws(() => requireM1SyntheticIdentity(invalid, tokens));
  assert.throws(() =>
    requireM1SyntheticIdentity(identity, {
      access: 'a'.repeat(64),
      refresh: 'a'.repeat(64),
    }),
  );
  assert.throws(() =>
    requireM1SyntheticIdentity(identity, Object.create(tokens)),
  );
});

const migrations = await readExactM1Migrations();
function transactionFixture() {
  const calls: string[] = [];
  const state = {
    database: 'whaleu_test',
    gate: true,
    exact: true,
    ledger: migrations.map(({ name, checksum }) => ({ name, checksum })),
  };
  const tx = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === 'SELECT current_database() AS database')
        return { rows: [{ database: state.database }] };
      if (sql.startsWith('SELECT pg_try_advisory'))
        return { rows: [{ locked: state.gate }] };
      if (sql.startsWith('LOCK TABLE') || sql.startsWith('SET CONSTRAINTS'))
        return { rows: [] };
      if (sql.startsWith('SELECT name,checksum')) return { rows: state.ledger };
      if (sql.startsWith('SELECT\n')) return { rows: [{ exact: state.exact }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (sql === 'SELECT 42 AS value') return { rows: [{ value: 42 }] };
      throw new Error(`Unexpected mocked statement: ${sql}`);
    },
  } as unknown as PoolClient;
  return { tx, state, calls };
}

test('M1 retained fences use one managed transaction, fail closed and re-enroll after savepoint restore', async () => {
  const { tx, calls, state } = transactionFixture();
  await assert.rejects(retainExactM1(tx), /managed transaction/);
  startTransactionDeadlines(tx);
  try {
    const before = checkpointTransactionDeadlines(tx);
    await retainExactM1(tx);
    assert.ok(
      calls.some((sql) =>
        sql.includes('schema_migrations IN SHARE MODE NOWAIT'),
      ),
    );
    assert.ok(calls.some((sql) => sql.includes('IN ACCESS SHARE MODE NOWAIT')));
    const initialChecks = calls.filter((sql) =>
      sql.startsWith('SELECT\n'),
    ).length;
    await retainExactM1(tx);
    assert.equal(
      calls.filter((sql) => sql.startsWith('SELECT\n')).length,
      initialChecks,
    );
    restoreTransactionDeadlines(tx, before);
    await retainExactM1(tx);
    state.exact = false;
    await assert.rejects(
      checkTransactionDeadlines(tx),
      /Partial\/future owners/,
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
  for (const corruption of ['database', 'gate', 'catalog', 'ledger'] as const) {
    const fixture = transactionFixture();
    if (corruption === 'database') fixture.state.database = 'wrong-destination';
    if (corruption === 'gate') fixture.state.gate = false;
    if (corruption === 'catalog') fixture.state.exact = false;
    if (corruption === 'ledger')
      fixture.state.ledger.push({
        name: '0176_durable_reading_formatting.sql',
        checksum: '0'.repeat(64),
      });
    startTransactionDeadlines(fixture.tx);
    try {
      await assert.rejects(retainExactM1(fixture.tx));
    } finally {
      clearTransactionDeadlines(fixture.tx);
    }
  }
});

test('M1 standalone database query cannot precheck on a different client or skip final proof', async () => {
  const fixture = transactionFixture();
  const database = {
    query: () => {
      throw new Error('Unmanaged database query forbidden');
    },
    transaction: async <T>(operation: (tx: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(fixture.tx);
      try {
        const result = await operation(fixture.tx);
        await checkTransactionDeadlines(fixture.tx);
        return result;
      } finally {
        clearTransactionDeadlines(fixture.tx);
      }
    },
  } as unknown as DatabaseService;
  const guarded = guardedM1Database(database);
  assert.equal(
    (await guarded.query('SELECT 42 AS value')).rows[0]!['value'],
    42,
  );
  const use = fixture.calls.indexOf('SELECT 42 AS value');
  assert.ok(
    fixture.calls.slice(0, use).some((sql) => sql.startsWith('LOCK TABLE')),
  );
  assert.ok(
    fixture.calls
      .slice(use + 1)
      .some((sql) => sql.startsWith('SELECT name,checksum')),
  );
  await assert.rejects(
    guarded.transaction(async () => {
      fixture.state.exact = false;
      return 'not committed';
    }),
  );
});

test('M1 comment/reply seam pins the original f21 narrowing SQL and refuses missing parent evidence', async () => {
  const source = await readFile(
    path.join(
      root,
      'apps/api/test/support/historical-m1/text-source-publication.ts',
    ),
    'utf8',
  );
  const body = source.slice(
    source.indexOf('export async function requireOrdinarySourceParent('),
    source.indexOf('\n\n/** Identity-specific'),
  );
  const expected =
    '4f2d6ee2546e16a4e6b6de4a0ffcbd9128b1389f098b762f8472f07dac09c274';
  assert.equal(hash(body), expected);
  assert.notEqual(hash(body.replace('IN (1,2,6)', 'IN (1,2,6,7)')), expected);
  assert.notEqual(
    hash(
      body.replace(
        "if (!row) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');",
        'return;',
      ),
    ),
    expected,
  );
  let present = false;
  const id = randomUUID();
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      assert.match(sql, /publication_envelope_version IN \(1,2,6\)/);
      assert.match(sql, /FOR SHARE OF p$/);
      assert.match(sql, /post_owner_visibility/);
      assert.match(sql, /post_distribution_bindings/);
      assert.deepEqual(values, [id]);
      return { rows: present ? [{ id }] : [] };
    },
  } as unknown as PoolClient;
  await assert.rejects(requireOrdinarySourceParent(id, tx));
  present = true;
  await requireOrdinarySourceParent(id, tx);
});

test('M1 full source helper retains original V6 admission and rejects V7/nonordinary composition', () => {
  const source = {
    version: 1,
    format: 'plain',
    readingFormatting: 'auto',
  } as const;
  const spaceId = randomUUID();
  const ordinary = {
    version: 2,
    accountId: randomUUID(),
    purpose: 'publish_post',
    spaceId,
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: '  e\u0301\noriginal source  ',
    component: { kind: 'none' },
    trading: null,
    allowAnonymousDm: false,
    scope: {
      originalSpaceId: spaceId,
      originalRegionId: null,
      authorOriginRegionId: null,
      identityRegionId: null,
      topologySnapshotId: null,
      sync: 'none',
    },
  } as const satisfies EffectiveContentEnvelopeDraft;
  const admitted = withReviewedTextSource(ordinary, source);
  assert.equal(admitted.version, 6);
  assert.equal(admitted.text, ordinary.text);
  for (const patch of [
    { version: 7 },
    { version: 8 },
    { category: 'feedback' },
    { category: 'trading' },
    { commentsPolicy: 'restricted' },
    { allowAnonymousDm: true },
    { component: { kind: 'poll' } },
    { trading: {} },
    { scope: { ...ordinary.scope, sync: 'inherited_related' } },
  ])
    assert.throws(() =>
      withReviewedTextSource(
        { ...ordinary, ...patch } as EffectiveContentEnvelopeDraft,
        source,
      ),
    );
});

test('M1 loader maps only both producer edges, rejects unexpected resolution, and detects preloading', () => {
  const historical = new URL(
    './support/historical-m1/publication.service.ts',
    import.meta.url,
  ).href;
  const reply = new URL(
    '../src/community/discussion/publication.service.ts',
    import.meta.url,
  ).href;
  const saved = new URL(
    './support/historical-m1/text-source-publication.ts',
    import.meta.url,
  ).href;
  const current = new URL(
    '../src/community/text-source/publication.js',
    import.meta.url,
  ).href;
  const contexts = [
    [historical, '../../../src/community/text-source/publication.js'],
    [reply, '../text-source/publication.js'],
  ] as const;
  const mapped: string[] = [];
  const resolve = m1ProducerResolver((parent) => mapped.push(parent));
  for (const [parentURL, specifier] of contexts) {
    assert.equal(m1ProducerImport(specifier, parentURL), saved);
    const context = { parentURL, conditions: [], importAttributes: {} };
    const result = resolve(specifier, context, (target) => ({ url: target }));
    assert.equal(result.url, saved);
    assert.throws(
      () => resolve(specifier, context, () => ({ url: current })),
      /resolution changed/,
    );
  }
  assert.deepEqual(mapped, [historical, reply]);
  for (const parent of [
    '../src/community/publication.service.ts',
    '../src/community/text-source/controller.ts',
    '../src/community/text-source/read.service.ts',
    '../src/community/reading-content/service.ts',
    '../src/community/reading-content/controller.ts',
  ]) {
    const parentURL = new URL(parent, import.meta.url).href;
    assert.equal(m1ProducerImport(current, parentURL), undefined);
    const result = resolve(
      current,
      { parentURL, conditions: [], importAttributes: {} },
      (target) => ({ url: target }),
    );
    assert.equal(result.url, current);
  }
  assert.equal(m1ProducerImport(current, undefined), undefined);
  assert.equal(m1ProducerImport('node:assert/strict', historical), undefined);
  const registration = installM1ProducerMapping(config);
  try {
    assert.throws(() => registration.assertComplete(), /preloaded/);
  } finally {
    registration.deregister();
  }
  assert.throws(() =>
    installM1ProducerMapping({ ...config, NODE_ENV: 'production' }),
  );
});

test('M1 Node24/tsx hook resolves both real producer imports without startup or database access', async () => {
  const mapping = installM1ProducerMapping(config);
  try {
    const [historical, reply] = await Promise.all([
      import('./support/historical-m1/publication.service.js'),
      import('../src/community/discussion/publication.service.js'),
    ]);
    assert.equal(typeof historical.PublicationService, 'function');
    assert.equal(typeof reply.ReplyPublicationService, 'function');
    mapping.assertComplete();
  } finally {
    mapping.deregister();
  }
});

test('M1 checked import adapter is one exact edge and retains the real media wrapper', async () => {
  assert.equal(provenance.importAdapters.length, 1);
  const edge = provenance.importAdapters[0]!;
  assert.equal(
    edge.snapshot,
    'apps/api/test/support/historical-m1/publication.service.ts',
  );
  assert.equal(
    edge.adapter,
    'apps/api/test/support/historical-m1/discussion-publication-target.ts',
  );
  assert.equal(
    edge.originalDependency,
    'apps/api/src/community/discussion/publication-target.ts',
  );
  assert.equal(
    hash(await readFile(path.join(root, edge.adapter))),
    edge.sha256,
  );
  assert.equal(historicalDiscussionMedia, currentDiscussionMedia);
});

test('M1 category boundary preserves legacy values but rejects water and new Home versions', () => {
  const legacy = [
    'discussion',
    'feedback',
    'confession',
    'companions',
    'pets',
    'internships',
    'scenery',
    'dorms',
    'research',
    'deep_sea',
    'trading',
  ];
  for (const category of legacy) {
    for (const version of [undefined, 1, 2, 3, 4, 5, 6]) {
      const target = {
        post: {
          category,
          ...(version === undefined
            ? {}
            : { publication_envelope_version: version }),
          id: 'unchanged',
        },
        authority: { marker: 'same' },
      };
      const narrowed = requireLegacyDiscussionTarget(target);
      assert.deepEqual(narrowed, target);
      assert.equal(narrowed.authority, target.authority);
      assert.equal(target.post.category, category);
    }
  }
  for (const post of [
    { category: 'water', publication_envelope_version: 1 },
    { category: 'water', publication_envelope_version: 7 },
    { category: 'discussion', publication_envelope_version: 7 },
    { category: 'discussion', publication_envelope_version: 8 },
    { category: 'discussion', publication_envelope_version: 0 },
    { category: 'unknown', publication_envelope_version: 6 },
  ])
    assert.throws(() => requireLegacyDiscussionTarget({ post }), {
      code: 'CONTENT_REVIEW_UNAVAILABLE',
    });
});

test('M1 checked adapter runs real authorization first and propagates its denial', async () => {
  const denial = new Error('exact real ancestor lookup denial');
  let reads = 0;
  const access = {
    accessiblePost: async () => {
      reads++;
      throw denial;
    },
  } as unknown as CommunityAccessService;
  await assert.rejects(
    authorizeHistoricalDiscussion(
      access,
      {} as CommunityRepository,
      'actor',
      { kind: 'comment', postId: 'post' },
      {} as PoolClient,
    ),
    (error: unknown) => error === denial,
  );
  assert.equal(reads, 1);
});
