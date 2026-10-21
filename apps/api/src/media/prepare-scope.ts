import { prepareProfileCoverMediaSchema } from './contracts-profile-cover.js';
import type { PrepareProfileCoverMediaInput } from './contracts-profile-cover.js';
import type {
  AuthorizedProfileCoverMediaEdit,
  ProfileCoverMediaDraftOwnerPort,
} from './profile-cover-prepare-scope.js';
import {
  prepareMajorDiscussionMediaSchema,
  majorDiscussionMediaRequestHash,
} from './contracts-major-discussion.js';
import type { PrepareMajorDiscussionMediaInput } from './contracts-major-discussion.js';
import type {
  AuthorizedMajorDiscussionMediaEdit,
  MajorDiscussionMediaDraftOwnerPort,
} from './major-discussion-prepare-scope.js';
import {
  prepareWindowDiscussionMediaSchema,
  windowDiscussionMediaRequestHash,
} from './contracts-window-discussion.js';
import type { PrepareWindowDiscussionMediaInput } from './contracts-window-discussion.js';
import type {
  AuthorizedWindowDiscussionMediaEdit,
  WindowDiscussionMediaDraftOwnerPort,
} from './window-discussion-prepare-scope.js';
import {
  preparePrivateMessageMediaSchema,
  privateMessageMediaRequestHash,
} from './contracts-private-message.js';
import type { PreparePrivateMessageMediaInput } from './contracts-private-message.js';
import type {
  AuthorizedPrivateMessageMediaEdit,
  PrivateMessageMediaDraftOwnerPort,
} from './private-message-prepare-scope.js';
import {
  prepareErrandMediaSchema,
  errandMediaRequestHash,
  errandMediaAudience,
  errandMediaPurpose,
} from './contracts-errand.js';
import type { PrepareErrandMediaInput } from './contracts-errand.js';
import type {
  AuthorizedErrandMediaEdit,
  ErrandMediaDraftOwnerPort,
} from './errand-prepare-scope.js';
import {
  prepareVerificationEvidenceMediaSchema,
  verificationEvidenceMediaRequestHash,
} from './contracts-verification-evidence.js';
import type { PrepareVerificationEvidenceMediaInput } from './contracts-verification-evidence.js';
import type {
  AuthorizedVerificationEvidenceMediaEdit,
  VerificationEvidenceMediaDraftOwnerPort,
} from './verification-evidence-prepare-scope.js';
import {
  prepareAnnouncementMediaSchema,
  announcementMediaRequestHash,
} from './contracts-announcement.js';
import type { PrepareAnnouncementMediaInput } from './contracts-announcement.js';
import type {
  AuthorizedAnnouncementMediaEdit,
  AnnouncementMediaDraftOwnerPort,
} from './announcement-prepare-scope.js';
import {
  prepareActivityMediaSchema,
  activityMediaRequestHash,
} from './contracts-activity.js';
import type { PrepareActivityMediaInput } from './contracts-activity.js';
import type {
  AuthorizedActivityMediaEdit,
  ActivityMediaDraftOwnerPort,
} from './activity-prepare-scope.js';
import {
  prepareOrganizationMediaSchema,
  organizationMediaRequestHash,
} from './contracts-organization.js';
import type { PrepareOrganizationMediaInput } from './contracts-organization.js';
import type {
  AuthorizedOrganizationMediaEdit,
  OrganizationMediaDraftOwnerPort,
} from './organization-prepare-scope.js';
import {
  prepareSchoolQrMediaSchema,
  schoolQrMediaRequestHash,
} from './contracts-school-qr.js';
import type { PrepareSchoolQrMediaInput } from './contracts-school-qr.js';
import type {
  AuthorizedSchoolQrMediaEdit,
  SchoolQrMediaDraftOwnerPort,
} from './school-qr-prepare-scope.js';
import { prepareCategoryIconMediaSchema } from './contracts-category-icon.js';
import type { PrepareCategoryIconMediaInput } from './contracts-category-icon.js';
import type {
  AuthorizedCategoryIconMediaEdit,
  CategoryIconMediaDraftOwnerPort,
} from './category-icon-prepare-scope.js';
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
        | PrepareProfileCoverMediaInput
        | PrepareRatingsMediaInput
        | PrepareWindowDiscussionMediaInput
        | PrepareMajorDiscussionMediaInput
        | PreparePrivateMessageMediaInput
        | PrepareErrandMediaInput
        | PrepareVerificationEvidenceMediaInput
        | PrepareAnnouncementMediaInput
        | PrepareActivityMediaInput
        | PrepareOrganizationMediaInput
        | PrepareSchoolQrMediaInput
        | PrepareCategoryIconMediaInput
        | RatingsDiscussionMemberPrepare;
      scope:
        | AuthorizedMediaDraft
        | AuthorizedProfileMediaEdit
        | AuthorizedProfileCoverMediaEdit
        | AuthorizedRatingsMediaEdit
        | AuthorizedWindowDiscussionMediaEdit
        | AuthorizedMajorDiscussionMediaEdit
        | AuthorizedPrivateMessageMediaEdit
        | AuthorizedErrandMediaEdit
        | AuthorizedVerificationEvidenceMediaEdit
        | AuthorizedAnnouncementMediaEdit
        | AuthorizedActivityMediaEdit
        | AuthorizedOrganizationMediaEdit
        | AuthorizedSchoolQrMediaEdit
        | AuthorizedCategoryIconMediaEdit
        | AuthorizedRatingsDiscussionDraft;
    }
  >();
  constructor(
    private readonly owner: MediaDraftOwnerPort,
    private readonly profileOwner?: ProfileMediaDraftOwnerPort,
    private readonly ratingsOwner?: RatingsMediaDraftOwnerPort,
    private readonly ratingsDiscussionOwner?: RatingsDiscussionMediaDraftOwnerPort,
    private readonly categoryIconOwner?: CategoryIconMediaDraftOwnerPort,
    private readonly schoolQrOwner?: SchoolQrMediaDraftOwnerPort,
    private readonly organizationOwner?: OrganizationMediaDraftOwnerPort,
    private readonly activityOwner?: ActivityMediaDraftOwnerPort,
    private readonly announcementOwner?: AnnouncementMediaDraftOwnerPort,
    private readonly verificationEvidenceOwner?: VerificationEvidenceMediaDraftOwnerPort,
    private readonly errandOwner?: ErrandMediaDraftOwnerPort,
    private readonly privateMessageOwner?: PrivateMessageMediaDraftOwnerPort,
    private readonly windowDiscussionOwner?: WindowDiscussionMediaDraftOwnerPort,
    private readonly majorDiscussionOwner?: MajorDiscussionMediaDraftOwnerPort,
    private readonly profileCoverOwner?: ProfileCoverMediaDraftOwnerPort,
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
  async authorizeVerificationEvidence(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareVerificationEvidenceMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.verificationEvidenceOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.verificationEvidenceOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'verification' ||
      scope.resourceKind !== 'student_evidence' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'verification-private' ||
      scope.purpose !== 'verification-evidence-image' ||
      scope.slot !== 'evidence' ||
      scope.ordinal !== 0 ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !==
        verificationEvidenceMediaRequestHash(actor, input) ||
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
  async authorizeMajorDiscussion(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareMajorDiscussionMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.majorDiscussionOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.majorDiscussionOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'majors' ||
      scope.resourceKind !== 'major_discussion_image' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'content-gated' ||
      scope.purpose !== 'major-discussion-image' ||
      scope.slot !== 'images' ||
      scope.ordinal !== input.ordinal ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== majorDiscussionMediaRequestHash(actor, input) ||
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
  async authorizeWindowDiscussion(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareWindowDiscussionMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.windowDiscussionOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.windowDiscussionOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'ratings' ||
      scope.resourceKind !== 'window_discussion_image' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'content-gated' ||
      scope.purpose !== 'window-discussion-image' ||
      scope.slot !== 'images' ||
      scope.ordinal !== input.ordinal ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== windowDiscussionMediaRequestHash(actor, input) ||
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
  async authorizePrivateMessage(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = preparePrivateMessageMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.privateMessageOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.privateMessageOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'messaging' ||
      scope.resourceKind !== 'private_message_image' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'conversation-private' ||
      scope.purpose !== 'private-message-image' ||
      scope.slot !== 'image' ||
      scope.ordinal !== 0 ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== privateMessageMediaRequestHash(actor, input) ||
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
  async authorizeErrand(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareErrandMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.errandOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.errandOwner.authorizePrepare(actor, input, tx);
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'errands' ||
      scope.resourceKind !== 'errand_image' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== errandMediaAudience(input.slot) ||
      scope.purpose !== errandMediaPurpose(input.slot) ||
      scope.slot !== input.slot ||
      scope.ordinal !== 0 ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== errandMediaRequestHash(actor, input) ||
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
  async authorizeAnnouncement(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareAnnouncementMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.announcementOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.announcementOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'announcements' ||
      scope.resourceKind !== 'announcement_image' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'announcement-gated' ||
      scope.purpose !== 'announcement-image' ||
      scope.slot !== input.slot ||
      scope.ordinal !== 0 ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== announcementMediaRequestHash(actor, input) ||
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
  async authorizeActivity(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareActivityMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.activityOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.activityOwner.authorizePrepare(actor, input, tx);
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'activities' ||
      scope.resourceKind !== 'activity_image' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'activity-gated' ||
      scope.purpose !== 'activity-image' ||
      scope.slot !== input.slot ||
      scope.ordinal !== 0 ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== activityMediaRequestHash(actor, input) ||
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
  async authorizeOrganization(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareOrganizationMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.organizationOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.organizationOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'organizations' ||
      scope.resourceKind !== 'organization_image' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'organization-gated' ||
      scope.purpose !== 'organization-image' ||
      scope.slot !== input.slot ||
      scope.ordinal !== 0 ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== organizationMediaRequestHash(actor, input) ||
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
  async authorizeSchoolQr(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareSchoolQrMediaSchema.parse(raw),
      actor = mediaIdSchema.parse(actorAccountId),
      epoch = transactionReadEpoch(tx);
    if (!epoch || !this.schoolQrOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.schoolQrOwner.authorizePrepare(actor, input, tx);
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'school_configuration' ||
      scope.resourceKind !== 'entry_qr' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'school-config-gated' ||
      scope.purpose !== 'school-configuration-qr-image' ||
      scope.slot !== 'qr' ||
      scope.ordinal !== 0 ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      scope.scopeRevision !== schoolQrMediaRequestHash(actor, input) ||
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
  async authorizeCategoryIcon(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareCategoryIconMediaSchema.parse(raw);
    const actor = mediaIdSchema.parse(actorAccountId);
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !this.categoryIconOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.categoryIconOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'ratings' ||
      scope.resourceKind !== 'category_icon' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'content-gated' ||
      scope.purpose !== 'ratings-category-icon-image' ||
      scope.slot !== 'icon' ||
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
  async authorizeProfileCover(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const input = prepareProfileCoverMediaSchema.parse(raw);
    const actor = mediaIdSchema.parse(actorAccountId);
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !this.profileCoverOwner)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.profileCoverOwner.authorizePrepare(
      actor,
      input,
      tx,
    );
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'profile' ||
      scope.resourceKind !== 'cover' ||
      scope.targetKind !== 'edit' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'profile-public' ||
      scope.purpose !== 'profile-cover-image' ||
      scope.slot !== 'cover' ||
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
      | PrepareProfileCoverMediaInput
      | PrepareRatingsMediaInput
      | PrepareWindowDiscussionMediaInput
      | PrepareMajorDiscussionMediaInput
      | PreparePrivateMessageMediaInput
      | PrepareErrandMediaInput
      | PrepareVerificationEvidenceMediaInput
      | PrepareAnnouncementMediaInput
      | PrepareActivityMediaInput
      | PrepareOrganizationMediaInput
      | PrepareSchoolQrMediaInput
      | PrepareCategoryIconMediaInput
      | RatingsDiscussionMemberPrepare;
    scope:
      | AuthorizedMediaDraft
      | AuthorizedProfileMediaEdit
      | AuthorizedProfileCoverMediaEdit
      | AuthorizedRatingsMediaEdit
      | AuthorizedWindowDiscussionMediaEdit
      | AuthorizedMajorDiscussionMediaEdit
      | AuthorizedPrivateMessageMediaEdit
      | AuthorizedErrandMediaEdit
      | AuthorizedVerificationEvidenceMediaEdit
      | AuthorizedAnnouncementMediaEdit
      | AuthorizedActivityMediaEdit
      | AuthorizedOrganizationMediaEdit
      | AuthorizedSchoolQrMediaEdit
      | AuthorizedCategoryIconMediaEdit
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
