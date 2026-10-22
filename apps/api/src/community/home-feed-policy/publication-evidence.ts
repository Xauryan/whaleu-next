import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { AcceptedApproval } from '../content-review/contracts.js';
import {
  approvalDigest,
  canonicalEnvelope,
} from '../content-review/contracts.js';
/** Stage original immutable Home evidence before optional source and Review
 * binding. Deferred SQL closure requires the genuine same-transaction content,
 * original receipt, origin, outbox and exact accepted decision. */
export async function insertHomePublicationEvidence(
  approval: AcceptedApproval | undefined,
  kind: 'post' | 'comment' | 'reply',
  id: string,
  tx: PoolClient,
): Promise<void> {
  if (!approval || (approval.version !== 7 && approval.version !== 8)) return;
  const envelope = canonicalEnvelope(approval.envelope);
  if (
    approval.version !== envelope.version ||
    approvalDigest(envelope) !== approval.digest ||
    envelope.purpose !== `publish_${kind}`
  )
    throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  if (envelope.version === 7 && kind === 'post') {
    await tx.query(
      `INSERT INTO whaleu_community.home_post_dispositions(post_id,decision_id,digest,evidence) VALUES($1,$2,$3,$4::jsonb)`,
      [id, approval.decisionId, approval.digest, JSON.stringify(envelope.home)],
    );
    return;
  }
  if (envelope.version === 8 && kind !== 'post') {
    await tx.query(
      `INSERT INTO whaleu_community.home_discussion_parent_bindings(content_kind,content_id,post_id,parent_decision_id,parent_digest,decision_id,digest) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        kind,
        id,
        envelope.postId,
        envelope.homeParent.decisionId,
        envelope.homeParent.digest,
        approval.decisionId,
        approval.digest,
      ],
    );
    return;
  }
  throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
}
