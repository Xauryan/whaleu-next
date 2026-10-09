import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import {
  knownRegion,
  parseTopology,
} from './community-policy/fact-validation.js';

// Admission bounds reject the whole request; they never return a partial scope.
export const RATING_RANDOM_SCOPE_CAMPUS_LIMIT = 1000;
export const RATING_RANDOM_SCOPE_REGION_LIMIT = 200;
const id = z.uuid().refine((value) => value === value.toLowerCase());
const version = z.string().regex(/^[0-9]+$/);
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
const regionSchema = z.strictObject({
  id,
  is_active: z.boolean(),
  state_version: version,
});
const institutionSchema = z.strictObject({ id, state_version: version });
type PhysicalCampus = z.infer<typeof campusSchema>;
type PhysicalAssignment = z.infer<typeof assignmentSchema>;
type PhysicalRegion = z.infer<typeof regionSchema>;

/** Private native-catalog scope. This proves neither legacy school crosswalks
 * nor the actor's access to any of the returned operating regions. */
export interface RatingRandomCampusScope {
  campusId: string;
  institutionId: string;
  regionIds: readonly string[];
  topologySnapshotId: string;
  topologyRevision: number;
  validUntil: number | null;
  fingerprint: string;
}
interface Fact {
  campusId: string;
  fingerprint: string;
}
function unavailable(): never {
  throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
}
function validRows<T>(rows: readonly T[], schema: z.ZodType<T>) {
  if (rows.some((row) => !schema.safeParse(row).success)) unavailable();
}

async function capture(
  campusId: string,
  tx: PoolClient,
  lock: boolean,
): Promise<RatingRandomCampusScope> {
  if (!id.safeParse(campusId).success) unavailable();
  if (lock)
    await tx.query(
      "SELECT snapshot_id FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR SHARE",
    );
  const snapshot = (
    await tx.query<{
      id: string;
      revision: number;
      topology: unknown;
      valid_until: Date | null;
      effective_at: string;
      precise_until: string | null;
      valid: boolean;
    }>(`WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
      SELECT s.id,s.revision,s.topology,s.valid_until,s.effective_at::text,s.valid_until::text precise_until,
        coalesce(s.coverage_state='complete' AND s.provenance_state='accepted'
        AND length(btrim(s.source_reference))>0 AND length(btrim(s.policy_reference))>0
        AND isfinite(s.effective_at) AND s.effective_at<=instant.now
        AND ((s.expiry_kind='policy_exempt' AND s.valid_until IS NULL)
        OR (s.expiry_kind='at' AND isfinite(s.valid_until) AND s.valid_until>s.effective_at AND s.valid_until>instant.now)),false) valid
      FROM whaleu_campus.community_topology_heads h
      JOIN whaleu_campus.community_topology_snapshots s ON s.id=h.snapshot_id AND s.revision=h.revision
      CROSS JOIN instant WHERE h.scope_key='community'`)
  ).rows[0];
  const topology = snapshot && parseTopology(snapshot.topology);
  const selected = topology?.assignments.get(campusId);
  if (
    !snapshot?.valid ||
    !id.safeParse(snapshot.id).success ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !topology ||
    !selected ||
    !id.safeParse(selected.institutionId).success ||
    selected.coverage !== 'complete' ||
    !selected.isActive ||
    !knownRegion(topology, selected.regionId)
  )
    unavailable();
  const institutionId = selected.institutionId;
  const reviewedAssignments = [...topology.assignments.values()]
    .filter((row) => row.institutionId === institutionId)
    .sort((a, b) => a.campusId.localeCompare(b.campusId));
  // Institution membership, not authentication relationship-group membership,
  // defines this candidate scope. Several distinct groups are intentionally kept.
  const reviewedRegions = [...topology.regions.values()]
    .filter((row) => row.institutionId === institutionId)
    .sort((a, b) => a.regionId.localeCompare(b.regionId));
  if (
    reviewedAssignments.length > RATING_RANDOM_SCOPE_CAMPUS_LIMIT ||
    reviewedRegions.length > RATING_RANDOM_SCOPE_REGION_LIMIT ||
    reviewedAssignments.some(
      (row) =>
        !id.safeParse(row.campusId).success ||
        !id.safeParse(row.regionId).success,
    ) ||
    reviewedRegions.some(
      (row) =>
        !id.safeParse(row.regionId).success ||
        !id.safeParse(row.groupId).success,
    )
  )
    unavailable();
  const snapshotIds = reviewedAssignments.map((row) => row.campusId);
  const campusSql = `SELECT id,institution_id,is_active,xmin::text state_version FROM whaleu_campus.campuses
    WHERE institution_id=$1 OR id=ANY($2::uuid[]) ORDER BY id LIMIT ${RATING_RANDOM_SCOPE_CAMPUS_LIMIT + 1}`;
  const plannedCampuses = (
    await tx.query<PhysicalCampus>(campusSql, [institutionId, snapshotIds])
  ).rows;
  if (plannedCampuses.length > RATING_RANDOM_SCOPE_CAMPUS_LIMIT) unavailable();
  validRows(plannedCampuses, campusSchema);
  const campusIds = plannedCampuses.map((row) => row.id);
  const assignmentSql = `SELECT campus_id,operating_region_id,xmin::text state_version FROM whaleu_campus.campus_region_assignments
    WHERE campus_id=ANY($1::uuid[]) ORDER BY campus_id LIMIT ${RATING_RANDOM_SCOPE_CAMPUS_LIMIT + 1}`;
  const plannedAssignments = (
    await tx.query<PhysicalAssignment>(assignmentSql, [campusIds])
  ).rows;
  if (plannedAssignments.length > RATING_RANDOM_SCOPE_CAMPUS_LIMIT)
    unavailable();
  validRows(plannedAssignments, assignmentSchema);
  const regionIds = [
    ...new Set([
      ...reviewedRegions.map((row) => row.regionId),
      ...plannedAssignments.map((row) => row.operating_region_id),
    ]),
  ].sort();
  if (regionIds.length > RATING_RANDOM_SCOPE_REGION_LIMIT) unavailable();
  const suffix = lock ? ' FOR SHARE' : '';
  // The caller holds the common shared policy gate before authentication.
  // Match the Campus inventory lock order: regions, institution, campuses,
  // assignments. Final rereads below never add a blocking row lock.
  const regions = (
    await tx.query<PhysicalRegion>(
      `SELECT id,is_active,xmin::text state_version FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id${suffix}`,
      [regionIds],
    )
  ).rows;
  const institutions = (
    await tx.query<z.infer<typeof institutionSchema>>(
      `SELECT id,xmin::text state_version FROM whaleu_campus.institutions WHERE id=$1${suffix}`,
      [institutionId],
    )
  ).rows;
  const campuses = (
    await tx.query<PhysicalCampus>(campusSql + suffix, [
      institutionId,
      snapshotIds,
    ])
  ).rows;
  const assignments = (
    await tx.query<PhysicalAssignment>(assignmentSql + suffix, [campusIds])
  ).rows;
  if (
    campuses.length > RATING_RANDOM_SCOPE_CAMPUS_LIMIT ||
    assignments.length > RATING_RANDOM_SCOPE_CAMPUS_LIMIT ||
    institutions.length !== 1 ||
    institutions[0]?.id !== institutionId
  )
    unavailable();
  validRows(institutions, institutionSchema);
  validRows(regions, regionSchema);
  validRows(campuses, campusSchema);
  validRows(assignments, assignmentSchema);
  const actualCampuses = new Map(campuses.map((row) => [row.id, row]));
  const actualAssignments = new Map(
    assignments.map((row) => [row.campus_id, row]),
  );
  const actualRegions = new Map(regions.map((row) => [row.id, row]));
  if (
    actualCampuses.size !== campuses.length ||
    actualAssignments.size !== assignments.length ||
    actualRegions.size !== regions.length ||
    !actualCampuses.get(campusId)?.is_active
  )
    unavailable();
  for (const region of reviewedRegions) {
    if (
      region.coverage !== 'complete' ||
      topology.groups.get(region.groupId)?.coverage !== 'complete' ||
      actualRegions.get(region.regionId)?.is_active !== region.isActive
    )
      unavailable();
  }
  // Every current active campus needs an exact reviewed, active assignment.
  // An unreviewed active sibling must not silently disappear from the pool.
  for (const campus of campuses) {
    if (campus.institution_id !== institutionId) unavailable();
    if (!campus.is_active) continue;
    const reviewed = topology.assignments.get(campus.id);
    if (
      !reviewed ||
      reviewed.institutionId !== institutionId ||
      reviewed.coverage !== 'complete' ||
      !reviewed.isActive ||
      !knownRegion(topology, reviewed.regionId) ||
      !actualRegions.get(reviewed.regionId)?.is_active ||
      actualAssignments.get(campus.id)?.operating_region_id !==
        reviewed.regionId
    )
      unavailable();
  }
  // Reverse reconciliation also covers declared inactive campuses and regions.
  for (const reviewed of reviewedAssignments) {
    const campus = actualCampuses.get(reviewed.campusId);
    if (
      reviewed.coverage !== 'complete' ||
      !campus ||
      campus.institution_id !== institutionId ||
      campus.is_active !== reviewed.isActive ||
      actualAssignments.get(reviewed.campusId)?.operating_region_id !==
        reviewed.regionId
    )
      unavailable();
  }
  // The candidate pool is the institution's active physical campuses mapped to
  // operating regions. Accepted orphan regions and inactive-only campuses do
  // not widen it; their records above only contribute completeness evidence.
  const includedRegionIds = [
    ...new Set(
      campuses
        .filter((campus) => campus.is_active)
        .map((campus) => actualAssignments.get(campus.id)!.operating_region_id),
    ),
  ].sort();
  const groups = [...new Set(reviewedRegions.map((region) => region.groupId))]
    .sort()
    .map((groupId) => topology.groups.get(groupId));
  const validUntil = snapshot.valid_until?.getTime() ?? null;
  if (validUntil !== null && !Number.isFinite(validUntil)) unavailable();
  return {
    campusId,
    institutionId,
    regionIds: includedRegionIds,
    topologySnapshotId: snapshot.id,
    topologyRevision: snapshot.revision,
    validUntil,
    fingerprint: ownerFingerprint([
      'rating-random-campus-scope:v1',
      campusId,
      institutionId,
      snapshot.id,
      snapshot.revision,
      snapshot.effective_at,
      snapshot.precise_until,
      groups,
      reviewedRegions,
      reviewedAssignments,
      institutions,
      regions,
      campuses,
      assignments,
    ]),
  };
}

const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'IDENTITY_CAMPUS_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'IDENTITY_CAMPUS_UNAVAILABLE', async (read) => {
      // All physical tables are fenced too: newly inserted siblings and removed
      // negative inventory are relevant even if no earlier row lock saw them.
      await read.query(
        'LOCK TABLE whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.operating_regions,whaleu_campus.institutions,whaleu_campus.campuses,whaleu_campus.campus_region_assignments IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          (await capture(fact.campusId, read, false)).fingerprint !==
          fact.fingerprint
        )
          unavailable();
    }),
};

@Injectable()
export class CampusRatingRandomScopeFacade {
  async resolve(
    campusId: string,
    tx: PoolClient,
  ): Promise<RatingRandomCampusScope> {
    enableRequiredTransactionProof(tx, proof);
    const result = await capture(campusId, tx, true);
    registerRequiredTransactionFact(
      tx,
      proof,
      `${campusId}:${result.fingerprint}`,
      Object.freeze({ campusId, fingerprint: result.fingerprint }),
    );
    registerTransactionDeadline(
      tx,
      result.validUntil,
      'IDENTITY_CAMPUS_UNAVAILABLE',
    );
    return result;
  }
}
