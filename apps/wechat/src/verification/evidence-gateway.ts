import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import {
  verificationEvidenceUuid,
  verificationEvidenceRevision,
  invalidVerificationEvidence,
} from './evidence-validation';
import type { VerificationEvidenceReadTarget } from './evidence-download';
import {
  VERIFICATION_EVIDENCE_MEDIA_PROTOCOL,
  decodeVerificationEvidencePrepare,
  decodeVerificationEvidenceStatus,
  decodeVerificationEvidenceRecovery,
  decodeVerificationEvidenceGrant,
  decodeVerificationEvidenceDescriptor,
  verificationEvidencePrepareHash,
} from './evidence-contract';
import type { VerificationEvidencePrepare } from './evidence-contract';
const prefix = '/v3/media/verification-evidence';
export class HttpVerificationEvidenceGateway {
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
        'Private evidence requires sign in',
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
    raw: VerificationEvidencePrepare,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const input = decodeVerificationEvidencePrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError(
        'auth-required',
        'Private evidence requires sign in',
      );
    const result = await this.call(
      `${prefix}/upload-intents`,
      'POST',
      decodeVerificationEvidenceStatus,
      session,
      cancel,
      input,
    );
    if (
      result.requestId !== input.clientRequestId ||
      result.requestHash !== verificationEvidencePrepareHash(actor, input)
    )
      invalidVerificationEvidence();
    return result;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-requests/${verificationEvidenceUuid(requestId)}`,
      'GET',
      decodeVerificationEvidenceRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) invalidVerificationEvidence();
    return result;
  }
  async cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidVerificationEvidence();
    const result = await this.call(
      `${prefix}/upload-requests/${verificationEvidenceUuid(requestId)}/cancel`,
      'POST',
      decodeVerificationEvidenceRecovery,
      session,
      cancel,
      { protocol: VERIFICATION_EVIDENCE_MEDIA_PROTOCOL, requestHash },
    );
    if (result.requestId !== requestId || result.requestHash !== requestHash)
      invalidVerificationEvidence();
    return result;
  }
  async status(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${verificationEvidenceUuid(intentId)}`,
      'GET',
      decodeVerificationEvidenceStatus,
      session,
      cancel,
    );
    if (result.intentId !== intentId) invalidVerificationEvidence();
    return result;
  }
  async grant(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${verificationEvidenceUuid(intentId)}/grant`,
      'POST',
      decodeVerificationEvidenceGrant,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidVerificationEvidence();
    return result;
  }
  async finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    const result = await this.call(
      `${prefix}/upload-intents/${verificationEvidenceUuid(intentId)}/finalize`,
      'POST',
      decodeVerificationEvidenceStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidVerificationEvidence();
    return result;
  }
  async cancel(intentId: string, session: MediaSession, cancel: Cancellation) {
    const result = await this.call(
      `${prefix}/upload-intents/${verificationEvidenceUuid(intentId)}/cancel`,
      'POST',
      decodeVerificationEvidenceStatus,
      session,
      cancel,
      {},
    );
    if (result.intentId !== intentId) invalidVerificationEvidence();
    return result;
  }
  async descriptor(
    target: VerificationEvidenceReadTarget,
    revision: number,
    session: MediaSession,
    cancel: Cancellation,
  ) {
    verificationEvidenceRevision(revision);
    const result = await this.call(
      `${prefix}/applications/${verificationEvidenceUuid(target.applicationId)}/descriptor`,
      'GET',
      decodeVerificationEvidenceDescriptor,
      session,
      cancel,
      undefined,
      {
        revision: String(revision),
        ...(target.reviewRegionId === null
          ? {}
          : {
              reviewRegionId: verificationEvidenceUuid(target.reviewRegionId),
            }),
      },
    );
    if (
      result.revision !== revision ||
      result.applicationId !== target.applicationId
    )
      invalidVerificationEvidence();
    return result;
  }
}
