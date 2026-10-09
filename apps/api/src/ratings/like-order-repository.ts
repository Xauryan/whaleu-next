import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import type { RatingRootOrderAfter } from './like-order-cursor.js';
interface Head {
  target_id: string;
  baseline_id: string;
  head_id: string | null;
  sequence: string;
  missing: number;
}
interface Row {
  id: string;
  createdMicros: string;
  ordinal: string;
  count: number | null;
}
const proof: RequiredTransactionProof<Head> = {
  maximumFacts: 1,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      await read.query(
        'SELECT target_id FROM whaleu_ratings.root_order_heads WHERE target_id=ANY($1::uuid[]) FOR SHARE NOWAIT',
        [facts.map((f) => f.target_id)],
      );
      const n = (
        await read.query<{ n: number }>(
          `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::bigint[],$5::integer[]) f(target,baseline,head,sequence,missing) JOIN whaleu_ratings.root_order_heads h ON h.target_id=f.target AND (h.baseline_id,h.head_id,h.sequence,h.missing) IS NOT DISTINCT FROM (f.baseline,f.head,f.sequence,f.missing)`,
          [
            facts.map((f) => f.target_id),
            facts.map((f) => f.baseline_id),
            facts.map((f) => f.head_id),
            facts.map((f) => f.sequence),
            facts.map((f) => f.missing),
          ],
        )
      ).rows[0]?.n;
      if (n !== facts.length) throw new ApplicationError('RATING_UNAVAILABLE');
    }),
};
@Injectable()
export class RatingRootOrderRepository {
  async head(target: string, sort: 'time' | 'likes', tx: PoolClient) {
    enableRequiredTransactionProof(tx, proof);
    const h = (
      await tx.query<Head>(
        `SELECT target_id,baseline_id,head_id,sequence::text,missing FROM whaleu_ratings.root_order_heads WHERE target_id=$1 FOR SHARE`,
        [target],
      )
    ).rows[0];
    if (!h || (sort === 'likes' && h.missing !== 0))
      throw new ApplicationError('RATING_UNAVAILABLE');
    registerRequiredTransactionFact(tx, proof, target, h);
    return [h.baseline_id, h.head_id, h.sequence, h.missing];
  }
  async page(
    target: string,
    sort: 'time' | 'likes',
    order: 'asc' | 'desc',
    after: RatingRootOrderAfter | null,
    limit: number,
    tx: PoolClient,
  ): Promise<Row[]> {
    // No nullable seek OR: every continuation is a direct indexed tuple range.
    if (sort === 'time')
      return (
        await tx.query<Row>(
          `SELECT root_id id,created_micros::text AS "createdMicros",ordinal::text,NULL::integer count FROM whaleu_ratings.root_order_entries WHERE target_id=$1 AND live ${after ? `AND (created_micros,ordinal)${order === 'asc' ? '>' : '<'}($3::bigint,$4::bigint)` : ''} ORDER BY root_order_entries.created_micros ${order},root_order_entries.ordinal ${order} LIMIT $2`,
          after
            ? [target, limit + 1, after.createdMicros, after.ordinal]
            : [target, limit + 1],
        )
      ).rows;
    const key = order === 'asc' ? 'count' : '(-count)';
    return (
      await tx.query<Row>(
        `SELECT root_id id,created_micros::text AS "createdMicros",ordinal::text,count FROM whaleu_ratings.root_order_entries WHERE target_id=$1 AND live AND known ${after ? `AND (${key},(-created_micros),(-ordinal))>($3::integer,$4::bigint,$5::bigint)` : ''} ORDER BY ${key},(-created_micros),(-ordinal) LIMIT $2`,
        after
          ? [
              target,
              limit + 1,
              order === 'asc' ? after.count : -after.count!,
              -BigInt(after.createdMicros) + '',
              -BigInt(after.ordinal) + '',
            ]
          : [target, limit + 1],
      )
    ).rows;
  }
}
