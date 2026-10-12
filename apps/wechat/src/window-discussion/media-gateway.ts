import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidDiscussion } from './contract';
import {
  mediaId,
  decodeWindowDiscussionImageReference,
  type WindowDiscussionImageReference,
} from './media-contract';
import {
  WINDOW_DISCUSSION_MEDIA_PROTOCOL,
  decodeWindowDiscussionMediaPrepare,
  decodeWindowDiscussionMediaStatus,
  decodeWindowDiscussionMediaRecovery,
  decodeWindowDiscussionMediaGrant,
  decodeWindowDiscussionMediaDescriptor,
  windowDiscussionMediaPrepareHash,
} from './media-contract';
import type { WindowDiscussionMediaPrepare } from './media-contract';
const prefix = '/v3/media/window-discussions';
export class HttpWindowDiscussionMediaGateway {
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
        'WindowDiscussion image management requires sign in',
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
    raw: WindowDiscussionMediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeWindowDiscussionMediaPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'WindowDiscussion image management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeWindowDiscussionMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== windowDiscussionMediaPrepareHash(actor, input)
    )
      invalidDiscussion();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${mediaId(requestId)}`,
      'GET',
      decodeWindowDiscussionMediaRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidDiscussion();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    windowId: string,
    publicationRequestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidDiscussion();
    const result = await this.call(
      `${prefix}/upload-requests/${mediaId(requestId)}/cancel`,
      'POST',
      decodeWindowDiscussionMediaRecovery,
      session,
      cancel,
      {
        protocol: WINDOW_DISCUSSION_MEDIA_PROTOCOL,
        requestHash,
        windowId: mediaId(windowId),
        publicationRequestId: mediaId(publicationRequestId),
      },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalidDiscussion();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${mediaId(intentId)}`,
      'GET',
      decodeWindowDiscussionMediaStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalidDiscussion();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${mediaId(intentId)}/grant`,
      'POST',
      decodeWindowDiscussionMediaGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidDiscussion();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${mediaId(intentId)}/finalize`,
      'POST',
      decodeWindowDiscussionMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidDiscussion();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${mediaId(intentId)}/cancel`,
      'POST',
      decodeWindowDiscussionMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidDiscussion();
    return result;
  }
  async descriptor(
    raw: WindowDiscussionImageReference,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const r = decodeWindowDiscussionImageReference(raw);
    const result = await this.call(
      `${prefix}/windows/${r.windowId}/comments/${r.commentId}/bindings/${r.bindingId}`,
      'GET',
      decodeWindowDiscussionMediaDescriptor,
      session,
      cancel,
      undefined,
      { ordinal: String(r.ordinal) },
    );
    if (
      result.windowId !== r.windowId ||
      result.commentId !== r.commentId ||
      result.bindingId !== r.bindingId ||
      result.ordinal !== r.ordinal
    )
      invalidDiscussion();
    return result;
  }
}
