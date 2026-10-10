/** Disposable synthetic issuers and real AppModule owners. No runtime provider,
 * final-projection inserts, disabled constraints, production rows or secrets. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { ratingCategoryFixture } from './rating-category-fixture.js';
import {
  appendTopologyRevision,
  withCommunityScopeWriter,
} from './community-scope-fixtures.js';
import type { RatingLegacyCompatSelector } from '../../src/campus/rating-scoped-context.facade.js';
import { CampusRatingScopedContextFacade } from '../../src/campus/rating-scoped-context.facade.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  canonicalRatingScopedEnvelope,
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
} from '../../src/community/content-review/rating-scoped-contracts.js';
import type {
  RatingScopedEnvelope,
  RatingScopedCategoryEnvelope,
} from '../../src/community/content-review/rating-scoped-contracts.js';
import { RatingScopedReleaseRepository } from '../../src/ratings/scoped/release.repository.js';
import { ratingScopedDigest } from '../../src/ratings/scoped/protocol-registry.js';
import {
  RATING_SCOPED_CAPABILITY_VERSION,
  RATING_SCOPED_REQUIRED_CAPABILITIES,
} from '../../src/ratings/scoped/constants.js';
import { ratingScopedContextSchema } from '../../src/ratings/scoped/contracts.js';
import type {
  RatingNavigationSelector,
  RatingScopedContextRequest,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedCategoryPageSchema } from '../../src/ratings/scoped/read.service.js';

export type RatingScopedSyntheticSourceKind =
  | 'legacy_adoption'
  | 'scoped_category_base'
  | 'scoped_category_override'
  | 'scoped_category_lifecycle'
  | 'scoped_category_order'
  | 'scoped_category_scope'
  | 'scoped_target_placement'
  | 'scope_absence'
  | 'scope_capabilities'
  | 'native_scoped_create'
  | 'native_v1_compat_write'
  | 'm3a_native_bridge';
export interface RatingScopedSyntheticSource {
  id: string;
  revision: string;
  kind: RatingScopedSyntheticSourceKind;
  key: string;
  scopeKeys: string[];
  digest: string;
  validUntil: Date;
}
export interface RatingScopedSyntheticCategory {
  categoryId: string;
  identityId: string;
  source: RatingScopedSyntheticSource;
  envelope: RatingScopedCategoryEnvelope;
  placementRevision: string;
  scopeKeys: string[];
}
const canonicalKeys = (keys: readonly string[]) => [...new Set(keys)].sort();
/** This helper is intentionally available only in the disposable test harness.
 * Every call uses source heads and the same SQL digest/verifiers as production. */
export async function writeRatingScopedSource(
  tx: PoolClient,
  input: {
    id?: string;
    revision?: string;
    kind: RatingScopedSyntheticSourceKind;
    key: string;
    scopeKeys: readonly string[];
    payload: Record<string, unknown>;
    validUntil?: Date;
  },
): Promise<RatingScopedSyntheticSource> {
  const id = input.id ?? randomUUID(),
    revision = input.revision ?? randomUUID(),
    scopeKeys = canonicalKeys(input.scopeKeys);
  const before = (
    await tx.query<{ source_id: string; effective_at: Date }>(
      `SELECT h.source_id,s.effective_at
    FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s
    ON (s.id,s.revision)=(h.source_id,h.source_revision) WHERE h.source_kind=$1 AND h.source_key=$2 FOR UPDATE OF h`,
      [input.kind, input.key],
    )
  ).rows[0];
  const row = (
    await tx.query<{ digest: string; valid_until: Date }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now)
    INSERT INTO whaleu_ratings.scoped_source_attestations(id,revision,source_kind,source_key,scope_keys,payload,digest,
      coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
    SELECT $1,$2,$3,$4,$5::text[],$6::jsonb,
      whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind',$3::text,'key',$4::text,'scopeKeys',$5::text[],'payload',$6::jsonb)),
      'complete','accepted','synthetic-scoped-issuer','synthetic-scoped-source:'||$1::text,'synthetic-scoped-test-policy',
      greatest(instant.now,coalesce($7::timestamptz,instant.now-interval '1 second')+interval '1 microsecond'),
      coalesce($8::timestamptz,instant.now+interval '30 minutes') FROM instant RETURNING digest,valid_until`,
      [
        id,
        revision,
        input.kind,
        input.key,
        scopeKeys,
        canonicalJson(input.payload),
        before?.effective_at ?? null,
        input.validUntil ?? null,
      ],
    )
  ).rows[0]!;
  const updated = await tx.query(
    `INSERT INTO whaleu_ratings.scoped_source_heads(source_kind,source_key,source_id,source_revision)
    VALUES($1,$2,$3,$4) ON CONFLICT(source_kind,source_key) DO UPDATE SET source_id=excluded.source_id,source_revision=excluded.source_revision
    WHERE scoped_source_heads.source_id=$5::uuid`,
    [input.kind, input.key, id, revision, before?.source_id ?? null],
  );
  assert.equal(
    updated.rowCount,
    1,
    'Synthetic source issuance must CAS its exact predecessor',
  );
  return {
    id,
    revision,
    kind: input.kind,
    key: input.key,
    scopeKeys,
    digest: row.digest,
    validUntil: row.valid_until,
  };
}
export async function writeRatingScopedApproval(
  tx: PoolClient,
  input: RatingScopedEnvelope,
  options: {
    result?: 'allow' | 'reject' | 'pending' | 'failed';
    visibilityUntil?: Date;
    consumeUntil?: Date;
    policyUntil?: Date;
  } = {},
) {
  const envelope = canonicalRatingScopedEnvelope(input),
    digest = ratingScopedApprovalDigest(envelope),
    policyRevisionId = randomUUID(),
    decisionId = randomUUID(),
    eventId = randomUUID();
  const now = (
    await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
  ).rows[0]!.now.getTime();
  const evaluatedAt = new Date(
    Math.min(
      now - 1000,
      (options.consumeUntil?.getTime() ?? Infinity) - 1000,
      (options.visibilityUntil?.getTime() ?? Infinity) - 1000,
      (options.policyUntil?.getTime() ?? Infinity) - 1000,
    ),
  );
  await tx.query(
    `INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from,valid_until)
    VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-scoped-review','synthetic-scoped-policy',$2,$3)`,
    [
      policyRevisionId,
      new Date(evaluatedAt.getTime() - 1000),
      options.policyUntil ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,
    result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until)
    VALUES($1,$2,$3,5,$4,$5::jsonb,$6,$7,'complete','accepted','synthetic-scoped-review','synthetic-scoped-exact-envelope',$8,$9,$10,$11)`,
    [
      decisionId,
      envelope.accountId,
      envelope.purpose,
      digest,
      canonicalJson(envelope),
      policyRevisionId,
      options.result ?? 'allow',
      evaluatedAt,
      options.consumeUntil ?? new Date(now + 3600000),
      options.visibilityUntil ? 'until' : 'durable',
      options.visibilityUntil ?? null,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
    VALUES($1,$2,'allow','complete','accepted','synthetic-scoped-review','synthetic-scoped-event',$3)`,
    [eventId, decisionId, evaluatedAt],
  );
  await tx.query(
    'INSERT INTO whaleu_community.rating_approval_heads(decision_id,event_id) VALUES($1,$2)',
    [decisionId, eventId],
  );
  return {
    decisionId,
    policyRevisionId,
    eventId,
    digest,
    envelope,
    version: 5 as const,
  };
}

export async function ratingScopedFixture() {
  const f = await ratingCategoryFixture();
  try {
    const campusA = f.scope.home.campusId,
      campusB = randomUUID(),
      regionId = f.scope.home.regionId;
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Synthetic scoped sibling','synthetic',true)",
        [campusB, f.scope.institutionId],
      );
      await tx.query(
        'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES($1,$2)',
        [campusB, regionId],
      );
    });
    const topology = structuredClone(f.scope.topology),
      groupId = topology.regions.find((r) => r.regionId === regionId)!.groupId;
    // All four campuses are explicitly authorized by this synthetic owner
    // snapshot, including the other regions. Institution equality does not grant it.
    for (const region of topology.regions) region.groupId = groupId;
    topology.assignments.push({
      campusId: campusB,
      institutionId: f.scope.institutionId,
      regionId,
      coverage: 'complete',
      isActive: true,
    });
    f.scope.topologySnapshotId = await appendTopologyRevision(f.pool, topology);
    f.scope.topology = topology;
    const creator = await f.actor();
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const campusIds = topology.assignments
      .filter((c) => c.isActive)
      .map((c) => c.campusId)
      .sort();
    const scopeKeys = canonicalKeys([
      ...campusIds.map((c) => `campus:${c}`),
      'global',
    ]);
    const logicalScopeKeys = canonicalKeys([
      ...topology.regions.filter((r) => r.isActive).map((r) => r.regionId),
      'global',
    ]);
    const owner = f.app.get(CampusRatingScopedContextFacade),
      releases = f.app.get(RatingScopedReleaseRepository);
    const categoryIds = new Map(
      scopeKeys.map((key) => [key, new Set<string>()]),
    );
    const targetIds = new Map(scopeKeys.map((key) => [key, new Set<string>()]));
    let capabilities: RatingScopedSyntheticSource | null = null;
    const issueSource = (
      input: Parameters<typeof writeRatingScopedSource>[1],
      tx?: PoolClient,
    ) =>
      tx
        ? writeRatingScopedSource(tx, input)
        : withCommunityScopeWriter(f.pool, (client) =>
            writeRatingScopedSource(client, input),
          );
    const bindSource = async (
      tx: PoolClient,
      accepted: Awaited<ReturnType<typeof writeRatingScopedApproval>>,
      source: RatingScopedCategoryEnvelope,
    ) => {
      canonicalRatingScopedCategorySource({
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        categoryId: source.categoryId,
        envelope: source,
      });
      // Synthetic issuance batches all decisions before the compiler registers
      // its final Review epoch. Normal binding and reverse SQL guards still run.
      await tx.query(
        `INSERT INTO whaleu_community.rating_scoped_category_source_bindings
        (decision_id,account_id,operation,digest,envelope,envelope_version,source_id,source_revision,category_id,issuance_id,issuance_digest)
        VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,$9,$10)`,
        [
          accepted.decisionId,
          source.accountId,
          source.purpose,
          accepted.digest,
          canonicalJson(source),
          source.sourceId,
          source.sourceRevision,
          source.categoryId,
          source.issuanceId,
          source.issuanceDigest,
        ],
      );
    };
    const placement = (keys: readonly string[]) => {
      const sorted = canonicalKeys(keys);
      if (sorted.length === 1 && sorted[0] === 'global')
        return { kind: 'global' as const };
      assert(
        sorted.length > 0 && sorted.every((key) => key.startsWith('campus:')),
        'Reviewed placement must be a strict global/campuses union',
      );
      return {
        kind: 'campuses' as const,
        campusIds: sorted.map((key) => key.slice(7)),
      };
    };
    const issueBase = async (input: {
      name: string;
      scopeKeys: readonly string[];
      description?: string;
      categoryId?: string;
      identityId?: string;
      parentId?: string | null;
      level?: 1 | 2 | 3;
      ordinal?: string;
      active?: boolean;
      hidden?: boolean;
    }): Promise<RatingScopedSyntheticCategory> => {
      const id = randomUUID(),
        revision = randomUUID(),
        categoryId = input.categoryId ?? randomUUID(),
        identityId = input.identityId ?? randomUUID(),
        keys = canonicalKeys(input.scopeKeys),
        key = `base:${categoryId}`,
        place = placement(keys),
        body = {
          parentId: input.parentId ?? null,
          level: input.level ?? 1,
          kind: 'general',
          systemKey: null,
          name: input.name,
          description: input.description ?? '',
        };
      const issuanceDigest = ratingScopedDigest('issuance', {
        id,
        revision,
        kind: 'scoped_category_base',
        key,
        scopeKeys: keys,
        categoryId,
        identityId,
        body,
        placement: place,
      });
      const envelope = canonicalRatingScopedEnvelope({
        version: 5,
        purpose: 'publish_rating_category_base_scoped',
        accountId: creator.accountId,
        sourceId: id,
        sourceRevision: revision,
        categoryId,
        identityId,
        issuanceId: id,
        issuanceDigest,
        placement: place,
        assetIds: [],
        body,
      });
      if (envelope.purpose !== 'publish_rating_category_base_scoped')
        assert.fail();
      const source = await withCommunityScopeWriter(f.pool, async (tx) => {
        const accepted = await writeRatingScopedApproval(tx, envelope);
        const source = await writeRatingScopedSource(tx, {
          id,
          revision,
          kind: 'scoped_category_base',
          key,
          scopeKeys: keys,
          payload: {
            reviewEnvelope: envelope,
            issuanceDigest,
            active: input.active ?? true,
            hidden: input.hidden ?? false,
            ordinal: input.ordinal ?? '0',
            originKind: place.kind === 'global' ? 'global' : 'regional',
          },
        });
        await bindSource(tx, accepted, envelope);
        return source;
      });
      const placementRevision = randomUUID();
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const issued = await writeRatingScopedSource(tx, {
          kind: 'scoped_category_scope',
          key: `placement:${categoryId}`,
          scopeKeys: keys,
          payload: {
            categoryId,
            baseSourceId: source.id,
            baseSourceRevision: source.revision,
            placementRevision,
            placement: place,
            scopeKeys: keys,
          },
        });
        await tx.query(
          `INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision)
          VALUES($1,$2,$3,$4,$5::text[],$6,$7)`,
          [
            placementRevision,
            categoryId,
            source.id,
            source.revision,
            keys,
            issued.id,
            issued.revision,
          ],
        );
      });
      for (const key of keys) {
        assert(categoryIds.has(key));
        categoryIds.get(key)!.add(categoryId);
      }
      return {
        categoryId,
        identityId,
        source,
        envelope,
        placementRevision,
        scopeKeys: keys,
      };
    };
    const override = async (
      category: RatingScopedSyntheticCategory,
      campusId: string,
      name: string,
      description = '',
      transaction?: PoolClient,
    ) => {
      const id = randomUUID(),
        revision = randomUUID(),
        scopeKey = `campus:${campusId}`,
        key = `override:${category.categoryId}:${campusId}`,
        place = placement([scopeKey]),
        body = { name, description };
      const issuanceDigest = ratingScopedDigest('issuance', {
        id,
        revision,
        kind: 'scoped_category_override',
        key,
        scopeKeys: [scopeKey],
        categoryId: category.categoryId,
        identityId: category.identityId,
        body,
        placement: place,
      });
      const envelope = canonicalRatingScopedEnvelope({
        version: 5,
        purpose: 'publish_rating_category_override_scoped',
        accountId: creator.accountId,
        sourceId: id,
        sourceRevision: revision,
        categoryId: category.categoryId,
        identityId: category.identityId,
        issuanceId: id,
        issuanceDigest,
        placement: place,
        assetIds: [],
        baseSourceId: category.source.id,
        baseSourceRevision: category.source.revision,
        scope: { kind: 'campus', campusId },
        body,
      });
      if (envelope.purpose !== 'publish_rating_category_override_scoped')
        assert.fail();
      const run = async (tx: PoolClient) => {
        const accepted = await writeRatingScopedApproval(tx, envelope);
        const source = await writeRatingScopedSource(tx, {
          id,
          revision,
          kind: 'scoped_category_override',
          key,
          scopeKeys: [scopeKey],
          payload: { reviewEnvelope: envelope, issuanceDigest },
        });
        await bindSource(tx, accepted, envelope);
        return { ...source, reviewDecisionId: accepted.decisionId };
      };
      return transaction
        ? run(transaction)
        : withCommunityScopeWriter(f.pool, run);
    };
    const lifecycle = (
      category: RatingScopedSyntheticCategory,
      campusId: string,
      hidden: boolean,
      active = true,
      tx?: PoolClient,
    ) =>
      issueSource(
        {
          kind: 'scoped_category_lifecycle',
          key: `lifecycle:${category.categoryId}:${campusId}`,
          scopeKeys: [`campus:${campusId}`],
          payload: {
            categoryId: category.categoryId,
            baseSourceId: category.source.id,
            baseSourceRevision: category.source.revision,
            hidden,
            active,
          },
        },
        tx,
      );
    const order = (
      category: RatingScopedSyntheticCategory,
      campusId: string,
      ordinal: string,
      tx?: PoolClient,
    ) =>
      issueSource(
        {
          kind: 'scoped_category_order',
          key: `order:${category.categoryId}:${campusId}`,
          scopeKeys: [`campus:${campusId}`],
          payload: {
            categoryId: category.categoryId,
            baseSourceId: category.source.id,
            baseSourceRevision: category.source.revision,
            ordinal,
          },
        },
        tx,
      );
    const declareScope = (
      scopeKey: string,
      patch: {
        complete?: boolean;
        categoryIds?: string[];
        targetIds?: string[];
        legacyCatalogIds?: string[];
      } = {},
      tx?: PoolClient,
    ) =>
      issueSource(
        {
          kind: 'scope_absence',
          key: scopeKey,
          scopeKeys: [scopeKey],
          payload: {
            complete: patch.complete ?? true,
            categoryIds:
              patch.categoryIds ??
              [...(categoryIds.get(scopeKey) ?? [])].sort(),
            targetIds:
              patch.targetIds ?? [...(targetIds.get(scopeKey) ?? [])].sort(),
            legacyCatalogIds: patch.legacyCatalogIds ?? [],
          },
        },
        tx,
      );
    const declareAll = async () => {
      for (const key of scopeKeys) await declareScope(key);
    };
    const capability = async (
      patch: Record<string, unknown> = {},
      tx?: PoolClient,
    ) => {
      const source = await issueSource(
        {
          kind: 'scope_capabilities',
          key: 'synthetic-scoped-full-deployment',
          scopeKeys,
          payload: {
            capabilityVersion: RATING_SCOPED_CAPABILITY_VERSION,
            protocolVersion: 2,
            reviewVersion: 5,
            journalVersion: 9,
            capabilities: [...RATING_SCOPED_REQUIRED_CAPABILITIES],
            routesDigest: ratingScopedDigest(
              'fixture-routes',
              RATING_SCOPED_REQUIRED_CAPABILITIES,
            ),
            nativeDigest: ratingScopedDigest(
              'fixture-native',
              'synthetic-native-v2',
            ),
            serviceDigest: ratingScopedDigest(
              'fixture-service',
              'real-AppModule-v2',
            ),
            ownerEvidenceDigest: ratingScopedDigest('fixture-owners', {
              topologySnapshotId: f.scope.topologySnapshotId,
              scopeKeys,
            }),
            legacyFreshWritePolicy: 'requires_explicit_bridge',
            ...patch,
          },
        },
        tx,
      );
      capabilities = source;
      return source;
    };
    type PublishOptions = {
      activate?: boolean;
      actor?: Actor;
      generation?: string;
      capability?: RatingScopedSyntheticSource;
      logicalScopeKeys?: string[];
      domain?: RatingLegacyCompatSelector;
    };
    const publish = async (
      options: PublishOptions = {},
      transaction?: PoolClient,
    ) => {
      const run = async (tx: PoolClient) => {
        const actor = options.actor ?? creator,
          proof = options.domain
            ? await owner.resolveLegacyCompatDomain(options.domain, tx)
            : await owner.resolveRandomCandidates(
                { accountId: actor.accountId, affiliation: actor.facts },
                { kind: 'institution_with_global', anchorCampusId: campusA },
                tx,
              ),
          source = options.capability ?? capabilities;
        const logicalKeys = canonicalKeys(
          proof.scopeKeys.map((key) =>
            key === 'global'
              ? 'global'
              : proof.mappings.find((m) => `campus:${m.campusId}` === key)!
                  .regionId,
          ),
        );
        assert(
          source,
          'A synthetic complete affected-domain issuance is required as a release cause',
        );
        return releases.publish(
          proof,
          options.activate
            ? {
                kind: 'protocol_activation',
                generation: options.generation ?? randomUUID(),
                capabilitySourceId: source.id,
                capabilitySourceRevision: source.revision,
                logicalScopeKeys: options.logicalScopeKeys ?? logicalKeys,
              }
            : {
                kind: 'source_release',
                issuanceSourceId: source.id,
                issuanceSourceRevision: source.revision,
              },
          tx,
        );
      };
      return transaction
        ? run(transaction)
        : withCommunityScopeWriter(f.pool, run);
    };
    const atomicChange = async (
      change: (tx: PoolClient) => Promise<unknown>,
      options: PublishOptions = {},
    ) => {
      const previous = capabilities;
      try {
        return await withCommunityScopeWriter(f.pool, async (tx) => {
          await change(tx);
          return publish(options, tx);
        });
      } catch (error) {
        capabilities = previous;
        throw error;
      }
    };
    const context = async (
      actor: Actor,
      selector: RatingNavigationSelector = { kind: 'global' },
      purpose: 'read' | 'interact' | 'create_target' | 'edit_target' = 'read',
    ) => {
      const response = await f
        .auth(request(f.http).post('/v2/ratings/contexts'), actor)
        .send({ purpose, selector, mode: 'public' });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return ratingScopedContextSchema.parse(response.body);
    };
    const requestContext = (actor: Actor, input: RatingScopedContextRequest) =>
      f.auth(request(f.http).post('/v2/ratings/contexts'), actor).send(input);
    const categories = async (
      actor: Actor,
      selector: RatingNavigationSelector,
    ) => {
      const current = await context(actor, selector),
        response = await f
          .auth(request(f.http).get('/v2/ratings/categories'), actor)
          .query({ contextId: current.id, contextToken: current.token });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return {
        context: current,
        response,
        page: ratingScopedCategoryPageSchema.parse(response.body),
      };
    };
    const seedCatalogs = async (options: { different?: boolean } = {}) => {
      const localScopes = [`campus:${campusA}`, `campus:${campusB}`].sort();
      const local = await issueBase({
        name: 'Shared local category',
        scopeKeys: localScopes,
        ordinal: '0',
      });
      const second = await issueBase({
        name: 'Second local category',
        scopeKeys: localScopes,
        ordinal: '1',
      });
      const global = await issueBase({
        name: 'Independent global category',
        scopeKeys: ['global'],
        ordinal: '0',
      });
      if (options.different !== false) {
        await override(local, campusB, 'Campus B category');
        await lifecycle(local, campusB, true);
        await order(local, campusB, '10');
      }
      await declareAll();
      await capability();
      return { local, second, global };
    };
    const creationPolicy = (keys: readonly string[] = scopeKeys) =>
      issueSource({
        kind: 'native_scoped_create',
        key: 'synthetic-native-scoped-create',
        scopeKeys: keys,
        payload: { enabled: true, scopeKeys: canonicalKeys(keys) },
      });
    return {
      ...f,
      creator,
      campusA,
      campusB,
      campusIds,
      regionId,
      scopeKeys,
      logicalScopeKeys,
      scopedOwner: owner,
      issueSource,
      issueBase,
      override,
      lifecycle,
      order,
      declareScope,
      declareAll,
      capability,
      publish,
      atomicChange,
      scopedContext: context,
      requestScopedContext: requestContext,
      scopedCategories: categories,
      seedScopedCatalogs: seedCatalogs,
      creationPolicy,
      approveScoped: (
        envelope: RatingScopedEnvelope,
        options: Parameters<typeof writeRatingScopedApproval>[2] = {},
      ) =>
        withCommunityScopeWriter(f.pool, (tx) =>
          writeRatingScopedApproval(tx, envelope, options),
        ),
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
export type RatingScopedFixture = Awaited<
  ReturnType<typeof ratingScopedFixture>
>;
