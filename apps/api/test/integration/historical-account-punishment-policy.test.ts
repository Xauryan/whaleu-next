/** Exact historical fixtures cannot become a production missing-schema bypass. */
import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG } from '../../src/config/config.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import {
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { SafetyRepository } from '../../src/safety/repository.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  transactionReadEpoch,
} from '../../src/database/transaction-deadlines.js';
import { enforceAccountPunishment } from '../../src/safety/account-moderation/policy.js';
import { boundAccountPunishmentPolicy } from '../../src/safety/account-policy/punishment-context.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';

const observation = (account: string, tx: PoolClient) =>
  enforceAccountPunishment(account, 'interaction', tx);

test('exact historical policy stays app-, transaction-, epoch- and callback-owned', async (t) => {
  const f = await directoryRuntimeFixture(65);
  t.after(() => f.close());
  const actor = await f.actor();
  const oldApp = f.app;
  const oldDatabase = oldApp.get(DatabaseService);
  const builder = Test.createTestingModule({
    imports: [AppModule.register(f.app.get(APP_CONFIG))],
  });
  const normal = (await builder.compile()).createNestApplication({
    logger: false,
  });
  await normal.init();
  t.after(() => normal.close());
  const normalDatabase = normal.get(DatabaseService);
  const allowed = () =>
    oldDatabase.transaction((tx) => observation(actor.accountId, tx));
  const denied = () =>
    normalDatabase.transaction((tx) => observation(actor.accountId, tx));
  await Promise.all([allowed(), assert.rejects(denied)]);
  await assert.rejects(
    normalDatabase.transaction(async (normalTx) => {
      await allowed();
      await observation(actor.accountId, normalTx);
    }),
  );
  await oldDatabase.transaction(async (outer) => {
    await observation(actor.accountId, outer);
    const checkpoint = checkpointTransactionDeadlines(outer);
    const previousEpoch = transactionReadEpoch(outer);
    const provider = boundAccountPunishmentPolicy(outer);
    restoreTransactionDeadlines(outer, checkpoint);
    assert.notEqual(
      transactionReadEpoch(outer),
      previousEpoch,
      'restore invalidates prior read proofs',
    );
    assert.equal(
      boundAccountPunishmentPolicy(outer),
      provider,
      'the same live transaction retains its provider',
    );
    await observation(actor.accountId, outer);
    await assert.rejects(
      normalDatabase.transaction(async (normalTx) => {
        assert.equal(
          boundAccountPunishmentPolicy(outer),
          undefined,
          'another app async scope cannot borrow the outer client provider',
        );
        await observation(actor.accountId, normalTx);
      }),
    );
    await observation(actor.accountId, outer);
    await assert.rejects(
      inTransaction(f.pool, (tx) => observation(actor.accountId, tx)),
    );
  });
  // The adapter is overlay-only. Original base restriction remains authoritative.
  await f.pool.query(
    'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
    [actor.accountId],
  );
  await assert.rejects(
    oldDatabase.transaction((tx) =>
      oldApp.get(SafetyRepository).restriction(actor.accountId, tx),
    ),
    { code: 'SAFETY_ACTION_RESTRICTED' },
  );
  await f.pool.query(
    'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
    [actor.accountId],
  );

  let originalClient!: PoolClient;
  let oldCallback!: (
    tx: PoolClient,
  ) => ReturnType<typeof boundAccountPunishmentPolicy>;
  await oldDatabase.transaction(async (tx) => {
    originalClient = tx;
    assert.ok(boundAccountPunishmentPolicy(tx));
    oldCallback = AsyncResource.bind((client: PoolClient) =>
      boundAccountPunishmentPolicy(client),
    );
  });
  assert.equal(
    oldCallback(originalClient),
    undefined,
    'completed epoch is never reusable',
  );
  await oldDatabase.transaction(async (tx) => {
    assert.equal(
      tx,
      originalClient,
      'actual pool reborrow exercises the same PoolClient object',
    );
    assert.ok(boundAccountPunishmentPolicy(tx));
    assert.equal(
      oldCallback(tx),
      undefined,
      'old async scope cannot borrow the new lease',
    );
    await observation(actor.accountId, tx);
  });

  for (const statement of [
    "UPDATE whaleu_meta.schema_migrations SET checksum=repeat('0',64) WHERE name=(SELECT min(name) FROM whaleu_meta.schema_migrations)",
    'DELETE FROM whaleu_meta.schema_migrations WHERE name=(SELECT min(name) FROM whaleu_meta.schema_migrations)',
    "INSERT INTO whaleu_meta.schema_migrations(name,checksum) VALUES('0065_extra.sql',repeat('0',64))",
    'CREATE TABLE whaleu_safety.account_punishments(id uuid)',
    'CREATE TABLE whaleu_safety.account_appeals(id uuid)',
    'CREATE TABLE whaleu_authorization.account_punishment_authority_epoch(id uuid)',
    'CREATE TABLE whaleu_notifications.account_appeal_notices(id uuid)',
    "CREATE FUNCTION whaleu_authorization.advance_account_punishment_authority_epoch() RETURNS boolean LANGUAGE sql AS 'SELECT true'",
    ...[
      'issue_account_punishment',
      'release_account_punishment',
      'require_account_punishment_allowed',
      'validate_account_appeal_release',
    ].map(
      (name) =>
        `CREATE FUNCTION whaleu_safety.${name}() RETURNS boolean LANGUAGE sql AS 'SELECT true'`,
    ),
    "CREATE FUNCTION whaleu_safety.account_punishment_policy_observation(uuid,text) RETURNS boolean LANGUAGE sql AS 'SELECT true'",
  ]) {
    await assert.rejects(
      oldDatabase.transaction(async (tx) => {
        await tx.query(statement);
        await observation(actor.accountId, tx);
      }),
      { code: 'SAFETY_UNAVAILABLE' },
    );
    await allowed(); // The rejected transaction rolled back; no tainted cache.
  }
  const migrations = await readMigrations(
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  );
  await runMigrations(f.pool, migrations, { mode: 'up' });
  await assert.rejects(allowed, { code: 'SAFETY_UNAVAILABLE' });
  let releasePending!: () => void;
  const pendingGate = new Promise<void>((resolve) => {
    releasePending = resolve;
  });
  let entered!: () => void;
  const enteredGate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = oldDatabase.transaction(async (tx) => {
    await tx.query('SELECT 1');
    entered();
    await pendingGate;
  });
  await enteredGate;
  let rebuilt = false;
  const restart = f.restartApp().then(() => {
    rebuilt = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    rebuilt,
    false,
    'restart must drain an outstanding old transaction',
  );
  assert.throws(() => f.app, /closed or restarting/);
  releasePending();
  await pending;
  await restart;
  assert.notEqual(f.app, oldApp);
  assert.equal(
    oldCallback(originalClient),
    undefined,
    'shutdown does not revive an old callback',
  );
  await assert.rejects(
    oldDatabase.transaction((tx) => observation(actor.accountId, tx)),
  );
  await f.app
    .get(DatabaseService)
    .transaction((tx) => observation(actor.accountId, tx));
});
