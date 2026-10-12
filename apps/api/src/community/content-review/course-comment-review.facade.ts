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
export interface CourseCommentReviewEnvelope {
  version: 1;
  purpose: 'course.comment.publish.v1';
  actorId: string;
  requestId: string;
  courseId: string;
  catalogRevision: string;
  courseRevision: string;
  body: string;
}
export function courseCommentReviewDigest(
  envelope: CourseCommentReviewEnvelope,
) {
  return createHash('sha256')
    .update('whaleu:course-comment-review:v1\n' + canonicalJson(envelope))
    .digest('hex');
}
type Status = 'allow' | 'reject' | 'deny' | 'unavailable';
async function epoch(tx: PoolClient) {
  const row = (
    await tx.query<{ revision: string }>(
      'SELECT revision::text FROM whaleu_community.course_comment_review_epoch WHERE singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return row.revision;
}
async function ranking(courseId: string, tx: PoolClient) {
  return (
    await tx.query<{ available: boolean; valid_until: string | null }>(
      `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now) SELECT coalesce(bool_and(whaleu_community.course_comment_review_status(d.id,false,instant.now)<>'unavailable'),true) available,min(least(d.visibility_until,p.valid_until))::text valid_until FROM whaleu_community.course_comment_review_bindings b JOIN whaleu_community.course_comment_review_decisions d ON d.id=b.decision_id JOIN whaleu_community.course_comment_review_policies p ON p.id=d.policy_id CROSS JOIN instant WHERE b.course_id=$1`,
      [courseId],
    )
  ).rows[0]!;
}
type Fact =
  | { kind: 'ranking'; courseId: string; epoch: string }
  | { kind: 'consume'; decisionId: string; status: Status; epoch: string };
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.course_comment_review_policies,whaleu_community.course_comment_review_decisions,whaleu_community.course_comment_review_heads,whaleu_community.course_comment_review_bindings,whaleu_community.course_comment_review_epoch IN SHARE MODE NOWAIT',
      );
      const current = await epoch(read);
      for (const f of facts) {
        if (f.epoch !== current)
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        if (f.kind === 'ranking') {
          if (!(await ranking(f.courseId, read)).available)
            throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        } else if (
          (
            await read.query<{ status: Status }>(
              'SELECT whaleu_community.course_comment_review_status($1,true,clock_timestamp()) status',
              [f.decisionId],
            )
          ).rows[0]?.status !== f.status
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
      }
    }),
};
/** Narrow leaf under Review. Tests alone issue exact decisions; no blanket allows. */
@Injectable()
export class CourseCommentReviewFacade {
  async consume(envelope: CourseCommentReviewEnvelope, tx: PoolClient) {
    const digest = courseCommentReviewDigest(envelope);
    const row = (
      await tx.query<{ id: string; digest: string; status: Status }>(
        `SELECT d.id,d.digest,whaleu_community.course_comment_review_status(d.id,true,clock_timestamp()) status FROM whaleu_community.course_comment_review_heads h JOIN whaleu_community.course_comment_review_decisions d ON d.id=h.decision_id WHERE h.actor_id=$1 AND h.request_id=$2`,
        [envelope.actorId, envelope.requestId],
      )
    ).rows[0];
    if (
      !row ||
      row.digest !== digest ||
      row.status === 'unavailable' ||
      row.status === 'deny'
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return { decisionId: row.id, status: row.status };
  }
  async bind(
    commentId: string,
    courseId: string,
    decisionId: string,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_community.course_comment_review_bindings(comment_id,course_id,decision_id) VALUES($1,$2,$3)',
      [commentId, courseId, decisionId],
    );
  }
  async retainConsumed(
    decisionId: string,
    status: 'allow' | 'reject',
    tx: PoolClient,
  ) {
    const until = (
      await tx.query<{ until: string }>(
        'SELECT least(d.consume_until,d.visibility_until,p.valid_until)::text until FROM whaleu_community.course_comment_review_decisions d JOIN whaleu_community.course_comment_review_policies p ON p.id=d.policy_id WHERE d.id=$1',
        [decisionId],
      )
    ).rows[0]?.until;
    if (!until) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    registerTransactionExactDeadline(tx, until, 'CONTENT_REVIEW_UNAVAILABLE');
    const value = await epoch(tx);
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(
      tx,
      proof,
      decisionId,
      Object.freeze({
        kind: 'consume' as const,
        decisionId,
        status,
        epoch: value,
      }),
    );
  }
  async ranking(courseId: string, tx: PoolClient) {
    const value = await epoch(tx),
      result = await ranking(courseId, tx);
    if (!result.available)
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      result.valid_until,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(
      tx,
      proof,
      courseId,
      Object.freeze({ kind: 'ranking' as const, courseId, epoch: value }),
    );
    return { epoch: value, validUntil: result.valid_until };
  }
  async visibility(commentId: string, tx: PoolClient) {
    const status = (
      await tx.query<{ status: Status }>(
        'SELECT whaleu_community.course_comment_visibility($1,clock_timestamp()) status',
        [commentId],
      )
    ).rows[0]!.status;
    if (status === 'unavailable')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return status === 'allow';
  }
}
