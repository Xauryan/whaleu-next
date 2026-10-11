import { MediaCurrentDenied } from '../../media/asset-repository.js';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ZodError, z } from 'zod';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { canonicalJson } from '../../community/content-review/contracts.js';
import {
  DiscoveryContinuationFacade,
  discoveryContinuationScope,
} from '../../community/discovery-continuation.module.js';
import { requireOrganizationDirectoryCurrent } from '../../organizations/management/current-proof.js';
import { OrganizationMediaService } from '../../organizations/media/facade.js';
import { ActivityMediaService } from '../media/facade.js';
import { ActivityPublicationAccess } from './access.js';
import type { ActivityDraftRow, NativeActivityRow } from './access.js';
import { ActivityReviewService } from './review.js';
import { lockActivity, requireActivityCurrent } from './current-proof.js';
import {
  publicationCommandHash,
  activityPublicationReceiptSchema,
  activityPublicationRecoverySchema,
  activityDraftSchema,
  activityReviewEnvelopeSchema,
  activityReviewDigest,
  activityOrganizerPageSchema,
  activityNativeItemSchema,
  activityNativePageSchema,
  requirePublishableContent,
} from './contracts.js';
import type {
  ActivityPublicationCommand,
  ActivityPublicationReceipt,
  ActivityReviewEnvelope,
  PublicationQuery,
} from './contracts.js';
const positionSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum([
    'activity-organizers',
    'native-activities',
    'my-native-activities',
  ]),
  epoch: z.string(),
  after: z.string(),
});
@Injectable()
export class ActivityPublicationService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ActivityPublicationAccess)
    readonly access: ActivityPublicationAccess,
    @Inject(ActivityMediaService) readonly media: ActivityMediaService,
    @Inject(OrganizationMediaService)
    private readonly orgMedia: OrganizationMediaService,
    @Inject(ActivityReviewService) readonly review: ActivityReviewService,
    @Inject(DiscoveryContinuationFacade)
    private readonly cursors: DiscoveryContinuationFacade,
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
          ['57014', '55P03', '23514'].includes(String(error.code)))
      )
        throw new ApplicationError('ACTIVITY_UNAVAILABLE');
      throw error;
    }
  }
  private async requestLock(actor: string, key: string, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:activity-request:v1:'||$1||':'||$2,0))",
      [actor, key],
    );
  }
  private async recovery(actor: string, key: string, tx: PoolClient) {
    const receipt = (
      await tx.query<{ receipt: unknown }>(
        'SELECT receipt FROM whaleu_activities.publication_receipts WHERE actor_id=$1 AND client_request_id=$2',
        [actor, key],
      )
    ).rows[0];
    if (receipt)
      return activityPublicationRecoverySchema.parse({
        state: 'recorded',
        requestId: key,
        receipt: receipt.receipt,
      });
    const cancelled = (
      await tx.query<{ request_hash: string }>(
        'SELECT request_hash FROM whaleu_activities.publication_cancel_fences WHERE actor_id=$1 AND client_request_id=$2',
        [actor, key],
      )
    ).rows[0];
    if (cancelled)
      return activityPublicationRecoverySchema.parse({
        state: 'cancelled',
        requestId: key,
        requestHash: cancelled.request_hash,
      });
    const job = (
      await tx.query<{ id: string; request_hash: string }>(
        `SELECT j.id,r.request_hash FROM whaleu_activities.review_jobs j JOIN whaleu_activities.publication_requests r USING(actor_id,client_request_id) WHERE j.actor_id=$1 AND j.client_request_id=$2`,
        [actor, key],
      )
    ).rows[0];
    return activityPublicationRecoverySchema.parse(
      job
        ? {
            state: 'pending',
            requestId: key,
            requestHash: job.request_hash,
            review: await this.review.status(job.id, tx),
          }
        : { state: 'not_recorded', requestId: key },
    );
  }
  recover(token: string, key: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx);
      await this.requestLock(session.accountId, key, tx);
      return this.recovery(session.accountId, key, tx);
    });
  }
  cancel(token: string, key: string, hash: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx, true),
        actor = session.accountId;
      await this.requestLock(actor, key, tx);
      const prior = await this.recovery(actor, key, tx);
      if (prior.state === 'recorded') {
        if (prior.receipt.requestHash !== hash)
          throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
        return prior;
      }
      if (prior.state !== 'not_recorded' && prior.requestHash !== hash)
        throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
      await tx.query(
        `INSERT INTO whaleu_activities.publication_cancel_fences(actor_id,client_request_id,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [actor, key, hash],
      );
      return activityPublicationRecoverySchema.parse({
        state: 'cancelled',
        requestId: key,
        requestHash: hash,
      });
    });
  }
  command(token: string, id: string, command: ActivityPublicationCommand) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx, true),
        actor = session.accountId,
        hash = publicationCommandHash(actor, id, command);
      await this.requestLock(actor, command.clientRequestId, tx);
      const prior = await this.recovery(actor, command.clientRequestId, tx);
      if (prior.state === 'recorded') {
        if (prior.receipt.requestHash !== hash)
          throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
        return prior.receipt;
      }
      if (prior.state === 'cancelled')
        throw new ApplicationError(
          prior.requestHash === hash
            ? 'ACTIVITY_PUBLICATION_CANCELLED'
            : 'ACTIVITY_PUBLICATION_CONFLICT',
        );
      if (prior.state === 'pending' && prior.requestHash !== hash)
        throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
      const existing = (
        await tx.query<{ request_hash: string }>(
          'SELECT request_hash FROM whaleu_activities.publication_requests WHERE actor_id=$1 AND client_request_id=$2',
          [actor, command.clientRequestId],
        )
      ).rows[0];
      if (existing && existing.request_hash !== hash)
        throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
      await lockActivity(id, tx);
      if (!existing)
        await tx.query(
          `INSERT INTO whaleu_activities.publication_requests(actor_id,client_request_id,activity_id,request_hash,command) VALUES($1,$2,$3,$4,$5::jsonb)`,
          [actor, command.clientRequestId, id, hash, canonicalJson(command)],
        );
      let row: ActivityDraftRow;
      if (command.action === 'create') {
        const owner = await this.access.manager(
          actor,
          command.organization.organizationId,
          command.organizationRevision,
          tx,
        );
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:activity-draft-budget:v1:'||$1,0))",
          [actor],
        );
        if (
          (
            await tx.query(
              'SELECT 1 FROM whaleu_activities.publication_drafts WHERE id=$1',
              [id],
            )
          ).rowCount
        )
          throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
        const count = (
          await tx.query<{ n: number }>(
            "SELECT count(*)::integer n FROM whaleu_activities.publication_drafts WHERE account_id=$1 AND state='draft'",
            [actor],
          )
        ).rows[0]!.n;
        if (count >= 20) throw new ApplicationError('RATE_LIMITED');
        row = (
          await tx.query<ActivityDraftRow>(
            `INSERT INTO whaleu_activities.publication_drafts(id,account_id,organization_id,organization_revision,authority_version,region_id,revision,state,content) VALUES($1,$2,$3,$4,$5,$6,1,'draft',$7::jsonb) RETURNING *`,
            [
              id,
              actor,
              owner.row.id,
              command.organizationRevision,
              owner.authorityVersion,
              owner.row.region_id,
              canonicalJson(command.content),
            ],
          )
        ).rows[0]!;
      } else {
        row = await this.access.draft(id, tx, true);
        if (Number(row.revision) !== command.expectedRevision)
          throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
        if (command.action === 'cancel_draft') {
          if (row.account_id !== actor || row.state !== 'draft')
            throw new ApplicationError('AUTHORIZATION_REQUIRED');
        } else await this.access.requireDraft(actor, row, tx);
      }
      if (command.action === 'save' || command.action === 'cancel_draft') {
        if (
          (
            await tx.query(
              `SELECT 1 FROM whaleu_activities.review_jobs j WHERE j.activity_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_receipts r WHERE(r.actor_id,r.client_request_id)=(j.actor_id,j.client_request_id)) AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_cancel_fences c WHERE(c.actor_id,c.client_request_id)=(j.actor_id,j.client_request_id)) LIMIT 1`,
              [id],
            )
          ).rowCount
        )
          throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
        if (command.action === 'save') {
          const bindings = await this.media.mutate(
            {
              actorAccountId: actor,
              activityId: id,
              revision: Number(row.revision),
              currentBindings: row.media_bindings,
              changes: command.mediaChanges,
            },
            tx,
          );
          row = {
            ...row,
            revision: String(Number(row.revision) + 1),
            content: command.content,
            media_bindings: bindings,
          };
        } else {
          row = {
            ...row,
            media_bindings: await this.media.retireDraft(
              {
                actorAccountId: actor,
                activityId: id,
                revision: Number(row.revision),
                currentBindings: row.media_bindings,
              },
              tx,
            ),
          };
        }
      }
      if (command.action === 'publish') {
        if (
          (
            await tx.query(
              `SELECT 1 FROM whaleu_activities.review_jobs j WHERE j.activity_id=$1 AND j.client_request_id<>$2 AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_receipts r WHERE(r.actor_id,r.client_request_id)=(j.actor_id,j.client_request_id)) AND NOT EXISTS(SELECT 1 FROM whaleu_activities.publication_cancel_fences c WHERE(c.actor_id,c.client_request_id)=(j.actor_id,j.client_request_id)) LIMIT 1`,
              [id, command.clientRequestId],
            )
          ).rowCount
        )
          throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
        requirePublishableContent(row.content);
        await this.media.requireCurrentBindings(id, row.media_bindings, tx, {
          requireCover: true,
        });
        const envelope = await this.envelope(token, row, tx),
          digest = activityReviewDigest(envelope);
        let job = (
          await tx.query<{ id: string; digest: string; envelope: unknown }>(
            `SELECT id,digest,envelope FROM whaleu_activities.review_jobs WHERE actor_id=$1 AND client_request_id=$2`,
            [actor, command.clientRequestId],
          )
        ).rows[0];
        if (!job) {
          job = { id: randomUUID(), digest, envelope };
          await tx.query(
            `INSERT INTO whaleu_activities.review_jobs(id,actor_id,client_request_id,activity_id,digest,envelope) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
            [
              job.id,
              actor,
              command.clientRequestId,
              id,
              digest,
              canonicalJson(envelope),
            ],
          );
          await requireActivityCurrent('draft', id, tx);
          await this.access.recheck(token, tx);
          return activityPublicationRecoverySchema.parse({
            state: 'pending',
            requestId: command.clientRequestId,
            requestHash: hash,
            review: 'pending',
          });
        }
        if (
          job.digest !== digest ||
          canonicalJson(job.envelope) !== canonicalJson(envelope)
        )
          throw new ApplicationError('ACTIVITY_PUBLICATION_CONFLICT');
        const status = await this.review.status(job.id, tx);
        if (status !== 'ready') {
          await requireActivityCurrent('draft', id, tx);
          return activityPublicationRecoverySchema.parse({
            state: 'pending',
            requestId: command.clientRequestId,
            requestHash: hash,
            review: status,
          });
        }
        const decisionId = await this.review.accepted(job.id, envelope, tx);
        await tx.query(
          `INSERT INTO whaleu_activities.native_activities(id,original_publisher_account_id,organization_id,organization_revision,revision,region_id,organizer_label,content,media_bindings,organizer_qr,review_decision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
          [
            id,
            actor,
            row.organization_id,
            row.organization_revision,
            row.revision,
            row.region_id,
            envelope.organizerLabel,
            canonicalJson(row.content),
            canonicalJson(row.media_bindings),
            envelope.organizerQr ? canonicalJson(envelope.organizerQr) : null,
            decisionId,
          ],
        );
      }
      const eventId = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_activities.publication_events(id,activity_id,actor_id,client_request_id,action,revision,content,media_bindings) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
        [
          eventId,
          id,
          actor,
          command.clientRequestId,
          command.action,
          row.revision,
          canonicalJson(row.content),
          canonicalJson(row.media_bindings),
        ],
      );
      if (command.action !== 'create')
        await tx.query(
          `UPDATE whaleu_activities.publication_drafts SET revision=$2,content=$3::jsonb,media_bindings=$4::jsonb,state=$5,updated_at=transaction_timestamp() WHERE id=$1`,
          [
            id,
            row.revision,
            canonicalJson(row.content),
            canonicalJson(row.media_bindings),
            command.action === 'publish'
              ? 'published'
              : command.action === 'cancel_draft'
                ? 'cancelled'
                : 'draft',
          ],
        );
      const receipt: ActivityPublicationReceipt =
        activityPublicationReceiptSchema.parse({
          requestId: command.clientRequestId,
          requestHash: hash,
          activityId: id,
          revision: Number(row.revision),
          outcome:
            command.action === 'create'
              ? 'created'
              : command.action === 'save'
                ? 'saved'
                : command.action === 'publish'
                  ? 'published'
                  : 'draft_cancelled',
        });
      await tx.query(
        `INSERT INTO whaleu_activities.publication_receipts(actor_id,client_request_id,request_hash,activity_id,event_id,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          actor,
          command.clientRequestId,
          hash,
          id,
          eventId,
          canonicalJson(receipt),
        ],
      );
      await this.access.recheck(token, tx);
      await requireActivityCurrent('draft', id, tx);
      return receipt;
    });
  }
  private async envelope(
    token: string,
    row: ActivityDraftRow,
    tx: PoolClient,
  ): Promise<ActivityReviewEnvelope> {
    const owner = await this.access.manager(
      row.account_id,
      row.organization_id,
      Number(row.organization_revision),
      tx,
    );
    let qr: ActivityReviewEnvelope['organizerQr'] = null;
    if (row.content.showOrganizerQr) {
      const binding = owner.row.media_bindings.mainQr;
      if (!binding) throw new ApplicationError('MEDIA_UNAVAILABLE');
      const ref = {
        organizationId: owner.row.id,
        applicationRevision: Number(owner.row.revision),
        slot: 'mainQr' as const,
        bindingId: binding,
      };
      await this.orgMedia.describeReference(token, ref, 'public', tx);
      const facts = (
        await tx.query<{ asset_id: string; manifest_digest: string }>(
          `SELECT asset_id,manifest_digest FROM whaleu_organizations.media_appearances WHERE organization_id=$1 AND slot='mainQr' AND binding_id=$2`,
          [owner.row.id, binding],
        )
      ).rows[0];
      if (!facts) throw new ApplicationError('MEDIA_UNAVAILABLE');
      qr = {
        ...ref,
        assetId: facts.asset_id,
        manifestDigest: facts.manifest_digest,
      };
    }
    return activityReviewEnvelopeSchema.parse({
      version: 1,
      purpose: 'publish_activity',
      accountId: row.account_id,
      activityId: row.id,
      draftRevision: Number(row.revision),
      organization: { source: 'managed', organizationId: row.organization_id },
      organizationRevision: Number(row.organization_revision),
      authorityVersion: row.authority_version,
      regionId: row.region_id,
      organizerLabel: owner.row.data.name,
      content: row.content,
      media: await this.media.reviewFacts(row.id, row.media_bindings, tx),
      organizerQr: qr,
    });
  }
  draft(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx),
        row = await this.access.draft(id, tx);
      if (row.account_id !== session.accountId)
        throw new ApplicationError('ACTIVITY_NOT_FOUND');
      // Original private draft remains recoverable after organization authority changes;
      // every save/publish/media read separately re-proves current manager authority.
      await requireActivityCurrent('draft', id, tx);
      return activityDraftSchema.parse({
        source: 'native',
        id: row.id,
        regionId: row.region_id,
        organization: {
          source: 'managed',
          organizationId: row.organization_id,
        },
        organizationRevision: Number(row.organization_revision),
        revision: Number(row.revision),
        state: row.state,
        content: row.content,
        mediaBindings: row.media_bindings,
      });
    });
  }
  organizers(token: string, query: PublicationQuery) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx),
        home = await this.access.organizations.home(
          session.accountId,
          null,
          tx,
        );
      await requireOrganizationDirectoryCurrent(tx);
      const epoch = (
          await tx.query<{ revision: string }>(
            'SELECT revision FROM whaleu_organizations.native_directory_epoch WHERE singleton',
          )
        ).rows[0]!.revision,
        kind = 'activity-organizers' as const,
        scope = discoveryContinuationScope([
          kind,
          session.accountId,
          session.sessionId,
          home.identityRegionId,
          home.selectionId,
          home.topologySnapshotId,
          epoch,
          query.limit,
        ]);
      const position = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx, (v) =>
            positionSchema.parse(v),
          )
        : null;
      if (position && (position.kind !== kind || position.epoch !== epoch))
        throw new ApplicationError('ACTIVITY_REVISION_CHANGED');
      const rows = (
        await tx.query<{ id: string }>(
          `SELECT o.id FROM whaleu_organizations.organizations o JOIN whaleu_organizations.organization_grants g ON g.organization_id=o.id WHERE o.region_id=$1 AND o.state='approved' AND g.account_id=$2 AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp() AND(g.expires_at IS NULL OR g.expires_at>clock_timestamp()) AND($3::uuid IS NULL OR o.id>$3) ORDER BY o.id LIMIT $4`,
          [
            home.identityRegionId,
            session.accountId,
            position?.after ?? null,
            query.limit + 1,
          ],
        )
      ).rows;
      const items = [];
      for (const r of rows.slice(0, query.limit)) {
        const owner = await this.access.manager(
          session.accountId,
          r.id,
          null,
          tx,
        );
        items.push({
          source: 'managed',
          organizationId: r.id,
          revision: Number(owner.row.revision),
          name: owner.row.data.name,
          kind: owner.row.data.kind,
          role: owner.grant.role,
        });
      }
      const nextCursor =
        rows.length > query.limit
          ? await this.cursors.create(
              scope,
              session.accountId,
              { v: 1, kind, epoch, after: items.at(-1)!.organizationId },
              tx,
            )
          : null;
      return activityOrganizerPageSchema.parse({
        regionId: home.identityRegionId,
        items,
        nextCursor,
      });
    });
  }
  private async item(token: string, row: NativeActivityRow, tx: PoolClient) {
    await this.media.requireCurrentBindings(row.id, row.media_bindings, tx, {
      requireCover: true,
    });
    let qr: unknown = { status: 'disabled' };
    if (row.content.showOrganizerQr) {
      qr = { status: 'unavailable' };
      const org = await this.access.organizations.row(row.organization_id, tx),
        ref = row.organizer_qr;
      if (
        ref &&
        Number(org.revision) === ref.applicationRevision &&
        org.media_bindings.mainQr === ref.bindingId
      ) {
        await this.orgMedia.describeReference(
          token,
          {
            organizationId: ref.organizationId,
            applicationRevision: ref.applicationRevision,
            slot: 'mainQr',
            bindingId: ref.bindingId,
          },
          'public',
          tx,
        );
        qr = {
          status: 'available',
          organizationId: ref.organizationId,
          applicationRevision: ref.applicationRevision,
          slot: 'mainQr',
          bindingId: ref.bindingId,
        };
      }
    }
    return activityNativeItemSchema.parse({
      source: 'native',
      id: row.id,
      regionId: row.region_id,
      revision: Number(row.revision),
      organization: { source: 'managed', organizationId: row.organization_id },
      organizerLabel: row.organizer_label,
      content: row.content,
      mediaBindings: row.media_bindings,
      createdAt: row.created_at.toISOString(),
      organizerQr: qr,
    });
  }
  detail(token: string, id: string) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx),
        row = await this.access.native(id, session.accountId, tx);
      return this.item(token, row, tx);
    });
  }
  list(token: string, query: PublicationQuery, mine = false) {
    return this.run(async (tx) => {
      const session = await this.access.authenticate(token, tx),
        home = await this.access.organizations.home(
          session.accountId,
          null,
          tx,
        );
      await requireActivityCurrent('directory', 'native', tx);
      await requireOrganizationDirectoryCurrent(tx);
      const epoch = (
          await tx.query<{ revision: string }>(
            `SELECT a.revision::text||':'||o.revision::text revision FROM whaleu_activities.native_directory_epoch a CROSS JOIN whaleu_organizations.native_directory_epoch o WHERE a.singleton AND o.singleton`,
          )
        ).rows[0]!.revision,
        kind = mine
          ? ('my-native-activities' as const)
          : ('native-activities' as const),
        scope = discoveryContinuationScope([
          kind,
          session.accountId,
          session.sessionId,
          home.identityRegionId,
          home.selectionId,
          home.topologySnapshotId,
          epoch,
          query.limit,
        ]);
      const position = query.cursor
        ? await this.cursors.get(query.cursor, scope, tx, (v) =>
            positionSchema.parse(v),
          )
        : null;
      if (
        position &&
        (position.kind !== kind ||
          position.epoch !== epoch ||
          !/^\d+$/.test(position.after))
      )
        throw new ApplicationError('ACTIVITY_REVISION_CHANGED');
      const rows = (
        await tx.query<{ id: string; ordinal: string }>(
          `SELECT a.id,a.ordinal FROM whaleu_activities.native_activities a JOIN whaleu_organizations.organizations o ON o.id=a.organization_id AND o.state='approved' WHERE a.region_id=$1 AND($2::uuid IS NULL OR a.original_publisher_account_id=$2) AND($3::bigint IS NULL OR a.ordinal<$3) ORDER BY a.ordinal DESC LIMIT $4`,
          [
            home.identityRegionId,
            mine ? session.accountId : null,
            position?.after ?? null,
            query.limit + 1,
          ],
        )
      ).rows;
      const items = [];
      // Check at most one bounded candidate page. Known denials are omitted;
      // unknown evidence still fails closed. Cursor advances by the last checked
      // candidate, so even an empty visible page can continue without false totals.
      for (const r of rows.slice(0, query.limit)) {
        try {
          items.push(
            await this.item(
              token,
              await this.access.native(r.id, session.accountId, tx),
              tx,
            ),
          );
        } catch (error) {
          if (
            !(error instanceof MediaCurrentDenied) &&
            !(
              error instanceof ApplicationError &&
              error.code === 'CONTENT_REJECTED'
            )
          )
            throw error;
        }
      }
      const nextCursor =
        rows.length > query.limit
          ? await this.cursors.create(
              scope,
              session.accountId,
              { v: 1, kind, epoch, after: rows[query.limit - 1]!.ordinal },
              tx,
            )
          : null;
      return activityNativePageSchema.parse({
        source: 'native',
        regionId: home.identityRegionId,
        items,
        nextCursor,
      });
    });
  }
}
