import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import {
  organizationMediaUuid,
  organizationMediaSlot,
  organizationMediaRevision,
  invalidOrganizationMedia,
} from './media-validation';
import type { OrganizationMediaSlot } from './media-validation';
import type { OrganizationMediaReadTarget } from './media-download';
import {
  ORGANIZATION_MEDIA_PROTOCOL,
  decodeOrganizationMediaPrepare,
  decodeOrganizationMediaStatus,
  decodeOrganizationMediaRecovery,
  decodeOrganizationMediaGrant,
  decodeOrganizationMediaDescriptor,
  organizationMediaPrepareHash,
} from './media-contract';
import type { OrganizationMediaPrepare } from './media-contract';
const prefix = '/v3/media/organizations';
export class HttpOrganizationMediaGateway {
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
        'Organization image management requires sign in',
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
    raw: OrganizationMediaPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeOrganizationMediaPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'Organization image management requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeOrganizationMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== organizationMediaPrepareHash(actor, input)
    )
      invalidOrganizationMedia();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${organizationMediaUuid(requestId)}`,
      'GET',
      decodeOrganizationMediaRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidOrganizationMedia();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidOrganizationMedia();
    const result = await this.call(
      `${prefix}/upload-requests/${organizationMediaUuid(requestId)}/cancel`,
      'POST',
      decodeOrganizationMediaRecovery,
      session,
      cancel,
      { protocol: ORGANIZATION_MEDIA_PROTOCOL, requestHash },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalidOrganizationMedia();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${organizationMediaUuid(intentId)}`,
      'GET',
      decodeOrganizationMediaStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalidOrganizationMedia();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${organizationMediaUuid(intentId)}/grant`,
      'POST',
      decodeOrganizationMediaGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidOrganizationMedia();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${organizationMediaUuid(intentId)}/finalize`,
      'POST',
      decodeOrganizationMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidOrganizationMedia();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${organizationMediaUuid(intentId)}/cancel`,
      'POST',
      decodeOrganizationMediaStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidOrganizationMedia();
    return result;
  }
  async descriptor(
    target: OrganizationMediaReadTarget,
    key: OrganizationMediaSlot,
    applicationRevision: number,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    organizationMediaSlot(key);
    organizationMediaRevision(applicationRevision);
    if (target.audience !== 'public' && target.audience !== 'management')
      invalidOrganizationMedia();
    if (target.audience === 'public' && key === 'managerContact')
      invalidOrganizationMedia();
    const path = `${prefix}/${target.audience}/organizations/${organizationMediaUuid(target.organizationId)}/slots/${key}/descriptor`;
    const result = await this.call(
      path,
      'GET',
      decodeOrganizationMediaDescriptor,
      session,
      cancel,
      undefined,
      { applicationRevision: String(applicationRevision) },
    );
    if (
      result.slot !== key ||
      result.applicationRevision !== applicationRevision ||
      result.organizationId !== target.organizationId
    )
      invalidOrganizationMedia();
    return result;
  }
}
