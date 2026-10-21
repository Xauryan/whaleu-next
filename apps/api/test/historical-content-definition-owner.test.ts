import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { CampusService } from '../src/campus/campus.service.js';
import { loadConfig } from '../src/config/config.js';
import { MIGRATION_LOCK, readMigrations } from '../src/database/migrations.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import type { ContentScopeSnapshot } from '../src/community/content-review/contracts.js';
import {
  reconstructDefinition,
  definitionMatchesApproval,
} from '../src/community/content-review/definition-validation.js';
import type {
  DefinitionPost,
  DefinitionPayload,
} from '../src/community/content-review/definition-validation.js';
import { approvalDigest } from '../src/community/content-review/contracts.js';
import { reconstructDefinition as predecessorDefinition } from './support/historical-content-definition/definition-validation.js';
import {
  configureHistoricalContentDefinitions,
  historicalContentDefinitionRepository,
  historicalTextSourceAbsenceSql,
  historicalContentDefinitionPrefixes,
  HistoricalContentDefinitionRepository,
} from './support/historical-content-definition/configure.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const manifest = await readMigrations(
  fileURLToPath(new URL('../migrations', import.meta.url)),
);
const prefixManifest = (prefix: number) =>
  manifest
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
const post: DefinitionPost = {
  id: randomUUID(),
  space_id: randomUUID(),
  account_id: randomUUID(),
  category: 'discussion',
  text: 'Synthetic retained definition',
  author_mode: 'named',
  comments_policy: 'open',
  publication_envelope_version: 1,
  publication_state: 'published',
  visibility: 'approved',
  deleted_at: null,
  published_at: new Date('2026-01-01T00:00:00Z'),
};
const region = randomUUID();
const scope: ContentScopeSnapshot = {
  originalSpaceId: post.space_id,
  originalRegionId: region,
  authorOriginRegionId: region,
  identityRegionId: region,
  topologySnapshotId: randomUUID(),
  sync: 'none',
};
const campuses = {
  requireActiveRegion: async (id: string) => assert.equal(id, region),
} as unknown as CampusService;

test('historical reader and differential oracle are exact c27 bytes except import relocation', async () => {
  const provenance = JSON.parse(
    await readFile(
      new URL(
        './support/historical-content-definition/provenance.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    source: string;
    snapshot: string;
    commit: string;
    blob: string;
    sourceSha256: string;
  }[];
  assert.deepEqual(
    provenance.map(({ sourceSha256, blob }) => ({ sourceSha256, blob })),
    [
      {
        sourceSha256:
          'c49a61c9e08b80eb3b685314f87f10a5b41ad2cc0c0fa29d5cbfd96b26e2e343',
        blob: 'c8fcd226f17120c0973fb6d1e9da0d6f7d0af626',
      },
      {
        sourceSha256:
          '1c33d5da252b38520b01769e17585b3838af022168145eeb3adabbcf0074d951',
        blob: 'ba9f5552a7ad064444d1d360a672c1e0aad5f5a9',
      },
    ],
  );
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  for (const record of provenance) {
    assert.equal(record.commit, 'c27f173d8057f349469f4f96855d31edb9cff7c5');
    const snapshot = path.join(root, record.snapshot);
    const original = path.join(root, record.source);
    const bytes = await readFile(snapshot, 'utf8');
    const restored = bytes.replace(
      /from '([^']+)'/g,
      (whole, specifier: string) => {
        if (!specifier.startsWith('.')) return whole;
        const relative = path
          .relative(
            path.dirname(original),
            path.resolve(path.dirname(snapshot), specifier),
          )
          .split(path.sep)
          .join('/');
        return `from '${relative.startsWith('.') ? relative : './' + relative}'`;
      },
    );
    assert.equal(
      createHash('sha256').update(restored).digest('hex'),
      record.sourceSha256,
    );
    assert.equal(
      createHash('sha1')
        .update(`blob ${Buffer.byteLength(restored)}\0`)
        .update(restored)
        .digest('hex'),
      record.blob,
    );
  }
  const snapshot = await readFile(
    new URL(
      './support/historical-content-definition/content-definition.repository.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.ok(
    snapshot.includes(
      "from '../../../src/community/content-review/definition-validation.js'",
    ),
  );
  assert.equal(
    snapshot.includes("from './definition-validation.js'"),
    false,
    'the oracle is not installed in the reader',
  );
  assert.deepEqual(
    Object.getOwnPropertyNames(ContentDefinitionRepository.prototype).sort(),
    ['constructor', 'current', 'newRelatedRoot', 'resolve'].sort(),
    'New public reader methods require an explicitly guarded fixture entry',
  );
});

function fixture(prefix = 132) {
  const expected = prefixManifest(prefix);
  const calls: string[] = [];
  let rows = expected,
    absent = true,
    locked = true,
    businessCalls = 0;
  let afterRead = () => {};
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('pg_try_advisory_xact_lock_shared')) {
        assert.deepEqual(values, [...MIGRATION_LOCK]);
        return { rows: [{ locked }] };
      }
      if (sql.startsWith('LOCK TABLE')) return { rows: [] };
      if (sql.startsWith('SELECT name,checksum')) {
        assert.deepEqual(values, [expected.length + 1]);
        return { rows };
      }
      if (sql === historicalTextSourceAbsenceSql) return { rows: [{ absent }] };
      businessCalls++;
      afterRead();
      if (sql.includes('community_text_sources'))
        throw Object.assign(new Error('relation does not exist'), {
          code: '42P01',
        });
      if (sql.startsWith('SELECT * FROM whaleu_community.posts'))
        return { rows: [post] };
      if (sql.startsWith('SELECT id,is_active,kind,operating_region_id'))
        return {
          rows: [
            {
              id: post.space_id,
              is_active: true,
              kind: 'regional',
              operating_region_id: region,
            },
          ],
        };
      if (
        /FROM whaleu_community\.(post_images|polls|formations|trading_listings)/.test(
          sql,
        )
      )
        return { rows: [] };
      throw new Error(`Unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>) => {
    calls.push('BEGIN');
    startTransactionDeadlines(tx);
    try {
      const result = await work(tx);
      calls.push('COMMIT');
      return result;
    } catch (error) {
      calls.push('ROLLBACK');
      throw error;
    } finally {
      clearTransactionDeadlines(tx);
    }
  };
  return {
    tx,
    calls,
    transaction,
    businessCalls: () => businessCalls,
    setRows: (value: typeof rows) => {
      rows = value;
    },
    setAbsent: (value: boolean) => {
      absent = value;
    },
    setLocked: (value: boolean) => {
      locked = value;
    },
    afterRead: (value: () => void) => {
      afterRead = value;
    },
  };
}

test('only the four exact registered disposable historical fixtures are accepted', async () => {
  for (const invalid of [
    { ...config, NODE_ENV: 'production' as const },
    { ...config, DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
    { ...config, DATABASE_URL: 'postgres://fixture@127.0.0.1/not_disposable' },
    { ...config, PG_SSL_MODE: 'verify-full' as const },
    { ...config, DATABASE_URL: config.DATABASE_URL + '?sslmode=disable' },
    { ...config, DATABASE_URL: config.DATABASE_URL + '?SSLMode=disable' },
  ])
    await assert.rejects(
      historicalContentDefinitionRepository(campuses, invalid, 132),
    );
  assert.deepEqual(historicalContentDefinitionPrefixes, [132, 137, 144, 174]);
  for (const prefix of [0, 131, 134, 140, 145, 147, 173, 175, 176, 999])
    await assert.rejects(
      historicalContentDefinitionRepository(campuses, config, prefix),
    );
});

test('each registered caller validates its own complete actual prefix, never another allowed caller', async () => {
  for (const prefix of historicalContentDefinitionPrefixes) {
    const f = fixture(prefix);
    const owner = await historicalContentDefinitionRepository(
      campuses,
      config,
      prefix,
    );
    const decision = await f.transaction(
      (tx): ReturnType<HistoricalContentDefinitionRepository['current']> =>
        owner.current('post', post.id, scope, tx),
    );
    assert.equal(decision.kind, 'allow');
    for (const other of historicalContentDefinitionPrefixes.filter(
      (value) => value !== prefix,
    )) {
      f.setRows(prefixManifest(other));
      await assert.rejects(
        f.transaction((tx) => owner.current('post', post.id, scope, tx)),
        /cannot cross an upgrade/,
      );
    }
  }
});

test('real predecessor reads are fenced before and after on the caller managed transaction', async () => {
  const f = fixture();
  const owner = await historicalContentDefinitionRepository(
    campuses,
    config,
    132,
  );
  assert.deepEqual([...f.calls], [], 'DI does not perform a detached precheck');
  await assert.rejects(
    owner.current('post', post.id, scope, f.tx),
    /managed transaction/,
  );
  assert.deepEqual([...f.calls], []);
  const value = await f.transaction((tx) =>
    owner.current('post', post.id, scope, tx),
  );
  assert.equal(value.kind, 'allow');
  assert.equal(f.calls[0], 'BEGIN');
  assert.ok(f.calls[1]!.includes('pg_try_advisory_xact_lock_shared'));
  assert.equal(
    f.calls[2],
    'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
  );
  assert.equal(
    f.calls.filter((sql) => sql === historicalTextSourceAbsenceSql).length,
    2,
  );
  assert.equal(f.calls.at(-2), historicalTextSourceAbsenceSql);
  assert.equal(f.calls.at(-1), 'COMMIT');
  assert.equal(f.businessCalls(), 6);
  assert.equal(
    f.calls.some((sql) =>
      sql.includes('JOIN whaleu_community.community_text_sources'),
    ),
    false,
  );
  await assert.rejects(
    owner.current('post', post.id, scope, f.tx),
    /managed transaction/,
  );
  await f.transaction(async (tx) => {
    assert.deepEqual(await owner.newRelatedRoot(post.id, scope, tx), {
      kind: 'unavailable',
    });
  });
});

for (const prefix of historicalContentDefinitionPrefixes)
  test(`prefix ${prefix} rejects changed checksums, missing or extra migrations, partial source deployment and lock contention before and after reads`, async () => {
    const expected = prefixManifest(prefix);
    const f = fixture(prefix);
    const owner = await historicalContentDefinitionRepository(
      campuses,
      config,
      prefix,
    );
    const reject = () =>
      assert.rejects(
        f.transaction((tx) => owner.current('post', post.id, scope, tx)),
      );
    for (const rows of [
      expected.slice(0, -1),
      [...expected, { name: '0999_extra.sql', checksum: 'changed' }],
      expected.map((row, index) =>
        index === 0 ? { ...row, checksum: 'changed' } : row,
      ),
    ]) {
      f.setRows(rows);
      await reject();
    }
    f.setRows(expected);
    f.setAbsent(false);
    await reject();
    f.setAbsent(true);
    f.setLocked(false);
    await reject();
    assert.equal(f.businessCalls(), 0);
    f.setLocked(true);
    const decision = await f.transaction(
      (tx): ReturnType<HistoricalContentDefinitionRepository['current']> =>
        owner.current('post', post.id, scope, tx),
    );
    assert.equal(decision.kind, 'allow');
    f.afterRead(() => f.setAbsent(false));
    await assert.rejects(
      f.transaction((tx) => owner.current('post', post.id, scope, tx)),
      /Partial text-source schema/,
    );
    assert.equal(
      f.calls.at(-1),
      'ROLLBACK',
      'a result is never released after a changed boundary',
    );
    f.setAbsent(true);
    f.afterRead(() => f.setRows(expected.slice(0, -1)));
    await assert.rejects(
      f.transaction((tx) => owner.current('post', post.id, scope, tx)),
      /cannot cross an upgrade/,
    );
    f.setRows(expected);
    const unavailable = new Error('Real definition dependency unavailable');
    f.afterRead(() => {
      throw unavailable;
    });
    await assert.rejects(
      f.transaction((tx) => owner.current('post', post.id, scope, tx)),
      (error: unknown) => error === unavailable,
      'Dependency errors are propagated, never converted into a permit',
    );
  });

test('0175 absence covers every introduced object family, not only its table', () => {
  for (const catalog of [
    'pg_class',
    'pg_proc',
    'pg_trigger',
    'pg_attribute',
    'pg_constraint',
    'pg_type',
  ])
    assert.ok(historicalTextSourceAbsenceSql.includes(catalog));
  const migration = manifest.find(({ name }) => name.startsWith('0175_'))!;
  for (const match of migration.sql.matchAll(
    /CREATE\s+(?:TABLE|FUNCTION)\s+whaleu_community\.([a-z_]+)/g,
  )) {
    const name = match[1]!;
    assert.ok(
      name.startsWith('text_source_') ||
        name === 'community_text_sources' ||
        name === 'profile_moderation_definition',
    );
  }
  for (const match of migration.sql.matchAll(
    /ADD\s+(?:COLUMN|CONSTRAINT)\s+([a-z_]+)/g,
  ))
    assert.ok(
      match[1]!.startsWith('text_source_') ||
        [
          'content_approval_envelope_version',
          'content_binding_envelope_version',
          'content_approval_policies_policy_key_check',
        ].includes(match[1]!),
    );
  assert.ok(
    historicalTextSourceAbsenceSql.includes(
      'profile_moderation_definition_pre_text_source',
    ),
  );
  assert.ok(
    migration.sql.includes('CREATE CONSTRAINT TRIGGER text_source_recheck'),
  );
  assert.ok(
    migration.sql.includes('CREATE TRIGGER text_source_dependency_recheck'),
  );
});

for (const prefix of historicalContentDefinitionPrefixes)
  test(`Nest installs only the exact ${prefix} historical reader; ordinary current reads still fail on missing source schema`, async () => {
    const makeBuilder = () =>
      Test.createTestingModule({
        providers: [
          ContentDefinitionRepository,
          { provide: CampusService, useValue: campuses },
        ],
      });
    const builder = makeBuilder();
    await configureHistoricalContentDefinitions(builder, config, prefix);
    const historical = await builder.compile();
    const ordinary = await makeBuilder().compile();
    try {
      assert.ok(
        historical.get(ContentDefinitionRepository) instanceof
          HistoricalContentDefinitionRepository,
      );
      const current = ordinary.get(ContentDefinitionRepository);
      assert.ok(current instanceof ContentDefinitionRepository);
      assert.equal(
        current instanceof HistoricalContentDefinitionRepository,
        false,
      );
      const f = fixture(prefix);
      assert.equal(
        (
          await f.transaction((tx) =>
            historical
              .get(ContentDefinitionRepository)
              .current('post', post.id, scope, tx),
          )
        ).kind,
        'allow',
      );
      await assert.rejects(
        f.transaction((tx) => current.current('post', post.id, scope, tx)),
        { code: '42P01' },
      );
    } finally {
      await historical.close();
      await ordinary.close();
    }
  });

test('current validation preserves c27 v1-v5 reconstruction and rejects legacy corruption; no v6 permit is invented', () => {
  const facts: DefinitionPayload = { images: [], options: [], creators: [] };
  const targetId = randomUUID(),
    categoryId = randomUUID(),
    revision = randomUUID();
  const ratingLink: NonNullable<DefinitionPayload['ratingTargetLink']> = {
    kind: 'rating_target_link',
    targetId,
    label: 'Synthetic',
    binding: {
      version: 1,
      targetId,
      categoryId,
      targetRevision: revision,
      definitionRevision: revision,
      contentVersion: 1,
      originSourceId: revision,
      sourceId: revision,
      sourceRevision: revision,
      placementRevision: revision,
      categoryRevision: revision,
      catalogId: revision,
      headRevision: revision,
      protocolGeneration: revision,
      sourceDigest: 'a'.repeat(64),
      selector: { kind: 'global' },
      originRegionId: region,
      systemKey: 'course',
      ancestry: [{ categoryId, revision }],
    },
  };
  const cases: {
    post: DefinitionPost;
    scope: ContentScopeSnapshot;
    facts: DefinitionPayload;
  }[] = [
    { post, scope, facts },
    {
      post: {
        ...post,
        publication_envelope_version: 2,
        allow_anonymous_dm: false,
      },
      scope,
      facts,
    },
    {
      post: {
        ...post,
        publication_envelope_version: 3,
        category: 'feedback',
        feedback: { contacts: { wechat: '', qq: '', phone: '' } },
      },
      scope: { ...scope, originalRegionId: null },
      facts,
    },
    {
      post: { ...post, publication_envelope_version: 4 },
      scope: {
        ...scope,
        sync: 'related',
        originalRegionId: region,
        authorOriginRegionId: region,
        identityRegionId: region,
        topologySnapshotId: revision,
        configurationRevisionId: revision,
        identityCampusId: revision,
        identitySelectionId: revision,
        affiliationSnapshotId: revision,
        affiliationAssertionId: revision,
        syncPolicyId: revision,
        publicationGroupId: revision,
        publicationMembersDigest: 'b'.repeat(64),
      },
      facts,
    },
    {
      post: { ...post, publication_envelope_version: 5 },
      scope,
      facts: { ...facts, ratingTargetLink: ratingLink },
    },
  ];
  for (const sample of cases) {
    const run = (
      node: DefinitionPost,
      selectedScope = sample.scope,
      payload = sample.facts,
    ) => {
      const args: Parameters<typeof reconstructDefinition> = [
        'post',
        node,
        node,
        null,
        selectedScope,
        [],
        payload,
      ];
      const current = reconstructDefinition(...args);
      assert.deepEqual(current, predecessorDefinition(...args));
      return current;
    };
    const valid = run(sample.post);
    assert.equal(
      valid.kind,
      'allow',
      `v${sample.post.publication_envelope_version} remains accepted`,
    );
    if (valid.kind !== 'allow') assert.fail();
    assert.equal(
      definitionMatchesApproval(valid.value, {
        envelope: valid.value.envelope,
        digest: approvalDigest(valid.value.envelope),
      }),
      true,
    );
    const mismatch = { ...valid.value.envelope, text: 'different body' };
    assert.equal(
      definitionMatchesApproval(valid.value, {
        envelope: mismatch,
        digest: approvalDigest(mismatch),
      }),
      false,
    );
    assert.equal(run({ ...sample.post, text: '' }).kind, 'unavailable');
    assert.equal(
      run({ ...sample.post, account_id: 'invalid' }).kind,
      'unavailable',
    );
    assert.equal(
      run(sample.post, { ...sample.scope, originalSpaceId: randomUUID() }).kind,
      'unavailable',
    );
    assert.equal(
      run(sample.post, sample.scope, {
        ...sample.facts,
        images: [
          { assetId: randomUUID(), digest: 'a'.repeat(64), position: 1 },
        ],
      }).kind,
      'unavailable',
    );
  }
  assert.equal(
    reconstructDefinition(
      'post',
      { ...post, publication_envelope_version: 6 },
      post,
      null,
      scope,
      [],
      facts,
    ).kind,
    'unavailable',
  );
});
