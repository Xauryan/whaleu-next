import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  transactionReadEpoch,
  registerTransactionDeadline,
} from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { verificationEvidenceReferenceSchema } from './contracts-verification-evidence.js';
import type { VerificationEvidenceReference } from './contracts-verification-evidence.js';
export interface VerificationEvidenceReadRequest {
  readonly reference: VerificationEvidenceReference;
  readonly reviewRegionId: string | null;
  readonly requestId: string;
}
export interface VerificationEvidenceReadAuthority {
  readonly principal: {
    readonly accountId: string;
    readonly sessionId: string;
  };
  readonly actorAccountId: string;
  readonly reference: VerificationEvidenceReference;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly ownerRevision: string;
  readonly expiresAt: number;
  readonly policyRef: string;
}
export interface VerificationEvidenceReadPort {
  authorizeCurrent(
    credential: string,
    request: VerificationEvidenceReadRequest,
    tx: PoolClient,
  ): Promise<VerificationEvidenceReadAuthority>;
}
const brand: unique symbol = Symbol('verification-evidence-read-proof');
export interface VerificationEvidenceReadProof {
  readonly [brand]: true;
}
export class VerificationEvidenceOwnerProofRegistry {
  private readonly issued = new WeakMap<
    VerificationEvidenceReadProof,
    {
      tx: PoolClient;
      epoch: object;
      request: VerificationEvidenceReadRequest;
      authority: VerificationEvidenceReadAuthority;
    }
  >();
  constructor(private readonly owner: VerificationEvidenceReadPort) {}
  async authorize(
    credential: string,
    request: VerificationEvidenceReadRequest,
    tx: PoolClient,
  ): Promise<VerificationEvidenceReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (!epoch || !credential) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({
      ...request,
      reference: Object.freeze(
        verificationEvidenceReferenceSchema.parse(request.reference),
      ),
    });
    mediaV2IdSchema.parse(request.requestId);
    if (request.reviewRegionId !== null)
      mediaV2IdSchema.parse(request.reviewRegionId);
    const value = await this.owner.authorizeCurrent(credential, snapshot, tx);
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(
        verificationEvidenceReferenceSchema.parse(value.reference),
      ) !== JSON.stringify(snapshot.reference) ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt < 1 ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(value.policyRef)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const id of [
      value.assetId,
      value.actorAccountId,
      value.principal.accountId,
      value.principal.sessionId,
    ])
      mediaV2IdSchema.parse(id);
    mediaDigestSchema.parse(value.manifestDigest);
    mediaDigestSchema.parse(value.ownerRevision);
    registerTransactionDeadline(tx, value.expiresAt, 'MEDIA_UNAVAILABLE');
    const proof: VerificationEvidenceReadProof = Object.freeze({
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
    proof: VerificationEvidenceReadProof,
    request: VerificationEvidenceReadRequest,
    tx: PoolClient,
  ): VerificationEvidenceReadAuthority {
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
