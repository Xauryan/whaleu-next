import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { announcementReferenceSchema } from './contracts-announcement.js';
import type { AnnouncementReference } from './contracts-announcement.js';
export type AnnouncementPrincipal =
  | {
      readonly kind: 'announcement-public';
      readonly campusId: string | null;
      readonly requestId: string;
      readonly accountId: string | null;
      readonly sessionId: string | null;
    }
  | {
      readonly kind: 'authenticated-announcement-management';
      readonly accountId: string;
      readonly sessionId: string;
    };
export interface AnnouncementReadRequest {
  readonly reference: AnnouncementReference;
  readonly audience: 'public' | 'management';
  readonly campusId: string | null;
  readonly requestId: string;
}
export interface AnnouncementReadAuthority {
  readonly principal: AnnouncementPrincipal;
  readonly reference: AnnouncementReference;
  readonly appearanceId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly ownerRevision: string;
}
export interface AnnouncementReadPort {
  authorizeCurrent(
    credential: string | null,
    request: AnnouncementReadRequest,
    tx: PoolClient,
  ): Promise<AnnouncementReadAuthority>;
}
const brand: unique symbol = Symbol('announcement-owner-proof');
export interface AnnouncementReadProof {
  readonly [brand]: true;
}
export class AnnouncementOwnerProofRegistry {
  private readonly issued = new WeakMap<
    AnnouncementReadProof,
    {
      tx: PoolClient;
      epoch: object;
      request: AnnouncementReadRequest;
      authority: AnnouncementReadAuthority;
    }
  >();
  constructor(private readonly owner: AnnouncementReadPort) {}
  async authorize(
    credential: string | null,
    request: AnnouncementReadRequest,
    tx: PoolClient,
  ): Promise<AnnouncementReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || (credential !== null && !credential))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({
      ...request,
      reference: Object.freeze(
        announcementReferenceSchema.parse(request.reference),
      ),
    });
    mediaV2IdSchema.parse(request.requestId);
    if (request.audience === 'public') {
      if (
        request.campusId !== null &&
        !mediaV2IdSchema.safeParse(request.campusId).success
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    } else if (
      request.audience !== 'management' ||
      credential === null ||
      request.campusId !== null
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const value = await this.owner.authorizeCurrent(credential, snapshot, tx);
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(announcementReferenceSchema.parse(value.reference)) !==
        JSON.stringify(snapshot.reference)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(value.appearanceId);
    mediaV2IdSchema.parse(value.assetId);
    mediaDigestSchema.parse(value.manifestDigest);
    mediaDigestSchema.parse(value.ownerRevision);
    if (request.audience === 'public') {
      if (
        value.principal.kind !== 'announcement-public' ||
        value.principal.campusId !== request.campusId ||
        value.principal.requestId !== request.requestId ||
        (credential === null) !== (value.principal.accountId === null) ||
        (credential === null) !== (value.principal.sessionId === null)
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (value.principal.accountId !== null) {
        mediaV2IdSchema.parse(value.principal.accountId);
        mediaV2IdSchema.parse(value.principal.sessionId);
      }
    } else {
      if (value.principal.kind !== 'authenticated-announcement-management')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      mediaV2IdSchema.parse(value.principal.accountId);
      mediaV2IdSchema.parse(value.principal.sessionId);
    }
    const proof: AnnouncementReadProof = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(proof, {
      tx,
      epoch,
      request: snapshot,
      authority: Object.freeze({
        ...value,
        reference: snapshot.reference,
        principal: Object.freeze({ ...value.principal }),
      }),
    });
    return proof;
  }
  require(
    proof: AnnouncementReadProof,
    request: AnnouncementReadRequest,
    tx: PoolClient,
  ): AnnouncementReadAuthority {
    const fact = this.issued.get(proof);
    if (
      !fact ||
      fact.tx !== tx ||
      fact.epoch !== transactionReadEpoch(tx) ||
      fact.request.audience !== request.audience ||
      fact.request.campusId !== request.campusId ||
      fact.request.requestId !== request.requestId ||
      JSON.stringify(fact.request.reference) !==
        JSON.stringify(announcementReferenceSchema.parse(request.reference))
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return fact.authority;
  }
}
