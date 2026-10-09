import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
import { ratingIso } from '../repository.js';
interface LikeRow {
  subject_id: string;
  baseline_id: string;
  baseline_at: string;
  count: number;
  head_id: string | null;
  sequence: string;
  liked: boolean;
  revision: string;
  occurred_at: string;
  last_transition_id: string | null;
}
interface Fact {
  id: string;
  actor: string;
  baseline: string;
  count: number;
  head: string | null;
  sequence: string;
  revision: string;
  liked: boolean;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 1,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      await read.query(
        'SELECT subject_id FROM whaleu_ratings.like_states WHERE subject_id=ANY($1::uuid[]) FOR SHARE NOWAIT',
        [facts.map((f) => f.id)],
      );
      const rows = (
        await read.query<{ n: number }>(
          `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::integer[],$5::uuid[],$6::bigint[],$7::uuid[],$8::boolean[]) f(id,actor,baseline,count,head,sequence,revision,liked) JOIN whaleu_ratings.like_subjects s ON s.id=f.id AND s.baseline_id=f.baseline JOIN whaleu_ratings.like_states st ON st.subject_id=s.id AND (st.count,st.head_id,st.sequence) IS NOT DISTINCT FROM (f.count,f.head,f.sequence) LEFT JOIN whaleu_ratings.like_memberships m ON m.subject_id=s.id AND m.account_id=f.actor WHERE coalesce(m.revision,s.baseline_id)=f.revision AND coalesce(m.liked,false)=f.liked AND (m.subject_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions t WHERE t.subject_id=s.id AND t.account_id=f.actor LIMIT 1))`,
          [
            facts.map((f) => f.id),
            facts.map((f) => f.actor),
            facts.map((f) => f.baseline),
            facts.map((f) => f.count),
            facts.map((f) => f.head),
            facts.map((f) => f.sequence),
            facts.map((f) => f.revision),
            facts.map((f) => f.liked),
          ],
        )
      ).rows;
      if (rows[0]?.n !== facts.length)
        throw new ApplicationError('RATING_UNAVAILABLE');
    }),
};
@Injectable()
export class RatingLikesRepository {
  async state(
    id: string,
    actor: string,
    tx: PoolClient,
    write = false,
  ): Promise<LikeRow | null> {
    enableRequiredTransactionProof(tx, proof);
    const row =
      (
        await tx.query<LikeRow>(
          `SELECT s.id subject_id,s.baseline_id,${ratingIso('s.baseline_at')} baseline_at,st.count,st.head_id,st.sequence::text,coalesce(m.liked,false) liked,coalesce(m.revision,s.baseline_id) revision,${ratingIso('coalesce(m.updated_at,s.baseline_at)')} occurred_at,m.last_transition_id FROM whaleu_ratings.like_subjects s JOIN whaleu_ratings.like_states st ON st.subject_id=s.id LEFT JOIN whaleu_ratings.like_memberships m ON m.subject_id=s.id AND m.account_id=$2 WHERE s.id=$1 AND (m.subject_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM whaleu_ratings.like_transitions t WHERE t.subject_id=s.id AND t.account_id=$2 LIMIT 1)) FOR ${write ? 'UPDATE' : 'SHARE'} OF st`,
          [id, actor],
        )
      ).rows[0] ?? null;
    return row;
  }
  retain(row: LikeRow, actor: string, tx: PoolClient) {
    registerRequiredTransactionFact(tx, proof, row.subject_id, {
      id: row.subject_id,
      actor,
      baseline: row.baseline_id,
      count: row.count,
      head: row.head_id,
      sequence: row.sequence,
      revision: row.revision,
      liked: row.liked,
    });
  }
  async set(
    id: string,
    actor: string,
    requestId: string,
    expectedRevision: string,
    liked: boolean,
    tx: PoolClient,
  ) {
    const current = await this.state(id, actor, tx, true);
    if (!current) throw new ApplicationError('RATING_UNAVAILABLE');
    if (current.revision !== expectedRevision)
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    const outcome = current.liked === liked ? 'noop' : 'applied';
    if (outcome === 'noop')
      await tx.query(
        `INSERT INTO whaleu_ratings.like_noop_observations(account_id,request_id,subject_id,baseline_id,anchor_transition_id,liked,revision,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [
          actor,
          requestId,
          id,
          current.baseline_id,
          current.last_transition_id,
          liked,
          current.revision,
          current.occurred_at,
        ],
      );
    else if (current.last_transition_id)
      await tx.query(
        `UPDATE whaleu_ratings.like_memberships SET liked=$3,request_id=$4,expected_revision=$5 WHERE subject_id=$1 AND account_id=$2`,
        [id, actor, liked, requestId, expectedRevision],
      );
    else
      await tx.query(
        `INSERT INTO whaleu_ratings.like_memberships(subject_id,account_id,liked,request_id,expected_revision) VALUES($1,$2,$3,$4,$5)`,
        [id, actor, liked, requestId, expectedRevision],
      );
    const final =
      outcome === 'noop' ? current : await this.state(id, actor, tx, true);
    if (!final) throw new ApplicationError('RATING_UNAVAILABLE');
    this.retain(final, actor, tx);
    return {
      outcome,
      liked: final.liked,
      revision: final.revision,
      occurredAt: final.occurred_at,
    } as const;
  }
}
