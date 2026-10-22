import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
  type TransactionOptions,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { requireRatingPromotionSession } from '../../src/identity/rating-promotion-session.js';
import { inspectSessionEpochSchema } from '../../src/identity/session-epoch.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { AppLogger } from '../../src/observability/logger.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  rollbackOnly,
  sqlError,
  sqlRejected,
  staleEpoch,
} from '../support/epoch-authority-fixture.js';

const appCode = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const appId = 'wx0123456789abcdef';
const credentials = () => ({
  access: mintToken('access'),
  refresh: mintToken('refresh'),
});
const hashes = (tokens: ReturnType<typeof credentials>) => ({
  access: hashToken(tokens.access),
  refresh: hashToken(tokens.refresh),
});

// Separate from the existing migration/schema suite: every negative below first
// proves the SAME fixture succeeds, then changes only its account epoch.
test(
  '0180 real SQL authority matrix, retained credentials and savepoint final proof',
  { timeout: 240000 },
  async (t) => {
    const connection = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connection,
      'Disposable loopback whaleu_test required; never skip',
    );
    const url = new URL(connection);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connection,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '5',
    });
    const pool = new Pool(poolOptions(config));
    const db = new DatabaseService(config, new AppLogger(config));
    const identity = new IdentityRepository(db, config);
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
      assert.equal(locked, true, 'Another suite owns this disposable database');
      assert.ok(
        supportedPostgresVersion(
          (
            await suite.query<{ version: number }>(
              "SELECT current_setting('server_version_num')::integer version",
            )
          ).rows[0]!.version,
        ),
      );
      assert.equal(
        (
          await suite.query(
            'SELECT 1 FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [migrationSchemaNames],
          )
        ).rowCount,
        0,
        'Never touch an existing app schema',
      );
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert.equal(
        migrations.at(-1)?.name,
        '0180_identity_session_revocation_epoch.sql',
        'This regression is pinned to the unchanged current180 chain',
      );
      owns = true;
      await runMigrations(pool, migrations, { mode: 'up' });
      const tokens = credentials();
      const actor = await identity.createSession(
        { provider: 'wechat', appId, subject: randomUUID() },
        hashes(tokens),
      );
      const grant = randomUUID();
      await withCommunityScopeWriter(pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference,valid_from) VALUES($1,$2,'super_admin',$2,'synthetic:epoch-matrix',clock_timestamp()-interval '1 minute')",
          [grant, actor.accountId],
        ),
      );
      const actorArgs = [actor.accountId, actor.sessionId];
      const tokenArgs = [...actorArgs, hashToken(tokens.access)];
      const predicates = [
        [
          'ratings.target_edit_session_current',
          'SELECT whaleu_ratings.target_edit_session_current($1,$2,clock_timestamp()) valid',
          actorArgs,
        ],
        [
          'identity.course_comment_session',
          'SELECT whaleu_identity.course_comment_session($1,$2,clock_timestamp()) valid',
          actorArgs,
        ],
        [
          'identity.window_rating_session',
          'SELECT whaleu_identity.window_rating_session($1,$2,clock_timestamp()) valid',
          actorArgs,
        ],
        [
          'identity.major_rating_session',
          'SELECT whaleu_identity.major_rating_session($1,$2,clock_timestamp()) valid',
          actorArgs,
        ],
        [
          'profile.moderation_identity_current',
          'SELECT whaleu_profile.moderation_identity_current($1,$2,$3) valid',
          tokenArgs,
        ],
        [
          'profile.self_edit_identity_current',
          'SELECT whaleu_profile.self_edit_identity_current($1,$2,$3) valid',
          tokenArgs,
        ],
        [
          'verification.institutional_session_current',
          'SELECT whaleu_verification.institutional_session_current($1,$2) valid',
          actorArgs,
        ],
        [
          'authorization.school_admin_management_identity',
          'SELECT whaleu_authorization.school_admin_management_identity($1,$2,$3) valid',
          tokenArgs,
        ],
        [
          'safety.account_punishment_identity_current',
          'SELECT whaleu_safety.account_punishment_identity_current($1,$2,$3) valid',
          tokenArgs,
        ],
        [
          'safety.account_appeal_identity_current',
          'SELECT whaleu_safety.account_appeal_identity_current($1,$2,$3) valid',
          tokenArgs,
        ],
      ] as const;
      for (const [name, sql, args] of predicates)
        await t.test(
          `${name}: valid zero epoch -> stale denial -> rollback restores authority`,
          async () => {
            await rollbackOnly(pool, async (tx) => {
              assert.equal(
                (await tx.query<{ valid: boolean }>(sql, [...args])).rows[0]!
                  .valid,
                true,
                `${name} positive control`,
              );
              await staleEpoch(tx, actor.accountId);
              assert.equal(
                (await tx.query<{ valid: boolean }>(sql, [...args])).rows[0]!
                  .valid,
                false,
                `${name} must reject only epoch mismatch`,
              );
            });
            assert.equal(
              (await pool.query<{ valid: boolean }>(sql, [...args])).rows[0]!
                .valid,
              true,
            );
          },
        );
      for (const [name, sql, message, constraint] of [
        [
          'experience maintenance',
          'SELECT whaleu_experience.require_maintenance_authority($1,$2,$3)',
          'Maintenance lacks live global actor authority',
          undefined,
        ],
        [
          'errand management',
          'SELECT whaleu_authorization.require_errand_management_authority($1,$2,$3,NULL)',
          'Errand management lacks live exact actor authority',
          'errand_management_authority_invalid',
        ],
      ] as const)
        await t.test(
          `${name}: current exact grant cannot rescue a stale session`,
          async () => {
            await rollbackOnly(pool, async (tx) => {
              await tx.query(sql, [...actorArgs, grant]);
              await staleEpoch(tx, actor.accountId);
              await sqlRejected(
                tx,
                () => tx.query(sql, [...actorArgs, grant]),
                sqlError(message, constraint),
              );
            });
            await pool.query(sql, [...actorArgs, grant]);
          },
        );
      await t.test(
        'phone claim trigger rejects stale session on an otherwise identical valid reservation',
        async () => {
          const id = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_verification.phone_requests(account_id,request_id,app_id,consent) VALUES($1,$2,$3,'wechat-phone-verification-v1')",
            [actor.accountId, id, appId],
          );
          const claim = (tx: PoolClient) =>
            tx.query(
              "UPDATE whaleu_verification.phone_requests SET state='claimed',base_revision=0,claimed_session_id=$3 WHERE account_id=$1 AND request_id=$2 RETURNING state,claimed_at,claim_deadline",
              [actor.accountId, id, actor.sessionId],
            );
          await rollbackOnly(pool, async (tx) => {
            await tx.query('SAVEPOINT positive_claim');
            const positive = (await claim(tx)).rows[0]!;
            assert.equal(positive.state, 'claimed');
            assert.ok(
              positive.claimed_at instanceof Date &&
                positive.claim_deadline > positive.claimed_at,
            );
            await tx.query('ROLLBACK TO SAVEPOINT positive_claim');
            await tx.query('RELEASE SAVEPOINT positive_claim');
            await staleEpoch(tx, actor.accountId);
            await sqlRejected(
              tx,
              () => claim(tx),
              sqlError('Phone claim is unavailable'),
            );
            assert.equal(
              (
                await tx.query(
                  'SELECT state FROM whaleu_verification.phone_requests WHERE account_id=$1 AND request_id=$2',
                  [actor.accountId, id],
                )
              ).rows[0]!.state,
              'reserved',
            );
          });
        },
      );
      await t.test(
        'retained access and unconsumed refresh cannot mint credentials, consume refresh or extend any lifetime',
        async () => {
          const retained = credentials();
          assert.equal(
            (await identity.rotate(hashToken(tokens.refresh), hashes(retained)))
              .sessionId,
            actor.sessionId,
            'Real zero-epoch rotation succeeds before stale injection',
          );
          assert.equal(
            (await identity.authenticate(hashToken(retained.access))).accountId,
            actor.accountId,
          );
          const snapshot = async () =>
            (
              await pool.query(
                `SELECT to_jsonb(s) session,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY token_hash) FROM whaleu_identity.access_tokens a WHERE a.session_id=s.id) access,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY token_hash) FROM whaleu_identity.refresh_tokens r WHERE r.session_id=s.id) refresh
        FROM whaleu_identity.sessions s WHERE s.id=$1`,
                [actor.sessionId],
              )
            ).rows[0];
          const before = await snapshot();
          const next = credentials();
          // Only transaction entry is adapted to inject a rollback-only fault. All
          // Identity SQL, locks, token writes and final proofs are the real runtime.
          const staleDatabase = {
            transaction: <T>(
              work: (tx: PoolClient) => Promise<T>,
              options?: TransactionOptions,
            ) =>
              db.transaction(async (tx) => {
                await staleEpoch(tx, actor.accountId);
                return work(tx);
              }, options),
          } as DatabaseService;
          const staleIdentity = new IdentityRepository(staleDatabase, config);
          await assert.rejects(
            staleIdentity.authenticate(hashToken(retained.access)),
            appCode('SESSION_REVOKED'),
          );
          await assert.rejects(
            staleIdentity.rotate(hashToken(retained.refresh), hashes(next)),
            appCode('SESSION_REVOKED'),
          );
          assert.deepEqual(
            await snapshot(),
            before,
            'All credential rows and three session lifetimes survive the denied replay unchanged',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_identity.access_tokens WHERE token_hash=$1 UNION ALL SELECT 1 FROM whaleu_identity.refresh_tokens WHERE token_hash=$2',
                [hashToken(next.access), hashToken(next.refresh)],
              )
            ).rowCount,
            0,
          );
          // The exact retained refresh is still usable after rollback, proving it was
          // neither previously consumed nor an unrelated invalid credential fixture.
          assert.equal(
            (await identity.rotate(hashToken(retained.refresh), hashes(next)))
              .sessionId,
            actor.sessionId,
          );
          assert.equal(
            (await identity.authenticate(hashToken(next.access))).accountId,
            actor.accountId,
          );
        },
      );
      await t.test(
        'rating promotion actual admission rejects stale originating interactive session',
        async () => {
          await rollbackOnly(pool, async (tx) => {
            await requireRatingPromotionSession(
              actor.accountId,
              actor.sessionId,
              tx,
            );
            await staleEpoch(tx, actor.accountId);
            await assert.rejects(
              requireRatingPromotionSession(
                actor.accountId,
                actor.sessionId,
                tx,
              ),
              appCode('PROMOTION_SOURCE_CHANGED'),
            );
          });
        },
      );
      await pool.query(
        'CREATE TABLE whaleu_meta.epoch_tentative_effects(id uuid PRIMARY KEY, account_id uuid NOT NULL)',
      );
      for (const kind of ['identity', 'promotion'] as const)
        await t.test(
          `${kind} real final proof survives savepoint lock release and rolls back tentative writes`,
          async () => {
            const freshTokens = credentials();
            const fresh = await identity.createSession(
              { provider: 'wechat', appId, subject: randomUUID() },
              hashes(freshTokens),
            );
            const effect = randomUUID();
            let wrote = false;
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await tx.query('SAVEPOINT authority_locks');
                if (kind === 'identity')
                  await identity.authenticate(
                    hashToken(freshTokens.access),
                    tx,
                  );
                else
                  await requireRatingPromotionSession(
                    fresh.accountId,
                    fresh.sessionId,
                    tx,
                  );
                await tx.query('ROLLBACK TO SAVEPOINT authority_locks');
                await tx.query('RELEASE SAVEPOINT authority_locks');
                await tx.query(
                  'INSERT INTO whaleu_meta.epoch_tentative_effects VALUES($1,$2)',
                  [effect, fresh.accountId],
                );
                assert.equal(
                  (
                    await tx.query(
                      'SELECT 1 FROM whaleu_meta.epoch_tentative_effects WHERE id=$1',
                      [effect],
                    )
                  ).rowCount,
                  1,
                );
                wrote = true;
                await staleEpoch(tx, fresh.accountId);
                // Do not throw here: real inTransaction finalization must reject.
              }),
              appCode(
                kind === 'identity'
                  ? 'SESSION_REVOKED'
                  : 'PROMOTION_SOURCE_CHANGED',
              ),
            );
            assert.equal(wrote, true);
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_meta.epoch_tentative_effects WHERE id=$1',
                  [effect],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (await identity.authenticate(hashToken(freshTokens.access)))
                .accountId,
              fresh.accountId,
            );
          },
        );
      await inTransaction(pool, inspectSessionEpochSchema);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM whaleu_identity.accounts WHERE session_revocation_epoch<>0',
          )
        ).rowCount,
        0,
      );
    } finally {
      await db.onApplicationShutdown();
      if (owns && suite)
        for (const schema of migrationSchemaNames)
          await suite.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
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
