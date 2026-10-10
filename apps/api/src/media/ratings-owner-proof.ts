import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { ratingsMediaParentSchema } from './contracts-ratings.js';
import type { RatingsMediaParent } from './contracts-ratings.js';

export interface RatingsMediaPrincipal {
  readonly kind: 'authenticatedRatings';
  readonly accountId: string;
  readonly sessionId: string;
}
export interface RatingsMediaReadRequest {
  readonly targetId: string;
  readonly contextId: string;
  readonly contextToken: string;
  readonly appearanceId: string;
  readonly purpose: 'list-projection' | 'direct-content' | 'download';
  /** Server-generated per-request identity, never a viewer/account substitute. */
  readonly requestId: string;
}
export interface AuthorizedRatingsMediaRead {
  readonly principal: RatingsMediaPrincipal;
  readonly actorAccountId: string;
  readonly targetId: string;
  readonly parent: RatingsMediaParent;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly bindingId: string;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
}
/** DI-only authenticated Ratings owner. Revalidate session/Safety, exact
 * scope, current definition, appearance and exact Ratings Review and
 * enroll the mandatory owner proof in this same transaction. */
export interface RatingsMediaReadPort {
  authorizeCurrent(
    credential: string,
    request: RatingsMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedRatingsMediaRead>;
}
const brand: unique symbol = Symbol('ratings-media-read-proof');
export interface RatingsMediaReadProof {
  readonly [brand]: true;
}
interface Facts {
  tx: PoolClient;
  epoch: object;
  request: RatingsMediaReadRequest;
  authority: AuthorizedRatingsMediaRead;
}
export class RatingsMediaProofRegistry {
  private readonly issued = new WeakMap<RatingsMediaReadProof, Facts>();
  constructor(private readonly owner: RatingsMediaReadPort) {}
  async authorize(
    credential: string,
    request: RatingsMediaReadRequest,
    tx: PoolClient,
  ): Promise<RatingsMediaReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !credential) throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(request.targetId);
    mediaV2IdSchema.parse(request.contextId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(request.contextToken))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(request.appearanceId);
    mediaV2IdSchema.parse(request.requestId);
    if (
      !['list-projection', 'direct-content', 'download'].includes(
        request.purpose,
      )
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({ ...request });
    const read = await this.owner.authorizeCurrent(credential, snapshot, tx);
    const parent = ratingsMediaParentSchema.parse(read.parent);
    mediaV2IdSchema.parse(read.actorAccountId);
    mediaV2IdSchema.parse(read.assetId);
    mediaV2IdSchema.parse(read.bindingId);
    mediaDigestSchema.parse(read.manifestDigest);
    mediaDigestSchema.parse(read.ownerRevision);
    mediaDigestSchema.parse(read.reviewRevision);
    if (
      read.targetId !== request.targetId ||
      parent.resourceId !== request.appearanceId ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (read.principal.kind !== 'authenticatedRatings')
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(read.principal.accountId);
    mediaV2IdSchema.parse(read.principal.sessionId);
    const proof: RatingsMediaReadProof = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(proof, {
      tx,
      epoch,
      request: snapshot,
      authority: Object.freeze({
        ...read,
        parent: Object.freeze(parent),
        principal: Object.freeze({ ...read.principal }),
      }),
    });
    return proof;
  }
  require(
    proof: RatingsMediaReadProof,
    request: RatingsMediaReadRequest,
    tx: PoolClient,
  ): AuthorizedRatingsMediaRead {
    const facts = this.issued.get(proof);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== transactionReadEpoch(tx) ||
      facts.request.targetId !== request.targetId ||
      facts.request.contextId !== request.contextId ||
      facts.request.contextToken !== request.contextToken ||
      facts.request.appearanceId !== request.appearanceId ||
      facts.request.requestId !== request.requestId ||
      facts.request.purpose !== request.purpose
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return facts.authority;
  }
}
