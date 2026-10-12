import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { mediaDigestSchema } from './contracts.js';
import {
  privateMessageReferenceSchema,
  privateMessageMediaBindingSchema,
} from './contracts-private-message.js';
import type { PrivateMessageReference } from './contracts-private-message.js';
import type { PrivateMessageMediaReadAuthority } from '../messaging/media/access-port.js';
export interface PrivateMessageReadRequest {
  readonly reference: PrivateMessageReference;
}
export interface PrivateMessageReadAuthority extends PrivateMessageMediaReadAuthority {
  readonly reference: PrivateMessageReference;
}
export interface PrivateMessageReadPort {
  authorizeCurrent(
    token: string,
    request: PrivateMessageReadRequest,
    tx: PoolClient,
  ): Promise<PrivateMessageReadAuthority>;
}
const brand: unique symbol = Symbol('private-message-owner-proof');
export interface PrivateMessageReadProof {
  readonly [brand]: true;
}
export class PrivateMessageOwnerProofRegistry {
  private readonly issued = new WeakMap<
    PrivateMessageReadProof,
    {
      tx: PoolClient;
      epoch: object;
      reference: PrivateMessageReference;
      authority: PrivateMessageReadAuthority;
    }
  >();
  constructor(private readonly owner: PrivateMessageReadPort) {}
  async authorize(
    token: string,
    request: PrivateMessageReadRequest,
    tx: PoolClient,
  ): Promise<PrivateMessageReadProof> {
    const epoch = transactionReadEpoch(tx),
      reference = Object.freeze(
        privateMessageReferenceSchema.parse(request.reference),
      );
    if (!epoch || !token) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const value = await this.owner.authorizeCurrent(token, { reference }, tx),
      image = Object.freeze(
        privateMessageMediaBindingSchema.parse(value.image),
      );
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(privateMessageReferenceSchema.parse(value.reference)) !==
        JSON.stringify(reference) ||
      value.conversationId !== reference.conversationId ||
      value.messageId !== reference.messageId ||
      image.bindingId !== reference.bindingId ||
      !value.ownerRevision ||
      value.ownerRevision.length > 500
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const id of [
      value.accountId,
      value.sessionId,
      value.actorAccountId,
      value.messageRequestId,
    ])
      mediaV2IdSchema.parse(id);
    mediaDigestSchema.parse(value.contextDigest);
    const proof: PrivateMessageReadProof = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(proof, {
      tx,
      epoch,
      reference,
      authority: Object.freeze({ ...value, reference, image }),
    });
    return proof;
  }
  require(
    proof: PrivateMessageReadProof,
    request: PrivateMessageReadRequest,
    tx: PoolClient,
  ) {
    const found = this.issued.get(proof);
    if (
      !found ||
      found.tx !== tx ||
      found.epoch !== transactionReadEpoch(tx) ||
      JSON.stringify(found.reference) !==
        JSON.stringify(privateMessageReferenceSchema.parse(request.reference))
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return found.authority;
  }
}
