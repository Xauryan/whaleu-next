import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pollDelay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
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
  type Migration,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { inspectSessionEpochSchema } from '../../src/identity/session-epoch.js';
import { sqlError, sqlRejected } from '../support/epoch-authority-fixture.js';
import { requireRatingPromotionSession } from '../../src/identity/rating-promotion-session.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { AppLogger } from '../../src/observability/logger.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

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

const gateNamespace = 180180;
const appId = 'wx0123456789abcdef';
const lockUnavailable = (e: unknown) =>
  e instanceof Error && 'code' in e && e.code === '55P03';
type Outcome = { ok: true } | { ok: false; error: unknown };

async function blockedRow(
  writer: PoolClient,
  table: 'accounts' | 'sessions',
  id: string,
) {
  await writer.query('SAVEPOINT before_release');
  await assert.rejects(
    writer.query(
      `SELECT id FROM whaleu_identity.${table} WHERE id=$1 FOR UPDATE NOWAIT`,
      [id],
    ),
    lockUnavailable,
  );
  await writer.query('ROLLBACK TO SAVEPOINT before_release');
  await writer.query('RELEASE SAVEPOINT before_release');
}
async function ownedRow(
  writer: PoolClient,
  table: 'accounts' | 'sessions',
  id: string,
) {
  assert.equal(
    (
      await writer.query(
        `SELECT id FROM whaleu_identity.${table} WHERE id=$1 FOR UPDATE NOWAIT`,
        [id],
      )
    ).rowCount,
    1,
  );
}

// No timer establishes the interleaving: progress requires observing this exact
// owned backend waiting inside our deferred trigger on our held advisory gate.
async function waitForDeferredGate(
  observer: PoolClient,
  backend: () => number | undefined,
  settled: () => Outcome | undefined,
) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const done = settled();
    if (done)
      throw done.ok
        ? new Error('Transaction committed before the owned gate was observed')
        : done.error;
    const pid = backend();
    if (pid !== undefined) {
      const row = (
        await observer.query<{
          wait_event_type: string;
          wait_event: string;
          query: string;
        }>(
          'SELECT wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=$1',
          [pid],
        )
      ).rows[0];
      if (row?.wait_event_type === 'Lock' && row.wait_event === 'advisory') {
        assert.match(row.query, /^SET CONSTRAINTS ALL IMMEDIATE$/i);
        return;
      }
    }
    await pollDelay(10);
  }
  assert.fail(
    'The exact owned backend did not reach its deferred advisory gate within the original timeout budget',
  );
}

test(
  'historical180 epoch boundary and current repository released-lock/deferred final fences',
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
      await t.test(
        'historical180: exact ledger and original immutable/write-closed SQL guards',
        async () => {
          await runMigrations(pool, historical, { mode: 'up' });
          await assertEpochLedger(pool, historical);
          await inTransaction(pool, async (tx) => {
            await assertHistoricalEpoch180(tx, historical[179]!);
            const account = randomUUID(),
              session = randomUUID();
            await tx.query(
              'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
              [account],
            );
            await tx.query(
              "INSERT INTO whaleu_identity.sessions(id,account_id,access_expires_at,refresh_expires_at,absolute_expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '7 days',clock_timestamp()+interval '30 days')",
              [session, account],
            );
            assert.deepEqual(
              (
                await tx.query(
                  'SELECT a.session_revocation_epoch,s.issued_revocation_epoch FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id WHERE s.id=$1',
                  [session],
                )
              ).rows,
              [{ session_revocation_epoch: '0', issued_revocation_epoch: '0' }],
            );
            await sqlRejected(
              tx,
              () =>
                tx.query(
                  'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1',
                  [account],
                ),
              sqlError(
                'Real accepted deletion authority is not installed',
                'session_epoch_account',
              ),
            );
            await sqlRejected(
              tx,
              () =>
                tx.query(
                  'UPDATE whaleu_identity.sessions SET issued_revocation_epoch=1 WHERE id=$1',
                  [session],
                ),
              sqlError(
                'Session identity and issued epoch are immutable',
                'session_epoch_issued',
              ),
            );
            await assertHistoricalEpoch180(tx, historical[179]!);
          });
          await assert.rejects(
            inTransaction(pool, inspectSessionEpochSchema),
            (error: unknown) =>
              error instanceof ApplicationError &&
              error.code === 'AUTH_NOT_CONFIGURED',
          );
          await assertEpochLedger(pool, historical);
        },
      );
      await t.test(
        'current repository: full migration ledger and actual released-lock/deferred-fence matrix',
        async (t) => {
          await runMigrations(pool, migrations, { mode: 'up' });
          await assertEpochLedger(pool, migrations);
          await inTransaction(pool, inspectSessionEpochSchema);
          await suite!.query(`
      CREATE TABLE whaleu_meta.epoch_fence_effects(id uuid PRIMARY KEY, gate_key integer NOT NULL, waited boolean NOT NULL DEFAULT false);
      CREATE FUNCTION whaleu_meta.epoch_fence_wait() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(${gateNamespace},NEW.gate_key);
        UPDATE whaleu_meta.epoch_fence_effects SET waited=true WHERE id=NEW.id;
        RETURN NULL;
      END $$;
      CREATE CONSTRAINT TRIGGER epoch_fence_wait AFTER INSERT ON whaleu_meta.epoch_fence_effects
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_meta.epoch_fence_wait();
    `);
          const actor = async () => {
            const access = mintToken('access');
            const session = await identity.createSession(
              { provider: 'wechat', appId, subject: randomUUID() },
              {
                access: hashToken(access),
                refresh: hashToken(mintToken('refresh')),
              },
            );
            return { ...session, access: hashToken(access) };
          };
          const original = await actor(),
            post = await actor();
          let gate = 1;
          for (const kind of ['identity', 'promotion'] as const) {
            const admit = (who: typeof original, tx: PoolClient) =>
              kind === 'identity'
                ? identity.authenticate(who.access, tx)
                : requireRatingPromotionSession(
                    who.accountId,
                    who.sessionId,
                    tx,
                  );
            const errorCode =
              kind === 'identity' ? 'SESSION_REVOKED' : 'PROMOTION_UNAVAILABLE';
            const rejected = (outcome: Outcome) => {
              assert.equal(outcome.ok, false);
              if (!outcome.ok)
                assert.ok(
                  outcome.error instanceof ApplicationError &&
                    outcome.error.code === errorCode,
                  `Expected ${errorCode}, received ${String(outcome.error)}`,
                );
            };
            for (const conflictingWriter of [false, true])
              await t.test(
                `${kind}: ${conflictingWriter ? 'denies after' : 'valid-zero control through'} actual released row locks and deferred advisory wait`,
                async () => {
                  const writer = await pool.connect();
                  const effect = randomUUID(),
                    key = gate++;
                  let backend: number | undefined, settled: Outcome | undefined;
                  let operation: Promise<Outcome> | undefined;
                  await suite!.query('SELECT pg_advisory_lock($1,$2)', [
                    gateNamespace,
                    key,
                  ]);
                  try {
                    await writer.query('BEGIN');
                    operation = inTransaction(pool, async (tx) => {
                      backend = (
                        await tx.query<{ pid: number }>(
                          'SELECT pg_backend_pid() pid',
                        )
                      ).rows[0]!.pid;
                      await tx.query('SAVEPOINT retained_authority');
                      await admit(post, tx);
                      // Actual locks, not a pg_locks guess: the second connection fails on
                      // BOTH exact rows until the savepoint releases them.
                      await blockedRow(writer, 'accounts', post.accountId);
                      await blockedRow(writer, 'sessions', post.sessionId);
                      await tx.query(
                        'ROLLBACK TO SAVEPOINT retained_authority',
                      );
                      await tx.query('RELEASE SAVEPOINT retained_authority');
                      // Deliberately retain the JS fact here. Production checkpoint/restore
                      // semantics are covered separately below, not conflated with this case.
                      await tx.query(
                        'INSERT INTO whaleu_meta.epoch_fence_effects(id,gate_key) VALUES($1,$2)',
                        [effect, key],
                      );
                    }).then(
                      () => (settled = { ok: true }),
                      (error: unknown) => (settled = { ok: false, error }),
                    );
                    await waitForDeferredGate(
                      suite!,
                      () => backend,
                      () => settled,
                    );
                    await ownedRow(writer, 'accounts', post.accountId);
                    await ownedRow(writer, 'sessions', post.sessionId);
                    if (kind === 'promotion')
                      await writer.query(
                        'LOCK TABLE whaleu_identity.accounts,whaleu_identity.sessions IN ROW EXCLUSIVE MODE NOWAIT',
                      );
                    if (!conflictingWriter) await writer.query('ROLLBACK');
                    await suite!.query('SELECT pg_advisory_unlock($1,$2)', [
                      gateNamespace,
                      key,
                    ]);
                    const outcome = await operation;
                    if (conflictingWriter) rejected(outcome);
                    else assert.equal(outcome.ok, true);
                    const effects = await suite!.query<{ waited: boolean }>(
                      'SELECT waited FROM whaleu_meta.epoch_fence_effects WHERE id=$1',
                      [effect],
                    );
                    assert.equal(effects.rowCount, conflictingWriter ? 0 : 1);
                    if (!conflictingWriter)
                      assert.equal(effects.rows[0]!.waited, true);
                  } finally {
                    await suite!.query('SELECT pg_advisory_unlock($1,$2)', [
                      gateNamespace,
                      key,
                    ]);
                    await writer.query('ROLLBACK');
                    await operation;
                    writer.release();
                  }
                  // Neither row/session state nor epoch was mutated by contention.
                  assert.equal(
                    (await identity.authenticate(post.access)).accountId,
                    post.accountId,
                  );
                },
              );
            await t.test(
              `${kind}: production checkpoint/restore trims discarded session fact but retains earlier authority`,
              async () => {
                const writer = await pool.connect();
                const effect = randomUUID(),
                  temporarySession = randomUUID(),
                  temporaryToken = hashToken(mintToken('access'));
                try {
                  await writer.query('BEGIN');
                  await inTransaction(pool, async (tx) => {
                    await admit(original, tx);
                    const checkpoint = checkpointTransactionDeadlines(tx);
                    await tx.query('SAVEPOINT rejected_command');
                    // A real zero-epoch session and token, valid before rollback. Removing
                    // this session makes an accidentally retained post-checkpoint fact fail.
                    await tx.query(
                      'INSERT INTO whaleu_identity.sessions(id,account_id,access_expires_at,refresh_expires_at,absolute_expires_at,issued_revocation_epoch) SELECT $1,account_id,access_expires_at,refresh_expires_at,absolute_expires_at,issued_revocation_epoch FROM whaleu_identity.sessions WHERE id=$2',
                      [temporarySession, post.sessionId],
                    );
                    await tx.query(
                      'INSERT INTO whaleu_identity.access_tokens(token_hash,session_id,expires_at) SELECT $1,$2,expires_at FROM whaleu_identity.access_tokens WHERE token_hash=$3',
                      [temporaryToken, temporarySession, post.access],
                    );
                    await admit(
                      {
                        ...post,
                        sessionId: temporarySession,
                        access: temporaryToken,
                      },
                      tx,
                    );
                    await tx.query('ROLLBACK TO SAVEPOINT rejected_command');
                    restoreTransactionDeadlines(tx, checkpoint);
                    await tx.query('RELEASE SAVEPOINT rejected_command');
                    assert.equal(
                      (
                        await tx.query(
                          'SELECT 1 FROM whaleu_identity.sessions WHERE id=$1',
                          [temporarySession],
                        )
                      ).rowCount,
                      0,
                    );
                    await blockedRow(writer, 'accounts', original.accountId);
                    await blockedRow(writer, 'sessions', original.sessionId);
                    await ownedRow(writer, 'accounts', post.accountId);
                    await ownedRow(writer, 'sessions', post.sessionId);
                    await tx.query(
                      'INSERT INTO whaleu_meta.epoch_fence_effects(id,gate_key) VALUES($1,$2)',
                      [effect, gate++],
                    );
                  });
                  assert.equal(
                    (
                      await suite!.query<{ waited: boolean }>(
                        'SELECT waited FROM whaleu_meta.epoch_fence_effects WHERE id=$1',
                        [effect],
                      )
                    ).rows[0]!.waited,
                    true,
                  );
                } finally {
                  await writer.query('ROLLBACK');
                  writer.release();
                }
              },
            );
            await t.test(
              `${kind}: explicit readmission after checkpoint restore registers a fresh final fact`,
              async () => {
                const writer = await pool.connect(),
                  effect = randomUUID(),
                  temporarySession = randomUUID(),
                  temporaryToken = hashToken(mintToken('access'));
                try {
                  await writer.query('BEGIN');
                  const outcome: Outcome = await inTransaction(
                    pool,
                    async (tx) => {
                      await admit(original, tx);
                      const checkpoint = checkpointTransactionDeadlines(tx);
                      await tx.query('SAVEPOINT discarded_authority');
                      await admit(post, tx);
                      await tx.query(
                        'ROLLBACK TO SAVEPOINT discarded_authority',
                      );
                      restoreTransactionDeadlines(tx, checkpoint);
                      await tx.query('RELEASE SAVEPOINT discarded_authority');
                      await tx.query('SAVEPOINT fresh_authority');
                      await tx.query(
                        'INSERT INTO whaleu_identity.sessions(id,account_id,access_expires_at,refresh_expires_at,absolute_expires_at,issued_revocation_epoch) SELECT $1,account_id,access_expires_at,refresh_expires_at,absolute_expires_at,issued_revocation_epoch FROM whaleu_identity.sessions WHERE id=$2',
                        [temporarySession, post.sessionId],
                      );
                      await tx.query(
                        'INSERT INTO whaleu_identity.access_tokens(token_hash,session_id,expires_at) SELECT $1,$2,expires_at FROM whaleu_identity.access_tokens WHERE token_hash=$3',
                        [temporaryToken, temporarySession, post.access],
                      );
                      await admit(
                        {
                          ...post,
                          sessionId: temporarySession,
                          access: temporaryToken,
                        },
                        tx,
                      );
                      await blockedRow(writer, 'accounts', post.accountId);
                      await tx.query('ROLLBACK TO SAVEPOINT fresh_authority');
                      await tx.query('RELEASE SAVEPOINT fresh_authority');
                      assert.equal(
                        (
                          await tx.query(
                            'SELECT 1 FROM whaleu_identity.sessions WHERE id=$1',
                            [temporarySession],
                          )
                        ).rowCount,
                        0,
                      );
                      await ownedRow(writer, 'accounts', post.accountId);
                      await ownedRow(writer, 'sessions', post.sessionId);
                      await writer.query('ROLLBACK');
                      // No conflicting writer survives. Only the freshly registered,
                      // now-missing session may veto; the original fact remains valid.
                      await tx.query(
                        'INSERT INTO whaleu_meta.epoch_fence_effects(id,gate_key) VALUES($1,$2)',
                        [effect, gate++],
                      );
                    },
                  ).then(
                    () => ({ ok: true as const }),
                    (error: unknown) => ({ ok: false as const, error }),
                  );
                  assert.equal(outcome.ok, false);
                  if (!outcome.ok) {
                    const missingCode =
                      kind === 'identity'
                        ? 'SESSION_REVOKED'
                        : 'PROMOTION_SOURCE_CHANGED';
                    assert.ok(
                      outcome.error instanceof ApplicationError &&
                        outcome.error.code === missingCode,
                      `Expected ${missingCode}, received ${String(outcome.error)}`,
                    );
                  }
                  assert.equal(
                    (
                      await suite!.query(
                        'SELECT 1 FROM whaleu_meta.epoch_fence_effects WHERE id=$1',
                        [effect],
                      )
                    ).rowCount,
                    0,
                  );
                } finally {
                  await writer.query('ROLLBACK');
                  writer.release();
                }
              },
            );
          }
          assert.equal(
            (
              await suite!.query(
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
