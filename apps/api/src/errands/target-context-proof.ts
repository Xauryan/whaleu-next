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
  orderId: string;
  fingerprint: string;
}
async function state(orderId: string, tx: PoolClient) {
  return ownerFingerprint(
    (
      await tx.query(
        `SELECT to_jsonb(o) o,o.xmin::text ov,to_jsonb(p) p,p.xmin::text pv,to_jsonb(s) s,s.xmin::text sv,to_jsonb(t) t,t.xmin::text tv
     FROM whaleu_errands.orders o JOIN whaleu_errands.private_details p ON p.order_id=o.id
     JOIN whaleu_campus.operating_regions s ON s.id=o.source_region_id
     JOIN whaleu_campus.operating_regions t ON t.id=o.target_region_id WHERE o.id=$1`,
        [orderId],
      )
    ).rows,
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 8,
  failureCode: 'ERRAND_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'ERRAND_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_errands.orders,whaleu_errands.private_details,whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await state(fact.orderId, read)) !== fact.fingerprint)
          throw new ApplicationError('ERRAND_UNAVAILABLE');
    }),
};
/** Extra final owner fence for cross-module projections and both byte authorizations. */
export async function requireErrandTargetCurrent(
  orderId: string,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, proof);
  const fingerprint = await state(orderId, tx);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${orderId}:${fingerprint}`,
    Object.freeze({ orderId, fingerprint }),
  );
}
