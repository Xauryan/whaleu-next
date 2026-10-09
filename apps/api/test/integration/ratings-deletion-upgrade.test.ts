import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { seedRating0052Upgrade } from '../support/rating-legacy-upgrade-fixture.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';

test('0053 upgrades populated 0052 without rewriting legacy receipts, authors, effects or sources', async (t) => {
  const f = await ratingDiscussionFixture(52);
  t.after(() => f.close());
  const owner = await f.actor(),
    other = await f.actor(),
    catalog = await f.catalog(owner),
    target = catalog.targets[0]!;
  // Historical rows must be created with the actual 0052 SQL protocol, not
  // today's command services (which deliberately require the latest schema).
  const { root, reply, deletedRoot, deletion, score, liked } =
    await seedRating0052Upgrade(f, owner, other, catalog, target);
  assert.equal(deletion.outcome, 'applied');
  assert.equal(score.outcome, 'applied', JSON.stringify(score));
  assert.equal(liked.outcome, 'applied', JSON.stringify(liked));
  const tables = (
    await f.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='whaleu_ratings' AND table_type='BASE TABLE' ORDER BY table_name",
    )
  ).rows.map((r) => r.table_name);
  const snapshot = async () => {
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      assert.match(table, /^[a-z_]+$/);
      rows[table] = (
        await f.pool.query(
          `SELECT to_jsonb(r)-'admin_delete_audit_id' row FROM whaleu_ratings.${table} r ORDER BY (to_jsonb(r)-'admin_delete_audit_id')::text`,
        )
      ).rows;
    }
    return rows;
  };
  const before = await snapshot();
  const migrations = await readMigrations(
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  );
  await runMigrations(f.pool, migrations, { mode: 'up' });
  assert.deepEqual(await snapshot(), before);
  for (const table of [
    'target_origin_sources',
    'target_origin_heads',
    'admin_delete_audits',
  ])
    assert.equal(
      (
        await f.pool.query(
          `SELECT count(*)::int n FROM whaleu_ratings.${table}`,
        )
      ).rows[0]!.n,
      0,
    );
  assert.deepEqual(
    (
      await f.auth(
        request(f.http).get(
          `/v1/ratings/requests/${root.input.clientRequestId}`,
        ),
        owner,
      )
    ).body,
    root.receipt,
  );
  assert.deepEqual(
    (
      await f.auth(
        request(f.http).get(
          `/v1/ratings/reply-requests/${reply.input.clientRequestId}`,
        ),
        other,
      )
    ).body,
    reply.receipt,
  );
  const noop = await f.deleteRoot(owner, catalog, target, {
    id: deletedRoot.id,
    revision: deletion.revision,
  });
  assert.equal(noop.outcome, 'noop', JSON.stringify(noop));
  assert.equal(noop.occurredAt, deletion.occurredAt);
});
