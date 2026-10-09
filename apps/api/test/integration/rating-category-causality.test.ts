import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingCategoryFixture,
  ratingCategoryPrefix,
} from '../support/rating-category-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { ratingCategoryIntentHash } from '../../src/ratings/category-management/requests.js';

// Canonical synthetic owner facts, real HTTP/PG pipeline, and direct adversarial
// statements. No trigger disabling, session_replication_role, or fake approval.
test('M3A exact three-level release has bidirectional retained causal artifacts', async (t) => {
  const f = await ratingCategoryFixture();
  t.after(() => f.close());
  const actor = await f.actor();
  await f.grant(actor, 'developer');
  const created = await f.createCategories(actor, null, {
    nodes: [
      { key: 'root', parentKey: null, name: 'Root', description: '' },
      {
        key: 'branch',
        parentKey: 'root',
        name: 'Branch',
        description: 'Reviewed branch',
      },
      {
        key: 'leaf',
        parentKey: 'branch',
        name: 'Leaf',
        description: 'Reviewed leaf',
      },
    ],
  });
  assert.deepEqual(
    created.receipt.categories.map((row) => row.level),
    [1, 2, 3],
  );
  assert.equal(
    created.receipt.catalogs.length,
    4,
    'Global and all three canonical regions publish together',
  );
  const source = (
    await f.pool.query<{ exact: boolean }>(
      `SELECT
    (SELECT count(*) FROM whaleu_ratings.category_identities WHERE creation_release_id=$1)=3
    AND (SELECT count(*) FROM whaleu_ratings.category_base_versions WHERE release_id=$1)=3
    AND (SELECT count(*) FROM whaleu_ratings.category_scope_versions WHERE release_id=$1)=1
    AND (SELECT count(*) FROM whaleu_ratings.category_release_catalogs WHERE release_id=$1)=4
    AND (SELECT count(*) FROM whaleu_community.rating_category_base_bindings WHERE release_id=$1)=3
    AND (SELECT count(DISTINCT decision_id) FROM whaleu_community.rating_category_base_bindings WHERE release_id=$1)=1
    AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_release_catalogs r
      WHERE r.release_id=$1 AND (NOT whaleu_ratings.category_catalog_sources_complete(r.after_catalog_id)
       OR NOT whaleu_ratings.category_catalog_compat_current(r.after_catalog_id))) exact`,
      [created.receipt.releaseId],
    )
  ).rows[0];
  assert.equal(source?.exact, true);
  const repeated = await f.commitCategories(
    actor,
    created.input,
    created.prepared.contextRevision,
  );
  assert.deepEqual(repeated.body, created.receipt);
  const recovered = await f.auth(
    request(f.http).get(
      `${ratingCategoryPrefix}/requests/${created.input.clientRequestId}`,
    ),
    actor,
  );
  assert.deepEqual(recovered.body, created.receipt);
  const id = created.receipt.categories[0]!.id;
  for (const sql of [
    "UPDATE whaleu_ratings.category_base_versions SET name='Forged' WHERE category_id=$1",
    'DELETE FROM whaleu_ratings.category_identities WHERE id=$1',
    'UPDATE whaleu_ratings.category_base_heads SET revision=gen_random_uuid() WHERE category_id=$1',
    'DELETE FROM whaleu_community.rating_category_base_bindings WHERE category_id=$1',
  ])
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) => tx.query(sql, [id])),
      sql,
    );
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query('TRUNCATE whaleu_ratings.catalog_category_lineage'),
    ),
  );
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.category_identities(id,creator_id,kind,is_system,system_key,source_kind,creation_release_id)
     VALUES($1,$2,'general',false,NULL,'native',$3)`,
        [randomUUID(), actor.accountId, created.receipt.releaseId],
      ),
    ),
    'A retained historical release cannot justify a new orphan identity',
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.category_identities WHERE creation_release_id=$1',
        [created.receipt.releaseId],
      )
    ).rowCount,
    3,
  );
});

test('M3A preparations and closures share the old command namespace and reject uncaused receipts', async (t) => {
  const f = await ratingCategoryFixture();
  t.after(() => f.close());
  const actor = await f.actor();
  await f.grant(actor, 'super_admin');
  const intent = f.categoryIntent(await f.categoryContext(actor));
  const prepared = await f.prepareCategories(actor, intent);
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'set_score',$3)`,
        [actor.accountId, intent.clientRequestId, 'a'.repeat(64)],
      ),
    ),
    'A preparation reserves the shared namespace before a receipt exists',
  );
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "UPDATE whaleu_ratings.category_command_preparations SET nodes='[]'::jsonb WHERE account_id=$1 AND request_id=$2",
        [actor.accountId, intent.clientRequestId],
      ),
    ),
  );
  const before = await f.pool.query(
    'SELECT catalog_id FROM whaleu_ratings.catalog_heads ORDER BY scope_key',
  );
  const fake = { ...intent, clientRequestId: randomUUID() };
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash,receipt)
     VALUES($1,$2,'create_categories',$3,$4::jsonb)`,
        [
          actor.accountId,
          fake.clientRequestId,
          ratingCategoryIntentHash(fake),
          JSON.stringify({
            requestId: fake.clientRequestId,
            operation: 'create_categories',
            outcome: 'applied',
            releaseId: randomUUID(),
            categories: prepared.categories,
            catalogs: [],
            occurredAt: new Date().toISOString(),
          }),
        ],
      ),
    ),
    'An applied receipt cannot exist without an exact fresh transition',
  );
  const cancelled = await f
    .auth(request(f.http).post(`${ratingCategoryPrefix}/cancel`), actor)
    .send(intent);
  assert.deepEqual(cancelled.body, {
    requestId: intent.clientRequestId,
    operation: 'create_categories',
    outcome: 'rejected',
    code: 'RATING_CATEGORY_CANCELLED',
  });
  assert.deepEqual(
    (await f.commitCategories(actor, intent, prepared.contextRevision)).body,
    cancelled.body,
  );
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT catalog_id FROM whaleu_ratings.catalog_heads ORDER BY scope_key',
      )
    ).rows,
    before.rows,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.category_command_transitions',
      )
    ).rowCount,
    0,
  );
  const unknown = { ...intent, clientRequestId: randomUUID() };
  const waiting = await f.prepareCategories(actor, unknown);
  const noReview = await f.commitCategories(
    actor,
    unknown,
    waiting.contextRevision,
  );
  assert.equal(noReview.status, 503, JSON.stringify(noReview.body));
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, unknown.clientRequestId],
      )
    ).rowCount,
    0,
    'Unknown Review never becomes terminal rejection',
  );
});

test('M3A SQL intent validator rejects extra authority, forests, duplicate keys and noncanonical text', async (t) => {
  const f = await ratingCategoryFixture();
  t.after(() => f.close());
  const actor = await f.actor();
  await f.grant(actor, 'developer');
  const intent = f.categoryIntent(await f.categoryContext(actor));
  const malformed = [
    { ...intent, isSystem: true },
    { ...intent, assetIds: [randomUUID()] },
    { ...intent, parentId: randomUUID(), expectedParentRevision: null },
    {
      ...intent,
      nodes: [...intent.nodes, { ...intent.nodes[0], key: 'another' }],
    },
    {
      ...intent,
      nodes: [...intent.nodes, { ...intent.nodes[0], parentKey: 'root' }],
    },
    { ...intent, nodes: [{ ...intent.nodes[0], name: ' Leading space' }] },
    { ...intent, nodes: [{ ...intent.nodes[0], parentKey: 'later' }] },
  ];
  for (const value of malformed) {
    const result = await f.pool.query<{ valid: boolean }>(
      'SELECT whaleu_ratings.category_intent_valid($1::jsonb) valid',
      [JSON.stringify(value)],
    );
    assert.equal(result.rows[0]?.valid, false, JSON.stringify(value));
  }
  const hashes = await f.pool.query<{ hash: string }>(
    'SELECT whaleu_ratings.category_intent_hash($1::jsonb) hash',
    [JSON.stringify(intent)],
  );
  assert.equal(hashes.rows[0]?.hash, ratingCategoryIntentHash(intent));
});
