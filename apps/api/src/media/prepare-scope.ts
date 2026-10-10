import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
import { mediaIdSchema, prepareMediaSchema } from './contracts.js';
import type { z } from 'zod';
import { prepareMediaV2Schema } from './contracts-v2.js';
import type { PrepareMediaV2Input } from './contracts-v2.js';
import { prepareMediaV3Schema } from './contracts-v3.js';
import type { PrepareMediaV3Input } from './contracts-v3.js';

export type PrepareMediaInput = z.infer<typeof prepareMediaSchema>;
export interface AuthorizedMediaDraft {
  readonly actorAccountId: string;
  /** Owner-generated durable identity; the client draftId is only a lookup intent. */
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly ownerKind: 'community';
  readonly resourceKind: 'post';
  readonly targetKind: 'draft';
  readonly contentVersion: 1;
  readonly audience: 'content-gated';
  readonly purpose: 'community-post-image';
  readonly slot: 'images';
  readonly ordinal: number;
}
export interface MediaDraftOwnerPort {
  /** Resolve a durable owner scope under current Identity/Safety/publication
   * authority. Enroll that owner's mandatory proof. No remote effects here. */
  authorizePrepare(
    actorAccountId: string,
    input: PrepareMediaInput | PrepareMediaV2Input | PrepareMediaV3Input,
    tx: PoolClient,
  ): Promise<AuthorizedMediaDraft>;
}
const brand: unique symbol = Symbol('media-prepare-scope');
export interface MediaPrepareScope {
  readonly [brand]: true;
}
/** No HTTP request can construct this capability. There is intentionally no
 * normal AppModule owner implementation or synthetic environment switch. */
export class MediaPrepareScopes {
  private readonly issued = new WeakMap<
    MediaPrepareScope,
    {
      tx: PoolClient;
      epoch: object;
      input: PrepareMediaInput | PrepareMediaV2Input | PrepareMediaV3Input;
      scope: AuthorizedMediaDraft;
    }
  >();
  constructor(private readonly owner: MediaDraftOwnerPort) {}
  async authorize(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return this.issue(actorAccountId, prepareMediaSchema.parse(raw), tx);
  }
  async authorizeV2(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return this.issue(actorAccountId, prepareMediaV2Schema.parse(raw), tx);
  }
  async authorizeV3(
    actorAccountId: string,
    raw: unknown,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    return this.issue(actorAccountId, prepareMediaV3Schema.parse(raw), tx);
  }
  private async issue(
    actorAccountId: string,
    input: PrepareMediaInput | PrepareMediaV2Input | PrepareMediaV3Input,
    tx: PoolClient,
  ): Promise<MediaPrepareScope> {
    const actor = mediaIdSchema.parse(actorAccountId);
    const epoch = transactionReadEpoch(tx);
    if (!epoch) throw new ApplicationError('MEDIA_UNAVAILABLE');
    const scope = await this.owner.authorizePrepare(actor, input, tx);
    if (
      scope.actorAccountId !== actor ||
      scope.ownerKind !== 'community' ||
      scope.resourceKind !== 'post' ||
      scope.targetKind !== 'draft' ||
      scope.contentVersion !== 1 ||
      scope.audience !== 'content-gated' ||
      scope.purpose !== input.purpose ||
      scope.slot !== input.slot ||
      scope.ordinal !== input.ordinal ||
      !mediaIdSchema.safeParse(scope.serverScopeId).success ||
      !/^[A-Za-z0-9._:-]{1,200}$/.test(scope.scopeRevision) ||
      transactionReadEpoch(tx) !== epoch
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    const capability: MediaPrepareScope = Object.freeze({
      [brand]: true as const,
    });
    if ('protocolVersion' in input) Object.freeze(input.batchIdentity);
    Object.freeze(input.declaration);
    Object.freeze(input);
    this.issued.set(capability, {
      tx,
      epoch,
      input,
      scope: Object.freeze({ ...scope }),
    });
    return capability;
  }
  require(
    capability: MediaPrepareScope,
    tx: PoolClient,
  ): {
    input: PrepareMediaInput | PrepareMediaV2Input | PrepareMediaV3Input;
    scope: AuthorizedMediaDraft;
  } {
    const issued = this.issued.get(capability);
    if (
      !issued ||
      issued.tx !== tx ||
      issued.epoch !== transactionReadEpoch(tx)
    )
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    return issued;
  }
}
