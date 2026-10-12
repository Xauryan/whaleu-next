import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { registerTransactionExactDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('major-directory-v1'),
  id: z.uuid(),
  departmentId: z.number().int().min(-2147483648).max(2147483647),
  validUntil: z.string().min(10).max(80),
});
export const majorCursorScope = discoveryContinuationScope;
@Injectable()
export class MajorCursors {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  async get(cursor: string, scope: string, tx: PoolClient) {
    try {
      const p = await this.cursors.get(cursor, scope, tx, (value) =>
        positionSchema.parse(value),
      );
      if (
        !(
          await tx.query<{ valid: boolean }>(
            'SELECT clock_timestamp()<$1::timestamptz valid',
            [p.validUntil],
          )
        ).rows[0]!.valid
      )
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      registerTransactionExactDeadline(
        tx,
        p.validUntil,
        'DISCOVERY_RESTART_REQUIRED',
      );
      return p;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
  }
  create(
    actor: string,
    scope: string,
    position: z.infer<typeof positionSchema>,
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
