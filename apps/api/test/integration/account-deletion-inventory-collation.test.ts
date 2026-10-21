import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  accountDeletionCapability,
  COOLING_MS,
  INVENTORY_VERSION,
} from '../../src/account-deletion/contracts.js';
import { preflight } from '../../src/account-deletion/owners/preflight.js';
import { accountDeletionFixture } from '../support/account-deletion-fixture.js';

type Fixture = Awaited<ReturnType<typeof accountDeletionFixture>>;
const migrationName = '0174_account_deletion_inventory_collation.sql';
const command = () => ({
  version: 1,
  requestId: randomUUID(),
  expectedGeneration: '0',
  consent: 'account-deletion-explicit-v1',
});
const pageSql =
  'SELECT whaleu_account_deletion.follow_social_page($1) complete';
const sqlConstraint = (message: RegExp) => (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  error.code === '23514' &&
  message.test(error.message);
async function current(tx: Pick<PoolClient, 'query'>, id: string) {
  return (
    await tx.query<{ valid: boolean }>(
      'SELECT whaleu_account_deletion.inventory_current($1) valid',
      [id],
    )
  ).rows[0]!.valid;
}
async function digest(tx: Pick<PoolClient, 'query'>) {
  const value = (
    await tx.query<{ digest: string }>(
      'SELECT whaleu_account_deletion.coordinator_shape() digest',
    )
  ).rows[0]!.digest;
  assert.match(value, /^[a-f0-9]{64}$/);
  return value;
}
async function rollback(f: Fixture, work: (tx: PoolClient) => Promise<void>) {
  const tx = await f.pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await work(tx);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
}
async function sealSnapshot(f: Fixture) {
  return (
    await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
    'sandboxes',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM whaleu_account_deletion.sandboxes s),
    'inventory',(SELECT jsonb_agg(to_jsonb(i) ORDER BY sandbox_id,relation COLLATE "C") FROM whaleu_account_deletion.inventory i)
  ) value`)
  ).rows[0]!.value;
}

// Genuine ordered migration upgrade, not a copied hash or a replacement of the
// installed historical function. Runs in both centrally allocated C/en_US lanes.
test(
  '0174 upgrade invalidates immutable 0173 qualifications without backfill',
  { timeout: 900000 },
  async (t) => {
    const f = await accountDeletionFixture({ throughMigration: 173 });
    t.after(() => f.close());
    const actor = await f.create();
    const intent = command();
    await f.service.request(f.assertion(actor), intent);
    const context = await f.repository.transaction((tx) =>
      f.repository.context(tx, actor.accountId),
    );
    const before = await sealSnapshot(f);
    const oldShape = await digest(f.pool);
    // The historical check can be true in C and false in en_US. Establish its
    // exact ordering predicate instead of disguising the reproduced locale bug.
    const oldArrays = (
      await f.pool.query<{ equal: boolean }>(
        `SELECT
    (SELECT array_agg(relation ORDER BY relation) FROM whaleu_account_deletion.inventory WHERE sandbox_id=$1)
    IS NOT DISTINCT FROM
    (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY n.nspname||'.'||c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\'
       AND n.nspname NOT IN('whaleu_account_deletion','whaleu_meta') AND c.relkind IN('r','p')) equal`,
        [context.sandbox_id],
      )
    ).rows[0]!.equal;
    assert.equal(await current(f.pool, intent.requestId), oldArrays);
    // This regression upgrades exactly 0173 -> published 0174, not later owners.
    const migrations = (
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      )
    ).filter((migration) => Number(migration.name.slice(0, 4)) <= 174);
    assert.equal(migrations.at(-1)?.name, migrationName);
    const result = await runMigrations(f.pool, migrations, { mode: 'up' });
    assert.ok(result.some((entry) => entry.name === migrationName));
    assert.deepEqual(await sealSnapshot(f), before);
    assert.notEqual(await digest(f.pool), oldShape);
    assert.equal(await current(f.pool, intent.requestId), false);
    const check = await f.repository.transaction((tx) =>
      preflight(tx, context.sandbox_id),
    );
    assert.deepEqual(check.blockers, ['COORDINATOR_SHAPE_CHANGED']);
    await assert.rejects(
      f.pool.query(
        'UPDATE whaleu_account_deletion.sandboxes SET coordinator_shape_hash=whaleu_account_deletion.coordinator_shape() WHERE id=$1',
        [context.sandbox_id],
      ),
      sqlConstraint(/Synthetic sandbox identity is immutable/),
    );
    assert.deepEqual(await sealSnapshot(f), before);
    await f.advance(COOLING_MS);
    const waiting = await f.worker.tick(intent.requestId);
    assert.equal(waiting.phase, 'waiting');
    assert.deepEqual(waiting.pending, ['COORDINATOR_SHAPE_CHANGED']);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1',
          [intent.requestId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [actor.accountId],
        )
      ).rowCount,
      1,
    );
  },
);

test(
  '0174 fresh qualification preserves exact causes, current inventory and real completion',
  { timeout: 900000 },
  async (t) => {
    const f = await accountDeletionFixture({ throughMigration: 174 });
    t.after(() => f.close());
    const actor = await f.create(),
      peer = await f.create(),
      unrelated = await f.create();
    const intent = command(),
      peerIntent = command();
    await f.service.request(f.assertion(actor), intent);
    await f.service.request(f.assertion(peer), peerIntent);
    await f.advance(COOLING_MS);
    await f.repository.transaction(async (tx) => {
      for (const id of [intent.requestId, peerIntent.requestId])
        await tx.query(
          "UPDATE whaleu_account_deletion.requests SET phase='erasing',revision=revision+1,irreversible_at=$2 WHERE id=$1",
          [id, new Date(f.now())],
        );
    });
    const context = await f.repository.transaction((tx) =>
      f.repository.context(tx, actor.accountId),
    );
    const shape = await digest(f.pool);
    assert.equal(await current(f.pool, intent.requestId), true);
    assert.equal(INVENTORY_VERSION, 'account-deletion-local-0173-v1');
    assert.equal(accountDeletionCapability().status, 'unavailable');

    await t.test(
      'whole coordinator digest is stable for the three supported rendering settings and restores caller GUCs',
      async () => {
        await rollback(f, async (tx) => {
          for (const search of [
            'public, pg_catalog',
            'whaleu_account_deletion, pg_catalog',
          ])
            for (const quotes of ['on', 'off'])
              for (const style of ['postgres', 'iso_8601', 'sql_standard']) {
                await tx.query(
                  "SELECT set_config('search_path',$1,true),set_config('quote_all_identifiers',$2,true),set_config('IntervalStyle',$3,true)",
                  [search, quotes, style],
                );
                const settings = async () =>
                  (
                    await tx.query(
                      "SELECT current_setting('search_path') search_path,current_setting('quote_all_identifiers') quotes,current_setting('IntervalStyle') interval_style",
                    )
                  ).rows[0];
                const before = await settings();
                assert.equal(await digest(tx), shape, JSON.stringify(before));
                assert.deepEqual(await settings(), before);
              }
        });
        // Item shape/row capture retains its historical caller-setting boundary.
        // These current checks deliberately run after canonical fixture settings restore.
        assert.equal(await current(f.pool, intent.requestId), true);
      },
    );

    await t.test(
      'missing, unrelated, wrong-generation and previously committed causes remain unauthorized',
      async () => {
        await assert.rejects(
          f.pool.query(pageSql, [intent.requestId]),
          sqlConstraint(/Exact synthetic follow cause required/),
        );
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            await f.repository.cause(
              tx,
              await f.repository.request(tx, peerIntent.requestId),
              'follow-social',
            );
            await tx.query(pageSql, [intent.requestId]);
          }),
          sqlConstraint(/Exact synthetic follow cause required/),
        );
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_account_deletion.owner_causes(request_id,owner,generation) VALUES($1,'follow-social',2)",
            [intent.requestId],
          ),
          sqlConstraint(
            /Owner cause requires exact current erasure generation/,
          ),
        );
        await f.repository.transaction(async (tx) =>
          f.repository.cause(
            tx,
            await f.repository.request(tx, intent.requestId),
            'follow-social',
          ),
        );
        await assert.rejects(
          f.pool.query(pageSql, [intent.requestId]),
          sqlConstraint(/Exact synthetic follow cause required/),
        );
      },
    );

    await t.test(
      'function body drift changes qualification and rejects even a genuine current cause',
      async () => {
        const migration = await readFile(
          new URL('../../migrations/' + migrationName, import.meta.url),
          'utf8',
        );
        const installed = migration.match(
          /CREATE OR REPLACE FUNCTION whaleu_account_deletion\.inventory_current\(request uuid\)[\s\S]*?END\$\$;/,
        )?.[0];
        assert.ok(installed);
        await rollback(f, async (tx) => {
          const marker =
            '-- harmless body drift: existing guards remain intact';
          assert.equal(installed.split('AS $$').length, 2);
          const changed = installed.replace(
            'AS $$',
            () => `AS $$\n${marker}\n`,
          );
          assert.equal(changed.replace(`\n${marker}\n`, ''), installed);
          await tx.query(changed);
          assert.notEqual(await digest(tx), shape);
          assert.equal(await current(tx, intent.requestId), false);
          assert.deepEqual((await preflight(tx, context.sandbox_id)).blockers, [
            'COORDINATOR_SHAPE_CHANGED',
          ]);
          await f.repository.cause(
            tx,
            await f.repository.request(tx, intent.requestId),
            'follow-social',
          );
          await assert.rejects(
            tx.query(pageSql, [intent.requestId]),
            sqlConstraint(/Exact synthetic follow cause required/),
          );
        });
        assert.equal(await digest(f.pool), shape);
        assert.equal(await current(f.pool, intent.requestId), true);
      },
    );

    await t.test(
      'extra, missing, shape-changed and unrelated unsupported rows still fail the SQL gate',
      async () => {
        for (const mutation of [
          'CREATE TABLE whaleu_profile.unreviewed_inventory_probe(id integer)',
          'ALTER TABLE whaleu_profile.details RENAME TO missing_inventory_probe',
          'ALTER TABLE whaleu_profile.details ADD COLUMN inventory_probe integer',
        ])
          await rollback(f, async (tx) => {
            await tx.query(mutation);
            assert.equal(await current(tx, intent.requestId), false, mutation);
            await f.repository.cause(
              tx,
              await f.repository.request(tx, intent.requestId),
              'follow-social',
            );
            await assert.rejects(
              tx.query(pageSql, [intent.requestId]),
              sqlConstraint(/Exact synthetic follow cause required/),
            );
          });
        await rollback(f, async (tx) => {
          const id = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,receipt)
        VALUES($1,$2,repeat('a',64),'publish_post',$3::jsonb)`,
            [
              unrelated.accountId,
              id,
              JSON.stringify({
                requestId: id,
                operation: 'publish_post',
                outcome: 'rejected',
                code: 'PHONE_VERIFICATION_REQUIRED',
              }),
            ],
          );
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          assert.equal(await current(tx, intent.requestId), false);
          assert.ok(
            (await preflight(tx, context.sandbox_id)).blockers.includes(
              'UNSUPPORTED_OWNER_DATA:whaleu_community.publication_requests',
            ),
          );
          await f.repository.cause(
            tx,
            await f.repository.request(tx, intent.requestId),
            'follow-social',
          );
          await assert.rejects(
            tx.query(pageSql, [intent.requestId]),
            sqlConstraint(/Exact synthetic follow cause required/),
          );
        });
        assert.equal(await current(f.pool, intent.requestId), true);
      },
    );

    await t.test(
      'fresh exact current cause executes the real page and all seven genuine owners finish',
      async () => {
        let completed = false;
        for (let page = 0; page < 100; page++) {
          const status = await f.worker.tick(intent.requestId);
          if (status.phase === 'completed') {
            completed = true;
            break;
          }
          assert.equal(status.phase, 'waiting');
          assert.ok(
            status.pending.every((reason) =>
              ['OWNER_PAGE_PENDING', 'OWNER_WORK_PENDING'].includes(reason),
            ),
            JSON.stringify(status),
          );
        }
        assert.equal(completed, true);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_account_deletion.owner_receipts WHERE request_id=$1',
              [intent.requestId],
            )
          ).rowCount,
          7,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_account_deletion.follow_pages WHERE request_id=$1',
              [intent.requestId],
            )
          ).rowCount! > 0,
          true,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_account_deletion.follow_social_complete($1) complete',
              [intent.requestId],
            )
          ).rows[0]!.complete,
          true,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [actor.accountId],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [peer.accountId],
            )
          ).rowCount,
          1,
        );
      },
    );
  },
);
