import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { CampusService } from '../src/campus/campus.service.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { MIGRATION_LOCK, readMigrations } from '../src/database/migrations.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../src/community/content-review/contracts.js';
import { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import { ReadingFormattingRuntime } from '../src/community/reading-formatting/runtime.js';
import { ReadingSourceOwner } from '../src/community/reading-formatting/source-owner.js';
import {
  configureHistoricalContentDefinitions,
  historicalContentDefinitionBoundary,
  historicalContentDefinitionPrefixes,
  historicalTextSourceAbsenceSql,
} from './support/historical-content-definition/configure.js';
import {
  HistoricalReadingFormattingRuntime,
  historicalReadingAbsenceSql,
} from './support/historical-content-definition/reading-enrollment.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const manifest = await readMigrations(
  fileURLToPath(new URL('../migrations', import.meta.url)),
);
const expected = (prefix: number) =>
  manifest
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
const database = {} as DatabaseService;
const sources = {} as ReadingSourceOwner;
type Kind = 'post' | 'comment' | 'reply';

function legacyEnvelope(kind: Kind, version = 1) {
  const actor = randomUUID(),
    space = randomUUID(),
    region = randomUUID(),
    revision = randomUUID();
  const postId = randomUUID(),
    rootId = randomUUID(),
    targetId = randomUUID(),
    categoryId = randomUUID();
  const scope = {
    originalSpaceId: space,
    originalRegionId: version === 3 ? null : region,
    authorOriginRegionId: region,
    identityRegionId: region,
    topologySnapshotId: revision,
    configurationRevisionId: revision,
    identityCampusId: revision,
    identitySelectionId: revision,
    affiliationSnapshotId: revision,
    affiliationAssertionId: revision,
    ...(version === 4
      ? kind === 'post'
        ? {
            sync: 'related',
            syncPolicyId: revision,
            publicationGroupId: revision,
            publicationMembersDigest: 'a'.repeat(64),
          }
        : {
            sync: 'inherited_related',
            parentDistribution: {
              postId,
              decisionId: revision,
              digest: 'a'.repeat(64),
            },
          }
      : { sync: 'none' }),
  };
  return canonicalEnvelope({
    version: kind === 'post' ? version : version === 4 ? 4 : 1,
    accountId: actor,
    purpose:
      kind === 'post'
        ? 'publish_post'
        : kind === 'comment'
          ? 'publish_comment'
          : 'publish_reply',
    spaceId: space,
    category: version === 3 ? 'feedback' : 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: kind === 'post' ? null : postId,
    rootCommentId: kind === 'reply' ? rootId : null,
    targetReplyId: null,
    text: 'Synthetic original publication',
    images: [],
    component:
      version === 5 && kind === 'post'
        ? {
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
          }
        : { kind: 'none' },
    trading: null,
    scope,
    ...(version === 2 && kind === 'post' ? { allowAnonymousDm: false } : {}),
    ...(version === 3 && kind === 'post'
      ? { feedback: { contacts: { wechat: '', qq: '', phone: '' } } }
      : {}),
    ...(version === 4 ? { allowAnonymousDm: null } : {}),
  });
}

function fixture(prefix: number, kind: Kind = 'post', version = 1) {
  const id = randomUUID(),
    requestId = randomUUID(),
    envelope = legacyEnvelope(kind, version);
  const row = {
    envelope_version: envelope.version,
    envelope: envelope as unknown,
    digest: approvalDigest(envelope),
    account_id: envelope.accountId,
    content_account_id: envelope.accountId,
    text: envelope.text,
    same_transaction: true,
    post_version: version,
    operation: envelope.purpose,
    receipt: {
      requestId,
      operation: envelope.purpose,
      outcome: 'created',
      resourceId: id,
    } as Record<string, unknown> | null,
  };
  let applied = expected(prefix),
    sourceAbsent = true,
    readingAbsent = true,
    locked = true,
    present = true;
  let afterRead = () => {};
  const calls: string[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('pg_try_advisory_xact_lock_shared')) {
        assert.deepEqual(values, [...MIGRATION_LOCK]);
        return { rows: [{ locked }] };
      }
      if (sql.startsWith('LOCK TABLE')) return { rows: [] };
      if (sql.startsWith('SELECT name,checksum')) {
        assert.deepEqual(values, [expected(prefix).length + 1]);
        return { rows: applied };
      }
      if (sql === historicalTextSourceAbsenceSql)
        return { rows: [{ absent: sourceAbsent }] };
      if (sql === historicalReadingAbsenceSql)
        return { rows: [{ absent: readingAbsent }] };
      if (sql.startsWith('SELECT b.envelope_version')) {
        assert.deepEqual(values, [kind, id, requestId]);
        assert.ok(
          sql.includes(
            `${kind === 'post' ? 'publication_transaction' : 'approval_publication_transaction'}=pg_current_xact_id()`,
          ),
        );
        assert.ok(sql.includes('FOR SHARE OF n,b,r'));
        assert.ok(
          sql.includes('r.account_id=n.account_id AND r.client_request_id=$3'),
        );
        afterRead();
        return { rows: present ? [row] : [] };
      }
      if (sql.includes('FROM whaleu_community.community_text_sources'))
        throw Object.assign(new Error('Missing source relation'), {
          code: '42P01',
        });
      throw new Error(`Unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  const run = async (owner: ReadingFormattingRuntime) => {
    startTransactionDeadlines(tx);
    try {
      await owner.enrollCreated(kind, id, requestId, tx);
      calls.push('COMMIT');
    } catch (error) {
      calls.push('ROLLBACK');
      throw error;
    } finally {
      clearTransactionDeadlines(tx);
    }
  };
  return {
    id,
    requestId,
    row,
    calls,
    tx,
    run,
    setApplied: (value: typeof applied) => {
      applied = value;
    },
    sourceAbsent: (value: boolean) => {
      sourceAbsent = value;
    },
    readingAbsent: (value: boolean) => {
      readingAbsent = value;
    },
    locked: (value: boolean) => {
      locked = value;
    },
    present: (value: boolean) => {
      present = value;
    },
    afterRead: (value: () => void) => {
      afterRead = value;
    },
  };
}

test('c27 had no enrollment; current retries return retained receipts before enrollment', async () => {
  const record = JSON.parse(
    await readFile(
      new URL(
        './support/historical-content-definition/publication-provenance.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(record.commit, 'c27f173d8057f349469f4f96855d31edb9cff7c5');
  assert.equal(record.blob, 'ff722c45940018fa2477237b0c3f7ad2527f73f1');
  assert.equal(
    record.sourceSha256,
    '845a750998dcdb5c1b41b4ca7f70b8ea531e2df0e1879e7b6de1a955c1a061ff',
  );
  assert.equal(record.readingRuntimeOccurrences, 0);
  assert.equal(record.enrollCreatedOccurrences, 0);
  assert.equal(
    record.executeTail,
    '        await enrollPublishedHotProcessing(receipt.resourceId, tx);\n      }\n      await this.access.actor(token, tx);\n      return receipt;\n    });\n  }\n',
  );
  const current = await readFile(
    new URL('../src/community/publication.repository.ts', import.meta.url),
    'utf8',
  );
  const replay = current.indexOf('if (row.receipt) {');
  const work = current.indexOf('const deadlineCheckpoint', replay);
  const enroll = current.indexOf('await this.reading.enrollCreated(');
  assert.ok(replay > 0 && work > replay && enroll > work);
  assert.match(
    current.slice(replay, work),
    /return reviewOnly[\s\S]+: row\.receipt;/,
  );
});

test('each exact historical prefix preserves source-free new publication enrollment absence across v1-v5 and all node kinds', async () => {
  for (const prefix of historicalContentDefinitionPrefixes) {
    const owner = new HistoricalReadingFormattingRuntime(
      database,
      sources,
      await historicalContentDefinitionBoundary(config, prefix),
    );
    for (const kind of ['post', 'comment', 'reply'] as const) {
      for (const version of [1, 2, 3, 4, 5]) {
        const f = fixture(prefix, kind, version);
        await f.run(owner);
        assert.equal(
          f.calls.filter((sql) => sql === historicalReadingAbsenceSql).length,
          2,
        );
        assert.equal(f.calls.at(-2), historicalReadingAbsenceSql);
        assert.equal(f.calls.at(-1), 'COMMIT');
        assert.equal(
          f.calls.some(
            (sql) =>
              sql.startsWith('INSERT') ||
              sql.startsWith('UPDATE') ||
              sql.startsWith('DELETE'),
          ),
          false,
        );
      }
    }
  }
});

test('historical enrollment rejects unbound, old-transaction, source-bearing, wrong-version and mismatched receipt evidence', async () => {
  const owner = new HistoricalReadingFormattingRuntime(
    database,
    sources,
    await historicalContentDefinitionBoundary(config, 144),
  );
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => f.present(false),
    (f) => {
      f.row.same_transaction = false;
    },
    (f) => {
      f.row.envelope_version = 6;
    },
    (f) => {
      f.row.post_version = 6;
    },
    (f) => {
      f.row.envelope = { ...(f.row.envelope as object), textSource: undefined };
    },
    (f) => {
      f.row.digest = '0'.repeat(64);
    },
    (f) => {
      f.row.content_account_id = randomUUID();
    },
    (f) => {
      f.row.account_id = randomUUID();
    },
    (f) => {
      f.row.text += ' changed';
    },
    (f) => {
      f.row.operation = 'publish_reply';
    },
    (f) => {
      f.row.receipt = null;
    },
    (f) => {
      f.row.receipt!['requestId'] = randomUUID();
    },
    (f) => {
      f.row.receipt!['resourceId'] = randomUUID();
    },
    (f) => {
      f.row.receipt!['outcome'] = 'rejected';
    },
    (f) => {
      f.row.receipt!['operation'] = 'publish_comment';
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(144);
    mutate(f);
    await assert.rejects(f.run(owner));
    assert.equal(f.calls.at(-1), 'ROLLBACK');
  }
});

test('enrollment requires the exact same managed transaction, prefix and both absent schemas before and after use', async () => {
  for (const prefix of historicalContentDefinitionPrefixes) {
    const owner = new HistoricalReadingFormattingRuntime(
      database,
      sources,
      await historicalContentDefinitionBoundary(config, prefix),
    );
    const unmanaged = fixture(prefix);
    await assert.rejects(
      owner.enrollCreated(
        'post',
        unmanaged.id,
        unmanaged.requestId,
        unmanaged.tx,
      ),
      /managed transaction/,
    );
    assert.deepEqual(unmanaged.calls, []);
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.sourceAbsent(false),
      (f: ReturnType<typeof fixture>) => f.readingAbsent(false),
      (f: ReturnType<typeof fixture>) => f.locked(false),
      (f: ReturnType<typeof fixture>) =>
        f.setApplied(expected(prefix).slice(0, -1)),
      (f: ReturnType<typeof fixture>) =>
        f.setApplied([
          ...expected(prefix),
          { name: '0175_extra.sql', checksum: 'x' },
        ]),
      (f: ReturnType<typeof fixture>) =>
        f.setApplied(
          expected(prefix).map((row, i) =>
            i === 0 ? { ...row, checksum: 'x' } : row,
          ),
        ),
    ]) {
      const f = fixture(prefix);
      change(f);
      await assert.rejects(f.run(owner));
      assert.equal(
        f.calls.some((sql) => sql.startsWith('SELECT b.envelope_version')),
        false,
      );
    }
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.sourceAbsent(false),
      (f: ReturnType<typeof fixture>) => f.readingAbsent(false),
      (f: ReturnType<typeof fixture>) =>
        f.setApplied(expected(prefix).slice(0, -1)),
    ]) {
      const f = fixture(prefix);
      f.afterRead(() => change(f));
      await assert.rejects(f.run(owner));
      assert.equal(f.calls.at(-1), 'ROLLBACK');
    }
    const f = fixture(prefix),
      failure = new Error('Real owner query unavailable');
    f.afterRead(() => {
      throw failure;
    });
    await assert.rejects(f.run(owner), (error: unknown) => error === failure);
  }
});

test('only enrollCreated is overridden; all other formatter methods and unconfigured DI remain current', async () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(
      HistoricalReadingFormattingRuntime.prototype,
    ).sort(),
    ['constructor', 'enrollCreated'],
  );
  const owner = new HistoricalReadingFormattingRuntime(
    database,
    sources,
    await historicalContentDefinitionBoundary(config, 144),
  );
  for (const name of Object.getOwnPropertyNames(
    ReadingFormattingRuntime.prototype,
  )) {
    if (name !== 'constructor' && name !== 'enrollCreated')
      assert.equal(
        Reflect.get(owner, name),
        Reflect.get(ReadingFormattingRuntime.prototype, name),
      );
  }
  const builder = () =>
    Test.createTestingModule({
      providers: [
        ContentDefinitionRepository,
        ReadingFormattingRuntime,
        { provide: CampusService, useValue: {} },
        { provide: DatabaseService, useValue: database },
        { provide: ReadingSourceOwner, useValue: sources },
      ],
    });
  const historicalBuilder = builder();
  await configureHistoricalContentDefinitions(historicalBuilder, config, 144);
  const historical = await historicalBuilder.compile(),
    current = await builder().compile();
  try {
    assert.ok(
      historical.get(ReadingFormattingRuntime) instanceof
        HistoricalReadingFormattingRuntime,
    );
    assert.equal(
      current.get(ReadingFormattingRuntime).constructor,
      ReadingFormattingRuntime,
    );
    await assert.rejects(
      fixture(144).run(current.get(ReadingFormattingRuntime)),
      { code: '42P01' },
    );
  } finally {
    await historical.close();
    await current.close();
  }
});

test('0176 absence inventory includes independent functions, dynamic triggers, indexes and composite types', () => {
  for (const name of [
    'pg_class',
    'pg_proc',
    'pg_trigger',
    'pg_attribute',
    'pg_constraint',
    'pg_type',
  ])
    assert.ok(historicalReadingAbsenceSql.includes(name));
  const migration = manifest.find(({ name }) => name.startsWith('0176_'))!;
  for (const match of migration.sql.matchAll(
    /CREATE\s+(?:TABLE|FUNCTION)\s+whaleu_community\.([a-z_]+)/g,
  ))
    assert.ok(match[1]!.startsWith('reading_format_'));
  for (const match of migration.sql.matchAll(
    /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z_]+)/g,
  ))
    assert.ok(match[1]!.startsWith('reading_'));
  assert.ok(migration.sql.includes('CREATE CONSTRAINT TRIGGER reading_graph'));
  assert.ok(migration.sql.includes('CREATE TRIGGER reading_late_guard'));
});
