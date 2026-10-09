import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { PoolClient } from 'pg';
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
function fixture(count = 1, catalogCount = 1) {
  const categoryId = randomUUID(),
    creatorId = randomUUID();
  const catalogs = Array.from({ length: catalogCount }, (_, i) => ({
    id: uuid(100_000 + i),
    regionId: i ? uuid(200_000 + i) : null,
  }));
  const state = {
    epoch: '0',
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
      kind: 'school',
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
            envelope: { id },
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
