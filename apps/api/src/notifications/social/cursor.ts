import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { ApplicationError } from '../../http/application-error.js';
import type { SocialCategory } from './contracts.js';
const ordinal = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const position = z.strictObject({
  v: z.literal(2),
  kind: z.literal('social-updates'),
  head: ordinal,
  beforeAt: z.iso.datetime({ precision: 6 }),
  beforeOrdinal: ordinal.refine((value) => BigInt(value) > 0n),
});
export type SocialCursorPosition = Pick<
  z.infer<typeof position>,
  'head' | 'beforeAt' | 'beforeOrdinal'
>;
export function socialCursorScope(
  account: string,
  session: string,
  token: string,
  category: SocialCategory,
  limit: number,
) {
  return discoveryContinuationScope([
    'social-updates',
    2,
    account,
    session,
    createHash('sha256').update(token).digest('hex'),
    category,
    limit,
    'event-time-desc-with-delivery-snapshot',
  ]);
}
@Injectable()
export class SocialUpdatesCursors {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  async get(cursor: string, scope: string, tx: PoolClient) {
    try {
      return await this.cursors.get(cursor, scope, tx, (value) =>
        position.parse(value),
      );
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    }
  }
  create(
    account: string,
    scope: string,
    before: SocialCursorPosition,
    tx: PoolClient,
  ) {
    return this.cursors.create(
      scope,
      account,
      position.parse({ v: 2, kind: 'social-updates', ...before }),
      tx,
    );
  }
}
