import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import { DatabaseService } from '../database/database.js';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../community/discovery-continuation.module.js';
import { CampusErrandScopeFacade } from '../campus/errand-scope.facade.js';
import { AuthorDisplayService } from '../profile/author-display.service.js';
import { ErrandContentReviewFacade } from '../community/content-review/errand-content-review.facade.js';
import { ErrandNotificationsFacade } from '../notifications/errand.facade.js';
import { ErrandAccessService } from './access.js';
import { ErrandsRepository, errandEnvelope } from './repository.js';
import type { ErrandRow, ErrandListPosition } from './repository.js';
import { ErrandRequests } from './requests.js';
import {
  errandSummarySchema,
  errandDetailSchema,
  errandContactHistorySchema,
  errandPageSchema,
  errandRewardSchema,
  errandIdSchema,
  errandTimeSchema,
} from './contracts.js';
import type {
  PublishErrand,
  ErrandCommand,
  AcceptErrand,
  ErrandsQuery,
  OwnErrandsQuery,
  ErrandOperation,
  ErrandDetail,
} from './contracts.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  anchor: errandTimeSchema,
  since: errandTimeSchema.nullable(),
  validUntil: z.number().finite(),
  after: z
    .strictObject({
      id: errandIdSchema,
      createdAt: errandTimeSchema,
      reward: errandRewardSchema,
    })
    .nullable(),
});
@Injectable()
export class ErrandsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ErrandAccessService) private readonly access: ErrandAccessService,
    @Inject(ErrandsRepository) private readonly records: ErrandsRepository,
    @Inject(ErrandRequests) private readonly requests: ErrandRequests,
    @Inject(ErrandContentReviewFacade)
    private readonly reviews: ErrandContentReviewFacade,
    @Inject(CampusErrandScopeFacade)
    private readonly campuses: CampusErrandScopeFacade,
    @Inject(AuthorDisplayService)
    private readonly profiles: AuthorDisplayService,
    @Inject(ErrandNotificationsFacade)
    private readonly notices: ErrandNotificationsFacade,
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
  ) {}
  private async run<T>(operation: (tx: PoolClient) => Promise<T>) {
    try {
      return await this.db.transaction(operation, {
        isolationLevel: 'read committed',
      });
    } catch (e) {
      if (e instanceof ZodError)
        throw new ApplicationError('ERRAND_UNAVAILABLE');
      throw e;
    }
  }
  private async visible(row: ErrandRow, tx: PoolClient) {
    const result = await this.reviews.current(row.id, errandEnvelope(row), tx);
    if (result.kind === 'unavailable')
      throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
    return result.kind === 'allow';
  }
  private async summary(row: ErrandRow, tx: PoolClient) {
    return errandSummarySchema.parse({
      id: row.id,
      revision: row.revision,
      title: row.title,
      publicText: row.public_text,
      expectedTimeText: row.expected_time_text,
      reward: row.reward,
      state: row.state,
      createdAt: row.created_at.toISOString(),
      acceptedAt: row.accepted_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      ...(await this.campuses.project(
        row.source_region_id,
        row.target_region_id,
        tx,
      )),
    });
  }
  publish(token: string, body: PublishErrand) {
    const { clientRequestId, ...intent } = body;
    return this.requests.execute(
      token,
      clientRequestId,
      'publish',
      intent,
      async (actor, tx) => {
        if (body.publicAssetIds.length || body.privateAssetIds.length)
          throw new ApplicationError('ERRAND_MEDIA_UNAVAILABLE');
        const scope = await this.access.scope(actor, body.targetRegionId, tx);
        await this.access.feature(actor, 'publish', tx);
        const envelope = {
          version: 1 as const,
          accountId: actor,
          purpose: 'publish_errand' as const,
          title: body.title,
          publicText: body.publicText,
          privateText: body.privateText,
          expectedTimeText: body.expectedTimeText,
          reward: body.reward,
          publisherContacts: body.publisherContacts,
          publicAssetIds: [] as [],
          privateAssetIds: [] as [],
          scope,
        };
        const approval = await this.reviews.accepted(envelope, tx);
        const row = await this.records.create(actor, body, scope, tx);
        await this.reviews.bind(approval, row.id, errandEnvelope(row), tx);
        const event = await this.records.event(
          row,
          actor,
          'publish',
          null,
          clientRequestId,
          tx,
        );
        return {
          orderId: row.id,
          revision: row.revision,
          occurredAt: event.occurredAt,
        };
      },
    );
  }
  command(
    token: string,
    id: string,
    operation: Exclude<ErrandOperation, 'publish'>,
    body: ErrandCommand | AcceptErrand,
  ) {
    const { clientRequestId, ...command } = body;
    return this.requests.execute(
      token,
      clientRequestId,
      operation,
      { orderId: id, ...command },
      async (actor, tx) => {
        if (operation === 'accept') {
          await this.access.base(actor, tx);
          await this.access.feature(actor, 'accept', tx);
        }
        const row = await this.records.read(id, tx, true);
        if (!row || row.deleted_at)
          throw new ApplicationError('ERRAND_NOT_FOUND');
        if (operation !== 'accept' && row.publisher_id !== actor)
          throw new ApplicationError('ERRAND_NOT_FOUND');
        if (operation === 'accept' && row.publisher_id === actor)
          throw new ApplicationError('ERRAND_SELF_ACCEPT');
        if (row.revision !== body.expectedRevision)
          throw new ApplicationError('ERRAND_REVISION_CONFLICT');
        if (
          (operation === 'accept' && row.state !== 'pending') ||
          (operation === 'cancel' &&
            !['pending', 'accepted'].includes(row.state)) ||
          (operation === 'complete' && row.state !== 'accepted')
        )
          throw new ApplicationError('ERRAND_STATE_CONFLICT');
        if (operation === 'accept' && !(await this.visible(row, tx)))
          throw new ApplicationError('ERRAND_NOT_FOUND');
        const contacts =
          operation === 'accept' ? (body as AcceptErrand).contacts : null;
        const next = await this.records.transition(
          row,
          actor,
          operation,
          contacts,
          tx,
        );
        const event = await this.records.event(
          next,
          actor,
          operation,
          row.state,
          clientRequestId,
          tx,
        );
        if (operation === 'accept') {
          await this.records.remember(actor, contacts!, event.id, tx);
          await this.notices.record(
            {
              transitionId: event.id,
              recipientAccountId: row.publisher_id,
              orderId: id,
              kind: 'accepted',
            },
            tx,
          );
        } else if (operation === 'complete')
          await this.notices.record(
            {
              transitionId: event.id,
              recipientAccountId: row.accepter_id!,
              orderId: id,
              kind: 'completed',
            },
            tx,
          );
        return {
          orderId: id,
          revision: next.revision,
          occurredAt: event.occurredAt,
        };
      },
    );
  }
  receipt(token: string, id: string) {
    return this.requests.receipt(token, id);
  }
  contacts(token: string) {
    return this.run(async (tx) => {
      const actor = await this.access.common(token, tx);
      const contacts = await this.records.contacts(actor.accountId, tx);
      await this.access.recheck(token, tx);
      return errandContactHistorySchema.parse(
        contacts ? { status: 'available', contacts } : { status: 'empty' },
      );
    });
  }
  detail(token: string, id: string) {
    return this.run(async (tx) => {
      const actor = await this.access.common(token, tx),
        row = await this.records.read(id, tx);
      if (!row || row.deleted_at)
        throw new ApplicationError('ERRAND_NOT_FOUND');
      const relation =
        row.publisher_id === actor.accountId
          ? ('publisher' as const)
          : row.accepter_id === actor.accountId
            ? ('accepter' as const)
            : ('none' as const);
      if (relation === 'none') await this.access.base(actor.accountId, tx);
      if (!(await this.visible(row, tx)))
        throw new ApplicationError('ERRAND_NOT_FOUND');
      const summary = await this.summary(row, tx);
      let accept = relation === 'none' && row.state === 'pending';
      if (accept)
        try {
          await this.access.feature(actor.accountId, 'accept', tx);
        } catch (e) {
          if (
            e instanceof ApplicationError &&
            ['ERRAND_ACTION_RESTRICTED', 'SAFETY_UNAVAILABLE'].includes(e.code)
          )
            accept = false;
          else throw e;
        }
      const detail: ErrandDetail = {
        ...summary,
        relation,
        capabilities: {
          accept,
          cancel:
            relation === 'publisher' &&
            ['pending', 'accepted'].includes(row.state),
          complete: relation === 'publisher' && row.state === 'accepted',
          delete: relation === 'publisher',
        },
      };
      if (relation !== 'none') detail.privateText = row.private_text;
      if (relation !== 'none' && row.state === 'accepted') {
        const opposite =
          relation === 'publisher' ? row.accepter_id! : row.publisher_id;
        const display = await this.profiles.find(opposite, tx);
        const contacts =
          relation === 'publisher'
            ? row.accepter_contacts
            : row.publisher_contacts;
        if (!contacts) throw new ApplicationError('ERRAND_UNAVAILABLE');
        detail.oppositeContact = {
          display: display
            ? { status: 'available', displayName: display.displayName }
            : { status: 'unavailable' },
          contacts,
        };
      }
      await this.access.recheck(token, tx);
      return errandDetailSchema.parse(detail);
    });
  }
  list(token: string, query: ErrandsQuery) {
    return this.page(token, { kind: 'discovery', query });
  }
  own(token: string, query: OwnErrandsQuery) {
    return this.page(token, { kind: 'own', query });
  }
  private page(
    token: string,
    mode:
      | { kind: 'discovery'; query: ErrandsQuery }
      | { kind: 'own'; query: OwnErrandsQuery },
  ) {
    return this.run(async (tx) => {
      const session = await this.access.common(token, tx),
        query = mode.query;
      let identity: Awaited<ReturnType<ErrandAccessService['scope']>> | null =
        null;
      if (mode.kind === 'discovery')
        identity = await this.access.scope(
          session.accountId,
          mode.query.regionId,
          tx,
        );
      const ownOnly =
        mode.kind === 'discovery' &&
        identity!.sourceRegionId !== mode.query.regionId;
      const context =
        mode.kind === 'discovery'
          ? {
              kind: 'discovery' as const,
              regionId: mode.query.regionId,
              discoveryMode: ownOnly
                ? ('own_only' as const)
                : ('home' as const),
            }
          : { kind: 'own' as const, relation: mode.query.relation };
      const scope = discoveryContinuationScope([
        'errands-v1',
        session.accountId,
        session.sessionId,
        context,
        query.limit,
        mode.kind === 'discovery'
          ? [
              mode.query.filter,
              mode.query.sort,
              mode.query.direction,
              identity!.identitySelectionId,
              identity!.topologySnapshotId,
            ]
          : null,
      ]);
      const now = (
        await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now.getTime();
      const position: ErrandListPosition = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx, (v) =>
            positionSchema.parse(v),
          )
        : {
            v: 1,
            anchor: new Date(now).toISOString(),
            since:
              mode.kind === 'discovery'
                ? new Date(now - 3 * 86400000).toISOString()
                : null,
            validUntil: now + 5 * 60000,
            after: null,
          };
      if (
        position.validUntil <= now ||
        Date.parse(position.anchor) > now ||
        position.validUntil !== Date.parse(position.anchor) + 5 * 60000 ||
        (mode.kind === 'discovery'
          ? position.since === null ||
            Date.parse(position.since) !==
              Date.parse(position.anchor) - 3 * 86400000
          : position.since !== null)
      )
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      registerTransactionDeadline(
        tx,
        position.validUntil,
        'DISCOVERY_RESTART_REQUIRED',
      );
      const candidates = await this.records.candidates(
        session.accountId,
        position,
        mode.kind === 'discovery'
          ? { kind: 'discovery', query: mode.query, ownOnly }
          : { kind: 'own', relation: mode.query.relation },
        tx,
      );
      const items = [];
      let after = position.after,
        scanned = 0;
      for (const candidate of candidates.slice(0, 100)) {
        if (items.length === query.limit) break;
        scanned++;
        const row = await this.records.read(candidate.id, tx);
        if (!row) throw new ApplicationError('ERRAND_UNAVAILABLE');
        after = {
          id: row.id,
          createdAt: row.created_at.toISOString(),
          reward: row.reward,
        };
        if (row.deleted_at) continue;
        if (
          mode.kind === 'discovery' &&
          (!['pending', 'accepted'].includes(row.state) ||
            (mode.query.filter === 'pending' && row.state !== 'pending'))
        )
          continue;
        if (!(await this.visible(row, tx))) continue;
        items.push(await this.summary(row, tx));
      }
      const more = scanned < candidates.length;
      await this.access.recheck(token, tx);
      const nextCursor =
        more && after
          ? await this.cursors.create(
              scope,
              session.accountId,
              { ...position, after },
              tx,
            )
          : null;
      return errandPageSchema.parse({
        context,
        items,
        continuation: nextCursor ? 'more' : 'end',
        nextCursor,
      });
    });
  }
}
