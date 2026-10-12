import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  decodeOwnerVisibilityCommand,
  decodeOwnerVisibilityManagement,
  decodeOwnerVisibilityReceipt,
  invalidOwnerVisibility,
  matchOwnerVisibilityReceipt,
} from './contract';
import type {
  OwnerVisibilityCommand,
  OwnerVisibilityManagement,
  OwnerVisibilityReceipt,
} from './contract';
export interface OwnerPostVisibilityGateway {
  management(
    postId: string,
    cancel: Cancellation,
  ): Promise<OwnerVisibilityManagement>;
  submit(
    command: OwnerVisibilityCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<OwnerVisibilityReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<OwnerVisibilityReceipt>;
}
export class HttpOwnerPostVisibilityGateway implements OwnerPostVisibilityGateway {
  constructor(private readonly api: ApiClient) {}
  async management(
    postId: string,
    cancellation: Cancellation,
  ): Promise<OwnerVisibilityManagement> {
    if (!isUuid(postId)) invalidOwnerVisibility();
    const result = await this.api.request(
      {
        path: `/v1/me/community/posts/${postId}/owner-visibility`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeOwnerVisibilityManagement,
      },
      { cancellation },
    );
    if (result.postId !== postId) invalidOwnerVisibility();
    return result;
  }
  async submit(
    raw: OwnerVisibilityCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<OwnerVisibilityReceipt> {
    const command = decodeOwnerVisibilityCommand(raw);
    const result = await this.api.request(
      {
        path: cancelling
          ? `/v1/me/community/owner-visibility-requests/${command.clientRequestId}/cancel`
          : '/v1/me/community/owner-visibility-commands',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeOwnerVisibilityReceipt,
      },
      { cancellation, body: { ...command } },
    );
    matchOwnerVisibilityReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<OwnerVisibilityReceipt> {
    if (!uuid4(requestId)) invalidOwnerVisibility();
    const result = await this.api.request(
      {
        path: `/v1/me/community/owner-visibility-requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeOwnerVisibilityReceipt,
      },
      { cancellation },
    );
    if (result.requestId !== requestId) invalidOwnerVisibility();
    return result;
  }
}
