import { historicalEpochAbsenceSql } from '../historical-epoch-absence.js';
import { historicalRealDeletionAbsenceSql } from '../historical-real-deletion-absence.js';
/** Exact-0175 test boundary. Never imported by production source. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../../src/config/config.js';
import type {
  DatabaseService,
  TransactionOptions,
} from '../../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
} from '../../../src/database/migrations.js';
import {
  transactionLifetime,
  transactionReadEpoch,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../src/database/transaction-deadlines.js';
import type { ProviderIdentity } from '../../../src/identity/contracts.js';
import type { TokenHashes } from './identity.repository.js';

export const M1_MANIFEST_SHA256 =
  '10a178660bb2cb8188ac7f6eba4b2feb612f20fe450bdbf65d1c8e0f32a4d779';
export const M1_SYNTHETIC_APP = 'synthetic-m1-compatibility-only';

export function requireM1TestConfig(config: RuntimeConfig): void {
  assert.equal(config.NODE_ENV, 'test');
  const url = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.search, '', 'M1 forbids connection-string query overrides');
  assert.equal(url.hash, '', 'M1 forbids connection-string fragments');
}

export async function readExactM1Migrations() {
  const migrations = (
    await readMigrations(
      fileURLToPath(new URL('../../../migrations', import.meta.url)),
    )
  ).filter(({ name }) => name <= '0175_community_text_sources.sql');
  assert.equal(migrations.length, 175);
  assert.equal(migrations.at(-1)?.name, '0175_community_text_sources.sql');
  assert.equal(
    createHash('sha256')
      .update(
        JSON.stringify(
          migrations.map(({ name, checksum }) => ({ name, checksum })),
        ),
      )
      .digest('hex'),
    M1_MANIFEST_SHA256,
    'M1 must use all 175 immutable predecessor migration bytes',
  );
  return migrations;
}
let manifest: ReturnType<typeof readExactM1Migrations> | undefined;

/** Reject recognized successor catalog families, including unledgered partial
 * Reading/Home/registration relations, functions, types, triggers and columns,
 * plus the exact new0180 column/constraint/trigger/function identities.
 * This is a test boundary, not a general full-catalog integrity certificate.
 * Existing lifecycle columns MUST remain.
 * The official migration shared gate, table DDL locks, and ledger SHARE lock
 * are acquired in the same managed transaction and retained through COMMIT.
 */
export async function inspectExactM1(tx: PoolClient): Promise<void> {
  assert.ok(transactionLifetime(tx), 'M1 requires a managed transaction');
  const destination = await tx.query<{ database: string }>(
    'SELECT current_database() AS database',
  );
  assert.ok(
    destination.rows[0]?.database === 'whaleu_test',
    'M1 requires the disposable database',
  );
  const gate = await tx.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked',
    [...MIGRATION_LOCK],
  );
  assert.equal(gate.rows[0]?.locked, true, 'M1 cannot overlap a migration');
  await tx.query(
    'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
  );
  await tx.query(`LOCK TABLE whaleu_identity.accounts,whaleu_identity.provider_identities,
    whaleu_identity.sessions,whaleu_community.posts,whaleu_community.root_comments,
    whaleu_community.replies,whaleu_community.community_text_sources,
    whaleu_community.content_approval_decisions,whaleu_community.content_approval_policies,
    whaleu_community.content_approval_bindings,whaleu_community.text_review_requests
    IN ACCESS SHARE MODE NOWAIT`);
  const expected = (await (manifest ??= readExactM1Migrations())).map(
    ({ name, checksum }) => ({ name, checksum }),
  );
  const ledger = await tx.query(
    'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT 176',
  );
  assert.deepEqual(
    ledger.rows,
    expected,
    'M1 cannot cross any upgrade boundary',
  );
  const catalog = await tx.query<{ exact: boolean }>(`SELECT
    NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE (n.nspname='whaleu_community' AND (starts_with(c.relname,'reading_format_') OR starts_with(c.relname,'home_')))
         OR (n.nspname='whaleu_identity' AND starts_with(c.relname,'registration_guard')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE (n.nspname='whaleu_community' AND (starts_with(p.proname,'reading_format_') OR starts_with(p.proname,'home_')))
         OR (n.nspname='whaleu_identity' AND starts_with(p.proname,'registration_guard')))
    AND NOT EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE (n.nspname='whaleu_community' AND (starts_with(t.typname,'reading_format_') OR starts_with(t.typname,'home_')))
         OR (n.nspname='whaleu_identity' AND starts_with(t.typname,'registration_guard')))
    AND NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE starts_with(n.nspname,'whaleu_') AND (starts_with(t.tgname,'reading_') OR starts_with(t.tgname,'home_') OR starts_with(t.tgname,'registration_guard')))
    AND NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE starts_with(n.nspname,'whaleu_') AND (starts_with(c.conname,'reading_') OR starts_with(c.conname,'home_') OR starts_with(c.conname,'registration_guard')))
    AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE NOT attisdropped
      AND ((attrelid='whaleu_community.content_approval_decisions'::regclass AND attname='home_issuance_transaction')
        OR (attrelid='whaleu_community.text_review_requests'::regclass AND attname='home_transition_transaction')))
    AND (${historicalEpochAbsenceSql})
    AND (${historicalRealDeletionAbsenceSql})
    AND (SELECT count(*)=3 FROM pg_attribute
      WHERE attrelid='whaleu_identity.accounts'::regclass AND NOT attisdropped
      AND attname=ANY(ARRAY['lifecycle','lifecycle_generation','deletion_request_id'])) AS exact`);
  assert.equal(
    catalog.rows[0]?.exact,
    true,
    'Partial/future owners are not exact M1',
  );
}
const boundaryProof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'COMMUNITY_UNAVAILABLE',
  validate: async (facts, tx) => {
    assert.deepEqual(facts, [M1_MANIFEST_SHA256]);
    await inspectExactM1(tx);
  },
};
const retained = new WeakMap<PoolClient, { lifetime: object; epoch: object }>();
export async function retainExactM1(tx: PoolClient): Promise<void> {
  const lifetime = transactionLifetime(tx),
    epoch = transactionReadEpoch(tx);
  assert.ok(lifetime && epoch, 'M1 requires a managed transaction');
  const previous = retained.get(tx);
  if (previous?.lifetime !== lifetime || previous.epoch !== epoch)
    await inspectExactM1(tx);
  // Re-enroll even on cache hits: a savepoint may prune required facts.
  enableRequiredTransactionProof(tx, boundaryProof);
  registerRequiredTransactionFact(
    tx,
    boundaryProof,
    'exact-m1',
    M1_MANIFEST_SHA256,
  );
  retained.set(tx, { lifetime, epoch });
}

/** All current readers and Review owners use this real DatabaseService wrapper.
 * It changes no SQL result, permission, approval, or source value. A standalone
 * query is made managed so its fence cannot be released on a different client.
 */
export function guardedM1Database(database: DatabaseService): DatabaseService {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'transaction')
        return <T>(
          operation: (tx: PoolClient) => Promise<T>,
          options?: TransactionOptions,
        ) =>
          database.transaction(async (tx) => {
            await retainExactM1(tx);
            const result = await operation(tx);
            await retainExactM1(tx);
            return result;
          }, options);
      if (property === 'query')
        return (sql: string, values?: unknown[]) =>
          database.transaction(async (tx) => {
            await retainExactM1(tx);
            const result = await tx.query(sql, values);
            await retainExactM1(tx);
            return result;
          });
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function ownData<T extends object>(
  value: T,
  keys: readonly string[],
): Record<string, unknown> {
  assert.ok(value && typeof value === 'object');
  assert.ok(
    Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  assert.deepEqual(Reflect.ownKeys(descriptors).sort(), [...keys].sort());
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    assert.ok(
      descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
    );
    copy[key] = descriptor.value;
  }
  return copy;
}
export function requireM1SyntheticIdentity(
  identity: ProviderIdentity,
  tokens: TokenHashes,
) {
  const copiedIdentity = ownData(identity, ['appId', 'provider', 'subject']);
  const copiedTokens = ownData(tokens, ['access', 'refresh']);
  assert.equal(copiedIdentity['provider'], 'wechat');
  assert.equal(copiedIdentity['appId'], M1_SYNTHETIC_APP);
  assert.equal(typeof copiedIdentity['subject'], 'string');
  assert.match(
    copiedIdentity['subject'] as string,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(typeof copiedTokens['access'], 'string');
  assert.equal(typeof copiedTokens['refresh'], 'string');
  assert.match(copiedTokens['access'] as string, /^[a-f0-9]{64}$/);
  assert.match(copiedTokens['refresh'] as string, /^[a-f0-9]{64}$/);
  assert.notEqual(copiedTokens['access'], copiedTokens['refresh']);
  return Object.freeze({
    identity: Object.freeze(copiedIdentity) as unknown as ProviderIdentity,
    tokens: Object.freeze(copiedTokens) as unknown as TokenHashes,
  });
}
