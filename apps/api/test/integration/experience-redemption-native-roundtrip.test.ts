import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModuleBuilder } from '@nestjs/testing';
import {
  RedemptionProvider,
  RedemptionAttemptBudget,
  redemptionFingerprints,
} from '../../src/experience/redemption.provider.js';
import { Pool, Client } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { inTransaction, poolOptions } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { AppLogger, createLogger } from '../../src/observability/logger.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { grantSyntheticTitle } from '../support/experience-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  NativeExperienceTransport,
  nativeOrigin,
  memoryStorage,
} from '../support/experience-native-bridge.js';

const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpExperienceGateway,
} = require('../../../wechat/src/experience/gateway.ts');
const {
  createExperienceRuntime,
} = require('../../../wechat/src/experience/runtime.ts');

// These are deliberately public fake canaries, not real legacy redemption material.
const canary = 'SYNTHETIC-only-Redemption-Canary-É-2026';
const alias = 'SYNTHETIC-only-second-code-same-title';
const titleKey = 'redeem_liangchenmeijing';
const base = '/v1/me/experience';

function overrideRedemption(builder: TestingModuleBuilder, provider: unknown) {
  return builder
    .overrideProvider(RedemptionProvider)
    .useValue(provider)
    .overrideProvider(RedemptionAttemptBudget)
    .useValue({
      available: () => true,
      permit: async () => (provider as { permit(): boolean }).permit(),
    });
}
async function syntheticRedemptionFixture(pool: Pool, ...codes: string[]) {
  await inTransaction(pool, async (tx) => {
    const peer = (
      tx as PoolClient & {
        connection?: { stream?: { remoteAddress?: string } };
      }
    ).connection?.stream?.remoteAddress;
    assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(tx.host));
    assert.ok(peer && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer));
    assert.equal(
      (
        await tx.query<{ allowed: boolean }>(
          'SELECT whaleu_experience.synthetic_fixture_allowed() allowed',
        )
      ).rows[0]!.allowed,
      true,
    );
  });
  const keyCanary = 'SYNTHETIC-ONLY-HMAC-KEY-NEVER-PRODUCTION-2026';
  const material = {
    version: 'synthetic_roundtrip_v1',
    key: Buffer.from(keyCanary),
  };
  const fingerprints = new Set(
    codes.map(
      (code) => redemptionFingerprints('fixture', code, material)!.lookup,
    ),
  );
  const state = { enabled: true, keyAvailable: true, allowAttempt: true };
  const provider = {
    available: () => state.enabled,
    permit: () => state.allowAttempt,
    key: (version?: string) =>
      state.keyAvailable && (!version || version === material.version)
        ? material
        : null,
    lookup: async (digest: string) =>
      fingerprints.has(digest) ? titleKey : null,
  };
  return { provider, state, keyCanary };
}

async function waitForBlockedQuery(pool: Pool, fragment: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const waiting = await pool.query<{ n: number }>(
      "SELECT count(*)::integer n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock' AND strpos(query,$1)>0",
      [fragment],
    );
    if (waiting.rows[0]!.n > 0) return;
    await delay(10);
  }
  assert.fail('Expected real PostgreSQL lock wait was not observed');
}

test(
  'real AppModule and native redemption: inactive default, atomic synthetic proof, privacy and recovery',
  { timeout: 180000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Disposable local PostgreSQL required; no silent skips',
    );
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '16',
      EXPERIENCE_PROCESSING: 'manual_only',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let app: INestApplication | undefined, suite: PoolClient | undefined;
    let owns = false,
      locked = false;
    const logs: string[] = [],
      sql: string[] = [];
    const originalQuery = Client.prototype.query;
    // Observe every physical PostgreSQL query, including BEGIN/COMMIT and provider paths.
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      sql.push(JSON.stringify(args.filter((v) => typeof v !== 'function')));
      return Reflect.apply(originalQuery, this, args);
    } as typeof originalQuery;
    const oldOwner = randomUUID(),
      oldSubject = randomUUID();
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true);
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < '0022_'),
        { mode: 'up' },
      );
      await inTransaction(pool, async (tx) => {
        await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
          oldOwner,
        ]);
        await initializeNativeSafetyAccount(oldOwner, tx);
        await tx.query(
          "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-redemption-only',$1,$2)",
          [oldSubject, oldOwner],
        );
      });
      await runMigrations(pool, migrations, { mode: 'up' });
      const start = async (provider?: unknown) => {
        let builder = Test.createTestingModule({
          imports: [AppModule.register(config)],
        });
        // Provider override is filled by the dedicated synthetic fixture contract.
        if (provider) builder = overrideRedemption(builder, provider);
        const module = await builder.compile();
        app = module.createNestApplication({ logger: false });
        Object.defineProperty(app.get(AppLogger), 'structured', {
          value: createLogger('info', {
            write: (line: string) => {
              logs.push(line);
            },
          }),
        });
        configureHttp(app);
        await app.listen(0, '127.0.0.1');
      };
      await start();
      type Credentials = Awaited<ReturnType<typeof createRuntimeActor>>;
      const post = (
        actor: Credentials,
        code: string,
        requestId = randomUUID(),
      ) =>
        request(app!.getHttpServer())
          .post(`${base}/redemptions`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({ requestId, code });
      const get = (actor: Credentials, path: string) =>
        request(app!.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${actor.accessToken}`);
      const actor = await createRuntimeActor(app!);
      const legacyAccess = mintToken('access'),
        legacyRefresh = mintToken('refresh');
      const legacySession = await app!.get(IdentityRepository).createSession(
        {
          provider: 'wechat',
          appId: 'synthetic-redemption-only',
          subject: oldSubject,
        },
        {
          access: hashToken(legacyAccess),
          refresh: hashToken(legacyRefresh),
        },
      );
      const legacy = {
        ...legacySession,
        accessToken: legacyAccess,
        refreshToken: legacyRefresh,
      };
      const experienceSnapshot = async () => {
        const tables = (
          await pool.query<{ table_name: string }>(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='whaleu_experience' ORDER BY table_name",
          )
        ).rows;
        const snapshot: Record<string, unknown> = {};
        for (const { table_name } of tables) {
          assert.match(table_name, /^[a-z_]+$/);
          snapshot[table_name] = (
            await pool.query(
              `SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) row FROM whaleu_experience.${table_name} t) s`,
            )
          ).rows[0]!.rows;
        }
        return snapshot;
      };
      await t.test(
        'normal production wiring is unavailable and read-only; guest denial and exact 17-title metadata',
        async () => {
          const before = await experienceSnapshot();
          assert.equal(
            (await request(app!.getHttpServer()).get(`${base}/redemption`))
              .status,
            401,
          );
          assert.equal(
            (
              await request(app!.getHttpServer())
                .post(`${base}/redemptions`)
                .send({ requestId: randomUUID(), code: canary })
            ).status,
            401,
          );
          const capability = await get(actor, `${base}/redemption`);
          assert.equal(capability.status, 200);
          assert.deepEqual(capability.body, { status: 'unavailable' });
          const unavailable = await post(actor, canary);
          assert.equal(unavailable.status, 503);
          assert.equal(
            unavailable.body.error.code,
            'EXPERIENCE_REDEMPTION_UNAVAILABLE',
          );
          const catalog = await request(app!.getHttpServer()).get(
            '/v1/experience/catalog',
          );
          assert.equal(catalog.body.titles.length, 17);
          assert.deepEqual(
            catalog.body.titles.find(
              (v: { key: string }) => v.key === titleKey,
            ),
            {
              key: titleKey,
              name: '良辰美景',
              kind: 'limited',
              unlockLevel: null,
            },
          );
          assert.ok(!JSON.stringify(catalog.body).includes('role_admin'));
          assert.deepEqual(await experienceSnapshot(), before);
          assert.deepEqual(
            (await get(actor, `${base}/appearance`)).body.titles
              .map((v: { key: string }) => v.key)
              .sort(),
            ['default_jingxiaoyu', 'level_1'],
          );
        },
      );
      // Remaining enabled tests use only an explicit guarded fixture authority.
      const fixture = await syntheticRedemptionFixture(pool, canary, alias);
      await app!.close();
      await start(fixture.provider);
      await t.test(
        'denied attempt budget is nonterminal and consumes no proof',
        async () => {
          const before = await experienceSnapshot();
          fixture.state.allowAttempt = false;
          try {
            const id = randomUUID(),
              response = await post(actor, canary, id);
            assert.equal(response.status, 429);
            assert.equal(
              response.body.error.code,
              'EXPERIENCE_REDEMPTION_RATE_LIMITED',
            );
            assert.equal(
              (await get(actor, `${base}/requests/${id}`)).status,
              404,
            );
            assert.deepEqual(await experienceSnapshot(), before);
          } finally {
            fixture.state.allowAttempt = true;
          }
        },
      );
      await t.test(
        'strict request boundary rejects extra authority, controls and UTF-8 oversize without durable state',
        async () => {
          const before = await experienceSnapshot();
          for (const body of [
            { requestId: randomUUID(), code: '' },
            { requestId: randomUUID(), code: 'a\u0000b' },
            { requestId: randomUUID(), code: 'a\nb' },
            { requestId: randomUUID(), code: '界'.repeat(43) },
            { requestId: randomUUID(), code: canary, ownerId: oldOwner },
            { requestId: randomUUID(), code: canary, titleKey },
            { requestId: 'invalid', code: canary },
          ])
            assert.equal(
              (
                await request(app!.getHttpServer())
                  .post(`${base}/redemptions`)
                  .set('Authorization', `Bearer ${actor.accessToken}`)
                  .send(body)
              ).status,
              400,
            );
          assert.equal(
            (await get(actor, `${base}/redemption?ownerId=${oldOwner}`)).status,
            400,
          );
          assert.equal(
            (await post(actor, canary).query({ titleKey })).status,
            400,
          );
          assert.deepEqual(await experienceSnapshot(), before);
        },
      );
      await t.test(
        'exact-byte invalid results are immutable; fresh grant/replay preserve selection, points and coverage',
        async () => {
          assert.deepEqual((await get(actor, `${base}/redemption`)).body, {
            status: 'available',
          });
          for (const code of [
            canary.toLowerCase(),
            ` ${canary}`,
            `${canary} `,
            canary.normalize('NFD'),
          ]) {
            const id = randomUUID(),
              result = await post(actor, code, id);
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, {
              requestId: id,
              operation: 'redeem_title',
              outcome: 'rejected',
              code: 'EXPERIENCE_REDEMPTION_INVALID',
            });
            assert.deepEqual(
              (await get(actor, `${base}/requests/${id}`)).body,
              result.body,
            );
            assert.equal((await post(actor, canary, id)).status, 409);
          }
          const summary = (await get(actor, base)).body;
          const appearance = (await get(actor, `${base}/appearance`)).body;
          const id = randomUUID(),
            granted = await post(actor, canary, id);
          assert.equal(granted.status, 200);
          assert.deepEqual(granted.body, {
            requestId: id,
            operation: 'redeem_title',
            outcome: 'granted',
            titleKey,
          });
          assert.deepEqual((await post(actor, canary, id)).body, granted.body);
          assert.equal((await post(actor, alias, id)).status, 409);
          assert.equal(
            (
              await request(app!.getHttpServer())
                .post(`${base}/sign-in`)
                .set('Authorization', `Bearer ${actor.accessToken}`)
                .send({ requestId: id })
            ).status,
            409,
          );
          assert.deepEqual((await get(actor, base)).body, summary);
          const after = (await get(actor, `${base}/appearance`)).body;
          for (const key of ['titleKey', 'colorId', 'revision', 'coverage'])
            assert.deepEqual(after[key], appearance[key]);
          assert.equal(
            after.titles.filter((v: { key: string }) => v.key === titleKey)
              .length,
            1,
          );
          const stored = (
            await pool.query(
              'SELECT intent_hash,intent_key_version,receipt FROM whaleu_experience.requests WHERE owner_id=$1 AND request_id=$2',
              [actor.accountId, id],
            )
          ).rows[0]!;
          assert.match(stored.intent_hash, /^[0-9a-f]{64}$/);
          assert.notEqual(
            stored.intent_hash,
            createHash('sha256').update(canary).digest('hex'),
          );
          assert.ok(stored.intent_key_version);
          assert.deepEqual(stored.receipt, granted.body);
        },
      );
      await t.test(
        'parallel codes for one title grant once; shared code grants another owner; receipts are owner scoped',
        async () => {
          const peer = await createRuntimeActor(app!),
            other = await createRuntimeActor(app!);
          const ids = [randomUUID(), randomUUID()];
          const results = await Promise.all([
            post(peer, canary, ids[0]),
            post(peer, alias, ids[1]),
          ]);
          assert.ok(results.every((r) => r.status === 200));
          assert.deepEqual(results.map((r) => r.body.outcome).sort(), [
            'granted',
            'rejected',
          ]);
          assert.equal(
            results.find((r) => r.body.outcome === 'rejected')!.body.code,
            'EXPERIENCE_TITLE_ALREADY_OWNED',
          );
          assert.equal((await post(other, canary)).body.outcome, 'granted');
          assert.equal(
            (await get(other, `${base}/requests/${ids[0]}`)).status,
            404,
          );
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key=$2',
                [peer.accountId, titleKey],
              )
            ).rows[0]!.n,
            1,
          );
          const replayId = randomUUID(),
            fresh = await createRuntimeActor(app!);
          const replay = await Promise.all([
            post(fresh, canary, replayId),
            post(fresh, canary, replayId),
          ]);
          assert.ok(replay.every((r) => r.status === 200));
          assert.deepEqual(replay[0]!.body, replay[1]!.body);
        },
      );
      await t.test(
        'unknown baseline and undated existing ownership survive duplicate rejection',
        async () => {
          await inTransaction(pool, (tx) =>
            grantSyntheticTitle(tx, oldOwner, titleKey, null),
          );
          const before = (await get(legacy, base)).body;
          const owned = (await get(legacy, `${base}/appearance`)).body;
          assert.equal(before.balance, null);
          assert.equal(before.baseline, 'baseline_unknown');
          assert.equal(owned.coverage, 'partial');
          assert.equal(
            owned.titles.find((v: { key: string }) => v.key === titleKey)
              .earnedAt,
            null,
          );
          const result = await post(legacy, canary);
          assert.equal(result.status, 200);
          assert.equal(result.body.code, 'EXPERIENCE_TITLE_ALREADY_OWNED');
          assert.deepEqual((await get(legacy, base)).body, before);
          assert.deepEqual(
            (await get(legacy, `${base}/appearance`)).body,
            owned,
          );
          const proof = (
            await pool.query(
              'SELECT origin,earned_at FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key=$2',
              [oldOwner, titleKey],
            )
          ).rows[0]!;
          assert.deepEqual(proof, {
            origin: 'synthetic_fixture',
            earned_at: null,
          });
        },
      );
      await t.test(
        'new grant does not initialize a legacy balance or promote partial history',
        async () => {
          const newOwner = randomUUID();
          // A synthetic legacy account is explicitly created without the registration initializer.
          await inTransaction(pool, async (tx) => {
            await tx.query(
              'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
              [newOwner],
            );
            await initializeNativeSafetyAccount(newOwner, tx);
            await tx.query(
              "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-redemption-only',$1,$2)",
              [newOwner, newOwner],
            );
          });
          const access = mintToken('access'),
            refresh = mintToken('refresh');
          const session = await app!.get(IdentityRepository).createSession(
            {
              provider: 'wechat',
              appId: 'synthetic-redemption-only',
              subject: newOwner,
            },
            { access: hashToken(access), refresh: hashToken(refresh) },
          );
          const account = {
            ...session,
            accessToken: access,
            refreshToken: refresh,
          };
          const summary = (await get(account, base)).body;
          assert.equal(summary.balance, null);
          assert.equal((await post(account, canary)).body.outcome, 'granted');
          assert.deepEqual((await get(account, base)).body, summary);
          const appearance = (await get(account, `${base}/appearance`)).body;
          assert.equal(appearance.coverage, 'partial');
          assert.equal(appearance.titleKey, null);
          assert.equal(appearance.titles.length, 1);
          assert.equal(appearance.titles[0].key, titleKey);
          assert.ok(appearance.titles[0].earnedAt);
        },
      );
      await t.test(
        'expiry during owner lock wait rolls back decision; revocation during session wait prevents grant',
        async () => {
          const expiring = await createRuntimeActor(app!);
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '450 milliseconds' WHERE token_hash=$1",
            [hashToken(expiring.accessToken)],
          );
          const blocker = await pool.connect();
          await blocker.query('BEGIN');
          try {
            await blocker.query(
              'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
              [expiring.accountId],
            );
            const id = randomUUID();
            const submitted = post(expiring, canary, id).then(
              (response) => response,
            );
            await waitForBlockedQuery(pool, 'whaleu_experience.owners');
            await delay(650);
            await blocker.query('COMMIT');
            assert.equal((await submitted).status, 401);
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_experience.requests WHERE owner_id=$1 AND request_id=$2',
                  [expiring.accountId, id],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key=$2',
                  [expiring.accountId, titleKey],
                )
              ).rowCount,
              0,
            );
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          const revoked = await createRuntimeActor(app!);
          const sessionLock = await pool.connect();
          await sessionLock.query('BEGIN');
          try {
            await sessionLock.query(
              'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR UPDATE',
              [revoked.sessionId],
            );
            const submitted = post(revoked, canary).then(
              (response) => response,
            );
            await waitForBlockedQuery(pool, 'whaleu_identity.sessions');
            await sessionLock.query(
              "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
              [revoked.sessionId],
            );
            await sessionLock.query('COMMIT');
            assert.equal((await submitted).status, 401);
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_experience.redemption_decisions WHERE owner_id=$1',
                  [revoked.accountId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await sessionLock.query('ROLLBACK');
            sessionLock.release();
          }
        },
      );
      const transport = new NativeExperienceTransport(
        Number(new URL(await app!.getUrl()).port),
      );
      const cancel = new Cancellation();
      const makeNative = async (
        credentials?: Credentials,
        savedStorage?: ReturnType<typeof memoryStorage>,
      ) => {
        credentials ??= await createRuntimeActor(app!);
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), credentials);
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, transport, systemClock),
          {
            login: async () => {
              throw new Error('No provider configured');
            },
          },
          systemClock,
        );
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        const storage = savedStorage ?? memoryStorage();
        const identity = {
          credentials,
          sessions,
          auth,
          api,
          storage,
          experience: new HttpExperienceGateway(api),
        };
        return {
          ...identity,
          runtime: createExperienceRuntime(
            identity,
            storage,
            nativeOrigin,
            async () => randomUUID(),
          ),
        };
      };
      const posts = () =>
        transport.exchanges.filter(
          (e) => e.path === `${base}/redemptions` && e.method === 'POST',
        ).length;
      await t.test(
        'lost native response persists only recovery handle; restart recovers GET with provider and keys unavailable',
        async () => {
          const native = await makeNative();
          const before = await native.experience.appearance(cancel);
          transport.dropSuccess = {
            path: `${base}/redemptions`,
            method: 'POST',
          };
          await assert.rejects(native.runtime.redeemTitle(canary));
          const handle = native.runtime.pending.redemption.load(
            native.credentials.accountId,
          );
          assert.ok(handle);
          assert.deepEqual(Object.keys(handle).sort(), [
            'accountId',
            'operation',
            'origin',
            'requestId',
            'version',
          ]);
          assert.ok(
            !JSON.stringify([...native.storage.values]).includes(canary),
          );
          native.runtime.hide();
          native.runtime.dispose();
          fixture.state.enabled = false;
          fixture.state.keyAvailable = false;
          const count = posts();
          const restarted = await makeNative(
            native.credentials,
            native.storage,
          );
          try {
            const result = await restarted.runtime.recoverRedemption();
            assert.deepEqual(result, {
              requestId: handle.requestId,
              operation: 'redeem_title',
              outcome: 'granted',
              titleKey,
            });
            assert.equal(posts(), count);
            assert.equal(
              restarted.runtime.pending.redemption.load(
                native.credentials.accountId,
              ),
              null,
            );
            const after = await restarted.experience.appearance(cancel);
            assert.equal(after.titleKey, before.titleKey);
            assert.equal(after.revision, before.revision);
            assert.ok(
              after.titles.some((v: { key: string }) => v.key === titleKey),
            );
          } finally {
            fixture.state.enabled = true;
            fixture.state.keyAvailable = true;
            restarted.runtime.dispose();
          }
        },
      );
      await t.test(
        'hide clears uncommitted input, recovery reads first, explicit re-entry reuses original handle',
        async () => {
          const native = await makeNative();
          transport.failNext = `${base}/redemptions`;
          await assert.rejects(native.runtime.redeemTitle(canary));
          const handle = native.runtime.pending.redemption.load(
            native.credentials.accountId,
          );
          assert.ok(handle);
          native.runtime.hide();
          native.runtime.dispose();
          const resumed = await makeNative(native.credentials, native.storage);
          const count = posts();
          await assert.rejects(resumed.runtime.recoverRedemption());
          assert.equal(
            posts(),
            count,
            'No blank or remembered code submission after hide',
          );
          assert.deepEqual(
            resumed.runtime.pending.redemption.load(
              native.credentials.accountId,
            ),
            handle,
          );
          const result = await resumed.runtime.recoverRedemption(canary);
          assert.equal(result.requestId, handle.requestId);
          assert.equal(result.outcome, 'granted');
          assert.equal(posts(), count + 1);
          assert.ok(
            !JSON.stringify([...resumed.storage.values]).includes(canary),
          );
          resumed.runtime.dispose();
        },
      );
      await t.test(
        'late native committed response never settles replacement owner recovery journal',
        async () => {
          const native = await makeNative(),
            replacement = await makeNative();
          const held = transport.holdNext(`${base}/redemptions`, 'POST');
          const submitted = native.runtime.redeemTitle(canary).then(
            () => true,
            () => false,
          );
          await held.arrived;
          const original = native.runtime.pending.redemption.load(
            native.credentials.accountId,
          );
          assert.ok(original);
          native.sessions.completeLogin(
            native.sessions.beginLogin(),
            replacement.credentials,
          );
          held.release();
          assert.equal(await submitted, false);
          assert.deepEqual(
            native.runtime.pending.redemption.load(
              native.credentials.accountId,
            ),
            original,
          );
          assert.equal(
            native.runtime.pending.redemption.load(
              replacement.credentials.accountId,
            ),
            null,
          );
          native.runtime.dispose();
          replacement.runtime.dispose();
          const recovered = await makeNative(
            native.credentials,
            native.storage,
          );
          assert.equal(
            (await recovered.runtime.recoverRedemption()).requestId,
            original.requestId,
          );
          recovered.runtime.dispose();
        },
      );
      // Native lifecycle cases added below when the typed runtime contract lands.
      await t.test(
        'SQL, HTTP logs and durable state contain no plaintext code or fake key',
        async () => {
          const persisted = JSON.stringify(await experienceSnapshot());
          for (const secret of [
            canary,
            alias,
            fixture.keyCanary,
            Buffer.from(fixture.keyCanary).toString('hex'),
            JSON.stringify(Array.from(Buffer.from(fixture.keyCanary))),
          ]) {
            assert.ok(
              !sql.join('\n').includes(secret),
              'Plaintext never crosses SQL boundary',
            );
            assert.ok(
              !logs.join('\n').includes(secret),
              'Logs contain metadata only',
            );
            assert.ok(!persisted.includes(secret), 'No plaintext persisted');
          }
        },
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (owns) {
            for (const schema of migrationSchemaNames)
              await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            assert.equal(
              (
                await pool.query<{ n: number }>(
                  "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
                )
              ).rows[0]!.n,
              0,
              'No test schemas remain',
            );
          }
        } finally {
          if (locked)
            await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
              MIGRATION_LOCK[0],
              2,
            ]);
          suite?.release();
          await pool.end();
          Client.prototype.query = originalQuery;
        }
      }
    }
  },
);
