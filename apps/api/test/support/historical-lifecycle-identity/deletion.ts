/** TEST ONLY. Exact 0173/0174 lifecycle-aware Identity, not current acceptance.
 * The repository is the 2f9f Git blob with imports relocated, not a fallback.
 * No schema repair, epoch authority, fixture admission, or pool precheck lives here. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../../src/config/config.js';
import { DatabaseService } from '../../../src/database/database.js';
import type { TransactionOptions } from '../../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
} from '../../../src/database/migrations.js';
import { boundedOwnerProof } from '../../../src/database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  transactionLifetime,
  transactionReadEpoch,
} from '../../../src/database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../../src/http/application-error.js';
import { IdentityRepository } from '../../../src/identity/identity.repository.js';
import type { ProviderIdentity } from '../../../src/identity/contracts.js';
import { IdentityRepository as PredecessorIdentityRepository } from '../historical-m1/identity.repository.js';
import { historicalRealDeletionAbsenceSql } from '../historical-real-deletion-absence.js';
import { historicalRealRequestAbsenceSql } from '../historical-real-request-absence.js';

// These exact checked-in manifests were independently compared, file for file,
// with 2f9f77260119664af3a06c488963153fdc12dab3. Never accept a prefix range.
const manifestDigests = Object.freeze({
  173: 'cc1605b4d8f9bffd3242e5efc370c1cd800d131500261a0c35b61d611dbd9fcf',
  174: 'd24fa884cda400efd2de536dec24cbbd1d48e309711168783df2071866032a75',
});
const transactionArguments: Readonly<Record<string, number>> = Object.freeze({
  dmActiveAccount: 1,
  processingAccountState: 1,
  activeAccount: 1,
  beginTitleMaintenanceSweep: 0,
  titleMaintenanceCandidateWindow: 1,
  lockTitleMaintenanceAccount: 1,
  canonicalWechatTitleEligibility: 1,
  wechatAppAccount: 2,
  authenticate: 1,
});
const managedMethods = Object.freeze(['createSession', 'rotate', 'revoke']);
const owners = new WeakSet<object>();
export function isHistoricalDeletionIdentity(value: unknown): boolean {
  return typeof value === 'object' && value !== null && owners.has(value);
}

/** Inspect every independently installable successor family, not just its head
 * tables. Triggers on Identity, Media, Safety, Campus, etc. count too. This does
 * not widen either older shared historical adapter or its prefix registry. */
// A candidate is the exact union of the five forbidden-name predicates below.
// Filter BEFORE materializing attributes: evaluating the precise 0088 exception
// across all namespace/attribute combinations created a 701,325-row join on a
// fresh predecessor catalog. Namespace OIDs are InitPlan arrays, never a join
// that can rescan catalogs for each schema. Keep the original 100/500 ms.
// Catalog names use byte-ordered prefix ranges under explicit C collation.
// This is exactly the original optional-one-underscore regex union, without
// regex evaluation across every catalog row under real callers' 20 ms budget.
const successorName = (name: string) => {
  const prefixes = [
    'registration_guard',
    'session_epoch_',
    'text_source_',
    'community_text_sources',
    'reading_',
    'home_',
  ];
  const ranges = prefixes
    .flatMap((prefix) => [prefix, '_' + prefix])
    .map((prefix) => {
      const upper =
        prefix.slice(0, -1) +
        String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
      return `(${name} COLLATE "C" >= '${prefix}'::name AND ${name} COLLATE "C" < '${upper}'::name)`;
    });
  return `(${ranges.join(' OR ')} OR ${name} IN ('profile_moderation_definition_pre_text_source','profile_moderation_definition_pre_home','session_revocation_epoch','issued_revocation_epoch'))`;
};
export const historicalDeletionSchemaSql = `WITH application_namespaces AS MATERIALIZED (
  SELECT oid FROM pg_namespace WHERE starts_with(nspname,'whaleu_')
), candidate_attributes AS MATERIALIZED (
  SELECT a.attrelid,a.attnum,a.attname,a.atttypid,a.attnotnull,a.attgenerated,a.attidentity,a.atttypmod,a.attndims
  FROM pg_attribute a WHERE NOT a.attisdropped AND ${successorName('a.attname')}
), application_objects AS MATERIALIZED (
  SELECT c.relname::text name FROM pg_class c WHERE c.relnamespace=ANY(ARRAY(SELECT oid FROM application_namespaces)) AND ${successorName('c.relname')}
  UNION ALL SELECT p.proname::text FROM pg_proc p WHERE p.pronamespace=ANY(ARRAY(SELECT oid FROM application_namespaces)) AND ${successorName('p.proname')}
  UNION ALL SELECT t.tgname::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=ANY(ARRAY(SELECT oid FROM application_namespaces)) AND ${successorName('t.tgname')}
  UNION ALL SELECT t.typname::text FROM pg_type t WHERE t.typnamespace=ANY(ARRAY(SELECT oid FROM application_namespaces)) AND ${successorName('t.typname')}
  UNION ALL SELECT c.conname::text FROM pg_constraint c WHERE c.connamespace=ANY(ARRAY(SELECT oid FROM application_namespaces)) AND ${successorName('c.conname')}
  UNION ALL SELECT a.attname::text FROM candidate_attributes a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relnamespace=ANY(ARRAY(SELECT oid FROM application_namespaces)) AND NOT (
      -- Exact 0088 predecessor columns, not 0175 Community source metadata.
      -- No namespace-wide exception: renamed/extra/changed columns still fail.
      n.nspname='whaleu_ratings' AND c.relname='category_icon_definitions' AND c.relkind='r'
      AND a.attname IN ('text_source_id','text_source_revision')
      AND a.atttypid='pg_catalog.uuid'::regtype AND NOT a.attnotnull
      AND a.attgenerated='' AND a.attidentity='' AND a.atttypmod=-1 AND a.attndims=0
      AND NOT EXISTS (SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum)
    )
) SELECT
  NOT EXISTS (
    SELECT 1 FROM (VALUES ('lifecycle','text',true),('lifecycle_generation','int8',true),('deletion_request_id','uuid',false)) required(name,type,required_not_null)
    WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
      WHERE a.attrelid='whaleu_identity.accounts'::regclass AND NOT a.attisdropped
        AND a.attname=required.name AND t.typname=required.type AND a.attnotnull=required.required_not_null)
  ) AS lifecycle_present,
  NOT EXISTS (
    SELECT 1 FROM unnest(ARRAY['sandboxes','inventory','fixture_accounts','requests','commands','recovery_grants','owner_causes','owner_receipts','reregistration_guards','reserved_profile_ids','fixture_media_cohorts','media_observations','follow_scopes','follow_pages','follow_mutations','follow_source_intents','follow_source_retirements','follow_source_erasures','follow_head_advances']) required(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='whaleu_account_deletion' AND c.relname=required.name AND c.relkind='r')
  ) AS deletion_present,
  (${historicalRealDeletionAbsenceSql}) AS real_deletion_absent,
  (${historicalRealRequestAbsenceSql}) AS real_request_absent,
  NOT EXISTS (SELECT 1 FROM application_objects WHERE name ~ '^_?registration_guard') AS registration_absent,
  NOT EXISTS (SELECT 1 FROM application_objects WHERE name ~ '^_?session_epoch_' OR name IN ('session_revocation_epoch','issued_revocation_epoch')) AS epoch_absent,
  NOT EXISTS (SELECT 1 FROM application_objects WHERE name ~ '^_?(text_source_|community_text_sources)' OR name='profile_moderation_definition_pre_text_source') AS source_absent,
  NOT EXISTS (SELECT 1 FROM application_objects WHERE name ~ '^_?reading_') AS reading_absent,
  NOT EXISTS (SELECT 1 FROM application_objects WHERE name ~ '^_?home_' OR name='profile_moderation_definition_pre_home') AS home_absent`;

function requireSyntheticIdentity(value: ProviderIdentity): ProviderIdentity {
  // Caller-owned objects must not change namespace after an awaited boundary.
  // Read descriptors, not getters, and hand the old repository only captured data.
  if (!value || typeof value !== 'object')
    throw new ApplicationError('AUTH_NOT_CONFIGURED');
  const prototype = Object.getPrototypeOf(value);
  const allowed = ['provider', 'appId', 'subject'];
  const keys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.length !== allowed.length ||
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key))
  )
    throw new ApplicationError('AUTH_NOT_CONFIGURED');
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
    string,
    PropertyDescriptor
  >;
  if (
    allowed.some(
      (key) =>
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    )
  )
    throw new ApplicationError('AUTH_NOT_CONFIGURED');
  const provider: unknown = descriptors['provider']!.value;
  const appId: unknown = descriptors['appId']!.value;
  const subject: unknown = descriptors['subject']!.value;
  const uuid =
    '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const subjects: Readonly<Record<string, RegExp>> = Object.freeze({
    'synthetic-account-deletion-rehearsal': new RegExp(`^synthetic-${uuid}$`),
    'synthetic-nonfixture-follow-peer': new RegExp(`^generated-${uuid}$`),
    'synthetic-runtime-only': new RegExp(`^${uuid}$`),
  });
  if (
    provider !== 'wechat' ||
    typeof appId !== 'string' ||
    typeof subject !== 'string' ||
    !Object.hasOwn(subjects, appId) ||
    !subjects[appId]!.test(subject)
  )
    throw new ApplicationError('AUTH_NOT_CONFIGURED');
  return Object.freeze(
    Object.assign(Object.create(null), { provider, appId, subject }),
  ) as ProviderIdentity;
}

async function boundaryManifest(config: RuntimeConfig, prefix: 173 | 174) {
  assert.equal(config.NODE_ENV, 'test');
  const url = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  assert.ok(![...url.searchParams.keys()].some((key) => /^ssl/i.test(key)));
  assert.ok(prefix === 173 || prefix === 174);
  const expected = Object.freeze(
    (
      await readMigrations(
        fileURLToPath(new URL('../../../migrations', import.meta.url)),
      )
    )
      .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
      .map(({ name, checksum }) => Object.freeze({ name, checksum })),
  );
  assert.equal(Number(expected.at(-1)?.name.slice(0, 4)), prefix);
  const digest = createHash('sha256')
    .update(JSON.stringify(expected))
    .digest('hex');
  assert.equal(
    digest,
    manifestDigests[prefix],
    'Historical manifest requires provenance review',
  );
  return { expected, digest };
}

export async function historicalDeletionBoundary(
  config: RuntimeConfig,
  prefix: 173 | 174,
): Promise<(tx: PoolClient) => Promise<void>> {
  const { expected, digest } = await boundaryManifest(config, prefix);
  const prefixFact = Object.freeze({ prefix, digest });
  const requireBoundary = async (tx: PoolClient): Promise<void> => {
    if (!tx || !transactionLifetime(tx))
      throw new ApplicationError('AUTH_NOT_CONFIGURED');
    await boundedOwnerProof(tx, 'AUTH_NOT_CONFIGURED', async (read) => {
      const current = await read.query<{ database: string }>(
        'SELECT current_database() AS database',
      );
      if (current.rows[0]?.database !== 'whaleu_test')
        throw new ApplicationError('AUTH_NOT_CONFIGURED');
      const fence = await read.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock_shared($1,$2) AS locked',
        [...MIGRATION_LOCK],
      );
      if (fence.rows[0]?.locked !== true)
        throw new ApplicationError('AUTH_NOT_CONFIGURED');
      await read.query(
        'LOCK TABLE whaleu_identity.accounts, whaleu_identity.sessions IN ACCESS SHARE MODE NOWAIT',
      );
      await read.query(
        'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
      );
      const actual = await read.query(
        'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT $1',
        [expected.length + 1],
      );
      assert.deepEqual(actual.rows, expected);
      const shape = (
        await read.query<Record<string, boolean>>(historicalDeletionSchemaSql)
      ).rows[0];
      if (
        !shape ||
        [
          'lifecycle_present',
          'deletion_present',
          'real_deletion_absent',
          'real_request_absent',
          'registration_absent',
          'epoch_absent',
          'source_absent',
          'reading_absent',
          'home_absent',
        ].some((key) => shape[key] !== true)
      )
        throw new ApplicationError('AUTH_NOT_CONFIGURED');
    });
  };
  // One immutable SCHEMA fact, not a synthetic session-epoch or actor proof.
  // The real managed transaction runner invokes this after all deferred waits.
  const proof: RequiredTransactionProof<typeof prefixFact> = Object.freeze({
    maximumFacts: 1,
    failureCode: 'AUTH_NOT_CONFIGURED' as const,
    validate: async (facts: readonly (typeof prefixFact)[], tx: PoolClient) => {
      if (facts.length !== 1 || facts[0] !== prefixFact)
        throw new ApplicationError('AUTH_NOT_CONFIGURED');
      await requireBoundary(tx);
    },
  });
  // Explicit test-only first + final semantics, not a per-operation schema
  // recheck: same-TX DDL may reach tentative business SQL, but unconditional
  // final proof rejects and rolls all work back before a result can escape.
  // Read epochs change on the REAL savepoint checkpoint restoration. A raw
  // ROLLBACK TO without restoreTransactionDeadlines is outside this contract.
  // No cross-request actor/session authority is cached; real business reads run.
  const admitted = new WeakMap<
    PoolClient,
    { lifetime: object; epoch: object }
  >();
  const retainBoundary = async (tx: PoolClient) => {
    const lifetime = transactionLifetime(tx),
      epoch = transactionReadEpoch(tx);
    if (!lifetime || !epoch) throw new ApplicationError('AUTH_NOT_CONFIGURED');
    const previous = admitted.get(tx);
    if (previous?.lifetime !== lifetime || previous.epoch !== epoch) {
      await requireBoundary(tx);
      // Never certify a proof that spanned rollback or managed-client reuse.
      if (
        transactionLifetime(tx) !== lifetime ||
        transactionReadEpoch(tx) !== epoch
      )
        throw new ApplicationError('AUTH_NOT_CONFIGURED');
      admitted.set(tx, { lifetime, epoch });
    }
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(tx, proof, digest, prefixFact);
  };
  return retainBoundary;
}

export async function historicalDeletionIdentity(
  database: DatabaseService,
  config: RuntimeConfig,
  prefix: 173 | 174,
): Promise<IdentityRepository> {
  const retainBoundary = await historicalDeletionBoundary(config, prefix);
  const transaction = <T>(
    operation: (tx: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ) => {
    if (
      options.isolationLevel !== undefined &&
      options.isolationLevel !== 'read committed'
    )
      throw new ApplicationError('AUTH_NOT_CONFIGURED');
    return database.transaction(
      async (tx) => {
        await retainBoundary(tx);
        const result = await operation(tx);
        await retainBoundary(tx);
        return result;
      },
      { ...options, isolationLevel: 'read committed' },
    );
  };
  // Deliberately no generic property forwarding or externally exposed database.
  // revoke's original single query runs under this same managed lifecycle.
  const guardedDatabase = Object.freeze({
    transaction,
    query: (sql: string, values?: unknown[]) =>
      transaction((tx) => tx.query(sql, values)),
  }) as unknown as DatabaseService;
  const predecessor = new PredecessorIdentityRepository(
    guardedDatabase,
    config,
  );
  const surface: Record<string, (...args: unknown[]) => Promise<unknown>> =
    Object.create(null) as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
  for (const name of [
    ...Object.keys(transactionArguments),
    ...managedMethods,
  ]) {
    const method = Reflect.get(predecessor, name) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    assert.equal(typeof method, 'function');
    surface[name] = async (...args: unknown[]) => {
      if (name === 'createSession')
        args[0] = requireSyntheticIdentity(args[0] as ProviderIdentity);
      const index = transactionArguments[name];
      if (index === undefined) return Reflect.apply(method, predecessor, args);
      if (name === 'authenticate' && args[index] === undefined)
        return transaction((tx) =>
          predecessor.authenticate(args[0] as string, tx),
        );
      const tx = args[index] as PoolClient;
      await retainBoundary(tx);
      const result = await Reflect.apply(method, predecessor, args);
      await retainBoundary(tx);
      return result;
    };
  }
  owners.add(surface);
  return Object.freeze(surface) as unknown as IdentityRepository;
}

export async function configureHistoricalDeletionIdentity(
  builder: TestingModuleBuilder,
  config: RuntimeConfig,
  prefix: 173 | 174,
): Promise<void> {
  // Validate configuration/manifest before compile, never the database. The
  // factory uses the application's own DatabaseService and real policy context.
  await boundaryManifest(config, prefix);
  builder.overrideProvider(IdentityRepository).useFactory({
    inject: [DatabaseService],
    factory: (database: DatabaseService) =>
      historicalDeletionIdentity(database, config, prefix),
  });
}
