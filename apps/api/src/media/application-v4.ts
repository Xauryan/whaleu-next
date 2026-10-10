import type {
  MediaIngressClaim,
  MediaUploadApplicationV2,
} from './application-v2.js';
import type {
  MediaBatchRecovery,
  MediaBatchPublicationRecovery,
  MediaBatchStatus,
  MediaMemberStatus,
  MediaBatchFencePublicationResult,
} from './contracts-v4.js';
export const MEDIA_DISCUSSION_BATCH_APPLICATION = Symbol(
  'MEDIA_DISCUSSION_BATCH_APPLICATION',
);
export interface MediaDiscussionBatchApplication extends Pick<
  MediaUploadApplicationV2,
  'grant' | 'admit' | 'observe' | 'retire'
> {
  fencePublication(
    token: string,
    batchId: string,
    input: unknown,
  ): Promise<MediaBatchFencePublicationResult>;
  prepareBatch(token: string, input: unknown): Promise<MediaBatchStatus>;
  recoverBatch(token: string, requestId: string): Promise<MediaBatchRecovery>;
  cancelBatch(
    token: string,
    requestId: string,
    input: unknown,
  ): Promise<MediaBatchRecovery>;
  recoverPublication(
    token: string,
    input: unknown,
  ): Promise<MediaBatchPublicationRecovery>;
  layout(
    token: string,
    batchId: string,
    input: unknown,
  ): Promise<MediaBatchStatus>;
  seal(
    token: string,
    batchId: string,
    input: unknown,
  ): Promise<MediaBatchStatus>;
  reopen(
    token: string,
    batchId: string,
    input: unknown,
  ): Promise<MediaBatchStatus>;
  prepareMember(
    token: string,
    batchId: string,
    input: unknown,
  ): Promise<MediaMemberStatus>;
  memberStatus(token: string, intentId: string): Promise<MediaMemberStatus>;
  finalizeMember(token: string, intentId: string): Promise<MediaMemberStatus>;
  cancelMember(token: string, intentId: string): Promise<MediaMemberStatus>;
}
export type MediaBatchIngressClaim = MediaIngressClaim;
