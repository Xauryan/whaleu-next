import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaDigestSchema } from './contracts.js';
import { mediaV2IdSchema } from './contracts-v2.js';
import { activityReferenceSchema } from './contracts-activity.js';
import type { ActivityReference } from './contracts-activity.js';
export interface ActivityReadRequest {
  readonly reference: ActivityReference;
  readonly audience: 'public' | 'management';
  readonly requestId: string;
}
export interface ActivityReadAuthority {
  readonly principal: {
    readonly kind: 'authenticated-activity';
    readonly accountId: string;
    readonly sessionId: string;
  };
  readonly reference: ActivityReference;
  readonly appearanceId: string;
  readonly assetId: string;
  readonly manifestDigest: string;
  readonly ownerRevision: string;
}
export interface ActivityReadPort {
  authorizeCurrent(
    credential: string,
    request: ActivityReadRequest,
    tx: PoolClient,
  ): Promise<ActivityReadAuthority>;
}
const brand: unique symbol = Symbol('activity-media-owner-proof');
export interface ActivityReadProof {
  readonly [brand]: true;
}
export class ActivityOwnerProofRegistry {
  private readonly issued = new WeakMap<
    ActivityReadProof,
    {
      tx: PoolClient;
      epoch: object;
      request: ActivityReadRequest;
      authority: ActivityReadAuthority;
    }
  >();
  constructor(private readonly owner: ActivityReadPort) {}
  async authorize(
    credential: string,
    request: ActivityReadRequest,
    tx: PoolClient,
  ): Promise<ActivityReadProof> {
    const epoch = transactionReadEpoch(tx);
    if (
      !epoch ||
      !credential ||
      !['public', 'management'].includes(request.audience)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const snapshot = Object.freeze({
      ...request,
      reference: Object.freeze(
        activityReferenceSchema.parse(request.reference),
      ),
    });
    mediaV2IdSchema.parse(request.requestId);
    const value = await this.owner.authorizeCurrent(credential, snapshot, tx);
    if (
      transactionReadEpoch(tx) !== epoch ||
      JSON.stringify(activityReferenceSchema.parse(value.reference)) !==
        JSON.stringify(snapshot.reference) ||
      value.principal.kind !== 'authenticated-activity'
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
    const proof: ActivityReadProof = Object.freeze({
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
    proof: ActivityReadProof,
    request: ActivityReadRequest,
    tx: PoolClient,
  ): ActivityReadAuthority {
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
