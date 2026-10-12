import type { ApiClient } from '../api/client';
import { uuid4 } from '../community/contract';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  decodeReclassificationCommand,
  decodeCategoryManagement,
  decodeReclassificationReceipt,
  decodeReclassificationRecovery,
  invalidReclassification,
  matchReclassificationReceipt,
} from './contract';
import type {
  ReclassificationCommand,
  CategoryManagement,
  ReclassificationReceipt,
  ReclassificationRecovery,
} from './contract';
export interface CategoryReclassificationGateway {
  management(postId: string, cancel: Cancellation): Promise<CategoryManagement>;
  submit(
    command: ReclassificationCommand,
    cancel: Cancellation,
    cancelling?: boolean,
  ): Promise<ReclassificationReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<ReclassificationRecovery>;
}
export class HttpCategoryReclassificationGateway implements CategoryReclassificationGateway {
  constructor(private readonly api: ApiClient) {}
  async management(
    postId: string,
    cancellation: Cancellation,
  ): Promise<CategoryManagement> {
    if (!isUuid(postId)) invalidReclassification();
    const result = await this.api.request(
      {
        path: `/v1/community/posts/${postId}/category-management`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeCategoryManagement,
      },
      { cancellation },
    );
    if (result.postId !== postId) invalidReclassification();
    return result;
  }
  async submit(
    raw: ReclassificationCommand,
    cancellation: Cancellation,
    cancelling = false,
  ): Promise<ReclassificationReceipt> {
    const command = decodeReclassificationCommand(raw);
    const result = await this.api.request(
      {
        path: cancelling
          ? `/v1/community/category-requests/${command.clientRequestId}/cancel`
          : '/v1/community/category-commands',
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeReclassificationReceipt,
      },
      { cancellation, body: { ...command } },
    );
    matchReclassificationReceipt(command, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<ReclassificationRecovery> {
    if (!uuid4(requestId)) invalidReclassification();
    const result = await this.api.request(
      {
        path: `/v1/community/category-requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodeReclassificationRecovery,
      },
      { cancellation },
    );
    if (result.state === 'recorded' && result.receipt.requestId !== requestId)
      invalidReclassification();
    return result;
  }
}
