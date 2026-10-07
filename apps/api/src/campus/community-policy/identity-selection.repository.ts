import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
import type {
  IdentityCampusIntent,
  IdentityCampusReceipt,
  IdentityCampusReason,
  IdentityCampusSummary,
} from '../../identity-campus/contracts.js';
import type { PublicationAffiliationMetadata } from './contracts.js';
import {
  earliestDeadline,
  knownRegion,
  parseTopology,
  validProvenance,
} from './fact-validation.js';
import {
  databaseNow,
  readSelection,
  readSelectionHead,
  readTopology,
} from './records.js';
import type {
  SelectionHead,
  SelectionRecord,
  TopologyRecord,
} from './records.js';

interface PhysicalCampus {
  id: string;
  institution_id: string;
  full_name: string;
  is_active: boolean;
  state_version: string;
}
interface PhysicalRegion {
  id: string;
  name: string;
  is_active: boolean;
  state_version: string;
}
interface PhysicalAssignment {
  campus_id: string;
  operating_region_id: string;
  state_version: string;
}
interface PhysicalInstitution {
  id: string;
  state_version: string;
}
interface StoredReceipt {
  client_request_id: string;
  campus_id: string;
  intent_hash: string;
  expected_state_revision: string;
  selection_revision: number;
  outcome: 'applied' | 'unchanged';
}
export interface OwnCampusFacts {
  selection: 'valid' | 'selection_required' | 'unavailable';
  reason: IdentityCampusReason;
  selectedCampus: IdentityCampusSummary | null;
  options: { status: 'known' | 'unavailable'; items: IdentityCampusSummary[] };
  writable: boolean;
  head: SelectionHead | null;
  current: SelectionRecord | null;
  topology: TopologyRecord | null;
  validUntil: number | null;
  fingerprint: unknown;
}
export function identitySelectionIntentHash(
  intent: Pick<IdentityCampusIntent, 'campusId' | 'expectedStateRevision'>,
) {
  return createHash('sha256')
    .update(
      `whaleu-identity-campus-intent:v1\n${intent.campusId}\n${intent.expectedStateRevision}`,
    )
    .digest('hex');
}
export function identitySelectionRevision(
  accountId: string,
  facts: OwnCampusFacts,
  affiliation: PublicationAffiliationMetadata,
  phone: unknown,
  safety: unknown,
) {
  return `ic1:${createHash('sha256')
    .update(
      JSON.stringify([
        'whaleu-identity-campus-state:v1',
        accountId,
        facts.fingerprint,
        affiliation,
        phone,
        safety,
      ]),
    )
    .digest('hex')}`;
}

/** Campus-owned SQL only. Outer gate is held by orchestration before authentication.
 * This inventory's bounded completeness contract is documented in API_IDENTITY_CAMPUS.
 * Lock order: topology, selection, region UUIDs, institution UUIDs, campus UUIDs,
 * assignment campus UUIDs. Catalog statement gates also protect absent rows. */
@Injectable()
export class IdentitySelectionRepository {
  async own(
    accountId: string,
    affiliation: PublicationAffiliationMetadata,
    tx: PoolClient,
    write = false,
  ): Promise<OwnCampusFacts> {
    const snapshot = await readTopology(tx);
    const head = await readSelectionHead(accountId, tx, write);
    const current = await readSelection(accountId, head, tx);
    const latest = (
      await tx.query<{ revision: number }>(
        'SELECT COALESCE(MAX(revision),0)::integer revision FROM whaleu_campus.community_identity_selections WHERE account_id=$1',
        [accountId],
      )
    ).rows[0]!.revision;
    const structureKnown =
      head === null
        ? latest === 0
        : Number.isInteger(head.revision) &&
          head.revision >= 0 &&
          latest === head.revision &&
          (head.revision === 0
            ? head.selection_id === null
            : !!head.selection_id && !!current);
    const result: OwnCampusFacts = {
      selection: 'unavailable',
      reason: 'history_unknown',
      selectedCampus: null,
      options: { status: 'unavailable', items: [] },
      writable: false,
      head,
      current,
      topology: snapshot,
      validUntil: null,
      fingerprint: null,
    };
    const topology = snapshot && parseTopology(snapshot.topology);
    const origin =
      topology && knownRegion(topology, affiliation.originRegionId);
    if (
      !snapshot ||
      !topology ||
      !origin ||
      origin.institutionId !== affiliation.institutionId
    ) {
      result.reason = 'topology_unavailable';
      return result;
    }
    // Plan locks under the phantom-safe outer gate; acquire and reread rows below.
    const snapshotIds = [...topology.assignments.values()]
      .filter((row) => row.institutionId === affiliation.institutionId)
      .map((row) => row.campusId);
    const extraIds = [
      ...new Set([
        ...snapshotIds,
        ...(current?.campus_id ? [current.campus_id] : []),
      ]),
    ].sort();
    const planned = (
      await tx.query<PhysicalCampus>(
        'SELECT id,institution_id,full_name,is_active,xmin::text state_version FROM whaleu_campus.campuses WHERE institution_id=$1 OR id=ANY($2::uuid[]) ORDER BY id',
        [affiliation.institutionId, extraIds],
      )
    ).rows;
    const campusIds = planned.map((row) => row.id);
    const plannedAssignments = (
      await tx.query<PhysicalAssignment>(
        'SELECT campus_id,operating_region_id,xmin::text state_version FROM whaleu_campus.campus_region_assignments WHERE campus_id=ANY($1::uuid[]) ORDER BY campus_id',
        [campusIds],
      )
    ).rows;
    const regionIds = [
      ...new Set([
        origin.regionId,
        ...[...topology.regions.values()]
          .filter(
            (row) =>
              row.institutionId === affiliation.institutionId &&
              row.groupId === origin.groupId,
          )
          .map((row) => row.regionId),
        ...[...topology.assignments.values()]
          .filter((row) => row.institutionId === affiliation.institutionId)
          .map((row) => row.regionId),
        ...plannedAssignments.map((row) => row.operating_region_id),
      ]),
    ].sort();
    const regions = (
      await tx.query<PhysicalRegion>(
        'SELECT id,name,is_active,xmin::text state_version FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [regionIds],
      )
    ).rows;
    const institutionIds = [
      ...new Set([
        affiliation.institutionId,
        ...planned.map((row) => row.institution_id),
      ]),
    ].sort();
    const institutions = (
      await tx.query<PhysicalInstitution>(
        'SELECT id,xmin::text state_version FROM whaleu_campus.institutions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [institutionIds],
      )
    ).rows;
    const campuses = (
      await tx.query<PhysicalCampus>(
        'SELECT id,institution_id,full_name,is_active,xmin::text state_version FROM whaleu_campus.campuses WHERE institution_id=$1 OR id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
        [affiliation.institutionId, extraIds],
      )
    ).rows;
    const assignments = (
      await tx.query<PhysicalAssignment>(
        'SELECT campus_id,operating_region_id,xmin::text state_version FROM whaleu_campus.campus_region_assignments WHERE campus_id=ANY($1::uuid[]) ORDER BY campus_id FOR SHARE',
        [campusIds],
      )
    ).rows;
    const now = await databaseNow(tx);
    if (
      !validProvenance(snapshot, now) ||
      (affiliation.validUntil !== null &&
        (!Number.isFinite(affiliation.validUntil) ||
          affiliation.validUntil <= now))
    ) {
      result.reason = 'topology_unavailable';
      return result;
    }
    const regionMap = new Map(regions.map((row) => [row.id, row]));
    const campusMap = new Map(campuses.map((row) => [row.id, row]));
    const assignmentMap = new Map(
      assignments.map((row) => [row.campus_id, row]),
    );
    const originActive = regionMap.get(origin.regionId)?.is_active === true;
    const institutionKnown = institutions.some(
      (row) => row.id === affiliation.institutionId,
    );
    const summary = (id: string): IdentityCampusSummary | null => {
      const campus = campusMap.get(id),
        reviewed = topology.assignments.get(id),
        actual = assignmentMap.get(id);
      const region = reviewed && knownRegion(topology, reviewed.regionId);
      const physicalRegion = region && regionMap.get(region.regionId);
      if (
        !originActive ||
        !institutionKnown ||
        !campus?.is_active ||
        campus.institution_id !== affiliation.institutionId ||
        !reviewed ||
        reviewed.coverage !== 'complete' ||
        !reviewed.isActive ||
        reviewed.institutionId !== affiliation.institutionId ||
        !region ||
        region.groupId !== origin.groupId ||
        !physicalRegion?.is_active ||
        actual?.operating_region_id !== region.regionId
      )
        return null;
      return {
        id: campus.id,
        name: campus.full_name,
        operatingRegion: { id: physicalRegion.id, name: physicalRegion.name },
      };
    };
    // Selected authority is independently validated; unrelated inventory gaps do
    // not hide an otherwise exact valid current choice.
    const historicalEffective =
      current?.effective_at instanceof Date
        ? current.effective_at.getTime()
        : Number.NaN;
    // Accepted expired history is still known history. It cannot authorize now,
    // but can explain a stale binding without relabeling it as unknown evidence.
    if (
      current &&
      Number.isFinite(historicalEffective) &&
      historicalEffective <= now &&
      validProvenance(current, historicalEffective)
    ) {
      if (
        current.affiliation_assertion_id !== affiliation.assertionId ||
        current.affiliation_snapshot_id !== affiliation.snapshotId ||
        current.topology_snapshot_id !== snapshot.id
      )
        result.reason = 'inputs_changed';
      else if (!validProvenance(current, now))
        result.reason = 'choice_no_longer_valid';
      else if (!originActive || !institutionKnown)
        result.reason = 'choice_no_longer_valid';
      else if (current.selection_state === 'selection_required') {
        result.selection = 'selection_required';
        result.reason = 'choice_required';
      } else {
        result.selectedCampus = current.campus_id
          ? summary(current.campus_id)
          : null;
        if (result.selectedCampus) {
          result.selection = 'valid';
          result.reason = 'current';
        } else result.reason = 'choice_no_longer_valid';
      }
    }
    // Every active institution campus must have a complete reviewed assignment
    // and known complete region/group, even when that known group is excluded.
    let complete = originActive && institutionKnown;
    const relevantRegions = [...topology.regions.values()].filter(
      (row) =>
        row.institutionId === affiliation.institutionId &&
        row.groupId === origin.groupId,
    );
    for (const region of relevantRegions) {
      const actual = regionMap.get(region.regionId);
      if (
        region.coverage !== 'complete' ||
        !actual ||
        actual.is_active !== region.isActive
      )
        complete = false;
    }
    for (const campus of campuses.filter(
      (row) =>
        row.institution_id === affiliation.institutionId && row.is_active,
    )) {
      const reviewed = topology.assignments.get(campus.id),
        actual = assignmentMap.get(campus.id);
      const region = reviewed && knownRegion(topology, reviewed.regionId);
      if (
        !reviewed ||
        reviewed.institutionId !== affiliation.institutionId ||
        reviewed.coverage !== 'complete' ||
        !reviewed.isActive ||
        !region ||
        !regionMap.get(region.regionId)?.is_active ||
        actual?.operating_region_id !== reviewed.regionId
      )
        complete = false;
    }
    // Reverse reconciliation: never silently drop missing/remapped/inactive rows
    // that the snapshot says belong to this institution, including zero results.
    for (const reviewed of [...topology.assignments.values()].filter(
      (row) => row.institutionId === affiliation.institutionId,
    )) {
      const campus = campusMap.get(reviewed.campusId),
        actual = assignmentMap.get(reviewed.campusId),
        region = topology.regions.get(reviewed.regionId),
        physicalRegion = regionMap.get(reviewed.regionId);
      if (
        reviewed.coverage !== 'complete' ||
        !campus ||
        campus.institution_id !== reviewed.institutionId ||
        campus.is_active !== reviewed.isActive ||
        actual?.operating_region_id !== reviewed.regionId ||
        !region ||
        region.coverage !== 'complete' ||
        !physicalRegion ||
        physicalRegion.is_active !== region.isActive ||
        topology.groups.get(region.groupId)?.coverage !== 'complete'
      )
        complete = false;
    }
    if (!structureKnown) {
      result.selection = 'unavailable';
      result.reason = 'history_unknown';
      result.selectedCampus = null;
    }
    if (complete)
      result.options = {
        status: 'known',
        items: campuses
          .map((row) => summary(row.id))
          .filter((row): row is IdentityCampusSummary => row !== null),
      };
    result.writable = structureKnown && complete;
    result.validUntil = earliestDeadline(
      snapshot.valid_until?.getTime() ?? null,
      affiliation.validUntil,
    );
    if (result.selection !== 'unavailable')
      registerTransactionDeadline(
        tx,
        current!.valid_until?.getTime() ?? null,
        'IDENTITY_CAMPUS_UNAVAILABLE',
      );
    if (complete || result.selection !== 'unavailable')
      registerTransactionDeadline(
        tx,
        result.validUntil,
        'IDENTITY_CAMPUS_UNAVAILABLE',
      );
    result.fingerprint = [
      head,
      latest,
      snapshot.id,
      snapshot.revision,
      affiliation,
      regions,
      institutions,
      campuses,
      assignments,
    ];
    return result;
  }

  async receipt(
    accountId: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<StoredReceipt | null> {
    return (
      (
        await tx.query<StoredReceipt>(
          'SELECT client_request_id,campus_id,intent_hash,expected_state_revision,selection_revision,outcome FROM whaleu_campus.identity_selection_requests WHERE account_id=$1 AND client_request_id=$2 FOR SHARE',
          [accountId, requestId],
        )
      ).rows[0] ?? null
    );
  }
  receiptView(row: StoredReceipt): IdentityCampusReceipt {
    return {
      requestId: row.client_request_id,
      campusId: row.campus_id,
      outcome: row.outcome,
      selectionRevision: row.selection_revision,
    };
  }
  async select(
    accountId: string,
    intent: IdentityCampusIntent,
    affiliation: PublicationAffiliationMetadata,
    facts: OwnCampusFacts,
    tx: PoolClient,
  ): Promise<IdentityCampusReceipt> {
    if (!facts.writable || !facts.topology)
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    if (!facts.options.items.some((row) => row.id === intent.campusId))
      throw new ApplicationError('IDENTITY_CAMPUS_NOT_ELIGIBLE');
    const now = await databaseNow(tx);
    if (facts.validUntil !== null && facts.validUntil <= now)
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    const unchanged =
      facts.selection === 'valid' &&
      facts.current?.campus_id === intent.campusId;
    let selectionId = facts.current?.id,
      revision = facts.head?.revision ?? 0;
    if (!unchanged) {
      if (revision >= 2147483647)
        throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
      if (!facts.head)
        await tx.query(
          'INSERT INTO whaleu_campus.community_identity_heads(account_id) VALUES($1)',
          [accountId],
        );
      selectionId = randomUUID();
      revision++;
      await tx.query(
        `INSERT INTO whaleu_campus.community_identity_selections
        (id,account_id,revision,selection_state,campus_id,affiliation_assertion_id,affiliation_snapshot_id,topology_snapshot_id,
         coverage_state,provenance_state,source_reference,policy_reference,effective_at,expiry_kind,valid_until)
        VALUES($1,$2,$3,'selected',$4,$5,$6,$7,'complete','accepted',$8,'own-identity-campus-selection:v1',$9,$10,$11)`,
        [
          selectionId,
          accountId,
          revision,
          intent.campusId,
          affiliation.assertionId,
          affiliation.snapshotId,
          facts.topology.id,
          `authenticated-account:${accountId}:request:${intent.requestId}`,
          new Date(now),
          facts.validUntil === null ? 'policy_exempt' : 'at',
          facts.validUntil === null ? null : new Date(facts.validUntil),
        ],
      );
      await tx.query(
        'UPDATE whaleu_campus.community_identity_heads SET revision=$2,selection_id=$3 WHERE account_id=$1',
        [accountId, revision, selectionId],
      );
    }
    const outcome = unchanged ? 'unchanged' : 'applied';
    await tx.query(
      `INSERT INTO whaleu_campus.identity_selection_requests
      (account_id,client_request_id,operation,intent_version,intent_hash,campus_id,expected_state_revision,selection_id,selection_revision,outcome)
      VALUES($1,$2,'select_identity_campus',1,$3,$4,$5,$6,$7,$8)`,
      [
        accountId,
        intent.requestId,
        identitySelectionIntentHash(intent),
        intent.campusId,
        intent.expectedStateRevision,
        selectionId,
        revision,
        outcome,
      ],
    );
    return {
      requestId: intent.requestId,
      campusId: intent.campusId,
      outcome,
      selectionRevision: revision,
    };
  }
}
