import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { InjectionToken } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { Pool, PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService, inTransaction } from '../src/database/database.js';
import { readMigrations } from '../src/database/migrations.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { PublicationService } from '../src/community/publication.service.js';
import { PublicationRepository } from '../src/community/publication.repository.js';
import { publishPostSchema } from '../src/community/contracts.js';
import type {
  PublishPost,
  PublishComment,
} from '../src/community/contracts.js';
import { PublicationService as PredecessorPublicationService } from './support/historical-publication/publication.service.js';
import {
  authorizeDiscussionPublication as authorizeHistoricalDiscussion,
  requireC27DiscussionTarget,
  withDiscussionPublicationMedia as historicalDiscussionMedia,
} from './support/historical-publication/discussion-publication-target.js';
import { withDiscussionPublicationMedia as currentDiscussionMedia } from '../src/community/discussion/publication-target.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunityRepository } from '../src/community/community.repository.js';
import {
  configureHistoricalPublication,
  guardedHistoricalPublicationDatabase,
  historicalHomeAbsenceSql,
  historicalPublicationBoundary,
  historicalPublicationPrefixes,
  HistoricalPublicationService,
} from './support/historical-publication/configure.js';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://fixture@127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const migrations = await readMigrations(
  fileURLToPath(new URL('../migrations', import.meta.url)),
);
const expected = (prefix: number) =>
  migrations
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));

function fixture(prefix: number) {
  const state = {
    rows: expected(prefix),
    locked: true,
    absent: true,
    homeAbsent: true,
    homeChecks: 0,
    statements: [] as string[],
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      state.statements.push(sql);
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (sql.includes('pg_try_advisory'))
        return { rows: [{ locked: state.locked }] };
      if (sql.includes('SELECT name,checksum')) {
        assert.deepEqual(values, [expected(prefix).length + 1]);
        return { rows: state.rows };
      }
      if (sql === historicalHomeAbsenceSql) {
        state.homeChecks++;
        assert.ok((values?.[0] as string[]).includes('home_publication_head'));
        assert.ok(
          (values?.[1] as string[]).includes('home_publication_current'),
        );
        assert.ok(
          (values?.[1] as string[]).includes(
            'profile_moderation_definition_pre_home',
          ),
        );
        assert.ok((values?.[2] as string[]).includes('home_review_capture'));
        assert.deepEqual(values?.[3], [
          'home_issuance_transaction',
          'home_transition_transaction',
        ]);
        assert.deepEqual(values?.[4], [
          'home_decision_cohort',
          'home_queue_cohort',
        ]);
        return { rows: [{ absent: state.homeAbsent }] };
      }
      if (sql.includes('AS absent'))
        return { rows: [{ absent: state.absent }] };
      return { rows: [] };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { connect: async () => tx } as unknown as Pick<Pool, 'connect'>;
  return { state, tx, pool };
}

test('producer source is exact full c27 bytes after reversing only declared import mappings', async () => {
  const provenance = JSON.parse(
    await readFile(
      new URL(
        './support/historical-publication/provenance.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.equal(provenance.commit, 'c27f173d8057f349469f4f96855d31edb9cff7c5');
  assert.equal(provenance.blob, '669fee5a87ede58b6f794b0d8b05bb7ec23b09c8');
  assert.equal(
    provenance.sourceSha256,
    'c3aa35f765432b8e7601926de5f286fc5e28bc41d556b4fe5fb1900e5843f1f6',
  );
  assert.deepEqual(provenance.importAdapter, {
    path: 'apps/api/test/support/historical-publication/discussion-publication-target.ts',
    originalDependency:
      'apps/api/src/community/discussion/publication-target.ts',
    sha256: '1dab96c4c3818048b2372e0898a9fdfefe62a6f27a550f2b69a7386afb2407ad',
  });
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  assert.equal(
    createHash('sha256')
      .update(await readFile(path.join(root, provenance.importAdapter.path)))
      .digest('hex'),
    provenance.importAdapter.sha256,
  );
  assert.equal(historicalDiscussionMedia, currentDiscussionMedia);
  const source = path.join(root, provenance.source),
    snapshot = path.join(root, provenance.snapshot);
  const restored = (await readFile(snapshot, 'utf8')).replace(
    /'(\.{1,2}\/[^']+\.js)'/g,
    (_whole, specifier: string) => {
      let target = path.resolve(path.dirname(snapshot), specifier);
      if (
        target ===
        path.join(root, provenance.importAdapter.path).replace(/\.ts$/, '.js')
      )
        target = path
          .join(root, provenance.importAdapter.originalDependency)
          .replace(/\.ts$/, '.js');
      const relative = path
        .relative(path.dirname(source), target)
        .split(path.sep)
        .join('/');
      return `'${relative.startsWith('.') ? relative : './' + relative}'`;
    },
  );
  assert.equal(
    createHash('sha256').update(restored).digest('hex'),
    provenance.sourceSha256,
  );
  assert.equal(
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(restored)}\0`)
      .update(restored)
      .digest('hex'),
    provenance.blob,
  );
  for (const method of [
    'approved',
    'bind',
    'scope',
    'discussionScope',
  ] as const)
    assert.equal(
      HistoricalPublicationService.prototype[method],
      PredecessorPublicationService.prototype[method],
    );
});

test('historical producer rejects unregistered/current prefixes, unsafe destinations and source downgrade', async () => {
  assert.deepEqual(historicalPublicationPrefixes, [137, 144]);
  for (const prefix of [132, 136, 138, 143, 145, 174, 175, 178, 179])
    await assert.rejects(historicalPublicationBoundary(config, prefix));
  for (const patch of [
    { NODE_ENV: 'production' as const },
    { DATABASE_URL: 'postgres://fixture@example.org/whaleu_test' },
    { DATABASE_URL: 'postgres://fixture@127.0.0.1/real' },
    { PG_SSL_MODE: 'verify-full' as const },
  ])
    await assert.rejects(
      historicalPublicationBoundary({ ...config, ...patch }, 137),
    );
  const owner = Object.create(
    HistoricalPublicationService.prototype,
  ) as HistoricalPublicationService;
  assert.throws(
    () => owner.post('token', { textSource: {} } as unknown as PublishPost),
    {
      code: 'CONTENT_REVIEW_UNAVAILABLE',
    },
  );
  assert.throws(
    () =>
      owner.comment('token', 'post', {
        textSource: {},
      } as unknown as PublishComment),
    { code: 'CONTENT_REVIEW_UNAVAILABLE' },
  );
  await assert.rejects(owner.requireSourceParent(), {
    code: 'CONTENT_REVIEW_UNAVAILABLE',
  });
});

test('only the two historical DI compositions replace the producer and add the transaction fence', async () => {
  for (const prefix of historicalPublicationPrefixes) {
    const overrides: unknown[] = [];
    const builder = {
      overrideProvider(token: unknown) {
        overrides.push(token);
        return {
          useFactory() {},
          useClass(owner: unknown) {
            assert.equal(owner, HistoricalPublicationService);
          },
        };
      },
    } as unknown as TestingModuleBuilder;
    await configureHistoricalPublication(builder, config, prefix);
    assert.deepEqual(overrides, [DatabaseService, PublicationService]);
  }
  const wiring = await readFile(
    new URL(
      './support/historical-account-punishment-policy.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(wiring, /if \(prefix === undefined\) return;/);
  assert.match(
    wiring,
    /if \(historicalPublicationPrefixes.includes\(prefix\)\)\s+await configureHistoricalPublication\(builder, config, prefix\);/,
  );
});

test('boundary rejects ledger drift, partial source/Home and migration locks in the real managed lifetime', async () => {
  for (const prefix of historicalPublicationPrefixes) {
    const boundary = await historicalPublicationBoundary(config, prefix);
    const f = fixture(prefix);
    await assert.rejects(boundary(f.tx), /managed transaction/);
    await inTransaction(f.pool, boundary);
    for (const alter of [
      () => {
        f.state.rows = expected(prefix).slice(1);
      },
      () => {
        f.state.rows = [
          ...expected(prefix),
          { name: '9999_future.sql', checksum: '0'.repeat(64) },
        ];
      },
      () => {
        f.state.rows = expected(prefix).map((row, index) =>
          index ? row : { ...row, checksum: '0'.repeat(64) },
        );
      },
      () => {
        f.state.rows = expected(prefix === 137 ? 144 : 137);
      },
      () => {
        f.state.absent = false;
      },
      () => {
        f.state.homeAbsent = false;
      },
      () => {
        f.state.locked = false;
      },
    ]) {
      Object.assign(f.state, {
        rows: expected(prefix),
        absent: true,
        homeAbsent: true,
        locked: true,
      });
      alter();
      await assert.rejects(inTransaction(f.pool, boundary));
      assert.equal(f.state.statements.at(-1), 'ROLLBACK');
    }
  }
});

test('transaction wrapper preserves options/result/errors/savepoints and rejects post-callback DDL drift before COMMIT', async () => {
  const f = fixture(144),
    boundary = await historicalPublicationBoundary(config, 144);
  const options = { isolationLevel: 'read committed' as const };
  let driftAfterCallback = false;
  const database = {
    query() {
      return this;
    },
    transaction<T>(operation: (tx: PoolClient) => Promise<T>, actual?: object) {
      assert.equal(actual, options);
      return inTransaction(
        f.pool,
        async (tx) => {
          const result = await operation(tx);
          if (driftAfterCallback) f.state.homeAbsent = false;
          return result;
        },
        options,
      );
    },
  } as unknown as DatabaseService;
  const guarded = guardedHistoricalPublicationDatabase(database, boundary);
  assert.equal(guarded.query('untouched'), database);
  const result = {};
  assert.equal(
    await guarded.transaction(async (tx) => {
      assert.equal(tx, f.tx);
      const checkpoint = checkpointTransactionDeadlines(tx);
      await tx.query('SAVEPOINT publication_work');
      await tx.query('ROLLBACK TO SAVEPOINT publication_work');
      restoreTransactionDeadlines(tx, checkpoint);
      return result;
    }, options),
    result,
  );
  assert.equal(
    f.state.homeChecks,
    3,
    'entry, callback tail and actual pre-COMMIT proof',
  );
  assert.equal(f.state.statements.at(-1), 'COMMIT');
  const failure = new Error('original callback failure');
  await assert.rejects(
    guarded.transaction(async () => {
      throw failure;
    }, options),
    (error) => error === failure,
  );
  assert.equal(f.state.statements.at(-1), 'ROLLBACK');
  driftAfterCallback = true;
  await assert.rejects(
    guarded.transaction(async () => result, options),
    /Partial Home ownership/,
  );
  assert.equal(f.state.statements.at(-1), 'ROLLBACK');
});

test('real Nest injection retains the exact producer constructor and unchanged journal arguments', async () => {
  const calls: unknown[][] = [];
  const receipt = { outcome: 'created' };
  const parameters = Reflect.getMetadata(
    'self:paramtypes',
    PredecessorPublicationService,
  ) as { param: InjectionToken }[];
  assert.ok(parameters.length > 10);
  const module = await Test.createTestingModule({
    providers: [
      { provide: PublicationService, useClass: HistoricalPublicationService },
      ...parameters.map(({ param }) => ({
        provide: param,
        useValue:
          param === PublicationRepository
            ? {
                execute: (...args: unknown[]) => {
                  calls.push(args);
                  return Promise.resolve(receipt);
                },
              }
            : {},
      })),
    ],
  }).compile();
  try {
    const owner: unknown = module.get(PublicationService);
    assert.ok(owner instanceof HistoricalPublicationService);
    const body = publishPostSchema.parse({
      clientRequestId: '00000000-0000-4000-8000-000000000001',
      spaceId: '00000000-0000-4000-8000-000000000002',
      category: 'discussion',
      text: 'Exact original input',
      authorMode: 'named',
      commentsPolicy: 'open',
      imageAssetIds: [],
    });
    assert.equal(await owner.post('original token', body), receipt);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.slice(0, 3), [
      'original token',
      body.clientRequestId,
      'publish_post',
    ]);
    assert.equal(typeof calls[0]?.[4], 'function');
    assert.equal(calls[0]?.[5], false);
  } finally {
    await module.close();
  }
});

test('checked c27 target adapter preserves all legacy fields and rejects every future category/version', () => {
  for (const category of [
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
  ]) {
    for (const version of [undefined, 1, 2, 3, 4, 5]) {
      const target = {
        post: {
          id: 'original',
          category,
          ...(version === undefined
            ? {}
            : { publication_envelope_version: version }),
          extra: { retained: true },
        },
        authority: { unchanged: true },
        space: { id: 'original space' },
        root: { id: 'original root' },
        mode: 'named',
        targetAccount: 'original account',
      };
      const result = requireC27DiscussionTarget(target);
      assert.deepEqual(result, target);
      assert.equal(result.authority, target.authority);
      assert.equal(result.space, target.space);
      assert.equal(result.root, target.root);
      assert.equal(result.post.extra, target.post.extra);
      assert.equal(target.post.category, category);
    }
  }
  for (const post of [
    { category: 'water', publication_envelope_version: 1 },
    { category: 'unknown', publication_envelope_version: 1 },
    { category: 'discussion', publication_envelope_version: 6 },
    { category: 'discussion', publication_envelope_version: 7 },
    { category: 'discussion', publication_envelope_version: 8 },
    { category: 'discussion', publication_envelope_version: 0 },
    { category: 'discussion', publication_envelope_version: 1.5 },
    { category: 'discussion', publication_envelope_version: NaN },
  ])
    assert.throws(() => requireC27DiscussionTarget({ post }), {
      code: 'CONTENT_REVIEW_UNAVAILABLE',
    });
});

test('checked import adapter runs original authorization first and propagates its exact failure', async () => {
  const denial = new Error('original current ancestor denial');
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
    (error) => error === denial,
  );
  assert.equal(reads, 1);
});
