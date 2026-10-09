import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
import {
  canonicalRatingCategoryEnvelope,
  ratingCategoryApprovalDigest,
} from '../src/community/content-review/rating-category-contracts.js';
import {
  RatingCompletePoolRepository,
  assertRatingCompletePoolBatch,
  ratingCompletePoolSummary,
  RATING_COMPLETE_POOL_BATCH_SIZE,
  RATING_COMPLETE_POOL_TARGET_LIMIT,
} from '../src/ratings/random/complete-pool.repository.js';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function fixture(count = 1, catalogCount = 1, native = false) {
  const categoryId = randomUUID(),
    creatorId = randomUUID();
  const catalogs = Array.from({ length: catalogCount }, (_, i) => ({
    id: uuid(100_000 + i),
    regionId: i ? uuid(200_000 + i) : null,
  }));
  const state = {
    epoch: '0',
    reviewEpoch: '0',
    categoryReviewState: 'allow' as 'allow' | 'revoked',
    categoryReviewUnknown: false,
    isolation: 'read committed',
    conflict: false,
    current: true,
    now: new Date(),
    validUntil: null as string | null,
    epochRows: null as unknown[] | null,
    missingCatalog: false,
    statements: [] as { sql: string; values: unknown[] }[],
    ancestors: catalogs.map((catalog) => ({
      catalog_id: catalog.id,
      id: categoryId,
      parent_id: null,
      level: 1,
      kind: native ? 'general' : 'school',
      system_key: null,
      name: 'Category',
      description: '',
      revision: randomUUID(),
      ordinal: '0',
      active: true,
      hidden: false,
    })),
    paths: catalogs.flatMap((catalog) =>
      Array.from({ length: count }, (_, i) => {
        const id = uuid(i + 1),
          revision = uuid(300_000 + i);
        return {
          catalog_id: catalog.id,
          category_id: categoryId,
          target_id: id,
          valid_path: true,
          target: {
            id,
            revision,
            category_id: categoryId,
            creator_id: creatorId,
            region_id: null as string | null,
            name: `Target ${i}`,
            description: '',
            active: true,
            envelope: {
              version: 1,
              accountId: creatorId,
              purpose: 'publish_rating_target',
              clientRequestId: uuid(500_000 + i),
              targetId: id,
              targetRevision: revision,
              categoryId,
              categoryRevision: uuid(400_000),
              catalogRevision: catalogs[0]!.id,
              scope: { regionId: null },
              assetIds: [],
              name: `Target ${i}`,
              description: '',
            },
            content_version: 1 as number | null,
            definition_revision: revision as string | null,
            applied_target_revision: revision as string | null,
            definition_target_id: id as string | null,
            lifecycle_target_revision: revision as string | null,
            owner_deleted: false,
          },
          summary: {
            revision,
            count: '1',
            sum: '5',
            b1: '0',
            b2: '0',
            b3: '0',
            b4: '0',
            b5: '1',
          } as Record<string, unknown> | null,
        };
      }),
    ),
  };
  const nativeEnvelope = native
    ? canonicalRatingCategoryEnvelope({
        version: 4,
        purpose: 'publish_rating_categories',
        accountId: creatorId,
        clientRequestId: uuid(800001),
        releaseId: uuid(800002),
        intent: {
          clientRequestId: uuid(800001),
          regionId: null,
          expectedCatalogRevision: null,
          expectedScopeRevision: 's'.repeat(43),
          parentId: null,
          expectedParentRevision: null,
          nodes: [
            { key: 'root', parentKey: null, name: 'Category', description: '' },
          ],
          assetIds: [],
        },
        scope: {
          regionId: null,
          topologySnapshotId: uuid(800003),
          campusIds: [],
          scopeRevision: 's'.repeat(43),
        },
        categories: [
          {
            key: 'root',
            id: categoryId,
            revision: state.ancestors[0]!.revision,
            parentId: null,
            level: 1,
            name: 'Category',
            description: '',
            scopeVersionId: uuid(800004),
          },
        ],
        catalogs: [
          {
            regionId: null,
            beforeCatalogId: null,
            afterCatalogId: catalogs[0]!.id,
            campusIds: [],
          },
        ],
        assetIds: [],
      })
    : null;
  const tx = {
    async query(sql: string, values: unknown[] = []) {
      state.statements.push({ sql, values });
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: state.isolation,
              statement_timeout: '5s',
              lock_timeout: '0',
              now: state.now,
            },
          ],
        };
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return {
          rows: [{ singleton: true, version: 1, epoch: state.reviewEpoch }],
        };
      if (
        sql.includes('WITH ORDINALITY w(category_id,base_revision,ordinal)')
      ) {
        assert.ok(nativeEnvelope);
        const e = nativeEnvelope,
          digest = ratingCategoryApprovalDigest(e),
          evaluated = new Date(state.now.getTime() - 1000);
        return {
          rows: (values[0] as string[]).map((id, index) => {
            assert.equal(id, categoryId);
            return {
              ordinal: index + 1,
              binding: {
                category_id: categoryId,
                base_revision: e.categories[0]!.revision,
                release_id: e.releaseId,
                decision_id: uuid(800005),
                account_id: creatorId,
                operation: e.purpose,
                envelope_version: 4,
                digest,
                envelope: e,
                scope: e.scope,
              },
              account_exists: true,
              bound_time: true,
              now: state.now,
              exact_time: true,
              id: uuid(800005),
              account_id: creatorId,
              operation: e.purpose,
              envelope_version: 4,
              digest,
              envelope: e,
              policy_revision_id: uuid(800006),
              result: 'allow',
              coverage: state.categoryReviewUnknown ? 'missing' : 'complete',
              provenance: 'accepted',
              issuer: 'synthetic-category-review',
              provenance_ref: 'synthetic-category-ref',
              evaluated_at: evaluated,
              consume_until: new Date(state.now.getTime() + 60000),
              visibility_model: 'durable',
              visibility_until: null,
              policy_key: 'local-explicit-v1',
              policy_version: 1,
              policy_coverage: 'complete',
              policy_provenance: 'accepted',
              policy_issuer: 'synthetic-category-policy',
              policy_provenance_ref: 'synthetic-category-policy-ref',
              policy_valid_from: evaluated,
              policy_valid_until: null,
              state: state.categoryReviewState,
              event_at: evaluated,
              event_coverage: 'complete',
              event_provenance: 'accepted',
              event_issuer: 'synthetic-category-event',
              event_provenance_ref: 'synthetic-category-event-ref',
            };
          }),
        };
      }
      if (sql.includes('FROM whaleu_ratings.random_pool_epoch'))
        return {
          rows: state.epochRows ?? [
            { singleton: true, version: 1, epoch: state.epoch },
          ],
        };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.conflict)
          throw Object.assign(new Error('conflicting writer'), {
            code: '55P03',
          });
        return { rows: [] };
      }
      if (
        sql.startsWith('SELECT set_config') ||
        sql.startsWith('SET CONSTRAINTS')
      )
        return { rows: [] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: state.now }] };
      if (sql.startsWith('SELECT ($1::timestamptz'))
        return { rows: [{ valid: state.current }] };
      if (sql.includes('WITH ORDINALITY s(region_id,ordinal)'))
        return {
          rows: catalogs.map((catalog, i) => ({
            ordinal: i + 1,
            id: state.missingCatalog ? null : catalog.id,
            region_id: catalog.regionId,
            valid: !state.missingCatalog,
            precise_until: state.validUntil,
          })),
        };
      if (sql.includes('catalog_category_lineage'))
        return {
          rows: (values[1] as string[]).map((id, index) => {
            const category = state.ancestors.find(
              (row) => row.catalog_id === values[0] && row.id === id,
            );
            assert.ok(
              category,
              'Only explicit synthetic opaque category rows are admitted',
            );
            if (nativeEnvelope)
              return {
                ordinal: index + 1,
                lineage: {
                  source_kind: 'native',
                  effective_revision: category.revision,
                  base_revision: category.revision,
                  scope_version_id:
                    nativeEnvelope.categories[0]!.scopeVersionId,
                  topology_snapshot_id: nativeEnvelope.scope.topologySnapshotId,
                },
                base: {
                  category_id: category.id,
                  revision: category.revision,
                  parent_id: category.parent_id,
                  level: category.level,
                  name: category.name,
                  description: category.description,
                  active: category.active,
                  is_global: true,
                  scope_version_id:
                    nativeEnvelope.categories[0]!.scopeVersionId,
                  release_id: nativeEnvelope.releaseId,
                  envelope: nativeEnvelope,
                },
                head_revision: category.revision,
                source_scope: {
                  id: nativeEnvelope.categories[0]!.scopeVersionId,
                  region_id: null,
                  campus_ids: [],
                  topology_snapshot_id: nativeEnvelope.scope.topologySnapshotId,
                  release_id: nativeEnvelope.releaseId,
                },
              };
            return {
              ordinal: index + 1,
              lineage: {
                source_kind: 'opaque',
                effective_revision: category.revision,
                base_revision: null,
                scope_version_id: null,
                topology_snapshot_id: null,
              },
              base: null,
              head_revision: null,
              source_scope: null,
            };
          }),
        };
      if (sql.includes('WITH RECURSIVE path AS'))
        return { rows: structuredClone(state.ancestors) };
      if (sql.includes('paths AS MATERIALIZED')) {
        const [admittedCatalogs, , afterCatalog, afterTarget, limit] =
          values as [string[], string, string | null, string | null, number];
        return {
          rows: structuredClone(
            state.paths
              .filter(
                (path) =>
                  admittedCatalogs.includes(path.catalog_id) &&
                  (afterCatalog === null ||
                    path.catalog_id > afterCatalog ||
                    (path.catalog_id === afterCatalog &&
                      path.target_id > afterTarget!)),
              )
              .slice(0, limit),
          ),
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    state,
    tx,
    categoryId,
    catalogs,
    repository: new RatingCompletePoolRepository(),
  };
}
async function prepared(f: ReturnType<typeof fixture>) {
  const handle = await f.repository.capture(f.tx);
  await f.repository.prepare(
    handle,
    f.catalogs.map((catalog) => catalog.regionId),
    f.categoryId,
    f.tx,
  );
  return handle;
}
const ratingUnavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'RATING_UNAVAILABLE';

for (const count of [1001, 2048])
  test(`streams all ${count} targets through bounded batches before complete/final fixed epoch proof`, async () => {
    const f = fixture(count),
      handle = await prepared(f);
    await assert.rejects(
      f.repository.complete(handle, f.tx),
      ratingUnavailable,
    );
    let total = 0,
      ordinal = 0,
      streamKey: object | undefined;
    for (;;) {
      const batch = await f.repository.next(handle, f.tx);
      const issued = assertRatingCompletePoolBatch(batch, f.tx);
      streamKey ??= issued.streamKey;
      assert.equal(issued.streamKey, streamKey);
      assert.equal(issued.ordinal, ordinal++);
      assert.ok(batch.items.length <= 128);
      assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch.items));
      total += batch.items.length;
      if (batch.done) break;
    }
    assert.equal(total, count);
    await f.repository.complete(handle, f.tx);
    await checkTransactionDeadlines(f.tx);
    const scans = f.state.statements.filter(({ sql }) =>
      sql.includes('paths AS MATERIALIZED'),
    );
    assert.equal(scans.length, Math.floor(count / 128) + 1);
    for (const scan of scans) {
      assert.equal(scan.values.at(-1), RATING_COMPLETE_POOL_BATCH_SIZE);
      assert.match(scan.sql, /LEFT JOIN whaleu_ratings.targets/);
      assert.match(
        scan.sql,
        /LEFT JOIN whaleu_ratings.target_definition_heads/,
      );
      assert.match(
        scan.sql,
        /LEFT JOIN whaleu_ratings.target_definition_versions/,
      );
      assert.match(
        scan.sql,
        /LEFT JOIN whaleu_ratings.target_definition_lifecycles/,
      );
      assert.match(scan.sql, /o\.effective_at<=instant\.now/);
      assert.match(scan.sql, /b\.creation_transaction=c\.creation_transaction/);
      assert.doesNotMatch(scan.sql, /FOR SHARE|DISTINCT t\.id/);
    }
    const fence = f.state.statements.findIndex(({ sql }) =>
      sql.startsWith('LOCK TABLE'),
    );
    assert.ok(fence > 0);
    assert.match(
      f.state.statements[fence]!.sql,
      /random_pool_epoch IN SHARE MODE NOWAIT/,
    );
    assert.ok(
      f.state.statements
        .slice(fence + 1)
        .every(
          ({ sql }) =>
            !/FROM whaleu_ratings\.(targets|categories|catalogs|score_summaries)/.test(
              sql,
            ),
        ),
    );
  });

test('all legal catalog paths survive until Review, including global targets in regional catalogs', async () => {
  const f = fixture(1, 3),
    handle = await prepared(f);
  const batch = await f.repository.next(handle, f.tx);
  assert.equal(batch.items.length, 3);
  assert.equal(new Set(batch.items.map((item) => item.id)).size, 1);
  assert.equal(new Set(batch.items.map((item) => item.catalog.id)).size, 3);
  assert.equal(batch.items[2]!.row.region_id, null);
  assert.equal(batch.items[2]!.catalog.regionId, f.catalogs[2]!.regionId);
  await f.repository.complete(handle, f.tx);
});

test('target admission is whole-pool B/B+1, never a first-128 success', async () => {
  const f = fixture(RATING_COMPLETE_POOL_TARGET_LIMIT + 1),
    handle = await prepared(f);
  let seen = 0;
  await assert.rejects(async () => {
    for (;;) {
      const batch = await f.repository.next(handle, f.tx);
      seen += batch.items.length;
      if (batch.done) break;
    }
  }, ratingUnavailable);
  assert.ok(seen > 128);
  await assert.rejects(f.repository.complete(handle, f.tx), ratingUnavailable);
});

test('unknown catalogs and broken visible ancestry fail; authoritative hidden/absent categories do not leak paths', async () => {
  const missing = fixture();
  missing.state.missingCatalog = true;
  await assert.rejects(prepared(missing), ratingUnavailable);
  const broken = fixture();
  broken.state.ancestors[0]!.level = 2;
  await assert.rejects(prepared(broken), ratingUnavailable);
  const hidden = fixture(1, 2);
  hidden.state.ancestors[0]!.hidden = true;
  const h = await prepared(hidden);
  assert.equal(
    hidden.state.statements.filter(({ sql }) =>
      sql.includes('paths AS MATERIALIZED'),
    ).length,
    0,
  );
  const batch = await hidden.repository.next(h, hidden.tx);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]!.catalog.id, hidden.catalogs[1]!.id);
});

test('unavailable summaries remain explicit and malformed distributions fail the canonical schema', () => {
  assert.deepEqual(ratingCompletePoolSummary(null), { status: 'unavailable' });
  const f = fixture();
  assert.equal(
    ratingCompletePoolSummary(f.state.paths[0]!.summary).status,
    'known',
  );
  assert.throws(() =>
    ratingCompletePoolSummary({ ...f.state.paths[0]!.summary, count: '2' }),
  );
});

test('inactive paths yield an empty non-EOF batch and scanning continues beyond it', async () => {
  const f = fixture(129);
  for (const path of f.state.paths.slice(0, 128)) path.target.active = false;
  const handle = await prepared(f);
  const first = await f.repository.next(handle, f.tx);
  assert.equal(first.items.length, 0);
  assert.equal(first.done, false);
  const last = await f.repository.next(handle, f.tx);
  assert.equal(last.items.length, 1);
  assert.equal(last.items[0]!.id, uuid(129));
  assert.equal(last.done, true);
  await f.repository.complete(handle, f.tx);
});

test('forged, copied, cross-transaction and restored-savepoint handles/batches are invalid', async () => {
  const f = fixture(),
    handle = await prepared(f);
  await assert.rejects(
    f.repository.next({} as typeof handle, f.tx),
    ratingUnavailable,
  );
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  const batch = await f.repository.next(handle, f.tx);
  assert.throws(
    () => assertRatingCompletePoolBatch({ ...batch }, f.tx),
    ratingUnavailable,
  );
  assert.throws(
    () => assertRatingCompletePoolBatch(batch, fixture().tx),
    ratingUnavailable,
  );
  restoreTransactionDeadlines(f.tx, checkpoint);
  assert.throws(
    () => assertRatingCompletePoolBatch(batch, f.tx),
    ratingUnavailable,
  );
  await assert.rejects(f.repository.complete(handle, f.tx), ratingUnavailable);
});

test('committed mutations/ABA and pending writers invalidate whole-pool final proof', async () => {
  for (const mode of ['commit', 'aba', 'pending'] as const) {
    const f = fixture(),
      handle = await prepared(f);
    await f.repository.next(handle, f.tx);
    await f.repository.complete(handle, f.tx);
    if (mode === 'pending') f.state.conflict = true;
    else f.state.epoch = mode === 'aba' ? '2' : '1';
    await assert.rejects(checkTransactionDeadlines(f.tx), ratingUnavailable);
  }
});

test('expiry is checked before sampling and final deadline uses conservative microsecond rounding', async () => {
  const f = fixture(),
    handle = await prepared(f);
  await f.repository.next(handle, f.tx);
  f.state.current = false;
  await assert.rejects(f.repository.complete(handle, f.tx), ratingUnavailable);
  const g = fixture();
  g.state.validUntil = '2026-10-09T14:00:00.123999Z';
  g.state.now = new Date('2026-10-09T14:00:00.123Z');
  const gh = await prepared(g);
  await g.repository.next(gh, g.tx);
  await g.repository.complete(gh, g.tx);
  await assert.rejects(checkTransactionDeadlines(g.tx), ratingUnavailable);
});

test('capture requires current transaction/read-committed and exact singleton/version/epoch dimension', async () => {
  const wrongIsolation = fixture();
  wrongIsolation.state.isolation = 'repeatable read';
  await assert.rejects(
    wrongIsolation.repository.capture(wrongIsolation.tx),
    ratingUnavailable,
  );
  for (const rows of [
    [],
    [{ singleton: true, version: 2, epoch: '0' }],
    [{ singleton: true, version: 1, epoch: '9223372036854775808' }],
    [{ singleton: true, version: 1, epoch: '-1' }],
    [
      { singleton: true, version: 1, epoch: '0' },
      { singleton: true, version: 1, epoch: '0' },
    ],
  ]) {
    const f = fixture();
    f.state.epochRows = rows;
    await assert.rejects(f.repository.capture(f.tx), ratingUnavailable);
  }
});

test('0054 covers every complete-pool source and preserves existing Review publication epoch protocol', () => {
  const migration = readFileSync(
    new URL(
      '../migrations/0054_rating_complete_random_pool.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const historical = readFileSync(
    new URL('../migrations/0042_ratings.sql', import.meta.url),
    'utf8',
  );
  for (const table of [
    'catalogs',
    'catalog_heads',
    'categories',
    'target_memberships',
    'targets',
    'target_sources',
    'target_creations',
    'score_baselines',
    'score_summaries',
    'scores',
    'score_transitions',
    'target_state_revisions',
  ]) {
    assert.ok(migration.includes(`'${table}'`));
    if (table !== 'target_state_revisions')
      assert.ok(historical.includes(`'${table}'`));
  }
  assert.match(
    migration,
    /BEFORE INSERT OR UPDATE OR DELETE ON whaleu_ratings/,
  );
  assert.match(migration, /epoch<9223372036854775807/);
  assert.match(
    migration,
    /BEFORE TRUNCATE ON whaleu_ratings.random_pool_epoch/,
  );
  assert.match(migration, /rating_review_binding_epoch/);
  assert.doesNotMatch(
    migration,
    /EXECUTE FUNCTION whaleu_community.advance_rating_review_epoch/,
  );
  assert.doesNotMatch(migration, /pg_advisory/);
});

test('owner final proof rejects capture-only, incomplete scan, uncompleted EOF and duplicate capture', async () => {
  const captured = fixture();
  await captured.repository.capture(captured.tx);
  await assert.rejects(
    captured.repository.capture(captured.tx),
    ratingUnavailable,
  );
  await assert.rejects(
    checkTransactionDeadlines(captured.tx),
    ratingUnavailable,
  );
  const scanning = fixture(129),
    scanningHandle = await prepared(scanning);
  await scanning.repository.next(scanningHandle, scanning.tx);
  await assert.rejects(
    checkTransactionDeadlines(scanning.tx),
    ratingUnavailable,
  );
  const eof = fixture(),
    eofHandle = await prepared(eof);
  await eof.repository.next(eofHandle, eof.tx);
  await assert.rejects(checkTransactionDeadlines(eof.tx), ratingUnavailable);
  await eof.repository.complete(eofHandle, eof.tx);
  await checkTransactionDeadlines(eof.tx);
});

test('preparation queries apply finite remaining statement/lock budgets and complete restores settings', async () => {
  const f = fixture(),
    handle = await prepared(f);
  await f.repository.next(handle, f.tx);
  await f.repository.complete(handle, f.tx);
  const configs = f.state.statements.filter(({ sql }) =>
    sql.startsWith('SELECT set_config'),
  );
  assert.ok(configs.length >= 6);
  for (const config of configs.slice(0, -1)) {
    assert.ok(parseFloat(config.values[0] as string) <= 2000);
    assert.ok(parseFloat(config.values[1] as string) <= 100);
  }
  assert.deepEqual(configs.at(-1)?.values, ['5s', '0']);
});

test('malformed target paths cannot be silently filtered from the pool', async () => {
  for (const kind of ['category', 'scope', 'structure'] as const) {
    const f = fixture(),
      handle = await prepared(f);
    const path = f.state.paths[0]!;
    if (kind === 'category') path.target.category_id = randomUUID();
    if (kind === 'scope') path.target.region_id = randomUUID();
    if (kind === 'structure') path.valid_path = false;
    await assert.rejects(f.repository.next(handle, f.tx), ratingUnavailable);
    await assert.rejects(checkTransactionDeadlines(f.tx), ratingUnavailable);
  }
});

test('DB-clock whole-request deadline is checked after every final owner proof', async () => {
  const f = fixture(),
    handle = await prepared(f);
  await f.repository.next(handle, f.tx);
  await f.repository.complete(handle, f.tx);
  f.state.now = new Date(f.state.now.getTime() + 15_001);
  await assert.rejects(checkTransactionDeadlines(f.tx), ratingUnavailable);
});

test('missing current head, version, or lifecycle at the end of a large pool aborts the complete selection', async () => {
  for (const column of [
    'content_version',
    'definition_revision',
    'applied_target_revision',
    'definition_target_id',
    'lifecycle_target_revision',
  ] as const) {
    const f = fixture(1001),
      handle = await prepared(f);
    f.state.paths.at(-1)!.target[column] = null;
    let seen = 0;
    await assert.rejects(async () => {
      for (;;) {
        const batch = await f.repository.next(handle, f.tx);
        seen += batch.items.length;
        if (batch.done) break;
      }
    }, ratingUnavailable);
    assert.ok(seen > 520);
    await assert.rejects(
      f.repository.complete(handle, f.tx),
      ratingUnavailable,
    );
  }
});

test('pool descriptor binds definition publication rather than later target lifecycle and owner deletion remains closed', async () => {
  const f = fixture(2),
    handle = await prepared(f);
  const current = f.state.paths[0]!.target;
  const definitionRevision = current.definition_revision;
  current.revision = randomUUID();
  current.lifecycle_target_revision = current.revision;
  f.state.paths[1]!.target.owner_deleted = true;
  const batch = await f.repository.next(handle, f.tx);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]!.row.revision, current.revision);
  assert.equal(
    batch.items[0]!.definition.definitionRevision,
    definitionRevision,
  );
  assert.equal(
    batch.items[0]!.definition.appliedTargetRevision,
    definitionRevision,
  );
  assert.equal(batch.items[0]!.row.definition, batch.items[0]!.definition);
  assert.ok(Object.isFrozen(batch.items[0]!.definition));
  await f.repository.complete(handle, f.tx);
});

test('a pool larger than the legacy fact limit preserves mixed v1 and edited current definitions in every branded batch', async () => {
  const f = fixture(1001),
    handle = await prepared(f);
  for (let i = 0; i < f.state.paths.length; i++) {
    if (i % 2 === 0) continue;
    const target = f.state.paths[i]!.target;
    const name = `Edited target ${i}`;
    const definitionRevision = uuid(600_000 + i);
    const appliedTargetRevision = uuid(700_000 + i);
    Object.assign(target, {
      name,
      content_version: 2,
      definition_revision: definitionRevision,
      applied_target_revision: appliedTargetRevision,
      envelope: {
        ...target.envelope,
        version: 3,
        purpose: 'edit_rating_target',
        targetRevision: appliedTargetRevision,
        previousTargetRevision: target.revision,
        previousDefinitionRevision: target.definition_revision,
        definitionRevision,
        contentVersion: 2,
        name,
      },
    });
  }
  let seen = 0;
  for (;;) {
    const batch = await f.repository.next(handle, f.tx);
    assertRatingCompletePoolBatch(batch, f.tx);
    assert.ok(batch.items.length <= 128);
    for (const item of batch.items) {
      const index = Number(BigInt(`0x${item.id.slice(-12)}`)) - 1;
      assert.equal(item.definition.contentVersion, index % 2 === 0 ? 1 : 2);
      assert.equal(
        item.row.name,
        index % 2 === 0 ? `Target ${index}` : `Edited target ${index}`,
      );
      assert.equal(item.row.envelope, item.definition.envelope);
      assert.ok(Object.isFrozen(item.definition));
      seen++;
    }
    if (batch.done) break;
  }
  assert.equal(seen, 1001);
  await f.repository.complete(handle, f.tx);
  await checkTransactionDeadlines(f.tx);
});

test('native category current Review protects the entire 1001-target pool with one fixed category fence', async () => {
  const f = fixture(1001, 1, true),
    handle = await prepared(f);
  let count = 0;
  for (;;) {
    const batch = await f.repository.next(handle, f.tx);
    count += batch.items.length;
    if (batch.done) break;
  }
  assert.equal(count, 1001);
  await f.repository.complete(handle, f.tx);
  await checkTransactionDeadlines(f.tx);
  assert.equal(
    f.state.statements.filter(({ sql }) =>
      sql.startsWith('LOCK TABLE whaleu_community.rating_review_epoch'),
    ).length,
    1,
  );
  f.state.reviewEpoch = '1';
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
});

test('native category authoritative deny is absent and unknown never narrows the complete pool', async () => {
  const denied = fixture(1001, 1, true);
  denied.state.categoryReviewState = 'revoked';
  await assert.rejects(
    prepared(denied),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'RATING_NOT_FOUND',
  );
  const unknown = fixture(1001, 1, true);
  unknown.state.categoryReviewUnknown = true;
  await assert.rejects(
    prepared(unknown),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
});
