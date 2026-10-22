/** Real schema-retention/definition-reader code with catalog result fixtures.
 * PostgreSQL closure, role and concurrent-write evidence lives in the separate
 * production integration. These tests never claim actual SQL execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { MIGRATION_LOCK } from '../src/database/migrations.js';
import { readingCatalogSnapshotSql } from '../src/community/reading-formatting/catalog.js';
import {
  inspectReadingSchema,
  retainReadingSchema,
  hasRetainedHomeReadingSchema,
} from '../src/community/reading-formatting/readiness.js';
import { HOME_READING_CATALOG_BODY_SHA256 } from '../src/community/reading-formatting/home-schema.js';
import { readHomeDefinitionEvidence } from '../src/community/home-feed-policy/definition-evidence.js';
import { assertReadingWorkerRole } from '../src/community/reading-formatting/worker-process.js';
import { observeReadingFormatter } from '../src/community/reading-formatting/capability.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const oldBody = readFileSync(
  new URL('../migrations/0176_durable_reading_formatting.sql', import.meta.url),
  'utf8',
)
  .split('AS $catalog$')[1]!
  .split('$catalog$;')[0]!;
const migration = readFileSync(
  new URL('../migrations/0178_home_publication_protocol.sql', import.meta.url),
  'utf8',
);
const homeBody = migration
  .split('AS $home_reading_catalog$')[1]!
  .split('$home_reading_catalog$;')[0]!;
const oldCatalog = 'a'.repeat(64),
  homeCatalog = 'b'.repeat(64);
const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE';
function fixture(home = true) {
  const presence = {
    homePresent: home,
    relations: 8,
    functions: 14,
    protocol: true,
    catalog: true,
    catalogFunction: {
      body: oldBody,
      stable: true,
      invoker: true,
      sql: true,
      config: ['search_path=pg_catalog'],
      scalar: true,
    },
    marker: {
      body: `SELECT '${JSON.stringify({ version: 1, formatter: 'plain-cjk-slices-v2', generation: 1, migration: '0176_durable_reading_formatting.sql', catalog: oldCatalog })}'::jsonb`,
      immutable: true,
      invoker: true,
      sql: true,
      config: ['search_path=pg_catalog'],
      scalar: true,
      sameOwner: true,
    },
  };
  const state = {
    presence,
    home: {
      collector: { body: homeBody, safe: true },
      marker: {
        body: `SELECT '${JSON.stringify({ version: 1, migration: '0178_home_publication_protocol.sql', catalog: homeCatalog })}'::jsonb`,
        safe: true,
      },
    } as { collector: unknown; marker: unknown },
    current: homeCatalog,
    gate: true,
    queries: [] as string[],
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      state.queries.push(sql);
      if (sql === 'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked') {
        assert.deepEqual(values, [...MIGRATION_LOCK]);
        return { rows: [{ locked: state.gate }] };
      }
      if (sql.includes('count(*)::integer FROM pg_class'))
        return { rows: [state.presence] };
      if (sql === readingCatalogSnapshotSql)
        return {
          rows: [
            {
              catalog: oldCatalog,
              slots: [1, 2],
              deparsePath: 'pg_catalog',
              searchPathRestored: true,
            },
          ],
        };
      if (
        sql.includes(
          "to_regprocedure('whaleu_community.home_reading_protocol()')",
        )
      )
        return { rows: [state.home] };
      if (sql === 'SELECT whaleu_community.home_reading_catalog() catalog')
        return { rows: [{ catalog: state.current }] };
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes("current_setting('statement_timeout')"))
        return { rows: [{ statement_timeout: '0', lock_timeout: '0' }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { state, tx };
}
const id = '10000000-0000-4000-8000-000000000001';
async function evidenceReads(tx: PoolClient) {
  await readHomeDefinitionEvidence('post', id, id, tx);
  await readHomeDefinitionEvidence('comment', id, id, tx);
}
function ownerReads(queries: string[]) {
  return queries.filter(
    (q) =>
      q.startsWith('SELECT evidence FROM whaleu_community.home_') ||
      q.startsWith('SELECT post_id AS "postId"'),
  );
}

test('finite Home collector hard-pin preserves original 0176 collector and seals exact historical premises', () => {
  assert.equal(
    createHash('sha256').update(homeBody).digest('hex'),
    HOME_READING_CATALOG_BODY_SHA256,
  );
  assert.equal(
    createHash('sha256').update(oldBody).digest('hex'),
    '4193cd2855e457dbc40ed24a5f1966735e0436b435455eca69e50cbd19893133',
  );
  assert.doesNotMatch(
    homeBody,
    /home_(?:reading_catalog|reading_protocol|publication_catalog|publication_protocol)/,
  );
  assert.doesNotMatch(homeBody, /LIKE 'home_%'/);
  for (const name of [
    'home_metadata_insert_guard',
    'home_definition',
    'home_review_current',
    'approved_content_immutable',
    'approved_post_immutable',
    'approved_comment_immutable',
    'approved_reply_immutable',
    'moderation_text_valid',
    'moderation_trim',
    'moderation_uuid_valid',
    'post_owner_visibility_keys',
    'rating_scoped_uuid_valid',
  ])
    assert.ok(homeBody.includes(`'${name}'`), name);
  for (const field of [
    'relowner',
    'relrowsecurity',
    'relforcerowsecurity',
    'relispartition',
    'relpartbound',
    'pg_inherits',
    'convalidated',
    'indisvalid',
    'indisready',
    'indislive',
    'tgenabled',
    'tgdeferrable',
    'tginitdeferred',
    'pg_get_functiondef',
    'proowner',
  ])
    assert.ok(homeBody.includes(field), field);
});

test('inspection and legacy-only retention never grant SELECT-only Home evidence', async () => {
  for (const home of [false, true]) {
    const f = fixture(home);
    startTransactionDeadlines(f.tx);
    try {
      await inspectReadingSchema(f.tx);
      assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
      await evidenceReads(f.tx);
      assert.ok(
        ownerReads(f.state.queries).every((q) => q.endsWith(' FOR SHARE')),
      );
      if (!home) {
        await retainReadingSchema(f.tx);
        assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
        assert.equal(
          f.state.queries.some((q) => q.includes('home_reading_catalog()')),
          false,
        );
      }
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('retained combined proof alone permits point SELECT for the exact managed client', async () => {
  const f = fixture();
  await assert.rejects(retainReadingSchema(f.tx), unavailable);
  startTransactionDeadlines(f.tx);
  try {
    await retainReadingSchema(f.tx);
    assert.equal(hasRetainedHomeReadingSchema(f.tx), true);
    assert.equal(hasRetainedHomeReadingSchema(fixture().tx), false);
    await evidenceReads(f.tx);
    assert.ok(
      ownerReads(f.state.queries).every((q) => !q.includes('FOR SHARE')),
    );
    await checkTransactionDeadlines(f.tx);
    assert.equal(
      f.state.queries.filter(
        (q) => q === 'SELECT whaleu_community.home_reading_catalog() catalog',
      ).length,
      2,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
  assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
  startTransactionDeadlines(f.tx);
  try {
    assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('savepoint rollback/read-epoch replacement invalidates the private retained mark', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    const before = checkpointTransactionDeadlines(f.tx);
    await retainReadingSchema(f.tx);
    assert.equal(hasRetainedHomeReadingSchema(f.tx), true);
    restoreTransactionDeadlines(f.tx, before);
    assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
    await evidenceReads(f.tx);
    assert.ok(
      ownerReads(f.state.queries).every((q) => q.endsWith(' FOR SHARE')),
    );
    await retainReadingSchema(f.tx);
    assert.equal(hasRetainedHomeReadingSchema(f.tx), true);
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

for (const mode of ['missing', 'unsafe', 'body', 'digest', 'marker'] as const)
  test(`Home partial/drift ${mode} fails closed and clears a prior retained mark`, async () => {
    const f = fixture();
    startTransactionDeadlines(f.tx);
    try {
      await retainReadingSchema(f.tx);
      if (mode === 'missing') f.state.home.marker = null;
      if (mode === 'unsafe')
        f.state.home.collector = { body: homeBody, safe: false };
      if (mode === 'body')
        f.state.home.collector = { body: homeBody + ' ', safe: true };
      if (mode === 'digest') f.state.current = 'c'.repeat(64);
      if (mode === 'marker')
        f.state.home.marker = {
          body: "SELECT '{}'::jsonb || '{}'::jsonb",
          safe: true,
        };
      await assert.rejects(retainReadingSchema(f.tx), unavailable);
      assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  });

test('required finalizer rejects changed Home seal even when original reading catalog is unchanged', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    await retainReadingSchema(f.tx);
    f.state.current = 'c'.repeat(64);
    f.state.home.marker = {
      body: `SELECT '${JSON.stringify({ version: 1, migration: '0178_home_publication_protocol.sql', catalog: f.state.current })}'::jsonb`,
      safe: true,
    };
    await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('missing Home presence attestation is not silently treated as legacy', async () => {
  const f = fixture(false);
  Reflect.deleteProperty(f.state.presence, 'homePresent');
  await assert.rejects(inspectReadingSchema(f.tx), unavailable);
});

test('optional final presentation/capability schema checks include the Home identity', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    const value = await observeReadingFormatter(f.tx, 'disabled');
    assert.equal(value.schema, 'installed');
    assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
    f.state.current = 'c'.repeat(64);
    await checkTransactionDeadlines(f.tx);
    assert.equal(value.schema, 'unavailable');
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('production role query rejects absent Home owners through NULL OIDs with a controlled upgrade error', async () => {
  let calls = 0;
  const tx = {
    query: async (sql: string) => {
      calls++;
      // SQL-result fixture, not a claim to run PostgreSQL privilege checks.
      assert.match(sql, /to_regclass\(a\.relation\) IS NULL/);
      assert.match(
        sql,
        /has_table_privilege\(current_user,to_regclass\(a\.relation\)::oid,a\.privilege\)/,
      );
      assert.match(
        sql,
        /has_column_privilege\(current_user,to_regclass\(a\.relation\)::oid,a\."column",a\.privilege\)/,
      );
      assert.doesNotMatch(
        sql,
        /has_(?:table|column)_privilege\(current_user,a\.relation,/,
      );
      return { rows: [{ admitted: false }] };
    },
  } as unknown as PoolClient;
  await assert.rejects(
    assertReadingWorkerRole(tx),
    /complete 0178 Home migration.*least-privilege managed-runtime role/,
  );
  assert.equal(calls, 1);
});

test('cooperating migration exclusion is obtained before catalog proof and failed try never grants a mark', async () => {
  const f = fixture();
  startTransactionDeadlines(f.tx);
  try {
    f.state.gate = false;
    await assert.rejects(retainReadingSchema(f.tx), unavailable);
    assert.deepEqual(f.state.queries, [
      'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked',
    ]);
    assert.equal(hasRetainedHomeReadingSchema(f.tx), false);
    f.state.gate = true;
    await retainReadingSchema(f.tx);
    assert.equal(
      f.state.queries[1],
      'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked',
    );
    assert.equal(hasRetainedHomeReadingSchema(f.tx), true);
    await checkTransactionDeadlines(f.tx);
    assert.equal(
      f.state.queries.some((q) => q.includes('pg_advisory_unlock')),
      false,
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
