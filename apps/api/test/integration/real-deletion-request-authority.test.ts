import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureHttp } from '../../src/http/http.js';
import { Pool, type PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { ApplicationError } from '../../src/http/application-error.js';
import {
  checkpointTransactionDeadlines,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  restoreTransactionDeadlines,
  type RequiredTransactionProof,
} from '../../src/database/transaction-deadlines.js';
import { AppLogger } from '../../src/observability/logger.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { WechatIdentityProvider } from '../../src/identity/wechat-provider.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { ProviderIdentityDigests } from '../../src/identity/registration/digests.js';
import { PersonalTimetableRepository } from '../../src/personal-timetable/repository.js';
import { PersonalTimetableService } from '../../src/personal-timetable/service.js';
import type { TimetableCommand } from '../../src/personal-timetable/contracts.js';
import { RealDeletionService } from '../../src/account-deletion/real/service.js';
import { REAL_DELETION_CONSENT } from '../../src/account-deletion/real/contracts.js';
import { RequestProviderReauthentication } from '../../src/account-deletion/real/reauthentication.js';
import { inspectPreparationSchema } from '../../src/account-deletion/real/qualification.js';
import { inspectRequestSchema } from '../../src/account-deletion/real/request-qualification.js';
import { inspectNativeBirthShape } from '../../src/account-deletion/real/native-birth-shape.js';
import {
  acceptedRequestReceipt,
  beginRealReauthentication,
  cancelRealRequest,
  commitRealAcceptance,
} from '../../src/account-deletion/real/request-repository.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  admitLocalRequestValidation,
  installLocalRequestValidation,
  inspectLocalRequestValidation,
} from '../support/real-request-local-validation.js';

const appCode = (code: string) => (e: unknown) =>
  e instanceof ApplicationError && e.code === code;
const sqlCode = (code: string) => (e: unknown) =>
  e instanceof Error && 'code' in e && e.code === code;
const secret = () => 'wu_dr_' + randomBytes(32).toString('base64url');

// These barriers observe actual managed transactions, not Promise scheduling.
// Watchdogs bound test orchestration only; no runtime timeout/budget is relaxed.
function signal<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 4000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function outcome<T>(promise: Promise<T>) {
  // Install the rejection observer before any competing operation is started.
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}
function finalProofBarrier() {
  const reached = signal<number>();
  const release = signal<void>();
  const proof: RequiredTransactionProof<string> = {
    maximumFacts: 1,
    failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
    validate: async (facts, tx) => {
      assert.equal(facts.length, 1);
      const pid = (
        await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0]!.pid;
      reached.resolve(pid);
      await bounded(
        release.promise,
        'Managed final-proof barrier was not released',
      );
    },
  };
  return {
    reached: reached.promise,
    release: () => release.resolve(),
    retain(tx: PoolClient, key: string) {
      // Registered LAST, so every real owner validator has already succeeded
      // when reached resolves. The wrapper still owns the final clock check.
      enableRequiredTransactionProof(tx, proof);
      registerRequiredTransactionFact(tx, proof, key, key);
    },
  };
}
async function waitUntilSqlDeadline(tx: PoolClient, exact: string) {
  const before = (
    await tx.query<{ live: boolean }>(
      'SELECT $1::timestamptz>clock_timestamp() live',
      [exact],
    )
  ).rows[0]!;
  assert.equal(before.live, true, 'Constructed boundary must still be live');
  await tx.query(
    'SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp()))::double precision+0.02)',
    [exact],
  );
  assert.equal(
    (
      await tx.query<{ expired: boolean }>(
        'SELECT $1::timestamptz<=clock_timestamp() expired',
        [exact],
      )
    ).rows[0]!.expired,
    true,
  );
}
async function assertExactBoundary(tx: PoolClient, exact: string) {
  // SQL arithmetic only. This is an exact before/equal/after comparison, not a
  // claim that a wall-clock request landed on one particular microsecond.
  assert.deepEqual(
    (
      await tx.query(
        `SELECT $1::timestamptz > $1::timestamptz-interval '1 microsecond' before,
      $1::timestamptz <= $1::timestamptz equal,
      $1::timestamptz <= $1::timestamptz+interval '1 microsecond' after`,
        [exact],
      )
    ).rows[0],
    { before: true, equal: true, after: true },
  );
}

test(
  '0182 actual real-account request core, isolated local-validation authority only; production activation remains unavailable',
  { timeout: 180000 },
  async (t) => {
    const connection = process.env['TEST_DATABASE_URL'];
    assert(
      connection,
      'Fresh disposable loopback database required, never skip',
    );
    const url = new URL(connection);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connection,
      PG_SSL_MODE: 'disable',
      PG_POOL_MAX: '5',
      LOG_LEVEL: 'silent',
      REAL_ACCOUNT_DELETION_ENTRY: 'prepare_only',
      WECHAT_APP_ID: 'wx0123456789abcdef',
      WECHAT_APP_SECRET: 'local-disposable-provider-adapter-only',
      AUTH_RATE_LIMIT_KEY: '01'.repeat(32),
    });
    const pool = new Pool(poolOptions(config)),
      db = new DatabaseService(config, new AppLogger(config)),
      identities = new IdentityRepository(db, config);
    let providerCalls = 0;
    const provider = new WechatIdentityProvider(
      config,
      async (address, options) => {
        providerCalls++;
        assert.equal(
          new URL(String(address)).origin,
          'https://api.weixin.qq.com',
        );
        assert.equal(options?.redirect, 'error');
        return new Response(
          JSON.stringify({
            openid: 'local-real-request-a',
            session_key: Buffer.alloc(16).toString('base64'),
          }),
          { status: 200 },
        );
      },
    );
    const identity = new IdentityService(provider, identities),
      service = new RealDeletionService(config, db, identity);
    const reauth = new RequestProviderReauthentication(
      provider,
      new ProviderIdentityDigests({
        version: 1,
        activeEpoch: 'local-two',
        keys: [
          { epoch: 'local-one', keyHex: '02'.repeat(32) },
          { epoch: 'local-two', keyHex: '03'.repeat(32) },
        ],
      }),
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
      assert(locked);
      assert(
        supportedPostgresVersion(
          (
            await suite.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await suite.query<{ n: number }>(
            'SELECT count(*)::integer n FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [['whaleu_local_request_validation', ...migrationSchemaNames]],
          )
        ).rows[0]!.n,
        0,
        'Never touch existing schemas',
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      const access = mintToken('access'),
        refresh = mintToken('refresh'),
        otherAccess = mintToken('access');
      const a = await identities.createSession(
        {
          provider: 'wechat',
          appId: config.WECHAT_APP_ID!,
          subject: 'local-real-request-a',
        },
        { access: hashToken(access), refresh: hashToken(refresh) },
      );
      const b = await identities.createSession(
        {
          provider: 'wechat',
          appId: config.WECHAT_APP_ID!,
          subject: 'local-real-request-b',
        },
        {
          access: hashToken(otherAccess),
          refresh: hashToken(mintToken('refresh')),
        },
      );
      const birthScope = {
        accountId: a.accountId,
        sessionId: a.sessionId,
        appId: config.WECHAT_APP_ID!,
        subject: 'local-real-request-a',
      };
      const command = {
        version: 1 as const,
        intentId: randomUUID(),
        expectedGeneration: '0',
        consent: REAL_DELETION_CONSENT,
        recoverySecret: secret(),
        code: 'local-code-not-persisted',
      };
      const { code: unused, ...prepare } = command;
      assert(unused);
      await service.prepare(access, prepare);
      const timetable = new PersonalTimetableService(
        db,
        identity,
        new PersonalTimetableRepository(),
      );
      const bCommand: TimetableCommand = {
        version: 1,
        requestId: randomUUID(),
        termId: randomUUID(),
        operation: 'term.create',
        expectedRevision: 0,
        payload: {
          name: 'B existing private history',
          weekOneMonday: '2026-10-19',
          weekCount: 16,
          timeZone: 'Asia/Shanghai',
        },
      };
      const bReceipt = await timetable.execute(otherAccess, bCommand);
      assert.equal(bReceipt.outcome, 'applied');
      const bBefore = (
        await pool.query(
          `SELECT jsonb_build_object('account',(SELECT to_jsonb(x) FROM whaleu_identity.accounts x WHERE id=$1),'terms',(SELECT jsonb_agg(to_jsonb(x)) FROM whaleu_timetable.terms x WHERE account_id=$1),'commands',(SELECT jsonb_agg(to_jsonb(x)) FROM whaleu_timetable.commands x WHERE account_id=$1)) value`,
          [b.accountId],
        )
      ).rows;
      await t.test(
        'real native A has13 birth rows despite B real Timetable history; this is not full-owner admission',
        async () => {
          const shape = await db.transaction(
            (tx) => inspectNativeBirthShape(tx, birthScope),
            { isolationLevel: 'read committed' },
          );
          assert.equal(shape.rows, 13);
          assert.equal(shape.requiresCompleteOwnerCoverage, true);
          await inTransaction(pool, inspectRequestSchema);
          assert.equal(providerCalls, 0);
        },
      );
      await t.test(
        'production HTTP service remains closed and never consumes a provider code',
        async () => {
          await assert.rejects(
            service.accept(command),
            appCode('REAL_DELETION_UNAVAILABLE'),
          );
          assert.equal(providerCalls, 0);
        },
      );
      await t.test(
        'unqualified epoch advance and invented admission receipt cannot authorize real request',
        async () => {
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1',
                [a.accountId],
              ),
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                `INSERT INTO whaleu_real_deletion_admission.receipts(request_id,account_id,generation,previous_epoch,owner_revision,owner_evidence,reader_revision,reader_evidence,valid_until) VALUES($1,$2,1,0,'invented',$3,'invented',$3,clock_timestamp()+interval '1 minute')`,
                [command.intentId, a.accountId, '0'.repeat(64)],
              ),
            ),
            sqlCode('23514'),
          );
        },
      );
      await t.test(
        'unknown request function drift is rejected by actual schema seal',
        async () => {
          const rollback = new Error('rollback-local-catalog-probe');
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await tx.query(
                'CREATE FUNCTION whaleu_real_deletion.unknown_owner() RETURNS integer LANGUAGE sql AS $$SELECT 1$$',
              );
              await assert.rejects(
                inspectRequestSchema(tx),
                appCode('REAL_DELETION_UNAVAILABLE'),
              );
              throw rollback;
            }),
            (e) => e === rollback,
          );
          await inTransaction(pool, inspectRequestSchema);
        },
      );
      await inTransaction(pool, installLocalRequestValidation);
      await t.test(
        'test-only authority is explicit and independently sealed, not a production-mode flag',
        async () => {
          await inTransaction(pool, inspectRequestSchema);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_real_deletion.requests',
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'full AcceptDeletion projects exact intent and rejects changed generation, capability and intent without an attempt',
        async () => {
          for (const altered of [
            { ...command, expectedGeneration: '1' },
            { ...command, recoverySecret: secret() },
            { ...command, intentId: randomUUID() },
          ])
            await assert.rejects(
              db.transaction(
                (tx) =>
                  beginRealReauthentication(tx, altered, access, identity),
                { isolationLevel: 'read committed' },
              ),
              appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
            );
          for (const altered of [
            { ...command, consent: 'changed-consent' },
            { ...command, version: 2 },
            { ...command, authority: true },
          ])
            await assert.rejects(
              db.transaction(
                (tx) =>
                  beginRealReauthentication(tx, altered, access, identity),
                { isolationLevel: 'read committed' },
              ),
              (error: unknown) =>
                error instanceof Error && error.name === 'ZodError',
            );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_real_deletion.reauthentication_attempts',
              )
            ).rows[0].n,
            0,
          );
          assert.equal(providerCalls, 0);
        },
      );
      const scope = await db.transaction(
        (tx) => beginRealReauthentication(tx, command, access, identity),
        { isolationLevel: 'read committed' },
      );
      assert.equal(scope.requestId, command.intentId);
      assert.equal(scope.generation, '1');
      const otherIntent = {
        ...command,
        intentId: randomUUID(),
        recoverySecret: secret(),
      };
      const { code: otherCode, ...otherPrepare } = otherIntent;
      assert(otherCode);
      await service.prepare(access, otherPrepare);
      const competing = await db.transaction(
        (tx) => beginRealReauthentication(tx, otherIntent, access, identity),
        { isolationLevel: 'read committed' },
      );
      await t.test(
        'local admission receipt cannot commit without its exact accepted request cause',
        async () => {
          await assert.rejects(
            db.transaction((tx) => admitLocalRequestValidation(tx, scope), {
              isolationLevel: 'read committed',
            }),
            (e) =>
              sqlCode('23514')(e) &&
              e instanceof Error &&
              e.message ===
                'Admission evidence lacks its exact accepted request',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_real_deletion_admission.receipts WHERE request_id=$1',
                [command.intentId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'verified attempt cannot commit detached from exact accepted request',
        async () => {
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_real_deletion.reauthentication_attempts SET verified_at=clock_timestamp(),verification_transaction=pg_current_xact_id() WHERE id=$1',
                [scope.attemptId],
              ),
            ),
            sqlCode('23514'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT verified_at FROM whaleu_real_deletion.reauthentication_attempts WHERE id=$1',
                [scope.attemptId],
              )
            ).rows[0].verified_at,
            null,
          );
        },
      );
      const verified = await reauth.exchange(command.code, scope);
      const accepted = await db.transaction(
        async (tx) => {
          await admitLocalRequestValidation(tx, scope);
          return commitRealAcceptance(
            tx,
            { command, accessHash: hashToken(access), scope, verified },
            reauth,
          );
        },
        { isolationLevel: 'read committed' },
      );
      await t.test(
        'real accepted cause atomically binds request, generation, all digest epochs and monotone revocation',
        async () => {
          assert.equal(accepted.phase, 'cooling');
          assert.equal(accepted.revision, '1');
          assert.deepEqual(
            (
              await pool.query(
                'SELECT lifecycle,lifecycle_generation,session_revocation_epoch,real_deletion_request_id,deletion_request_id FROM whaleu_identity.accounts WHERE id=$1',
                [a.accountId],
              )
            ).rows[0],
            {
              lifecycle: 'cooling',
              lifecycle_generation: '1',
              session_revocation_epoch: '1',
              real_deletion_request_id: command.intentId,
              deletion_request_id: null,
            },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_real_deletion.provider_captures WHERE attempt_id=$1',
                [scope.attemptId],
              )
            ).rows[0].n,
            2,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT extract(epoch FROM cancel_before-accepted_at)::integer seconds FROM whaleu_real_deletion.requests WHERE id=$1',
                [command.intentId],
              )
            ).rows[0].seconds,
            604800,
          );
          assert(!JSON.stringify(accepted).includes(a.accountId));
          assert(!JSON.stringify(accepted).includes(command.recoverySecret));
        },
      );
      await t.test(
        'old access and refresh fail; accepted lost-response recovery needs no further provider code',
        async () => {
          await assert.rejects(
            identity.session(access),
            appCode('SESSION_REVOKED'),
          );
          await assert.rejects(
            identity.refresh(refresh),
            appCode('SESSION_REVOKED'),
          );
          const calls = providerCalls;
          assert.deepEqual(
            await db.transaction(
              (tx) =>
                acceptedRequestReceipt(tx, {
                  ...command,
                  code: 'already-consumed-but-not-used',
                }),
              { isolationLevel: 'read committed' },
            ),
            accepted,
          );
          assert.equal(providerCalls, calls);
        },
      );
      await t.test(
        'previously prepared competing intent cannot consume an already accepted generation',
        async () => {
          const proof = await reauth.exchange(otherIntent.code, competing);
          await assert.rejects(
            db.transaction(
              (tx) =>
                commitRealAcceptance(
                  tx,
                  {
                    command: otherIntent,
                    accessHash: hashToken(access),
                    scope: competing,
                    verified: proof,
                  },
                  reauth,
                ),
              { isolationLevel: 'read committed' },
            ),
            appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_real_deletion.requests WHERE account_id=$1',
                [a.accountId],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      const cancel = {
        intentId: command.intentId,
        recoverySecret: command.recoverySecret,
        commandId: randomUUID(),
        expectedRevision: '1',
        action: 'explicitly-cancel-real-account-deletion-v1' as const,
      };
      const cancelled = await db.transaction(
        (tx) => cancelRealRequest(tx, cancel),
        { isolationLevel: 'read committed' },
      );
      await t.test(
        'purpose-only cancellation restores lifecycle but never lowers epoch or resurrects old credentials',
        async () => {
          assert.equal(cancelled.phase, 'cancelled');
          assert.equal(cancelled.revision, '2');
          assert.deepEqual(
            (
              await pool.query(
                'SELECT lifecycle,lifecycle_generation,session_revocation_epoch FROM whaleu_identity.accounts WHERE id=$1',
                [a.accountId],
              )
            ).rows[0],
            {
              lifecycle: 'active',
              lifecycle_generation: '1',
              session_revocation_epoch: '1',
            },
          );
          await assert.rejects(
            identity.session(access),
            appCode('SESSION_REVOKED'),
          );
          await assert.rejects(
            identity.refresh(refresh),
            appCode('SESSION_REVOKED'),
          );
        },
      );
      await t.test(
        'lost cancellation response replays exact command while conflicts and unknown cancellations do not fake success',
        async () => {
          assert.deepEqual(
            await db.transaction((tx) => cancelRealRequest(tx, cancel), {
              isolationLevel: 'read committed',
            }),
            cancelled,
          );
          await assert.rejects(
            db.transaction(
              (tx) =>
                cancelRealRequest(tx, { ...cancel, expectedRevision: '2' }),
              { isolationLevel: 'read committed' },
            ),
            appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
          );
          await assert.rejects(
            db.transaction(
              (tx) =>
                cancelRealRequest(tx, { ...cancel, commandId: randomUUID() }),
              { isolationLevel: 'read committed' },
            ),
            appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
          );
        },
      );
      const resumedAccess = mintToken('access');
      await t.test(
        'new ordinary session issues current epoch; historical known-token logout remains scoped and idempotent',
        async () => {
          const token = resumedAccess;
          await identities.createSession(
            {
              provider: 'wechat',
              appId: config.WECHAT_APP_ID!,
              subject: 'local-real-request-a',
            },
            {
              access: hashToken(token),
              refresh: hashToken(mintToken('refresh')),
            },
          );
          assert.equal((await identity.session(token)).accountId, a.accountId);
          await identity.logout(access);
          await identity.logout(access);
          assert.equal((await identity.session(token)).accountId, a.accountId);
        },
      );
      await t.test(
        'expired linked cancelled and competing intents do not break new prepare or consume the live budget',
        async () => {
          const rollback = new Error(
            'rollback-expired-linked-preparation-fixture',
          );
          const next = {
            ...prepare,
            intentId: randomUUID(),
            expectedGeneration: '1',
            recoverySecret: secret(),
          };
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              // Rollback-only administrator time fixture, not a new acceptance
              // authority. Preserve exact900-second TTL and every FK/constraint.
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations DISABLE TRIGGER preparation_guard',
              );
              await tx.query(
                "UPDATE whaleu_real_deletion.preparations SET created_at=created_at-interval '16 minutes',expires_at=expires_at-interval '16 minutes' WHERE intent_id=ANY($1::uuid[])",
                [[command.intentId, otherIntent.intentId]],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations ENABLE TRIGGER preparation_guard',
              );
              await tx.query('SET CONSTRAINTS ALL DEFERRED');
              await inspectPreparationSchema(tx);
              const scopedDb = {
                transaction: <T>(work: (client: PoolClient) => Promise<T>) =>
                  work(tx),
              } as DatabaseService;
              const actual = new RealDeletionService(
                config,
                scopedDb,
                identity,
              );
              assert.equal(
                (await actual.prepare(resumedAccess, next)).phase,
                'prepared',
              );
              assert.deepEqual(
                (
                  await tx.query(
                    'SELECT count(*)::integer total,count(*) FILTER(WHERE expires_at>clock_timestamp())::integer live FROM whaleu_real_deletion.preparations WHERE account_id=$1',
                    [a.accountId],
                  )
                ).rows[0],
                { total: 3, live: 1 },
              );
              assert.equal(
                (
                  await tx.query(
                    "SELECT 1 FROM whaleu_real_deletion.requests WHERE id=$1 AND phase='cancelled'",
                    [command.intentId],
                  )
                ).rowCount,
                1,
              );
              assert.equal(
                (
                  await tx.query(
                    'SELECT 1 FROM whaleu_real_deletion.reauthentication_attempts WHERE intent_id=ANY($1::uuid[])',
                    [[command.intentId, otherIntent.intentId]],
                  )
                ).rowCount,
                2,
              );
              throw rollback;
            }),
            (e) => e === rollback,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_real_deletion.preparations WHERE intent_id=$1',
                [next.intentId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'real AppModule HTTP prepares again after cancellation without reviving the old bearer',
        async (ht) => {
          let external = 0;
          ht.mock.method(globalThis, 'fetch', async () => {
            external++;
            throw new Error('External transport forbidden');
          });
          const module = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          }).compile();
          const app = module.createNestApplication();
          configureHttp(app);
          await app.init();
          try {
            const next = {
              ...prepare,
              intentId: randomUUID(),
              expectedGeneration: '1',
              recoverySecret: secret(),
            };
            const response = await request(app.getHttpServer())
              .post('/v1/account-deletion/prepare')
              .set('Authorization', 'Bearer ' + resumedAccess)
              .send(next)
              .expect(200);
            assert.equal(response.body.phase, 'prepared');
            assert.equal(
              response.headers['cache-control'],
              'private, no-store',
            );
            assert.equal(response.body.intentId, next.intentId);
            const status = await request(app.getHttpServer())
              .post('/v1/account-deletion/status')
              .send({
                intentId: next.intentId,
                recoverySecret: next.recoverySecret,
              })
              .expect(200);
            assert.deepEqual(status.body, response.body);
            await request(app.getHttpServer())
              .post('/v1/account-deletion/prepare')
              .set('Authorization', 'Bearer ' + access)
              .send({ ...next, intentId: randomUUID() })
              .expect(401);
            assert.equal(external, 0);
            assert.equal(
              (
                await pool.query(
                  'SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=$1',
                  [a.accountId],
                )
              ).rows[0].session_revocation_epoch,
              '1',
            );
          } finally {
            await app.close();
          }
        },
      );
      await t.test(
        'temporary retained-history guard allows64, rejects65, and ordinary expired unlinked rows reclaim four slots',
        async () => {
          const rollback = new Error('rollback-bounded-retention-fixture');
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              // Data-volume fixture only. Restore the exact guard before either
              // boundary assertion; never disable FK/deferred constraints globally.
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations DISABLE TRIGGER preparation_guard',
              );
              await tx.query(
                `INSERT INTO whaleu_real_deletion.preparations(intent_id,account_id,session_id,app_id,base_generation,next_generation,intent_hash,recovery_hash,consent,created_at,expires_at,created_transaction)
              SELECT gen_random_uuid(),$1,$2,$3,0,1,$4,$4,$5,statement_timestamp()-interval '16 minutes',statement_timestamp()-interval '1 minute',pg_current_xact_id() FROM generate_series(1,63)`,
                [
                  b.accountId,
                  b.sessionId,
                  config.WECHAT_APP_ID,
                  '0'.repeat(64),
                  REAL_DELETION_CONSENT,
                ],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations ENABLE TRIGGER preparation_guard',
              );
              await tx.query('SET CONSTRAINTS ALL DEFERRED');
              await inspectPreparationSchema(tx);
              const insert = `INSERT INTO whaleu_real_deletion.preparations(intent_id,account_id,session_id,app_id,base_generation,next_generation,intent_hash,recovery_hash,consent,created_at,expires_at,created_transaction)
              VALUES(gen_random_uuid(),$1,$2,$3,0,1,$4,$4,$5,clock_timestamp(),clock_timestamp(),pg_current_xact_id())`;
              const values = [
                b.accountId,
                b.sessionId,
                config.WECHAT_APP_ID,
                '0'.repeat(64),
                REAL_DELETION_CONSENT,
              ];
              await tx.query(insert, values);
              assert.equal(
                (
                  await tx.query(
                    'SELECT count(*)::integer n FROM whaleu_real_deletion.preparations WHERE account_id=$1',
                    [b.accountId],
                  )
                ).rows[0].n,
                64,
              );
              await tx.query('SAVEPOINT sixty_fifth');
              await assert.rejects(
                tx.query(insert, values),
                (e) =>
                  sqlCode('23514')(e) &&
                  e instanceof Error &&
                  e.message ===
                    'Real preparation retained-history budget exhausted',
              );
              await tx.query('ROLLBACK TO SAVEPOINT sixty_fifth');
              const scopedDb = {
                transaction: <T>(work: (client: PoolClient) => Promise<T>) =>
                  work(tx),
              } as DatabaseService;
              const actual = new RealDeletionService(
                config,
                scopedDb,
                identity,
              );
              assert.equal(
                (
                  await actual.prepare(otherAccess, {
                    ...prepare,
                    intentId: randomUUID(),
                    recoverySecret: secret(),
                  })
                ).phase,
                'prepared',
              );
              assert.equal(
                (
                  await tx.query(
                    'SELECT count(*)::integer n FROM whaleu_real_deletion.preparations WHERE account_id=$1',
                    [b.accountId],
                  )
                ).rows[0].n,
                61,
              );
              throw rollback;
            }),
            (e) => e === rollback,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_real_deletion.preparations WHERE account_id=$1',
                [b.accountId],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'B actual private history, original receipt and identity remain unchanged',
        async () => {
          assert.deepEqual(
            await timetable.execute(otherAccess, bCommand),
            bReceipt,
          );
          assert.deepEqual(
            (
              await pool.query(
                `SELECT jsonb_build_object('account',(SELECT to_jsonb(x) FROM whaleu_identity.accounts x WHERE id=$1),'terms',(SELECT jsonb_agg(to_jsonb(x)) FROM whaleu_timetable.terms x WHERE account_id=$1),'commands',(SELECT jsonb_agg(to_jsonb(x)) FROM whaleu_timetable.commands x WHERE account_id=$1)) value`,
                [b.accountId],
              )
            ).rows,
            bBefore,
          );
          assert.equal(
            (await identity.session(otherAccess)).accountId,
            b.accountId,
          );
        },
      );
      await t.test(
        'local-validation execution does not activate production routes or emit completion registration guards',
        async () => {
          await assert.rejects(
            service.accept(command),
            appCode('REAL_DELETION_UNAVAILABLE'),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer n FROM whaleu_real_deletion.requests WHERE phase NOT IN('cooling','cancelled')",
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_identity.registration_guards',
              )
            ).rows[0].n,
            0,
          );
        },
      );

      // Every fixture below is a fresh account in this disposable cluster, with
      // an adapter-local provider response. No production admission is installed.
      const newFixture = async () => {
        const subject = `local-boundary-${randomUUID()}`;
        const fixtureAccess = mintToken('access');
        const fixtureRefresh = mintToken('refresh');
        const session = await identities.createSession(
          { provider: 'wechat', appId: config.WECHAT_APP_ID!, subject },
          {
            access: hashToken(fixtureAccess),
            refresh: hashToken(fixtureRefresh),
          },
        );
        const fixtureProvider = new WechatIdentityProvider(
          config,
          async (address) => {
            assert.equal(
              new URL(String(address)).origin,
              'https://api.weixin.qq.com',
            );
            return new Response(
              JSON.stringify({
                openid: subject,
                session_key: Buffer.alloc(16).toString('base64'),
              }),
              { status: 200 },
            );
          },
        );
        const fixtureReauth = new RequestProviderReauthentication(
          fixtureProvider,
          new ProviderIdentityDigests({
            version: 1,
            activeEpoch: 'local-two',
            keys: [
              { epoch: 'local-one', keyHex: '02'.repeat(32) },
              { epoch: 'local-two', keyHex: '03'.repeat(32) },
            ],
          }),
        );
        const prepareAttempt = async () => {
          const fixtureCommand = {
            ...command,
            intentId: randomUUID(),
            recoverySecret: secret(),
          };
          const { code: providerCode, ...preparation } = fixtureCommand;
          assert(providerCode);
          await service.prepare(fixtureAccess, preparation);
          const fixtureScope = await db.transaction(
            (tx) =>
              beginRealReauthentication(
                tx,
                fixtureCommand,
                fixtureAccess,
                identity,
              ),
            { isolationLevel: 'read committed' },
          );
          return { command: fixtureCommand, scope: fixtureScope };
        };
        const prepared = await prepareAttempt();
        return {
          ...prepared,
          accountId: session.accountId,
          sessionId: session.sessionId,
          access: fixtureAccess,
          refresh: fixtureRefresh,
          provider: fixtureProvider,
          reauth: fixtureReauth,
          prepareAttempt,
        };
      };
      type Fixture = Awaited<ReturnType<typeof newFixture>>;
      const acceptFixture = async (
        fixture: Fixture,
        barrier?: ReturnType<typeof finalProofBarrier>,
      ) => {
        const verified = await fixture.reauth.exchange(
          fixture.command.code,
          fixture.scope,
        );
        return db.transaction(
          async (tx) => {
            await admitLocalRequestValidation(tx, fixture.scope);
            const receipt = await commitRealAcceptance(
              tx,
              {
                command: fixture.command,
                accessHash: hashToken(fixture.access),
                scope: fixture.scope,
                verified,
              },
              fixture.reauth,
            );
            barrier?.retain(tx, fixture.command.intentId);
            return receipt;
          },
          { isolationLevel: 'read committed' },
        );
      };
      const cancellation = (fixture: Fixture) => ({
        intentId: fixture.command.intentId,
        recoverySecret: fixture.command.recoverySecret,
        commandId: randomUUID(),
        expectedRevision: '1',
        action: 'explicitly-cancel-real-account-deletion-v1' as const,
      });
      const snapshot = async (fixture: Fixture) =>
        (
          await pool.query(
            `SELECT jsonb_build_object(
          'account',(SELECT to_jsonb(a) FROM whaleu_identity.accounts a WHERE id=$1),
          'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM whaleu_identity.sessions s WHERE account_id=$1),
          'access',(SELECT jsonb_agg(to_jsonb(a) ORDER BY token_hash) FROM whaleu_identity.access_tokens a WHERE session_id=$2),
          'refresh',(SELECT jsonb_agg(to_jsonb(r) ORDER BY token_hash) FROM whaleu_identity.refresh_tokens r WHERE session_id=$2),
          'preparations',(SELECT jsonb_agg(to_jsonb(p) ORDER BY intent_id) FROM whaleu_real_deletion.preparations p WHERE account_id=$1),
          'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_real_deletion.reauthentication_attempts a WHERE account_id=$1),
          'captures',(SELECT jsonb_agg(to_jsonb(c) ORDER BY attempt_id,key_epoch) FROM whaleu_real_deletion.provider_captures c JOIN whaleu_real_deletion.reauthentication_attempts a ON a.id=c.attempt_id WHERE a.account_id=$1),
          'admissions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM whaleu_real_deletion_admission.receipts r WHERE account_id=$1),
          'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM whaleu_real_deletion.requests r WHERE account_id=$1),
          'cancellations',(SELECT jsonb_agg(to_jsonb(c) ORDER BY command_id) FROM whaleu_real_deletion.cancellations c JOIN whaleu_real_deletion.requests r ON r.id=c.request_id WHERE r.account_id=$1)
        ) value`,
            [fixture.accountId, fixture.sessionId],
          )
        ).rows;
      const assertSingleAcceptance = async (fixture: Fixture) => {
        assert.deepEqual(
          (
            await pool.query(
              `SELECT lifecycle,lifecycle_generation,session_revocation_epoch,real_deletion_request_id,
            (SELECT count(*)::integer FROM whaleu_real_deletion.requests WHERE account_id=$1) requests,
            (SELECT count(*)::integer FROM whaleu_real_deletion_admission.receipts WHERE account_id=$1) admissions,
            (SELECT count(*)::integer FROM whaleu_real_deletion.provider_captures c JOIN whaleu_real_deletion.reauthentication_attempts a ON a.id=c.attempt_id WHERE a.account_id=$1) captures
          FROM whaleu_identity.accounts WHERE id=$1`,
              [fixture.accountId],
            )
          ).rows[0],
          {
            lifecycle: 'cooling',
            lifecycle_generation: '1',
            session_revocation_epoch: '1',
            real_deletion_request_id: fixture.command.intentId,
            requests: 1,
            admissions: 1,
            captures: 2,
          },
        );
      };
      await t.test(
        'overlapping accept/accept: an entered competitor cannot cross the held accepting transaction fence',
        async () => {
          const fixture = await newFixture();
          const competitor = await fixture.prepareAttempt();
          const verified = await fixture.reauth.exchange(
            competitor.command.code,
            competitor.scope,
          );
          const barrier = finalProofBarrier();
          let emitted = false;
          const accepting = outcome(
            acceptFixture(fixture, barrier).then((value) => {
              emitted = true;
              return value;
            }),
          );
          let competingResult: ReturnType<typeof outcome> | undefined;
          try {
            await bounded(
              Promise.race([
                barrier.reached,
                accepting.then((result) => {
                  if (!result.ok) throw result.error;
                  throw new Error('Acceptance settled before its barrier');
                }),
              ]),
              'Acceptance did not reach its managed final proof',
            );
            assert.equal(emitted, false);
            let entered = false;
            competingResult = outcome(
              db.transaction(
                async (tx) => {
                  entered = true;
                  assert.equal(
                    emitted,
                    false,
                    'Second transaction must enter before the first commits',
                  );
                  await inspectRequestSchema(tx);
                  await inspectLocalRequestValidation(tx);
                  assert.equal(
                    (
                      await tx.query(
                        'SELECT 1 FROM whaleu_real_deletion.requests WHERE account_id=$1',
                        [fixture.accountId],
                      )
                    ).rowCount,
                    0,
                    'Winning acceptance must still be uncommitted',
                  );
                  return commitRealAcceptance(
                    tx,
                    {
                      command: competitor.command,
                      accessHash: hashToken(fixture.access),
                      scope: competitor.scope,
                      verified,
                    },
                    fixture.reauth,
                  );
                },
                { isolationLevel: 'read committed' },
              ),
            );
            const result = await bounded(
              competingResult,
              'Competing accept failed to fail closed promptly',
            );
            assert.equal(entered, true);
            assert.equal(result.ok, false);
            if (!result.ok)
              assert(appCode('REAL_DELETION_UNAVAILABLE')(result.error));
            assert.equal(
              emitted,
              false,
              'Competing rejection must happen while first accept is held',
            );
          } finally {
            barrier.release();
            await competingResult;
            await accepting;
          }
          const result = await accepting;
          assert(result.ok);
          assert.equal(result.value.phase, 'cooling');
          await assertSingleAcceptance(fixture);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT verified_at,verification_transaction FROM whaleu_real_deletion.reauthentication_attempts WHERE id=$1',
                [competitor.scope.attemptId],
              )
            ).rows[0],
            { verified_at: null, verification_transaction: null },
          );
        },
      );
      await t.test(
        'overlapping accept/refresh: an observed lock waiter sees the committed epoch and never emits rotated credentials',
        async () => {
          const fixture = await newFixture();
          const before = (
            await pool.query(
              `SELECT jsonb_build_object(
            'session',(SELECT to_jsonb(s) FROM whaleu_identity.sessions s WHERE id=$1),
            'access',(SELECT jsonb_agg(to_jsonb(a) ORDER BY token_hash) FROM whaleu_identity.access_tokens a WHERE session_id=$1),
            'refresh',(SELECT jsonb_agg(to_jsonb(r) ORDER BY token_hash) FROM whaleu_identity.refresh_tokens r WHERE session_id=$1)) value`,
              [fixture.sessionId],
            )
          ).rows;
          const entered = signal<number>();
          const observingDb = {
            transaction: <T>(
              work: (tx: PoolClient) => Promise<T>,
              options = {},
            ) =>
              db.transaction(async (tx) => {
                entered.resolve(
                  (
                    await tx.query<{ pid: number }>(
                      'SELECT pg_backend_pid() pid',
                    )
                  ).rows[0]!.pid,
                );
                return work(tx);
              }, options),
          } as DatabaseService;
          const refreshingIdentity = new IdentityService(
            fixture.provider,
            new IdentityRepository(observingDb, config),
          );
          const barrier = finalProofBarrier();
          let acceptedEmitted = false;
          let refreshEmitted = false;
          const accepting = outcome(
            acceptFixture(fixture, barrier).then((value) => {
              acceptedEmitted = true;
              return value;
            }),
          );
          let refreshing: ReturnType<typeof outcome> | undefined;
          let observing: Promise<void> | undefined;
          let stopObserving = false;
          try {
            const acceptingPid = await bounded(
              Promise.race([
                barrier.reached,
                accepting.then((result) => {
                  if (!result.ok) throw result.error;
                  throw new Error('Acceptance settled before refresh overlap');
                }),
              ]),
              'Acceptance did not reach its final proof',
            );
            refreshing = outcome(
              refreshingIdentity.refresh(fixture.refresh).then((value) => {
                refreshEmitted = true;
                return value;
              }),
            );
            const refreshingPid = await bounded(
              entered.promise,
              'Refresh transaction did not enter',
            );
            assert.notEqual(refreshingPid, acceptingPid);
            // Actual PostgreSQL wait graph is the synchronization witness. An
            // arbitrary sleep or merely starting two Promises is insufficient.
            observing = (async () => {
              const observeUntil = performance.now() + 3000;
              while (!stopObserving) {
                assert(
                  performance.now() < observeUntil,
                  'Refresh lock observation timed out',
                );
                const row = (
                  await pool.query<{
                    blockers: number[];
                    wait_event_type: string | null;
                  }>(
                    'SELECT pg_blocking_pids(pid) blockers,wait_event_type FROM pg_stat_activity WHERE pid=$1',
                    [refreshingPid],
                  )
                ).rows[0];
                if (stopObserving) return;
                if (row?.blockers.includes(acceptingPid)) {
                  assert.equal(row.wait_event_type, 'Lock');
                  return;
                }
                assert.equal(acceptedEmitted, false);
                assert.equal(refreshEmitted, false);
                await delay(10);
              }
            })();
            await bounded(
              observing,
              'Refresh never became an observed waiter on acceptance',
            );
            assert.equal(acceptedEmitted, false);
            assert.equal(refreshEmitted, false);
          } finally {
            // A watchdog does not cancel a pending SQL query. Stop further
            // polling and join the observer before another subtest can start.
            stopObserving = true;
            barrier.release();
            await Promise.all([
              accepting,
              refreshing,
              observing?.catch(() => undefined),
            ]);
          }
          assert((await accepting).ok);
          assert(refreshing);
          const result = await refreshing;
          assert.equal(result.ok, false);
          if (!result.ok) assert(appCode('SESSION_REVOKED')(result.error));
          assert.equal(refreshEmitted, false);
          await assertSingleAcceptance(fixture);
          assert.deepEqual(
            (
              await pool.query(
                `SELECT jsonb_build_object(
            'session',(SELECT to_jsonb(s) FROM whaleu_identity.sessions s WHERE id=$1),
            'access',(SELECT jsonb_agg(to_jsonb(a) ORDER BY token_hash) FROM whaleu_identity.access_tokens a WHERE session_id=$1),
            'refresh',(SELECT jsonb_agg(to_jsonb(r) ORDER BY token_hash) FROM whaleu_identity.refresh_tokens r WHERE session_id=$1)) value`,
                [fixture.sessionId],
              )
            ).rows,
            before,
          );
        },
      );
      await t.test(
        'overlapping cancel/cancel: an entered competitor cannot duplicate closure while exact retry remains recoverable',
        async () => {
          const fixture = await newFixture();
          await acceptFixture(fixture);
          const command = cancellation(fixture);
          const barrier = finalProofBarrier();
          let emitted = false;
          const cancelling = outcome(
            db
              .transaction(
                async (tx) => {
                  const receipt = await cancelRealRequest(tx, command);
                  barrier.retain(tx, command.commandId);
                  return receipt;
                },
                { isolationLevel: 'read committed' },
              )
              .then((value) => {
                emitted = true;
                return value;
              }),
          );
          let competingResult: ReturnType<typeof outcome> | undefined;
          try {
            await bounded(
              Promise.race([
                barrier.reached,
                cancelling.then((result) => {
                  if (!result.ok) throw result.error;
                  throw new Error('Cancellation settled before its barrier');
                }),
              ]),
              'Cancellation did not reach its managed final proof',
            );
            let entered = false;
            competingResult = outcome(
              db.transaction(
                async (tx) => {
                  entered = true;
                  assert.equal(emitted, false);
                  return cancelRealRequest(tx, {
                    ...command,
                    commandId: randomUUID(),
                  });
                },
                { isolationLevel: 'read committed' },
              ),
            );
            const result = await bounded(
              competingResult,
              'Competing cancellation failed to reject promptly',
            );
            assert.equal(entered, true);
            assert.equal(result.ok, false);
            if (!result.ok) assert(sqlCode('55P03')(result.error));
            assert.equal(
              emitted,
              false,
              'Second cancellation must reject before first commits',
            );
          } finally {
            barrier.release();
            await competingResult;
            await cancelling;
          }
          const result = await cancelling;
          assert(result.ok);
          assert.equal(result.value.phase, 'cancelled');
          assert.equal(result.value.revision, '2');
          assert.deepEqual(
            await db.transaction((tx) => cancelRealRequest(tx, command), {
              isolationLevel: 'read committed',
            }),
            result.value,
          );
          assert.deepEqual(
            (
              await pool.query(
                `SELECT a.lifecycle,a.lifecycle_generation,a.session_revocation_epoch,r.phase,r.revision,
            (SELECT count(*)::integer FROM whaleu_real_deletion.cancellations WHERE request_id=r.id) cancellations
          FROM whaleu_identity.accounts a JOIN whaleu_real_deletion.requests r ON r.id=a.real_deletion_request_id WHERE a.id=$1`,
                [fixture.accountId],
              )
            ).rows[0],
            {
              lifecycle: 'active',
              lifecycle_generation: '1',
              session_revocation_epoch: '1',
              phase: 'cancelled',
              revision: '2',
              cancellations: 1,
            },
          );
          await assert.rejects(
            identity.session(fixture.access),
            appCode('SESSION_REVOKED'),
          );
          await assert.rejects(
            identity.refresh(fixture.refresh),
            appCode('SESSION_REVOKED'),
          );
        },
      );
      await t.test(
        'original thirty-second attempt shape and four-live-attempt budget remain enforced',
        async () => {
          const fixture = await newFixture();
          for (let n = 1; n < 4; n++)
            await db.transaction(
              (tx) =>
                beginRealReauthentication(
                  tx,
                  fixture.command,
                  fixture.access,
                  identity,
                ),
              { isolationLevel: 'read committed' },
            );
          const before = await snapshot(fixture);
          assert.deepEqual(
            (
              await pool.query(
                `SELECT count(*)::integer n,bool_and(expires_at=created_at+interval '30 seconds' AND expires_at>clock_timestamp()) exact_live
            FROM whaleu_real_deletion.reauthentication_attempts WHERE account_id=$1`,
                [fixture.accountId],
              )
            ).rows[0],
            { n: 4, exact_live: true },
          );
          await assert.rejects(
            db.transaction(
              (tx) =>
                beginRealReauthentication(
                  tx,
                  fixture.command,
                  fixture.access,
                  identity,
                ),
              { isolationLevel: 'read committed' },
            ),
            (error) =>
              sqlCode('23514')(error) &&
              error instanceof Error &&
              error.message === 'Reauthentication attempt capacity exhausted',
          );
          assert.deepEqual(await snapshot(fixture), before);
        },
      );

      for (const boundary of ['attempt', 'admission'] as const) {
        await t.test(
          `administrator-constructed ${boundary} thirty-second boundary: live acceptance passes every owner proof, then final clock expiry rolls everything back`,
          async () => {
            const fixture = await newFixture();
            const before = await snapshot(fixture);
            const verified = await fixture.reauth.exchange(
              fixture.command.code,
              fixture.scope,
            );
            let preDeadlineControl = false;
            let laterProofReached = false;
            let crossedDeadline = false;
            let emitted = false;
            let exact = '';
            const later: RequiredTransactionProof<string> = {
              maximumFacts: 1,
              failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
              validate: async (facts, tx) => {
                assert.deepEqual(facts, [fixture.command.intentId]);
                // All real validators, including exact current-transaction receipt,
                // provider capture and original session proofs, have passed.
                assert.equal(preDeadlineControl, true);
                assert.equal(
                  (
                    await tx.query<{ current: boolean }>(
                      'SELECT whaleu_real_deletion_admission.current_receipt($1,$2,1,0) current',
                      [fixture.command.intentId, fixture.accountId],
                    )
                  ).rows[0]!.current,
                  true,
                );
                laterProofReached = true;
                await assertExactBoundary(tx, exact);
                await waitUntilSqlDeadline(tx, exact);
                crossedDeadline = true;
              },
            };
            try {
              await assert.rejects(
                db
                  .transaction(
                    async (tx) => {
                      if (boundary === 'attempt') {
                        // Rollback-only administrator timestamp fixture. Preserve the
                        // original 30-second interval and restore before runtime use.
                        await tx.query(
                          'ALTER TABLE whaleu_real_deletion.reauthentication_attempts DISABLE TRIGGER real_attempt_guard',
                        );
                        await tx.query(
                          `UPDATE whaleu_real_deletion.reauthentication_attempts SET created_at=at.value-interval '28 seconds',expires_at=at.value+interval '2 seconds'
                  FROM(SELECT clock_timestamp() value) at WHERE id=$1`,
                          [fixture.scope.attemptId],
                        );
                        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                        await tx.query(
                          'ALTER TABLE whaleu_real_deletion.reauthentication_attempts ENABLE TRIGGER real_attempt_guard',
                        );
                        await tx.query('SET CONSTRAINTS ALL DEFERRED');
                      }
                      await admitLocalRequestValidation(tx, fixture.scope);
                      if (boundary === 'admission') {
                        const original = (
                          await tx.query<{ definition: string }>(
                            "SELECT pg_get_functiondef('whaleu_real_deletion_admission.unavailable()'::regprocedure) definition",
                          )
                        ).rows[0]!.definition;
                        // The receipt has a pending deferred exact-request trigger, so
                        // ALTER TABLE cannot toggle its guard. Replace ONLY this installed
                        // test-local guard for the administrator UPDATE, then restore its
                        // exact definition before any acceptance or validation runs.
                        await tx.query(
                          'CREATE OR REPLACE FUNCTION whaleu_real_deletion_admission.unavailable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN RETURN NEW;END$$',
                        );
                        await tx.query(
                          `UPDATE whaleu_real_deletion_admission.receipts SET created_at=at.value-interval '28 seconds',valid_until=at.value+interval '2 seconds'
                  FROM(SELECT clock_timestamp() value) at WHERE request_id=$1`,
                          [fixture.command.intentId],
                        );
                        await tx.query(original);
                        assert.equal(
                          (
                            await tx.query<{ definition: string }>(
                              "SELECT pg_get_functiondef('whaleu_real_deletion_admission.unavailable()'::regprocedure) definition",
                            )
                          ).rows[0]!.definition,
                          original,
                        );
                      }
                      await inspectLocalRequestValidation(tx);
                      await inspectRequestSchema(tx);
                      const row = (
                        await tx.query<{
                          exact: string;
                          exact_thirty: boolean;
                          live: boolean;
                        }>(
                          boundary === 'attempt'
                            ? "SELECT expires_at::text exact,expires_at=created_at+interval '30 seconds' exact_thirty,expires_at>clock_timestamp() live FROM whaleu_real_deletion.reauthentication_attempts WHERE id=$1"
                            : "SELECT valid_until::text exact,valid_until=created_at+interval '30 seconds' exact_thirty,valid_until>clock_timestamp() live FROM whaleu_real_deletion_admission.receipts WHERE request_id=$1",
                          [
                            boundary === 'attempt'
                              ? fixture.scope.attemptId
                              : fixture.command.intentId,
                          ],
                        )
                      ).rows[0]!;
                      assert.equal(row.exact_thirty, true);
                      assert.equal(row.live, true);
                      exact = row.exact;
                      const tentative = await commitRealAcceptance(
                        tx,
                        {
                          command: fixture.command,
                          accessHash: hashToken(fixture.access),
                          scope: fixture.scope,
                          verified,
                        },
                        fixture.reauth,
                      );
                      assert.equal(tentative.phase, 'cooling');
                      assert.equal(tentative.revision, '1');
                      preDeadlineControl = true;
                      enableRequiredTransactionProof(tx, later);
                      registerRequiredTransactionFact(
                        tx,
                        later,
                        fixture.command.intentId,
                        fixture.command.intentId,
                      );
                      return tentative;
                    },
                    { isolationLevel: 'read committed' },
                  )
                  .then((value) => {
                    emitted = true;
                    return value;
                  }),
                appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
              );
            } finally {
              // runTransaction rolls back DDL and data on every exception, not
              // just the expected expiry. Verify restoration even on failure.
              assert.deepEqual(await snapshot(fixture), before);
              await inTransaction(pool, inspectLocalRequestValidation, {
                isolationLevel: 'read committed',
              });
              await inTransaction(pool, inspectRequestSchema, {
                isolationLevel: 'read committed',
              });
            }
            assert.equal(preDeadlineControl, true);
            assert.equal(
              laterProofReached,
              true,
              'Must not fail at an earlier schema, constraint or owner proof',
            );
            assert.equal(crossedDeadline, true);
            assert.equal(emitted, false);
            assert.equal(
              (await identity.session(fixture.access)).accountId,
              fixture.accountId,
            );
          },
        );
      }
      for (const stage of ['before-mutation', 'after-owner-proofs'] as const) {
        await t.test(
          `administrator-constructed seven-day cancellation boundary ${stage}: original guard and exact final deadline reject without a committed result`,
          async () => {
            const fixture = await newFixture();
            await acceptFixture(fixture);
            const command = cancellation(fixture);
            const before = await snapshot(fixture);
            let preDeadlineControl = false;
            let laterProofReached = false;
            let crossedDeadline = false;
            let emitted = false;
            try {
              await assert.rejects(
                db
                  .transaction(
                    async (tx) => {
                      // Rollback-only administrator fixture, NOT seven days of natural
                      // waiting. Keep the exact604800-second interval and all constraints.
                      // Skip request_apply only for this time-only fixture, so its UPDATE
                      // branch cannot pretend this still-cooling request was cancelled.
                      await tx.query(
                        'ALTER TABLE whaleu_real_deletion.requests DISABLE TRIGGER real_request_guard',
                      );
                      await tx.query(
                        'ALTER TABLE whaleu_real_deletion.requests DISABLE TRIGGER real_request_apply',
                      );
                      await tx.query(
                        `UPDATE whaleu_real_deletion.requests SET accepted_at=at.value-interval '604798 seconds',cancel_before=at.value+interval '2 seconds'
                FROM(SELECT clock_timestamp() value) at WHERE id=$1`,
                        [fixture.command.intentId],
                      );
                      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                      await tx.query(
                        'ALTER TABLE whaleu_real_deletion.requests ENABLE TRIGGER real_request_guard',
                      );
                      await tx.query(
                        'ALTER TABLE whaleu_real_deletion.requests ENABLE TRIGGER real_request_apply',
                      );
                      await tx.query('SET CONSTRAINTS ALL DEFERRED');
                      await inspectRequestSchema(tx);
                      const row = (
                        await tx.query<{
                          exact: string;
                          exact_seven_days: boolean;
                          live: boolean;
                        }>(
                          "SELECT cancel_before::text exact,cancel_before=accepted_at+interval '604800 seconds' exact_seven_days,cancel_before>clock_timestamp() live FROM whaleu_real_deletion.requests WHERE id=$1",
                          [fixture.command.intentId],
                        )
                      ).rows[0]!;
                      assert.equal(row.exact_seven_days, true);
                      assert.equal(row.live, true);
                      await assertExactBoundary(tx, row.exact);
                      const checkpoint = checkpointTransactionDeadlines(tx);
                      if (stage === 'before-mutation')
                        await tx.query('SAVEPOINT predeadline_control');
                      const tentative = await cancelRealRequest(tx, command);
                      assert.equal(tentative.phase, 'cancelled');
                      assert.equal(tentative.revision, '2');
                      preDeadlineControl = true;
                      if (stage === 'before-mutation') {
                        // Prove the restored original guards admit this exact command
                        // while live, then undo only that control and its retained facts.
                        await tx.query(
                          'ROLLBACK TO SAVEPOINT predeadline_control',
                        );
                        restoreTransactionDeadlines(tx, checkpoint);
                        await tx.query('RELEASE SAVEPOINT predeadline_control');
                        await waitUntilSqlDeadline(tx, row.exact);
                        crossedDeadline = true;
                        return cancelRealRequest(tx, command);
                      }
                      const later: RequiredTransactionProof<string> = {
                        maximumFacts: 1,
                        failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
                        validate: async (facts, read) => {
                          assert.deepEqual(facts, [command.commandId]);
                          assert.equal(preDeadlineControl, true);
                          laterProofReached = true;
                          await waitUntilSqlDeadline(read, row.exact);
                          crossedDeadline = true;
                        },
                      };
                      enableRequiredTransactionProof(tx, later);
                      registerRequiredTransactionFact(
                        tx,
                        later,
                        command.commandId,
                        command.commandId,
                      );
                      return tentative;
                    },
                    { isolationLevel: 'read committed' },
                  )
                  .then((value) => {
                    emitted = true;
                    return value;
                  }),
                stage === 'before-mutation'
                  ? (error) =>
                      sqlCode('23514')(error) &&
                      error instanceof Error &&
                      error.message ===
                        'Current cooling scope and exact revision required'
                  : appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
              );
            } finally {
              assert.deepEqual(await snapshot(fixture), before);
              await inTransaction(pool, inspectRequestSchema, {
                isolationLevel: 'read committed',
              });
            }
            assert.equal(preDeadlineControl, true);
            assert.equal(laterProofReached, stage === 'after-owner-proofs');
            assert.equal(crossedDeadline, true);
            assert.equal(emitted, false);
            await assertSingleAcceptance(fixture);
            await assert.rejects(
              identity.session(fixture.access),
              appCode('SESSION_REVOKED'),
            );
            await assert.rejects(
              identity.refresh(fixture.refresh),
              appCode('SESSION_REVOKED'),
            );
          },
        );
      }
      await t.test(
        'concurrency and constructed deadline fixtures still confer no production admission, erasure completion or thirty-day registration guard',
        async () => {
          await assert.rejects(
            service.accept(command),
            appCode('REAL_DELETION_UNAVAILABLE'),
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer n FROM whaleu_real_deletion.requests WHERE phase NOT IN('cooling','cancelled')",
              )
            ).rows[0].n,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer n FROM whaleu_identity.registration_guards',
              )
            ).rows[0].n,
            0,
          );
        },
      );
    } finally {
      await db.onApplicationShutdown();
      if (owns && suite) {
        await suite.query(
          'DROP SCHEMA IF EXISTS whaleu_local_request_validation CASCADE',
        );
        for (const schema of migrationSchemaNames)
          await suite.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      if (locked && suite)
        await suite.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
