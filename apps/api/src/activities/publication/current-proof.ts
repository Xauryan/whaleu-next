import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
interface Fact {
  kind: 'draft' | 'native' | 'review' | 'directory';
  id: string;
  fingerprint: string;
}
async function state(kind: Fact['kind'], id: string, tx: PoolClient) {
  if (kind === 'directory')
    return ownerFingerprint(
      (await tx.query('SELECT * FROM whaleu_activities.native_directory_epoch'))
        .rows,
    );
  if (kind === 'review')
    return ownerFingerprint(
      (
        await tx.query(
          `SELECT d.*,d.xmin::text dv,h.state,h.revision,h.event_id,h.xmin::text hv,to_jsonb(e) event,e.xmin::text ev,p.*,p.xmin::text pv FROM whaleu_activities.review_decisions d JOIN whaleu_activities.review_heads h ON h.decision_id=d.id JOIN whaleu_activities.review_events e ON(e.id,e.decision_id,e.revision,e.state)=(h.event_id,h.decision_id,h.revision,h.state) JOIN whaleu_activities.review_policies p ON p.id=d.policy_id WHERE d.id=$1`,
          [id],
        )
      ).rows,
    );
  return ownerFingerprint(
    (
      await tx.query(
        `SELECT *,xmin::text version FROM whaleu_activities.${kind === 'draft' ? 'publication_drafts' : 'native_activities'} WHERE id=$1`,
        [id],
      )
    ).rows,
  );
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 96,
  failureCode: 'ACTIVITY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'ACTIVITY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_activities.publication_drafts,whaleu_activities.native_activities,whaleu_activities.review_decisions,whaleu_activities.review_heads,whaleu_activities.review_events,whaleu_activities.review_policies,whaleu_activities.native_directory_epoch IN SHARE MODE NOWAIT',
      );
      for (const fact of facts)
        if ((await state(fact.kind, fact.id, read)) !== fact.fingerprint)
          throw new ApplicationError('ACTIVITY_UNAVAILABLE');
    }),
};
export async function requireActivityCurrent(
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
}
export async function lockActivity(id: string, tx: PoolClient) {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:activity-publication:v1:'||$1,0))",
    [id],
  );
}
