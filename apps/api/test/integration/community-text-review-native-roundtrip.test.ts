/** Real native controller → strict HTTP gateway → normal AppModule → PostgreSQL.
 * Local operator decisions are explicit; only identity/scope facts are synthetic.
 * This does not claim WeChat-device or real external-provider acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import {
  WECHAT_PHONE_PROVIDER,
  type PhoneProvider,
} from '../../src/verification/wechat-phone-provider.js';
import { PhoneBindingService } from '../../src/verification/phone-binding.service.js';
import { VerificationRepository } from '../../src/verification/verification.repository.js';
import { seedCommunityScope } from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

const output = z.strictObject({
  event: z.enum(['pending', 'done', 'failure']),
  requestId: z.string().uuid().optional(),
  cancelledRequestId: z.string().uuid().optional(),
  resourceId: z.string().uuid().optional(),
  issued: z.number().int().optional(),
  message: z.string().optional(),
});
function checkpoint(
  child: ChildProcess,
  expected: 'pending' | 'done',
): Promise<z.infer<typeof output>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
    };
    const message = (raw: unknown) => {
      const parsed = output.safeParse(raw);
      if (!parsed.success) {
        cleanup();
        reject(Error('Invalid text-review native IPC'));
        return;
      }
      if (parsed.data.event === 'failure') {
        cleanup();
        reject(Error(parsed.data.message));
      } else if (parsed.data.event === expected) {
        cleanup();
        resolve(parsed.data);
      }
    };
    const exit = (code: number | null) => {
      cleanup();
      reject(Error(`Native child exited before ${expected}: ${code}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error(`Native child timed out at ${expected}`));
    }, 45000);
    timer.unref();
    child.on('message', message);
    child.once('exit', exit);
  });
}

test(
  'native text review, explicit operator approval, original-key publication and cancelled-response recovery',
  { timeout: 120000 },
  async () => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      child: ChildProcess | undefined;
    let locked = false,
      owns = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked);
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
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
      const scope = await seedCommunityScope(pool);
      const config = loadConfig({
        ...base,
        NATIVE_VERIFICATION_ENROLLMENT: 'enabled',
        WECHAT_PHONE_BINDING: 'enabled',
        WECHAT_PHONE_PROOF_TTL_SECONDS: '3600',
        WECHAT_APP_ID: 'wx0000000000000000',
        WECHAT_APP_SECRET: 'synthetic-native-roundtrip-not-a-secret',
        AUTH_RATE_LIMIT_KEY: '0'.repeat(64),
        COMMUNITY_TEXT_REVIEW: 'local_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test:native-reviewer',
      });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      const port = Number(new URL(await app.getUrl()).port);
      // The only provider substitute is its external authorization result. Identity
      // creation, absence enrollment and phone-owner completion all use real code.
      const provider = app.get<PhoneProvider>(WECHAT_PHONE_PROVIDER);
      provider.exchange = async () => ({
        appId: config.WECHAT_APP_ID!,
        authorizedAt: Date.now(),
      });
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const created = await app.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: config.WECHAT_APP_ID!,
          subject: randomUUID(),
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      const actor = { ...created, accessToken, refreshToken };
      const records = new VerificationRepository();
      assert.deepEqual(
        (await inTransaction(pool, (tx) => records.read(actor.accountId, tx)))
          .summary,
        {
          affiliation: { status: 'unverified' },
          studentNumber: { status: 'unverified' },
          phone: { status: 'unverified' },
          application: { status: 'none' },
        },
      );
      const phone = app.get(PhoneBindingService),
        phoneRequest = randomUUID();
      assert.equal(
        (await phone.reserve(accessToken, phoneRequest, null)).state,
        'reserved',
      );
      assert.equal(
        (
          await phone.authorize(
            accessToken,
            phoneRequest,
            'synthetic-native-authorization-code',
          )
        ).state,
        'verified',
      );
      assert.deepEqual(
        (await inTransaction(pool, (tx) => records.read(actor.accountId, tx)))
          .summary,
        {
          affiliation: { status: 'unverified' },
          studentNumber: { status: 'unverified' },
          phone: { status: 'verified' },
          application: { status: 'none' },
        },
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM whaleu_campus.community_identity_selections WHERE account_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        0,
      );
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-policy',
            basis: 'Disposable native roundtrip local policy',
          },
          tx,
        ),
      );
      const policy = {
        postEnabled: true,
        commentEnabled: true,
        namedOnly: true as const,
        categories: ['discussion' as const],
        validForHours: 24,
        basis: 'Explicit native single-region text experiment',
      };
      const preview = (await inTransaction(pool, (tx) =>
        operator.run({ command: 'preview-region', ...policy }, tx),
      )) as { currentRevision: number; previewDigest: string };
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'apply-region',
            ...policy,
            expectedRevision: preview.currentRevision,
            previewDigest: preview.previewDigest,
          },
          tx,
        ),
      );
      child = fork(
        fileURLToPath(
          new URL(
            '../support/community-text-review-native-worker.mjs',
            import.meta.url,
          ),
        ),
        [],
        {
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      child.stderr?.resume();
      const exited = new Promise<number | null>((resolve) =>
        child!.once('exit', resolve),
      );
      const pendingResult = checkpoint(child, 'pending');
      child.send({ port, credentials: actor, spaceId: scope.home.spaceId });
      const pending = await pendingResult;
      assert.ok(pending.requestId);
      const row = (
        await pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, pending.requestId],
        )
      ).rows[0];
      assert.ok(row);
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'decide',
            accountId: actor.accountId,
            requestId: pending.requestId!,
            digest: row.digest,
            decision: 'allow',
            basis: 'Explicit operator approval of exact native synthetic text',
          },
          tx,
        ),
      );
      const doneResult = checkpoint(child, 'done');
      child.send({ event: 'approved' });
      const done = await doneResult;
      assert.equal(done.requestId, pending.requestId);
      assert.equal(done.issued, 2);
      assert.notEqual(done.cancelledRequestId, done.requestId);
      const receipt = (
        await pool.query<{ receipt: { outcome: string; resourceId: string } }>(
          'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, done.requestId],
        )
      ).rows[0]!.receipt;
      assert.equal(receipt.outcome, 'created');
      assert.equal(receipt.resourceId, done.resourceId);
      assert.equal(await exited, 0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exit = new Promise<void>((resolve) =>
          child!.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exit;
      }
      await app?.close();
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
