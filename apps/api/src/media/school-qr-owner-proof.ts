import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { schoolQrReferenceSchema } from './contracts-school-qr.js';
import type { SchoolQrReference } from './contracts-school-qr.js';
export type SchoolQrPrincipal =
  | {
      readonly kind: 'school-public';
      readonly campusId: string;
      readonly requestId: string;
      readonly accountId: string | null;
    }
  | {
      readonly kind: 'authenticated-errand-target';
      readonly orderId: string;
      readonly requestId: string;
      readonly accountId: string;
      readonly sessionId: string;
    }
  | {
      readonly kind: 'authenticated-school-management';
      readonly accountId: string;
      readonly sessionId: string;
    };
export interface SchoolQrReadRequest {
  readonly reference: SchoolQrReference;
  readonly audience: 'public' | 'management' | 'errand-order';
  readonly orderId?: string;
  readonly campusId: string | null;
  readonly requestId: string;
}
export interface SchoolQrReadAuthority {
  readonly principal: SchoolQrPrincipal;
  readonly reference: SchoolQrReference;
  readonly appearanceId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly ownerRevision: string;
}
export interface SchoolQrReadPort {
  authorizeCurrent(
    credential: string | null,
    request: SchoolQrReadRequest,
    tx: PoolClient,
  ): Promise<SchoolQrReadAuthority>;
}
const brand: unique symbol = Symbol('school-qr-owner-proof');
export interface SchoolQrReadProof {
  readonly [brand]: true;
}
export class SchoolQrOwnerProofRegistry {
  private readonly issued = new WeakMap<
    SchoolQrReadProof,
    {
      tx: PoolClient;
      epoch: object;
      request: SchoolQrReadRequest;
      authority: SchoolQrReadAuthority;
    }
  >();
  constructor(private readonly owner: SchoolQrReadPort) {}
  async authorize(
    credential: string | null,
    request: SchoolQrReadRequest,
    tx: PoolClient,
  ): Promise<SchoolQrReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || (credential !== null && !credential))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({
      ...request,
      reference: Object.freeze(
        schoolQrReferenceSchema.parse(request.reference),
      ),
    });
    mediaV2IdSchema.parse(request.requestId);
    if (request.audience === 'public') {
      if (
        request.orderId !== undefined ||
        request.reference.entryKey === 'review' ||
        !mediaV2IdSchema.safeParse(request.campusId).success
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    } else if (request.audience === 'errand-order') {
      if (
        credential === null ||
        request.campusId !== null ||
        request.reference.entryKey !== 'errand' ||
        !mediaV2IdSchema.safeParse(request.orderId).success
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
    } else if (
      request.orderId !== undefined ||
      request.audience !== 'management' ||
      credential === null ||
      request.campusId !== null
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const value = await this.owner.authorizeCurrent(credential, snapshot, tx);
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(schoolQrReferenceSchema.parse(value.reference)) !==
        JSON.stringify(snapshot.reference)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    mediaV2IdSchema.parse(value.appearanceId);
    mediaV2IdSchema.parse(value.assetId);
    mediaDigestSchema.parse(value.manifestDigest);
    mediaDigestSchema.parse(value.ownerRevision);
    if (request.audience === 'public') {
      if (
        value.principal.kind !== 'school-public' ||
        value.principal.campusId !== request.campusId ||
        value.principal.requestId !== request.requestId ||
        (credential === null) !== (value.principal.accountId === null)
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      if (value.principal.accountId !== null)
        mediaV2IdSchema.parse(value.principal.accountId);
    } else if (request.audience === 'errand-order') {
      if (
        value.principal.kind !== 'authenticated-errand-target' ||
        value.principal.orderId !== request.orderId ||
        value.principal.requestId !== request.requestId
      )
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      mediaV2IdSchema.parse(value.principal.accountId);
      mediaV2IdSchema.parse(value.principal.sessionId);
    } else {
      if (value.principal.kind !== 'authenticated-school-management')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      mediaV2IdSchema.parse(value.principal.accountId);
      mediaV2IdSchema.parse(value.principal.sessionId);
    }
    const proof: SchoolQrReadProof = Object.freeze({ [brand]: true as const });
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
    proof: SchoolQrReadProof,
    request: SchoolQrReadRequest,
    tx: PoolClient,
  ): SchoolQrReadAuthority {
    const fact = this.issued.get(proof);
    if (
      !fact ||
      fact.tx !== tx ||
      fact.epoch !== transactionReadEpoch(tx) ||
      JSON.stringify(fact.request) !== JSON.stringify(request)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return fact.authority;
  }
}
