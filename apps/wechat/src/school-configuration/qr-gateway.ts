import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import {
  schoolUuid,
  schoolKey,
  schoolRevision,
  invalidSchool,
} from './contract';
import type { SchoolEntryKey } from './contract';
import type { SchoolQrReadTarget } from './qr-download';
import {
  SCHOOL_QR_MEDIA_PROTOCOL,
  decodeSchoolQrPrepare,
  decodeSchoolQrStatus,
  decodeSchoolQrRecovery,
  decodeSchoolQrGrant,
  decodeSchoolQrDescriptor,
  schoolQrPrepareHash,
} from './qr-contract';
import type { SchoolQrPrepare } from './qr-contract';
const prefix = '/v3/media/school-configuration';
export class HttpSchoolQrMediaGateway {
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
        'School QR management requires sign in',
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
    raw: SchoolQrPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeSchoolQrPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'School QR management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeSchoolQrStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== schoolQrPrepareHash(actor, input)
    )
      invalidSchool();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${schoolUuid(requestId)}`,
      'GET',
      decodeSchoolQrRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidSchool();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidSchool();
    const result = await this.call(
      `${prefix}/upload-requests/${schoolUuid(requestId)}/cancel`,
      'POST',
      decodeSchoolQrRecovery,
      session,
      cancel,
      { protocol: SCHOOL_QR_MEDIA_PROTOCOL, requestHash },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalidSchool();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${schoolUuid(intentId)}`,
      'GET',
      decodeSchoolQrStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalidSchool();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${schoolUuid(intentId)}/grant`,
      'POST',
      decodeSchoolQrGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidSchool();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${schoolUuid(intentId)}/finalize`,
      'POST',
      decodeSchoolQrStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidSchool();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${schoolUuid(intentId)}/cancel`,
      'POST',
      decodeSchoolQrStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidSchool();
    return result;
  }
  async descriptor(
    target: SchoolQrReadTarget,
    key: SchoolEntryKey,
    entryRevision: number,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    schoolKey(key);
    if (!schoolRevision(entryRevision)) invalidSchool();
    const publicRead = 'campusId' in target;
    if (
      (publicRead && key === 'review') ||
      ('orderId' in target && key !== 'errand')
    )
      invalidSchool();
    const path = publicRead
      ? `${prefix}/entries/${key}/descriptor`
      : 'orderId' in target
        ? `${prefix}/errands/${schoolUuid(target.orderId)}/descriptor`
        : `${prefix}/management/regions/${schoolUuid(target.regionId)}/entries/${key}/descriptor`;
    const result = await this.call(
      path,
      'GET',
      decodeSchoolQrDescriptor,
      session,
      cancel,
      undefined,
      {
        entryRevision: String(entryRevision),
        ...(publicRead ? { campusId: schoolUuid(target.campusId) } : {}),
      },
      publicRead,
    );
    if (
      result.entryKey !== key ||
      result.entryRevision !== entryRevision ||
      (!publicRead &&
        result.regionId !==
          ('orderId' in target
            ? schoolUuid(target.targetRegionId)
            : target.regionId))
    )
      invalidSchool();
    return result;
  }
}
