import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { AnnouncementsAccessService } from './access.js';
import { AnnouncementsRepository } from './repository.js';
import {
  AnnouncementsCursorRepository,
  announcementCursorScope,
  announcementOrdinalSchema,
} from './cursor.js';
import {
  announcementSummary,
  announcementDetail,
  announcementPopup,
} from './projection.js';
import {
  announcementPageSchema,
  announcementDetailSchema,
  announcementPublicPopupSchema,
  announcementOwnerPopupSchema,
  announcementChangesSchema,
  announcementAckReceiptSchema,
} from './contracts.js';
import type {
  AnnouncementScopeQuery,
  AnnouncementListQuery,
  AnnouncementChangesQuery,
  AnnouncementAckCommand,
} from './contracts.js';
@Injectable()
export class AnnouncementsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AnnouncementsAccessService)
    private readonly access: AnnouncementsAccessService,
    @Inject(AnnouncementsRepository)
    private readonly records: AnnouncementsRepository,
    @Inject(AnnouncementsCursorRepository)
    private readonly cursors: AnnouncementsCursorRepository,
  ) {}
  private async run<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(operation, {
        isolationLevel: 'read committed',
      });
    } catch (error) {
      if (
        error instanceof ZodError ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          ['57014', '55P03'].includes(String(error.code)))
      )
        throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
      throw error;
    }
  }
  list(token: string | null, query: AnnouncementListQuery) {
    return this.run(async (tx) => {
      const campusId = query.campusId ?? null;
      const session = await this.access.resolve(token, campusId, tx);
      const catalog = await this.records.catalog(tx);
      const scope = announcementCursorScope(
        catalog,
        campusId,
        query.limit,
        session,
      );
      const after = query.cursor
        ? await this.cursors.get(query.cursor, scope, catalog, tx)
        : null;
      const latestId = await this.records.latestId(catalog, campusId, tx);
      const rows = await this.records.list(
        catalog,
        campusId,
        after,
        query.limit,
        tx,
      );
      if (
        rows.length > query.limit + 1 ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      )
        throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
      let previous = after === null ? null : BigInt(after);
      for (const row of rows) {
        if (
          !announcementOrdinalSchema.safeParse(row.source_ordinal).success ||
          (previous !== null && BigInt(row.source_ordinal) >= previous)
        )
          throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
        previous = BigInt(row.source_ordinal);
      }
      const items = rows
        .slice(0, query.limit)
        .map((row) => announcementSummary(row, latestId));
      const more = rows.length > query.limit;
      await this.access.recheck(token, tx);
      const nextCursor = more
        ? await this.cursors.create(
            scope,
            session?.accountId ?? null,
            catalog,
            rows[query.limit - 1]!.source_ordinal,
            tx,
          )
        : null;
      return announcementPageSchema.parse({
        context: { campusId },
        items,
        continuation: more ? 'more' : 'end',
        nextCursor,
      });
    });
  }
  detail(token: string | null, id: string, query: AnnouncementScopeQuery) {
    return this.run(async (tx) => {
      const campusId = query.campusId ?? null;
      await this.access.resolve(token, campusId, tx);
      const catalog = await this.records.catalog(tx);
      const row = await this.records.detail(catalog, campusId, id, tx);
      if (!row) throw new ApplicationError('ANNOUNCEMENT_NOT_FOUND');
      const result = announcementDetail(
        row,
        await this.records.latestId(catalog, campusId, tx),
      );
      await this.access.recheck(token, tx);
      return announcementDetailSchema.parse(result);
    });
  }
  popup(token: string | null, query: AnnouncementScopeQuery) {
    return this.run(async (tx) => {
      const campusId = query.campusId ?? null;
      await this.access.resolve(token, campusId, tx);
      const catalog = await this.records.catalog(tx);
      const row = await this.records.popup(catalog, campusId, tx);
      const result = announcementPublicPopupSchema.parse({
        context: { campusId },
        popup: row ? announcementPopup(row) : null,
      });
      await this.access.recheck(token, tx);
      return result;
    });
  }
  ownerPopup(token: string, query: AnnouncementScopeQuery) {
    return this.run(async (tx) => {
      const campusId = query.campusId ?? null;
      const session = await this.access.resolve(token, campusId, tx);
      if (!session) throw new ApplicationError('AUTHENTICATION_REQUIRED');
      const catalog = await this.records.catalog(tx);
      const row = await this.records.popup(catalog, campusId, tx);
      // Select latest before looking at the owner's ID marker. Never drain older popups.
      const result = announcementOwnerPopupSchema.parse(
        row
          ? {
              context: { campusId },
              candidate: announcementPopup(row),
              acknowledgement: await this.records.acknowledgement(
                session.accountId,
                row.id,
                tx,
              ),
            }
          : { context: { campusId }, candidate: null },
      );
      await this.access.recheck(token, tx);
      return result;
    });
  }
  changes(token: string | null, query: AnnouncementChangesQuery) {
    return this.run(async (tx) => {
      const campusId = query.campusId ?? null;
      await this.access.resolve(token, campusId, tx);
      const catalog = await this.records.catalog(tx);
      const result = announcementChangesSchema.parse({
        context: { campusId },
        ...(await this.records.changes(catalog, campusId, query.since, tx)),
      });
      await this.access.recheck(token, tx);
      return result;
    });
  }
  acknowledge(token: string, id: string, command: AnnouncementAckCommand) {
    return this.run(async (tx) => {
      const session = await this.access.resolve(token, command.campusId, tx);
      if (!session) throw new ApplicationError('AUTHENTICATION_REQUIRED');
      const catalog = await this.records.catalog(tx);
      const row = await this.records.detail(catalog, command.campusId, id, tx);
      if (!row || !row.popup_enabled)
        throw new ApplicationError('ANNOUNCEMENT_NOT_FOUND');
      if (row.revision !== command.expectedRevision)
        throw new ApplicationError('ANNOUNCEMENT_REVISION_CHANGED');
      announcementPopup(row); // Unknown override facts must not become an acknowledged readable popup.
      const acknowledgement = await this.records.acknowledge(
        session.accountId,
        id,
        tx,
      );
      await this.access.recheck(token, tx);
      return announcementAckReceiptSchema.parse({
        announcementId: id,
        acknowledgement,
      });
    });
  }
}
