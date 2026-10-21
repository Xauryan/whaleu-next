/** TEST ONLY. Fixed schema-0167 discussion-upgrade Identity owner.
 * Derived from the unchanged historical-identity/configure.ts guard; no shared
 * registry widening or production fallback. Only synthetic leaf actors enroll.
 * Guard and use share a managed transaction and fences that exclude both the
 * account ALTER and migration-ledger writes until that transaction commits. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import type { TransactionOptions } from '../../src/database/database.js';
import { readMigrations } from '../../src/database/migrations.js';
import { transactionLifetime } from '../../src/database/transaction-deadlines.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityRepository as PredecessorIdentityRepository } from './historical-identity/repository.js';

// Explicit public transaction-bearing surface. New owner methods must be
// reviewed instead of receiving a generic object-shaped "transaction" bypass.
const transactionArguments: Readonly<Record<string, number>> = Object.freeze({
  dmActiveAccount: 1,
  activeAccount: 1,
  beginTitleMaintenanceSweep: 0,
  titleMaintenanceCandidateWindow: 1,
  lockTitleMaintenanceAccount: 1,
  canonicalWechatTitleEligibility: 1,
  wechatAppAccount: 2,
  authenticate: 1,
});
const managedMethods = new Set(['createSession', 'rotate', 'revoke']);

export async function discussionOrderUpgradeIdentity(
  database: DatabaseService,
  config: RuntimeConfig,
  historicalPhase: () => boolean,
): Promise<IdentityRepository> {
  assert.equal(config.NODE_ENV, 'test');
  const url = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  // A connection-string SSL option must not override the explicit false mode.
  assert.ok(![...url.searchParams.keys()].some((key) => /^ssl/i.test(key)));
  const prefix = 167;
  assert.equal(
    historicalPhase(),
    true,
    'Discussion predecessor phase is closed',
  );
  const expected = (
    await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    )
  )
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
  assert.equal(Number(expected.at(-1)?.name.slice(0, 4)), prefix);
  const requirePrefix = async (tx: PoolClient): Promise<void> => {
    assert.equal(
      historicalPhase(),
      true,
      'Discussion predecessor phase is closed',
    );
    assert.ok(
      transactionLifetime(tx),
      'Historical Identity requires a managed transaction',
    );
    // ACCESS SHARE permits concurrent predecessor DML but conflicts with
    // account ALTER (ACCESS EXCLUSIVE). NOWAIT fails closed during an upgrade.
    await tx.query(
      'LOCK TABLE whaleu_identity.accounts IN ACCESS SHARE MODE NOWAIT',
    );
    await tx.query(
      'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
    );
    const actual = await tx.query(
      'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT $1',
      [expected.length + 1],
    );
    assert.deepEqual(
      actual.rows,
      expected,
      'Historical Identity cannot cross an upgrade',
    );
    const absent = await tx.query<{ absent: boolean }>(
      `SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='whaleu_account_deletion')
       AND NOT EXISTS (SELECT 1 FROM pg_attribute
         WHERE attrelid='whaleu_identity.accounts'::regclass AND NOT attisdropped
           AND attname=ANY(ARRAY['lifecycle','lifecycle_generation','deletion_request_id'])) AS absent`,
    );
    assert.equal(
      absent.rows[0]?.absent,
      true,
      'Partial deletion schema is not a predecessor',
    );
  };
  const guardedDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'transaction')
        return <T>(
          operation: (tx: PoolClient) => Promise<T>,
          options?: TransactionOptions,
        ) =>
          database.transaction(async (tx) => {
            await requirePrefix(tx);
            const result = await operation(tx);
            await requirePrefix(tx);
            return result;
          }, options);
      if (property === 'query')
        // Standalone authenticate/revoke must not precheck on one connection
        // then issue the statement on another. Retain fences through commit.
        return (sql: string, values?: unknown[]) =>
          database.transaction(async (tx) => {
            await requirePrefix(tx);
            const result = await tx.query(sql, values);
            await requirePrefix(tx);
            return result;
          });
      return Reflect.get(target, property, receiver);
    },
  });
  const predecessor = new PredecessorIdentityRepository(
    guardedDatabase,
    config,
  );
  return new Proxy(predecessor, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== 'function' || property === 'constructor')
        return method;
      const name = String(property);
      assert.ok(
        name in transactionArguments || managedMethods.has(name),
        `Unreviewed historical Identity method ${name}`,
      );
      return async (...args: unknown[]) => {
        assert.equal(
          historicalPhase(),
          true,
          'Discussion predecessor phase is closed',
        );
        if (name === 'createSession') {
          const identity = args[0] as {
            provider?: unknown;
            appId?: unknown;
            subject?: unknown;
          };
          assert.equal(identity.provider, 'wechat');
          assert.equal(
            identity.appId,
            'synthetic-discussion-order-upgrade-only',
          );
          assert.ok(
            typeof identity.subject === 'string' &&
              /^discussion-upgrade-[0-9a-f-]{36}$/.test(identity.subject),
          );
        }
        const index = transactionArguments[name];
        const tx =
          index === undefined
            ? undefined
            : (args[index] as PoolClient | undefined);
        // authenticate without a supplied transaction uses guarded query above.
        if (index !== undefined && name !== 'authenticate') assert.ok(tx);
        if (tx) await requirePrefix(tx);
        const result = await Reflect.apply(method, target, args);
        if (tx) await requirePrefix(tx);
        return result;
      };
    },
  }) as unknown as IdentityRepository;
}
