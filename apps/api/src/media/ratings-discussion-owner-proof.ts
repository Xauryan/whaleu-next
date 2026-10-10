import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema, mediaIdSchema } from './contracts.js';
import { ratingsDiscussionMediaParentSchema } from './contracts-ratings-discussion.js';
import type { RatingsDiscussionMediaParent } from './contracts-ratings-discussion.js';
import type { RatingsMediaPrincipal } from './ratings-owner-proof.js';

export interface RatingsDiscussionMediaReadRequest {
  readonly targetId: string;
  readonly rootId: string;
  readonly replyId: string | null;
  readonly subjectRevision: string;
  readonly contextId: string;
  readonly contextToken: string;
  readonly attachmentSetDigest: string;
  readonly purpose: 'list-projection' | 'direct-content' | 'download';
  readonly requestId: string;
}
export interface AuthorizedRatingsDiscussionMediaRead {
  readonly principal: RatingsMediaPrincipal;
  readonly actorAccountId: string;
  readonly parent: RatingsDiscussionMediaParent;
  readonly subjectRevision: string;
  readonly attachmentSetDigest: string;
  readonly images: readonly {
    readonly assetId: string;
    readonly manifestDigest: string;
    readonly bindingId: string;
    readonly ordinal: number;
  }[];
  readonly ownerRevision: string;
  readonly reviewRevision: string;
}
/** Authenticate and prove current exact scope, all real ancestors, complete
 * Review and complete ordered media set. Never accept a first-image proof. */
export interface RatingsDiscussionMediaReadPort {
  authorizeCurrent(
    token: string,
    request: RatingsDiscussionMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsDiscussionMediaRead>;
}
const brand: unique symbol = Symbol('ratings-discussion-media-read');
export interface RatingsDiscussionMediaReadProof {
  readonly [brand]: true;
}
export class RatingsDiscussionMediaProofRegistry {
  private readonly issued = new WeakMap<
    RatingsDiscussionMediaReadProof,
    {
      tx: PoolClient;
      epoch: object;
      request: string;
      read: AuthorizedRatingsDiscussionMediaRead;
    }
  >();
  constructor(private readonly owner: RatingsDiscussionMediaReadPort) {}
  async authorize(
    token: string,
    request: RatingsDiscussionMediaReadRequest,
    tx: PoolClient,
  ): Promise<RatingsDiscussionMediaReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !token) throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const id of [
      request.targetId,
      request.rootId,
      request.subjectRevision,
      request.contextId,
      request.requestId,
    ])
      mediaIdSchema.parse(id);
    if (request.replyId !== null) mediaIdSchema.parse(request.replyId);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(request.contextToken) ||
      !['list-projection', 'direct-content', 'download'].includes(
        request.purpose,
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaDigestSchema.parse(request.attachmentSetDigest);
    const snapshot = Object.freeze({ ...request });
    const read = await this.owner.authorizeCurrent(token, snapshot, tx);
    const parent = ratingsDiscussionMediaParentSchema.parse(read.parent);
    const reply = parent.resourceKind === 'rating_reply';
    if (
      transactionReadEpoch(tx) !== epoch ||
      read.principal.kind !== 'authenticatedRatings' ||
      parent.targetId !== request.targetId ||
      parent.resourceId !== (request.replyId ?? request.rootId) ||
      reply !== (request.replyId !== null) ||
      (reply && parent.rootId !== request.rootId) ||
      read.subjectRevision !== request.subjectRevision ||
      read.attachmentSetDigest !== request.attachmentSetDigest ||
      read.images.length < 1 ||
      read.images.length > (reply ? 3 : 9) ||
      new Set(read.images.map((x) => x.assetId)).size !== read.images.length ||
      new Set(read.images.map((x) => x.bindingId)).size !==
        read.images.length ||
      read.images.some((x, i) => x.ordinal !== i)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const id of [
      read.actorAccountId,
      read.principal.accountId,
      read.principal.sessionId,
    ])
      mediaIdSchema.parse(id);
    for (const digest of [read.ownerRevision, read.reviewRevision])
      mediaDigestSchema.parse(digest);
    for (const image of read.images) {
      mediaIdSchema.parse(image.assetId);
      mediaIdSchema.parse(image.bindingId);
      mediaDigestSchema.parse(image.manifestDigest);
    }
    const proof = Object.freeze({ [brand]: true as const });
    this.issued.set(proof, {
      tx,
      epoch,
      request: JSON.stringify(snapshot),
      read: Object.freeze({
        ...read,
        parent: Object.freeze(parent),
        principal: Object.freeze({ ...read.principal }),
        images: Object.freeze(read.images.map((x) => Object.freeze({ ...x }))),
      }),
    });
    return proof;
  }
  require(
    proof: RatingsDiscussionMediaReadProof,
    request: RatingsDiscussionMediaReadRequest,
    tx: PoolClient,
  ): AuthorizedRatingsDiscussionMediaRead {
    const issued = this.issued.get(proof);
    if (
      !issued ||
      issued.tx !== tx ||
      issued.epoch !== transactionReadEpoch(tx) ||
      issued.request !== JSON.stringify(request)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return issued.read;
  }
}
