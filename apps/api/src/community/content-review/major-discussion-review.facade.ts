import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { canonicalJson } from './contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export interface MajorDiscussionReviewEnvelope {
  version: 1;
  purpose: 'major.discussion.root.v1' | 'major.discussion.reply.v1';
  actorId: string;
  requestId: string;
  majorId: string;
  catalogRevision: string;
  majorRevision: string;
  body: string;
  rootId: string | null;
  replyToReplyId: string | null;
  replyToActorId: string | null;
}
export const majorDiscussionReviewDigest = (
  envelope: MajorDiscussionReviewEnvelope,
) =>
  createHash('sha256')
    .update('whaleu:major-discussion-review:v1\n' + canonicalJson(envelope))
    .digest('hex');
type Fact = { decisionId: string; status: 'allow' | 'reject' };
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.major_discussion_review_policies,whaleu_community.major_discussion_review_decisions,whaleu_community.major_discussion_review_heads,whaleu_community.major_discussion_review_epoch IN SHARE MODE NOWAIT',
      );
      for (const f of facts)
        if (
          (
            await read.query<{ status: string }>(
              'SELECT whaleu_community.major_discussion_review_status($1,true,clock_timestamp()) status',
              [f.decisionId],
            )
          ).rows[0]?.status !== f.status
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }),
};
/** Review-owned exact purposes. No production issuer or blanket approval. */
@Injectable()
export class MajorDiscussionReviewFacade {
  async consume(envelope: MajorDiscussionReviewEnvelope, tx: PoolClient) {
    const row = (
      await tx.query<{
        id: string;
        digest: string;
        status: string;
        until: string;
      }>(
        `SELECT d.id,d.digest,whaleu_community.major_discussion_review_status(d.id,true,clock_timestamp()) status,least(d.consume_until,d.visibility_until,p.valid_until)::text until FROM whaleu_community.major_discussion_review_heads h JOIN whaleu_community.major_discussion_review_decisions d ON d.id=h.decision_id JOIN whaleu_community.major_discussion_review_policies p ON p.id=d.policy_id WHERE h.actor_id=$1 AND h.request_id=$2`,
        [envelope.actorId, envelope.requestId],
      )
    ).rows[0];
    if (
      !row ||
      row.digest !== majorDiscussionReviewDigest(envelope) ||
      (row.status !== 'allow' && row.status !== 'reject')
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      row.until,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(
      tx,
      proof,
      row.id,
      Object.freeze({ decisionId: row.id, status: row.status }),
    );
    return { decisionId: row.id, status: row.status };
  }
}
