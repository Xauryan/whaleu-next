import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { ApplicationError } from '../../http/application-error.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('major-discussion-v1'),
  id: z.uuid(),
  time: z.string().regex(/^\d+$/),
  likes: z.string().regex(/^\d+$/),
  validUntil: z.string().max(80),
});
export type CommentPosition = z.infer<typeof positionSchema>;
export const discussionCursorScope = discoveryContinuationScope;
@Injectable()
export class MajorDiscussionCursors {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly cursor: DiscoveryContinuationFacade,
  ) {}
  async get(value: string, scope: string, tx: PoolClient) {
    try {
      const p = await this.cursor.get(value, scope, tx, (x) =>
        positionSchema.parse(x),
      );
      if (
        !(
          await tx.query<{ valid: boolean }>(
            'SELECT $1::timestamptz>clock_timestamp() valid',
            [p.validUntil],
          )
        ).rows[0]?.valid
      )
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      registerTransactionExactDeadline(
        tx,
        p.validUntil,
        'DISCOVERY_RESTART_REQUIRED',
      );
      return p;
    } catch {
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
  }
  create(
    actor: string,
    scope: string,
    position: CommentPosition,
    tx: PoolClient,
  ) {
    return this.cursor.create(scope, actor, positionSchema.parse(position), tx);
  }
}
