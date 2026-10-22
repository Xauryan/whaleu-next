/** TEST ONLY: a new non-admitted synthetic peer at exactly 0174.
 * The complete frozen lifecycle-aware Identity owner remains unchanged. This
 * helper neither installs the 0175 adapter nor substitutes current Identity.
 * It exposes no chosen identity, account, session recovery or provider input. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../src/config/config.js';
import type {
  DatabaseService,
  TransactionOptions,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
} from '../../src/database/migrations.js';
import {
  transactionLifetime,
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../src/database/transaction-deadlines.js';
import type { ProviderIdentity } from '../../src/identity/contracts.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { IdentityRepository as PredecessorIdentityRepository } from './historical-m1/identity.repository.js';
import { historicalEpochAbsenceSql } from './historical-epoch-absence.js';
import { historicalRealDeletionAbsenceSql } from './historical-real-deletion-absence.js';

export const HISTORICAL_DELETION_PEER_APP = 'synthetic-deletion-peer-0174-only';
export const DELETION_PEER_0174_MANIFEST_SHA256 =
  'd24fa884cda400efd2de536dec24cbbd1d48e309711168783df2071866032a75';

export function requireHistoricalDeletionPeerConfig(config: RuntimeConfig) {
  assert.equal(config.NODE_ENV, 'test');
  const url = new URL(config.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.equal(url.search, '', 'Historical peers forbid URL query overrides');
  assert.equal(url.hash, '', 'Historical peers forbid URL fragments');
  assert.equal(config.PG_SSL_MODE, 'disable');
}

export function requireHistoricalDeletionPeerIdentity(
  identity: ProviderIdentity,
) {
  assert.ok(identity && Object.getPrototypeOf(identity) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(identity);
  assert.deepEqual(Reflect.ownKeys(descriptors).sort(), [
    'appId',
    'provider',
    'subject',
  ]);
  for (const key of ['appId', 'provider', 'subject']) {
    const descriptor = descriptors[key];
    assert.ok(
      descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
    );
  }
  assert.equal(identity.provider, 'wechat');
  assert.equal(identity.appId, HISTORICAL_DELETION_PEER_APP);
  assert.match(
    identity.subject,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
}

export async function readHistoricalDeletionPeerMigrations() {
  const expected = (
    await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    )
  )
    .filter(({ name }) => Number(name.slice(0, 4)) <= 174)
    .map(({ name, checksum }) => Object.freeze({ name, checksum }));
  assert.equal(expected.length, 174);
  assert.equal(
    expected.at(-1)?.name,
    '0174_account_deletion_inventory_collation.sql',
  );
  assert.equal(
    createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
    DELETION_PEER_0174_MANIFEST_SHA256,
  );
  return Object.freeze(expected);
}
let manifest:
  ReturnType<typeof readHistoricalDeletionPeerMigrations> | undefined;

/** Reject independently installable successor object families as well as any
 * ledger change. This is an isolated test boundary, not a certificate against
 * arbitrary unapproved superuser rewriting of existing function bodies. */
export const historicalDeletionPeerCatalogSql = `SELECT
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE (n.nspname='whaleu_community' AND (starts_with(c.relname,'community_text_sources') OR starts_with(c.relname,'text_source_') OR starts_with(c.relname,'reading_format_') OR starts_with(c.relname,'home_')))
       OR (n.nspname='whaleu_identity' AND starts_with(c.relname,'registration_guard')))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='whaleu_community' AND (starts_with(p.proname,'text_source_') OR p.proname='profile_moderation_definition_pre_text_source' OR p.proname='profile_moderation_definition_pre_home' OR starts_with(p.proname,'reading_format_') OR starts_with(p.proname,'home_')))
       OR (n.nspname='whaleu_identity' AND starts_with(p.proname,'registration_guard')))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE starts_with(n.nspname,'whaleu_') AND (starts_with(t.tgname,'text_source_') OR starts_with(t.tgname,'reading_') OR starts_with(t.tgname,'home_') OR starts_with(t.tgname,'registration_guard')))
  AND NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE NOT a.attisdropped AND ((n.nspname='whaleu_community' AND (starts_with(a.attname,'text_source_') OR starts_with(a.attname,'reading_format_') OR starts_with(a.attname,'home_')))
       OR (n.nspname='whaleu_identity' AND starts_with(a.attname,'registration_guard'))))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE starts_with(n.nspname,'whaleu_') AND (starts_with(c.conname,'text_source_') OR starts_with(c.conname,'reading_') OR starts_with(c.conname,'home_') OR starts_with(c.conname,'registration_guard')))
  AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE (n.nspname='whaleu_community' AND (t.typname=ANY(ARRAY['community_text_sources','_community_text_sources']) OR starts_with(t.typname,'text_source_') OR starts_with(t.typname,'_text_source_') OR starts_with(t.typname,'reading_format_') OR starts_with(t.typname,'_reading_format_') OR starts_with(t.typname,'home_') OR starts_with(t.typname,'_home_')))
       OR (n.nspname='whaleu_identity' AND (starts_with(t.typname,'registration_guard') OR starts_with(t.typname,'_registration_guard'))))
  AND (${historicalEpochAbsenceSql})
  AND (${historicalRealDeletionAbsenceSql})
  AND (SELECT count(*)=3 FROM pg_attribute WHERE attrelid='whaleu_identity.accounts'::regclass
    AND NOT attisdropped AND attname=ANY(ARRAY['lifecycle','lifecycle_generation','deletion_request_id'])) AS exact`;

export async function inspectHistoricalDeletionPeer174(
  tx: PoolClient,
): Promise<void> {
  assert.ok(
    transactionLifetime(tx),
    'Historical peer requires a managed transaction',
  );
  assert.equal(
    (
      await tx.query<{ database: string }>(
        'SELECT current_database() AS database',
      )
    ).rows[0]?.database,
    'whaleu_test',
  );
  const gate = await tx.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock_shared($1, $2) AS locked',
    [...MIGRATION_LOCK],
  );
  assert.equal(
    gate.rows[0]?.locked,
    true,
    'Historical peer cannot overlap a migration',
  );
  await tx.query(
    'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
  );
  await tx.query(`LOCK TABLE whaleu_identity.accounts,whaleu_identity.provider_identities,
    whaleu_identity.sessions,whaleu_identity.access_tokens,whaleu_identity.refresh_tokens,
    whaleu_account_deletion.fixture_accounts,whaleu_community.content_approval_decisions,
    whaleu_community.text_review_requests IN ACCESS SHARE MODE NOWAIT`);
  const expected = await (manifest ??= readHistoricalDeletionPeerMigrations());
  const actual = await tx.query(
    'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT 175',
  );
  assert.deepEqual(
    actual.rows,
    expected,
    'Historical peer requires the exact 0174 migration ledger',
  );
  const catalog = await tx.query<{ exact: boolean }>(
    historicalDeletionPeerCatalogSql,
  );
  assert.equal(
    catalog.rows[0]?.exact,
    true,
    'Partial or future schema is not an exact 0174 peer boundary',
  );
}
const boundaryProof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'AUTH_NOT_CONFIGURED',
  validate: async (facts, tx) => {
    assert.deepEqual(facts, [DELETION_PEER_0174_MANIFEST_SHA256]);
    await inspectHistoricalDeletionPeer174(tx);
  },
};
export async function retainHistoricalDeletionPeer174(
  tx: PoolClient,
): Promise<void> {
  await inspectHistoricalDeletionPeer174(tx);
  enableRequiredTransactionProof(tx, boundaryProof);
  registerRequiredTransactionFact(
    tx,
    boundaryProof,
    'exact-deletion-peer-0174',
    DELETION_PEER_0174_MANIFEST_SHA256,
  );
}

export async function createHistoricalDeletionPeer(
  database: DatabaseService,
  config: RuntimeConfig,
) {
  requireHistoricalDeletionPeerConfig(config);
  const identity: ProviderIdentity = Object.freeze({
    provider: 'wechat',
    appId: HISTORICAL_DELETION_PEER_APP,
    subject: randomUUID(),
  });
  requireHistoricalDeletionPeerIdentity(identity);
  const accessToken = mintToken('access'),
    refreshToken = mintToken('refresh');
  return database.transaction(
    async (tx) => {
      await retainHistoricalDeletionPeer174(tx);
      // Match the frozen owner's subject lock before checking absence. The owner
      // takes the same reentrant lock; an existing subject can never become a login.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify([identity.provider, identity.appId, identity.subject]),
      ]);
      const existing = await tx.query(
        'SELECT account_id FROM whaleu_identity.provider_identities WHERE provider=$1 AND app_id=$2 AND subject=$3',
        [identity.provider, identity.appId, identity.subject],
      );
      assert.equal(
        existing.rows.length,
        0,
        'Historical peer cannot recover an existing subject',
      );
      // Only this complete fixed owner's createSession runs on the already-managed
      // transaction. No nested commit, fake owner result or selective copied SQL.
      const ownerDatabase = {
        transaction: <T>(
          operation: (client: PoolClient) => Promise<T>,
          options?: TransactionOptions,
        ) => {
          assert.equal(
            options,
            undefined,
            'Frozen peer owner transaction contract changed',
          );
          return operation(tx);
        },
      } as DatabaseService;
      const session = await new PredecessorIdentityRepository(
        ownerDatabase,
        config,
      ).createSession(identity, {
        access: hashToken(accessToken),
        refresh: hashToken(refreshToken),
      });
      assert.equal(
        (
          await tx.query(
            'SELECT 1 FROM whaleu_account_deletion.fixture_accounts WHERE account_id=$1',
            [session.accountId],
          )
        ).rowCount,
        0,
        'External peer must never receive synthetic deletion admission',
      );
      await retainHistoricalDeletionPeer174(tx);
      return { ...session, accessToken, refreshToken };
    },
    { isolationLevel: 'read committed' },
  );
}
