import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import {
  errandReferenceSchema,
  errandMediaBindingsSchema,
} from './contracts-errand.js';
import type { ErrandReference } from './contracts-errand.js';
import type { ErrandMediaReadAuthority } from '../errands/media/access-port.js';
export interface ErrandReadRequest {
  readonly reference: ErrandReference;
}
export interface ErrandReadAuthority extends ErrandMediaReadAuthority {
  readonly reference: ErrandReference;
}
export interface ErrandReadPort {
  authorizeCurrent(
    token: string,
    request: ErrandReadRequest,
    tx: PoolClient,
  ): Promise<ErrandReadAuthority>;
}
const brand: unique symbol = Symbol('errand-owner-proof');
export interface ErrandReadProof {
  readonly [brand]: true;
}
export class ErrandOwnerProofRegistry {
  private readonly issued = new WeakMap<
    ErrandReadProof,
    {
      tx: PoolClient;
      epoch: object;
      reference: ErrandReference;
      authority: ErrandReadAuthority;
    }
  >();
  constructor(private readonly owner: ErrandReadPort) {}
  async authorize(
    token: string,
    request: ErrandReadRequest,
    tx: PoolClient,
  ): Promise<ErrandReadProof> {
    const epoch = transactionReadEpoch(tx),
      reference = Object.freeze(errandReferenceSchema.parse(request.reference));
    if (!epoch || !token) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const value = await this.owner.authorizeCurrent(token, { reference }, tx);
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(errandReferenceSchema.parse(value.reference)) !==
        JSON.stringify(reference) ||
      value.orderId !== reference.orderId ||
      value.mediaRevision !== reference.revision ||
      typeof value.ownerRevision !== 'string' ||
      !value.ownerRevision ||
      value.ownerRevision.length > 500 ||
      !Number.isSafeInteger(value.draftRevision) ||
      value.draftRevision < 1
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const id of [
      value.accountId,
      value.sessionId,
      value.draftId,
      value.actorAccountId,
    ])
      mediaV2IdSchema.parse(id);
    const media = Object.freeze(
      errandMediaBindingsSchema.parse(value.media).map((x) => Object.freeze(x)),
    );
    if (
      !media.some(
        (x) => x.slot === reference.slot && x.bindingId === reference.bindingId,
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const proof: ErrandReadProof = Object.freeze({ [brand]: true as const });
    this.issued.set(proof, {
      tx,
      epoch,
      reference,
      authority: Object.freeze({ ...value, reference, media }),
    });
    return proof;
  }
  require(
    proof: ErrandReadProof,
    request: ErrandReadRequest,
    tx: PoolClient,
  ): ErrandReadAuthority {
    const found = this.issued.get(proof);
    if (
      !found ||
      found.tx !== tx ||
      found.epoch !== transactionReadEpoch(tx) ||
      JSON.stringify(found.reference) !==
        JSON.stringify(errandReferenceSchema.parse(request.reference))
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return found.authority;
  }
}
