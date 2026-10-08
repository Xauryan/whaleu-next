import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import { inTransaction, poolOptions } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
const title = 'redeem_liangchenmeijing';
const at = new Date('2026-10-08T00:00:00Z');
test(
  'redemption SQL immutable decision proof, strict receipts and synthetic-only authority',
  { timeout: 120000 },
  async (t) => {
    const urlString = process.env['TEST_DATABASE_URL'];
    assert.ok(urlString);
    const url = new URL(urlString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const pool = new Pool(
      poolOptions(
        loadConfig({
          NODE_ENV: 'test',
          DATABASE_URL: urlString,
          PG_SSL_MODE: 'disable',
          LOG_LEVEL: 'silent',
        }),
      ),
    );
    let suite: PoolClient | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rowCount,
        0,
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      async function actor() {
        const owner = randomUUID();
        await pool.query(
          'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
          [owner],
        );
        await pool.query(
          'INSERT INTO whaleu_experience.owners(owner_id) VALUES($1)',
          [owner],
        );
        return owner;
      }
      async function decision(
        tx: PoolClient,
        owner: string,
        id: string,
        outcome = 'granted',
        key: string | null = title,
      ) {
        await tx.query(
          "INSERT INTO whaleu_experience.redemption_decisions(owner_id,request_id,title_key,outcome,decided_at,authority_kind) VALUES($1,$2,$3,$4,$5,'synthetic_fixture')",
          [owner, id, key, outcome, at],
        );
      }
      async function entitlement(
        tx: PoolClient,
        owner: string,
        id: string,
        earned = at,
      ) {
        await tx.query(
          "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,redemption_request_id,earned_at) VALUES($1,$2,'redemption',$3,$4)",
          [owner, title, id, earned],
        );
      }
      async function receipt(
        tx: PoolClient,
        owner: string,
        id: string,
        extra: Record<string, unknown> = {},
      ) {
        await tx.query(
          "INSERT INTO whaleu_experience.requests(owner_id,request_id,operation,intent_hash,intent_key_version,receipt) VALUES($1,$2,'redeem_title',$3,'synthetic_v1',$4::jsonb)",
          [
            owner,
            id,
            'a'.repeat(64),
            JSON.stringify({
              requestId: id,
              operation: 'redeem_title',
              outcome: 'granted',
              titleKey: title,
              ...extra,
            }),
          ],
        );
      }
      const constraintError = (e: unknown) =>
        !!e &&
        typeof e === 'object' &&
        'code' in e &&
        ['23514', '23503', '23505'].includes(String(e.code));
      await t.test(
        'orphan/mismatched/forged proof and extra receipt fields cannot commit',
        async () => {
          const cases = [
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r);
            },
            async (tx: PoolClient, o: string, r: string) => {
              await receipt(tx, o, r);
            },
            async (tx: PoolClient, o: string, r: string) => {
              await entitlement(tx, o, r);
            },
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r);
              await receipt(tx, o, r);
            },
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r);
              await entitlement(tx, o, r, new Date(at.getTime() + 1));
            },
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r);
              await entitlement(tx, o, r);
              await receipt(tx, o, r, { extra: 'not allowed' });
            },
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r, 'invalid', null);
              await entitlement(tx, o, r);
            },
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r, 'already_owned');
            },
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r, 'granted', 'level_1');
            },
            async (tx: PoolClient, o: string, r: string) => {
              await decision(tx, o, r);
              await entitlement(tx, o, r);
              await receipt(tx, o, r, {
                outcome: 'rejected',
                code: 'EXPERIENCE_REDEMPTION_INVALID',
                titleKey: undefined,
              });
            },
          ];
          for (const run of cases) {
            const owner = await actor();
            await assert.rejects(
              inTransaction(pool, (tx) => run(tx, owner, randomUUID())),
              constraintError,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1',
                  [owner],
                )
              ).rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        'complete grant is immutable and cannot be reused by a later transaction',
        async () => {
          const owner = await actor(),
            id = randomUUID();
          await inTransaction(pool, async (tx) => {
            await decision(tx, owner, id);
            await entitlement(tx, owner, id);
            await receipt(tx, owner, id);
          });
          for (const table of [
            'redemption_decisions',
            'entitlements',
            'requests',
          ])
            await assert.rejects(
              pool.query(
                `DELETE FROM whaleu_experience.${table} WHERE owner_id=$1`,
                [owner],
              ),
              constraintError,
            );
          await assert.rejects(
            inTransaction(pool, (tx) => receipt(tx, owner, id)),
            constraintError,
          );
          await assert.rejects(
            inTransaction(pool, (tx) => decision(tx, owner, randomUUID())),
            constraintError,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.account_states WHERE owner_id=$1',
                [owner],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'already-owned preserves undated evidence and invalid has no proof-linked entitlement',
        async () => {
          const owner = await actor();
          await pool.query(
            "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,earned_at) VALUES($1,$2,'synthetic_fixture',NULL)",
            [owner, title],
          );
          const before = (
            await pool.query(
              'SELECT * FROM whaleu_experience.entitlements WHERE owner_id=$1',
              [owner],
            )
          ).rows[0];
          for (const outcome of ['already_owned', 'invalid'])
            await inTransaction(pool, async (tx) => {
              const id = randomUUID();
              await decision(
                tx,
                owner,
                id,
                outcome,
                outcome === 'invalid' ? null : title,
              );
              await receipt(tx, owner, id, {
                outcome: 'rejected',
                titleKey: undefined,
                code:
                  outcome === 'invalid'
                    ? 'EXPERIENCE_REDEMPTION_INVALID'
                    : 'EXPERIENCE_TITLE_ALREADY_OWNED',
              });
            });
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_experience.entitlements WHERE owner_id=$1',
                [owner],
              )
            ).rows[0],
            before,
          );
        },
      );
      await t.test(
        'synthetic authority denial fails closed and prior receipt constraints remain active',
        async () => {
          const owner = await actor();
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await tx.query(
                'CREATE OR REPLACE FUNCTION whaleu_experience.synthetic_fixture_allowed() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$',
              );
              await decision(tx, owner, randomUUID());
            }),
            constraintError,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT whaleu_experience.synthetic_fixture_allowed() allowed',
              )
            ).rows[0].allowed,
            true,
          );
          for (const operation of ['appearance', 'sign_in'])
            await assert.rejects(
              pool.query(
                'INSERT INTO whaleu_experience.requests(owner_id,request_id,operation,intent_hash,receipt) VALUES($1,$2,$3,$4,$5)',
                [
                  owner,
                  randomUUID(),
                  operation,
                  'a'.repeat(64),
                  JSON.stringify({
                    operation,
                    outcome: 'rejected',
                    code: 'unexpected',
                  }),
                ],
              ),
              constraintError,
            );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer n FROM pg_constraint WHERE conrelid='whaleu_experience.requests'::regclass AND conname IN ('requests_check','receipt_strict_fields')",
              )
            ).rows[0].n,
            2,
          );
        },
      );
    } finally {
      if (owns)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
