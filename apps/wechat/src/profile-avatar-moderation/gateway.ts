import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import {
  decodeProfileAvatarModerationTarget,
  decodeProfileAvatarModerationCommand,
  decodeProfileAvatarModerationManagement,
  decodeProfileAvatarModerationReceipt,
  decodeProfileAvatarModerationRecovery,
  invalidProfileAvatarModeration,
  matchProfileAvatarModerationReceipt,
  sameProfileAvatarModerationTarget,
} from './contract';
import type {
  ProfileAvatarModerationTarget,
  ProfileAvatarModerationCommand,
  ProfileAvatarModerationManagement,
  ProfileAvatarModerationReceipt,
  ProfileAvatarModerationRecovery,
} from './contract';
export interface ProfileAvatarModerationGateway {
  management(
    target: ProfileAvatarModerationTarget,
    cancel: Cancellation,
  ): Promise<ProfileAvatarModerationManagement>;
  submit(
    command: ProfileAvatarModerationCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<ProfileAvatarModerationReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<ProfileAvatarModerationRecovery>;
}
export class HttpProfileAvatarModerationGateway implements ProfileAvatarModerationGateway {
  constructor(private readonly api: ApiClient) {}
  async management(
    raw: ProfileAvatarModerationTarget,
    cancellation: Cancellation,
  ): Promise<ProfileAvatarModerationManagement> {
    const target = decodeProfileAvatarModerationTarget(raw);
    const result = await this.api.request(
      {
        path: '/v1/community/profile-avatar-moderation/management',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeProfileAvatarModerationManagement,
      },
      { cancellation, query: { ...target } },
    );
    if (!sameProfileAvatarModerationTarget(result.target, target))
      invalidProfileAvatarModeration();
    return result;
  }
  async submit(
    raw: ProfileAvatarModerationCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<ProfileAvatarModerationReceipt> {
    const command = decodeProfileAvatarModerationCommand(raw);
    const result = await this.api.request(
      {
        path: cancelling
          ? '/v1/community/profile-avatar-moderation/commands/cancel'
          : '/v1/community/profile-avatar-moderation/commands',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeProfileAvatarModerationReceipt,
      },
      { cancellation, body: { ...command, target: { ...command.target } } },
    );
    matchProfileAvatarModerationReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<ProfileAvatarModerationRecovery> {
    if (!uuid4(requestId)) invalidProfileAvatarModeration();
    const result = await this.api.request(
      {
        path: `/v1/community/profile-avatar-moderation/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeProfileAvatarModerationRecovery,
      },
      { cancellation },
    );
    if (result.state === 'recorded' && result.receipt.requestId !== requestId)
      invalidProfileAvatarModeration();
    return result;
  }
}
