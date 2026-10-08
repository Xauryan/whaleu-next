import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { ApplicationError } from '../http/application-error.js';
import { activitySelectionSchema } from './contracts.js';
import type { ActivityListQuery } from './contracts.js';
import type { ActivityCatalog } from './repository.js';
import type { SessionView } from '../identity/contracts.js';
export const activityOrdinalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
  );
export const activityPositionSchema = z
  .strictObject({
    v: z.literal(1),
    kind: z.literal('activities'),
    catalogRevision: z.uuid(),
    after: activityOrdinalSchema.nullable(),
    selection: activitySelectionSchema,
    remaining: z.number().int().min(1).max(10).nullable(),
  })
  .refine(
    (value) =>
      (value.selection.kind === 'historical') === (value.remaining !== null),
  );
export type ActivityPosition = z.infer<typeof activityPositionSchema>;
export function activityCursorScope(
  catalog: ActivityCatalog,
  query: ActivityListQuery,
  session: SessionView,
  selectionId: string,
  topologySnapshotId: string,
) {
  return discoveryContinuationScope([
    'activities',
    1,
    session.accountId,
    session.sessionId,
    selectionId,
    topologySnapshotId,
    catalog.regionId,
    catalog.id,
    catalog.orderingVersion,
    query.window,
    query.limit,
  ]);
}
@Injectable()
export class ActivitiesCursorRepository {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly records: DiscoveryContinuationFacade,
  ) {}
  async get(
    cursor: string,
    scope: string,
    catalog: ActivityCatalog,
    window: 'entry' | 'all',
    tx: PoolClient,
  ): Promise<ActivityPosition> {
    try {
      const position = await this.records.get(cursor, scope, tx, (value) =>
        activityPositionSchema.parse(value),
      );
      if (
        position.catalogRevision !== catalog.id ||
        (window === 'all' && position.selection.kind !== 'all')
      )
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      return position;
    } catch (error) {
      if (error instanceof BadRequestException)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      throw error;
    }
  }
  create(
    scope: string,
    accountId: string,
    position: ActivityPosition,
    tx: PoolClient,
  ) {
    return this.records.create(
      scope,
      accountId,
      activityPositionSchema.parse(position),
      tx,
    );
  }
}
