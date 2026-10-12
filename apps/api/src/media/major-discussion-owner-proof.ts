import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { mediaDigestSchema } from './contracts.js';
import {
  majorDiscussionReferenceSchema,
  majorDiscussionMediaBindingsSchema,
} from './contracts-major-discussion.js';
import type { MajorDiscussionReference } from './contracts-major-discussion.js';
import type { MajorDiscussionMediaReadAuthority } from '../majors/discussion/media/access-port.js';
export interface MajorDiscussionReadRequest {
  readonly reference: MajorDiscussionReference;
}
export interface MajorDiscussionReadAuthority extends MajorDiscussionMediaReadAuthority {
  readonly reference: MajorDiscussionReference;
}
export interface MajorDiscussionReadPort {
  authorizeCurrent(
    token: string,
    request: MajorDiscussionReadRequest,
    tx: PoolClient,
  ): Promise<MajorDiscussionReadAuthority>;
}
const brand: unique symbol = Symbol('major-discussion-owner-proof');
export interface MajorDiscussionReadProof {
  readonly [brand]: true;
}
export class MajorDiscussionOwnerProofRegistry {
  private readonly issued = new WeakMap<
    MajorDiscussionReadProof,
    {
      tx: PoolClient;
      epoch: object;
      reference: MajorDiscussionReference;
      authority: MajorDiscussionReadAuthority;
    }
  >();
  constructor(private readonly owner: MajorDiscussionReadPort) {}
  async authorize(
    token: string,
    request: MajorDiscussionReadRequest,
    tx: PoolClient,
  ): Promise<MajorDiscussionReadProof> {
    const epoch = transactionReadEpoch(tx),
      reference = Object.freeze(
        majorDiscussionReferenceSchema.parse(request.reference),
      );
    if (!epoch || !token) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const value = await this.owner.authorizeCurrent(token, { reference }, tx),
      images = Object.freeze(
        majorDiscussionMediaBindingsSchema
          .parse(value.images)
          .map((x) => Object.freeze(x)),
      );
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(majorDiscussionReferenceSchema.parse(value.reference)) !==
        JSON.stringify(reference) ||
      value.majorId !== reference.majorId ||
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
    const proof: MajorDiscussionReadProof = Object.freeze({
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
    proof: MajorDiscussionReadProof,
    request: MajorDiscussionReadRequest,
    tx: PoolClient,
  ) {
    const found = this.issued.get(proof);
    if (
      !found ||
      found.tx !== tx ||
      found.epoch !== transactionReadEpoch(tx) ||
      JSON.stringify(found.reference) !==
        JSON.stringify(majorDiscussionReferenceSchema.parse(request.reference))
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return found.authority;
  }
}
