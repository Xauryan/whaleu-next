import { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { Cancellation, Json } from '../platform/contracts';
import type { MediaSession } from '../media/contracts';
import { isUuid } from './contract';
import type { AvatarPrincipalContext } from './avatar-principal';
import {
  PROFILE_MEDIA_PROTOCOL,
  avatarDigest,
  avatarInvalid,
  decodeAvatarCatalog,
  decodeAvatarCommand,
  decodeAvatarCommandRecovery,
  decodeAvatarEditRecovery,
  decodeAvatarEditStatus,
  decodeAvatarGrant,
  decodeAvatarPrepare,
  decodeAvatarReceipt,
  decodeCurrentAvatar,
  type AvatarCatalog,
  type AvatarCommand,
  type AvatarCommandRecovery,
  type AvatarEditRecovery,
  type AvatarEditStatus,
  type AvatarGrant,
  type AvatarPrepare,
  type AvatarReceipt,
  type CurrentAvatar,
} from './avatar-contract';
export interface AvatarGateway {
  catalog(
    principal: AvatarPrincipalContext,
    cancel: Cancellation,
  ): Promise<AvatarCatalog>;
  current(
    profileId: string | null,
    principal: AvatarPrincipalContext,
    cancel: Cancellation,
  ): Promise<CurrentAvatar>;
  prepare(
    input: AvatarPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditStatus>;
  recoverEdit(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditRecovery>;
  status(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditStatus>;
  grant(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarGrant>;
  finalize(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditStatus>;
  cancelEdit(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditRecovery>;
  command(
    input: AvatarCommand,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarReceipt>;
  cancelCommand(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarCommandRecovery>;
  recoverCommand(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarCommandRecovery>;
}
const own = '/v1/me/profile';
const id = (value: string): string => {
  if (!isUuid(value)) avatarInvalid();
  return value;
};
/** No mutation auth replay and no account IDs, remote URLs or storage keys in input. */
export class HttpAvatarGateway implements AvatarGateway {
  constructor(private readonly api: ApiClient) {}
  private async read<T>(
    path: string,
    decode: (value: unknown) => T,
    principal: AvatarPrincipalContext,
    cancel: Cancellation,
    required = false,
  ): Promise<T> {
    const before = principal.current();
    if (required && before.kind !== 'session')
      throw new ClientError('auth-required', 'Sign in to edit avatar');
    const result = await this.api.request(
      {
        path,
        method: 'GET',
        authentication: required ? 'required' : 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel },
    );
    principal.current();
    return result;
  }
  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    decode: (value: unknown) => T,
    session: MediaSession,
    cancel: Cancellation,
    body?: Json,
  ): Promise<T> {
    if (!session.current().credentials)
      throw new ClientError('auth-required', 'Sign in to edit avatar');
    const result = await this.api.request(
      {
        path,
        method,
        authentication: 'required',
        authReplay: method === 'GET' ? 'once' : 'never',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(body === undefined ? {} : { body }) },
    );
    session.current();
    return result;
  }
  async catalog(
    principal: AvatarPrincipalContext,
    cancel: Cancellation,
  ): Promise<AvatarCatalog> {
    principal.current();
    const result = await this.api.request(
      {
        path: '/v1/profile-avatar-catalog',
        method: 'GET',
        authentication: 'none',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAvatarCatalog,
      },
      { cancellation: cancel },
    );
    principal.current();
    return result;
  }
  async current(
    profileId: string | null,
    principal: AvatarPrincipalContext,
    cancel: Cancellation,
  ): Promise<CurrentAvatar> {
    const result = await this.read(
      profileId === null
        ? `${own}/avatar`
        : `/v1/profiles/${id(profileId)}/avatar`,
      decodeCurrentAvatar,
      principal,
      cancel,
      profileId === null,
    );
    if (profileId !== null && result.profileId !== profileId) avatarInvalid();
    return result;
  }
  async prepare(
    raw: AvatarPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditStatus> {
    const input = decodeAvatarPrepare(raw);
    const result = await this.call(
      'POST',
      `${own}/avatar-edits`,
      decodeAvatarEditStatus,
      session,
      cancel,
      { ...input, declaration: { ...input.declaration } },
    );
    if (result.requestId !== input.clientRequestId) avatarInvalid();
    return result;
  }
  async recoverEdit(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditRecovery> {
    const result = await this.call(
      'GET',
      `${own}/avatar-edit-requests/${id(requestId)}`,
      decodeAvatarEditRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) avatarInvalid();
    return result;
  }
  async status(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditStatus> {
    const result = await this.call(
      'GET',
      `${own}/avatar-edits/${id(editId)}`,
      decodeAvatarEditStatus,
      session,
      cancel,
    );
    if (result.editId !== editId) avatarInvalid();
    return result;
  }
  async grant(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarGrant> {
    const result = await this.call(
      'POST',
      `${own}/avatar-edits/${id(editId)}/grant`,
      decodeAvatarGrant,
      session,
      cancel,
      {},
    );
    if (result.editId !== editId) avatarInvalid();
    return result;
  }
  async finalize(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditStatus> {
    const result = await this.call(
      'POST',
      `${own}/avatar-edits/${id(editId)}/finalize`,
      decodeAvatarEditStatus,
      session,
      cancel,
      {},
    );
    if (result.editId !== editId) avatarInvalid();
    return result;
  }
  async cancelEdit(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarEditRecovery> {
    if (!avatarDigest(requestHash)) avatarInvalid();
    const result = await this.call(
      'POST',
      `${own}/avatar-edit-requests/${id(requestId)}/cancel`,
      decodeAvatarEditRecovery,
      session,
      cancel,
      { protocol: PROFILE_MEDIA_PROTOCOL, requestHash },
    );
    if (
      result.requestId !== requestId ||
      (result.state === 'recorded' && result.requestHash !== requestHash)
    )
      avatarInvalid();
    return result;
  }
  async command(
    raw: AvatarCommand,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarReceipt> {
    const input = decodeAvatarCommand(raw);
    const result = await this.call(
      'POST',
      `${own}/avatar-commands`,
      decodeAvatarReceipt,
      session,
      cancel,
      { ...input, source: { ...input.source } },
    );
    if (
      result.clientRequestId !== input.clientRequestId ||
      result.resultingRevision !== input.expectedRevision + 1
    )
      avatarInvalid();
    return result;
  }
  async cancelCommand(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarCommandRecovery> {
    if (!avatarDigest(requestHash)) avatarInvalid();
    const result = await this.call(
      'POST',
      `${own}/avatar-command-requests/${id(requestId)}/cancel`,
      decodeAvatarCommandRecovery,
      session,
      cancel,
      { protocol: PROFILE_MEDIA_PROTOCOL, requestHash },
    );
    if (
      result.clientRequestId !== requestId ||
      result.state === 'not_recorded' ||
      (result.state === 'cancelled' && result.requestHash !== requestHash)
    )
      avatarInvalid();
    return result;
  }
  async recoverCommand(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<AvatarCommandRecovery> {
    const result = await this.call(
      'GET',
      `${own}/avatar-command-requests/${id(requestId)}`,
      decodeAvatarCommandRecovery,
      session,
      cancel,
    );
    if (result.clientRequestId !== requestId) avatarInvalid();
    return result;
  }
}
const unavailable = async (): Promise<never> => {
  throw new ClientError('configuration', 'Profile avatar media is unavailable');
};
export const unavailableAvatarGateway: AvatarGateway = {
  catalog: async () => ({
    protocol: PROFILE_MEDIA_PROTOCOL,
    availability: 'unavailable',
    catalogVersion: null,
    items: [],
  }),
  current: unavailable,
  prepare: unavailable,
  recoverEdit: unavailable,
  status: unavailable,
  grant: unavailable,
  finalize: unavailable,
  cancelEdit: unavailable,
  command: unavailable,
  cancelCommand: unavailable,
  recoverCommand: unavailable,
};
