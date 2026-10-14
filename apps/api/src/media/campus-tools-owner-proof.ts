import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import {
  campusToolMediaTargetSchema,
  campusToolMediaReferenceSchema,
} from './contracts-campus-tools.js';
import type {
  CampusToolMediaTarget,
  CampusToolMediaReference,
} from './contracts-campus-tools.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { mediaDigestSchema } from './contracts.js';
export interface CampusToolMediaRequest {
  readonly target: CampusToolMediaTarget;
  readonly requestId: string;
}
export interface CampusToolMediaAuthority {
  readonly reference: CampusToolMediaReference;
  readonly catalogDigest: string;
  readonly principal: {
    readonly kind: 'campus-tools-public';
    readonly accountId: string | null;
    readonly sessionId: string | null;
    readonly requestId: string;
  };
}
export interface CampusToolMediaReadPort {
  authorizeCurrent(
    token: string | null,
    request: CampusToolMediaRequest,
    tx: PoolClient,
  ): Promise<CampusToolMediaAuthority>;
}
const brand: unique symbol = Symbol('campus-tools-owner-proof');
export interface CampusToolMediaProof {
  readonly [brand]: true;
}
export class CampusToolMediaProofRegistry {
  private readonly issued = new WeakMap<
    CampusToolMediaProof,
    {
      tx: PoolClient;
      epoch: object;
      request: CampusToolMediaRequest;
      authority: CampusToolMediaAuthority;
    }
  >();
  constructor(private readonly owner: CampusToolMediaReadPort) {}
  async authorize(
    token: string | null,
    request: CampusToolMediaRequest,
    tx: PoolClient,
  ): Promise<CampusToolMediaProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || (token !== null && !token))
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({
      target: Object.freeze(campusToolMediaTargetSchema.parse(request.target)),
      requestId: mediaV2IdSchema.parse(request.requestId),
    });
    const authority = await this.owner.authorizeCurrent(token, snapshot, tx);
    const reference = campusToolMediaReferenceSchema.parse(authority.reference);
    mediaDigestSchema.parse(authority.catalogDigest);
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(
        campusToolMediaTargetSchema.parse({
          campusId: reference.campusId,
          catalogId: reference.catalogId,
          entryId: reference.entryId,
          bindingId: reference.bindingId,
        }),
      ) !== JSON.stringify(snapshot.target) ||
      authority.principal.kind !== 'campus-tools-public' ||
      authority.principal.requestId !== snapshot.requestId ||
      (token === null) !== (authority.principal.accountId === null) ||
      (authority.principal.accountId === null) !==
        (authority.principal.sessionId === null)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    if (authority.principal.accountId !== null) {
      mediaV2IdSchema.parse(authority.principal.accountId);
      mediaV2IdSchema.parse(authority.principal.sessionId);
    }
    const proof: CampusToolMediaProof = Object.freeze({
      [brand]: true as const,
    });
    this.issued.set(proof, {
      tx,
      epoch,
      request: snapshot,
      authority: Object.freeze({
        ...authority,
        reference: Object.freeze(reference),
        principal: Object.freeze({ ...authority.principal }),
      }),
    });
    return proof;
  }
  require(
    proof: CampusToolMediaProof,
    request: CampusToolMediaRequest,
    tx: PoolClient,
  ) {
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
