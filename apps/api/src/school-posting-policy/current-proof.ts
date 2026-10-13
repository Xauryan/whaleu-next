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
  actorId: string;
  regionId: string;
  fingerprint: string;
}
async function fingerprint(fact: Omit<Fact, 'fingerprint'>, tx: PoolClient) {
  const result = await tx.query(
    `SELECT
    (SELECT jsonb_agg(jsonb_build_array(to_jsonb(g),g.xmin::text,g.ctid::text) ORDER BY g.id) FROM whaleu_authorization.role_grants g WHERE g.account_id=$1) grants,
    (SELECT jsonb_build_array(to_jsonb(r),r.xmin::text,r.ctid::text) FROM whaleu_campus.operating_regions r WHERE r.id=$2) region,
    (SELECT jsonb_build_array(to_jsonb(h),h.xmin::text,h.ctid::text,to_jsonb(p),p.xmin::text,p.ctid::text) FROM whaleu_community.region_policy_heads h LEFT JOIN whaleu_community.region_policy_revisions p ON p.id=h.revision_id WHERE h.region_id=$2) policy`,
    [fact.actorId, fact.regionId],
  );
  return ownerFingerprint(result.rows);
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 8,
  failureCode: 'SCHOOL_POSTING_POLICY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'SCHOOL_POSTING_POLICY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants,whaleu_campus.operating_regions,whaleu_community.region_policy_heads,whaleu_community.region_policy_revisions IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await fingerprint(fact, read)) !== fact.fingerprint)
          throw new ApplicationError('SCHOOL_POSTING_POLICY_UNAVAILABLE');
    }),
};
export async function requireSchoolPostingCurrent(
  actorId: string,
  regionId: string,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, proof);
  const fact = {
    actorId,
    regionId,
    fingerprint: await fingerprint({ actorId, regionId }, tx),
  };
  registerRequiredTransactionFact(
    tx,
    proof,
    JSON.stringify(fact),
    Object.freeze(fact),
  );
}
