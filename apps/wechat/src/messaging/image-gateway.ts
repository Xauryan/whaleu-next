import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import { id, invalid } from './contract';
const imageUuid = (v: unknown): string => (id(v) ? v : invalid());
import {
  PRIVATE_MESSAGE_MEDIA_PROTOCOL,
  decodePrivateMessageMediaPrepare,
  decodePrivateMessageMediaStatus,
  decodePrivateMessageMediaRecovery,
  decodePrivateMessageMediaGrant,
  privateMessageMediaPrepareHash,
} from './image-contract';
import type { PrivateMessageMediaPrepare } from './image-contract';
const prefix = '/v3/media/private-messages';
export class HttpPrivateMessageMediaGateway {
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
        'Private message image management requires sign in',
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
    raw: PrivateMessageMediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodePrivateMessageMediaPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'Private message image management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodePrivateMessageMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== privateMessageMediaPrepareHash(actor, input)
    )
      invalid();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${imageUuid(requestId)}`,
      'GET',
      decodePrivateMessageMediaRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalid();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    conversationId: string,
    messageRequestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalid();
    const result = await this.call(
      `${prefix}/upload-requests/${imageUuid(requestId)}/cancel`,
      'POST',
      decodePrivateMessageMediaRecovery,
      session,
      cancel,
      {
        protocol: PRIVATE_MESSAGE_MEDIA_PROTOCOL,
        requestHash,
        conversationId: imageUuid(conversationId),
        messageRequestId: imageUuid(messageRequestId),
      },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalid();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${imageUuid(intentId)}`,
      'GET',
      decodePrivateMessageMediaStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalid();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${imageUuid(intentId)}/grant`,
      'POST',
      decodePrivateMessageMediaGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalid();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${imageUuid(intentId)}/finalize`,
      'POST',
      decodePrivateMessageMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalid();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${imageUuid(intentId)}/cancel`,
      'POST',
      decodePrivateMessageMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalid();
    return result;
  }
}
