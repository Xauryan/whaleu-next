import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('course-directory-v1'),
  sort: z.enum(['rating', 'time']),
  id: z.uuid(),
  validUntil: z.iso.datetime().nullable(),
  value: z
    .string()
    .regex(/^-?\d+(?:\.\d+)?$/)
    .max(30)
    .nullable(),
});
export type CoursePosition = z.infer<typeof positionSchema>;
export const courseCursorScope = discoveryContinuationScope;
@Injectable()
export class CourseCursors {
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
        const now = (
          await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
        ).rows[0]!.now;
        if (now.getTime() >= Date.parse(position.validUntil))
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
        registerTransactionDeadline(
          tx,
          Date.parse(position.validUntil),
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
    position: CoursePosition,
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
