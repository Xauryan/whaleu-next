import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { ApplicationError } from '../../http/application-error.js';
import type { SessionView } from '../../identity/contracts.js';
import type { DirectoryCatalog } from './repository.js';
import type {
  DirectoryCategoryQuery,
  DirectoryEntryQuery,
} from './contracts.js';
export const directoryOrdinalSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
  );
export const directoryPositionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(['directory-categories', 'directory-entries']),
  catalogRevision: z.uuid(),
  taxonomyRevision: z.uuid(),
  after: directoryOrdinalSchema,
});
export function directoryCursorScope(
  mode: 'categories' | 'entries',
  catalog: DirectoryCatalog,
  query: DirectoryCategoryQuery | DirectoryEntryQuery,
  actor: SessionView,
  selectionId: string,
  topologySnapshotId: string,
) {
  return discoveryContinuationScope([
    'organization-directory',
    1,
    mode,
    actor.accountId,
    actor.sessionId,
    selectionId,
    topologySnapshotId,
    catalog.regionId,
    catalog.kind,
    'categoryId' in query ? (query.categoryId ?? null) : null,
    'q' in query ? (query.q ?? null) : null,
    query.limit,
    catalog.orderingVersion,
    catalog.id,
    catalog.taxonomyId,
  ]);
}
@Injectable()
export class DirectoryCursorRepository {
  constructor(
    @Inject(DiscoveryContinuationFacade)
    private readonly records: DiscoveryContinuationFacade,
  ) {}
  async get(
    cursor: string,
    scope: string,
    catalog: DirectoryCatalog,
    mode: 'categories' | 'entries',
    tx: PoolClient,
  ): Promise<string> {
    try {
      const position = await this.records.get(cursor, scope, tx, (value) =>
        directoryPositionSchema.parse(value),
      );
      if (
        position.kind !== `directory-${mode}` ||
        position.catalogRevision !== catalog.id ||
        position.taxonomyRevision !== catalog.taxonomyId
      )
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
    accountId: string,
    catalog: DirectoryCatalog,
    mode: 'categories' | 'entries',
    after: string,
    tx: PoolClient,
  ) {
    return this.records.create(
      scope,
      accountId,
      directoryPositionSchema.parse({
        v: 1,
        kind: `directory-${mode}`,
        catalogRevision: catalog.id,
        taxonomyRevision: catalog.taxonomyId,
        after,
      }),
      tx,
    );
  }
}
