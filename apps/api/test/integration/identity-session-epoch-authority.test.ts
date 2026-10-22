import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
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
  type Migration,
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

// The historical fixture is exact0180, not a runtime compatibility fallback.
// Current runtime/deployment uses ALL repository migrations, not a maximum182
// compatibility mode. Require the unchanged ordered prefix through0182, then
// compare every installed ledger row with the complete repository chain.
function epochStages(migrations: readonly Migration[]) {
  const historical = migrations.slice(0, 180);
  const required = migrations.slice(0, 182);
  assert.equal(historical.length, 180);
  assert.equal(
    historical.at(-1)?.name,
    '0180_identity_session_revocation_epoch.sql',
  );
  assert.equal(required.length, 182);
  assert.equal(
    required.at(-1)?.name,
    '0182_real_deletion_request_authority.sql',
  );
  for (const [chain, expected] of [
    [
      historical,
      'dba888821d84a9a27fcb82c94e027eaa2b3c30cf28efc3b71e6d9fe6ea9fdf0d',
    ],
    [
      required,
      '231ba5fbc296f08b5bcef6c50fd42b192348aa8f2967dcba220680ca63db583b',
    ],
  ] as const)
    assert.equal(
      createHash('sha256')
        .update(
          JSON.stringify(
            chain.map(({ name, checksum }) => ({ name, checksum })),
          ),
        )
        .digest('hex'),
      expected,
      'The exact signed migration prefix must remain unchanged',
    );
  return historical;
}
async function assertEpochLedger(pool: Pool, migrations: readonly Migration[]) {
  assert.deepEqual(
    (
      await pool.query(
        'SELECT name, checksum FROM whaleu_meta.schema_migrations ORDER BY name',
      )
    ).rows,
    migrations.map(({ name, checksum }) => ({ name, checksum })),
    'Every installed migration name and checksum must match the selected stage',
  );
}

// Raw catalog assertions are scoped to the pinned historical test only. The
// current Identity inspector must reject this v1 schema, never admit it.
async function assertHistoricalEpoch180(tx: PoolClient, migration: Migration) {
  const expected = [
    ...migration.sql.matchAll(
      /CREATE FUNCTION whaleu_identity\.(session_epoch_[a-z_]+)\(\) RETURNS (?:trigger|jsonb)[^;]*? AS \$epoch\$([\s\S]*?)\$epoch\$;/g,
    ),
  ]
    .map((match) => ({ name: match[1]!, body: match[2]! }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  assert.deepEqual(
    expected.map(({ name }) => name),
    [
      'session_epoch_account_guard',
      'session_epoch_issued_guard',
      'session_epoch_protocol',
    ],
  );
  assert.deepEqual(
    (
      await tx.query(
        "SELECT proname name,prosrc body FROM pg_proc WHERE pronamespace='whaleu_identity'::regnamespace AND proname LIKE 'session_epoch_%' ORDER BY proname",
      )
    ).rows,
    expected,
  );
  assert.equal(
    (
      await tx.query<{ valid: boolean }>(`
    SELECT count(*)=2 AND bool_and(t.tgenabled='O' AND t.tgtype=23 AND NOT t.tgisinternal
      AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgattr=''::int2vector
      AND NOT t.tgdeferrable AND NOT t.tginitdeferred) valid
    FROM (VALUES ('whaleu_identity.accounts','session_epoch_account','whaleu_identity.session_epoch_account_guard()'),
      ('whaleu_identity.sessions','session_epoch_issued','whaleu_identity.session_epoch_issued_guard()')) e(rel,name,fn)
    JOIN pg_trigger t ON t.tgrelid=to_regclass(e.rel) AND t.tgname=e.name AND t.tgfoid=to_regprocedure(e.fn)
  `)
    ).rows[0]!.valid,
    true,
    'Historical guards are restored before authority is tested',
  );
}

async function sqlAuthorityMatrix(
  t: TestContext,
  pool: Pool,
  actor: { accountId: string; sessionId: string },
  tokens: ReturnType<typeof credentials>,
  makeStale: typeof staleEpoch,
) {
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
            (await tx.query<{ valid: boolean }>(sql, [...args])).rows[0]!.valid,
            true,
            `${name} positive control`,
          );
          await makeStale(tx, actor.accountId);
          assert.equal(
            (await tx.query<{ valid: boolean }>(sql, [...args])).rows[0]!.valid,
            false,
            `${name} must reject only epoch mismatch`,
          );
        });
        assert.equal(
          (await pool.query<{ valid: boolean }>(sql, [...args])).rows[0]!.valid,
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
          await makeStale(tx, actor.accountId);
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
        await makeStale(tx, actor.accountId);
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
}

// Separate from the existing migration/schema suite: every negative below first
// proves the SAME fixture succeeds, then changes only its account epoch.
test(
  'historical180 SQL authority and current repository Identity credentials/final proof',
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
      const historical = epochStages(migrations);
      owns = true;
      const old = {
        accountId: randomUUID(),
        sessionId: randomUUID(),
        tokens: credentials(),
      };
      await t.test(
        'historical180: exact ledger, original SQL matrix and write-closed epoch authority',
        async (t) => {
          await runMigrations(pool, historical, { mode: 'up' });
          await assertEpochLedger(pool, historical);
          await inTransaction(pool, async (tx) => {
            await assertHistoricalEpoch180(tx, historical[179]!);
            await tx.query(
              'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
              [old.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat',$1,$2,$3)",
              [appId, randomUUID(), old.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_identity.sessions(id,account_id,access_expires_at,refresh_expires_at,absolute_expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '7 days',clock_timestamp()+interval '30 days')",
              [old.sessionId, old.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_identity.access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')",
              [hashToken(old.tokens.access), old.sessionId],
            );
            await tx.query(
              'INSERT INTO whaleu_identity.refresh_tokens(token_hash,session_id) VALUES($1,$2)',
              [hashToken(old.tokens.refresh), old.sessionId],
            );
            await sqlRejected(
              tx,
              () =>
                tx.query(
                  'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1',
                  [old.accountId],
                ),
              sqlError(
                'Real accepted deletion authority is not installed',
                'session_epoch_account',
              ),
            );
          });
          // Signed current code requires0182 bodies: old credentials are compatible
          // after upgrade; operating the current service on the old schema is not.
          await assert.rejects(
            inTransaction(pool, inspectSessionEpochSchema),
            appCode('AUTH_NOT_CONFIGURED'),
          );
          const historicalStale: typeof staleEpoch = async (tx, account) => {
            await tx.query(
              'ALTER TABLE whaleu_identity.accounts DISABLE TRIGGER session_epoch_account',
            );
            assert.equal(
              (
                await tx.query(
                  'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1 AND session_revocation_epoch=0 RETURNING id',
                  [account],
                )
              ).rowCount,
              1,
              'Exactly one rollback-only historical stale transition',
            );
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            await tx.query(
              'ALTER TABLE whaleu_identity.accounts ENABLE TRIGGER session_epoch_account',
            );
            await assertHistoricalEpoch180(tx, historical[179]!);
          };
          await sqlAuthorityMatrix(t, pool, old, old.tokens, historicalStale);
          await assertEpochLedger(pool, historical);
        },
      );
      await t.test(
        'current repository: full migration ledger, old credentials and actual Identity/final-proof controls',
        async (t) => {
          await runMigrations(pool, migrations, { mode: 'up' });
          await assertEpochLedger(pool, migrations);
          await inTransaction(pool, inspectSessionEpochSchema);
          assert.equal(
            (await identity.authenticate(hashToken(old.tokens.access)))
              .accountId,
            old.accountId,
          );
          const upgradedTokens = credentials();
          assert.equal(
            (
              await identity.rotate(
                hashToken(old.tokens.refresh),
                hashes(upgradedTokens),
              )
            ).sessionId,
            old.sessionId,
          );
          assert.equal(
            (await identity.authenticate(hashToken(upgradedTokens.access)))
              .accountId,
            old.accountId,
          );
          const tokens = credentials();
          const actor = await identity.createSession(
            { provider: 'wechat', appId, subject: randomUUID() },
            hashes(tokens),
          );
          await sqlAuthorityMatrix(t, pool, actor, tokens, staleEpoch);
          await t.test(
            'retained access and unconsumed refresh cannot mint credentials, consume refresh or extend any lifetime',
            async () => {
              const retained = credentials();
              assert.equal(
                (
                  await identity.rotate(
                    hashToken(tokens.refresh),
                    hashes(retained),
                  )
                ).sessionId,
                actor.sessionId,
                'Real zero-epoch rotation succeeds before stale injection',
              );
              assert.equal(
                (await identity.authenticate(hashToken(retained.access)))
                  .accountId,
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
              const staleIdentity = new IdentityRepository(
                staleDatabase,
                config,
              );
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
                (
                  await identity.rotate(
                    hashToken(retained.refresh),
                    hashes(next),
                  )
                ).sessionId,
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
          await assertEpochLedger(pool, migrations);
        },
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
