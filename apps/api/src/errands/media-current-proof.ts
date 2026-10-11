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
type Fact = { kind: 'draft' | 'order'; id: string; fingerprint: string };
async function state(kind: Fact['kind'], id: string, tx: PoolClient) {
  if (kind === 'draft')
    return ownerFingerprint(
      (
        await tx.query(
          `SELECT
            (SELECT to_jsonb(d)||jsonb_build_object('version',d.xmin::text) FROM whaleu_errands.media_drafts d WHERE d.id=$1) draft,
            (SELECT coalesce(jsonb_agg(to_jsonb(c)||jsonb_build_object('version',c.xmin::text) ORDER BY c.actor_id),'[]'::jsonb) FROM whaleu_errands.media_draft_cancellations c WHERE c.draft_id=$1) cancellations`,
          [id],
        )
      ).rows,
    );
  return ownerFingerprint(
    (
      await tx.query(
        `SELECT to_jsonb(o) o,o.xmin::text ov,to_jsonb(p) p,p.xmin::text pv,
    to_jsonb(h) h,h.xmin::text hv,to_jsonb(s) s,to_jsonb(b) b,to_jsonb(mb) mb,
    to_jsonb(d) d,to_jsonb(rh) rh,rh.xmin::text rhv,to_jsonb(e) e,to_jsonb(policy) policy
    FROM whaleu_errands.orders o JOIN whaleu_errands.private_details p ON p.order_id=o.id
    JOIN whaleu_errands.media_heads h ON h.order_id=o.id
    JOIN whaleu_errands.media_sets s ON (s.order_id,s.revision)=(h.order_id,h.revision)
    JOIN whaleu_community.errand_approval_bindings b ON b.order_id=o.id
    LEFT JOIN whaleu_community.errand_media_approval_bindings mb ON(mb.order_id,mb.media_revision)=(h.order_id,h.revision)
    LEFT JOIN whaleu_community.errand_approval_decisions d ON d.id=CASE WHEN h.revision=1 THEN b.decision_id ELSE mb.decision_id END
    LEFT JOIN whaleu_community.errand_approval_heads rh ON rh.decision_id=d.id
    LEFT JOIN whaleu_community.errand_approval_events e ON e.id=rh.event_id
    LEFT JOIN whaleu_community.content_approval_policies policy ON policy.id=d.policy_revision_id
    WHERE o.id=$1`,
        [id],
      )
    ).rows,
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 128,
  failureCode: 'ERRAND_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'ERRAND_UNAVAILABLE', async (read) => {
      await read.query(`LOCK TABLE whaleu_errands.media_drafts,whaleu_errands.media_draft_cancellations,whaleu_errands.orders,whaleu_errands.private_details,
      whaleu_errands.media_publications,whaleu_errands.media_heads,whaleu_errands.media_sets,
      whaleu_community.errand_approval_bindings,whaleu_community.errand_media_approval_bindings,
      whaleu_community.errand_approval_decisions,whaleu_community.errand_approval_heads,
      whaleu_community.errand_approval_events,whaleu_community.content_approval_policies IN SHARE MODE NOWAIT`);
      for (const fact of facts)
        if ((await state(fact.kind, fact.id, read)) !== fact.fingerprint)
          throw new ApplicationError('ERRAND_UNAVAILABLE');
    }),
};
export async function requireErrandMediaCurrent(
  kind: Fact['kind'],
  id: string,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, proof);
  const fingerprint = await state(kind, id, tx);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${kind}:${id}:${fingerprint}`,
    Object.freeze({ kind, id, fingerprint }),
  );
  return fingerprint;
}
