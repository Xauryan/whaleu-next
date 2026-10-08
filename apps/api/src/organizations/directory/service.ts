import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { DirectoryAccessService } from './access.js';
import { DirectoryRepository } from './repository.js';
import {
  DirectoryCursorRepository,
  directoryCursorScope,
  directoryOrdinalSchema,
} from './cursor.js';
import {
  directoryCategory,
  directorySummary,
  directoryDetail,
} from './projection.js';
import {
  directoryContextSchema,
  directoryCategoryPageSchema,
  directoryEntryPageSchema,
  directoryDetailSchema,
} from './contracts.js';
import type {
  DirectoryCategoryQuery,
  DirectoryEntryQuery,
} from './contracts.js';

function checkOrder(
  rows: readonly { id: string }[],
  ordinals: readonly string[],
  after: string | null,
  limit: number,
) {
  if (
    rows.length > limit + 1 ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new ApplicationError('DIRECTORY_UNAVAILABLE');
  let previous = after === null ? null : BigInt(after);
  for (const ordinal of ordinals) {
    if (
      !directoryOrdinalSchema.safeParse(ordinal).success ||
      (previous !== null && BigInt(ordinal) <= previous)
    )
      throw new ApplicationError('DIRECTORY_UNAVAILABLE');
    previous = BigInt(ordinal);
  }
}
@Injectable()
export class DirectoryService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DirectoryAccessService)
    private readonly access: DirectoryAccessService,
    @Inject(DirectoryRepository) private readonly records: DirectoryRepository,
    @Inject(DirectoryCursorRepository)
    private readonly cursors: DirectoryCursorRepository,
  ) {}
  context(token: string) {
    return this.database.transaction(
      async (tx) => {
        const access = await this.access.resolve(token, null, tx);
        await this.access.recheck(token, tx);
        return directoryContextSchema.parse({ regionId: access.regionId });
      },
      { isolationLevel: 'read committed' },
    );
  }
  categories(token: string, regionId: string, query: DirectoryCategoryQuery) {
    return this.database.transaction(
      async (tx) => {
        const access = await this.access.resolve(token, regionId, tx);
        const catalog = await this.records.catalog(regionId, query.kind, tx);
        const scope = directoryCursorScope(
          'categories',
          catalog,
          query,
          access.session,
          access.selectionId,
          access.topologySnapshotId,
        );
        const after = query.cursor
          ? await this.cursors.get(
              query.cursor,
              scope,
              catalog,
              'categories',
              tx,
            )
          : null;
        const rows = await this.records.categories(
          catalog,
          after,
          query.limit,
          tx,
        );
        checkOrder(
          rows,
          rows.map((row) => row.display_ordinal),
          after,
          query.limit,
        );
        if (rows.some((row) => row.kind !== query.kind))
          throw new ApplicationError('DIRECTORY_UNAVAILABLE');
        const items = rows.map(directoryCategory).slice(0, query.limit);
        const more = rows.length > query.limit;
        await this.access.recheck(token, tx);
        const nextCursor = more
          ? await this.cursors.create(
              scope,
              access.session.accountId,
              catalog,
              'categories',
              rows[query.limit - 1]!.display_ordinal,
              tx,
            )
          : null;
        return directoryCategoryPageSchema.parse({
          items,
          continuation: more ? 'more' : 'end',
          nextCursor,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  entries(token: string, regionId: string, query: DirectoryEntryQuery) {
    return this.database.transaction(
      async (tx) => {
        const access = await this.access.resolve(token, regionId, tx);
        const catalog = await this.records.catalog(regionId, query.kind, tx);
        if (query.categoryId)
          await this.records.category(catalog, query.categoryId, tx);
        const scope = directoryCursorScope(
          'entries',
          catalog,
          query,
          access.session,
          access.selectionId,
          access.topologySnapshotId,
        );
        const after = query.cursor
          ? await this.cursors.get(query.cursor, scope, catalog, 'entries', tx)
          : null;
        const rows = await this.records.entries(catalog, query, after, tx);
        const order =
          query.q === undefined ? 'display_ordinal' : 'search_ordinal';
        checkOrder(
          rows,
          rows.map((row) => row[order]),
          after,
          query.limit,
        );
        if (
          rows.some(
            (row) =>
              row.kind !== query.kind ||
              (query.categoryId !== undefined &&
                row.category_id !== query.categoryId),
          )
        )
          throw new ApplicationError('DIRECTORY_UNAVAILABLE');
        const items = rows.map(directorySummary).slice(0, query.limit);
        const more = rows.length > query.limit;
        await this.access.recheck(token, tx);
        const nextCursor = more
          ? await this.cursors.create(
              scope,
              access.session.accountId,
              catalog,
              'entries',
              rows[query.limit - 1]![order],
              tx,
            )
          : null;
        return directoryEntryPageSchema.parse({
          items,
          continuation: more ? 'more' : 'end',
          nextCursor,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  detail(token: string, regionId: string, entryId: string) {
    return this.database.transaction(
      async (tx) => {
        try {
          await this.access.resolve(token, regionId, tx);
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.code === 'DIRECTORY_SCOPE_UNAVAILABLE'
          )
            throw new ApplicationError('DIRECTORY_NOT_FOUND');
          throw error;
        }
        const kind = await this.records.detailKind(regionId, entryId, tx);
        let catalog;
        try {
          catalog = await this.records.catalog(regionId, kind, tx);
        } catch (error) {
          if (
            error instanceof ApplicationError &&
            error.code === 'DIRECTORY_UNAVAILABLE'
          )
            throw new ApplicationError('DIRECTORY_NOT_FOUND');
          throw error;
        }
        const row = await this.records.detail(catalog, entryId, tx);
        if (!row) throw new ApplicationError('DIRECTORY_NOT_FOUND');
        if (row.id !== entryId || row.kind !== kind)
          throw new ApplicationError('DIRECTORY_UNAVAILABLE');
        const result = directoryDetail(row);
        await this.access.recheck(token, tx);
        return directoryDetailSchema.parse(result);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
