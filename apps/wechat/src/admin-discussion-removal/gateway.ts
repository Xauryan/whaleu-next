import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import {
  decodeAdminDiscussionRemovalTarget,
  decodeAdminDiscussionRemovalCommand,
  decodeAdminDiscussionRemovalManagement,
  decodeAdminDiscussionRemovalReceipt,
  decodeAdminDiscussionRemovalRecovery,
  invalidAdminDiscussionRemoval,
  matchAdminDiscussionRemovalReceipt,
  sameAdminDiscussionRemovalTarget,
} from './contract';
import type {
  AdminDiscussionRemovalTarget,
  AdminDiscussionRemovalCommand,
  AdminDiscussionRemovalManagement,
  AdminDiscussionRemovalReceipt,
  AdminDiscussionRemovalRecovery,
} from './contract';
export interface AdminDiscussionRemovalGateway {
  management(
    target: AdminDiscussionRemovalTarget,
    cancel: Cancellation,
  ): Promise<AdminDiscussionRemovalManagement>;
  submit(
    command: AdminDiscussionRemovalCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<AdminDiscussionRemovalReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<AdminDiscussionRemovalRecovery>;
}
export class HttpAdminDiscussionRemovalGateway implements AdminDiscussionRemovalGateway {
  constructor(private readonly api: ApiClient) {}
  async management(
    raw: AdminDiscussionRemovalTarget,
    cancellation: Cancellation,
  ): Promise<AdminDiscussionRemovalManagement> {
    const target = decodeAdminDiscussionRemovalTarget(raw);
    const result = await this.api.request(
      {
        path: '/v1/community/admin-discussion-removal/management',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAdminDiscussionRemovalManagement,
      },
      { cancellation, query: { ...target, version: '2' } },
    );
    if (!sameAdminDiscussionRemovalTarget(result.target, target))
      invalidAdminDiscussionRemoval();
    return result;
  }
  async submit(
    raw: AdminDiscussionRemovalCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<AdminDiscussionRemovalReceipt> {
    const command = decodeAdminDiscussionRemovalCommand(raw);
    const result = await this.api.request(
      {
        path: cancelling
          ? '/v1/community/admin-discussion-removal/commands/cancel'
          : '/v1/community/admin-discussion-removal/commands',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAdminDiscussionRemovalReceipt,
      },
      {
        cancellation,
        body: {
          clientRequestId: command.clientRequestId,
          expectedTargetVersion: command.expectedTargetVersion,
          action: command.action,
          ...(command.version === 2 ? { version: 2 } : {}),
          target: { ...command.target },
          ...(command.punishment
            ? {
                punishment: {
                  ...command.punishment,
                  duration: { ...command.punishment.duration },
                },
              }
            : {}),
        },
      },
    );
    matchAdminDiscussionRemovalReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<AdminDiscussionRemovalRecovery> {
    if (!uuid4(requestId)) invalidAdminDiscussionRemoval();
    const result = await this.api.request(
      {
        path: `/v1/community/admin-discussion-removal/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAdminDiscussionRemovalRecovery,
      },
      { cancellation },
    );
    if (result.state === 'recorded' && result.receipt.requestId !== requestId)
      invalidAdminDiscussionRemoval();
    return result;
  }
}
