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
interface Fact {
  actor: string;
  selected: string;
  initial: unknown;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'SCHOOL_IDENTITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'SCHOOL_IDENTITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants,whaleu_majors.major_delete_authority_epoch IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const row = (
          await read.query<{ facts: unknown; allowed: boolean }>(
            'SELECT whaleu_authorization.school_admin_management_input_facts($1,$2,NULL,false) facts,whaleu_authorization.school_admin_management_super($1,$2) allowed',
            [f.actor, f.selected],
          )
        ).rows[0];
        if (
          !row?.allowed ||
          ownerFingerprint(row.facts) !== ownerFingerprint(f.initial)
        )
          throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
      }
    }),
};
export async function retainLookupAuthority(
  actor: string,
  selected: string,
  initial: unknown,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    'lookup-authority',
    Object.freeze({ actor, selected, initial }),
  );
}
