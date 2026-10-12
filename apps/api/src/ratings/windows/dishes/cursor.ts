import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../../community/discovery-continuation.module.js';
import { registerTransactionExactDeadline } from '../../../database/transaction-deadlines.js';
import { ApplicationError } from '../../../http/application-error.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('window-dishes-v1'),
  identity: z.string().regex(/^(?:[a-f0-9]{2}){1,40}$/),
  count: z.number().int().min(1).max(1000),
  validUntil: z.string().min(10).max(80).nullable(),
});
export type DishPosition = z.infer<typeof positionSchema>;
export const dishCursorScope = discoveryContinuationScope;
@Injectable()
export class DishCursors {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  async get(cursor: string, scope: string, tx: PoolClient) {
    try {
      const position = await this.cursors.get(cursor, scope, tx, (value) =>
        positionSchema.parse(value),
      );
      if (position.validUntil !== null) {
        const current = (
          await tx.query<{ valid: boolean }>(
            'SELECT clock_timestamp()<$1::timestamptz valid',
            [position.validUntil],
          )
        ).rows[0]!.valid;
        if (!current) throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        registerTransactionExactDeadline(
          tx,
          position.validUntil,
          'DISCOVERY_RESTART_REQUIRED',
        );
      }
      return position;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
  }
  create(actor: string, scope: string, position: DishPosition, tx: PoolClient) {
    return this.cursors.create(
      scope,
      actor,
      positionSchema.parse(position),
      tx,
    );
  }
}
