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
export interface DishReviewEnvelope {
  version: 1;
  purpose: 'window.dish.recommend.v1';
  actorId: string;
  requestId: string;
  windowId: string;
  catalogRevision: string;
  windowRevision: string;
  dishName: string;
  dishIdentity: string;
}
export const dishIdentity = (name: string) =>
  Buffer.from(name, 'utf8').toString('hex');
export function dishReviewDigest(envelope: DishReviewEnvelope) {
  return createHash('sha256')
    .update('whaleu:window-dish-review:v1\n' + canonicalJson(envelope))
    .digest('hex');
}
type Status = 'allow' | 'reject' | 'deny' | 'unavailable';
interface Fact {
  decisionId: string;
  status: 'allow' | 'reject';
  epoch: string;
}
async function epoch(tx: PoolClient) {
  const row = (
    await tx.query<{ revision: string }>(
      'SELECT revision::text FROM whaleu_community.dish_review_epoch WHERE singleton',
    )
  ).rows[0];
  if (!row) throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
  return row.revision;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'CONTENT_REVIEW_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'CONTENT_REVIEW_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_community.dish_review_policies,whaleu_community.dish_review_decisions,whaleu_community.dish_review_heads,whaleu_community.dish_review_epoch IN SHARE MODE NOWAIT',
      );
      const current = await epoch(read);
      for (const f of facts)
        if (
          f.epoch !== current ||
          (
            await read.query<{ status: Status }>(
              'SELECT whaleu_community.dish_review_status($1,true,clock_timestamp()) status',
              [f.decisionId],
            )
          ).rows[0]?.status !== f.status
        )
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    }),
};
/** Canonical Review purpose, never a generic score/comment allow or live issuer. */
@Injectable()
export class DishReviewFacade {
  async consume(envelope: DishReviewEnvelope, tx: PoolClient) {
    const row = (
      await tx.query<{ id: string; digest: string; status: Status }>(
        `SELECT d.id,d.digest,whaleu_community.dish_review_status(d.id,true,clock_timestamp()) status FROM whaleu_community.dish_review_heads h JOIN whaleu_community.dish_review_decisions d ON d.id=h.decision_id WHERE h.actor_id=$1 AND h.request_id=$2`,
        [envelope.actorId, envelope.requestId],
      )
    ).rows[0];
    if (
      !row ||
      row.digest !== dishReviewDigest(envelope) ||
      row.status === 'unavailable' ||
      row.status === 'deny'
    )
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    const until = (
      await tx.query<{ until: string }>(
        'SELECT least(d.consume_until,d.visibility_until,p.valid_until)::text until FROM whaleu_community.dish_review_decisions d JOIN whaleu_community.dish_review_policies p ON p.id=d.policy_id WHERE d.id=$1',
        [row.id],
      )
    ).rows[0]!.until;
    registerTransactionExactDeadline(tx, until, 'CONTENT_REVIEW_UNAVAILABLE');
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(
      tx,
      proof,
      row.id,
      Object.freeze({
        decisionId: row.id,
        status: row.status,
        epoch: await epoch(tx),
      }),
    );
    return { decisionId: row.id, status: row.status };
  }
}
