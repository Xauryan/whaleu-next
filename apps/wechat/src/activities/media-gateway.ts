import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import {
  activityMediaUuid,
  activityMediaSlot,
  activityMediaRevision,
  invalidActivityMedia,
} from './media-validation';
import type { ActivityMediaSlot } from './media-validation';
import type { ActivityMediaReadTarget } from './media-download';
import {
  ACTIVITY_MEDIA_PROTOCOL,
  decodeActivityMediaPrepare,
  decodeActivityMediaStatus,
  decodeActivityMediaRecovery,
  decodeActivityMediaGrant,
  decodeActivityMediaDescriptor,
  activityMediaPrepareHash,
} from './media-contract';
import type { ActivityMediaPrepare } from './media-contract';
const prefix = '/v3/media/activities';
export class HttpActivityMediaGateway {
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
        'Activity image management requires sign in',
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
    raw: ActivityMediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeActivityMediaPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'Activity image management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeActivityMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== activityMediaPrepareHash(actor, input)
    )
      invalidActivityMedia();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${activityMediaUuid(requestId)}`,
      'GET',
      decodeActivityMediaRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidActivityMedia();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidActivityMedia();
    const result = await this.call(
      `${prefix}/upload-requests/${activityMediaUuid(requestId)}/cancel`,
      'POST',
      decodeActivityMediaRecovery,
      session,
      cancel,
      { protocol: ACTIVITY_MEDIA_PROTOCOL, requestHash },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalidActivityMedia();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${activityMediaUuid(intentId)}`,
      'GET',
      decodeActivityMediaStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalidActivityMedia();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${activityMediaUuid(intentId)}/grant`,
      'POST',
      decodeActivityMediaGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidActivityMedia();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${activityMediaUuid(intentId)}/finalize`,
      'POST',
      decodeActivityMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidActivityMedia();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${activityMediaUuid(intentId)}/cancel`,
      'POST',
      decodeActivityMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidActivityMedia();
    return result;
  }
  async descriptor(
    target: ActivityMediaReadTarget,
    key: ActivityMediaSlot,
    revision: number,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    activityMediaSlot(key);
    activityMediaRevision(revision);
    if (target.audience !== 'public' && target.audience !== 'management')
      invalidActivityMedia();
    const path = `${prefix}/${target.audience}/activities/${activityMediaUuid(target.activityId)}/slots/${key}/descriptor`;
    const result = await this.call(
      path,
      'GET',
      decodeActivityMediaDescriptor,
      session,
      cancel,
      undefined,
      { revision: String(revision) },
    );
    if (
      result.slot !== key ||
      result.revision !== revision ||
      result.activityId !== target.activityId
    )
      invalidActivityMedia();
    return result;
  }
}
