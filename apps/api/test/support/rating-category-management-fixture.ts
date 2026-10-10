/** Isolated synthetic policy/grant ingress; real HTTP, owners, Review and guards. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import request from 'supertest';
import {
  ratingScopedFixture,
  writeRatingScopedApproval,
  writeRatingScopedSource,
  type RatingScopedFixture,
  type RatingScopedSyntheticCategory,
  type RatingScopedSyntheticSource,
} from './rating-scoped-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  planCategoryManagement,
  type CategoryManagementPlan,
  type CategorySourceIssue,
  type CategorySnapshot,
} from '../../src/ratings/category-management/plan.js';
import { RatingCategoryManagementReader } from '../../src/ratings/category-management/scoped-reader.repository.js';
import {
  ratingCategoryManagementContextSchema,
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedOperations,
  ratingCategoryScopedPreparationSchema,
  ratingCategoryScopedReceiptSchema,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedOperation,
} from '../../src/ratings/category-management/scoped-contracts.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';
import { ratingScopedDigest } from '../../src/ratings/scoped/protocol-registry.js';
import { RatingCategoryManagementAuthorityFacade } from '../../src/authorization/rating-category-management.facade.js';
import { CampusRatingScopedContextFacade } from '../../src/campus/rating-scoped-context.facade.js';
import { RatingScopedReleaseRepository } from '../../src/ratings/scoped/release.repository.js';
import { RatingCategorySourceIssuer } from '../../src/ratings/category-management/source-issuer.js';

export const categoryManagementPrefix = '/v2/ratings/category-management';
export async function seedCategoryManagementSource(
  tx: PoolClient,
  input: {
    kind:
      'native_scoped_category_management' | 'scoped_category_system_registry';
    key: string;
    scopeKeys: readonly string[];
    payload: Record<string, unknown>;
  },
) {
  assert.equal(
    (
      await tx.query(
        "SELECT 1 FROM whaleu_ratings.scope_protocol_versions WHERE phase='adopted' LIMIT 1",
      )
    ).rowCount,
    0,
    'Initial synthetic issuance must precede activation',
  );
  const id = randomUUID(),
    revision = randomUUID(),
    keys = [...new Set(input.scopeKeys)].sort();
  await tx.query(
    `INSERT INTO whaleu_ratings.scoped_source_attestations
    (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
    VALUES($1,$2,$3,$4,$5::text[],$6::jsonb,
      whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind',$3::text,'key',$4::text,'scopeKeys',$5::text[],'payload',$6::jsonb)),
      'complete','accepted','synthetic-scoped-issuer','synthetic-management:'||$1::text,'synthetic-category-management-policy',clock_timestamp(),clock_timestamp()+interval '30 minutes')`,
    [id, revision, input.kind, input.key, keys, canonicalJson(input.payload)],
  );
  await tx.query(
    'INSERT INTO whaleu_ratings.scoped_source_heads(source_kind,source_key,source_id,source_revision) VALUES($1,$2,$3,$4)',
    [input.kind, input.key, id, revision],
  );
  return { id, revision };
}
/** Rebuild the exact real before-domain after an adversary changes claimed scope.
 * These are current source/head facts, not arbitrary or stale fixture vectors. */
export function categoryPlanBefore(
  plan: CategoryManagementPlan,
  snapshot: CategorySnapshot,
  scopeKeys: string[],
) {
  plan.affectedScopeKeys = [...scopeKeys].sort();
  plan.beforeHeads = snapshot.heads.filter((h) =>
    scopeKeys.includes(h.scopeKey),
  );
  plan.beforeBaseAvailability = [
    ...new Map(
      snapshot.categories
        .filter((r) => scopeKeys.includes(r.scopeKey))
        .map((r) => [
          r.expected.baseSourceId,
          {
            sourceId: r.expected.baseSourceId,
            sourceRevision: r.expected.baseSourceRevision,
            current:
              !!r.baseBody &&
              !snapshot.reviewBlockedSourceIds?.includes(
                r.expected.baseSourceId,
              ),
          },
        ]),
    ).values(),
  ].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  plan.beforeCompatHeads = (snapshot.compatHeads ?? []).filter((head) =>
    head.scopeKeys.some((key) => scopeKeys.includes(key)),
  );
  const sources = snapshot.sources.filter((s) =>
    s.scope_keys.some((key) => scopeKeys.includes(key)),
  );
  plan.beforeVector = sources
    .map((s) => ({
      id: s.id,
      revision: s.revision,
      kind: s.source_kind,
      key: s.source_key,
      digest: s.digest,
    }))
    .sort((a, b) =>
      a.kind < b.kind
        ? -1
        : a.kind > b.kind
          ? 1
          : a.key < b.key
            ? -1
            : a.key > b.key
              ? 1
              : 0,
    );
  plan.beforeDigest = ratingScopedDigest('category-before', {
    heads: plan.beforeHeads,
    vector: plan.beforeVector,
  });
  plan.validUntil = new Date(
    Math.min(
      snapshot.validUntil,
      ...sources.map((s) => s.valid_until.getTime()),
    ),
  ).toISOString();
}
/** A second independent pre-C base for one stable category, with distinct source
 * and placement keys. The shared fixture's issueBase intentionally has one key. */
async function parallelBase(
  f: RatingScopedFixture,
  original: RatingScopedSyntheticCategory,
  input: {
    campusId: string;
    name?: string;
    identityId?: string;
    active?: boolean;
    hidden?: boolean;
    ordinal: string;
  },
): Promise<RatingScopedSyntheticCategory> {
  assert.equal(
    original.envelope.purpose,
    'publish_rating_category_base_scoped',
  );
  if (original.envelope.purpose !== 'publish_rating_category_base_scoped')
    assert.fail();
  const id = randomUUID(),
    revision = randomUUID(),
    categoryId = original.categoryId,
    identityId = input.identityId ?? original.identityId;
  const scopeKeys = [`campus:${input.campusId}`],
    placement = { kind: 'campuses' as const, campusIds: [input.campusId] };
  const key = `parallel-base:${categoryId}:${input.campusId}`,
    body = {
      ...original.envelope.body,
      name: input.name ?? original.envelope.body.name,
    };
  const issuanceDigest = ratingScopedDigest('issuance', {
    id,
    revision,
    kind: 'scoped_category_base',
    key,
    scopeKeys,
    categoryId,
    identityId,
    body,
    placement,
  });
  const envelope = canonicalRatingScopedEnvelope({
    ...original.envelope,
    sourceId: id,
    sourceRevision: revision,
    identityId,
    issuanceId: id,
    issuanceDigest,
    placement,
    body,
  });
  if (envelope.purpose !== 'publish_rating_category_base_scoped') assert.fail();
  const placementRevision = randomUUID();
  const source = await withCommunityScopeWriter(f.pool, async (tx) => {
    assert.equal(
      (
        await tx.query(
          "SELECT 1 FROM whaleu_ratings.scope_protocol_versions WHERE phase='adopted' LIMIT 1",
        )
      ).rowCount,
      0,
    );
    const approved = await writeRatingScopedApproval(tx, envelope);
    const source = await writeRatingScopedSource(tx, {
      id,
      revision,
      kind: 'scoped_category_base',
      key,
      scopeKeys,
      payload: {
        reviewEnvelope: envelope,
        issuanceDigest,
        active: input.active ?? true,
        hidden: input.hidden ?? false,
        ordinal: input.ordinal,
        originKind: 'regional',
      },
    });
    await tx.query(
      `INSERT INTO whaleu_community.rating_scoped_category_source_bindings
      (decision_id,account_id,operation,digest,envelope,envelope_version,source_id,source_revision,category_id,issuance_id,issuance_digest)
      VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,$9,$10)`,
      [
        approved.decisionId,
        envelope.accountId,
        envelope.purpose,
        approved.digest,
        canonicalJson(envelope),
        id,
        revision,
        categoryId,
        envelope.issuanceId,
        envelope.issuanceDigest,
      ],
    );
    const scoped = await writeRatingScopedSource(tx, {
      kind: 'scoped_category_scope',
      key: `parallel-placement:${categoryId}:${input.campusId}`,
      scopeKeys,
      payload: {
        categoryId,
        baseSourceId: id,
        baseSourceRevision: revision,
        placementRevision,
        placement,
        scopeKeys,
      },
    });
    await tx.query(
      `INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision)
      VALUES($1,$2,$3,$4,$5::text[],$6,$7)`,
      [
        placementRevision,
        categoryId,
        id,
        revision,
        scopeKeys,
        scoped.id,
        scoped.revision,
      ],
    );
    return source;
  });
  return {
    categoryId,
    identityId,
    source,
    envelope,
    placementRevision,
    scopeKeys,
  };
}
export async function ratingCategoryManagementFixture(
  options: {
    policy?: 'enabled' | 'disabled' | 'missing';
    adversarialCatalog?: boolean;
    legacyLifecycles?: boolean;
    equalViews?: boolean;
    multiBases?: boolean;
    legacyBridge?: boolean;
    reviewPreview?: boolean;
  } = {},
) {
  const f = await ratingScopedFixture();
  try {
    const admin = f.creator;
    await f.grant(admin, 'super_admin');
    const data = await f.seedScopedCatalogs({ different: false });
    const solo = options.adversarialCatalog
      ? await f.issueBase({
          name: 'A-only adversarial root',
          scopeKeys: [`campus:${f.campusA}`],
          ordinal: '2',
        })
      : null;
    const child = solo
      ? await f.issueBase({
          name: 'A-only adversarial child',
          scopeKeys: solo.scopeKeys,
          parentId: solo.categoryId,
          level: 2,
          ordinal: '3',
        })
      : null;
    const legacyCases: {
      shape: 'per_view' | 'multi_scope';
      operation:
        | 'edit_category_base_scoped'
        | 'set_category_scope_scoped'
        | 'set_category_lifecycle_scoped';
      category: RatingScopedSyntheticCategory;
      sources: RatingScopedSyntheticSource[];
    }[] = [];
    if (options.legacyLifecycles)
      for (const shape of ['per_view', 'multi_scope'] as const)
        for (const operation of [
          'edit_category_base_scoped',
          'set_category_scope_scoped',
          'set_category_lifecycle_scoped',
        ] as const) {
          const category = await f.issueBase({
            name: `Old lifecycle ${shape} ${operation}`,
            scopeKeys: [`campus:${f.campusA}`, `campus:${f.campusB}`],
            ordinal: String(10 + legacyCases.length),
          });
          const sources =
            shape === 'per_view'
              ? [
                  await f.lifecycle(category, f.campusA, false, false),
                  await f.lifecycle(category, f.campusB, true, false),
                ]
              : [
                  await f.issueSource({
                    kind: 'scoped_category_lifecycle',
                    key: `legacy-shared-lifecycle:${category.categoryId}`,
                    scopeKeys: category.scopeKeys,
                    payload: {
                      categoryId: category.categoryId,
                      baseSourceId: category.source.id,
                      baseSourceRevision: category.source.revision,
                      active: false,
                      hidden: true,
                    },
                  }),
                ];
          legacyCases.push({ shape, operation, category, sources });
        }
    const multiBaseCases: {
      mismatch:
        | 'none'
        | 'identity'
        | 'body'
        | 'active'
        | 'hidden'
        | 'ordinal'
        | 'state';
      a: RatingScopedSyntheticCategory;
      b: RatingScopedSyntheticCategory;
      dependencies: RatingScopedSyntheticSource[];
    }[] = [];
    if (options.multiBases)
      for (const mismatch of [
        'none',
        'identity',
        'body',
        'active',
        'hidden',
        'ordinal',
        'state',
      ] as const) {
        const ordinal = String(30 + multiBaseCases.length * 2);
        const a = await f.issueBase({
          name: `Parallel base ${mismatch}`,
          scopeKeys: [`campus:${f.campusA}`],
          ordinal,
        });
        const b = await parallelBase(f, a, {
          campusId: f.campusB,
          ordinal:
            mismatch === 'ordinal' ? String(Number(ordinal) + 1) : ordinal,
          ...(mismatch === 'identity' ? { identityId: randomUUID() } : {}),
          ...(mismatch === 'body' ? { name: 'Different shared body' } : {}),
          ...(mismatch === 'active' ? { active: false } : {}),
          ...(mismatch === 'hidden' ? { hidden: true } : {}),
        });
        const dependencies: RatingScopedSyntheticSource[] = [];
        if (mismatch === 'none')
          dependencies.push(
            await f.override(a, f.campusA, 'A parallel override'),
            await f.override(b, f.campusB, 'B parallel override'),
            await f.lifecycle(a, f.campusA, false, true),
            await f.lifecycle(b, f.campusB, true, true),
            await f.order(a, f.campusA, '60'),
            await f.order(b, f.campusB, '61'),
          );
        if (mismatch === 'state')
          dependencies.push(await f.lifecycle(b, f.campusB, false, false));
        multiBaseCases.push({ mismatch, a, b, dependencies });
      }
    if (solo || legacyCases.length || multiBaseCases.length)
      await f.declareAll();
    if (multiBaseCases.length)
      await f.declareScope(`campus:${f.campusB}`, {
        categoryIds: [
          data.local.categoryId,
          data.second.categoryId,
          ...legacyCases.map((item) => item.category.categoryId),
          ...multiBaseCases.map((item) => item.a.categoryId),
        ].sort(),
      });
    const overrideB = options.equalViews
      ? null
      : await f.override(data.local, f.campusB, 'Exact campus B override');
    const previewOverride =
      options.reviewPreview && child
        ? await f.override(
            child,
            f.campusA,
            'Previously approved secret set-name',
            'Previously approved secret set-description',
          )
        : null;
    await f.issueSource({
      kind: 'native_scoped_create',
      key: 'synthetic-management-target-create',
      scopeKeys: f.scopeKeys,
      payload: {
        enabled: true,
        genericKind: 'general',
        scopeKeys: f.scopeKeys,
      },
    });
    if (options.legacyBridge)
      for (const logical of f.logicalScopeKeys) {
        const scopeKeys =
          logical === 'global'
            ? ['global']
            : f.scope.topology.assignments
                .filter((c) => c.isActive && c.regionId === logical)
                .map((c) => `campus:${c.campusId}`)
                .sort();
        await f.issueSource({
          kind: 'native_v1_compat_write',
          key: logical,
          scopeKeys,
          payload: {
            policyVersion: 'native-v1-compat-write-v1',
            enabled: true,
            logicalScopeKey: logical,
            scopeKeys,
            operations: ['create_categories'],
            placementPolicy: 'exact_legacy_domain',
            categoryPolicy: 'append_native_only',
          },
        });
      }
    await withCommunityScopeWriter(f.pool, async (tx) => {
      if (options.policy !== 'missing')
        await seedCategoryManagementSource(tx, {
          kind: 'native_scoped_category_management',
          key: 'synthetic-category-management',
          scopeKeys: f.scopeKeys,
          payload: {
            enabled: options.policy !== 'disabled',
            operations: [...ratingCategoryScopedOperations],
          },
        });
      await seedCategoryManagementSource(tx, {
        kind: 'scoped_category_system_registry',
        key: 'synthetic-known-registry',
        scopeKeys: f.scopeKeys,
        payload: {
          enabled: true,
          systemKey: 'synthetic_general',
          kind: 'general',
          consumer: 'ratings_general_v1',
          maximumDepth: 3,
          allowChildren: true,
          allowDisable: true,
          allowCampusOverride: true,
        },
      });
      await seedCategoryManagementSource(tx, {
        kind: 'scoped_category_system_registry',
        key: 'synthetic-unknown-consumer',
        scopeKeys: f.scopeKeys,
        payload: {
          enabled: true,
          systemKey: 'synthetic_unknown',
          kind: 'general',
          consumer: 'unknown_consumer',
          maximumDepth: 3,
          allowChildren: true,
          allowDisable: true,
          allowCampusOverride: true,
        },
      });
      if (options.adversarialCatalog)
        for (const [systemKey, restrictions] of [
          ['synthetic_no_disable', { allowDisable: false }],
          ['synthetic_no_children', { allowChildren: false }],
          ['synthetic_no_override', { allowCampusOverride: false }],
          ['synthetic_configured_depth', {}],
        ] as const)
          await seedCategoryManagementSource(tx, {
            kind: 'scoped_category_system_registry',
            key: systemKey,
            scopeKeys: f.scopeKeys,
            payload: {
              enabled: true,
              systemKey,
              kind: 'general',
              consumer: 'ratings_general_v1',
              maximumDepth: 3,
              allowChildren: true,
              allowDisable: true,
              allowCampusOverride: true,
              ...restrictions,
            },
          });
    });
    await f.publish({ activate: true });
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const post = (actor: Actor, route: string, body: object) =>
      f
        .auth(
          request(f.http).post(`${categoryManagementPrefix}/${route}`),
          actor,
        )
        .send(body);
    const context = async (
      actor: Actor,
      selector: RatingNavigationSelector = {
        kind: 'campus',
        campusId: f.campusA,
      },
    ) => {
      const response = await post(actor, 'contexts', { selector });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return ratingCategoryManagementContextSchema.parse(response.body);
    };
    const makeIntent = (
      current: ReturnType<typeof ratingCategoryManagementContextSchema.parse>,
      operation: RatingCategoryScopedOperation,
      payload: Record<string, unknown>,
    ) =>
      ratingCategoryScopedIntentSchema.parse({
        protocolVersion: 2,
        operation,
        context: current.commandContext,
        payload: {
          clientRequestId: randomUUID(),
          expectedSnapshot: current.snapshotRevision,
          ...payload,
        },
      });
    const prepare = async (actor: Actor, input: RatingCategoryScopedIntent) => {
      const response = await post(actor, 'prepare', input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return ratingCategoryScopedPreparationSchema.parse(response.body);
    };
    const storedPlan = async (
      actor: Actor,
      input: RatingCategoryScopedIntent,
    ) => {
      const row = (
        await f.pool.query<{
          category_plan: CategoryManagementPlan;
          context_revision: string;
        }>(
          'SELECT category_plan,context_revision FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0];
      assert(
        row,
        'Approval must consume a real persisted category preparation',
      );
      return row;
    };
    const approve = async (actor: Actor, input: RatingCategoryScopedIntent) => {
      const stored = await storedPlan(actor, input);
      return withCommunityScopeWriter(f.pool, async (tx) => {
        const decisions: Awaited<
          ReturnType<typeof writeRatingScopedApproval>
        >[] = [];
        for (const raw of stored.category_plan.envelopes)
          decisions.push(
            await writeRatingScopedApproval(
              tx,
              canonicalRatingScopedEnvelope(raw),
            ),
          );
        return decisions;
      });
    };
    const commit = (
      actor: Actor,
      input: RatingCategoryScopedIntent,
      contextRevision: string,
    ) =>
      post(actor, 'commit', {
        intent: input,
        preparationContextRevision: contextRevision,
      });
    const execute = async (actor: Actor, input: RatingCategoryScopedIntent) => {
      const prepared = await prepare(actor, input);
      const decisions = await approve(actor, input);
      const response = await commit(actor, input, prepared.contextRevision);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const receipt = ratingCategoryScopedReceiptSchema.parse(response.body);
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      return { prepared, decisions, receipt };
    };
    const exactGrant = async (
      actor: Actor,
      campusId: string,
      options: { validFrom?: Date; expiresAt?: Date } = {},
    ) => {
      const id = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_authorization.rating_category_campus_grants
        (id,account_id,campus_id,approved_by_account_id,approval_reference,valid_from,expires_at)
        VALUES($1,$2,$3,$4,'synthetic-exact-classification-only',coalesce($5,clock_timestamp()-interval '1 second'),$6)`,
          [
            id,
            actor.accountId,
            campusId,
            admin.accountId,
            options.validFrom ?? null,
            options.expiresAt ?? null,
          ],
        ),
      );
      return id;
    };
    const artifacts = async () =>
      (
        await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
      'sources',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM whaleu_ratings.scoped_source_attestations s),
      'sourceHeads',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY source_kind,source_key),'[]') FROM whaleu_ratings.scoped_source_heads s),
      'catalogHeads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY scope_key),'[]') FROM whaleu_ratings.scoped_catalog_heads h),
      'compatHeads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY scope_key),'[]') FROM whaleu_ratings.catalog_heads h),
      'releases',(SELECT count(*) FROM whaleu_ratings.scoped_releases),
      'placements',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY placement_revision),'[]') FROM whaleu_ratings.category_scope_placements p),
      'targets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') FROM whaleu_ratings.targets t),
      'targetPlacements',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY placement_revision),'[]') FROM whaleu_ratings.target_scope_placements p),
      'bindings',(SELECT count(*) FROM whaleu_community.rating_scoped_category_source_bindings),
      'reviewDecisions',(SELECT count(*) FROM whaleu_community.rating_approval_decisions),
      'reviewEvents',(SELECT count(*) FROM whaleu_community.rating_approval_events),
      'effects',(SELECT count(*) FROM whaleu_ratings.effect_events),
      'sourceEpoch',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton),
      'reviewEpoch',(SELECT epoch FROM whaleu_community.rating_review_binding_epoch WHERE singleton)
    ) value`)
      ).rows[0]!.value;
    const ledger = async () =>
      (
        await f.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
      'claims',(SELECT count(*) FROM whaleu_ratings.command_claims),
      'preparations',(SELECT count(*) FROM whaleu_ratings.scoped_command_preparations),
      'requests',(SELECT count(*) FROM whaleu_ratings.requests),
      'outcomes',(SELECT count(*) FROM whaleu_ratings.scoped_command_outcomes),
      'causes',(SELECT count(*) FROM whaleu_ratings.scoped_command_causes)) value`)
      ).rows[0]!.value;
    const rejectSql = async (
      label: string,
      work: (tx: PoolClient) => Promise<unknown>,
    ) => {
      const before = { artifacts: await artifacts(), ledger: await ledger() };
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          await work(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        }),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23514',
        label,
      );
      assert.deepEqual(
        { artifacts: await artifacts(), ledger: await ledger() },
        before,
        `${label}: full transaction and owner epochs must roll back`,
      );
    };
    // Fresh exact plans use the same real reader/planner as service preparation;
    // hostile mutations are inserted through all normal SQL guards and claims.
    const rawPrepare = async (
      tx: PoolClient,
      actor: Actor,
      input: RatingCategoryScopedIntent,
      mutate: (
        plan: CategoryManagementPlan,
        actual: CategorySnapshot,
      ) => void = () => {},
      dummyTarget = false,
      planning: {
        seedIntent?: RatingCategoryScopedIntent;
        allowInMemory?: (snapshot: CategorySnapshot) => void;
      } = {},
    ) => {
      const selector = input.context.selector;
      const snapshot = await f.app
        .get(RatingCategoryManagementReader)
        .snapshot(
          selector.kind === 'global' ? 'global' : `campus:${selector.campusId}`,
          tx,
        );
      const seed = planning.seedIntent ?? input;
      assert.equal(seed.operation, input.operation);
      assert.equal(seed.payload.clientRequestId, input.payload.clientRequestId);
      assert.deepEqual(seed.context, input.context);
      const permitted = structuredClone(snapshot);
      // Only the candidate planner's in-memory inputs change. PostgreSQL sees
      // the real registry, real parent depth and actual typed hostile intent.
      planning.allowInMemory?.(permitted);
      const hash = ratingCategoryScopedIntentHash(input),
        plan = planCategoryManagement(actor.accountId, seed, hash, permitted);
      mutate(plan, snapshot);
      plan.previewDigest = ratingScopedDigest('category-plan', {
        ...plan,
        previewDigest: '',
      });
      const contextRevision = randomBytes(32).toString('base64url');
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_command_preparations
        (account_id,request_id,operation,intent_hash,intent,context_id,session_id,context_revision,before_state,envelope,policy_source_id,policy_source_revision,valid_until,command_family,category_plan,target_id)
        SELECT $1,$2,$3,$4,$5::jsonb,c.id,c.session_id,$6,$7::jsonb,NULL,$8,$9,least(c.valid_until,$10::timestamptz),'category',$11::jsonb,$12::uuid
        FROM whaleu_ratings.scoped_contexts c WHERE c.id=$13 AND c.account_id=$1`,
        [
          actor.accountId,
          input.payload.clientRequestId,
          input.operation,
          hash,
          canonicalJson(input),
          contextRevision,
          canonicalJson({
            heads: plan.beforeHeads,
            vector: plan.beforeVector,
            digest: plan.beforeDigest,
          }),
          plan.policySourceId,
          plan.policySourceRevision,
          plan.validUntil,
          canonicalJson(plan),
          dummyTarget ? randomUUID() : null,
          input.context.id,
        ],
      );
      return { plan, contextRevision };
    };
    const execution = async (
      tx: PoolClient,
      actor: Actor,
      input: RatingCategoryScopedIntent,
    ) => {
      await tx.query(
        'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
        [
          actor.accountId,
          input.payload.clientRequestId,
          input.operation,
          ratingCategoryScopedIntentHash(input),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof)
        SELECT account_id,request_id,'category_execution',context_id,context_id,jsonb_build_object('intentHash',intent_hash,'planDigest',category_plan->>'previewDigest','contextRevision',context_revision,
          'executionDigest',whaleu_ratings.scoped_digest('category-execution',jsonb_build_object('accountId',account_id,'requestId',request_id,'planDigest',category_plan->>'previewDigest')))
        FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2`,
        [actor.accountId, input.payload.clientRequestId],
      );
    };
    const insertManagedSource = async (
      tx: PoolClient,
      plan: CategoryManagementPlan,
      item: CategorySourceIssue,
      issuer = 'ratings-category-management',
    ) => {
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_source_attestations
        (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
        SELECT $1,$2,$3,$4,$5::text[],$6::jsonb,whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind',$3::text,'key',$4::text,'scopeKeys',$5::text[],'payload',$6::jsonb)),
        'complete','accepted',$11,$7,p.policy_reference,clock_timestamp(),$8::timestamptz FROM whaleu_ratings.scoped_source_attestations p WHERE p.id=$9 AND p.revision=$10`,
        [
          item.id,
          item.revision,
          item.kind,
          item.key,
          item.scopeKeys,
          canonicalJson(item.payload),
          issuer === 'ratings-category-management'
            ? `rating-category-management:${plan.accountId}:${plan.requestId}`
            : `synthetic-unprivileged-source:${item.id}`,
          plan.validUntil,
          plan.policySourceId,
          plan.policySourceRevision,
          issuer,
        ],
      );
    };
    /** Complete a raw prepared/executing command using the real issuer and
     * owner-branded publisher, including its exact final cause and receipt. */
    const finishRaw = async (
      tx: PoolClient,
      actor: Actor,
      input: RatingCategoryScopedIntent,
      plan: CategoryManagementPlan,
    ) => {
      const authority = await f.app
        .get(RatingCategoryManagementAuthorityFacade)
        .resolve(actor.accountId, tx);
      const domains = await f.app
        .get(CampusRatingScopedContextFacade)
        .resolveCategoryManagementDomains(
          { accountId: actor.accountId },
          plan.affectedScopeKeys.map((key) =>
            key === 'global'
              ? ({ kind: 'global' } as const)
              : ({ kind: 'campus', campusId: key.slice(7) } as const),
          ),
          authority,
          tx,
        );
      await f.app.get(RatingCategorySourceIssuer).issue(plan, tx);
      const release = await f.app
        .get(RatingScopedReleaseRepository)
        .publishMany(
          domains,
          {
            kind: 'category_management',
            accountId: actor.accountId,
            requestId: input.payload.clientRequestId,
          },
          tx,
        );
      const heads = release.outputs.map((output) => ({
        scopeKey: output.scopeKey,
        catalogRevision: output.id,
        headRevision: output.headRevision,
      }));
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof)
        VALUES($1,$2,'category_release',$3,$3,$4::jsonb)`,
        [
          actor.accountId,
          input.payload.clientRequestId,
          release.releaseId,
          canonicalJson({ planDigest: plan.previewDigest, heads }),
        ],
      );
      const occurredAt = (
        await tx.query<{ at: Date }>('SELECT clock_timestamp() at')
      ).rows[0]!.at.toISOString();
      const result = {
        releaseId: release.releaseId,
        categoryIds: plan.categoryIds,
        heads,
        occurredAt,
      };
      const receipt = ratingCategoryScopedReceiptSchema.parse({
        protocolVersion: 2,
        requestId: input.payload.clientRequestId,
        operation: input.operation,
        intentHash: plan.intentHash,
        outcome: 'applied',
        result,
      });
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_command_outcomes(account_id,request_id,operation,intent_hash,intent,outcome,result)
        VALUES($1,$2,$3,$4,$5::jsonb,'applied',$6::jsonb)`,
        [
          actor.accountId,
          input.payload.clientRequestId,
          input.operation,
          plan.intentHash,
          canonicalJson(input),
          canonicalJson(result),
        ],
      );
      await tx.query(
        'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
        [
          actor.accountId,
          input.payload.clientRequestId,
          canonicalJson(receipt),
        ],
      );
      return receipt;
    };
    return {
      ...f,
      admin,
      data,
      solo,
      child,
      legacyCases,
      multiBaseCases,
      overrideB,
      previewOverride,
      managementPost: post,
      managementContext: context,
      managementIntent: makeIntent,
      prepareManagement: prepare,
      approveManagement: approve,
      commitManagement: commit,
      executeManagement: execute,
      managementPlan: storedPlan,
      exactCategoryGrant: exactGrant,
      managementArtifacts: artifacts,
      managementLedger: ledger,
      rejectCategorySql: rejectSql,
      rawCategoryPreparation: rawPrepare,
      rawCategoryExecution: execution,
      finishRawCategoryExecution: finishRaw,
      insertManagedSource,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
export type RatingCategoryManagementFixture = Awaited<
  ReturnType<typeof ratingCategoryManagementFixture>
>;
