import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { mediaDigestSchema } from './contracts.js';
import {
  windowDiscussionReferenceSchema,
  windowDiscussionMediaBindingsSchema,
} from './contracts-window-discussion.js';
import type { WindowDiscussionReference } from './contracts-window-discussion.js';
import type { WindowDiscussionMediaReadAuthority } from '../ratings/windows/discussion/media/access-port.js';
export interface WindowDiscussionReadRequest {
  readonly reference: WindowDiscussionReference;
}
export interface WindowDiscussionReadAuthority extends WindowDiscussionMediaReadAuthority {
  readonly reference: WindowDiscussionReference;
}
export interface WindowDiscussionReadPort {
  authorizeCurrent(
    token: string,
    request: WindowDiscussionReadRequest,
    tx: PoolClient,
  ): Promise<WindowDiscussionReadAuthority>;
}
const brand: unique symbol = Symbol('window-discussion-owner-proof');
export interface WindowDiscussionReadProof {
  readonly [brand]: true;
}
export class WindowDiscussionOwnerProofRegistry {
  private readonly issued = new WeakMap<
    WindowDiscussionReadProof,
    {
      tx: PoolClient;
      epoch: object;
      reference: WindowDiscussionReference;
      authority: WindowDiscussionReadAuthority;
    }
  >();
  constructor(private readonly owner: WindowDiscussionReadPort) {}
  async authorize(
    token: string,
    request: WindowDiscussionReadRequest,
    tx: PoolClient,
  ): Promise<WindowDiscussionReadProof> {
    const epoch = transactionReadEpoch(tx),
      reference = Object.freeze(
        windowDiscussionReferenceSchema.parse(request.reference),
      );
    if (!epoch || !token) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const value = await this.owner.authorizeCurrent(token, { reference }, tx),
      images = Object.freeze(
        windowDiscussionMediaBindingsSchema
          .parse(value.images)
          .map((x) => Object.freeze(x)),
      );
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(windowDiscussionReferenceSchema.parse(value.reference)) !==
        JSON.stringify(reference) ||
      value.windowId !== reference.windowId ||
      value.commentId !== reference.commentId ||
      images[reference.ordinal]?.bindingId !== reference.bindingId ||
      !value.ownerRevision ||
      value.ownerRevision.length > 500
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const id of [
      value.accountId,
      value.sessionId,
      value.actorAccountId,
      value.publicationRequestId,
    ])
      mediaV2IdSchema.parse(id);
    mediaDigestSchema.parse(value.contextDigest);
    const proof: WindowDiscussionReadProof = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(proof, {
      tx,
      epoch,
      reference,
      authority: Object.freeze({ ...value, reference, images }),
    });
    return proof;
  }
  require(
    proof: WindowDiscussionReadProof,
    request: WindowDiscussionReadRequest,
    tx: PoolClient,
  ) {
    const found = this.issued.get(proof);
    if (
      !found ||
      found.tx !== tx ||
      found.epoch !== transactionReadEpoch(tx) ||
      JSON.stringify(found.reference) !==
        JSON.stringify(windowDiscussionReferenceSchema.parse(request.reference))
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return found.authority;
  }
}
