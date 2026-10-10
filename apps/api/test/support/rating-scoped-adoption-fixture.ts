/** Opaque adoption fixtures issue evidence, not effective/projection rows. All
 * original catalog/category/target records and normal guards remain intact. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import request from 'supertest';
import {
  type RatingScopedFixture,
  writeRatingScopedApproval,
  writeRatingScopedSource,
} from './rating-scoped-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import { ratingScopedDigest } from '../../src/ratings/scoped/protocol-registry.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from './rating-scoped-command-fixture.js';
import { ratingScopedEditContextSchema } from '../../src/ratings/scoped/controller.js';
import {
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
  type RatingNavigationSelector,
} from '../../src/ratings/scoped/contracts.js';

export interface SyntheticOpaqueCategory {
  catalog_id: string;
  id: string;
  revision: string;
  parent_id: string | null;
  level: 1 | 2 | 3;
  origin_kind: 'global' | 'regional';
  kind: 'general';
  system_key: null;
  name: string;
  description: string;
  active: boolean;
  hidden: boolean;
  ordinal: number | string;
}
export interface SyntheticAdoptionIdentity {
  entityKind: 'category' | 'target';
  legacyBusinessId: string;
  identityId: string;
  sourceRowDigest: string;
}
export type SyntheticAdoptionAttack =
  | 'crosswalk'
  | 'row_digest'
  | 'alias_source'
  | 'alias_digest'
  | 'missing_alias'
  | 'missing_review'
  | 'wrong_identity';
const keys = (values: readonly string[]) => [...new Set(values)].sort();
const placement = (scopeKeys: readonly string[]) => {
  const sorted = keys(scopeKeys);
  if (sorted.length === 1 && sorted[0] === 'global')
    return { kind: 'global' as const };
  assert.ok(
    sorted.length > 0 && sorted.every((key) => key.startsWith('campus:')),
  );
  return {
    kind: 'campuses' as const,
    campusIds: sorted.map((key) => key.slice(7)),
  };
};
export async function prepareSyntheticOpaqueAdoption(
  f: RatingScopedFixture,
  legacyCatalogId: string,
  categoryId: string,
  scopeKeys: readonly string[],
) {
  const category = (
    await f.pool.query<SyntheticOpaqueCategory>(
      'SELECT * FROM whaleu_ratings.categories WHERE catalog_id=$1 AND id=$2',
      [legacyCatalogId, categoryId],
    )
  ).rows[0];
  assert.ok(category, 'A real immutable legacy category is required');
  assert.equal(category.kind, 'general');
  assert.equal(category.system_key, null);
  const ids = (
    await f.pool.query<{ source_row_digest: string }>(
      "SELECT whaleu_ratings.scoped_digest('legacy-category',to_jsonb(c)) source_row_digest FROM whaleu_ratings.categories c WHERE catalog_id=$1 AND id=$2",
      [legacyCatalogId, categoryId],
    )
  ).rows[0]!;
  const identityId = randomUUID(),
    sourceId = randomUUID(),
    sourceRevision = randomUUID(),
    scope = keys(scopeKeys),
    place = placement(scope);
  const body = {
    parentId: category.parent_id,
    level: category.level,
    kind: category.kind,
    systemKey: category.system_key,
    name: category.name,
    description: category.description,
  };
  const key = `adoption-review:${legacyCatalogId}:${categoryId}:${scope.join(',')}`;
  const issuanceDigest = ratingScopedDigest('issuance', {
    id: sourceId,
    revision: sourceRevision,
    kind: 'scoped_category_base',
    key,
    scopeKeys: scope,
    categoryId,
    identityId,
    body,
    placement: place,
  });
  const envelope = canonicalRatingScopedEnvelope({
    version: 5,
    purpose: 'publish_rating_category_base_scoped',
    accountId: f.creator.accountId,
    sourceId,
    sourceRevision,
    categoryId,
    identityId,
    issuanceId: sourceId,
    issuanceDigest,
    placement: place,
    assetIds: [],
    body,
  });
  if (envelope.purpose !== 'publish_rating_category_base_scoped') assert.fail();
  const reviewed = await withCommunityScopeWriter(f.pool, async (tx) => {
    const approved = await writeRatingScopedApproval(tx, envelope);
    const source = await writeRatingScopedSource(tx, {
      id: sourceId,
      revision: sourceRevision,
      kind: 'scoped_category_base',
      key,
      scopeKeys: scope,
      payload: {
        reviewEnvelope: envelope,
        issuanceDigest,
        active: category.active,
        hidden: category.hidden,
        ordinal: String(category.ordinal),
        originKind: category.origin_kind,
      },
    });
    await tx.query(
      `INSERT INTO whaleu_community.rating_scoped_category_source_bindings
      (decision_id,account_id,operation,digest,envelope,envelope_version,source_id,source_revision,category_id,issuance_id,issuance_digest)
      VALUES($1,$2,$3,$4,$5::jsonb,5,$6,$7,$8,$6,$9)`,
      [
        approved.decisionId,
        envelope.accountId,
        envelope.purpose,
        approved.digest,
        canonicalJson(envelope),
        sourceId,
        sourceRevision,
        categoryId,
        issuanceDigest,
      ],
    );
    return { source, approved };
  });
  const targets = (
    await f.pool.query<{ id: string; source_row_digest: string }>(
      `SELECT t.id,whaleu_ratings.scoped_digest('legacy-target',to_jsonb(t)) source_row_digest
    FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_memberships m ON m.target_id=t.id
    WHERE m.catalog_id=$1 AND m.category_id=$2 ORDER BY t.id`,
      [legacyCatalogId, categoryId],
    )
  ).rows;
  const identities: SyntheticAdoptionIdentity[] = [
    {
      entityKind: 'category',
      legacyBusinessId: categoryId,
      identityId,
      sourceRowDigest: ids.source_row_digest,
    },
    ...targets.map((target) => ({
      entityKind: 'target' as const,
      legacyBusinessId: target.id,
      identityId: randomUUID(),
      sourceRowDigest: target.source_row_digest,
    })),
  ];
  return {
    legacyCatalogId,
    category,
    categoryId,
    identityId,
    scopeKeys: scope,
    placement: place,
    identities,
    targets,
    envelope,
    reviewed,
  };
}
export type SyntheticOpaqueAdoption = Awaited<
  ReturnType<typeof prepareSyntheticOpaqueAdoption>
>;

export async function writeSyntheticOpaqueAdoption(
  tx: PoolClient,
  input: SyntheticOpaqueAdoption,
  attack?: SyntheticAdoptionAttack,
) {
  const manifestId = randomUUID(),
    sourceId = randomUUID(),
    sourceRevision = randomUUID();
  const crosswalk = structuredClone(input.identities);
  if (attack === 'crosswalk') crosswalk.pop();
  const digest = (
    await tx.query<{ digest: string }>(
      'SELECT whaleu_ratings.scoped_legacy_catalog_digest($1) digest',
      [input.legacyCatalogId],
    )
  ).rows[0]!.digest;
  const source = await writeRatingScopedSource(tx, {
    id: sourceId,
    revision: sourceRevision,
    kind: 'legacy_adoption',
    key: `adoption:${input.legacyCatalogId}:${input.categoryId}:${input.scopeKeys.join(',')}`,
    scopeKeys: input.scopeKeys,
    payload: {
      categoryId: input.categoryId,
      identityId: attack === 'wrong_identity' ? randomUUID() : input.identityId,
      manifestId,
      crosswalk,
      placement: input.placement,
      reviewSource: {
        kind: 'scoped_category_v5',
        sourceId:
          attack === 'missing_review' ? randomUUID() : input.reviewed.source.id,
        sourceRevision: input.reviewed.source.revision,
      },
    },
  });
  await tx.query(
    `INSERT INTO whaleu_ratings.legacy_adoption_manifests
    (id,source_id,source_revision,legacy_catalog_id,legacy_digest,scope_keys,crosswalk,placement)
    VALUES($1,$2,$3,$4,$5,$6::text[],$7::jsonb,$8::jsonb)`,
    [
      manifestId,
      sourceId,
      sourceRevision,
      input.legacyCatalogId,
      digest,
      input.scopeKeys,
      canonicalJson(crosswalk),
      canonicalJson(input.placement),
    ],
  );
  for (const identity of input.identities) {
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_adoption_identities(id,manifest_id,entity_kind,legacy_business_id,source_row_digest)
      VALUES($1,$2,$3,$4,$5)`,
      [
        identity.identityId,
        manifestId,
        identity.entityKind,
        identity.legacyBusinessId,
        attack === 'row_digest' ? '0'.repeat(64) : identity.sourceRowDigest,
      ],
    );
    if (attack === 'missing_alias') continue;
    await tx.query(
      `INSERT INTO whaleu_ratings.scoped_adoption_aliases
      (manifest_id,source_kind,source_key,source_revision,legacy_business_id,identity_id,entity_kind,source_row_digest)
      VALUES($1,'legacy_catalog',$2,$3,$4,$5,$6,$7)`,
      [
        manifestId,
        attack === 'alias_source' ? randomUUID() : input.legacyCatalogId,
        input.legacyCatalogId,
        identity.legacyBusinessId,
        identity.identityId,
        identity.entityKind,
        attack === 'alias_digest' ? '0'.repeat(64) : identity.sourceRowDigest,
      ],
    );
  }
  const placementRevision = randomUUID();
  const issued = await writeRatingScopedSource(tx, {
    kind: 'scoped_category_scope',
    key: `adoption-placement:${input.legacyCatalogId}:${input.categoryId}:${input.scopeKeys.join(',')}`,
    scopeKeys: input.scopeKeys,
    payload: {
      categoryId: input.categoryId,
      baseSourceId: sourceId,
      baseSourceRevision: sourceRevision,
      placementRevision,
      placement: input.placement,
      scopeKeys: input.scopeKeys,
    },
  });
  await tx.query(
    `INSERT INTO whaleu_ratings.category_scope_placements
    (placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision)
    VALUES($1,$2,$3,$4,$5::text[],$6,$7)`,
    [
      placementRevision,
      input.categoryId,
      sourceId,
      sourceRevision,
      input.scopeKeys,
      issued.id,
      issued.revision,
    ],
  );
  for (const target of input.targets) {
    const targetPlacement = await writeRatingScopedSource(tx, {
      kind: 'scoped_target_placement',
      key: `adoption-target:${input.legacyCatalogId}:${target.id}:${input.scopeKeys.join(',')}`,
      scopeKeys: input.scopeKeys,
      payload: {
        targetId: target.id,
        categoryId: input.categoryId,
        adoptionManifestId: manifestId,
      },
    });
    await tx.query(
      `INSERT INTO whaleu_ratings.target_scope_placements(placement_revision,target_id,scope_keys,source_id,source_revision)
      VALUES($1,$2,$3::text[],$4,$5)`,
      [
        randomUUID(),
        target.id,
        input.scopeKeys,
        targetPlacement.id,
        targetPlacement.revision,
      ],
    );
  }
  return { manifestId, source, placementRevision, input };
}

export async function writeSyntheticNativeBridge(
  tx: PoolClient,
  input: {
    legacyCatalogId: string;
    categoryId: string;
    categoryRevision: string;
    scopeKeys: readonly string[];
  },
) {
  const scopeKeys = keys(input.scopeKeys),
    place = placement(scopeKeys);
  const bridge = await writeRatingScopedSource(tx, {
    kind: 'm3a_native_bridge',
    key: `native-bridge:${input.legacyCatalogId}:${input.categoryId}`,
    scopeKeys,
    payload: {
      legacyCatalogId: input.legacyCatalogId,
      categoryId: input.categoryId,
      categoryRevision: input.categoryRevision,
    },
  });
  const placementRevision = randomUUID();
  const issued = await writeRatingScopedSource(tx, {
    kind: 'scoped_category_scope',
    key: `native-bridge-placement:${input.categoryId}`,
    scopeKeys,
    payload: {
      categoryId: input.categoryId,
      baseSourceId: bridge.id,
      baseSourceRevision: bridge.revision,
      placementRevision,
      placement: place,
      scopeKeys,
    },
  });
  await tx.query(
    `INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision)
    VALUES($1,$2,$3,$4,$5::text[],$6,$7)`,
    [
      placementRevision,
      input.categoryId,
      bridge.id,
      bridge.revision,
      scopeKeys,
      issued.id,
      issued.revision,
    ],
  );
  return { bridge, placementRevision };
}

export async function editSyntheticAdoptedTarget(
  f: RatingScopedFixture,
  targetId: string,
  selector: RatingNavigationSelector,
  name: string,
) {
  const actor = f.creator;
  const context = await f.scopedContext(actor, selector, 'edit_target');
  const current = await f
    .auth(
      request(f.http).get(
        `/v2/ratings/management/owner-edit/targets/${targetId}/context`,
      ),
      actor,
    )
    .query({ contextId: context.id, contextToken: context.token });
  assert.equal(current.status, 200, JSON.stringify(current.body));
  const state = ratingScopedEditContextSchema.parse(current.body);
  const input = ratingScopedIntentSchema.parse({
    protocolVersion: 2,
    operation: 'edit_target_scoped',
    context: scopedCommandContext(context),
    payload: {
      clientRequestId: randomUUID(),
      targetId,
      expectedTargetRevision: state.revision,
      expectedDefinitionRevision: state.definitionRevision,
      expectedContentVersion: state.contentVersion,
      categoryId: state.categoryId,
      expectedCategoryRevision: state.categoryRevision,
      name,
      description: state.description,
      assetIds: [],
    },
  });
  const preparedResponse = await f
    .auth(
      request(f.http).post('/v2/ratings/management/owner-edit/prepare'),
      actor,
    )
    .send(input);
  assert.equal(
    preparedResponse.status,
    200,
    JSON.stringify(preparedResponse.body),
  );
  const prepared = ratingScopedPreparationSchema.parse(preparedResponse.body);
  const persisted = (
    await f.pool.query(
      'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
      [actor.accountId, input.payload.clientRequestId],
    )
  ).rows[0]!;
  const approved = await f.approveScoped(
    canonicalRatingScopedEnvelope(persisted.envelope),
  );
  const committed = await f
    .auth(
      request(f.http).post('/v2/ratings/management/owner-edit/commit'),
      actor,
    )
    .send({ ...input, preparationContextRevision: prepared.contextRevision });
  assert.equal(committed.status, 200, JSON.stringify(committed.body));
  return {
    state,
    input,
    prepared,
    approved,
    receipt: scopedSuccess(committed.body),
  };
}
