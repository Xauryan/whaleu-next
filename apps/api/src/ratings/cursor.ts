import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { ApplicationError } from '../http/application-error.js';
export const ratingOrdinalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((s) => BigInt(s) <= 9223372036854775807n);
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('ratings'),
  after: ratingOrdinalSchema,
});
export const ratingCursorScope = discoveryContinuationScope;
@Injectable()
export class RatingsCursors {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  async get(cursor: string, scope: string, tx: PoolClient) {
    try {
      return (
        await this.cursors.get(cursor, scope, tx, (value) =>
          positionSchema.parse(value),
        )
      ).after;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
  }
  create(actor: string, scope: string, after: string, tx: PoolClient) {
    return this.cursors.create(
      scope,
      actor,
      positionSchema.parse({ v: 1, kind: 'ratings', after }),
      tx,
    );
  }
}
