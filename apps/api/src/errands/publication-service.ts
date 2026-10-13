import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import {
  canonicalJson,
  canonicalEqual,
} from '../community/content-review/contracts.js';
import {
  canonicalErrandEnvelope,
  errandApprovalDigest,
} from '../community/content-review/errand-contracts.js';
import type {
  ErrandContentEnvelope,
  ErrandContentScope,
} from '../community/content-review/errand-contracts.js';
import { ErrandContentReviewFacade } from '../community/content-review/errand-content-review.facade.js';
import { ErrandAccessService } from './access.js';
import { ErrandsRepository, errandEnvelope } from './repository.js';
import { ErrandRequests } from './requests.js';
import { errandReceiptSchema } from './contracts.js';
import { ErrandMediaService } from './media/facade.js';
import type { PrepareErrandMediaInput } from '../media/contracts-errand.js';
import {
  ERRAND_PUBLICATION_PROTOCOL,
  createErrandDraftSchema,
  cancelErrandDraftSchema,
  errandDraftSchema,
  publishErrandV2Schema,
  errandPublicationPreparationSchema,
  errandPublicationHash,
  errandImageBindingSchema,
} from './publication-contracts.js';
import type {
  PublishErrandV2,
  ErrandImageBinding,
} from './publication-contracts.js';
import { requireErrandMediaCurrent } from './media-current-proof.js';

interface DraftRow {
  id: string;
  actor_id: string;
  target_region_id: string;
  revision: string;
  state: 'open' | 'published' | 'cancelled';
  scope: ErrandContentScope;
  authority_version: string;
  expires_at: Date;
  publication_request_id: string | null;
  publication_request_hash: string | null;
}
const authorityHash = (scope: ErrandContentScope) =>
  createHash('sha256')
    .update('whaleu:errand-media-authority:v1\n' + canonicalJson(scope))
    .digest('hex');
@Injectable()
export class ErrandPublicationService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(ErrandAccessService) private readonly access: ErrandAccessService,
    @Inject(ErrandsRepository) private readonly records: ErrandsRepository,
    @Inject(ErrandRequests) private readonly requests: ErrandRequests,
    @Inject(ErrandContentReviewFacade)
    private readonly reviews: ErrandContentReviewFacade,
    @Inject(ErrandMediaService) private readonly media: ErrandMediaService,
  ) {}
  private project(row: DraftRow) {
    return errandDraftSchema.parse({
      protocol: ERRAND_PUBLICATION_PROTOCOL,
      draftId: row.id,
      targetRegionId: row.target_region_id,
      revision: Number(row.revision),
      state: row.state,
      expiresAt: row.expires_at.getTime(),
    });
  }
  private async draft(
    actor: string,
    id: string,
    tx: PoolClient,
    write = true,
  ): Promise<DraftRow> {
    const row = (
      await tx.query<DraftRow>(
        `SELECT * FROM whaleu_errands.media_drafts WHERE id=$1 AND actor_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
        [id, actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('ERRAND_NOT_FOUND');
    return row;
  }
  private async currentDraft(
    actor: string,
    id: string,
    revision: number,
    target: string,
    tx: PoolClient,
  ) {
    await this.access.actorCommon(actor, tx);
    const draft = await this.draft(actor, id, tx);
    if (
      draft.state !== 'open' ||
      Number(draft.revision) !== revision ||
      draft.target_region_id !== target
    )
      throw new ApplicationError('ERRAND_REVISION_CONFLICT');
    registerTransactionDeadline(
      tx,
      draft.expires_at.getTime(),
      'ERRAND_UNAVAILABLE',
    );
    const scope = await this.access.scope(actor, target, tx);
    await this.access.feature(actor, 'publish', tx);
    if (
      !canonicalEqual(scope, draft.scope) ||
      authorityHash(scope) !== draft.authority_version
    )
      throw new ApplicationError('ERRAND_REVISION_CONFLICT');
    return draft;
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  create(token: string, raw: unknown) {
    const input = createErrandDraftSchema.parse(raw);
    return this.db.transaction(
      async (tx) => {
        const actor = await this.access.common(token, tx, true);
        await tx.query('SELECT whaleu_errands.lock_media_draft($1,$2)', [
          actor.accountId,
          input.draftId,
        ]);
        if (
          (
            await tx.query(
              'SELECT 1 FROM whaleu_errands.media_draft_cancellations WHERE actor_id=$1 AND draft_id=$2',
              [actor.accountId, input.draftId],
            )
          ).rowCount
        )
          throw new ApplicationError('ERRAND_STATE_CONFLICT');
        const scope = await this.access.scope(
          actor.accountId,
          input.targetRegionId,
          tx,
        );
        await this.access.feature(actor.accountId, 'publish', tx);
        await tx.query(
          `INSERT INTO whaleu_errands.media_drafts(id,actor_id,target_region_id,scope,authority_version) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,
          [
            input.draftId,
            actor.accountId,
            input.targetRegionId,
            canonicalJson(scope),
            authorityHash(scope),
          ],
        );
        const row = await this.draft(actor.accountId, input.draftId, tx);
        if (
          row.target_region_id !== input.targetRegionId ||
          !canonicalEqual(row.scope, scope)
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        await requireErrandMediaCurrent('draft', row.id, tx);
        await this.access.recheck(token, tx);
        return this.project(row);
      },
      { isolationLevel: 'read committed' },
    );
  }
  async authorizeMediaPrepare(
    actor: string,
    input: PrepareErrandMediaInput,
    tx: PoolClient,
  ) {
    const draft = await this.currentDraft(
      actor,
      input.draftId,
      input.draftRevision,
      input.targetRegionId,
      tx,
    );
    if (draft.publication_request_id !== null)
      throw new ApplicationError('ERRAND_STATE_CONFLICT');
    const other = (
      await tx.query(
        `SELECT 1 FROM whaleu_media.errand_scopes s JOIN whaleu_media.upload_intents i ON i.resource_id=s.id
      WHERE s.draft_id=$1 AND s.slot=$2 AND s.client_request_id<>$3 AND i.state IN('prepared','upload_observed','sealing','processing','awaiting_review','ready') LIMIT 1`,
        [draft.id, input.slot, input.clientRequestId],
      )
    ).rowCount;
    if (other) throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    return {
      actorAccountId: actor,
      draftId: draft.id,
      draftRevision: Number(draft.revision),
      targetRegionId: draft.target_region_id,
      authorityVersion: draft.authority_version,
      expiresAt: draft.expires_at.getTime(),
    };
  }
  retainDraftCurrent(id: string, tx: PoolClient) {
    return requireErrandMediaCurrent('draft', id, tx);
  }
  private envelope(
    actor: string,
    body: PublishErrandV2,
    scope: ErrandContentScope,
  ): ErrandContentEnvelope {
    return canonicalErrandEnvelope({
      version: 2,
      accountId: actor,
      purpose: 'publish_errand',
      title: body.title,
      publicText: body.publicText,
      privateText: body.privateText,
      expectedTimeText: body.expectedTimeText,
      reward: body.reward,
      publisherContacts: body.publisherContacts,
      scope,
      draftId: body.draftId,
      draftRevision: body.draftRevision,
      mediaRevision: 1,
      publicMedia: body.publicMedia,
      privateMedia: body.privateMedia,
    });
  }
  /** Reserve the exact original command before the native client can lose its
   * response. The journal subsequently needs only these IDs and hashes. */
  @AccountPolicy('interaction', 'owner_after_recovery')
  prepare(token: string, raw: unknown) {
    const body = publishErrandV2Schema.parse(raw),
      hash = errandPublicationHash(body);
    return this.db.transaction(
      async (tx) => {
        const { accountId: actor } = await this.access.common(token, tx);
        const draft = await this.currentDraft(
          actor,
          body.draftId,
          body.draftRevision,
          body.targetRegionId,
          tx,
        );
        if (
          draft.publication_request_id !== null &&
          (draft.publication_request_id !== body.clientRequestId ||
            draft.publication_request_hash !== hash)
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        const existing = (
          await tx.query<{ intent_hash: string }>(
            'SELECT intent_hash FROM whaleu_errands.requests WHERE account_id=$1 AND request_id=$2',
            [actor, body.clientRequestId],
          )
        ).rows[0];
        if (existing && existing.intent_hash !== hash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.media.draftFacts(
          actor,
          draft.id,
          Number(draft.revision),
          draft.authority_version,
          [...body.publicMedia, ...body.privateMedia],
          tx,
        );
        const envelope = this.envelope(actor, body, draft.scope),
          reviewDigest = errandApprovalDigest(envelope);
        await tx.query(
          `INSERT INTO whaleu_errands.media_publication_intents(actor_id,request_id,draft_id,draft_revision,request_hash,command,review_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(actor_id,request_id) DO NOTHING`,
          [
            actor,
            body.clientRequestId,
            draft.id,
            body.draftRevision,
            hash,
            canonicalJson(body),
            reviewDigest,
          ],
        );
        const original = (
          await tx.query<{ request_hash: string; command: unknown }>(
            'SELECT request_hash,command FROM whaleu_errands.media_publication_intents WHERE actor_id=$1 AND request_id=$2',
            [actor, body.clientRequestId],
          )
        ).rows[0];
        if (
          !original ||
          original.request_hash !== hash ||
          !canonicalEqual(original.command, body)
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        if (draft.publication_request_id === null)
          await tx.query(
            'UPDATE whaleu_errands.media_drafts SET publication_request_id=$2,publication_request_hash=$3 WHERE id=$1',
            [draft.id, body.clientRequestId, hash],
          );
        await requireErrandMediaCurrent('draft', draft.id, tx);
        await this.access.recheck(token, tx);
        return errandPublicationPreparationSchema.parse({
          protocol: ERRAND_PUBLICATION_PROTOCOL,
          requestId: body.clientRequestId,
          requestHash: hash,
          draftId: draft.id,
          draftRevision: body.draftRevision,
          reviewDigest,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('interaction', 'owner_after_recovery')
  async publish(token: string, requestId: string, requestHash: string) {
    const body = await this.db.transaction(
      async (tx) => {
        const actor = await this.access.authenticate(token, tx);
        const row = (
          await tx.query<{ command: unknown; request_hash: string }>(
            'SELECT command,request_hash FROM whaleu_errands.media_publication_intents WHERE actor_id=$1 AND request_id=$2',
            [actor.accountId, requestId],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        if (row.request_hash !== requestHash)
          throw new ApplicationError('REQUEST_CONFLICT');
        await this.access.recheck(token, tx);
        return publishErrandV2Schema.parse(row.command);
      },
      { isolationLevel: 'read committed' },
    );
    const { clientRequestId, ...intent } = body;
    return this.requests.execute(
      token,
      clientRequestId,
      'publish',
      intent,
      async (actor, tx) => {
        const draft = await this.currentDraft(
          actor,
          body.draftId,
          body.draftRevision,
          body.targetRegionId,
          tx,
        );
        if (
          draft.publication_request_id !== requestId ||
          draft.publication_request_hash !== requestHash
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        const facts = [...body.publicMedia, ...body.privateMedia];
        await this.media.draftFacts(
          actor,
          draft.id,
          Number(draft.revision),
          draft.authority_version,
          facts,
          tx,
          true,
        );
        const envelope = this.envelope(actor, body, draft.scope),
          approval = await this.reviews.accepted(envelope, tx),
          id = randomUUID();
        const bindings = await this.media.acceptAndBindMany(
          actor,
          draft.id,
          Number(draft.revision),
          id,
          draft.authority_version,
          facts,
          tx,
        );
        await tx.query(
          `INSERT INTO whaleu_errands.media_publications(order_id,draft_id,draft_revision,actor_id,request_id,command_hash) VALUES($1,$2,$3,$4,$5,$6)`,
          [id, draft.id, body.draftRevision, actor, requestId, requestHash],
        );
        const publicMedia = bindings.filter((x) => x.slot.startsWith('public')),
          privateMedia = bindings.filter((x) => x.slot.startsWith('private'));
        await tx.query(
          `INSERT INTO whaleu_errands.media_sets(order_id,revision,cause,public_media,private_media) VALUES($1,1,'publication',$2::jsonb,$3::jsonb)`,
          [id, canonicalJson(publicMedia), canonicalJson(privateMedia)],
        );
        await tx.query(
          'INSERT INTO whaleu_errands.media_heads(order_id,revision) VALUES($1,1)',
          [id],
        );
        const row = await this.records.create(
          actor,
          { ...body, publicAssetIds: [], privateAssetIds: [] },
          draft.scope,
          tx,
          id,
          2,
        );
        await this.reviews.bind(approval, id, errandEnvelope(row), tx);
        const event = await this.records.event(
          row,
          actor,
          'publish',
          null,
          requestId,
          tx,
        );
        await tx.query(
          "UPDATE whaleu_errands.media_drafts SET state='published' WHERE id=$1",
          [draft.id],
        );
        await requireErrandMediaCurrent('draft', draft.id, tx);
        await requireErrandMediaCurrent('order', id, tx);
        return {
          orderId: id,
          revision: row.revision,
          occurredAt: event.occurredAt,
        };
      },
      2,
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  recover(token: string, requestId: string) {
    return this.db.transaction(
      async (tx) => {
        const actor = await this.access.authenticate(token, tx);
        const row = (
          await tx.query<{
            request_hash: string;
            draft_id: string;
            draft_revision: string;
            review_digest: string;
            receipt: unknown;
          }>(
            `SELECT i.*,r.receipt FROM whaleu_errands.media_publication_intents i LEFT JOIN whaleu_errands.requests r ON(r.account_id,r.request_id)=(i.actor_id,i.request_id) WHERE i.actor_id=$1 AND i.request_id=$2`,
            [actor.accountId, requestId],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('REQUEST_NOT_FOUND');
        await this.access.recheck(token, tx);
        const preparation = errandPublicationPreparationSchema.parse({
          protocol: ERRAND_PUBLICATION_PROTOCOL,
          requestId,
          requestHash: row.request_hash,
          draftId: row.draft_id,
          draftRevision: Number(row.draft_revision),
          reviewDigest: row.review_digest,
        });
        return row.receipt
          ? {
              ...preparation,
              state: 'terminal' as const,
              receipt: errandReceiptSchema.parse(row.receipt),
            }
          : { ...preparation, state: 'prepared' as const };
      },
      { isolationLevel: 'read committed' },
    );
  }
  @AccountPolicy('restricted_self_service', 'restricted')
  cancel(token: string, id: string, raw: unknown) {
    const input = cancelErrandDraftSchema.parse(raw);
    return this.db.transaction(
      async (tx) => {
        // Original-owner closure remains possible when publication eligibility or
        // content/image Review has ended. Identity is still current.
        const actor = await this.access.authenticate(token, tx, true);
        await tx.query('SELECT whaleu_errands.lock_media_draft($1,$2)', [
          actor.accountId,
          id,
        ]);
        const observed = (
          await tx.query<DraftRow>(
            'SELECT * FROM whaleu_errands.media_drafts WHERE id=$1',
            [id],
          )
        ).rows[0];
        if (observed && observed.actor_id !== actor.accountId)
          throw new ApplicationError('ERRAND_NOT_FOUND');
        // Match publication's request-before-draft row order. A late publish
        // may settle while this request fence waits; re-read its draft below.
        let known: ReturnType<typeof errandReceiptSchema.parse> | undefined;
        if (input.publication && observed?.state !== 'published') {
          const key = input.publication;
          const receipt = {
            requestId: key.requestId,
            operation: 'publish',
            outcome: 'rejected',
            code: 'ERRAND_STATE_CONFLICT',
          };
          await tx.query(
            `INSERT INTO whaleu_errands.requests(account_id,request_id,operation,intent_hash,receipt) VALUES($1,$2,'publish',$3,$4::jsonb) ON CONFLICT DO NOTHING`,
            [
              actor.accountId,
              key.requestId,
              key.requestHash,
              JSON.stringify(receipt),
            ],
          );
          const request = (
            await tx.query<{
              intent_hash: string;
              operation: string;
              receipt: unknown;
            }>(
              'SELECT intent_hash,operation,receipt FROM whaleu_errands.requests WHERE account_id=$1 AND request_id=$2 FOR UPDATE',
              [actor.accountId, key.requestId],
            )
          ).rows[0];
          if (
            !request ||
            request.intent_hash !== key.requestHash ||
            request.operation !== 'publish'
          )
            throw new ApplicationError('REQUEST_CONFLICT');
          known = errandReceiptSchema.parse(request.receipt);
        }
        const row = (
          await tx.query<DraftRow>(
            'SELECT * FROM whaleu_errands.media_drafts WHERE id=$1 AND actor_id=$2 FOR UPDATE NOWAIT',
            [id, actor.accountId],
          )
        ).rows[0];
        if (input.expectedRevision !== Number(row?.revision ?? 1))
          throw new ApplicationError('ERRAND_REVISION_CONFLICT');
        if (row?.state === 'published') {
          await requireErrandMediaCurrent('draft', id, tx);
          await this.access.recheck(token, tx);
          return this.project(row);
        }
        if (known?.outcome === 'applied')
          throw new ApplicationError('ERRAND_STATE_CONFLICT');
        if (!row) {
          const cancellation = (
            await tx.query<{
              publication_request_id: string | null;
              publication_request_hash: string | null;
            }>(
              'SELECT publication_request_id,publication_request_hash FROM whaleu_errands.media_draft_cancellations WHERE actor_id=$1 AND draft_id=$2',
              [actor.accountId, id],
            )
          ).rows[0];
          const requestId = input.publication?.requestId ?? null,
            requestHash = input.publication?.requestHash ?? null;
          if (
            cancellation &&
            (cancellation.publication_request_id !== requestId ||
              cancellation.publication_request_hash !== requestHash)
          )
            throw new ApplicationError('REQUEST_CONFLICT');
          if (!cancellation)
            await tx.query(
              'INSERT INTO whaleu_errands.media_draft_cancellations(actor_id,draft_id,publication_request_id,publication_request_hash) VALUES($1,$2,$3,$4)',
              [actor.accountId, id, requestId, requestHash],
            );
          await requireErrandMediaCurrent('draft', id, tx);
          await this.access.recheck(token, tx);
          return {
            protocol: ERRAND_PUBLICATION_PROTOCOL,
            draftId: id,
            revision: 1 as const,
            state: 'cancelled_before_create' as const,
          };
        }
        if (
          row.publication_request_id !== null &&
          (!input.publication ||
            input.publication.requestId !== row.publication_request_id ||
            input.publication.requestHash !== row.publication_request_hash)
        )
          throw new ApplicationError('REQUEST_CONFLICT');
        if (row.state === 'open')
          await tx.query(
            "UPDATE whaleu_errands.media_drafts SET state='cancelled' WHERE id=$1",
            [id],
          );
        // The durable owner fence precedes freeing any outstanding Media request.
        const intents = (
          await tx.query<{ id: string }>(
            `SELECT i.id FROM whaleu_media.upload_intents i JOIN whaleu_media.errand_scopes s ON s.id=i.resource_id WHERE s.draft_id=$1 AND s.actor_id=$2 AND NOT EXISTS(SELECT 1 FROM whaleu_media.assets a JOIN whaleu_media.bindings b ON b.asset_id=a.id WHERE a.intent_id=i.id) ORDER BY i.id`,
            [id, actor.accountId],
          )
        ).rows;
        for (const intent of intents)
          await this.media.lifecycle.cancel(actor.accountId, intent.id, tx);
        if (intents.length) await this.media.retainCurrent(tx);
        await requireErrandMediaCurrent('draft', id, tx);
        await this.access.recheck(token, tx);
        return this.project({ ...row, state: 'cancelled' });
      },
      { isolationLevel: 'read committed' },
    );
  }
  /** Called only by trusted audit integration, never installed as an HTTP route.
   * A captured set can only lose exact appearances. New Review is required to
   * reveal survivors; absent Review intentionally closes the new whole set. */
  async subtractAudited(
    input: {
      orderId: string;
      expectedRevision: number;
      removed: ErrandImageBinding[];
      issuer: string;
      provenanceRef: string;
    },
    tx: PoolClient,
  ) {
    const row = await this.records.read(input.orderId, tx, true);
    if (
      !row ||
      row.deleted_at ||
      !row.media ||
      row.media.revision !== input.expectedRevision
    )
      throw new ApplicationError('ERRAND_REVISION_CONFLICT');
    const removed = errandImageBindingSchema
        .array()
        .min(1)
        .max(6)
        .parse(input.removed),
      all = [...row.media.publicMedia, ...row.media.privateMedia];
    if (
      new Set(removed.map((x) => x.bindingId)).size !== removed.length ||
      removed.some((x) => !all.some((y) => canonicalEqual(x, y)))
    )
      throw new ApplicationError('ERRAND_REVISION_CONFLICT');
    const next = all.filter(
        (x) => !removed.some((y) => y.bindingId === x.bindingId),
      ),
      revision = row.media.revision + 1;
    await tx.query(
      `INSERT INTO whaleu_errands.media_audits(id,order_id,expected_revision,next_revision,removed,issuer,provenance_ref) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [
        randomUUID(),
        row.id,
        row.media.revision,
        revision,
        canonicalJson(removed),
        input.issuer,
        input.provenanceRef,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_errands.media_sets(order_id,revision,prior_revision,cause,public_media,private_media) VALUES($1,$2,$3,'audit_subtraction',$4::jsonb,$5::jsonb)`,
      [
        row.id,
        revision,
        row.media.revision,
        canonicalJson(next.filter((x) => x.slot.startsWith('public'))),
        canonicalJson(next.filter((x) => x.slot.startsWith('private'))),
      ],
    );
    await tx.query(
      'UPDATE whaleu_errands.media_heads SET revision=$2 WHERE order_id=$1',
      [row.id, revision],
    );
    await this.media.retireMany(row.id, removed, tx);
    await requireErrandMediaCurrent('order', row.id, tx);
    return errandEnvelope({
      ...row,
      media: {
        ...row.media,
        revision,
        publicMedia: next.filter((x) => x.slot.startsWith('public')),
        privateMedia: next.filter((x) => x.slot.startsWith('private')),
      },
    });
  }
  async retireDeleted(id: string, tx: PoolClient) {
    const installed = (
      await tx.query<{ installed: boolean }>(
        "SELECT to_regclass('whaleu_media.errand_appearances') IS NOT NULL installed",
      )
    ).rows[0]?.installed;
    if (!installed) return;
    const rows = (
      await tx.query<{
        slot: string;
        assetId: string;
        manifestDigest: string;
        bindingId: string;
      }>(
        `SELECT slot,asset_id "assetId",manifest_digest "manifestDigest",binding_id "bindingId" FROM whaleu_media.errand_appearances WHERE order_id=$1 ORDER BY slot`,
        [id],
      )
    ).rows;
    if (rows.length)
      await this.media.retireMany(
        id,
        rows.map((x) => errandImageBindingSchema.parse(x)),
        tx,
      );
  }
}
