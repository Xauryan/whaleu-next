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

const id = z.uuid().refine((value) => value === value.toLowerCase());
const physicalRegionSchema = z.strictObject({
  id,
  is_active: z.boolean(),
  state_version: z.string().regex(/^[0-9]+$/),
});
const physicalCampusSchema = z.strictObject({
  id,
  institution_id: id,
  is_active: z.boolean(),
  state_version: z.string().regex(/^[0-9]+$/),
});
const physicalAssignmentSchema = z.strictObject({
  campus_id: id,
  operating_region_id: id,
  state_version: z.string().regex(/^[0-9]+$/),
});
/** Native current canonical mappings only. This never interprets legacy school IDs
 * or confers administrative authority. The caller separately proves grants. */
export interface RatingCategoryCampusScope {
  topologySnapshotId: string;
  topologyRevision: number;
  regions: readonly { regionId: string; campusIds: readonly string[] }[];
  campusIds: readonly string[];
  fingerprint: string;
  validUntil: number | null;
}
function unavailable(): never {
  throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
}
async function capture(
  regionId: string | null,
  tx: PoolClient,
  lock: boolean,
): Promise<RatingCategoryCampusScope> {
  if (regionId !== null && !id.safeParse(regionId).success) unavailable();
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
      precise_until: string | null;
      effective_at: string;
      valid: boolean;
    }>(
      `WITH instant AS MATERIALIZED (SELECT clock_timestamp() now)
    SELECT s.id,s.revision,s.topology,s.valid_until,s.valid_until::text precise_until,s.effective_at::text,
    coalesce(s.coverage_state='complete' AND s.provenance_state='accepted' AND length(btrim(s.source_reference))>0 AND length(btrim(s.policy_reference))>0
    AND isfinite(s.effective_at) AND s.effective_at<=instant.now AND ((s.expiry_kind='policy_exempt' AND s.valid_until IS NULL)
    OR (s.expiry_kind='at' AND isfinite(s.valid_until) AND s.valid_until>s.effective_at AND s.valid_until>instant.now)),false) valid
    FROM whaleu_campus.community_topology_heads h JOIN whaleu_campus.community_topology_snapshots s ON s.id=h.snapshot_id AND s.revision=h.revision
    CROSS JOIN instant WHERE h.scope_key='community'`,
    )
  ).rows[0];
  const topology = snapshot && parseTopology(snapshot.topology);
  if (
    !snapshot?.valid ||
    !id.safeParse(snapshot.id).success ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !topology
  )
    unavailable();
  const suffix = lock ? ' FOR SHARE' : '';
  // Full native inventory proves absence as well as present mappings. The fixed
  // limits are admission bounds, never a truncated subset of campuses.
  const regions = (
    await tx.query<z.infer<typeof physicalRegionSchema>>(
      `SELECT id,is_active,xmin::text state_version FROM whaleu_campus.operating_regions ORDER BY id LIMIT 201${suffix}`,
    )
  ).rows;
  const institutions = (
    await tx.query<{ id: string; state_version: string }>(
      `SELECT id,xmin::text state_version FROM whaleu_campus.institutions ORDER BY id LIMIT 1001${suffix}`,
    )
  ).rows;
  const campuses = (
    await tx.query<z.infer<typeof physicalCampusSchema>>(
      `SELECT id,institution_id,is_active,xmin::text state_version FROM whaleu_campus.campuses ORDER BY id LIMIT 1001${suffix}`,
    )
  ).rows;
  const assignments = (
    await tx.query<z.infer<typeof physicalAssignmentSchema>>(
      `SELECT campus_id,operating_region_id,xmin::text state_version FROM whaleu_campus.campus_region_assignments ORDER BY campus_id LIMIT 1001${suffix}`,
    )
  ).rows;
  if (
    regions.length > 200 ||
    institutions.length > 1000 ||
    campuses.length > 1000 ||
    assignments.length > 1000 ||
    regions.some((row) => !physicalRegionSchema.safeParse(row).success) ||
    campuses.some((row) => !physicalCampusSchema.safeParse(row).success) ||
    assignments.some(
      (row) => !physicalAssignmentSchema.safeParse(row).success,
    ) ||
    institutions.some(
      (row) =>
        !id.safeParse(row.id).success || !/^[0-9]+$/.test(row.state_version),
    )
  )
    unavailable();
  const realRegions = new Map(regions.map((row) => [row.id, row]));
  const realInstitutions = new Set(institutions.map((row) => row.id));
  const realCampuses = new Map(campuses.map((row) => [row.id, row]));
  const realAssignments = new Map(
    assignments.map((row) => [row.campus_id, row.operating_region_id]),
  );
  if (
    realRegions.size !== regions.length ||
    realInstitutions.size !== institutions.length ||
    realCampuses.size !== campuses.length ||
    realAssignments.size !== assignments.length
  )
    unavailable();
  const wantedRegions =
    regionId === null
      ? regions.filter((row) => row.is_active).map((row) => row.id)
      : [regionId];
  if (
    wantedRegions.length === 0 ||
    wantedRegions.some(
      (value) =>
        !realRegions.get(value)?.is_active || !knownRegion(topology, value),
    )
  )
    unavailable();
  const wanted = new Set(wantedRegions);
  const included = new Map(
    wantedRegions.map((value) => [value, [] as string[]]),
  );
  // A global command proves all active physical campuses; a regional command
  // reconciles both its reviewed and physical assignments, including moves.
  for (const campus of campuses) {
    const physicalRegion = realAssignments.get(campus.id);
    const declared = topology.assignments.get(campus.id);
    const relevant =
      regionId === null ||
      (physicalRegion !== undefined && wanted.has(physicalRegion)) ||
      (declared !== undefined && wanted.has(declared.regionId));
    if (!relevant) continue;
    if (
      !realInstitutions.has(campus.institution_id) ||
      !declared ||
      declared.coverage !== 'complete' ||
      declared.institutionId !== campus.institution_id ||
      declared.isActive !== campus.is_active ||
      physicalRegion !== declared.regionId
    )
      unavailable();
    const reviewedRegion = topology.regions.get(declared.regionId);
    if (
      !reviewedRegion ||
      reviewedRegion.institutionId !== campus.institution_id ||
      reviewedRegion.coverage !== 'complete' ||
      realRegions.get(declared.regionId)?.is_active !== reviewedRegion.isActive
    )
      unavailable();
    if (campus.is_active) {
      if (
        !knownRegion(topology, declared.regionId) ||
        !realRegions.get(declared.regionId)?.is_active
      )
        unavailable();
      if (wanted.has(declared.regionId))
        included.get(declared.regionId)!.push(campus.id);
    }
  }
  for (const declared of topology.assignments.values()) {
    if (regionId !== null && !wanted.has(declared.regionId)) continue;
    const campus = realCampuses.get(declared.campusId);
    if (
      !campus ||
      campus.institution_id !== declared.institutionId ||
      campus.is_active !== declared.isActive ||
      declared.coverage !== 'complete' ||
      realAssignments.get(declared.campusId) !== declared.regionId
    )
      unavailable();
  }
  for (const declared of topology.regions.values()) {
    if (regionId !== null && declared.regionId !== regionId) continue;
    if (
      declared.coverage !== 'complete' ||
      !realRegions.has(declared.regionId) ||
      realRegions.get(declared.regionId)!.is_active !== declared.isActive ||
      !realInstitutions.has(declared.institutionId)
    )
      unavailable();
  }
  const selected = [...included]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, ids]) => ({ regionId: value, campusIds: ids.sort() }));
  if (selected.some((row) => row.campusIds.length === 0)) unavailable();
  const campusIds = selected.flatMap((row) => row.campusIds).sort();
  const validUntil = snapshot.valid_until?.getTime() ?? null;
  if (validUntil !== null && !Number.isFinite(validUntil)) unavailable();
  return {
    topologySnapshotId: snapshot.id,
    topologyRevision: snapshot.revision,
    regions: selected,
    campusIds,
    validUntil,
    fingerprint: ownerFingerprint([
      'rating-category-campus-scope:v1',
      regionId,
      snapshot.id,
      snapshot.revision,
      snapshot.effective_at,
      snapshot.precise_until,
      snapshot.topology,
      regions,
      institutions,
      campuses,
      assignments,
      selected,
    ]),
  };
}
const proof: RequiredTransactionProof<{
  regionId: string | null;
  fingerprint: string;
}> = {
  maximumFacts: 2,
  failureCode: 'IDENTITY_CAMPUS_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'IDENTITY_CAMPUS_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots,whaleu_campus.operating_regions,whaleu_campus.institutions,whaleu_campus.campuses,whaleu_campus.campus_region_assignments IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          (await capture(fact.regionId, read, false)).fingerprint !==
          fact.fingerprint
        )
          unavailable();
    }),
};
@Injectable()
export class CampusRatingCategoryScopeFacade {
  async scope(
    regionId: string | null,
    tx: PoolClient,
  ): Promise<RatingCategoryCampusScope> {
    enableRequiredTransactionProof(tx, proof);
    const result = await capture(regionId, tx, true);
    registerRequiredTransactionFact(
      tx,
      proof,
      regionId ?? 'global',
      Object.freeze({ regionId, fingerprint: result.fingerprint }),
    );
    registerTransactionDeadline(
      tx,
      result.validUntil,
      'IDENTITY_CAMPUS_UNAVAILABLE',
    );
    return Object.freeze(result);
  }
}
