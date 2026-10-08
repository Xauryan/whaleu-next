/** Disposable real-AppModule fixture. No runtime authorization replacement. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import type { MaintenanceReceipt } from '../../src/experience/maintenance.contracts.js';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { inTransaction, poolOptions } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { establishSyntheticExperienceBaseline } from './experience-fixtures.js';
import { migrationSchemaNames } from './migration-schemas.js';

export const maintenancePath = '/v1/admin/experience/title-maintenance';
export async function maintenanceFixture() {
  const urlString = process.env['TEST_DATABASE_URL'];
  assert.ok(
    urlString,
    'Requires disposable TEST_DATABASE_URL; never silently skipped',
  );
  const url = new URL(urlString);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: urlString,
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    PG_POOL_MAX: '16',
    PG_STATEMENT_TIMEOUT_MS: '15000',
  });
  const pool = new Pool(poolOptions(config));
  const suite = await pool.connect();
  let owns = false;
  const locked = (
    await suite.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1,$2) locked',
      [MIGRATION_LOCK[0], 2],
    )
  ).rows[0]!.locked;
  const cleanup = async () => {
    try {
      if (owns)
        for (const schema of [
          'whaleu_maintenance_test',
          ...migrationSchemaNames,
        ])
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      if (locked)
        await suite.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite.release();
      await pool.end();
    }
  };
  try {
    assert.ok(locked, 'Serial exclusive PostgreSQL fixture required');
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
        )
      ).rowCount,
      0,
      'Refuse preexisting schemas',
    );
    owns = true;
    await runMigrations(
      pool,
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      ),
      { mode: 'up' },
    );
    await pool.query('CREATE SCHEMA whaleu_maintenance_test');
    const module = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    configureHttp(app);
    await app.init();
    const identity = app.get(IdentityRepository);
    let serial = 0;
    async function account(
      input: {
        balance?: bigint;
        provider?: boolean;
        blocked?: boolean;
        id?: string;
      } = {},
    ) {
      const id =
        input.id ??
        `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
      const subject = randomUUID();
      await inTransaction(pool, async (tx) => {
        await tx.query(
          'INSERT INTO whaleu_identity.accounts(id,status) VALUES($1,$2)',
          [id, input.blocked ? 'blocked' : 'active'],
        );
        if (input.provider !== false)
          await tx.query(
            "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-maintenance-only',$1,$2)",
            [subject, id],
          );
        if (input.balance !== undefined)
          await establishSyntheticExperienceBaseline(tx, id, {
            balance: input.balance,
          });
      });
      return { id, subject };
    }
    async function actor() {
      const who = await account({ id: randomUUID(), balance: 0n });
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const session = await identity.createSession(
        {
          provider: 'wechat',
          appId: 'synthetic-maintenance-only',
          subject: who.subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      return { ...session, accessToken };
    }
    async function grant(
      accountId: string,
      role: 'developer' | 'super_admin' | 'school_admin',
      input: { expiresAt?: Date; regionId?: string } = {},
    ) {
      const id = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at) VALUES($1,$2,$3,$4,$2,'synthetic-maintenance-test',clock_timestamp()-interval '1 minute',$5)",
        [id, accountId, role, input.regionId ?? null, input.expiresAt ?? null],
      );
      return id;
    }
    const batch = (token: string | undefined, body: object) => {
      const req = request(app.getHttpServer()).post(
        `${maintenancePath}/batches`,
      );
      return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(
        body,
      );
    };
    const receipt = (token: string, id: string) =>
      request(app.getHttpServer())
        .get(`${maintenancePath}/requests/${id}`)
        .set('Authorization', `Bearer ${token}`);
    async function sweep(
      token: string,
      operation: 'repair_level_titles' | 'repair_default_title',
    ) {
      const receipts: MaintenanceReceipt[] = [];
      let body: object = { requestId: randomUUID(), operation };
      for (let guard = 0; guard < 200; guard++) {
        const result = await batch(token, body).expect(200);
        receipts.push(result.body);
        if (result.body.done) return receipts;
        body = {
          requestId: randomUUID(),
          previousRequestId: result.body.requestId,
        };
      }
      assert.fail(
        'Maintenance sweep did not terminate within fixture population',
      );
    }
    async function waitForLock(fragment: string) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const row = (
          await pool.query<{ waiting: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1) waiting",
            [`%${fragment}%`],
          )
        ).rows[0]!;
        if (row.waiting) return;
        await sleep(10);
      }
      assert.fail(`Expected observed PostgreSQL lock wait: ${fragment}`);
    }
    async function rollbackRows(id: string) {
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM whaleu_experience.maintenance_requests WHERE request_id=$1',
            [id],
          )
        ).rowCount,
        0,
      );
    }
    return {
      pool,
      app,
      identity,
      account,
      actor,
      grant,
      batch,
      receipt,
      sweep,
      waitForLock,
      rollbackRows,
      close: async () => {
        try {
          await app.close();
        } finally {
          await cleanup();
        }
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
export type MaintenanceFixture = Awaited<ReturnType<typeof maintenanceFixture>>;
export async function hold(pool: Pool, sql: string, values: unknown[] = []) {
  const tx = await pool.connect();
  await tx.query('BEGIN');
  await tx.query(sql, values);
  return tx;
}
export async function release(tx: PoolClient | undefined) {
  if (tx) {
    await tx.query('ROLLBACK');
    tx.release();
  }
}
