import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import {
  errandMediaUuid,
  errandMediaSlot,
  errandMediaRevision,
  invalidErrandMedia,
} from './media-validation';
import type { ErrandMediaSlot } from './media-validation';
import type { ErrandMediaReadTarget } from './media-download';
import {
  ERRAND_MEDIA_PROTOCOL,
  decodeErrandMediaPrepare,
  decodeErrandMediaStatus,
  decodeErrandMediaRecovery,
  decodeErrandMediaGrant,
  decodeErrandMediaDescriptor,
  errandMediaPrepareHash,
} from './media-contract';
import type { ErrandMediaPrepare } from './media-contract';
const prefix = '/v3/media/errands';
export class HttpErrandMediaGateway {
  constructor(private readonly api: ApiClient) {}
  private async call<T>(
    path: string,
    method: 'GET' | 'POST',
    decode: (value: unknown) => T,
    session: MediaSession,
    cancel: Cancellation,
    input?: unknown,
    query?: Record<string, string>,
  ) {
    if (!session.current().credentials)
      throw new ClientError(
        'auth-required',
        'Errand image management requires sign in',
      );
    const result = await this.api.request(
      {
        path,
        method,
        decode,
        authentication: 'required',
        authReplay: method === 'GET' ? 'once' : 'never',
        successStatus: 200,
      },
      {
        cancellation: cancel,
        ...(input === undefined
          ? {}
          : { body: JSON.parse(JSON.stringify(input)) as Json }),
        ...(query ? { query } : {}),
      },
    );
    session.current();
    return result;
  }
  async prepare(
    raw: ErrandMediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeErrandMediaPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'Errand image management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeErrandMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== errandMediaPrepareHash(actor, input)
    )
      invalidErrandMedia();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${errandMediaUuid(requestId)}`,
      'GET',
      decodeErrandMediaRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidErrandMedia();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidErrandMedia();
    const result = await this.call(
      `${prefix}/upload-requests/${errandMediaUuid(requestId)}/cancel`,
      'POST',
      decodeErrandMediaRecovery,
      session,
      cancel,
      { protocol: ERRAND_MEDIA_PROTOCOL, requestHash },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalidErrandMedia();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${errandMediaUuid(intentId)}`,
      'GET',
      decodeErrandMediaStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalidErrandMedia();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${errandMediaUuid(intentId)}/grant`,
      'POST',
      decodeErrandMediaGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidErrandMedia();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${errandMediaUuid(intentId)}/finalize`,
      'POST',
      decodeErrandMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidErrandMedia();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${errandMediaUuid(intentId)}/cancel`,
      'POST',
      decodeErrandMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidErrandMedia();
    return result;
  }
  async descriptor(
    target: ErrandMediaReadTarget,
    key: ErrandMediaSlot,
    revision: number,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    errandMediaSlot(key);
    errandMediaRevision(revision);
    const path = `${prefix}/orders/${errandMediaUuid(target.orderId)}/${key}`;
    const result = await this.call(
      path,
      'GET',
      decodeErrandMediaDescriptor,
      session,
      cancel,
      undefined,
      { revision: String(revision) },
    );
    if (
      result.slot !== key ||
      result.revision !== revision ||
      result.orderId !== target.orderId
    )
      invalidErrandMedia();
    return result;
  }
}
