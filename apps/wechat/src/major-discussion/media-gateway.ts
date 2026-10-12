import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidDiscussion } from './contract';
import {
  mediaId,
  decodeMajorDiscussionImageReference,
  type MajorDiscussionImageReference,
} from './media-contract';
import {
  MAJOR_DISCUSSION_MEDIA_PROTOCOL,
  decodeMajorDiscussionMediaPrepare,
  decodeMajorDiscussionMediaStatus,
  decodeMajorDiscussionMediaRecovery,
  decodeMajorDiscussionMediaGrant,
  decodeMajorDiscussionMediaDescriptor,
  majorDiscussionMediaPrepareHash,
} from './media-contract';
import type { MajorDiscussionMediaPrepare } from './media-contract';
const prefix = '/v3/media/major-discussions';
export class HttpMajorDiscussionMediaGateway {
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
        'MajorDiscussion image management requires sign in',
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
    raw: MajorDiscussionMediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeMajorDiscussionMediaPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'MajorDiscussion image management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeMajorDiscussionMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== majorDiscussionMediaPrepareHash(actor, input)
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
      decodeMajorDiscussionMediaRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidDiscussion();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    majorId: string,
    publicationRequestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidDiscussion();
    const result = await this.call(
      `${prefix}/upload-requests/${mediaId(requestId)}/cancel`,
      'POST',
      decodeMajorDiscussionMediaRecovery,
      session,
      cancel,
      {
        protocol: MAJOR_DISCUSSION_MEDIA_PROTOCOL,
        requestHash,
        majorId: mediaId(majorId),
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
      decodeMajorDiscussionMediaStatus,
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
      decodeMajorDiscussionMediaGrant,
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
      decodeMajorDiscussionMediaStatus,
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
      decodeMajorDiscussionMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidDiscussion();
    return result;
  }
  async descriptor(
    raw: MajorDiscussionImageReference,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const r = decodeMajorDiscussionImageReference(raw);
    const result = await this.call(
      `${prefix}/majors/${r.majorId}/comments/${r.commentId}/bindings/${r.bindingId}`,
      'GET',
      decodeMajorDiscussionMediaDescriptor,
      session,
      cancel,
      undefined,
      { ordinal: String(r.ordinal) },
    );
    if (
      result.majorId !== r.majorId ||
      result.commentId !== r.commentId ||
      result.bindingId !== r.bindingId ||
      result.ordinal !== r.ordinal
    )
      invalidDiscussion();
    return result;
  }
}
