/** Real-PG metadata-only parity and GUC recovery. No actor/business fixtures. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { boundedOwnerProof } from '../../src/database/required-owner-proof.js';
import { ApplicationError } from '../../src/http/application-error.js';
import {
  readingCatalogPreimageSql,
  readingCatalogSnapshotSql,
} from '../../src/community/reading-formatting/catalog.js';
import {
  inspectReadingSchema,
  requireReadingSchema,
} from '../../src/community/reading-formatting/readiness.js';

const original = readFileSync(
  new URL(
    '../../migrations/0176_durable_reading_formatting.sql',
    import.meta.url,
  ),
  'utf8',
)
  .split('AS $catalog$')[1]!
  .split('$catalog$;')[0]!;
const tail = ` SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb)::text,'UTF8')),'hex') FROM facts`;
assert.equal(original.split(tail).length, 2);
const referencePreimageSql =
  original.split(tail)[0]! +
  ` SELECT coalesce(jsonb_agg(jsonb_build_array(kind,key,value) ORDER BY kind COLLATE "C",key COLLATE "C"),'[]'::jsonb)::text preimage FROM facts`;
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const pathOf = async (tx: PoolClient) =>
  (
    await tx.query<{ path: string }>(
      "SELECT pg_catalog.current_setting('search_path') path",
    )
  ).rows[0]!.path;
const hasCode = (code: string) => (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;

/** Caller owns an explicit transaction; the migration-created original remains
 * untouched and provides an independent exact full-preimage reference. */
async function reference(tx: PoolClient): Promise<string> {
  const before = await pathOf(tx);
  await tx.query(
    "SELECT pg_catalog.set_config('search_path','pg_catalog',true)",
  );
  try {
    return (await tx.query<{ preimage: string }>(referencePreimageSql)).rows[0]!
      .preimage;
  } finally {
    await tx.query("SELECT pg_catalog.set_config('search_path',$1,true)", [
      before,
    ]);
  }
}

async function compare(tx: PoolClient, expected: string): Promise<void> {
  const before = await pathOf(tx);
  const actual = (await tx.query(readingCatalogPreimageSql)).rows[0];
  const runtime = (await tx.query(readingCatalogSnapshotSql)).rows[0];
  assert.deepEqual(
    runtime,
    {
      catalog: actual.catalog,
      slots: actual.slots,
      deparsePath: actual.deparsePath,
      searchPathRestored: actual.searchPathRestored,
    },
    'Exact runtime query has the same snapshot',
  );
  assert.equal(
    actual.preimage,
    expected,
    'Full ordered JSON preimage, not hash only',
  );
  assert.equal(actual.catalog, digest(expected));
  assert.deepEqual(actual.slots, [1, 2]);
  assert.equal(actual.deparsePath, 'pg_catalog');
  assert.equal(actual.searchPathRestored, true);
  assert.equal(await pathOf(tx), before);
  assert.equal(
    (await tx.query('SELECT whaleu_community.reading_format_catalog() catalog'))
      .rows[0].catalog,
    actual.catalog,
  );
}

export async function verifyReadingCatalogParity(
  pool: Pool,
  suite: PoolClient,
): Promise<void> {
  const originalPath = await pathOf(suite);
  let expected: string;
  await suite.query('BEGIN');
  try {
    expected = await reference(suite);
  } finally {
    await suite.query('ROLLBACK');
  }
  const preparedName = `reading_catalog_${randomUUID().replaceAll('-', '')}`;
  const ancillaryName = `${preparedName}_parameterized`;
  const prepared = new Set<string>();
  const paths = [
    originalPath,
    'whaleu_community, pg_catalog',
    '"whaleu_community", "$user", public, pg_catalog',
    '',
    'pg_catalog',
  ];
  try {
    // Fixture-only session settings establish raw/autocommit caller contexts.
    // The runtime collector itself uses only LOCAL, in its one statement.
    for (const path of paths) {
      await suite.query(
        "SELECT pg_catalog.set_config('search_path',$1,false)",
        [path],
      );
      await compare(suite, expected);
      await suite.query('BEGIN');
      try {
        await compare(suite, await reference(suite));
      } finally {
        await suite.query('ROLLBACK');
      }
    }
    // SET SESSION followed by SET LOCAL within the same transaction must retain
    // the local value now and the session value after commit, not flatten both.
    await suite.query('BEGIN');
    try {
      await suite.query(
        "SELECT pg_catalog.set_config('search_path',$1,false)",
        ['"whaleu_community", pg_catalog'],
      );
      await suite.query("SELECT pg_catalog.set_config('search_path','',true)");
      await compare(suite, await reference(suite));
      assert.equal(await pathOf(suite), '');
      await suite.query('COMMIT');
      assert.equal(await pathOf(suite), '"whaleu_community", pg_catalog');
    } finally {
      await suite.query('ROLLBACK');
      await suite.query(
        "SELECT pg_catalog.set_config('search_path',$1,false)",
        [originalPath],
      );
    }
    // Unrelated shadow objects are deliberately outside the fingerprint scope.
    // Parse-time catalog qualification must ignore them under a hostile path.
    await suite.query('BEGIN');
    try {
      await suite.query(`CREATE SCHEMA whaleu_reading_catalog_shadow;
        CREATE FUNCTION whaleu_reading_catalog_shadow.current_setting(pg_catalog.text) RETURNS pg_catalog.text LANGUAGE sql AS $$SELECT 'poison'::pg_catalog.text$$;
        CREATE DOMAIN whaleu_reading_catalog_shadow.text AS pg_catalog.int4;
        CREATE FUNCTION whaleu_reading_catalog_shadow.equal(pg_catalog.text,pg_catalog.text) RETURNS pg_catalog.bool LANGUAGE sql AS $$SELECT false$$;
        CREATE OPERATOR whaleu_reading_catalog_shadow.= (LEFTARG=pg_catalog.text,RIGHTARG=pg_catalog.text,FUNCTION=whaleu_reading_catalog_shadow.equal)`);
      await suite.query(
        'SET LOCAL search_path=whaleu_reading_catalog_shadow,whaleu_community,pg_catalog',
      );
      await compare(suite, await reference(suite));
    } finally {
      await suite.query('ROLLBACK');
    }

    // The exact runtime query has zero parameters, so named execution is generic
    // immediately. Reuse/revalidate its prepared statement across caller paths,
    // with consecutive executions under each unchanged path too.
    for (const path of paths) {
      await suite.query('BEGIN');
      try {
        await suite.query(
          "SELECT pg_catalog.set_config('search_path',$1,true)",
          [path],
        );
        const before = await pathOf(suite);
        for (let repetition = 0; repetition < 2; repetition++) {
          const actual = (
            await suite.query({
              name: preparedName,
              text: readingCatalogSnapshotSql,
            })
          ).rows[0];
          prepared.add(preparedName);
          assert.equal(actual.catalog, digest(await reference(suite)));
          assert.deepEqual(actual.slots, [1, 2]);
          assert.equal(actual.deparsePath, 'pg_catalog');
          assert.equal(actual.searchPathRestored, true);
          assert.equal(await pathOf(suite), before);
        }
      } finally {
        await suite.query('ROLLBACK');
      }
    }
    const exactPlans = (
      await suite.query<{ generic_plans: string; custom_plans: string }>(
        'SELECT generic_plans,custom_plans FROM pg_catalog.pg_prepared_statements WHERE name=$1',
        [preparedName],
      )
    ).rows[0]!;
    assert.ok(Number(exactPlans.generic_plans) >= 2 * paths.length);
    assert.equal(Number(exactPlans.custom_plans), 0);

    // Ancillary parameterized variant exercises both plan modes. It is not
    // represented as evidence that the zero-parameter runtime query is custom.
    for (const mode of ['force_custom_plan', 'force_generic_plan']) {
      await suite.query('BEGIN');
      try {
        // Diagnostic plan selection only; rolled back, never a runtime setting.
        await suite.query(
          "SELECT pg_catalog.set_config('plan_cache_mode',$1,true)",
          [mode],
        );
        await suite.query('SET LOCAL search_path=whaleu_community,pg_catalog');
        const before = await pathOf(suite);
        const actual = (
          await suite.query({
            name: ancillaryName,
            text: readingCatalogPreimageSql + '\nWHERE $1::pg_catalog.bool',
            values: [true],
          })
        ).rows[0];
        prepared.add(ancillaryName);
        assert.equal(actual.preimage, expected);
        assert.equal(actual.deparsePath, 'pg_catalog');
        assert.equal(actual.searchPathRestored, true);
        assert.equal(await pathOf(suite), before);
      } finally {
        await suite.query('ROLLBACK');
      }
    }
    const plans = (
      await suite.query<{ generic_plans: string; custom_plans: string }>(
        'SELECT generic_plans,custom_plans FROM pg_catalog.pg_prepared_statements WHERE name=$1',
        [ancillaryName],
      )
    ).rows[0]!;
    assert.ok(
      Number(plans.generic_plans) > 0 && Number(plans.custom_plans) > 0,
    );

    // Test-only fault variants preserve the exact CASE/CTE/path wrapper and
    // fail inside its THEN branch. The cast error naming "pg_catalog" proves
    // the LOCAL path change happened before the error, not merely at parse time.
    const marker = "pg_catalog.convert_to(value,'UTF8')";
    assert.equal(readingCatalogSnapshotSql.split(marker).length, 2);
    const fault = (expression: string) =>
      readingCatalogSnapshotSql.replace(
        marker,
        `pg_catalog.convert_to(${expression},'UTF8')`,
      );
    const castFailure = fault(
      "(pg_catalog.current_setting('search_path')::pg_catalog.int4)::pg_catalog.text",
    );
    const isInBranchCastError = (error: unknown) =>
      hasCode('22P02')(error) &&
      error instanceof Error &&
      error.message.includes('pg_catalog');
    await suite.query(
      "SELECT pg_catalog.set_config('search_path','pg_catalog',false)",
    );
    await assert.rejects(suite.query(castFailure), isInBranchCastError);
    assert.equal(await pathOf(suite), 'pg_catalog');
    await suite.query("SELECT pg_catalog.set_config('search_path',$1,false)", [
      originalPath,
    ]);
    await assert.rejects(suite.query(castFailure), isInBranchCastError);
    assert.equal(await pathOf(suite), originalPath);

    await suite.query('BEGIN');
    try {
      await suite.query('SET LOCAL search_path=whaleu_community,pg_catalog');
      const before = await pathOf(suite);
      await suite.query('SAVEPOINT catalog_fault');
      await assert.rejects(suite.query(castFailure), isInBranchCastError);
      await suite.query('ROLLBACK TO SAVEPOINT catalog_fault');
      assert.equal(await pathOf(suite), before);
      await suite.query("SET LOCAL statement_timeout='20ms'");
      const delayed = fault('(SELECT value FROM pg_catalog.pg_sleep(0.2))');
      await assert.rejects(suite.query(delayed), hasCode('57014'));
      await suite.query('ROLLBACK TO SAVEPOINT catalog_fault');
      assert.equal(await pathOf(suite), before);
      await compare(suite, expected);
    } finally {
      await suite.query('ROLLBACK');
    }

    const locker = await pool.connect();
    const lockKey = Number.parseInt(randomUUID().slice(0, 7), 16);
    let held = false;
    try {
      await locker.query('SELECT pg_catalog.pg_advisory_lock(1464355978,$1)', [
        lockKey,
      ]);
      held = true;
      await suite.query('BEGIN');
      try {
        await suite.query('SET LOCAL search_path=whaleu_community,pg_catalog');
        const before = await pathOf(suite);
        await suite.query('SAVEPOINT catalog_lock');
        await suite.query("SET LOCAL lock_timeout='1ms'");
        const blocked = fault(
          `(SELECT value FROM pg_catalog.pg_advisory_xact_lock(1464355978,${lockKey}))`,
        );
        await assert.rejects(suite.query(blocked), hasCode('55P03'));
        await suite.query('ROLLBACK TO SAVEPOINT catalog_lock');
        assert.equal(await pathOf(suite), before);
        await compare(suite, expected);
      } finally {
        await suite.query('ROLLBACK');
      }
    } finally {
      if (held)
        await locker.query(
          'SELECT pg_catalog.pg_advisory_unlock(1464355978,$1)',
          [lockKey],
        );
      locker.release();
    }

    // Pin the real managed wrapper to this known client so post-COMMIT and
    // post-ROLLBACK path checks cannot accidentally inspect a different backend.
    // Only fixture ownership/release is adapted, not any query or proof behavior.
    const release = suite.release;
    suite.release = () => {};
    const ownedPool = { connect: async () => suite } as unknown as Pick<
      Pool,
      'connect'
    >;
    try {
      const sessionPath = await pathOf(suite);
      await inTransaction(ownedPool, async (tx) => {
        await tx.query('SET LOCAL search_path=whaleu_community,pg_catalog');
        const before = await pathOf(tx);
        await requireReadingSchema(tx);
        assert.equal(await pathOf(tx), before);
        await boundedOwnerProof(tx, 'COMMUNITY_UNAVAILABLE', async (read) => {
          await inspectReadingSchema(read);
          assert.equal(await pathOf(tx), before);
        });
        assert.equal(await pathOf(tx), before);
      });
      // Final required proof ran through the unchanged bounded proxy at COMMIT.
      assert.equal(await pathOf(suite), sessionPath);
      await assert.rejects(
        inTransaction(ownedPool, async (tx) => {
          await tx.query('SET LOCAL search_path=whaleu_community,pg_catalog');
          await tx.query(castFailure);
        }),
        isInBranchCastError,
      );
      assert.equal(await pathOf(suite), sessionPath);
      await inTransaction(ownedPool, async (tx) => {
        await requireReadingSchema(tx);
      });
      assert.equal(await pathOf(suite), sessionPath);
    } finally {
      suite.release = release;
    }

    const mutations = [
      'CREATE FUNCTION whaleu_community.readingXformat_probe() RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT 1$$',
      'CREATE TABLE whaleu_community.readingXformat_probe(id integer)',
      "CREATE FUNCTION whaleu_community.reading_format_protocol(integer) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$SELECT '{}'::jsonb$$",
      `CREATE SCHEMA whaleu_reading_catalog_probe; CREATE TABLE whaleu_reading_catalog_probe.subject(id integer); CREATE FUNCTION whaleu_reading_catalog_probe.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$; CREATE TRIGGER reading_late_guard BEFORE INSERT ON whaleu_reading_catalog_probe.subject FOR EACH ROW EXECUTE FUNCTION whaleu_reading_catalog_probe.guard()`,
      `CREATE OR REPLACE FUNCTION whaleu_community.reading_format_catalog() RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog AS $probe$${original}\n-- exact-self-definition mutation\n$probe$`,
    ];
    for (const mutation of mutations) {
      await suite.query('BEGIN');
      try {
        await suite.query(mutation);
        const changed = await reference(suite);
        assert.notEqual(changed, expected);
        await compare(suite, changed);
        await assert.rejects(
          inspectReadingSchema(suite),
          (error: unknown) =>
            error instanceof ApplicationError &&
            error.code === 'COMMUNITY_UNAVAILABLE',
        );
        if (mutation.startsWith('CREATE SCHEMA')) {
          // This trigger belongs to both original predicate arms. The new
          // disjoint branches must emit it once, and must not duplicate its
          // already-covered foreign function or omit the foreign-only guard.
          await suite.query(
            'CREATE TRIGGER reading_late_guard BEFORE INSERT ON whaleu_community.reading_format_jobs FOR EACH ROW EXECUTE FUNCTION whaleu_reading_catalog_probe.guard()',
          );
          const overlapping = await reference(suite);
          const foreignFacts = JSON.parse(changed) as [
            string,
            string,
            unknown,
          ][];
          const overlapFacts = JSON.parse(overlapping) as [
            string,
            string,
            unknown,
          ][];
          assert.equal(overlapFacts.length, foreignFacts.length + 1);
          for (const [kind, key] of [
            [
              'trigger',
              'whaleu_community.reading_format_jobs:reading_late_guard',
            ],
            [
              'trigger',
              'whaleu_reading_catalog_probe.subject:reading_late_guard',
            ],
            ['function', 'whaleu_reading_catalog_probe.guard()'],
          ])
            assert.equal(
              overlapFacts.filter((fact) => fact[0] === kind && fact[1] === key)
                .length,
              1,
            );
          await compare(suite, overlapping);
          await assert.rejects(
            inspectReadingSchema(suite),
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'COMMUNITY_UNAVAILABLE',
          );
          await suite.query(
            'CREATE OR REPLACE FUNCTION whaleu_reading_catalog_probe.guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$',
          );
          const foreignFunctionChanged = await reference(suite);
          assert.notEqual(foreignFunctionChanged, overlapping);
          await compare(suite, foreignFunctionChanged);
          await assert.rejects(
            inspectReadingSchema(suite),
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'COMMUNITY_UNAVAILABLE',
          );
        }
      } finally {
        await suite.query('ROLLBACK');
      }
      await compare(suite, expected);
    }
  } finally {
    await suite.query('ROLLBACK');
    await suite.query("SELECT pg_catalog.set_config('search_path',$1,false)", [
      originalPath,
    ]);
    for (const name of prepared) await suite.query(`DEALLOCATE "${name}"`);
  }
  assert.equal(await pathOf(suite), originalPath);
}
