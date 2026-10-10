import {
  decodePublicationReference,
  type PublicationReference,
} from './discussion-upload-contracts';
import {
  decodeDiscussionTarget,
  type DiscussionTarget,
} from './discussion-batch-contracts';
import { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json, Transport } from '../platform/contracts';
import type { MediaSession } from './contracts';
import {
  batchIds,
  decodeBatchFenceResult,
  decodeBatchCommand,
  decodeBatchIdentity,
  decodeBatchPublicationRecovery,
  decodeBatchRecovery,
  decodeBatchStatus,
  decodeMemberPrepare,
  decodeMemberStatus,
  type BatchCommand,
  type BatchGateway,
  type BatchIdentity,
  type MemberPrepare,
} from './discussion-batch-contracts';
import {
  decodeUploadGrant,
  uploadDigest,
  uploadId,
  uploadInvalid,
} from './upload-contracts';
/** v4 is additive. Mutations never transparently replay under auth refresh. */
export class HttpDiscussionBatchGateway implements BatchGateway {
  private readonly api: ApiClient;
  constructor(
    origin: string,
    transport: Transport,
    private readonly sessions: SessionStore,
    auth: Pick<AuthService, 'refresh'>,
  ) {
    this.api = new ApiClient(origin, transport, sessions, auth);
  }
  private id(id: string): string {
    if (!uploadId(id)) uploadInvalid();
    return id;
  }
  async prepare(
    identity: BatchIdentity,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeBatchIdentity(identity);
    const status = await this.call(
      'POST',
      '/v4/media/batches/prepare',
      decodeBatchStatus,
      session,
      cancel,
      input,
    );
    if (status.batchRequestId !== input.batchRequestId) uploadInvalid();
    return status;
  }
  async recover(id: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      'GET',
      `/v4/media/batches/requests/${this.id(id)}`,
      decodeBatchRecovery,
      session,
      cancel,
    );
    if (
      (result.state === 'recorded'
        ? result.status.batchRequestId
        : result.batchRequestId) !== id
    )
      uploadInvalid();
    return result;
  }
  async cancel(
    id: string,
    hash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!uploadDigest(hash)) uploadInvalid();
    const result = await this.call(
      'POST',
      `/v4/media/batches/requests/${this.id(id)}/cancel`,
      decodeBatchRecovery,
      session,
      cancel,
      { batchRequestHash: hash },
    );
    if (
      result.state !== 'recorded' ||
      result.status.batchRequestId !== id ||
      result.status.batchRequestHash !== hash
    )
      uploadInvalid();
    return result;
  }
  async command(
    id: string,
    raw: BatchCommand,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const command = decodeBatchCommand(raw.kind, raw.payload);
    const result = await this.call(
      'POST',
      `/v4/media/batches/${this.id(id)}/${command.kind}`,
      decodeBatchStatus,
      session,
      cancel,
      command.payload,
    );
    if (result.batchId !== id) uploadInvalid();
    return result;
  }
  async recoverPublication(
    publication: PublicationReference,
    assetIds: readonly string[],
    session: MediaSession,
    cancel: Cancellation,
    target?: DiscussionTarget,
  ) {
    return this.call(
      'POST',
      '/v4/media/batches/recover-publication',
      decodeBatchPublicationRecovery,
      session,
      cancel,
      {
        publication: decodePublicationReference(publication),
        assetIds: batchIds(assetIds, 1),
        target: decodeDiscussionTarget(target),
      },
    );
  }
  async fencePublication(
    id: string,
    publication: PublicationReference,
    assetIds: readonly string[],
    session: MediaSession,
    cancel: Cancellation,
    target?: DiscussionTarget,
  ) {
    const result = await this.call(
      'POST',
      `/v4/media/batches/${this.id(id)}/fence-publication`,
      decodeBatchFenceResult,
      session,
      cancel,
      {
        publication: decodePublicationReference(publication),
        assetIds: batchIds(assetIds, 1),
        target: decodeDiscussionTarget(target),
      },
    );
    if (
      result.status.batchId !== id ||
      result.cancellation.operation !== publication.operation ||
      result.cancellation.requestId !== publication.clientRequestId ||
      (result.cancellation.outcome === 'cancelled' &&
        result.cancellation.intentHash !== publication.intentHash)
    )
      uploadInvalid();
    return result;
  }
  async prepareMember(
    id: string,
    raw: MemberPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeMemberPrepare(raw);
    const result = await this.call(
      'POST',
      `/v4/media/batches/${this.id(id)}/members/prepare`,
      decodeMemberStatus,
      session,
      cancel,
      input,
    );
    if (
      result.batchId !== id ||
      result.memberId !== input.memberId ||
      result.requestId !== input.clientRequestId
    )
      uploadInvalid();
    return result;
  }
  async memberStatus(id: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      'GET',
      `/v4/media/upload-intents/${this.id(id)}`,
      decodeMemberStatus,
      session,
      cancel,
    );
    if (result.intentId !== id) uploadInvalid();
    return result;
  }
  async grant(id: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      'POST',
      `/v4/media/upload-intents/${this.id(id)}/grant`,
      decodeUploadGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== id) uploadInvalid();
    return result;
  }
  async finalize(id: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      'POST',
      `/v4/media/upload-intents/${this.id(id)}/finalize`,
      decodeMemberStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== id) uploadInvalid();
    return result;
  }
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    decode: (raw: unknown) => T,
    session: MediaSession,
    cancel: Cancellation,
    body?: unknown,
  ): Promise<T> {
    const current = () => {
      this.sessions.assertCurrent(session.current());
      if (!session.current().credentials)
        throw new ClientError('auth-required', 'Original account required');
      if (cancel.isCancelled)
        throw new ClientError('cancelled', 'Batch operation cancelled');
    };
    current();
    const result = await this.api.request(
      {
        method,
        path,
        authentication: 'required',
        authReplay: method === 'GET' ? 'once' : 'never',
        successStatus: 200,
        decode,
      },
      {
        cancellation: cancel,
        ...(body === undefined ? {} : { body: body as Json }),
      },
    );
    current();
    return result;
  }
}
async function unavailable(): Promise<never> {
  throw new ClientError('configuration', 'Batch upload unavailable');
}
export const unavailableDiscussionBatchGateway: BatchGateway = Object.freeze({
  prepare: unavailable,
  recover: unavailable,
  cancel: unavailable,
  command: unavailable,
  recoverPublication: unavailable,
  fencePublication: unavailable,
  prepareMember: unavailable,
  memberStatus: unavailable,
  grant: unavailable,
  finalize: unavailable,
});
