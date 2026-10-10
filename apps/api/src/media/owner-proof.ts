import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaParentSchema } from './contracts.js';
import type { MediaAudience, MediaParent } from './contracts.js';

export type MediaReadPurpose =
  'list-projection' | 'direct-content' | 'download';
export interface OwnerReadRequest {
  readonly viewerAccountId: string;
  readonly parent: MediaParent;
  readonly audience: MediaAudience;
  readonly purpose: MediaReadPurpose;
}
/** A registered owner must run current Identity/Safety/ancestor/Review gates and
 * enroll its own mandatory final proof. Media cannot substitute for that proof.
 * No network work is allowed inside this authorization call. */
export interface MediaOwnerReadPort {
  readonly ownerKind: MediaParent['ownerKind'];
  authorizeCurrent(request: OwnerReadRequest, tx: PoolClient): Promise<void>;
}
const brand: unique symbol = Symbol('media-owner-read-proof');
export interface MediaOwnerReadProof {
  readonly [brand]: true;
}
interface ProofFacts {
  readonly tx: PoolClient;
  readonly epoch: object;
  readonly request: OwnerReadRequest;
}
/** A DI-only capability issuer. Proof objects cannot be reconstructed from JSON,
 * used for a different parent/purpose, or retained across transaction rollback. */
export class MediaOwnerProofRegistry {
  private readonly ports = new Map<
    MediaParent['ownerKind'],
    MediaOwnerReadPort
  >();
  private readonly proofs = new WeakMap<MediaOwnerReadProof, ProofFacts>();
  constructor(ports: readonly MediaOwnerReadPort[]) {
    for (const port of ports) {
      if (this.ports.has(port.ownerKind))
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      this.ports.set(port.ownerKind, port);
    }
  }
  async authorize(
    request: OwnerReadRequest,
    tx: PoolClient,
  ): Promise<MediaOwnerReadProof> {
    const epoch = transactionReadEpoch(tx);
    const parent = mediaParentSchema.parse(request.parent);
    const expectedAudience: MediaAudience =
      parent.ownerKind === 'community'
        ? 'content-gated'
        : parent.ownerKind === 'messaging'
          ? 'conversation-private'
          : 'participant-private';
    const port = this.ports.get(parent.ownerKind);
    if (
      !epoch ||
      !port ||
      request.audience !== expectedAudience ||
      !request.viewerAccountId
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot: OwnerReadRequest = Object.freeze({
      ...request,
      parent: Object.freeze(parent),
    });
    await port.authorizeCurrent(snapshot, tx);
    if (transactionReadEpoch(tx) !== epoch)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const proof: MediaOwnerReadProof = Object.freeze({
      [brand]: true as const,
    });
    this.proofs.set(proof, { tx, epoch, request: snapshot });
    return proof;
  }
  require(
    proof: MediaOwnerReadProof,
    tx: PoolClient,
    expected: OwnerReadRequest,
  ): void {
    const facts = this.proofs.get(proof);
    const parent = expected.parent;
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== transactionReadEpoch(tx) ||
      facts.request.viewerAccountId !== expected.viewerAccountId ||
      facts.request.audience !== expected.audience ||
      facts.request.purpose !== expected.purpose ||
      facts.request.parent.ownerKind !== parent.ownerKind ||
      facts.request.parent.resourceKind !== parent.resourceKind ||
      facts.request.parent.resourceId !== parent.resourceId ||
      facts.request.parent.contentVersion !== parent.contentVersion
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
  }
}
