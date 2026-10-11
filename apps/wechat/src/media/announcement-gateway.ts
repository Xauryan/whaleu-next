import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from './contracts';
import type { Cancellation, Json } from '../platform/contracts';
import {
  announcementMediaUuid,
  announcementMediaSlot,
  announcementMediaRevision,
  invalidAnnouncementMedia,
} from './announcement-validation';
import type { AnnouncementMediaSlot } from './announcement-validation';
import type { AnnouncementMediaReadTarget } from './announcement-download';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  decodeAnnouncementMediaPrepare,
  decodeAnnouncementMediaStatus,
  decodeAnnouncementMediaRecovery,
  decodeAnnouncementMediaGrant,
  decodeAnnouncementMediaDescriptor,
  announcementMediaPrepareHash,
} from './announcement-contract';
import type { AnnouncementMediaPrepare } from './announcement-contract';
const prefix = '/v3/media/announcements';
export class HttpAnnouncementMediaGateway {
  constructor(private readonly api: ApiClient) {}
  private async call<T>(
    path: string,
    method: 'GET' | 'POST',
    decode: (value: unknown) => T,
    session: MediaSession,
    cancel: Cancellation,
    input?: unknown,
    query?: Record<string, string>,
    optional = false,
  ) {
    if (!optional && !session.current().credentials)
      throw new ClientError(
        'auth-required',
        'Announcement image management requires sign in',
      );
    const result = await this.api.request(
      {
        path,
        method,
        decode,
        authentication: optional ? 'optional' : 'required',
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
    raw: AnnouncementMediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeAnnouncementMediaPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'Announcement image management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeAnnouncementMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== announcementMediaPrepareHash(actor, input)
    )
      invalidAnnouncementMedia();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${announcementMediaUuid(requestId)}`,
      'GET',
      decodeAnnouncementMediaRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidAnnouncementMedia();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidAnnouncementMedia();
    const result = await this.call(
      `${prefix}/upload-requests/${announcementMediaUuid(requestId)}/cancel`,
      'POST',
      decodeAnnouncementMediaRecovery,
      session,
      cancel,
      { protocol: ANNOUNCEMENT_MEDIA_PROTOCOL, requestHash },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalidAnnouncementMedia();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${announcementMediaUuid(intentId)}`,
      'GET',
      decodeAnnouncementMediaStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalidAnnouncementMedia();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${announcementMediaUuid(intentId)}/grant`,
      'POST',
      decodeAnnouncementMediaGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidAnnouncementMedia();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${announcementMediaUuid(intentId)}/finalize`,
      'POST',
      decodeAnnouncementMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidAnnouncementMedia();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${announcementMediaUuid(intentId)}/cancel`,
      'POST',
      decodeAnnouncementMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidAnnouncementMedia();
    return result;
  }
  async descriptor(
    target: AnnouncementMediaReadTarget,
    key: AnnouncementMediaSlot,
    revision: number,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    announcementMediaSlot(key);
    announcementMediaRevision(revision);
    if (target.audience !== 'public' && target.audience !== 'management')
      invalidAnnouncementMedia();
    if (target.audience === 'management' && target.campusId !== null)
      invalidAnnouncementMedia();
    const path = `${prefix}/${target.audience}/announcements/${announcementMediaUuid(target.announcementId)}/slots/${key}/descriptor`;
    const result = await this.call(
      path,
      'GET',
      decodeAnnouncementMediaDescriptor,
      session,
      cancel,
      undefined,
      {
        revision: String(revision),
        ...(target.campusId === null
          ? {}
          : { campusId: announcementMediaUuid(target.campusId) }),
      },
      target.audience === 'public',
    );
    if (
      result.slot !== key ||
      result.revision !== revision ||
      result.announcementId !== target.announcementId
    )
      invalidAnnouncementMedia();
    return result;
  }
}
