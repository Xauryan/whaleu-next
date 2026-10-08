import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { ApplicationError } from '../http/application-error.js';
import type { SessionView } from '../identity/contracts.js';
import type { AnnouncementCatalog } from './repository.js';
export const announcementOrdinalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
  );
export const announcementPositionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('announcements'),
  catalogRevision: z.uuid(),
  after: announcementOrdinalSchema,
});
export function announcementCursorScope(
  catalog: AnnouncementCatalog,
  campusId: string | null,
  limit: number,
  session: SessionView | null,
) {
  return discoveryContinuationScope([
    'announcements',
    1,
    session ? ['session', session.accountId, session.sessionId] : ['guest'],
    campusId,
    limit,
    catalog.id,
    catalog.orderingVersion,
  ]);
}
@Injectable()
export class AnnouncementsCursorRepository {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly records: DiscoveryContinuationFacade,
  ) {}
  async get(
    cursor: string,
    scope: string,
    catalog: AnnouncementCatalog,
    tx: PoolClient,
  ): Promise<string> {
    try {
      const position = await this.records.get(cursor, scope, tx, (value) =>
        announcementPositionSchema.parse(value),
      );
      if (position.catalogRevision !== catalog.id)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      return position.after;
    } catch (error) {
      if (error instanceof BadRequestException)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      throw error;
    }
  }
  create(
    scope: string,
    accountId: string | null,
    catalog: AnnouncementCatalog,
    after: string,
    tx: PoolClient,
  ) {
    return this.records.create(
      scope,
      accountId,
      announcementPositionSchema.parse({
        v: 1,
        kind: 'announcements',
        catalogRevision: catalog.id,
        after,
      }),
      tx,
    );
  }
}
