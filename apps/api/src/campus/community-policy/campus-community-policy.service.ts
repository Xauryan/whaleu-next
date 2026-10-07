import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import type {
  IdentityCampusResolution,
  PublicationAffiliationMetadata,
  RegionGroupResolution,
} from './contracts.js';
import {
  earliestDeadline,
  knownRegion,
  parseTopology,
  validProvenance,
} from './fact-validation.js';

import {
  activeRegions,
  databaseNow,
  readSelection,
  readSelectionHead,
  readTopology,
} from './records.js';

/** Read-only campus authority. Call under the common shared outer safety gate.
 * ALL authority/active-scope writers must FIRST acquire lockSafetyPolicy(tx,true).
 * Local read order: topology, selection, regions by UUID, campus/assignment.
 * The exclusive writer gate serializes cross-domain changes even where parent
 * visibility reads approval before publication scope. A reader never creates an
 * absent head or treats absent coverage as empty. */
@Injectable()
export class CampusCommunityPolicyService {
  async resolve(
    accountId: string,
    affiliation: PublicationAffiliationMetadata,
    targetRegionId: string | null,
    tx: PoolClient,
  ): Promise<IdentityCampusResolution> {
    const missing = { status: 'unavailable' } as const;
    const snapshot = await readTopology(tx);
    if (!snapshot) return missing;
    const topology = parseTopology(snapshot.topology);
    if (!topology) return missing;
    const head = await readSelectionHead(accountId, tx);
    if (!head?.selection_id) return missing;
    const selection = await readSelection(accountId, head, tx);
    if (
      !selection ||
      selection.affiliation_assertion_id !== affiliation.assertionId ||
      selection.affiliation_snapshot_id !== affiliation.snapshotId ||
      selection.topology_snapshot_id !== snapshot.id
    )
      return missing;

    const origin = knownRegion(topology, affiliation.originRegionId);
    if (!origin || origin.institutionId !== affiliation.institutionId)
      return missing;
    const assignment = selection.campus_id
      ? topology.assignments.get(selection.campus_id)
      : null;
    const identity = assignment
      ? knownRegion(topology, assignment.regionId)
      : null;
    const target =
      targetRegionId === null ? null : knownRegion(topology, targetRegionId);
    if (targetRegionId !== null && !target) return missing;
    if (selection.selection_state === 'selected') {
      if (
        !assignment ||
        !identity ||
        assignment.coverage !== 'complete' ||
        !assignment.isActive ||
        assignment.institutionId !== affiliation.institutionId ||
        identity.groupId !== origin.groupId
      )
        return missing;
    }
    const regionIds = [origin.regionId];
    if (identity) regionIds.push(identity.regionId);
    if (target) regionIds.push(target.regionId);
    if (!(await activeRegions(regionIds, tx))) return missing;
    if (selection.selection_state === 'selected') {
      // The stable physical campus and current assignment must still agree with
      // the reviewed snapshot. Neither browsing selection nor school code enters.
      const physical = (
        await tx.query<{
          institution_id: string;
          operating_region_id: string;
          is_active: boolean;
        }>(
          `SELECT c.institution_id,c.is_active,a.operating_region_id
           FROM whaleu_campus.campuses c
           JOIN whaleu_campus.institutions i ON i.id=c.institution_id
           JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id
           WHERE c.id=$1 FOR SHARE OF c,i,a`,
          [selection.campus_id],
        )
      ).rows[0];
      if (
        !physical?.is_active ||
        physical.institution_id !== affiliation.institutionId ||
        physical.operating_region_id !== identity!.regionId
      )
        return missing;
    }
    // Fresh clock after every potentially waiting lock, including assignments.
    const now = await databaseNow(tx);
    if (
      !validProvenance(snapshot, now) ||
      !validProvenance(selection, now) ||
      (affiliation.validUntil !== null &&
        (!Number.isFinite(affiliation.validUntil) ||
          affiliation.validUntil <= now))
    )
      return missing;
    const validUntil = earliestDeadline(
      snapshot.valid_until?.getTime() ?? null,
      selection.valid_until?.getTime() ?? null,
      affiliation.validUntil,
    );
    registerTransactionDeadline(tx, validUntil, 'COMMUNITY_UNAVAILABLE');
    if (selection.selection_state === 'selection_required')
      return { status: 'selection_required' };
    return {
      status: 'valid',
      campusId: selection.campus_id!,
      institutionId: affiliation.institutionId,
      identityRegionId: identity!.regionId,
      originRegionId: origin.regionId,
      selectionId: selection.id,
      topologySnapshotId: snapshot.id,
      relation:
        target === null
          ? 'global'
          : target.regionId === identity!.regionId
            ? 'home'
            : target.groupId === identity!.groupId
              ? 'related'
              : 'foreign',
      validUntil,
    };
  }

  /** Target management uses historical origin and current known topology without
   * consulting the author's current affiliation or current identity selection. */
  async sameGroup(
    regionA: string,
    regionB: string,
    tx: PoolClient,
  ): Promise<RegionGroupResolution> {
    const missing = { status: 'unavailable' } as const;
    const snapshot = await readTopology(tx);
    if (!snapshot) return missing;
    const topology = parseTopology(snapshot.topology);
    if (!topology) return missing;
    const a = knownRegion(topology, regionA);
    const b = knownRegion(topology, regionB);
    if (!a || !b || !(await activeRegions([regionA, regionB], tx)))
      return missing;
    if (!validProvenance(snapshot, await databaseNow(tx))) return missing;
    const validUntil = snapshot.valid_until?.getTime() ?? null;
    registerTransactionDeadline(tx, validUntil, 'COMMUNITY_UNAVAILABLE');
    return {
      status: 'known',
      sameGroup: a.groupId === b.groupId,
      topologySnapshotId: snapshot.id,
      validUntil,
    };
  }
}
