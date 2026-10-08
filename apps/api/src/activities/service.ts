import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { ActivityAccessService } from './access.js';
import { ActivitiesRepository } from './repository.js';
import {
  ActivitiesCursorRepository,
  activityCursorScope,
  activityOrdinalSchema,
} from './cursor.js';
import { activitySummary, activityDetail } from './projection.js';
import {
  activityContextSchema,
  activityPageSchema,
  activityDetailSchema,
  activityVisitReceiptSchema,
} from './contracts.js';
import type { ActivityListQuery, ActivityVisitCommand } from './contracts.js';
@Injectable()
export class ActivitiesService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ActivityAccessService)
    private readonly access: ActivityAccessService,
    @Inject(ActivitiesRepository)
    private readonly records: ActivitiesRepository,
    @Inject(ActivitiesCursorRepository)
    private readonly cursors: ActivitiesCursorRepository,
  ) {}
  private async run<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(operation, {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (error instanceof ZodError)
        throw new ApplicationError('ACTIVITY_UNAVAILABLE');
      throw error;
    }
  }
  context(token: string) {
    return this.run(async (tx) => {
      const access = await this.access.resolve(token, null, tx);
      const visitHistory = await this.records.history(
        access.session.accountId,
        tx,
      );
      await this.access.recheck(token, tx);
      return activityContextSchema.parse({
        regionId: access.regionId,
        visitHistory,
      });
    });
  }
  list(token: string, regionId: string, query: ActivityListQuery) {
    return this.run(async (tx) => {
      const access = await this.access.resolve(token, regionId, tx);
      const catalog = await this.records.catalog(regionId, tx);
      const scope = activityCursorScope(
        catalog,
        query,
        access.session,
        access.selectionId,
        access.topologySnapshotId,
      );
      const position = query.cursor
        ? await this.cursors.get(query.cursor, scope, catalog, query.window, tx)
        : null;
      const selection =
        position?.selection ??
        (await this.records.selection(
          catalog,
          access.session.accountId,
          query.window,
          tx,
        ));
      const remaining =
        position?.remaining ?? (selection.kind === 'historical' ? 10 : null);
      const after = position?.after ?? null;
      const limit = Math.min(query.limit, remaining ?? query.limit);
      const rows = await this.records.list(
        catalog,
        selection,
        after,
        limit,
        tx,
      );
      if (
        rows.length > limit + 1 ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      )
        throw new ApplicationError('ACTIVITY_UNAVAILABLE');
      let previous = after === null ? null : BigInt(after);
      for (const row of rows) {
        if (
          !activityOrdinalSchema.safeParse(row.display_ordinal).success ||
          row.region_id !== regionId ||
          (previous !== null && BigInt(row.display_ordinal) >= previous)
        )
          throw new ApplicationError('ACTIVITY_UNAVAILABLE');
        previous = BigInt(row.display_ordinal);
      }
      const items = rows.map(activitySummary).slice(0, limit);
      const more =
        rows.length > limit && (remaining === null || remaining > limit);
      await this.access.recheck(token, tx);
      // The shared bounded cursor bucket is the final blocking owner operation.
      const pageCursor =
        query.cursor ??
        (await this.cursors.create(
          scope,
          access.session.accountId,
          {
            v: 1,
            kind: 'activities',
            catalogRevision: catalog.id,
            after,
            selection,
            remaining,
          },
          tx,
        ));
      const nextCursor = more
        ? await this.cursors.create(
            scope,
            access.session.accountId,
            {
              v: 1,
              kind: 'activities',
              catalogRevision: catalog.id,
              after: rows[limit - 1]!.display_ordinal,
              selection,
              remaining: remaining === null ? null : remaining - limit,
            },
            tx,
          )
        : null;
      return activityPageSchema.parse({
        context: { regionId, catalogRevision: catalog.id },
        selection,
        items,
        continuation: more ? 'more' : 'end',
        nextCursor,
        pageCursor,
      });
    });
  }
  detail(token: string, regionId: string, id: string) {
    return this.run(async (tx) => {
      const access = await this.access.resolve(token, null, tx);
      if (access.regionId !== regionId)
        throw new ApplicationError('ACTIVITY_NOT_FOUND');
      const catalog = await this.records.catalog(regionId, tx);
      const row = await this.records.detail(catalog, id, tx);
      if (!row) throw new ApplicationError('ACTIVITY_NOT_FOUND');
      if (row.id !== id || row.region_id !== regionId)
        throw new ApplicationError('ACTIVITY_UNAVAILABLE');
      const result = activityDetail(row);
      await this.access.recheck(token, tx);
      return activityDetailSchema.parse(result);
    });
  }
  visit(token: string, requestId: string, command: ActivityVisitCommand) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      await this.records.lockVisits(session.accountId, tx);
      const receipt = await this.records.receipt(
        session.accountId,
        requestId,
        tx,
      );
      if (receipt) {
        if (
          receipt.regionId !== command.regionId ||
          receipt.catalogRevision !== command.expectedCatalogRevision
        )
          throw new ApplicationError('ACTIVITY_VISIT_CONFLICT');
        await this.access.recheck(token, tx);
        return activityVisitReceiptSchema.parse(receipt);
      }
      await this.access.resolve(token, command.regionId, tx);
      const catalog = await this.records.catalog(command.regionId, tx);
      if (catalog.id !== command.expectedCatalogRevision)
        throw new ApplicationError('ACTIVITY_REVISION_CHANGED');
      const result = await this.records.visit(
        session.accountId,
        requestId,
        catalog,
        tx,
      );
      await this.access.recheck(token, tx);
      return activityVisitReceiptSchema.parse(result);
    });
  }
}
