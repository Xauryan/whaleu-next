/** TEST ONLY. Local-only distribution before exactly registered 0138 boundaries.
 * Never masks missing production schema or replaces Safety, Review or Media. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../src/config/config.js';
import { readMigrations } from '../../src/database/migrations.js';
import { transactionReadEpoch } from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import type { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import type { Decision } from '../../src/community/community-policy.js';
import type { RelatedCampusDisplay } from '../../src/community/related-sync/contracts.js';
import type { CommunityDistributionScope } from '../../src/community/related-sync/contracts.js';
import { legacyContentScopeSchema } from '../../src/community/content-review/scope-contracts.js';
import { historicalPrefixes } from './historical-schema-prefixes.js';

let manifest: ReturnType<typeof readMigrations> | undefined;
const checkedInManifest = () =>
  (manifest ??= readMigrations(
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  ));

type PublicDistribution = Pick<
  CommunityDistributionService,
  keyof CommunityDistributionService
>;

export async function historicalCommunityDistribution(
  config: RuntimeConfig,
  prefix: number,
): Promise<PublicDistribution> {
  assert.equal(config.NODE_ENV, 'test');
  const database = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
  assert.equal(database.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  assert.ok(
    historicalPrefixes.has(prefix) && prefix < 138,
    `Unregistered pre-related-sync historical prefix ${prefix}`,
  );
  const migrations = await checkedInManifest();
  const expected = migrations
    .filter((migration) => Number(migration.name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
  assert.equal(Number(expected.at(-1)?.name.slice(0, 4)), prefix);
  const signature = JSON.stringify(expected);
  const introduced = migrations.find(({ name }) => name.startsWith('0138_'));
  assert.ok(
    introduced,
    'The related-campus distribution migration must be checked in',
  );
  const previousSql = migrations
    .filter(({ name }) => Number(name.slice(0, 4)) < 138)
    .map(({ sql }) => sql)
    .join('\n');
  const tables = [
    ...introduced.sql.matchAll(
      /\bCREATE\s+TABLE\s+(whaleu_[a-z_]+\.[a-z_]+)/gi,
    ),
  ].map((m) => m[1]!.toLowerCase());
  const functions = [
    ...introduced.sql.matchAll(
      /\bCREATE\s+FUNCTION\s+(whaleu_[a-z_]+\.[a-z_]+)/gi,
    ),
  ].map((m) => m[1]!.toLowerCase());
  const triggerNames = (sql: string) =>
    [...sql.matchAll(/\bCREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+([a-z_]+)/gi)].map(
      (m) => m[1]!.toLowerCase(),
    );
  const priorTriggers = new Set(triggerNames(previousSql));
  const triggers = [...new Set(triggerNames(introduced.sql))].filter(
    (name) => !priorTriggers.has(name),
  );
  const indexes = [
    ...introduced.sql.matchAll(
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+([a-z_]+)\s+ON\s+(whaleu_[a-z_]+)\./gi,
    ),
  ].map((m) => `${m[2]!.toLowerCase()}.${m[1]!.toLowerCase()}`);
  // These additions belong to an existing relation, so relation/function
  // absence alone cannot rule out a partial actor-proof deployment.
  const columns = [
    'whaleu_community.content_approval_bindings.related_actor_fingerprint',
    'whaleu_community.content_approval_bindings.related_actor_transaction',
  ];
  const constraints = [
    'whaleu_community.content_approval_bindings.related_actor_proof_shape',
  ];
  assert.ok(introduced.sql.includes('ADD COLUMN related_actor_fingerprint'));
  assert.ok(introduced.sql.includes('ADD COLUMN related_actor_transaction'));
  assert.ok(
    introduced.sql.includes('ADD CONSTRAINT related_actor_proof_shape'),
  );
  assert.ok(indexes.includes('whaleu_community.related_actor_inflight'));
  assert.ok(indexes.includes('whaleu_community.related_distribution_inflight'));
  assert.ok(tables.includes('whaleu_community.post_distribution_bindings'));
  assert.ok(
    functions.includes('whaleu_community.related_sync_envelope_admitted'),
  );
  assert.ok(triggers.includes('related_root_complete'));
  const verify = async (tx: PoolClient) => {
    try {
      const actual = await tx.query<{ name: string; checksum: string }>(
        'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT $1',
        [expected.length + 1],
      );
      if (JSON.stringify(actual.rows) !== signature)
        throw new Error('Historical migration prefix changed');
      // Reject partial deployment too, including isolated actor-proof columns
      // or constraints, and functions/indexes/triggers without their new table.
      const row = (
        await tx.query<{ absent: boolean }>(
          `SELECT
        NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname||'.'||c.relname)=ANY($1::text[]))
        AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname||'.'||p.proname)=ANY($2::text[]))
        AND NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname LIKE 'whaleu\\_%' ESCAPE '\\' AND t.tgname=ANY($3::text[]))
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT a.attisdropped AND (n.nspname||'.'||c.relname||'.'||a.attname)=ANY($4::text[]))
        AND NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname||'.'||c.relname||'.'||k.conname)=ANY($5::text[])) AS absent`,
          [[...tables, ...indexes], functions, triggers, columns, constraints],
        )
      ).rows[0];
      if (row?.absent !== true)
        throw new Error('Historical schema contains related-sync objects');
    } catch {
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
  };
  const scopes = new WeakMap<
    CommunityDistributionScope,
    { tx: PoolClient; epoch: object }
  >();
  const owned = (scope: CommunityDistributionScope, tx?: PoolClient) => {
    const entry = scopes.get(scope);
    if (
      !entry ||
      (tx && entry.tx !== tx) ||
      transactionReadEpoch(entry.tx) !== entry.epoch
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return entry;
  };
  const reject = async (tx: PoolClient): Promise<never> => {
    await verify(tx);
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  };
  const adapter: PublicDistribution = {
    observeRootAdmission: (tx) => reject(tx),
    requirePolicyEnable: (_regionId, tx) => reject(tx),
    prepare: (_actor, _space, _shape, _authority, tx) => reject(tx),
    bind: (_postId, _context, _approval, tx) => reject(tx),
    async capability(_actor, _space, _category, _authority, tx) {
      await verify(tx);
      return { availability: 'denied', reason: 'COMMUNITY_SCOPE_UNAVAILABLE' };
    },
    async requireEnvelopeShape(envelope, tx) {
      await verify(tx);
      if (envelope.version === 4)
        throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    },
    async inherit(postId, childScope, tx) {
      await verify(tx);
      const row = (
        await tx.query<{ publication_envelope_version: number }>(
          "SELECT coalesce((to_jsonb(p)->>'publication_envelope_version')::integer,1) AS publication_envelope_version FROM whaleu_community.posts p WHERE id=$1",
          [postId],
        )
      ).rows[0];
      if (!row || row.publication_envelope_version === 4)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return legacyContentScopeSchema.parse(childScope);
    },
    async resolveView(space, tx) {
      await verify(tx);
      const epoch = transactionReadEpoch(tx);
      if (!epoch || !space.isActive)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const scope: CommunityDistributionScope = Object.freeze({
        viewSpaceId: space.id,
        viewRegionId: space.operatingRegionId,
        relatedCampusDistribution: 'complete',
        fingerprint: createHash('sha256')
          .update(
            `test-only-historical-distribution:${prefix}:${signature}:${space.id}`,
          )
          .digest('hex'),
        originalSpaceIds: Object.freeze([space.id]),
        remoteSpaceIds: Object.freeze([]),
      });
      scopes.set(scope, { tx, epoch });
      return scope;
    },
    sqlPredicate(scope, alias, _category, parameters) {
      owned(scope);
      if (!/^[a-z][a-z0-9_]*$/.test(alias))
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      parameters.push(scope.viewSpaceId);
      return `(${alias}.space_id=$${parameters.length}::uuid)`;
    },
    display(scope, originalSpace) {
      owned(scope);
      if (originalSpace.id !== scope.viewSpaceId)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return { isRelatedCampusSync: false };
    },
    async evaluatePosts(scope, posts, tx) {
      await verify(tx);
      owned(scope, tx);
      if (posts.length > 256)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return new Map<string, Decision<RelatedCampusDisplay>>(
        posts.map((post) => [
          post.id,
          post.space_id === scope.viewSpaceId
            ? { kind: 'allow' as const, value: { isRelatedCampusSync: false } }
            : { kind: 'deny' as const, reason: 'POST_NOT_FOUND' as const },
        ]),
      );
    },
    async allows(scope, postId, originalSpaceId, category, tx) {
      return (
        await adapter.evaluatePosts(
          scope,
          [{ id: postId, space_id: originalSpaceId, category }],
          tx,
        )
      ).get(postId)!;
    },
  };
  return adapter;
}
