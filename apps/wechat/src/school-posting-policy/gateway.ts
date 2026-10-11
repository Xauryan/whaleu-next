import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodePostingPolicyCommand,
  decodePostingPolicyView,
  decodePostingPolicyReceipt,
  decodePostingPolicyRecovery,
  postingPolicyUuid,
  postingPolicyRequestId,
  postingPolicyHash,
  invalidPostingPolicy,
} from './contract';
import type {
  PostingPolicyCommand,
  PostingPolicyView,
  PostingPolicyReceipt,
  PostingPolicyRecovery,
} from './contract';
export interface SchoolPostingPolicyGateway {
  management(
    regionId: string | null,
    cancel: Cancellation,
  ): Promise<PostingPolicyView>;
  save(
    regionId: string,
    command: PostingPolicyCommand,
    cancel: Cancellation,
  ): Promise<PostingPolicyReceipt>;
  recover(
    requestId: string,
    cancel: Cancellation,
  ): Promise<PostingPolicyRecovery>;
  cancel(
    requestId: string,
    requestHash: string,
    cancel: Cancellation,
  ): Promise<PostingPolicyRecovery>;
}
export class HttpSchoolPostingPolicyGateway implements SchoolPostingPolicyGateway {
  constructor(private readonly api: ApiClient) {}
  async management(regionId: string | null, cancel: Cancellation) {
    if (regionId !== null) postingPolicyUuid(regionId);
    const result = await this.api.request(
      {
        path: '/v1/me/school-posting-policy',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePostingPolicyView,
      },
      { query: regionId === null ? {} : { regionId }, cancellation: cancel },
    );
    if (regionId !== null && result.context.regionId !== regionId)
      invalidPostingPolicy();
    return result;
  }
  async save(
    regionId: string,
    command: PostingPolicyCommand,
    cancel: Cancellation,
  ) {
    postingPolicyUuid(regionId);
    const checked = decodePostingPolicyCommand(command);
    const result = await this.api.request(
      {
        path: `/v1/me/school-posting-policy/${regionId}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodePostingPolicyReceipt,
      },
      {
        body: {
          clientRequestId: checked.clientRequestId,
          expectedRevision: checked.expectedRevision,
          policy: {
            ...checked.policy,
            unverifiedCategories: [...checked.policy.unverifiedCategories],
            expiry: { ...checked.policy.expiry },
          },
        },
        cancellation: cancel,
      },
    );
    if (
      result.regionId !== regionId ||
      result.requestId !== checked.clientRequestId ||
      result.revision !== checked.expectedRevision + 1
    )
      invalidPostingPolicy();
    return result;
  }
  async recover(requestId: string, cancel: Cancellation) {
    postingPolicyRequestId(requestId);
    const result = await this.api.request(
      {
        path: `/v1/me/school-posting-policy/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodePostingPolicyRecovery,
      },
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalidPostingPolicy();
    return result;
  }
  async cancel(requestId: string, requestHash: string, cancel: Cancellation) {
    postingPolicyRequestId(requestId);
    postingPolicyHash(requestHash);
    const result = await this.api.request(
      {
        path: `/v1/me/school-posting-policy/requests/${requestId}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'never',
        successStatus: 200,
        decode: decodePostingPolicyRecovery,
      },
      { body: { requestHash }, cancellation: cancel },
    );
    if (result.requestId !== requestId) invalidPostingPolicy();
    return result;
  }
}
