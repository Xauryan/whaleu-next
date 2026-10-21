import { ApiClient } from '../api/client';
import { ClientError } from '../api/errors';
import type { Cancellation, Json } from '../platform/contracts';
import type { MediaSession } from '../media/contracts';
import { isUuid } from './contract';
import type { CoverPrincipalContext } from './cover-principal';
import {
  PROFILE_COVER_PROTOCOL,
  decodeCoverCapabilities,
  type CoverCapabilities,
  coverDigest,
  coverInvalid,
  decodeCoverCommand,
  decodeCoverCommandRecovery,
  decodeCoverEditRecovery,
  decodeCoverEditStatus,
  decodeCoverGrant,
  decodeCoverPrepare,
  decodeCoverReceipt,
  decodeCurrentCover,
  type CoverCommand,
  type CoverCommandRecovery,
  type CoverEditRecovery,
  type CoverEditStatus,
  type CoverGrant,
  type CoverPrepare,
  type CoverReceipt,
  type CurrentCover,
} from './cover-contract';
export interface CoverGateway {
  capabilities(
    principal: CoverPrincipalContext,
    cancel: Cancellation,
  ): Promise<CoverCapabilities>;
  current(
    profileId: string | null,
    principal: CoverPrincipalContext,
    cancel: Cancellation,
  ): Promise<CurrentCover>;
  prepare(
    input: CoverPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditStatus>;
  recoverEdit(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditRecovery>;
  status(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditStatus>;
  grant(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverGrant>;
  finalize(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditStatus>;
  cancelEdit(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditRecovery>;
  command(
    input: CoverCommand,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverReceipt>;
  cancelCommand(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverCommandRecovery>;
  recoverCommand(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverCommandRecovery>;
}
const own = '/v1/me/profile';
const id = (value: string): string => {
  if (!isUuid(value)) coverInvalid();
  return value;
};
/** No mutation auth replay and no account IDs, remote URLs or storage keys in input. */
export class HttpCoverGateway implements CoverGateway {
  constructor(private readonly api: ApiClient) {}
  capabilities(
    principal: CoverPrincipalContext,
    cancel: Cancellation,
  ): Promise<CoverCapabilities> {
    return this.read(
      `${own}/cover-capabilities`,
      decodeCoverCapabilities,
      principal,
      cancel,
      true,
    );
  }
  private async read<T>(
    path: string,
    decode: (value: unknown) => T,
    principal: CoverPrincipalContext,
    cancel: Cancellation,
    required = false,
  ): Promise<T> {
    const before = principal.current();
    if (required && before.kind !== 'session')
      throw new ClientError('auth-required', 'Sign in to edit cover');
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
      throw new ClientError('auth-required', 'Sign in to edit cover');
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
  async current(
    profileId: string | null,
    principal: CoverPrincipalContext,
    cancel: Cancellation,
  ): Promise<CurrentCover> {
    const result = await this.read(
      profileId === null
        ? `${own}/cover`
        : `/v1/profiles/${id(profileId)}/cover`,
      decodeCurrentCover,
      principal,
      cancel,
      profileId === null,
    );
    if (profileId !== null && result.profileId !== profileId) coverInvalid();
    return result;
  }
  async prepare(
    raw: CoverPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditStatus> {
    const input = decodeCoverPrepare(raw);
    const result = await this.call(
      'POST',
      `${own}/cover-edits`,
      decodeCoverEditStatus,
      session,
      cancel,
      { ...input, declaration: { ...input.declaration } },
    );
    if (result.requestId !== input.clientRequestId) coverInvalid();
    return result;
  }
  async recoverEdit(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditRecovery> {
    const result = await this.call(
      'GET',
      `${own}/cover-edit-requests/${id(requestId)}`,
      decodeCoverEditRecovery,
      session,
      cancel,
    );
    if (result.requestId !== requestId) coverInvalid();
    return result;
  }
  async status(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditStatus> {
    const result = await this.call(
      'GET',
      `${own}/cover-edits/${id(editId)}`,
      decodeCoverEditStatus,
      session,
      cancel,
    );
    if (result.editId !== editId) coverInvalid();
    return result;
  }
  async grant(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverGrant> {
    const result = await this.call(
      'POST',
      `${own}/cover-edits/${id(editId)}/grant`,
      decodeCoverGrant,
      session,
      cancel,
      {},
    );
    if (result.editId !== editId) coverInvalid();
    return result;
  }
  async finalize(
    editId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditStatus> {
    const result = await this.call(
      'POST',
      `${own}/cover-edits/${id(editId)}/finalize`,
      decodeCoverEditStatus,
      session,
      cancel,
      {},
    );
    if (result.editId !== editId) coverInvalid();
    return result;
  }
  async cancelEdit(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverEditRecovery> {
    if (!coverDigest(requestHash)) coverInvalid();
    const result = await this.call(
      'POST',
      `${own}/cover-edit-requests/${id(requestId)}/cancel`,
      decodeCoverEditRecovery,
      session,
      cancel,
      { protocol: PROFILE_COVER_PROTOCOL, requestHash },
    );
    if (
      result.requestId !== requestId ||
      (result.state === 'recorded' && result.requestHash !== requestHash)
    )
      coverInvalid();
    return result;
  }
  async command(
    raw: CoverCommand,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverReceipt> {
    const input = decodeCoverCommand(raw);
    const result = await this.call(
      'POST',
      `${own}/cover-commands`,
      decodeCoverReceipt,
      session,
      cancel,
      { ...input, source: { ...input.source } },
    );
    if (
      result.clientRequestId !== input.clientRequestId ||
      result.resultingRevision !== input.expectedRevision + 1
    )
      coverInvalid();
    return result;
  }
  async cancelCommand(
    requestId: string,
    requestHash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverCommandRecovery> {
    if (!coverDigest(requestHash)) coverInvalid();
    const result = await this.call(
      'POST',
      `${own}/cover-command-requests/${id(requestId)}/cancel`,
      decodeCoverCommandRecovery,
      session,
      cancel,
      { protocol: PROFILE_COVER_PROTOCOL, requestHash },
    );
    if (
      result.clientRequestId !== requestId ||
      result.state === 'not_recorded' ||
      (result.state === 'cancelled' && result.requestHash !== requestHash)
    )
      coverInvalid();
    return result;
  }
  async recoverCommand(
    requestId: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<CoverCommandRecovery> {
    const result = await this.call(
      'GET',
      `${own}/cover-command-requests/${id(requestId)}`,
      decodeCoverCommandRecovery,
      session,
      cancel,
    );
    if (result.clientRequestId !== requestId) coverInvalid();
    return result;
  }
}
const unavailable = async (): Promise<never> => {
  throw new ClientError('configuration', 'Profile cover media is unavailable');
};
export const unavailableCoverGateway: CoverGateway = {
  capabilities: async () => ({
    protocol: PROFILE_COVER_PROTOCOL,
    upload: 'unavailable',
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
