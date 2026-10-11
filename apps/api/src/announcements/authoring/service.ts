import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError, z } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { AnnouncementAuthoringAccess } from './access.js';
import type { NativeAnnouncementRow } from './access.js';
import { requireNativeCurrent, lockNative } from './current-proof.js';
import {
  commandHash,
  snapshotHash,
  managedSchema,
  receiptSchema,
  recoverySchema,
  contentSchema,
} from './contracts.js';
import type {
  AnnouncementCommand,
  AnnouncementAudienceInput,
} from './contracts.js';
import { AnnouncementMediaService } from '../media/facade.js';
import { AnnouncementsRepository } from '../repository.js';
import {
  announcementSummary,
  announcementDetail,
  announcementPopup,
} from '../projection.js';
import {
  announcementPageSchema,
  announcementOwnerPopupSchema,
  announcementPublicPopupSchema,
  announcementAckReceiptSchema,
  announcementChangesSchema,
} from '../contracts.js';
import type {
  AnnouncementListQuery,
  AnnouncementScopeQuery,
  AnnouncementAckCommand,
  AnnouncementChangesQuery,
} from '../contracts.js';
import type { StoredAnnouncement } from '../projection.js';
const utc = (d: Date) => d.toISOString();
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('native-announcements'),
  after: z.string().regex(/^[1-9][0-9]*$/),
});
function inputFor(
  row: NativeAnnouncementRow,
  management: 'global' | 'fixed',
): AnnouncementAudienceInput {
  return management === 'fixed'
    ? { kind: 'fixed' }
    : row.audience.kind === 'all'
      ? { kind: 'all' }
      : { kind: 'regions', regionIds: row.audience.regionIds };
}
function projection(row: NativeAnnouncementRow): StoredAnnouncement {
  return {
    id: row.id,
    revision: row.revision_id,
    source_ordinal: row.ordinal,
    version_label: row.content.versionLabel,
    title: row.content.title,
    body_text: row.content.bodyText,
    announcement_date: row.content.announcementDate,
    source_created_at: utc(row.created_at),
    source_updated_at: utc(row.updated_at),
    highlight: row.content.highlight,
    popup_enabled: row.content.popupEnabled,
    popup_title_state: row.content.popupTitle === null ? 'absent' : 'value',
    popup_title: row.content.popupTitle,
    popup_body_state: row.content.popupBodyText === null ? 'absent' : 'value',
    popup_body_text: row.content.popupBodyText,
    media_state: 'known_empty',
  };
}
@Injectable()
export class AnnouncementAuthoringService {
  constructor(
    @Inject(DatabaseService) readonly db: DatabaseService,
    @Inject(AnnouncementAuthoringAccess)
    readonly access: AnnouncementAuthoringAccess,
    @Inject(AnnouncementMediaService) readonly media: AnnouncementMediaService,
    @Inject(AnnouncementsRepository) readonly legacy: AnnouncementsRepository,
    @Inject(DiscoveryContinuationFacade)
    readonly cursors: DiscoveryContinuationFacade,
  ) {}
  private async run<T>(work: (tx: PoolClient) => Promise<T>) {
    try {
      return await this.db.transaction(
        async (tx) => {
          await tx.query("SET LOCAL lock_timeout='500ms'");
          return work(tx);
        },
        { isolationLevel: 'read committed' },
      );
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
  private async lockRequest(actor: string, key: string, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:announcement-request:v1:'||$1||':'||$2,0))",
      [actor, key],
    );
  }
  private async recovery(actor: string, key: string, tx: PoolClient) {
    const row = (
      await tx.query<{ receipt: unknown }>(
        'SELECT receipt FROM whaleu_announcements.native_requests WHERE actor_id=$1 AND client_request_id=$2',
        [actor, key],
      )
    ).rows[0];
    if (row)
      return recoverySchema.parse({
        state: 'recorded',
        requestId: key,
        receipt: row.receipt,
      });
    const fence = (
      await tx.query<{ request_hash: string }>(
        'SELECT request_hash FROM whaleu_announcements.native_cancel_fences WHERE actor_id=$1 AND client_request_id=$2',
        [actor, key],
      )
    ).rows[0];
    return recoverySchema.parse(
      fence
        ? {
            state: 'cancelled',
            requestId: key,
            requestHash: fence.request_hash,
          }
        : { state: 'not_recorded', requestId: key },
    );
  }
  recover(token: string, key: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx);
      return this.recovery(s.accountId, key, tx);
    });
  }
  cancel(token: string, key: string, hash: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx);
      await this.lockRequest(s.accountId, key, tx);
      const prior = await this.recovery(s.accountId, key, tx);
      if (prior.state !== 'not_recorded') {
        if (
          (prior.state === 'recorded'
            ? prior.receipt.requestHash
            : prior.requestHash) !== hash
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        return prior;
      }
      await tx.query(
        'INSERT INTO whaleu_announcements.native_cancel_fences(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
        [s.accountId, key, hash],
      );
      return recoverySchema.parse({
        state: 'cancelled',
        requestId: key,
        requestHash: hash,
      });
    });
  }
  capabilities(token: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx);
      try {
        const auth = await this.access.manager(s.accountId, tx);
        const region =
          auth.management === 'fixed'
            ? (
                await tx.query<{ id: string; name: string }>(
                  'SELECT id,name FROM whaleu_campus.operating_regions WHERE id=$1',
                  [auth.grant.operatingRegionId],
                )
              ).rows[0]
            : null;
        return { management: auth.management, region };
      } catch (error) {
        if (
          error instanceof ApplicationError &&
          error.code === 'AUTHORIZATION_REQUIRED'
        )
          return { management: 'none' as const, region: null };
        throw error;
      }
    });
  }
  regions(token: string, search: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx),
        auth = await this.access.manager(s.accountId, tx);
      if (auth.management !== 'global')
        throw new ApplicationError('AUTHORIZATION_REQUIRED');
      const rows = (
        await tx.query<{ id: string; name: string }>(
          "SELECT id,name FROM whaleu_campus.operating_regions WHERE is_active AND name ILIKE '%'||$1||'%' ORDER BY name,id LIMIT 51",
          [search],
        )
      ).rows;
      return { items: rows.slice(0, 50), more: rows.length > 50 };
    });
  }
  private managed(row: NativeAnnouncementRow) {
    return managedSchema.parse({
      source: 'native',
      id: row.id,
      revision: Number(row.revision),
      revisionId: row.revision_id,
      state: row.state,
      content: row.content,
      audience: row.audience,
      mediaBindings: row.media_bindings,
      createdAt: utc(row.created_at),
      updatedAt: utc(row.updated_at),
    });
  }
  management(token: string, query: { cursor?: string; limit: number }) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx),
        auth = await this.access.manager(s.accountId, tx);
      const epoch = await this.epoch(tx),
        scope = discoveryContinuationScope([
          'announcement-management',
          s.accountId,
          s.sessionId,
          auth.grant.id,
          epoch,
          query.limit,
        ]);
      const after = query.cursor
        ? (
            await this.cursors.get(query.cursor, scope, tx, (v) =>
              positionSchema.parse(v),
            )
          ).after
        : null;
      const rows = (
        await tx.query<NativeAnnouncementRow>(
          `SELECT * FROM whaleu_announcements.native_announcements WHERE state<>'cancelled' AND(state<>'draft' OR creator_id=$2) AND($1::boolean OR(creator_id=$2 AND audience->'regionIds'=jsonb_build_array($3::text))) AND($4::bigint IS NULL OR ordinal<$4) ORDER BY ordinal DESC LIMIT $5`,
          [
            auth.management === 'global',
            s.accountId,
            auth.grant.operatingRegionId,
            after,
            query.limit + 1,
          ],
        )
      ).rows;
      const next =
        rows.length > query.limit
          ? await this.cursors.create(
              scope,
              s.accountId,
              {
                v: 1,
                kind: 'native-announcements',
                after: rows[query.limit - 1]!.ordinal,
              },
              tx,
            )
          : null;
      await requireNativeCurrent('directory', '', tx);
      return {
        source: 'native',
        items: rows.slice(0, query.limit).map((r) => this.managed(r)),
        nextCursor: next,
      };
    });
  }
  closure(token: string, id: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx),
        row = await this.access.row(id, tx);
      if (row.creator_id !== s.accountId || row.state !== 'draft')
        throw new ApplicationError('ANNOUNCEMENT_NOT_FOUND');
      await requireNativeCurrent('entry', id, tx);
      return {
        id: row.id,
        revision: Number(row.revision),
        state: 'draft' as const,
      };
    });
  }
  readManaged(token: string, id: string) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx),
        row = await this.access.row(id, tx);
      await this.access.requireEditor(s.accountId, row, tx);
      await requireNativeCurrent('entry', id, tx);
      return this.managed(row);
    });
  }
  command(token: string, id: string, command: AnnouncementCommand) {
    return this.run(async (tx) => {
      const s = await this.access.authenticate(token, tx, true),
        actor = s.accountId,
        hash = commandHash(actor, id, command);
      await this.lockRequest(actor, command.clientRequestId, tx);
      const prior = await this.recovery(actor, command.clientRequestId, tx);
      if (prior.state !== 'not_recorded') {
        if (
          (prior.state === 'recorded'
            ? prior.receipt.requestHash
            : prior.requestHash) !== hash
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        if (prior.state === 'cancelled')
          throw new ApplicationError('ANNOUNCEMENT_COMMAND_CANCELLED');
        return prior.receipt;
      }
      await lockNative(id, tx);
      const existing =
        (
          await tx.query<NativeAnnouncementRow>(
            'SELECT * FROM whaleu_announcements.native_announcements WHERE id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0] ?? null;
      if (Number(existing?.revision ?? 0) !== command.expectedRevision)
        throw new ApplicationError('ANNOUNCEMENT_REVISION_CHANGED');
      if ((command.action === 'create') !== (existing === null))
        throw new ApplicationError('ANNOUNCEMENT_REVISION_CHANGED');
      const row = existing;
      let content = row?.content,
        audience = row?.audience,
        bindings = row?.media_bindings ?? {},
        state = row?.state ?? 'draft',
        grantId: string | null = null;
      if (command.action === 'cancel_draft') {
        if (!row || row.creator_id !== actor || row.state !== 'draft')
          throw new ApplicationError('AUTHORIZATION_REQUIRED');
        bindings = await this.media.retireDraft(
          {
            actorAccountId: actor,
            announcementId: id,
            revision: Number(row.revision),
            currentBindings: bindings,
          },
          tx,
        );
        state = 'cancelled';
      } else {
        const auth = row
          ? await this.access.requireEditor(actor, row, tx)
          : await this.access.manager(actor, tx);
        const resolved = await this.access.audience(
          actor,
          'audience' in command
            ? command.audience
            : inputFor(row!, auth.management),
          tx,
        );
        grantId = resolved.grant.id;
        audience = resolved.audience;
        if ('content' in command)
          content = contentSchema.parse({
            ...command.content,
            title:
              row?.content.title ?? `鲸语校园${command.content.versionLabel}`,
            type: 'minor',
          });
        if (command.action === 'save' || command.action === 'update') {
          if (
            (command.action === 'save' && row?.state !== 'draft') ||
            (command.action === 'update' &&
              !['active', 'inactive'].includes(row!.state))
          )
            throw new ApplicationError('ANNOUNCEMENT_REVISION_CHANGED');
          bindings = await this.media.mutate(
            {
              actorAccountId: actor,
              announcementId: id,
              revision: Number(row!.revision),
              currentBindings: bindings,
              changes: command.mediaChanges,
            },
            tx,
          );
        }
        if (command.action === 'publish') {
          if (row?.state !== 'draft')
            throw new ApplicationError('ANNOUNCEMENT_REVISION_CHANGED');
          state = 'active';
        }
        if (command.action === 'set_enabled') {
          if (!row || !['active', 'inactive'].includes(row.state))
            throw new ApplicationError('ANNOUNCEMENT_REVISION_CHANGED');
          state = command.enabled ? 'active' : 'inactive';
        }
        if (
          state === 'active' &&
          (!content!.versionLabel.trim() || !content!.bodyText.trim())
        )
          throw new ApplicationError('ANNOUNCEMENT_CONTENT_REQUIRED');
      }
      if (!content || !audience)
        throw new ApplicationError('ANNOUNCEMENTS_UNAVAILABLE');
      const mediaFacts =
        command.action === 'cancel_draft'
          ? []
          : command.action === 'set_enabled' && !command.enabled
            ? (
                await tx.query<{ media_facts: unknown[] }>(
                  'SELECT media_facts FROM whaleu_announcements.native_publications WHERE announcement_id=$1 AND revision=$2',
                  [id, row!.revision],
                )
              ).rows[0]!.media_facts
            : await this.media.reviewFacts(id, bindings, tx);
      const revision = command.expectedRevision + 1,
        revisionId = randomUUID();
      const snapshot = {
        announcementId: id,
        revision,
        revisionId,
        operation: command.action,
        actorId: actor,
        grantId,
        state,
        content,
        audience,
        mediaBindings: bindings,
        mediaFacts,
      };
      const publicationHash = snapshotHash(snapshot);
      if (!row)
        await tx.query(
          "INSERT INTO whaleu_announcements.identities(id,origin_kind,provenance,source_reference,policy_reference) VALUES($1,'fresh_local','accepted','native-admin-operation:v1','native-announcement-authoring:v1')",
          [id],
        );
      await tx.query(
        'INSERT INTO whaleu_announcements.native_publications(announcement_id,revision,revision_id,operation,actor_id,grant_id,state,content,audience,media_bindings,media_facts,publication_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)',
        [
          id,
          revision,
          revisionId,
          command.action,
          actor,
          grantId,
          state,
          JSON.stringify(content),
          JSON.stringify(audience),
          JSON.stringify(bindings),
          JSON.stringify(mediaFacts),
          publicationHash,
        ],
      );
      if (row)
        await tx.query(
          'UPDATE whaleu_announcements.native_announcements SET revision=$2,revision_id=$3,state=$4,content=$5::jsonb,audience=$6::jsonb,media_bindings=$7::jsonb,publication_hash=$8,updated_at=transaction_timestamp() WHERE id=$1',
          [
            id,
            revision,
            revisionId,
            state,
            JSON.stringify(content),
            JSON.stringify(audience),
            JSON.stringify(bindings),
            publicationHash,
          ],
        );
      else
        await tx.query(
          'INSERT INTO whaleu_announcements.native_announcements(id,creator_id,revision,revision_id,state,content,audience,media_bindings,publication_hash) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9)',
          [
            id,
            actor,
            revision,
            revisionId,
            state,
            JSON.stringify(content),
            JSON.stringify(audience),
            JSON.stringify(bindings),
            publicationHash,
          ],
        );
      const receipt = receiptSchema.parse({
        requestId: command.clientRequestId,
        requestHash: hash,
        announcementId: id,
        revision,
        outcome: command.action,
      });
      await tx.query(
        'INSERT INTO whaleu_announcements.native_requests(actor_id,client_request_id,announcement_id,command,request_hash,receipt) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)',
        [
          actor,
          command.clientRequestId,
          id,
          JSON.stringify(command),
          hash,
          JSON.stringify(receipt),
        ],
      );
      await requireNativeCurrent('entry', id, tx);
      return receipt;
    });
  }
  private async epoch(tx: PoolClient) {
    return (
      await tx.query<{ revision: string }>(
        'SELECT revision FROM whaleu_announcements.native_directory_epoch WHERE singleton FOR SHARE',
      )
    ).rows[0]!.revision;
  }
  private async visible(
    campus: string | null,
    tx: PoolClient,
    options: {
      id?: string;
      popup?: boolean;
      after?: string | undefined;
      limit?: number;
    } = {},
  ) {
    await requireNativeCurrent('directory', '', tx);
    return (
      await tx.query<NativeAnnouncementRow>(
        `SELECT * FROM whaleu_announcements.native_announcements WHERE state='active' AND(audience->>'kind'='all' OR($1::uuid IS NOT NULL AND audience->'campusIds' ? $1::text)) AND($2::uuid IS NULL OR id=$2) AND(NOT $3::boolean OR(content->>'popupEnabled')::boolean) AND($4::bigint IS NULL OR ordinal<$4) ORDER BY ordinal DESC LIMIT $5`,
        [
          campus,
          options.id ?? null,
          options.popup ?? false,
          options.after ?? null,
          options.limit ?? 1,
        ],
      )
    ).rows;
  }
  private mediaView(row: NativeAnnouncementRow) {
    const items = Object.entries(row.media_bindings)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([slot, bindingId]) => ({
        announcementId: row.id,
        revision: Number(row.revision),
        slot,
        bindingId,
      }));
    return items.length
      ? { status: 'available' as const, items }
      : { status: 'known_empty' as const, items: [] };
  }
  list(token: string | null, query: AnnouncementListQuery) {
    return this.run(async (tx) => {
      const campus = query.campusId ?? null,
        s = await this.access.reads.resolve(token, campus, tx),
        epoch = await this.epoch(tx),
        scope = discoveryContinuationScope([
          'native-announcements',
          s ? [s.accountId, s.sessionId] : null,
          campus,
          epoch,
          query.limit,
        ]);
      const after = query.cursor
        ? (
            await this.cursors.get(query.cursor, scope, tx, (v) =>
              positionSchema.parse(v),
            )
          ).after
        : undefined;
      const latest = (await this.visible(campus, tx))[0],
        rows = await this.visible(campus, tx, {
          after,
          limit: query.limit + 1,
        });
      const next =
        rows.length > query.limit
          ? await this.cursors.create(
              scope,
              s?.accountId ?? null,
              {
                v: 1,
                kind: 'native-announcements',
                after: rows[query.limit - 1]!.ordinal,
              },
              tx,
            )
          : null;
      await requireNativeCurrent('directory', '', tx);
      return announcementPageSchema.parse({
        context: { campusId: campus },
        items: rows
          .slice(0, query.limit)
          .map((r) => announcementSummary(projection(r), latest?.id ?? null)),
        continuation: next ? 'more' : 'end',
        nextCursor: next,
      });
    });
  }
  detail(token: string | null, id: string, query: AnnouncementScopeQuery) {
    return this.run(async (tx) => {
      const campus = query.campusId ?? null,
        { row } = await this.access.publicRow(token, id, campus, tx),
        latest = (await this.visible(campus, tx))[0];
      await requireNativeCurrent('directory', '', tx);
      return {
        ...announcementDetail(projection(row), latest?.id ?? null),
        media: this.mediaView(row),
      };
    });
  }
  popup(token: string | null, query: AnnouncementScopeQuery, owner = false) {
    return this.run(async (tx) => {
      const campus = query.campusId ?? null,
        s = await this.access.reads.resolve(token, campus, tx);
      if (owner && !s) throw new ApplicationError('AUTHENTICATION_REQUIRED');
      const row = (await this.visible(campus, tx, { popup: true }))[0],
        popup = row
          ? {
              ...announcementPopup(projection(row)),
              media: this.mediaView(row),
            }
          : null;
      await requireNativeCurrent('directory', '', tx);
      return owner
        ? announcementOwnerPopupSchema.parse(
            row
              ? {
                  context: { campusId: campus },
                  candidate: popup,
                  acknowledgement: await this.legacy.acknowledgement(
                    s!.accountId,
                    row.id,
                    tx,
                  ),
                }
              : { context: { campusId: campus }, candidate: null },
          )
        : announcementPublicPopupSchema.parse({
            context: { campusId: campus },
            popup,
          });
    });
  }
  acknowledge(token: string, id: string, command: AnnouncementAckCommand) {
    return this.run(async (tx) => {
      const { row, session } = await this.access.publicRow(
        token,
        id,
        command.campusId,
        tx,
      );
      if (!session) throw new ApplicationError('AUTHENTICATION_REQUIRED');
      if (!row.content.popupEnabled)
        throw new ApplicationError('ANNOUNCEMENT_NOT_FOUND');
      if (row.revision_id !== command.expectedRevision)
        throw new ApplicationError('ANNOUNCEMENT_REVISION_CHANGED');
      return announcementAckReceiptSchema.parse({
        announcementId: id,
        acknowledgement: await this.legacy.acknowledge(
          session.accountId,
          id,
          tx,
        ),
      });
    });
  }
  changes(token: string | null, query: AnnouncementChangesQuery) {
    return this.run(async (tx) => {
      const campus = query.campusId ?? null;
      await this.access.reads.resolve(token, campus, tx);
      await requireNativeCurrent('directory', '', tx);
      const time = (
        await tx.query<{ since: string; checked: string }>(
          `WITH instant AS(SELECT clock_timestamp() n) SELECT to_char(n AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') checked,CASE WHEN $1::text IS NULL THEN to_char((n-interval '720 hours') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ELSE $1::text END since FROM instant`,
          [query.since ?? null],
        )
      ).rows[0]!;
      const count = (
        await tx.query<{ count: string }>(
          "SELECT count(*)::text count FROM whaleu_announcements.native_announcements WHERE state='active' AND(audience->>'kind'='all' OR($1::uuid IS NOT NULL AND audience->'campusIds' ? $1::text)) AND created_at>$2",
          [campus, query.since ?? time.since],
        )
      ).rows[0]!.count;
      await requireNativeCurrent('directory', '', tx);
      return announcementChangesSchema.parse({
        context: { campusId: campus },
        since: time.since,
        checkedAt: time.checked,
        newness: {
          status: 'available',
          hasNew: count !== '0',
          newCount: count,
        },
      });
    });
  }
}
