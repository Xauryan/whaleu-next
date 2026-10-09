import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { ApplicationError } from '../../http/application-error.js';
import { ratingOrdinalSchema } from '../../ratings/cursor.js';

const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('rating-updates'),
  order: z.literal('newest'),
  before: ratingOrdinalSchema.refine((value) => BigInt(value) > 0n),
});
export function ratingUpdatesCursorScope(
  accountId: string,
  sessionId: string,
  token: string,
  limit: number,
): string {
  return discoveryContinuationScope([
    'rating-updates',
    1,
    accountId,
    sessionId,
    createHash('sha256').update(token).digest('hex'),
    limit,
    'ordinal-desc',
  ]);
}
@Injectable()
export class RatingUpdatesCursors {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  async get(cursor: string, scope: string, tx: PoolClient): Promise<string> {
    try {
      return (
        await this.cursors.get(cursor, scope, tx, (value) =>
          positionSchema.parse(value),
        )
      ).before;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
  }
  create(accountId: string, scope: string, before: string, tx: PoolClient) {
    return this.cursors.create(
      scope,
      accountId,
      positionSchema.parse({
        v: 1,
        kind: 'rating-updates',
        order: 'newest',
        before,
      }),
      tx,
    );
  }
}
