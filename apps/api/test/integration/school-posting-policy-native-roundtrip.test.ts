/** Emitted App and Page/WXML events → native HTTP gateway → AppModule → PostgreSQL.
 * Only WeChat platform/provider transports and the initial catalog are synthetic.
 * This does not claim WeChat-device or real external-provider acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
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
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import { WechatIdentityProvider } from '../../src/identity/wechat-provider.js';
import {
  WECHAT_PHONE_PROVIDER,
  WechatPhoneProvider,
} from '../../src/verification/wechat-phone-provider.js';
import { VerificationRepository } from '../../src/verification/verification.repository.js';
import {
  seedCommunityScope,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

const output = z.strictObject({
  event: z.enum(['checkpoint', 'done', 'failure']),
  name: z.string().optional(),
  accountId: z.string().uuid().optional(),
  otherAccountId: z.string().uuid().optional(),
  adminAccountId: z.string().uuid().optional(),
  created: z
    .array(
      z.strictObject({
        requestId: z.string().uuid(),
        resourceId: z.string().uuid(),
      }),
    )
    .optional(),
  cancelledRequestIds: z.array(z.string().uuid()).optional(),
  loginCalls: z.number().int().optional(),
  requests: z.number().int().optional(),
  requestId: z.string().uuid().optional(),
  message: z.string().optional(),
});
function checkpoint(
  child: ChildProcess,
  expected: string,
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
      } else if (
        parsed.data.event === 'checkpoint'
          ? parsed.data.name === expected
          : parsed.data.event === expected
      ) {
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
  'emitted native school administrator policy to unverified user post/comment/reply and immediate disable',
  { timeout: 180000 },
  async (t) => {
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
      const providerCalls = { login: 0, token: 0, phone: 0 };
      const providerTransport: typeof fetch = async (request, init) => {
        assert.ok(request instanceof URL);
        assert.equal(request.origin, 'https://api.weixin.qq.com');
        assert.equal(init?.redirect, 'error');
        if (request.pathname === '/sns/jscode2session') {
          assert.equal(init.method, 'GET');
          assert.equal(request.searchParams.get('appid'), config.WECHAT_APP_ID);
          const code = request.searchParams.get('js_code');
          assert.ok(
            [
              'synthetic-journey-login-admin',
              'synthetic-journey-login-owner',
              'synthetic-journey-login-other',
            ].includes(code!),
          );
          providerCalls.login++;
          return Response.json({
            openid: code,
            session_key: 'A'.repeat(22) + '==',
          });
        }
        if (request.pathname === '/cgi-bin/token') {
          assert.equal(init.method, 'GET');
          assert.equal(request.searchParams.get('appid'), config.WECHAT_APP_ID);
          providerCalls.token++;
          return Response.json({
            access_token: 'synthetic-journey-token',
            expires_in: 7200,
          });
        }
        assert.equal(request.pathname, '/wxa/business/getuserphonenumber');
        assert.equal(init.method, 'POST');
        assert.equal(
          request.searchParams.get('access_token'),
          'synthetic-journey-token',
        );
        assert.deepEqual(JSON.parse(String(init.body)), {
          code: 'synthetic-journey-explicit-phone-code',
        });
        providerCalls.phone++;
        return Response.json({
          errcode: 0,
          phone_info: {
            phoneNumber: '+15555550199',
            purePhoneNumber: '5555550199',
            countryCode: '1',
            watermark: {
              timestamp: Math.floor(Date.now() / 1000),
              appid: config.WECHAT_APP_ID,
            },
          },
        });
      };
      // Keep the real adapters and owner services; substitute only their external
      // HTTP transport. There is no runtime test route or artificial account grant.
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue(new WechatIdentityProvider(config, providerTransport))
        .overrideProvider(WECHAT_PHONE_PROVIDER)
        .useValue(new WechatPhoneProvider(config, providerTransport))
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      const port = Number(new URL(await app.getUrl()).port);
      const records = new VerificationRepository();
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      );
      child = fork(
        fileURLToPath(
          new URL(
            '../support/school-posting-policy-native-worker.mjs',
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
      const phases = [
        'admin-login',
        'policy-published',
        'user-phone',
        'post-review',
        'comment-review',
        'reply-review',
        'old-policy-review',
        'policy-revised-allowed',
        'revision-retry-denied',
        'closing-policy-review',
        'policy-disabled',
        'user-denied',
      ];
      let expected = checkpoint(child, phases[0]!);
      child.send({ port, home: scope.home, foreign: scope.foreign });
      let adminAccountId = '',
        accountId = '',
        firstRevisionId = '',
        currentRevisionId = '',
        oldDigest = '';
      for (let index = 0; index < phases.length; index++) {
        const name = phases[index]!;
        await t.test(name, async () => {
          const result = await expected;
          assert.ok(result.accountId);
          if (name === 'admin-login') {
            adminAccountId = result.accountId;
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic emitted policy journey')`,
                [randomUUID(), adminAccountId, scope.home.regionId],
              ),
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.region_policy_heads',
                )
              ).rowCount,
              0,
            );
          } else if (name === 'policy-published') {
            assert.equal(result.accountId, adminAccountId);
            assert.ok(result.requestId);
            const row = (
              await pool.query(
                'SELECT * FROM whaleu_community.region_policy_commands WHERE actor_id=$1 AND client_request_id=$2',
                [adminAccountId, result.requestId],
              )
            ).rows;
            assert.equal(row.length, 1);
            assert.equal(row[0].revision, 1);
            firstRevisionId = row[0].revision_id;
            currentRevisionId = firstRevisionId;
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.region_policy_revisions',
                )
              ).rowCount,
              1,
            );
          } else {
            accountId ||= result.accountId;
            assert.equal(result.accountId, accountId);
            assert.notEqual(accountId, adminAccountId);
          }
          if (name === 'user-phone') {
            assert.deepEqual(
              (await inTransaction(pool, (tx) => records.read(accountId, tx)))
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
                  [accountId],
                )
              ).rowCount,
              0,
            );
            assert.equal(providerCalls.phone, 1);
            await inTransaction(pool, (tx) =>
              operator.run(
                {
                  command: 'init-policy',
                  basis:
                    'Explicit disposable local Review for emitted school policy journey',
                },
                tx,
              ),
            );
          }
          if (name.endsWith('-review')) {
            assert.ok(result.requestId);
            const row = (
              await pool.query<{
                digest: string;
                envelope: { scope: { configurationRevisionId: string } };
              }>(
                'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                [accountId, result.requestId],
              )
            ).rows[0];
            assert.ok(row);
            assert.equal(
              row.envelope.scope.configurationRevisionId,
              currentRevisionId,
            );
            if (
              name === 'old-policy-review' ||
              name === 'closing-policy-review'
            )
              oldDigest = row.digest;
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
                  [accountId, result.requestId],
                )
              ).rowCount,
              0,
            );
            await inTransaction(pool, (tx) =>
              operator.run(
                {
                  command: 'decide',
                  accountId,
                  requestId: result.requestId!,
                  digest: row.digest,
                  decision: 'allow',
                  basis: 'Explicit review of exact synthetic native page text',
                },
                tx,
              ),
            );
          }
          if (name === 'policy-revised-allowed') {
            const policy = (
              await pool.query(
                'SELECT p.* FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON p.id=h.revision_id WHERE h.region_id=$1',
                [scope.home.regionId],
              )
            ).rows[0];
            assert.equal(policy.revision, 2);
            assert.equal(policy.unverified_post_enabled, true);
            assert.equal(policy.unverified_comment_enabled, true);
            assert.deepEqual(policy.unverified_categories, ['discussion']);
            currentRevisionId = policy.id;
          }
          if (name === 'revision-retry-denied') {
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2 AND receipt IS NOT NULL',
                  [accountId, result.requestId],
                )
              ).rowCount,
              0,
            );
            const old = (
              await pool.query(
                'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                [accountId, result.requestId],
              )
            ).rows[0];
            assert.equal(old.digest, oldDigest);
            assert.equal(
              old.envelope.scope.configurationRevisionId,
              firstRevisionId,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
                  [accountId, result.requestId],
                )
              ).rowCount,
              1,
            );
          }
          if (name === 'policy-disabled') {
            assert.equal(result.adminAccountId, adminAccountId);
            const policy = (
              await pool.query(
                'SELECT p.* FROM whaleu_community.region_policy_heads h JOIN whaleu_community.region_policy_revisions p ON p.id=h.revision_id WHERE h.region_id=$1',
                [scope.home.regionId],
              )
            ).rows[0];
            assert.equal(policy.revision, 3);
            assert.equal(policy.unverified_post_enabled, false);
            assert.equal(policy.unverified_comment_enabled, false);
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.region_policy_commands WHERE actor_id=$1',
                  [adminAccountId],
                )
              ).rowCount,
              3,
            );
            const old = (
              await pool.query(
                'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                [accountId, result.requestId],
              )
            ).rows[0];
            assert.equal(old.digest, oldDigest);
            assert.equal(
              old.envelope.scope.configurationRevisionId,
              currentRevisionId,
            );
          }
          if (result.created) {
            assert.equal(result.created.length, 3);
            for (const item of result.created) {
              const receipt = (
                await pool.query(
                  'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
                  [accountId, item.requestId],
                )
              ).rows[0]?.receipt;
              assert.equal(receipt?.outcome, 'created');
              assert.equal(receipt.resourceId, item.resourceId);
            }
          }
          if (name === 'user-denied') {
            assert.ok(result.requestId);
            const original = (
              await pool.query(
                'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
                [accountId, result.requestId],
              )
            ).rows[0]?.receipt;
            assert.deepEqual(original, {
              requestId: result.requestId,
              operation: 'publish_post',
              outcome: 'rejected',
              code: 'STUDENT_VERIFICATION_REQUIRED',
            });
            const old = (
              await pool.query(
                'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                [accountId, result.requestId],
              )
            ).rows[0];
            assert.equal(old.digest, oldDigest);
            assert.equal(
              old.envelope.scope.configurationRevisionId,
              currentRevisionId,
            );

            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
                  [accountId, result.requestId],
                )
              ).rowCount,
              0,
              'A terminal rejection is not fabricated as a cancellation',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_community.posts WHERE account_id=$1',
                  [accountId],
                )
              ).rowCount,
              1,
            );
            assert.deepEqual(providerCalls, { login: 6, token: 1, phone: 1 });
          }
          expected = checkpoint(child!, phases[index + 1] ?? 'done');
          child!.send({ event: 'continue', name });
        });
      }
      const done = await expected;
      assert.equal(done.loginCalls, 6);
      assert.ok(done.requests! > 30);
      assert.equal(await exited, 0);
      t.diagnostic(
        `Emitted native policy journey: ${done.requests} HTTP calls; real admin save/recovery and disable; new user login/phone; exact Review post/comment/reply; old approval refused without content loss.`,
      );
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
