import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
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
import { parseTopology } from './community-policy/fact-validation.js';

interface Mapping {
  campusId: string;
  operatingRegionId: string;
  topologySnapshotId: string;
  topologyRevision: number;
  validUntil: number | null;
  fingerprint: string;
}
interface Fact {
  campusId: string;
  fingerprint: string;
}
async function capture(
  campusId: string,
  tx: PoolClient,
  lock: boolean,
): Promise<Mapping> {
  if (lock)
    await tx.query(
      "SELECT snapshot_id FROM whaleu_campus.community_topology_heads WHERE scope_key='community' FOR SHARE",
    );
  const row = (
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
  const topology = row && parseTopology(row.topology);
  const assignment = topology?.assignments.get(campusId);
  const region = assignment && topology?.regions.get(assignment.regionId);
  const group = region && topology?.groups.get(region.groupId);
  // This is an authoritative origin mapping, not the public active-region picker.
  if (
    !row?.valid ||
    !assignment ||
    assignment.coverage !== 'complete' ||
    !region ||
    region.coverage !== 'complete' ||
    !group ||
    group.coverage !== 'complete'
  )
    throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
  return {
    campusId,
    operatingRegionId: region.regionId,
    topologySnapshotId: row.id,
    topologyRevision: row.revision,
    validUntil: row.valid_until?.getTime() ?? null,
    fingerprint: ownerFingerprint([
      campusId,
      row.id,
      row.revision,
      region.regionId,
      row.effective_at,
      row.precise_until,
    ]),
  };
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'IDENTITY_CAMPUS_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'IDENTITY_CAMPUS_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_campus.community_topology_heads,whaleu_campus.community_topology_snapshots IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if (
          (await capture(fact.campusId, read, false)).fingerprint !==
          fact.fingerprint
        )
          throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    }),
};
/** Campus owner proves original-campus membership without user affiliation. */
@Injectable()
export class CampusRatingOriginScopeFacade {
  async resolve(campusId: string, tx: PoolClient): Promise<Mapping> {
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
