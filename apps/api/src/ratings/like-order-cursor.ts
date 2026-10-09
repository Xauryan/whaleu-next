import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { DiscoveryContinuationFacade } from '../community/discovery-continuation.module.js';
import { ratingOrdinalSchema } from './cursor.js';
const micro = z
  .string()
  .regex(/^-?(0|[1-9][0-9]{0,18})$/)
  .refine(
    (s) =>
      BigInt(s) >= -9223372036854775807n && BigInt(s) <= 9223372036854775807n,
  );
const positionSchema = z
  .strictObject({
    v: z.literal(2),
    kind: z.literal('rating-root-order'),
    sort: z.enum(['time', 'likes']),
    order: z.enum(['asc', 'desc']),
    after: z.strictObject({
      createdMicros: micro,
      ordinal: ratingOrdinalSchema,
      count: z.number().int().nonnegative().max(2147483647).nullable(),
    }),
  })
  .refine((p) => (p.sort === 'time') === (p.after.count === null));
export type RatingRootOrderPosition = z.infer<typeof positionSchema>;
export type RatingRootOrderAfter = RatingRootOrderPosition['after'];
@Injectable()
export class RatingRootOrderCursors {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  async get(
    cursor: string,
    scope: string,
    sort: 'time' | 'likes',
    order: 'asc' | 'desc',
    tx: PoolClient,
  ) {
    try {
      const p = await this.cursors.get(cursor, scope, tx, (v) =>
        positionSchema.parse(v),
      );
      if (p.sort !== sort || p.order !== order)
        throw new Error('Order mismatch');
      return p.after;
    } catch (e) {
      if (e instanceof ApplicationError) throw e;
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
  }
  create(
    actor: string,
    scope: string,
    sort: 'time' | 'likes',
    order: 'asc' | 'desc',
    after: RatingRootOrderAfter,
    tx: PoolClient,
  ) {
    return this.cursors.create(
      scope,
      actor,
      positionSchema.parse({
        v: 2,
        kind: 'rating-root-order',
        sort,
        order,
        after,
      }),
      tx,
    );
  }
}
