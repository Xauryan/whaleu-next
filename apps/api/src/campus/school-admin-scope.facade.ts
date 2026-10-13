import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import type { PublicationAffiliationMetadata } from './community-policy/contracts.js';
import { IdentitySelectionRepository } from './community-policy/identity-selection.repository.js';

const code = 'SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE' as const;
interface ScopeObservation {
  institutionId: string;
  fingerprint: string;
}
export interface SchoolAdminScope {
  status: 'known' | 'unavailable';
  regions: { id: string; name: string }[];
  defaultRegionId: string | null;
  validUntil: number | null;
  fingerprint: unknown;
  topologySnapshotId: string | null;
}
async function sourceFacts(
  institutionId: string,
  tx: PoolClient,
): Promise<unknown> {
  const row = (
    await tx.query<{ facts: unknown }>(
      'SELECT whaleu_authorization.school_admin_scope_facts($1) facts',
      [institutionId],
    )
  ).rows[0];
  if (!row) throw new ApplicationError(code);
  return row.facts;
}
const scopeProof: RequiredTransactionProof<ScopeObservation> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      await read.query(`LOCK TABLE whaleu_campus.community_topology_heads,
      whaleu_campus.community_topology_snapshots,whaleu_campus.operating_regions,
      whaleu_campus.institutions,whaleu_campus.campuses,
      whaleu_campus.campus_region_assignments IN SHARE MODE NOWAIT`);
      for (const fact of facts) {
        if (
          ownerFingerprint(await sourceFacts(fact.institutionId, read)) !==
          fact.fingerprint
        )
          throw new ApplicationError(code);
      }
    }),
};

/** Campus owns accepted group membership and the bidirectionally reconciled
 * physical inventory. Identity-campus choice is only an optional default hint:
 * it can never widen eligible regions or prevent a proven explicit appointment.
 * The caller holds the common outer gate before any owner row lock. */
@Injectable()
export class SchoolAdminScopeFacade {
  constructor(
    @Inject(IdentitySelectionRepository)
    private readonly selections: IdentitySelectionRepository,
  ) {}

  async resolve(
    accountId: string,
    affiliation: PublicationAffiliationMetadata,
    tx: PoolClient,
  ): Promise<SchoolAdminScope> {
    // Never replace this pre-lock observation with a fresh post-wait snapshot.
    const initial = await sourceFacts(affiliation.institutionId, tx);
    enableRequiredTransactionProof(tx, scopeProof);
    registerRequiredTransactionFact(
      tx,
      scopeProof,
      affiliation.institutionId,
      Object.freeze({
        institutionId: affiliation.institutionId,
        fingerprint: ownerFingerprint(initial),
      }),
    );
    const own = await this.selections.own(
      accountId,
      affiliation,
      tx,
      false,
      'school_admin_scope',
    );
    const regions =
      own.options.status === 'known'
        ? [
            ...new Map(
              own.options.items.map((campus) => [
                campus.operatingRegion.id,
                campus.operatingRegion,
              ]),
            ).values(),
          ].sort((a, b) => a.id.localeCompare(b.id))
        : [];
    const selected =
      own.selection === 'valid' ? own.selectedCampus?.operatingRegion.id : null;
    if (own.topology && own.options.status === 'known') {
      const deadline = (
        await tx.query<{ until: string | null }>(
          'SELECT valid_until::text until FROM whaleu_campus.community_topology_snapshots WHERE id=$1',
          [own.topology.id],
        )
      ).rows[0];
      if (!deadline) throw new ApplicationError(code);
      registerTransactionExactDeadline(tx, deadline.until, code);
    }
    return {
      status: own.options.status,
      regions,
      defaultRegionId:
        selected && regions.some((region) => region.id === selected)
          ? selected
          : null,
      validUntil: own.validUntil,
      fingerprint: initial,
      topologySnapshotId: own.topology?.id ?? null,
    };
  }
}
