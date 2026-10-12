import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import {
  decodeProfileModerationTarget,
  decodeProfileModerationCommand,
  decodeProfileModerationManagement,
  decodeProfileModerationReceipt,
  decodeProfileModerationRecovery,
  invalidProfileModeration,
  matchProfileModerationReceipt,
  sameProfileModerationTarget,
} from './contract';
import type {
  ProfileModerationTarget,
  ProfileModerationCommand,
  ProfileModerationManagement,
  ProfileModerationReceipt,
  ProfileModerationRecovery,
} from './contract';
export interface ProfileModerationGateway {
  management(
    target: ProfileModerationTarget,
    cancel: Cancellation,
  ): Promise<ProfileModerationManagement>;
  submit(
    command: ProfileModerationCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<ProfileModerationReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<ProfileModerationRecovery>;
}
export class HttpProfileModerationGateway implements ProfileModerationGateway {
  constructor(private readonly api: ApiClient) {}
  async management(
    raw: ProfileModerationTarget,
    cancellation: Cancellation,
  ): Promise<ProfileModerationManagement> {
    const target = decodeProfileModerationTarget(raw);
    const result = await this.api.request(
      {
        path: '/v1/community/profile-moderation/management',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeProfileModerationManagement,
      },
      { cancellation, query: { ...target } },
    );
    if (!sameProfileModerationTarget(result.target, target))
      invalidProfileModeration();
    return result;
  }
  async submit(
    raw: ProfileModerationCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<ProfileModerationReceipt> {
    const command = decodeProfileModerationCommand(raw);
    const result = await this.api.request(
      {
        path: cancelling
          ? '/v1/community/profile-moderation/commands/cancel'
          : '/v1/community/profile-moderation/commands',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeProfileModerationReceipt,
      },
      { cancellation, body: { ...command, target: { ...command.target } } },
    );
    matchProfileModerationReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<ProfileModerationRecovery> {
    if (!uuid4(requestId)) invalidProfileModeration();
    const result = await this.api.request(
      {
        path: `/v1/community/profile-moderation/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeProfileModerationRecovery,
      },
      { cancellation },
    );
    if (result.state === 'recorded' && result.receipt.requestId !== requestId)
      invalidProfileModeration();
    return result;
  }
}
