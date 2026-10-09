import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';

async function snapshot(
  pool: Pool,
  names: readonly { table_schema: string; table_name: string }[],
) {
  const rows: Record<string, unknown> = {};
  for (const { table_schema: schema, table_name: table } of names) {
    assert.match(schema, /^whaleu_[a-z_]+$/);
    assert.match(table, /^[a-z_]+$/);
    rows[`${schema}.${table}`] = (
      await pool.query(
        `SELECT to_jsonb(r) row FROM ${schema}.${table} r ORDER BY to_jsonb(r)::text`,
      )
    ).rows;
  }
  return rows;
}

test('M3A real 0057 to 0058 upgrade preserves every old row, request hash, receipt, epoch and revoked Review', async (t) => {
  // Start at the real old prefix. Never create post-0058 data and pretend that
  // dropping new tables reproduces an upgrade.
  const f = await ratingDiscussionFixture(57);
  t.after(() => f.close());
  const actor = await f.actor();
  const legacy = await f.catalog(actor, { count: 2, depth: 3 });
  const target = legacy.targets[0]!;
  await setRatingReviewState(f.pool, target.approval.decisionId, 'revoked');
  const createIntent = {
    clientRequestId: randomUUID(),
    regionId: null,
    categoryId: legacy.categoryId,
    expectedCategoryRevision: legacy.categoryRevision,
    expectedCatalogRevision: legacy.catalogId,
    name: 'Retained old create intent',
    description: '',
    assetIds: [],
  };
  const editIntent = {
    clientRequestId: randomUUID(),
    targetId: target.id,
    regionId: null,
    expectedTargetRevision: target.revision,
    expectedDefinitionRevision: target.revision,
    expectedContentVersion: 1,
    categoryId: legacy.categoryId,
    expectedCategoryRevision: legacy.categoryRevision,
    expectedCatalogRevision: legacy.catalogId,
    name: 'Retained old edit intent',
    description: '',
    assetIds: [],
  };
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const createHash = (
      await tx.query<{ hash: string }>(
        `SELECT encode(sha256(convert_to(E'whaleu:rating-target-create:v1\\n'||whaleu_ratings.creation_canonical_json(jsonb_build_object('operation','create_target','intent',$1::jsonb)),'UTF8')),'hex') hash`,
        [JSON.stringify(createIntent)],
      )
    ).rows[0]!.hash;
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'create_target',$3)",
      [actor.accountId, createIntent.clientRequestId, createHash],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.target_creation_closures(account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,'RATING_CREATION_CANCELLED')",
      [
        actor.accountId,
        createIntent.clientRequestId,
        createHash,
        JSON.stringify(createIntent),
      ],
    );
    await tx.query(
      "UPDATE whaleu_ratings.requests SET receipt=jsonb_build_object('requestId',request_id,'operation',operation,'outcome','rejected','code','RATING_CREATION_CANCELLED') WHERE account_id=$1 AND request_id=$2",
      [actor.accountId, createIntent.clientRequestId],
    );
    const editHash = (
      await tx.query<{ hash: string }>(
        'SELECT whaleu_ratings.target_edit_intent_hash($1::jsonb) hash',
        [JSON.stringify(editIntent)],
      )
    ).rows[0]!.hash;
    await tx.query(
      "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'edit_target',$3)",
      [actor.accountId, editIntent.clientRequestId, editHash],
    );
    await tx.query(
      "INSERT INTO whaleu_ratings.target_edit_closures(actor_account_id,request_id,intent_hash,intent,code) VALUES($1,$2,$3,$4::jsonb,'RATING_EDIT_CANCELLED')",
      [
        actor.accountId,
        editIntent.clientRequestId,
        editHash,
        JSON.stringify(editIntent),
      ],
    );
    await tx.query(
      "UPDATE whaleu_ratings.requests SET receipt=jsonb_build_object('requestId',request_id,'operation',operation,'outcome','rejected','code','RATING_EDIT_CANCELLED') WHERE account_id=$1 AND request_id=$2",
      [actor.accountId, editIntent.clientRequestId],
    );
  });
  const v1 = target.approval.envelope;
  const v2 = {
    version: 2,
    purpose: 'publish_rating_reply',
    accountId: actor.accountId,
    clientRequestId: randomUUID(),
    targetId: target.id,
    targetRevision: target.revision,
    categoryId: legacy.categoryId,
    categoryRevision: legacy.categoryRevision,
    catalogRevision: legacy.catalogId,
    scope: { regionId: null },
    assetIds: [],
    authorMode: 'named',
    body: 'Retained v2 shape',
    rootId: randomUUID(),
    rootRevision: randomUUID(),
    replyTo: null,
  };
  const v3 = {
    ...v1,
    version: 3,
    purpose: 'edit_rating_target',
    targetRevision: randomUUID(),
    previousTargetRevision: target.revision,
    previousDefinitionRevision: target.revision,
    definitionRevision: randomUUID(),
    contentVersion: 2,
  };
  const envelopes = [
    v1,
    v2,
    v3,
    { ...v1, inventedAuthority: true },
    { ...v2, inventedAuthority: true },
    { ...v3, inventedAuthority: true },
  ];
  const shapes = async () =>
    (
      await f.pool.query<{ shape: boolean }>(
        `SELECT whaleu_community.rating_envelope_shape(e,e->>'purpose') shape
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY x(e,ord) ORDER BY ord`,
        [JSON.stringify(envelopes)],
      )
    ).rows;
  const oldShapes = await shapes();
  assert.deepEqual(
    oldShapes.map((row) => row.shape),
    [true, true, true, false, false, false],
  );
  const beforePredicate = (
    await f.pool.query<{ current: boolean }>(
      'SELECT whaleu_ratings.target_edit_catalog_current($1,$2::jsonb,clock_timestamp()) current',
      [target.id, JSON.stringify(editIntent)],
    )
  ).rows[0]?.current;
  const tables = (
    await f.pool.query<{
      table_schema: string;
      table_name: string;
    }>(`SELECT table_schema,table_name FROM information_schema.tables
    WHERE table_type='BASE TABLE' AND table_schema LIKE 'whaleu_%' AND table_schema<>'whaleu_meta' ORDER BY table_schema,table_name`)
  ).rows;
  const before = await snapshot(f.pool, tables);
  const requestBytes = (
    await f.pool.query(
      'SELECT account_id,request_id,operation,intent_hash,receipt::text FROM whaleu_ratings.requests ORDER BY account_id,request_id',
    )
  ).rows;
  const migrations = await readMigrations(
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  );
  await runMigrations(
    f.pool,
    migrations.filter((m) => Number(m.name.slice(0, 4)) <= 58),
    { mode: 'up' },
  );
  assert.deepEqual(
    await snapshot(f.pool, tables),
    before,
    'No old authority, epoch, state, source or receipt row may be rewritten',
  );
  assert.deepEqual(
    await shapes(),
    oldShapes,
    'The installed v1-v3 envelope branches preserve exact acceptance and strict extra-key rejection',
  );
  assert.equal(
    (
      await f.pool.query<{ current: boolean }>(
        'SELECT whaleu_ratings.target_edit_catalog_current($1,$2::jsonb,clock_timestamp()) current',
        [target.id, JSON.stringify(editIntent)],
      )
    ).rows[0]?.current,
    beforePredicate,
    'The M2B wrapper preserves the old opaque current-catalog predicate',
  );
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT account_id,request_id,operation,intent_hash,receipt::text FROM whaleu_ratings.requests ORDER BY account_id,request_id',
      )
    ).rows,
    requestBytes,
  );
  assert.equal(
    (await f.pool.query('SELECT 1 FROM whaleu_ratings.category_identities'))
      .rowCount,
    0,
  );
  assert.equal(
    (await f.pool.query('SELECT 1 FROM whaleu_ratings.category_base_versions'))
      .rowCount,
    0,
  );
  const lineage = (
    await f.pool.query<{ exact: boolean }>(`SELECT
    NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories c LEFT JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(c.catalog_id,c.id)
      WHERE NOT coalesce(l.source_kind='opaque' AND l.effective_revision=c.revision AND l.base_revision IS NULL AND l.scope_version_id IS NULL AND l.topology_snapshot_id IS NULL,false))
    AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.catalogs c LEFT JOIN whaleu_ratings.catalog_materializations m ON m.catalog_id=c.id
      WHERE NOT coalesce(m.source_kind='opaque' AND m.topology_snapshot_id IS NULL AND m.campus_ids='{}'::uuid[],false)) exact`)
  ).rows[0];
  assert.equal(
    lineage?.exact,
    true,
    'Historical effective rows receive opaque lineage only',
  );
  assert.equal(
    (
      await f.pool.query<{ current: boolean }>(
        `SELECT whaleu_community.rating_target_definition_current(target_id,content_version,definition_revision,applied_target_revision,envelope) current FROM whaleu_ratings.target_definition_versions WHERE target_id=$1`,
        [target.id],
      )
    ).rows[0]?.current,
    false,
  );
  const applied = (
    await f.pool.query<{ name: string; checksum: string }>(
      "SELECT name,checksum FROM whaleu_meta.schema_migrations WHERE name<'0058' ORDER BY name",
    )
  ).rows;
  assert.deepEqual(
    applied,
    migrations
      .filter((m) => Number(m.name.slice(0, 4)) <= 57)
      .map(({ name, checksum }) => ({ name, checksum })),
    'Every frozen migration checksum remains the real applied prefix',
  );
});
