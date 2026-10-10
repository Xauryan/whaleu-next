import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { profileMediaParentSchema } from './contracts-profile.js';
import type { ProfileMediaParent } from './contracts-profile.js';

export type ProfileMediaPrincipal =
  | { readonly kind: 'guest'; readonly requestId: string }
  | {
      readonly kind: 'session';
      readonly accountId: string;
      readonly sessionId: string;
    };
export interface ProfileMediaReadRequest {
  readonly profileId: string;
  readonly appearanceId: string;
  readonly purpose: 'list-projection' | 'direct-content' | 'download';
  /** Server-generated per-request identity, never a viewer/account substitute. */
  readonly requestId: string;
}
export interface AuthorizedProfileMediaRead {
  readonly principal: ProfileMediaPrincipal;
  readonly actorAccountId: string;
  readonly profileId: string;
  readonly parent: ProfileMediaParent;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly bindingId: string;
  readonly ownerRevision: string;
  readonly reviewRevision: string;
}
/** DI-only owner. A non-null invalid/empty credential must fail, never become a
 * guest. Revalidate session/Safety, current pointer and exact Profile Review and
 * enroll the mandatory owner proof in this same transaction. */
export interface ProfileMediaReadPort {
  authorizeCurrent(
    credential: string | null,
    request: ProfileMediaReadRequest,
    tx: PoolClient,
  ): Promise<AuthorizedProfileMediaRead>;
}
const brand: unique symbol = Symbol('profile-media-read-proof');
export interface ProfileMediaReadProof {
  readonly [brand]: true;
}
interface Facts {
  tx: PoolClient;
  epoch: object;
  request: ProfileMediaReadRequest;
  authority: AuthorizedProfileMediaRead;
}
export class ProfileMediaProofRegistry {
  private readonly issued = new WeakMap<ProfileMediaReadProof, Facts>();
  constructor(private readonly owner: ProfileMediaReadPort) {}
  async authorize(
    credential: string | null,
    request: ProfileMediaReadRequest,
    tx: PoolClient,
  ): Promise<ProfileMediaReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || (credential !== null && !credential))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(request.profileId);
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
    const parent = profileMediaParentSchema.parse(read.parent);
    mediaV2IdSchema.parse(read.actorAccountId);
    mediaV2IdSchema.parse(read.assetId);
    mediaV2IdSchema.parse(read.bindingId);
    mediaDigestSchema.parse(read.manifestDigest);
    mediaDigestSchema.parse(read.ownerRevision);
    mediaDigestSchema.parse(read.reviewRevision);
    if (
      read.profileId !== request.profileId ||
      parent.resourceId !== request.appearanceId ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (credential === null) {
      if (
        read.principal.kind !== 'guest' ||
        read.principal.requestId !== request.requestId
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    } else {
      if (read.principal.kind !== 'session')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      mediaV2IdSchema.parse(read.principal.accountId);
      mediaV2IdSchema.parse(read.principal.sessionId);
    }
    const proof: ProfileMediaReadProof = Object.freeze({
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
    proof: ProfileMediaReadProof,
    request: ProfileMediaReadRequest,
    tx: PoolClient,
  ): AuthorizedProfileMediaRead {
    const facts = this.issued.get(proof);
    if (
      !facts ||
      facts.tx !== tx ||
      facts.epoch !== transactionReadEpoch(tx) ||
      facts.request.profileId !== request.profileId ||
      facts.request.appearanceId !== request.appearanceId ||
      facts.request.requestId !== request.requestId ||
      facts.request.purpose !== request.purpose
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return facts.authority;
  }
}
