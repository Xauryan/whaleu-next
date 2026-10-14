import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
const code = 'SCHOOL_IDENTITY_UNAVAILABLE' as const;
interface Fact {
  actor: string;
  selected: string | null;
  target: string;
  campus: string | null;
  initial: unknown;
  generation: unknown;
  commandId: string | null;
  causeId: string | null;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: code,
  validate: (facts, tx) =>
    boundedOwnerProof(tx, code, async (read) => {
      if (facts.some((f) => f.selected !== null))
        await read.query(
          'LOCK TABLE whaleu_community.related_sync_admission_generation,whaleu_identity.accounts,whaleu_identity.legacy_account_mappings,whaleu_profile.profiles,whaleu_authorization.role_grants,whaleu_majors.major_delete_authority_epoch,whaleu_safety.blocks,whaleu_campus.campuses,whaleu_campus.institutions,whaleu_campus.school_identifiers,whaleu_campus.campus_region_assignments,whaleu_campus.operating_regions,whaleu_school_uid.admission_heads,whaleu_school_uid.school_admissions,whaleu_school_uid.account_heads,whaleu_school_uid.account_coverage,whaleu_school_uid.allocations,whaleu_school_uid.assignment_events,whaleu_school_uid.commands,whaleu_verification.native_enrollments,whaleu_verification.account_heads,whaleu_verification.snapshots,whaleu_verification.assertions IN SHARE MODE NOWAIT',
        );
      for (const f of facts) {
        if (f.commandId) {
          const r = await read.query(
            'SELECT whaleu_school_uid.command_assert_complete(q) FROM whaleu_school_uid.commands q WHERE id=$1',
            [f.commandId],
          );
          if (r.rowCount !== 1) throw new ApplicationError(code);
        } else {
          const r = (
            await read.query<{ facts: unknown; generation: unknown }>(
              'SELECT whaleu_school_uid.management_inputs($1,$2,$3,$4) facts,whaleu_verification.school_identity_admission_vector() generation',
              [f.actor, f.selected, f.target, f.campus],
            )
          ).rows[0];
          if (
            !r ||
            ownerFingerprint(r.facts) !== ownerFingerprint(f.initial) ||
            ownerFingerprint(r.generation) !== ownerFingerprint(f.generation)
          )
            throw new ApplicationError(code);
        }
      }
    }),
};
export function retainSchoolIdentityProof(fact: Fact, tx: PoolClient) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'school-identity',
    Object.freeze(fact),
  );
}
