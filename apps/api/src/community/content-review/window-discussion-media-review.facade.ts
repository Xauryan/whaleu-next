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
export interface WindowDiscussionMediaReviewEnvelope {
  version: 2;
  purpose: 'window.discussion.root.v2' | 'window.discussion.reply.v2';
  actorId: string;
  requestId: string;
  windowId: string;
  catalogRevision: string;
  windowRevision: string;
  body: string;
  images: readonly { assetId: string; manifestDigest: string }[];
  rootId: string | null;
  replyToReplyId: string | null;
  replyToActorId: string | null;
}
export const windowDiscussionMediaReviewDigest = (
  envelope: WindowDiscussionMediaReviewEnvelope,
) =>
  createHash('sha256')
    .update('whaleu:window-discussion-review:v2\n' + canonicalJson(envelope))
    .digest('hex');
type Fact = {
  decisionId: string;
  status: 'allow' | 'reject';
  reviewEpoch: string;
};
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.window_discussion_media_review_policies,whaleu_community.window_discussion_media_review_decisions,whaleu_community.window_discussion_media_review_heads,whaleu_community.window_discussion_review_epoch IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const current = (
          await read.query<{ status: string; review_epoch: string }>(
            'SELECT whaleu_community.window_discussion_media_review_status($1,true,clock_timestamp()) status,e.revision::text review_epoch FROM whaleu_community.window_discussion_review_epoch e WHERE e.singleton',
            [f.decisionId],
          )
        ).rows[0];
        if (
          current?.status !== f.status ||
          current?.review_epoch !== f.reviewEpoch
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
    }),
};
/** Review-owned exact purposes. No production issuer or blanket approval. */
@Injectable()
export class WindowDiscussionMediaReviewFacade {
  async consume(envelope: WindowDiscussionMediaReviewEnvelope, tx: PoolClient) {
    const row = (
      await tx.query<{
        id: string;
        digest: string;
        status: string;
        until: string;
        review_epoch: string;
      }>(
        `SELECT d.id,d.digest,whaleu_community.window_discussion_media_review_status(d.id,true,clock_timestamp()) status,least(d.consume_until,d.visibility_until,p.valid_until)::text until,e.revision::text review_epoch FROM whaleu_community.window_discussion_media_review_heads h JOIN whaleu_community.window_discussion_media_review_decisions d ON d.id=h.decision_id JOIN whaleu_community.window_discussion_media_review_policies p ON p.id=d.policy_id CROSS JOIN whaleu_community.window_discussion_review_epoch e WHERE h.actor_id=$1 AND h.request_id=$2 AND e.singleton`,
        [envelope.actorId, envelope.requestId],
      )
    ).rows[0];
    if (
      !row ||
      row.digest !== windowDiscussionMediaReviewDigest(envelope) ||
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
      Object.freeze({
        decisionId: row.id,
        status: row.status,
        reviewEpoch: row.review_epoch,
      }),
    );
    return { decisionId: row.id, status: row.status };
  }
}
