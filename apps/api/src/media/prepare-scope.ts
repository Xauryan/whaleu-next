import {
  ratingsDiscussionMemberPrepareSchema,
  ratingsDiscussionBatchIdentitySchema,
  ratingsDiscussionBatchHash,
} from './contracts-ratings-discussion.js';
import type {
  RatingsDiscussionMemberPrepare,
  RatingsDiscussionBatchIdentity,
} from './contracts-ratings-discussion.js';
import type {
  AuthorizedRatingsDiscussionDraft,
  AuthorizedRatingsDiscussionBatch,
  RatingsDiscussionMediaDraftOwnerPort,
} from './ratings-discussion-prepare-scope.js';
import { prepareRatingsMediaSchema } from './contracts-ratings.js';
import type { PrepareRatingsMediaInput } from './contracts-ratings.js';
import type {
  AuthorizedRatingsMediaEdit,
  RatingsMediaDraftOwnerPort,
} from './ratings-prepare-scope.js';
import { prepareProfileMediaSchema } from './contracts-profile.js';
import type { PrepareProfileMediaInput } from './contracts-profile.js';
import type {
  AuthorizedProfileMediaEdit,
  ProfileMediaDraftOwnerPort,
} from './profile-prepare-scope.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaIdSchema, prepareMediaSchema } from './contracts.js';
import type { z } from 'zod';
import { prepareMediaV2Schema } from './contracts-v2.js';
import type { PrepareMediaV2Input } from './contracts-v2.js';
import { prepareMediaV3Schema } from './contracts-v3.js';
import type { PrepareMediaV3Input } from './contracts-v3.js';
import { prepareMediaV4Schema } from './contracts-v4.js';
import type {
  PrepareMediaV4Input,
  MediaBatchIdentity as DiscussionMediaBatchIdentity,
} from './contracts-v4.js';

export type PrepareMediaInput = z.infer<typeof prepareMediaSchema>;
export interface AuthorizedMediaDraft {
  readonly actorAccountId: string;
  /** Owner-generated durable identity; the client draftId is only a lookup intent. */
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly ownerKind: 'community';
  readonly resourceKind: 'post' | 'comment' | 'reply';
  readonly targetKind: 'draft';
  readonly contentVersion: 1;
  readonly audience: 'content-gated';
  readonly purpose:
    | 'community-post-image'
    | 'community-comment-image'
    | 'community-reply-image';
  readonly slot: 'images';
  readonly ordinal: number;
}
export interface MediaDraftOwnerPort {
  /** Metadata-only historical identity. No current content/read permission. */
  resolvedDiscussionPostId?(
    actor: string,
    scopeId: string,
    revision: string,
    identity: DiscussionMediaBatchIdentity,
    tx: PoolClient,
  ): Promise<string>;
  /** Resolve a durable owner scope under current Identity/Safety/publication
   * authority. Enroll that owner's mandatory proof. No remote effects here. */
  authorizePrepare(
    actorAccountId: string,
    input:
      | PrepareMediaInput
      | PrepareMediaV2Input
      | PrepareMediaV3Input
      | PrepareMediaV4Input,
    tx: PoolClient,
  ): Promise<AuthorizedMediaDraft>;
}
const brand: unique symbol = Symbol('media-prepare-scope');
export interface MediaPrepareScope {
  readonly [brand]: true;
}
/** No HTTP request can construct this capability. There is intentionally no
 * normal AppModule owner implementation or synthetic environment switch. */
export class MediaPrepareScopes {
  private readonly issued = new WeakMap<
    MediaPrepareScope,
    {
      tx: PoolClient;
      epoch: object;
      input:
        | PrepareMediaInput
        | PrepareMediaV2Input
        | PrepareMediaV3Input
        | PrepareMediaV4Input
        | PrepareProfileMediaInput
        | PrepareRatingsMediaInput
        | RatingsDiscussionMemberPrepare;
      scope:
        | AuthorizedMediaDraft
        | AuthorizedProfileMediaEdit
        | AuthorizedRatingsMediaEdit
        | AuthorizedRatingsDiscussionDraft;
    }
  >();
  constructor(
    private readonly owner: MediaDraftOwnerPort,
    private readonly profileOwner?: ProfileMediaDraftOwnerPort,
    private readonly ratingsOwner?: RatingsMediaDraftOwnerPort,
    private readonly ratingsDiscussionOwner?: RatingsDiscussionMediaDraftOwnerPort,
  ) {}
  async authorizeRatingsDiscussionBatch(
    actor: string,
    raw: RatingsDiscussionBatchIdentity,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsDiscussionBatch> {
    const identity = ratingsDiscussionBatchIdentitySchema.parse(raw),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.ratingsDiscussionOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.ratingsDiscussionOwner.authorizeBatch(
      mediaIdSchema.parse(actor),
      identity,
      tx,
    );
    this.checkRatingsDiscussionScope(actor, identity, scope, tx, epoch);
    return Object.freeze({ ...scope, batchIdentity: identity });
  }
  async authorizeRatingsDiscussion(
    actor: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = ratingsDiscussionMemberPrepareSchema.parse(raw),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.ratingsDiscussionOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.ratingsDiscussionOwner.authorizePrepare(
      mediaIdSchema.parse(actor),
      input,
      tx,
    );
    const identity = ratingsDiscussionBatchIdentitySchema.parse(
      scope.batchIdentity,
    );
    this.checkRatingsDiscussionScope(actor, identity, scope, tx, epoch);
    if (
      scope.ordinal !== input.sourceSlot ||
      ratingsDiscussionBatchHash(actor, identity) !== input.batchIdentityHash
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    Object.freeze(input.declaration);
    Object.freeze(input);
    const capability: MediaPrepareScope = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(capability, {
      tx,
      epoch,
      input,
      scope: Object.freeze({ ...scope, batchIdentity: identity }),
    });
    return capability;
  }
  private checkRatingsDiscussionScope(
    actor: string,
    identity: RatingsDiscussionBatchIdentity,
    scope: AuthorizedRatingsDiscussionBatch,
    tx: PoolClient,
    epoch: object,
  ): void {
    const reply = identity.target.kind === 'reply';
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'ratings' ||
      scope.resourceKind !== (reply ? 'rating_reply' : 'rating_comment') ||
      scope.purpose !==
        (reply ? 'ratings-reply-image' : 'ratings-comment-image') ||
      scope.targetKind !== 'draft' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'content-gated' ||
      scope.slot !== 'images' ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(scope.scopeRevision) ||
      !Number.isSafeInteger(scope.expiresAt) ||
      ratingsDiscussionBatchHash(actor, scope.batchIdentity) !==
        ratingsDiscussionBatchHash(actor, identity) ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(tx, scope.expiresAt, 'MEDIA_UNAVAILABLE');
  }
  async authorizeRatings(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareRatingsMediaSchema.parse(raw);
    const actor = mediaIdSchema.parse(actorAccountId);
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !this.ratingsOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.ratingsOwner.authorizePrepare(actor, input, tx);
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'ratings' ||
      scope.resourceKind !== 'target_cover' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'content-gated' ||
      scope.purpose !== 'ratings-target-cover-image' ||
      scope.slot !== 'cover' ||
      scope.ordinal !== 0 ||
      scope.scopeRevision !== input.scopeRevision ||
      scope.serverScopeId !== input.editScopeId ||
      !Number.isSafeInteger(scope.expiresAt) ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(tx, scope.expiresAt, 'MEDIA_UNAVAILABLE');
    Object.freeze(input.declaration);
    Object.freeze(input);
    const capability: MediaPrepareScope = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(capability, {
      tx,
      epoch,
      input,
      scope: Object.freeze({ ...scope }),
    });
    return capability;
  }
  async authorizeProfile(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareProfileMediaSchema.parse(raw);
    const actor = mediaIdSchema.parse(actorAccountId);
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !this.profileOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.profileOwner.authorizePrepare(actor, input, tx);
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'profile' ||
      scope.resourceKind !== 'avatar' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'profile-public' ||
      scope.purpose !== 'profile-avatar-image' ||
      scope.slot !== 'avatar' ||
      scope.ordinal !== 0 ||
      scope.scopeRevision !== String(input.expectedRevision) ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      !Number.isSafeInteger(scope.expiresAt) ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    registerTransactionDeadline(tx, scope.expiresAt, 'MEDIA_UNAVAILABLE');
    Object.freeze(input.declaration);
    Object.freeze(input);
    const capability: MediaPrepareScope = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(capability, {
      tx,
      epoch,
      input,
      scope: Object.freeze({ ...scope }),
    });
    return capability;
  }
  async resolvedDiscussionPostId(
    actor: string,
    scopeId: string,
    revision: string,
    identity: DiscussionMediaBatchIdentity,
    tx: PoolClient,
  ): Promise<string> {
    if (!transactionReadEpoch(tx) || !this.owner.resolvedDiscussionPostId)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return mediaIdSchema.parse(
      await this.owner.resolvedDiscussionPostId(
        actor,
        scopeId,
        revision,
        identity,
        tx,
      ),
    );
  }
  async authorize(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return this.issue(actorAccountId, prepareMediaSchema.parse(raw), tx);
  }
  async authorizeV2(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return this.issue(actorAccountId, prepareMediaV2Schema.parse(raw), tx);
  }
  async authorizeV3(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return this.issue(actorAccountId, prepareMediaV3Schema.parse(raw), tx);
  }
  async authorizeV4(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return this.issue(actorAccountId, prepareMediaV4Schema.parse(raw), tx);
  }
  async authorizeBatch(
    actorAccountId: string,
    input: PrepareMediaV3Input | PrepareMediaV4Input,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return input.protocolVersion === 4
      ? this.authorizeV4(actorAccountId, input, tx)
      : this.authorizeV3(actorAccountId, input, tx);
  }
  private async issue(
    actorAccountId: string,
    input:
      | PrepareMediaInput
      | PrepareMediaV2Input
      | PrepareMediaV3Input
      | PrepareMediaV4Input,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const actor = mediaIdSchema.parse(actorAccountId);
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.owner.authorizePrepare(actor, input, tx);
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'community' ||
      scope.resourceKind !==
        ('protocolVersion' in input && input.protocolVersion === 4
          ? input.batchIdentity.target.kind
          : 'post') ||
      scope.targetKind !== 'draft' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'content-gated' ||
      scope.purpose !== input.purpose ||
      scope.slot !== input.slot ||
      scope.ordinal !== input.ordinal ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(scope.scopeRevision) ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const capability: MediaPrepareScope = Object.freeze({
      [brand]: true as const,
    });
    if ('protocolVersion' in input) {
      if (input.protocolVersion === 4)
        Object.freeze(input.batchIdentity.target);
      Object.freeze(input.batchIdentity);
    }
    Object.freeze(input.declaration);
    Object.freeze(input);
    this.issued.set(capability, {
      tx,
      epoch,
      input,
      scope: Object.freeze({ ...scope }),
    });
    return capability;
  }
  require(
    capability: MediaPrepareScope,
    tx: PoolClient,
  ): {
    input:
      | PrepareMediaInput
      | PrepareMediaV2Input
      | PrepareMediaV3Input
      | PrepareMediaV4Input
      | PrepareProfileMediaInput
      | PrepareRatingsMediaInput
      | RatingsDiscussionMemberPrepare;
    scope:
      | AuthorizedMediaDraft
      | AuthorizedProfileMediaEdit
      | AuthorizedRatingsMediaEdit
      | AuthorizedRatingsDiscussionDraft;
  } {
    const issued = this.issued.get(capability);
    if (
      !issued ||
      issued.tx !== tx ||
      issued.epoch !== transactionReadEpoch(tx)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return issued;
  }
}
