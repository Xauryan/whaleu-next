import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { Pool } from 'pg';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';

async function snapshot(
  pool: Pool,
  tables: readonly { table_schema: string; table_name: string }[],
) {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    assert.match(table.table_schema, /^whaleu_[a-z_]+$/);
    assert.match(table.table_name, /^[a-z_]+$/);
    result[`${table.table_schema}.${table.table_name}`] = (
      await pool.query(
        `SELECT to_jsonb(x)-'compat_projection_id' row FROM ${table.table_schema}.${table.table_name} x ORDER BY (to_jsonb(x)-'compat_projection_id')::text`,
      )
    ).rows;
  }
  return result;
}
test(
  'M3B actual 0061 upgrade preserves all historical rows and leaves every unissued scoped route closed',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingDiscussionFixture(61);
    t.after(() => f.close());
    const actor = await f.actor();
    await f.catalog(actor, { count: 2, depth: 3 });
    const tables = (
      await f.pool.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema LIKE 'whaleu_%' AND table_type='BASE TABLE' AND table_name<>'schema_migrations' ORDER BY 1,2`,
      )
    ).rows;
    const before = await snapshot(f.pool, tables);
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    await runMigrations(f.pool, migrations, { mode: 'up' });
    await f.restartApp();
    const after = await snapshot(f.pool, tables);
    const catalogKey = 'whaleu_experience.title_catalog';
    const catalog = after[catalogKey] as { row: Record<string, unknown> }[];
    const additions = catalog.filter(
      (item) => item.row['title_key'] === 'role_admin',
    );
    assert.equal(additions.length, 1);
    assert.deepEqual(additions[0]!.row, {
      title_key: 'role_admin',
      name: '管理员',
      kind: 'special',
      unlock_level: null,
    });
    assert.equal(catalog.length, (before[catalogKey] as unknown[]).length + 1);
    after[catalogKey] = catalog.filter((item) => item !== additions[0]);
    const entitlementsKey = 'whaleu_experience.entitlements';
    const entitlements = after[entitlementsKey] as {
      row: Record<string, unknown>;
    }[];
    for (const item of entitlements) {
      assert.equal(item.row['school_admin_actor_id'], null);
      assert.equal(item.row['school_admin_request_id'], null);
      delete item.row['school_admin_actor_id'];
      delete item.row['school_admin_request_id'];
    }
    const accountsKey = 'whaleu_identity.accounts';
    const accounts = after[accountsKey] as { row: Record<string, unknown> }[];
    assert.equal(accounts.length, (before[accountsKey] as unknown[]).length);
    for (const item of accounts) {
      // 0172 adds these exact defaults without changing historical identity.
      assert.equal(item.row['lifecycle'], 'active');
      assert.equal(item.row['lifecycle_generation'], 0);
      assert.equal(item.row['deletion_request_id'], null);
      delete item.row['lifecycle'];
      delete item.row['lifecycle_generation'];
      delete item.row['deletion_request_id'];
      // 0180 preserves historical sessions at the exact initial epoch.
      assert.equal(item.row['session_revocation_epoch'], 0);
      delete item.row['session_revocation_epoch'];
      // 0182 adds no real request authority to an existing account.
      assert.equal(item.row['real_deletion_request_id'], null);
      delete item.row['real_deletion_request_id'];
    }
    const sessionsKey = 'whaleu_identity.sessions';
    const sessions = after[sessionsKey] as { row: Record<string, unknown> }[];
    assert.equal(sessions.length, (before[sessionsKey] as unknown[]).length);
    assert.ok(accounts.length > 0 && sessions.length > 0);
    for (const item of sessions) {
      assert.equal(item.row['issued_revocation_epoch'], 0);
      delete item.row['issued_revocation_epoch'];
    }
    // Prove 0172/0180/0182's exact additive defaults and 0133's exact catalog
    // addition; retain every original historical field and table for equality.
    assert.deepEqual(after, before);
    for (const table of [
      'scoped_source_attestations',
      'scoped_catalogs',
      'scoped_catalog_heads',
      'scope_protocol_versions',
      'scope_protocol_heads',
      'compat_versions',
      'compat_heads',
      'legacy_adoption_manifests',
    ]) {
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM whaleu_ratings.${table}`,
          )
        ).rows[0].n,
        0,
        table,
      );
    }
    const response = await f
      .auth(request(f.http).post('/v2/ratings/contexts'), actor)
      .send({ selector: { kind: 'global' }, purpose: 'read', mode: 'public' });
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.headers['vary'] ?? '', /Authorization/i);
    const schemas = (
      await f.pool.query<{ n: number }>(
        `SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='whaleu_ratings' AND column_name='compat_projection_id' AND table_name IN ('catalog_materializations','catalog_category_lineage')`,
      )
    ).rows[0];
    assert.equal(schemas?.n, 2);
    await assert.rejects(
      f.pool.query(
        "INSERT INTO whaleu_ratings.scope_protocol_versions(id,logical_scope_key,phase,generation,manifest) VALUES(gen_random_uuid(),'global','adopted',gen_random_uuid(),'{}')",
      ),
    );
    const oldChecks = (
      await f.pool.query<{ valid: boolean }>(
        `SELECT whaleu_ratings.rating_scoped_operation_rule('set_score_scoped',2) IS NOT NULL AND whaleu_ratings.rating_scoped_operation_rule('set_score_scoped',1) IS NULL AND whaleu_ratings.rating_scoped_operation_rule('arbitrary_scoped',2) IS NULL valid`,
      )
    ).rows[0];
    assert.equal(oldChecks?.valid, true);
  },
);
