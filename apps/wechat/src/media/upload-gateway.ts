import { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json, Transport } from '../platform/contracts';
import type { MediaSession } from './contracts';
import {
  decodeUploadGrant,
  decodeUploadPrepare,
  decodeUploadRecovery,
  decodeUploadStatus,
  uploadDigest,
  uploadId,
  uploadInvalid,
  type UploadGateway,
  type UploadPrepare,
  type UploadRecovery,
  type UploadStatus,
} from './upload-contracts';

/** v2 is separate from frozen v1, with no implicit mutation replay. */
export class HttpUploadGateway implements UploadGateway {
  private readonly api: ApiClient;
  constructor(
    origin: string,
    transport: Transport,
    private readonly sessions: SessionStore,
    auth: Pick<AuthService, 'refresh'>,
  ) {
    this.api = new ApiClient(origin, transport, sessions, auth);
  }
  async prepare(
    raw: UploadPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadStatus> {
    const input = decodeUploadPrepare(raw);
    const status = await this.call(
      'POST',
      '/v2/media/upload-intents',
      decodeUploadStatus,
      session,
      cancel,
      { ...input, declaration: { ...input.declaration } },
    );
    if (status.requestId !== input.clientRequestId) uploadInvalid();
    return status;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadRecovery> {
    const value = await this.call(
      'GET',
      this.requestPath(requestId),
      decodeUploadRecovery,
      session,
      cancel,
    );
    if (value.requestId !== requestId) uploadInvalid();
    return value;
  }
  async status(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadStatus> {
    const value = await this.call(
      'GET',
      this.intentPath(intentId),
      decodeUploadStatus,
      session,
      cancel,
    );
    if (value.intentId !== intentId) uploadInvalid();
    return value;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const value = await this.call(
      'POST',
      `${this.intentPath(intentId)}/grant`,
      decodeUploadGrant,
      session,
      cancel,
      {},
    );
    if (value.intentId !== intentId) uploadInvalid();
    return value;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadStatus> {
    const value = await this.call(
      'POST',
      `${this.intentPath(intentId)}/finalize`,
      decodeUploadStatus,
      session,
      cancel,
      {},
    );
    if (value.intentId !== intentId) uploadInvalid();
    return value;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<UploadRecovery> {
    if (!uploadDigest(requestHash)) uploadInvalid();
    const value = await this.call(
      'POST',
      `${this.requestPath(requestId)}/cancel`,
      decodeUploadRecovery,
      session,
      cancel,
      { requestHash },
    );
    if (
      value.state === 'not_recorded' ||
      value.requestId !== requestId ||
      value.requestHash !== requestHash
    )
      uploadInvalid();
    return value;
  }
  private intentPath(id: string): string {
    if (!uploadId(id)) uploadInvalid();
    return `/v2/media/upload-intents/${id}`;
  }
  private requestPath(id: string): string {
    if (!uploadId(id)) uploadInvalid();
    return `/v2/media/upload-requests/${id}`;
  }
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    decode: (value: unknown) => T,
    session: MediaSession,
    cancel: Cancellation,
    body?: Json,
  ): Promise<T> {
    this.current(session, cancel);
    const result = await this.api.request(
      {
        method,
        path,
        authentication: 'required',
        authReplay: method === 'GET' ? 'once' : 'never',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(body === undefined ? {} : { body }) },
    );
    this.current(session, cancel);
    return result;
  }
  private current(session: MediaSession, cancel: Cancellation): void {
    const ticket = session.current();
    this.sessions.assertCurrent(ticket);
    if (!ticket.credentials)
      throw new ClientError('auth-required', 'Sign in to use media');
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Media request cancelled');
  }
}
async function unavailable(): Promise<never> {
  throw new ClientError('configuration', 'Media upload is unavailable');
}
/** Formal runtime has no synthetic/provider activation option. Tests inject concrete dependencies. */
export const unavailableUploadGateway: UploadGateway = Object.freeze({
  prepare: unavailable,
  recover: unavailable,
  status: unavailable,
  grant: unavailable,
  finalize: unavailable,
  cancelRequest: unavailable,
});
