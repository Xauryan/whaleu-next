import { retainRatingReadBytes } from './target-cover-current.js';
import { withRatingsMediaMutation } from '../media/ratings-discussion-mutation-proof.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../database/database.js';
import { ownerFingerprint } from '../database/required-owner-proof.js';
import type { IdentityService } from '../identity/identity.service.js';
import {
  authenticateMediaSession,
  type CurrentMediaSession,
} from '../identity/current-media-session.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ApplicationError } from '../http/application-error.js';
import { canonicalEqual } from '../community/content-review/contracts.js';
import { canonicalRatingDiscussionMediaEnvelope } from '../community/content-review/rating-discussion-media-contracts.js';
import {
  MediaRatingsDiscussionPrepareScopes,
  type AuthorizedRatingsDiscussionBatch,
} from '../media/ratings-discussion-prepare-scope.js';
import { MediaIntentRepository } from '../media/intent-repository.js';
import { MediaLifecycleRepository } from '../media/lifecycle-repository.js';
import { MediaIngressRepository } from '../media/ingress-repository.js';
import { RatingsDiscussionMediaRecoveryRepository } from '../media/ratings-discussion-recovery-repository.js';
import { RatingsDiscussionMediaBatchRepository } from '../media/ratings-discussion-batch-repository.js';
import {
  RatingsDiscussionMediaAssetRepository,
  type RatingsDiscussionSetSelection,
} from '../media/ratings-discussion-asset-repository.js';
import {
  RatingsDiscussionMediaProofRegistry,
  type RatingsDiscussionMediaReadRequest,
  type AuthorizedRatingsDiscussionMediaRead,
} from '../media/ratings-discussion-owner-proof.js';
import { RatingsDiscussionMediaDeliveryService } from '../media/ratings-discussion-delivery.js';
import type { RatingsDiscussionMediaRuntime } from '../media/application-ratings-discussion.js';
import type { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import {
  ratingsDiscussionBatchIdentitySchema,
  ratingsDiscussionBatchHash,
  ratingsDiscussionMemberHash,
  type RatingsDiscussionBatchIdentity,
  type RatingsDiscussionMemberPrepare,
} from '../media/contracts-ratings-discussion.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import type { RatingsAccessService } from './access.js';
import type {
  RatingScopedContextService,
  ResolvedRatingScope,
} from './scoped/context.service.js';
import type { RatingScopedRepository } from './scoped/repository.js';
import type { RatingsRepository } from './repository.js';
import type { RatingDiscussionRepository } from './discussion-repository.js';
import type { RatingDiscussionProjection } from './discussion-projection.js';
import type { RatingDiscussionMediaIntent } from './scoped/discussion-media-contracts.js';
import {
  currentRatingDiscussionDescriptors,
  discussionMediaParent,
} from './discussion-media-current.js';
import { assertRatingCommandClaim } from './management/requests.js';
export const RATINGS_DISCUSSION_MEDIA_RUNTIME = Symbol(
  'RATINGS_DISCUSSION_MEDIA_RUNTIME',
);
function draftId(actor: string, request: string): string {
  const bytes = createHash('sha256')
    .update(`whaleu:rating-discussion-draft:v1\n${actor}\n${request}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Original Ratings owners authorize transport. Publication remains exclusively
 * in RatingScopedCommands and its shared request/receipt/Review transaction. */
export class RatingDiscussionMediaService {
  private readonly credentials = new WeakMap<
    PoolClient,
    { token: string; session: CurrentMediaSession }
  >();
  readonly scopes: MediaRatingsDiscussionPrepareScopes;
  readonly intents: MediaIntentRepository;
  readonly lifecycle = new MediaLifecycleRepository();
  readonly assets: RatingsDiscussionMediaAssetRepository;
  readonly registry: RatingsDiscussionMediaProofRegistry;
  readonly recovery: RatingsDiscussionMediaRecoveryRepository;
  readonly batches: RatingsDiscussionMediaBatchRepository;
  readonly ingress: MediaIngressRepository | null;
  readonly delivery: RatingsDiscussionMediaDeliveryService | null;
  constructor(
    readonly database: DatabaseService,
    readonly identity: IdentityService,
    readonly access: RatingsAccessService,
    readonly contexts: RatingScopedContextService,
    readonly scoped: RatingScopedRepository,
    readonly records: RatingsRepository,
    readonly replies: RatingDiscussionRepository,
    readonly discussion: RatingDiscussionProjection,
    readonly runtime: RatingsDiscussionMediaRuntime | null,
    budget: MediaDeliveryBudgetPool,
  ) {
    this.scopes = new MediaRatingsDiscussionPrepareScopes({
      authorizeBatch: (actor, input, tx) =>
        this.authorizeBatch(actor, input, tx),
      authorizePrepare: (actor, input, tx) =>
        this.authorizePrepare(actor, input, tx),
    });
    this.intents = new MediaIntentRepository(this.scopes);
    this.registry = new RatingsDiscussionMediaProofRegistry({
      authorizeCurrent: (token, request, tx) =>
        this.authorizeCurrent(token, request, tx),
    });
    this.assets = new RatingsDiscussionMediaAssetRepository(
      this.registry,
      retainRatingReadBytes,
    );
    this.recovery = new RatingsDiscussionMediaRecoveryRepository(
      this.lifecycle,
      this.assets,
    );
    this.batches = new RatingsDiscussionMediaBatchRepository(
      this.scopes,
      this.intents,
      this.assets,
      this.lifecycle,
    );
    this.ingress = runtime
      ? new MediaIngressRepository(runtime.planning, 7)
      : null;
    this.delivery = runtime
      ? new RatingsDiscussionMediaDeliveryService(
          database,
          {
            authorize: async (
              token,
              request,
              bindingId,
              ordinal,
              variant,
              tx,
            ) =>
              this.assets.discussionDeliveryPlan(
                await this.registry.authorize(token, request, tx),
                request,
                bindingId,
                ordinal,
                variant,
                tx,
              ),
          },
          runtime.storage,
          budget,
        )
      : null;
  }
  authorized<T>(
    token: string,
    run: (session: CurrentMediaSession, tx: PoolClient) => Promise<T>,
    write = true,
  ): Promise<T> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, write);
        const session = await authenticateMediaSession(
          this.identity,
          token,
          tx,
        );
        this.credentials.set(tx, { token, session });
        try {
          const work = async () => {
            const result = await run(session, tx);
            await this.access.recheck(token, tx);
            return result;
          };
          return write
            ? await withRatingsMediaMutation(tx, work)
            : await work();
        } finally {
          this.credentials.delete(tx);
        }
      },
      { isolationLevel: 'read committed' },
    );
  }
  private async reserve(
    actor: string,
    request: string,
    operation: string,
    hash: string,
    tx: PoolClient,
  ) {
    await assertRatingCommandClaim(actor, request, operation, hash, tx);
    await tx.query(
      'INSERT INTO whaleu_ratings.command_claims(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [actor, request, operation, hash],
    );
    await assertRatingCommandClaim(actor, request, operation, hash, tx);
  }
  async reserveBatchRequest(
    actor: string,
    requestId: string,
    identityHash: string,
    tx: PoolClient,
  ): Promise<void> {
    const credential = this.credentials.get(tx);
    if (!credential || credential.session.accountId !== actor)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.reserve(
      actor,
      requestId,
      'prepare_discussion_media_batch',
      identityHash,
      tx,
    );
  }
  async reserveMemberRequest(
    actor: string,
    requestId: string,
    requestHash: string,
    tx: PoolClient,
  ): Promise<void> {
    const credential = this.credentials.get(tx);
    if (!credential || credential.session.accountId !== actor)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    await this.reserve(
      actor,
      requestId,
      'prepare_discussion_media_member',
      requestHash,
      tx,
    );
  }
  private async validateDraft(
    scope: ResolvedRatingScope,
    identity: RatingsDiscussionBatchIdentity,
    tx: PoolClient,
  ) {
    if (
      scope.context.protocolVersion !== 4 ||
      scope.context.purpose !== 'interact' ||
      !canonicalEqual(identity.context, {
        id: scope.context.id,
        token: scope.context.token,
        tokenDigest: scope.context.tokenDigest,
        selector: scope.context.selector,
        scopeRevision: scope.scopeRevision,
        protocolGeneration: scope.protocolGeneration,
        catalogRevision: scope.catalogRevision,
        headRevision: scope.headRevision,
        sourceDigest: scope.sourceDigest,
        discussionMedia: scope.context.discussionMedia,
      })
    )
      throw new ApplicationError('RATING_SCOPED_CONTEXT_CHANGED');
    const category = await this.scoped.category(
      scope,
      identity.categoryId,
      tx,
      true,
    );
    const target = await this.scoped.target(
      scope,
      identity.target.targetId,
      tx,
      true,
    );
    if (
      category.kind !== 'general' ||
      category.revision !== identity.expectedCategoryRevision ||
      target.category.id !== category.id ||
      target.row.revision !== identity.target.expectedTargetRevision ||
      target.row.definition.definitionRevision !==
        identity.target.expectedDefinitionRevision ||
      target.row.definition.contentVersion !==
        identity.target.expectedContentVersion
    )
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    if (identity.target.kind === 'reply') {
      const root = await this.records.comment(
        identity.target.rootId,
        identity.target.targetId,
        tx,
        true,
      );
      if (
        root.revision !== identity.target.expectedRootRevision ||
        !(await this.discussion.content(
          root,
          'comment',
          scope.actor,
          'rating_direct',
          tx,
        )) ||
        !(await this.discussion.canReply(root, scope.actor, tx))
      )
        throw new ApplicationError('RATING_NOT_FOUND');
      if (identity.target.replyTo) {
        const quote = await this.replies.reply(
          identity.target.replyTo.replyId,
          root.id,
          target.row.id,
          tx,
          true,
        );
        if (
          quote.revision !== identity.target.replyTo.expectedRevision ||
          !(await this.discussion.content(
            quote,
            'reply',
            scope.actor,
            'rating_direct',
            tx,
          ))
        )
          throw new ApplicationError('RATING_NOT_FOUND');
      }
    }
  }
  async authorizeBatch(
    actor: string,
    raw: RatingsDiscussionBatchIdentity,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsDiscussionBatch> {
    const identity = ratingsDiscussionBatchIdentitySchema.parse(raw),
      credential = this.credentials.get(tx);
    if (!credential || credential.session.accountId !== actor)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.contexts.resolve(
      credential.token,
      { contextId: identity.context.id, contextToken: identity.context.token },
      tx,
      { purpose: 'interact', write: true, protocolVersion: 4 },
    );
    await this.validateDraft(scope, identity, tx);
    const hash = ratingsDiscussionBatchHash(actor, identity);
    await this.reserve(
      actor,
      identity.batchRequestId,
      'prepare_discussion_media_batch',
      hash,
      tx,
    );
    await this.scoped.retainAfter(scope, tx);
    // Reserve commandRequestId only for publication, whose final exact hash does
    // not exist until sealing. SQL excludes every batch/member request key.
    const expiresAt = Math.min(
      Date.parse(scope.context.expiresAt),
      Date.parse(identity.context.discussionMedia.validUntil),
    );
    registerTransactionDeadline(tx, expiresAt, 'MEDIA_NOT_READY');
    return {
      actorAccountId: actor,
      serverScopeId: draftId(actor, identity.batchRequestId),
      scopeRevision: hash,
      expiresAt,
      batchIdentity: identity,
      ownerKind: 'ratings',
      resourceKind:
        identity.target.kind === 'root' ? 'rating_comment' : 'rating_reply',
      targetKind: 'draft',
      contentVersion: 1,
      audience: 'content-gated',
      purpose:
        identity.target.kind === 'root'
          ? 'ratings-comment-image'
          : 'ratings-reply-image',
      slot: 'images',
    };
  }
  async authorizePrepare(
    actor: string,
    input: RatingsDiscussionMemberPrepare,
    tx: PoolClient,
  ) {
    const identity = await this.batches.identity(actor, input.batchId, tx);
    if (
      input.batchIdentityHash !== ratingsDiscussionBatchHash(actor, identity) ||
      input.clientRequestId === identity.batchRequestId ||
      input.clientRequestId === identity.commandRequestId
    )
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    const scope = await this.authorizeBatch(actor, identity, tx);
    await this.reserve(
      actor,
      input.clientRequestId,
      'prepare_discussion_media_member',
      ratingsDiscussionMemberHash(actor, input),
      tx,
    );
    return { ...scope, ordinal: input.sourceSlot };
  }
  async selection(
    scope: ResolvedRatingScope,
    intent: RatingDiscussionMediaIntent,
    tx: PoolClient,
  ): Promise<RatingsDiscussionSetSelection> {
    if (
      !intent.payload.batchId ||
      !intent.payload.batchRequestId ||
      !intent.payload.sealedPlanDigest ||
      !intent.payload.images.length
    )
      throw new ApplicationError('MEDIA_NOT_READY');
    const identity = await this.batches.identity(
      scope.actor,
      intent.payload.batchId,
      tx,
    );
    const expected = {
      protocol: 'ratings-discussion-media-v1',
      batchRequestId: intent.payload.batchRequestId,
      commandRequestId: intent.payload.clientRequestId,
      draftRevision: intent.payload.draftRevision,
      categoryId: intent.payload.categoryId,
      expectedCategoryRevision: intent.payload.expectedCategoryRevision,
      context: intent.context,
      target: {
        kind: intent.operation === 'create_comment_scoped' ? 'root' : 'reply',
        targetId: intent.payload.targetId,
        expectedTargetRevision: intent.payload.expectedTargetRevision,
        expectedDefinitionRevision: intent.payload.expectedDefinitionRevision,
        expectedContentVersion: intent.payload.expectedContentVersion,
        ...(intent.operation === 'create_reply_scoped'
          ? {
              rootId: intent.payload.rootId,
              expectedRootRevision: intent.payload.expectedRootRevision,
              replyTo: intent.payload.replyTo,
            }
          : {}),
      },
    };
    if (!canonicalEqual(identity, expected))
      throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    await this.validateDraft(scope, identity, tx);
    return {
      actor: scope.actor,
      batchId: intent.payload.batchId,
      batchIdentityHash: ratingsDiscussionBatchHash(scope.actor, identity),
      sealedPlanDigest: intent.payload.sealedPlanDigest,
      images: intent.payload.images,
    };
  }
  async authorizeCurrent(
    token: string,
    request: RatingsDiscussionMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsDiscussionMediaRead> {
    await lockSafetyPolicy(tx);
    const session = await authenticateMediaSession(this.identity, token, tx);
    const scope = await this.contexts.resolve(
      token,
      { contextId: request.contextId, contextToken: request.contextToken },
      tx,
      { purpose: 'read', protocolVersion: 4 },
    );
    const target = await this.scoped.target(scope, request.targetId, tx);
    const root = await this.records.comment(request.rootId, target.row.id, tx);
    if (
      !(await this.discussion.content(
        root,
        'comment',
        scope.actor,
        'rating_direct',
        tx,
      ))
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const subject = request.replyId
      ? await this.replies.reply(request.replyId, root.id, target.row.id, tx)
      : root;
    if (
      request.replyId &&
      !(await this.discussion.content(
        subject,
        'reply',
        scope.actor,
        'rating_direct',
        tx,
      ))
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    const envelope = canonicalRatingDiscussionMediaEnvelope(subject.envelope);
    if (
      envelope.subjectRevision !== request.subjectRevision ||
      envelope.attachmentSetDigest !== request.attachmentSetDigest ||
      !envelope.images.length
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const descriptors = currentRatingDiscussionDescriptors(
      envelope,
      scope.actor,
      tx,
    );
    await this.scoped.retainAfter(scope, tx);
    await this.access.recheck(token, tx);
    return {
      principal: {
        kind: 'authenticatedRatings',
        accountId: session.accountId,
        sessionId: session.sessionId,
      },
      actorAccountId: subject.account_id,
      parent: discussionMediaParent(envelope),
      subjectRevision: subject.revision,
      attachmentSetDigest: envelope.attachmentSetDigest,
      images: envelope.images.map((image, index) => ({
        assetId: image.assetId,
        manifestDigest: image.manifestDigest,
        bindingId: descriptors[index]!.bindingId,
        ordinal: index,
      })),
      ownerRevision: ownerFingerprint({
        target: target.row.revision,
        definition: target.row.definition,
        root: root.revision,
        subject: subject.revision,
        scope: scope.scopeRevision,
      }),
      reviewRevision: ownerFingerprint(envelope),
    };
  }
  /** Bounded resumable logical detach. Physical storage deletion remains in the
   * existing Media lifecycle and cannot be declared complete by this cursor. */
  cleanupOne(): Promise<boolean> {
    return this.database.transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        const job = (
          await tx.query<{
            owner_kind: string;
            owner_id: string;
            after_kind: string | null;
            after_id: string | null;
          }>(
            "SELECT owner_kind,owner_id,after_kind,after_id FROM whaleu_ratings.discussion_media_cleanup WHERE phase='pending' ORDER BY created_at,owner_kind,owner_id LIMIT 1 FOR UPDATE SKIP LOCKED",
          )
        ).rows[0];
        if (!job) return false;
        const rows = (
          await tx.query<{
            resource_kind: 'rating_comment' | 'rating_reply';
            resource_id: string;
            target_id: string;
            root_id: string;
          }>(
            'SELECT * FROM whaleu_ratings.discussion_media_cleanup_page($1,$2,$3,$4,16)',
            [job.owner_kind, job.owner_id, job.after_kind, job.after_id],
          )
        ).rows;
        for (const row of rows)
          await tx.query(
            'INSERT INTO whaleu_ratings.discussion_media_tombstones(resource_kind,resource_id,target_id,root_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [row.resource_kind, row.resource_id, row.target_id, row.root_id],
          );
        if (rows.length)
          await this.assets.detachOwnedParents(
            rows.map((row) =>
              row.resource_kind === 'rating_comment'
                ? {
                    ownerKind: 'ratings',
                    resourceKind: 'rating_comment',
                    resourceId: row.resource_id,
                    targetId: row.target_id,
                    contentVersion: 1,
                  }
                : {
                    ownerKind: 'ratings',
                    resourceKind: 'rating_reply',
                    resourceId: row.resource_id,
                    targetId: row.target_id,
                    rootId: row.root_id,
                    contentVersion: 1,
                  },
            ),
            tx,
          );
        const last = rows.at(-1),
          done = rows.length < 16;
        await tx.query(
          "UPDATE whaleu_ratings.discussion_media_cleanup SET after_kind=coalesce($3,after_kind),after_id=coalesce($4,after_id),phase=CASE WHEN $5 THEN 'complete' ELSE 'pending' END,completed_at=CASE WHEN $5 THEN clock_timestamp() ELSE NULL END WHERE owner_kind=$1 AND owner_id=$2",
          [
            job.owner_kind,
            job.owner_id,
            last?.resource_kind ?? null,
            last?.resource_id ?? null,
            done,
          ],
        );
        return true;
      },
      { isolationLevel: 'read committed' },
    );
  }
}
