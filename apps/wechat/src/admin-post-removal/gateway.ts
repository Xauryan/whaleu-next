import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import {
  decodeAdminPostRemovalTarget,
  decodeAdminPostRemovalCommand,
  decodeAdminPostRemovalManagement,
  decodeAdminPostRemovalReceipt,
  decodeAdminPostRemovalRecovery,
  invalidAdminPostRemoval,
  matchAdminPostRemovalReceipt,
  sameAdminPostRemovalTarget,
} from './contract';
import type {
  AdminPostRemovalTarget,
  AdminPostRemovalCommand,
  AdminPostRemovalManagement,
  AdminPostRemovalReceipt,
  AdminPostRemovalRecovery,
} from './contract';
export interface AdminPostRemovalGateway {
  management(
    target: AdminPostRemovalTarget,
    cancel: Cancellation,
  ): Promise<AdminPostRemovalManagement>;
  submit(
    command: AdminPostRemovalCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<AdminPostRemovalReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<AdminPostRemovalRecovery>;
}
export class HttpAdminPostRemovalGateway implements AdminPostRemovalGateway {
  constructor(private readonly api: ApiClient) {}
  async management(
    raw: AdminPostRemovalTarget,
    cancellation: Cancellation,
  ): Promise<AdminPostRemovalManagement> {
    const target = decodeAdminPostRemovalTarget(raw);
    const result = await this.api.request(
      {
        path: '/v1/community/admin-post-removal/management',
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAdminPostRemovalManagement,
      },
      { cancellation, query: { ...target } },
    );
    if (!sameAdminPostRemovalTarget(result.target, target))
      invalidAdminPostRemoval();
    return result;
  }
  async submit(
    raw: AdminPostRemovalCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<AdminPostRemovalReceipt> {
    const command = decodeAdminPostRemovalCommand(raw);
    const result = await this.api.request(
      {
        path: cancelling
          ? '/v1/community/admin-post-removal/commands/cancel'
          : '/v1/community/admin-post-removal/commands',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAdminPostRemovalReceipt,
      },
      { cancellation, body: { ...command, target: { ...command.target } } },
    );
    matchAdminPostRemovalReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<AdminPostRemovalRecovery> {
    if (!uuid4(requestId)) invalidAdminPostRemoval();
    const result = await this.api.request(
      {
        path: `/v1/community/admin-post-removal/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeAdminPostRemovalRecovery,
      },
      { cancellation },
    );
    if (result.state === 'recorded' && result.receipt.requestId !== requestId)
      invalidAdminPostRemoval();
    return result;
  }
}
