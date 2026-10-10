import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { campusCountProofOwner } from './count-epochs.js';
import {
  assertRatingCategoryManagementAuthority,
  requireRatingCategoryManagementAuthority,
} from '../authorization/rating-category-management.facade.js';
import type { RatingCategoryManagementAuthority } from '../authorization/rating-category-management.facade.js';
import type { RatingGrantScope } from '../authorization/rating-grants.facade.js';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
  requiredOwnerEpoch,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
  transactionReadEpoch,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { CampusCommunityPolicyService } from './community-policy/campus-community-policy.service.js';
import type {
  PublicationAffiliationMetadata,
  IdentityCampusResolution,
} from './community-policy/contracts.js';
import {
  knownRegion,
  parseTopology,
  earliestDeadline,
} from './community-policy/fact-validation.js';
import type { Topology } from './community-policy/fact-validation.js';

export const RATING_SCOPED_CAMPUS_LIMIT = 1000;
export const RATING_SCOPED_REGION_LIMIT = 200;
const id = z.uuid().refine((value) => value === value.toLowerCase());
const navigationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('campus'), campusId: id }),
]);
const randomSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({
    kind: z.literal('institution_with_global'),
    anchorCampusId: id,
  }),
]);
const compatSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global_compat') }),
  z.strictObject({ kind: z.literal('region_compat'), regionId: id }),
]);
export type RatingNavigationSelector = z.infer<typeof navigationSchema>;
export type RatingRandomCandidateSelector = z.infer<typeof randomSchema>;
export type RatingLegacyCompatSelector = z.infer<typeof compatSchema>;
export interface RatingScopedActor {
  readonly accountId: string;
  readonly affiliation: PublicationAffiliationMetadata | null;
}
export interface RatingScopedCampusMapping {
  readonly campusId: string;
  readonly institutionId: string;
  readonly regionId: string;
  readonly isActive: boolean;
}
declare const scopeBrand: unique symbol;
export interface RatingScopedCampusProof {
  readonly [scopeBrand]: true;
  readonly kind: 'navigation' | 'random' | 'legacy_compat';
  readonly selector:
    | RatingNavigationSelector
    | RatingRandomCandidateSelector
    | RatingLegacyCompatSelector;
  readonly scopeKeys: readonly string[];
  readonly campusIds: readonly string[];
  readonly mappings: readonly RatingScopedCampusMapping[];
  readonly topologyState: 'complete' | 'unknown';
  readonly topologySnapshotId: string | null;
  readonly topologyRevision: number | null;
  readonly identity: {
    readonly campusId: string;
    readonly institutionId: string;
    readonly regionId: string;
    readonly selectionId: string;
  } | null;
  readonly view: {
    readonly campusId: string;
    readonly institutionId: string;
    readonly regionId: string;
  } | null;
  readonly origin: {
    readonly institutionId: string;
    readonly regionId: string;
  } | null;
  readonly authorization: readonly {
    readonly campusId: string;
    readonly decision: 'allow' | 'deny';
  }[];
  readonly authorizationMode:
    'ordinary' | 'managed_preview' | 'category_management' | 'none';
  readonly authorizationFingerprint: string;
  readonly inventoryFingerprint: string;
  readonly fingerprint: string;
  readonly validUntil: number | null;
}
const campusEpoch = requiredOwnerEpoch(
  campusCountProofOwner,
  'IDENTITY_CAMPUS_UNAVAILABLE',
);
const handles = new WeakMap<object, { tx: PoolClient; epoch: object }>();
export function assertRatingScopedCampusProof(
  value: RatingScopedCampusProof,
  tx: PoolClient,
): void {
  const owner = handles.get(value);
  if (!owner || owner.tx !== tx || owner.epoch !== transactionReadEpoch(tx))
    unavailable();
}
function unavailable(): never {
  throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const version = z.string().regex(/^(0|[1-9][0-9]*)$/);
const regionSchema = z.strictObject({
  id,
  is_active: z.boolean(),
  state_version: version,
});
const institutionSchema = z.strictObject({ id, state_version: version });
const campusSchema = z.strictObject({
  id,
  institution_id: id,
  is_active: z.boolean(),
  state_version: version,
});
const assignmentSchema = z.strictObject({
  campus_id: id,
  operating_region_id: id,
  state_version: version,
});
const current = (a: string) =>
  `${a}.coverage_state='complete' AND ${a}.provenance_state='accepted' AND length(btrim(${a}.source_reference))>0 AND length(btrim(${a}.policy_reference))>0 AND isfinite(${a}.effective_at) AND ${a}.effective_at<=instant.now AND ((${a}.expiry_kind='policy_exempt' AND ${a}.valid_until IS NULL) OR (${a}.expiry_kind='at' AND isfinite(${a}.valid_until) AND ${a}.valid_until>${a}.effective_at AND ${a}.valid_until>instant.now))`;
interface Inventory {
  fingerprint: string;
  epochFingerprint: string;
  topology: Topology | null;
  topologySnapshotId: string | null;
  topologyRevision: number | null;
  validUntil: number | null;
  complete: boolean;
  mappings: RatingScopedCampusMapping[];
}
async function captureInventory(tx: PoolClient): Promise<Inventory> {
  // The entire inventory is bounded; LIMIT+1 is an admission failure, never
  // a partial topology. No relationship-group filter can shrink random scope.
  const heads = (
    await tx.query<{
      id: string | null;
      revision: number | null;
      topology: unknown;
      precise_until: string | null;
      valid_until: Date | null;
      next_activation: Date | null;
      valid: boolean;
      head: unknown;
      snapshot: unknown;
    }>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
     SELECT s.id,s.revision,s.topology,s.valid_until,s.valid_until::text precise_until,
       CASE WHEN isfinite(s.effective_at) AND s.effective_at>instant.now THEN s.effective_at END next_activation,
       to_jsonb(h) head,to_jsonb(s) snapshot,coalesce(${current('s')},false) valid
     FROM whaleu_campus.community_topology_heads h LEFT JOIN whaleu_campus.community_topology_snapshots s
       ON s.id=h.snapshot_id AND s.revision=h.revision CROSS JOIN instant WHERE h.scope_key='community'`,
    )
  ).rows;
  if (heads.length > 1) unavailable();
  const regions = (
    await tx.query<z.infer<typeof regionSchema>>(
      'SELECT id,is_active,xmin::text state_version FROM whaleu_campus.operating_regions ORDER BY id LIMIT 201',
    )
  ).rows;
  const institutions = (
    await tx.query<z.infer<typeof institutionSchema>>(
      'SELECT id,xmin::text state_version FROM whaleu_campus.institutions ORDER BY id LIMIT 1001',
    )
  ).rows;
  const campuses = (
    await tx.query<z.infer<typeof campusSchema>>(
      'SELECT id,institution_id,is_active,xmin::text state_version FROM whaleu_campus.campuses ORDER BY id LIMIT 1001',
    )
  ).rows;
  const assignments = (
    await tx.query<z.infer<typeof assignmentSchema>>(
      'SELECT campus_id,operating_region_id,xmin::text state_version FROM whaleu_campus.campus_region_assignments ORDER BY campus_id LIMIT 1001',
    )
  ).rows;
  if (
    regions.length > 200 ||
    institutions.length > 1000 ||
    campuses.length > 1000 ||
    assignments.length > 1000 ||
    regions.some((r) => !regionSchema.safeParse(r).success) ||
    institutions.some((r) => !institutionSchema.safeParse(r).success) ||
    campuses.some((r) => !campusSchema.safeParse(r).success) ||
    assignments.some((r) => !assignmentSchema.safeParse(r).success)
  )
    unavailable();
  const snapshot = heads[0];
  const topology = snapshot?.valid ? parseTopology(snapshot.topology) : null;
  const realRegions = new Map(regions.map((r) => [r.id, r]));
  const realInstitutions = new Set(institutions.map((r) => r.id));
  const realCampuses = new Map(campuses.map((r) => [r.id, r]));
  const realAssignments = new Map(
    assignments.map((r) => [r.campus_id, r.operating_region_id]),
  );
  if (
    realRegions.size !== regions.length ||
    realInstitutions.size !== institutions.length ||
    realCampuses.size !== campuses.length ||
    realAssignments.size !== assignments.length
  )
    unavailable();
  let complete =
    !!topology &&
    !!snapshot?.id &&
    id.safeParse(snapshot.id).success &&
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision! > 0;
  if (topology) {
    if (
      topology.regions.size !== regions.length ||
      topology.assignments.size !== campuses.length ||
      assignments.length !== campuses.length
    )
      complete = false;
    for (const group of topology.groups.values())
      if (!id.safeParse(group.groupId).success || group.coverage !== 'complete')
        complete = false;
    for (const declared of topology.regions.values())
      if (
        !id.safeParse(declared.regionId).success ||
        !id.safeParse(declared.institutionId).success ||
        !id.safeParse(declared.groupId).success ||
        declared.coverage !== 'complete' ||
        !realInstitutions.has(declared.institutionId) ||
        realRegions.get(declared.regionId)?.is_active !== declared.isActive
      )
        complete = false;
    for (const campus of campuses) {
      const declared = topology.assignments.get(campus.id);
      if (
        !declared ||
        declared.coverage !== 'complete' ||
        !realInstitutions.has(campus.institution_id) ||
        declared.institutionId !== campus.institution_id ||
        declared.isActive !== campus.is_active ||
        realAssignments.get(campus.id) !== declared.regionId ||
        topology.regions.get(declared.regionId)?.institutionId !==
          campus.institution_id ||
        (campus.is_active &&
          (!knownRegion(topology, declared.regionId) ||
            !realRegions.get(declared.regionId)?.is_active))
      )
        complete = false;
    }
    for (const declared of topology.assignments.values())
      if (
        !id.safeParse(declared.campusId).success ||
        !realCampuses.has(declared.campusId) ||
        realAssignments.get(declared.campusId) !== declared.regionId
      )
        complete = false;
  }
  const mappings = campuses.flatMap((c) => {
    const regionId = realAssignments.get(c.id);
    return regionId
      ? [
          {
            campusId: c.id,
            institutionId: c.institution_id,
            regionId,
            isActive: c.is_active,
          },
        ]
      : [];
  });
  const until =
    snapshot?.valid_until instanceof Date
      ? snapshot.valid_until.getTime()
      : null;
  const activation =
    snapshot?.next_activation instanceof Date
      ? snapshot.next_activation.getTime()
      : null;
  if (
    (until !== null && !Number.isFinite(until)) ||
    (activation !== null && !Number.isFinite(activation))
  )
    unavailable();
  // A future head is an unknown observation, not an empty topology. Its first
  // possible activation still bounds independent-global proofs.
  const validUntil = earliestDeadline(
    snapshot?.valid ? until : null,
    activation,
  );
  return {
    fingerprint: ownerFingerprint([
      'rating-scoped-inventory:v1',
      heads,
      regions,
      institutions,
      campuses,
      assignments,
    ]),
    epochFingerprint: '',
    topology,
    topologySnapshotId: complete ? snapshot!.id : null,
    topologyRevision: complete ? snapshot!.revision : null,
    validUntil,
    complete,
    mappings,
  };
}
async function identityFingerprint(
  accountId: string,
  tx: PoolClient,
): Promise<string> {
  const rows = (
    await tx.query(
      `SELECT to_jsonb(h) head,to_jsonb(s) selection FROM whaleu_campus.community_identity_heads h
    LEFT JOIN whaleu_campus.community_identity_selections s ON s.id=h.selection_id AND s.account_id=h.account_id AND s.revision=h.revision
    WHERE h.account_id=$1`,
      [accountId],
    )
  ).rows;
  if (rows.length > 1) unavailable();
  return ownerFingerprint(rows);
}
interface Fact {
  inventoryFingerprint: string;
  accountId: string | null;
  identityFingerprint: string | null;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'IDENTITY_CAMPUS_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'IDENTITY_CAMPUS_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.community_identity_heads,whaleu_campus.community_identity_selections,whaleu_campus.operating_regions,whaleu_campus.institutions,whaleu_campus.campuses,whaleu_campus.campus_region_assignments IN SHARE MODE NOWAIT',
      );
      const inventory = await captureInventory(read);
      for (const fact of facts)
        if (
          fact.inventoryFingerprint !== inventory.fingerprint ||
          (fact.accountId !== null &&
            fact.identityFingerprint !==
              (await identityFingerprint(fact.accountId, read)))
        )
          unavailable();
    }),
};
/** Owner-only complete inventory for category authority expansion. This proves
 * physical/topological absence too, and does not confer publication authority. */
export async function resolveRatingCategoryManagementInventory(
  tx: PoolClient,
): Promise<{
  readonly mappings: readonly RatingScopedCampusMapping[];
  readonly fingerprint: string;
  readonly validUntil: number | null;
}> {
  const epochFingerprint = await campusEpoch(tx);
  const inventory = await captureInventory(tx);
  if (!inventory.complete) unavailable();
  enableRequiredTransactionProof(tx, proof);
  const fact = freeze({
    inventoryFingerprint: inventory.fingerprint,
    accountId: null,
    identityFingerprint: null,
  });
  registerRequiredTransactionFact(tx, proof, ownerFingerprint(fact), fact);
  registerTransactionDeadline(
    tx,
    inventory.validUntil,
    'IDENTITY_CAMPUS_UNAVAILABLE',
  );
  return freeze({
    mappings: inventory.mappings,
    fingerprint: ownerFingerprint([inventory.fingerprint, epochFingerprint]),
    validUntil: inventory.validUntil,
  });
}
@Injectable()
export class CampusRatingScopedContextFacade {
  constructor(
    @Inject(CampusCommunityPolicyService)
    private readonly policy: CampusCommunityPolicyService,
  ) {}
  private async finish(
    input: Omit<RatingScopedCampusProof, typeof scopeBrand | 'fingerprint'>,
    accountId: string | null,
    inventory: Inventory,
    tx: PoolClient,
  ): Promise<RatingScopedCampusProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch) unavailable();
    enableRequiredTransactionProof(tx, proof);
    const identity =
      accountId === null ? null : await identityFingerprint(accountId, tx);
    const fact = freeze({
      inventoryFingerprint: inventory.fingerprint,
      accountId,
      identityFingerprint: identity,
    });
    registerRequiredTransactionFact(tx, proof, ownerFingerprint(fact), fact);
    registerTransactionDeadline(
      tx,
      input.validUntil,
      'IDENTITY_CAMPUS_UNAVAILABLE',
    );
    const result = freeze({
      ...input,
      fingerprint: ownerFingerprint([
        'rating-scoped-campus:v1',
        input,
        identity,
      ]),
    }) as RatingScopedCampusProof;
    handles.set(result, { tx, epoch });
    return result;
  }
  private async ordinary(
    actor: RatingScopedActor,
    anchor: string | null,
    tx: PoolClient,
  ) {
    if (!id.safeParse(actor.accountId).success) unavailable();
    const epochFingerprint = await campusEpoch(tx);
    const inventory = await captureInventory(tx);
    inventory.epochFingerprint = epochFingerprint;
    if (anchor !== null && !inventory.complete) unavailable();
    const mapping =
      anchor === null
        ? null
        : inventory.mappings.find((r) => r.campusId === anchor && r.isActive);
    if (anchor !== null && !mapping) unavailable();
    let identity: Extract<
      IdentityCampusResolution,
      { status: 'valid' }
    > | null = null;
    if (actor.affiliation !== null) {
      const resolved = await this.policy.resolve(
        actor.accountId,
        actor.affiliation,
        mapping?.regionId ?? null,
        tx,
      );
      if (resolved.status === 'valid') identity = resolved;
      else if (anchor !== null)
        throw new ApplicationError(
          resolved.status === 'selection_required'
            ? 'IDENTITY_CAMPUS_REQUIRED'
            : 'IDENTITY_CAMPUS_UNAVAILABLE',
        );
    } else if (anchor !== null)
      throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
    if (
      anchor !== null &&
      (!identity ||
        identity.topologySnapshotId !== inventory.topologySnapshotId)
    )
      unavailable();
    if (identity && inventory.complete) {
      const selected = inventory.mappings.find(
        (row) => row.campusId === identity.campusId && row.isActive,
      );
      if (
        !actor.affiliation ||
        !selected ||
        selected.institutionId !== identity.institutionId ||
        selected.regionId !== identity.identityRegionId ||
        identity.institutionId !== actor.affiliation.institutionId ||
        identity.originRegionId !== actor.affiliation.originRegionId
      )
        unavailable();
    }
    if (mapping) {
      const home =
        identity && inventory.topology
          ? knownRegion(inventory.topology, identity.identityRegionId)
          : null;
      const view = inventory.topology
        ? knownRegion(inventory.topology, mapping.regionId)
        : null;
      if (!home || !view) unavailable();
      // Cross-campus access is the accepted Campus relationship-group policy,
      // after exact physical reconciliation. Region equality alone is no proof.
      if (view.groupId !== home.groupId || identity?.relation === 'foreign')
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    }
    return { inventory, mapping, identity };
  }
  private base(
    inventory: Inventory,
    identity: Extract<IdentityCampusResolution, { status: 'valid' }> | null,
    actor: RatingScopedActor,
  ) {
    return {
      mappings: inventory.complete ? inventory.mappings : [],
      topologyState: inventory.complete
        ? ('complete' as const)
        : ('unknown' as const),
      topologySnapshotId: inventory.topologySnapshotId,
      topologyRevision: inventory.topologyRevision,
      identity: identity
        ? {
            campusId: identity.campusId,
            institutionId: identity.institutionId,
            regionId: identity.identityRegionId,
            selectionId: identity.selectionId,
          }
        : null,
      origin: actor.affiliation
        ? {
            institutionId: actor.affiliation.institutionId,
            regionId: actor.affiliation.originRegionId,
          }
        : null,
      authorizationMode: 'ordinary' as const,
      authorizationFingerprint: ownerFingerprint([
        actor.accountId,
        actor.affiliation,
        identity,
      ]),
      inventoryFingerprint: ownerFingerprint([
        inventory.fingerprint,
        inventory.epochFingerprint,
      ]),
      validUntil: earliestDeadline(
        inventory.validUntil,
        identity?.validUntil ?? null,
        actor.affiliation?.validUntil ?? null,
      ),
    };
  }
  async resolveNavigation(
    actor: RatingScopedActor,
    input: RatingNavigationSelector,
    tx: PoolClient,
  ): Promise<RatingScopedCampusProof> {
    const selector = navigationSchema.parse(input);
    const { inventory, identity, mapping } = await this.ordinary(
      actor,
      selector.kind === 'campus' ? selector.campusId : null,
      tx,
    );
    return this.finish(
      {
        ...this.base(inventory, identity, actor),
        kind: 'navigation',
        selector,
        scopeKeys: [
          selector.kind === 'global' ? 'global' : `campus:${selector.campusId}`,
        ],
        campusIds: mapping ? [mapping.campusId] : [],
        view: mapping
          ? {
              campusId: mapping.campusId,
              institutionId: mapping.institutionId,
              regionId: mapping.regionId,
            }
          : null,
        authorization: mapping
          ? [{ campusId: mapping.campusId, decision: 'allow' }]
          : [],
      },
      actor.accountId,
      inventory,
      tx,
    );
  }
  async resolveRandomCandidates(
    actor: RatingScopedActor,
    input: RatingRandomCandidateSelector,
    tx: PoolClient,
  ): Promise<RatingScopedCampusProof> {
    const selector = randomSchema.parse(input);
    const { inventory, identity, mapping } = await this.ordinary(
      actor,
      selector.kind === 'institution_with_global'
        ? selector.anchorCampusId
        : null,
      tx,
    );
    const campusIds = mapping
      ? inventory.mappings
          .filter(
            (r) => r.isActive && r.institutionId === mapping.institutionId,
          )
          .map((r) => r.campusId)
          .sort()
      : [];
    if (mapping && !campusIds.length) unavailable();
    const home =
      identity && inventory.topology
        ? knownRegion(inventory.topology, identity.identityRegionId)
        : null;
    const authorization = campusIds.map((campusId) => {
      const exact = inventory.mappings.find((r) => r.campusId === campusId)!;
      const target =
        inventory.topology && knownRegion(inventory.topology, exact.regionId);
      if (!target || !home) unavailable();
      if (target.groupId !== home.groupId)
        throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
      return { campusId, decision: 'allow' as const };
    });
    return this.finish(
      {
        ...this.base(inventory, identity, actor),
        kind: 'random',
        selector,
        scopeKeys: [
          ...campusIds.map((campusId) => `campus:${campusId}`),
          'global',
        ],
        campusIds,
        authorization,
        view: mapping
          ? {
              campusId: mapping.campusId,
              institutionId: mapping.institutionId,
              regionId: mapping.regionId,
            }
          : null,
      },
      actor.accountId,
      inventory,
      tx,
    );
  }
  /** The caller must obtain grant from RatingAuthorizationFacade in this same
   * transaction. This is an internal owner composition API, never a DTO. Its
   * proof is explicitly preview-only and cannot authorize a fresh publication. */
  async resolveManagedNavigation(
    actor: RatingScopedActor,
    input: RatingNavigationSelector,
    grant: RatingGrantScope,
    tx: PoolClient,
  ): Promise<RatingScopedCampusProof> {
    const selector = navigationSchema.parse(input);
    if (!id.safeParse(actor.accountId).success || grant.kind === 'ordinary')
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    if (
      (grant.kind === 'fixed' &&
        (grant.grant.role !== 'school_admin' ||
          grant.grant.operatingRegionId !== grant.regionId)) ||
      (grant.kind === 'global' &&
        (!['developer', 'super_admin'].includes(grant.grant.role) ||
          grant.grant.operatingRegionId !== null))
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const epochFingerprint = await campusEpoch(tx);
    const inventory = await captureInventory(tx);
    inventory.epochFingerprint = epochFingerprint;
    if (!inventory.complete) unavailable();
    const selected =
      selector.kind === 'campus'
        ? inventory.mappings.find(
            (r) => r.campusId === selector.campusId && r.isActive,
          )
        : null;
    if (selector.kind === 'campus' && !selected) unavailable();
    if (
      grant.kind === 'fixed' &&
      (!selected || selected.regionId !== grant.regionId)
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    if (
      grant.kind === 'fixed' &&
      (!inventory.topology || !knownRegion(inventory.topology, grant.regionId))
    )
      unavailable();
    return this.finish(
      {
        kind: 'navigation',
        selector,
        scopeKeys: [selected ? `campus:${selected.campusId}` : 'global'],
        campusIds: selected ? [selected.campusId] : [],
        mappings: inventory.mappings,
        topologyState: 'complete',
        topologySnapshotId: inventory.topologySnapshotId,
        topologyRevision: inventory.topologyRevision,
        identity: null,
        view: selected
          ? {
              campusId: selected.campusId,
              institutionId: selected.institutionId,
              regionId: selected.regionId,
            }
          : null,
        origin: null,
        authorization: selected
          ? [{ campusId: selected.campusId, decision: 'allow' }]
          : [],
        authorizationMode: 'managed_preview',
        authorizationFingerprint: grant.fingerprint,
        inventoryFingerprint: ownerFingerprint([
          inventory.fingerprint,
          inventory.epochFingerprint,
        ]),
        validUntil: earliestDeadline(
          inventory.validUntil,
          grant.grant.validUntil,
        ),
      },
      actor.accountId,
      inventory,
      tx,
    );
  }
  /** Category-only write composition. Both owner handles are produced in this
   * transaction; no DTO, preview proof, or affiliation can manufacture it. */
  async resolveCategoryManagementDomain(
    actor: Pick<RatingScopedActor, 'accountId'>,
    input: RatingNavigationSelector,
    authority: RatingCategoryManagementAuthority,
    tx: PoolClient,
  ): Promise<RatingScopedCampusProof> {
    return (
      await this.resolveCategoryManagementDomains(actor, [input], authority, tx)
    )[0]!;
  }
  /** A release may span every physical campus plus independent global. Capture
   * the complete owner inventory once, then brand each exact view. All results
   * share one immutable inventory fact; proof capacity does not grow per view. */
  async resolveCategoryManagementDomains(
    actor: Pick<RatingScopedActor, 'accountId'>,
    inputs: readonly RatingNavigationSelector[],
    authority: RatingCategoryManagementAuthority,
    tx: PoolClient,
  ): Promise<readonly RatingScopedCampusProof[]> {
    assertRatingCategoryManagementAuthority(authority, tx);
    if (
      !id.safeParse(actor.accountId).success ||
      actor.accountId !== authority.accountId ||
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      inputs.length > RATING_SCOPED_CAMPUS_LIMIT + 1
    )
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const selectors = inputs.map((input) => navigationSchema.parse(input));
    const scopeKeys = selectors.map((selector) =>
      selector.kind === 'global' ? 'global' : `campus:${selector.campusId}`,
    );
    if (new Set(scopeKeys).size !== scopeKeys.length)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    const epochFingerprint = await campusEpoch(tx);
    const inventory = await captureInventory(tx);
    inventory.epochFingerprint = epochFingerprint;
    const inventoryFingerprint = ownerFingerprint([
      inventory.fingerprint,
      epochFingerprint,
    ]);
    if (
      !inventory.complete ||
      inventoryFingerprint !== authority.inventoryFingerprint
    )
      unavailable();
    const mappings = new Map(
      inventory.mappings
        .filter((mapping) => mapping.isActive)
        .map((mapping) => [mapping.campusId, mapping]),
    );
    const campusIds = selectors.flatMap((selector) =>
      selector.kind === 'campus' ? [selector.campusId] : [],
    );
    if (campusIds.some((campusId) => !mappings.has(campusId))) unavailable();
    requireRatingCategoryManagementAuthority(
      authority,
      campusIds,
      selectors.some((selector) => selector.kind === 'global'),
      tx,
    );
    const results: RatingScopedCampusProof[] = [];
    for (const selector of selectors) {
      const selected =
        selector.kind === 'campus' ? mappings.get(selector.campusId)! : null;
      results.push(
        await this.finish(
          {
            kind: 'navigation',
            selector,
            scopeKeys: [selected ? `campus:${selected.campusId}` : 'global'],
            campusIds: selected ? [selected.campusId] : [],
            mappings: inventory.mappings,
            topologyState: 'complete',
            topologySnapshotId: inventory.topologySnapshotId,
            topologyRevision: inventory.topologyRevision,
            identity: null,
            origin: null,
            view: selected
              ? {
                  campusId: selected.campusId,
                  institutionId: selected.institutionId,
                  regionId: selected.regionId,
                }
              : null,
            authorization: selected
              ? [{ campusId: selected.campusId, decision: 'allow' }]
              : [],
            authorizationMode: 'category_management',
            authorizationFingerprint: authority.fingerprint,
            inventoryFingerprint,
            validUntil: earliestDeadline(
              inventory.validUntil,
              authority.validUntil,
            ),
          },
          null,
          inventory,
          tx,
        ),
      );
    }
    return Object.freeze(results);
  }
  async resolveLegacyCompatDomain(
    input: RatingLegacyCompatSelector,
    tx: PoolClient,
  ): Promise<RatingScopedCampusProof> {
    const selector = compatSchema.parse(input),
      epochFingerprint = await campusEpoch(tx),
      inventory = await captureInventory(tx);
    inventory.epochFingerprint = epochFingerprint;
    if (
      selector.kind === 'region_compat' &&
      (!inventory.complete ||
        !inventory.topology ||
        !knownRegion(inventory.topology, selector.regionId))
    )
      unavailable();
    const campusIds =
      selector.kind === 'region_compat'
        ? inventory.mappings
            .filter((r) => r.isActive && r.regionId === selector.regionId)
            .map((r) => r.campusId)
            .sort()
        : [];
    // No zero-campus policy is installed: absence is not vacuous equality.
    if (selector.kind === 'region_compat' && !campusIds.length) unavailable();
    return this.finish(
      {
        kind: 'legacy_compat',
        selector,
        scopeKeys:
          selector.kind === 'global_compat'
            ? ['global']
            : campusIds.map((c) => `campus:${c}`),
        campusIds,
        mappings: inventory.complete ? inventory.mappings : [],
        topologyState: inventory.complete ? 'complete' : 'unknown',
        topologySnapshotId: inventory.topologySnapshotId,
        topologyRevision: inventory.topologyRevision,
        identity: null,
        view: null,
        origin: null,
        authorization: [],
        authorizationMode: 'none',
        authorizationFingerprint: ownerFingerprint(['compat-domain', selector]),
        inventoryFingerprint: ownerFingerprint([
          inventory.fingerprint,
          inventory.epochFingerprint,
        ]),
        validUntil: inventory.validUntil,
      },
      null,
      inventory,
      tx,
    );
  }
}
