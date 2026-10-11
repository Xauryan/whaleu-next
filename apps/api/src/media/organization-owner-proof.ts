import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { organizationReferenceSchema } from './contracts-organization.js';
import type { OrganizationReference } from './contracts-organization.js';
export interface OrganizationReadRequest {
  readonly reference: OrganizationReference;
  readonly audience: 'public' | 'management';
  readonly requestId: string;
}
export interface OrganizationReadAuthority {
  readonly principal: {
    readonly kind: 'authenticated-organization';
    readonly accountId: string;
    readonly sessionId: string;
  };
  readonly reference: OrganizationReference;
  readonly appearanceId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly ownerRevision: string;
}
export interface OrganizationReadPort {
  authorizeCurrent(
    credential: string,
    request: OrganizationReadRequest,
    tx: PoolClient,
  ): Promise<OrganizationReadAuthority>;
}
const brand: unique symbol = Symbol('organization-media-owner-proof');
export interface OrganizationReadProof {
  readonly [brand]: true;
}
export class OrganizationOwnerProofRegistry {
  private readonly issued = new WeakMap<
    OrganizationReadProof,
    {
      tx: PoolClient;
      epoch: object;
      request: OrganizationReadRequest;
      authority: OrganizationReadAuthority;
    }
  >();
  constructor(private readonly owner: OrganizationReadPort) {}
  async authorize(
    credential: string,
    request: OrganizationReadRequest,
    tx: PoolClient,
  ): Promise<OrganizationReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (
      !epoch ||
      !credential ||
      !['public', 'management'].includes(request.audience) ||
      (request.audience === 'public' &&
        request.reference.slot === 'managerContact')
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({
      ...request,
      reference: Object.freeze(
        organizationReferenceSchema.parse(request.reference),
      ),
    });
    mediaV2IdSchema.parse(request.requestId);
    const value = await this.owner.authorizeCurrent(credential, snapshot, tx);
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(organizationReferenceSchema.parse(value.reference)) !==
        JSON.stringify(snapshot.reference) ||
      value.principal.kind !== 'authenticated-organization'
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    for (const id of [
      value.appearanceId,
      value.assetId,
      value.principal.accountId,
      value.principal.sessionId,
    ])
      mediaV2IdSchema.parse(id);
    mediaDigestSchema.parse(value.manifestDigest);
    mediaDigestSchema.parse(value.ownerRevision);
    const proof: OrganizationReadProof = Object.freeze({
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
    proof: OrganizationReadProof,
    request: OrganizationReadRequest,
    tx: PoolClient,
  ): OrganizationReadAuthority {
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
