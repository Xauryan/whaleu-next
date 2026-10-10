import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  RATINGS_MEDIA_PROTOCOL,
  decodeRatingCoverGrant,
  decodeRatingCoverMediaStatus,
  decodeRatingCoverPrepare,
  decodeRatingCoverRecovery,
  ratingCoverPrepareHash,
  type RatingCoverGrant,
  type RatingCoverMediaStatus,
  type RatingCoverPrepare,
  type RatingCoverRecovery,
} from './target-cover-media-contract';
import {
  decodeRatingCoverScope,
  decodeRatingCoverScopeInput,
  decodeRatingCoverScopeCancellation,
  matchRatingCoverScope,
  ratingCoverScopeIdentity,
  type RatingCoverScopeCancellation,
  type RatingCoverScope,
  type RatingCoverScopeInput,
} from './target-cover-upload-scope';
export interface RatingCoverMediaGateway {
  cancelScope(
    input: RatingCoverScopeInput,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverScopeCancellation>;
  scope(
    input: RatingCoverScopeInput,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverScope>;
  prepare(
    input: RatingCoverPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverMediaStatus>;
  recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverRecovery>;
  status(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverMediaStatus>;
  grant(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverGrant>;
  finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverMediaStatus>;
  cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverRecovery>;
}
const prefix = '/v3/media/ratings-target';
const id = (value: string) => {
  if (!ratingId(value)) invalidRating();
  return value;
};
export class HttpRatingCoverMediaGateway implements RatingCoverMediaGateway {
  constructor(private readonly api: ApiClient) {}
  private async call<T>(
    path: string,
    method: 'POST' | 'GET',
    decode: (v: unknown) => T,
    session: MediaSession,
    cancel: Cancellation,
    input?: unknown,
  ): Promise<T> {
    if (!session.current().credentials)
      throw new ClientError('auth-required', 'Ratings media requires sign in');
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
      },
    );
    session.current();
    return result;
  }
  async cancelScope(
    raw: RatingCoverScopeInput,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverScopeCancellation> {
    const input = decodeRatingCoverScopeInput(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Original account required');
    return this.call(
      '/v3/ratings/target-cover/upload-scopes/cancel',
      'POST',
      (value) => decodeRatingCoverScopeCancellation(value, actor, input),
      session,
      cancel,
      input,
    );
  }
  async scope(
    raw: RatingCoverScopeInput,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverScope> {
    const input = decodeRatingCoverScopeInput(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Original account required');
    const expected = ratingCoverScopeIdentity(actor, input);
    const result = await this.call(
      '/v3/ratings/target-cover/upload-scopes',
      'POST',
      decodeRatingCoverScope,
      session,
      cancel,
      input,
    );
    matchRatingCoverScope(input, result);
    if (
      result.scopeId !== expected.scopeId ||
      result.scopeRevision !== expected.scopeRevision
    )
      invalidRating();
    return result;
  }
  async prepare(
    raw: RatingCoverPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverMediaStatus> {
    const input = decodeRatingCoverPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Original account required');
    const value = await this.call(
      `${prefix}/upload-scopes`,
      'POST',
      decodeRatingCoverMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      value.editScopeId !== input.editScopeId ||
      value.requestId !== input.clientRequestId ||
      value.requestHash !== ratingCoverPrepareHash(actor, input)
    )
      invalidRating();
    return value;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverRecovery> {
    const value = await this.call(
      `${prefix}/upload-requests/${id(requestId)}`,
      'GET',
      decodeRatingCoverRecovery,
      session,
      cancel,
    );
    if (value.requestId !== requestId) invalidRating();
    return value;
  }
  async status(
    editScopeId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverMediaStatus> {
    const value = await this.call(
      `${prefix}/upload-scopes/${id(editScopeId)}`,
      'GET',
      decodeRatingCoverMediaStatus,
      session,
      cancel,
    );
    if (value.editScopeId !== editScopeId) invalidRating();
    return value;
  }
  async grant(
    editScopeId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverGrant> {
    const value = await this.call(
      `${prefix}/upload-scopes/${id(editScopeId)}/grant`,
      'POST',
      decodeRatingCoverGrant,
      session,
      cancel,
      {},
    );
    if (value.editScopeId !== editScopeId) invalidRating();
    return value;
  }
  async finalize(
    editScopeId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverMediaStatus> {
    const value = await this.call(
      `${prefix}/upload-scopes/${id(editScopeId)}/finalize`,
      'POST',
      decodeRatingCoverMediaStatus,
      session,
      cancel,
      {},
    );
    if (value.editScopeId !== editScopeId) invalidRating();
    return value;
  }
  cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<RatingCoverRecovery> {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidRating();
    return this.call(
      `${prefix}/upload-requests/${id(requestId)}/cancel`,
      'POST',
      decodeRatingCoverRecovery,
      session,
      cancel,
      { protocol: RATINGS_MEDIA_PROTOCOL, requestHash },
    );
  }
}
