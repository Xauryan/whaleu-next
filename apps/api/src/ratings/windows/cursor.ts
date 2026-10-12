import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('window-directory-v1'),
  id: z.uuid(),
  rank: z.number().int().min(0).max(2),
  mean: z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/)
    .nullable(),
  count: z.string().regex(/^\d+$/),
  validUntil: z.string().min(10).max(80).nullable(),
});
export type WindowPosition = z.infer<typeof positionSchema>;
export const windowCursorScope = discoveryContinuationScope;
@Injectable()
export class WindowCursors {
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
  create(
    actor: string,
    scope: string,
    position: WindowPosition,
    tx: PoolClient,
  ) {
    return this.cursors.create(
      scope,
      actor,
      positionSchema.parse(position),
      tx,
    );
  }
}
