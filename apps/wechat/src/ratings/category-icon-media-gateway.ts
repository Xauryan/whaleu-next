import type { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { MediaSession } from '../media/contracts';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  CATEGORY_ICON_MEDIA_PROTOCOL,
  decodeCategoryIconDescriptor,
  type CategoryIconDescriptor,
  decodeCategoryIconGrant,
  decodeCategoryIconMediaStatus,
  decodeCategoryIconPrepare,
  decodeCategoryIconRecovery,
  categoryIconPrepareHash,
  type CategoryIconGrant,
  type CategoryIconMediaStatus,
  type CategoryIconPrepare,
  type CategoryIconRecovery,
} from './category-icon-media-contract';
import {
  decodeCategoryIconScope,
  decodeCategoryIconScopeInput,
  decodeCategoryIconScopeRecovery,
  categoryIconPrepareForScope,
  type CategoryIconScope,
  type CategoryIconScopeInput,
  type CategoryIconScopeRecovery,
} from './category-icon-upload-scope';
export interface CategoryIconMediaGateway {
  descriptor(
    categoryId: string,
    appearanceId: string,
    contextId: string,
    contextToken: string,
    purpose: 'management-preview' | 'direct-content',
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconDescriptor>;
  recoverScope(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconScopeRecovery>;
  cancelScope(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconScopeRecovery>;
  scope(
    input: CategoryIconScopeInput,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconScope>;
  prepare(
    input: CategoryIconPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconMediaStatus>;
  recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconRecovery>;
  status(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconMediaStatus>;
  grant(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconGrant>;
  finalize(
    intentId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconMediaStatus>;
  cancelRequest(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconRecovery>;
}
const prefix = '/v3/media/ratings-category-icon';
const id = (value: string) => {
  if (!ratingId(value)) invalidRating();
  return value;
};
export class HttpCategoryIconMediaGateway implements CategoryIconMediaGateway {
  constructor(private readonly api: ApiClient) {}
  private async call<T>(
    path: string,
    method: 'POST' | 'GET',
    decode: (v: unknown) => T,
    session: MediaSession,
    cancel: Cancellation,
    input?: unknown,
    query?: Record<string, string>,
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
        ...(query ? { query } : {}),
        ...(input === undefined
          ? {}
          : { body: JSON.parse(JSON.stringify(input)) as Json }),
      },
    );
    session.current();
    return result;
  }
  async descriptor(
    categoryId: string,
    appearanceId: string,
    contextId: string,
    contextToken: string,
    purpose: 'management-preview' | 'direct-content',
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconDescriptor> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(contextToken)) invalidRating();
    const result = await this.call(
      `${prefix}/categories/${id(categoryId)}/appearances/${id(appearanceId)}/descriptor`,
      'GET',
      decodeCategoryIconDescriptor,
      session,
      cancel,
      undefined,
      { contextId: id(contextId), contextToken, purpose },
    );
    if (
      result.categoryId !== categoryId ||
      result.appearanceId !== appearanceId ||
      result.contextId !== contextId ||
      result.contextToken !== contextToken
    )
      invalidRating();
    return result;
  }
  recoverScope(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconScopeRecovery> {
    return this.scopeRecovery(
      'recover',
      requestId,
      requestHash,
      session,
      cancel,
    );
  }
  cancelScope(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconScopeRecovery> {
    return this.scopeRecovery(
      'cancel',
      requestId,
      requestHash,
      session,
      cancel,
    );
  }
  private async scopeRecovery(
    action: 'recover' | 'cancel',
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconScopeRecovery> {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidRating();
    const result = await this.call(
      `/v5/ratings/category-management/upload-scopes/${action}`,
      'POST',
      decodeCategoryIconScopeRecovery,
      session,
      cancel,
      { clientRequestId: id(requestId), requestHash },
    );
    if (result.recovery && result.recovery.requestId !== requestId)
      invalidRating();
    return result;
  }
  async scope(
    raw: CategoryIconScopeInput,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconScope> {
    const input = decodeCategoryIconScopeInput(raw);
    const result = await this.call(
      '/v5/ratings/category-management/upload-scopes',
      'POST',
      decodeCategoryIconScope,
      session,
      cancel,
      input,
    );
    categoryIconPrepareForScope(input, result);
    return result;
  }
  async prepare(
    raw: CategoryIconPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconMediaStatus> {
    const input = decodeCategoryIconPrepare(raw),
      actor = session.current().credentials?.accountId;
    if (!actor)
      throw new ClientError('auth-required', 'Original account required');
    const value = await this.call(
      `${prefix}/upload-scopes`,
      'POST',
      decodeCategoryIconMediaStatus,
      session,
      cancel,
      input,
    );
    if (
      value.editScopeId !== input.editScopeId ||
      value.requestId !== input.clientRequestId ||
      value.requestHash !== categoryIconPrepareHash(actor, input)
    )
      invalidRating();
    return value;
  }
  async recover(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CategoryIconRecovery> {
    const value = await this.call(
      `${prefix}/upload-requests/${id(requestId)}`,
      'GET',
      decodeCategoryIconRecovery,
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
  ): Promise<CategoryIconMediaStatus> {
    const value = await this.call(
      `${prefix}/upload-scopes/${id(editScopeId)}`,
      'GET',
      decodeCategoryIconMediaStatus,
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
  ): Promise<CategoryIconGrant> {
    const value = await this.call(
      `${prefix}/upload-scopes/${id(editScopeId)}/grant`,
      'POST',
      decodeCategoryIconGrant,
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
  ): Promise<CategoryIconMediaStatus> {
    const value = await this.call(
      `${prefix}/upload-scopes/${id(editScopeId)}/finalize`,
      'POST',
      decodeCategoryIconMediaStatus,
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
  ): Promise<CategoryIconRecovery> {
    if (!/^[a-f0-9]{64}$/.test(requestHash)) invalidRating();
    return this.call(
      `${prefix}/upload-requests/${id(requestId)}/cancel`,
      'POST',
      decodeCategoryIconRecovery,
      session,
      cancel,
      { protocol: CATEGORY_ICON_MEDIA_PROTOCOL, requestHash },
    );
  }
}
