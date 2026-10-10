/** Internal dispatch only. HTTP and persisted v3 records always use their original
 * strict decoders; no legacy endpoint learns the v4 discussion vocabulary. */
import * as post from './batch-contracts';
import * as discussion from './discussion-batch-contracts';
import {
  decodePublicationReference as postReference,
  type PublicationReference as PostReference,
} from './upload-contracts';
import {
  decodePublicationReference as discussionReference,
  type PublicationReference as DiscussionReference,
} from './discussion-upload-contracts';
import { isRecord } from '../api/errors';
import { uploadInvalid } from './upload-contracts';
import type { MediaTarget } from './contracts';
import type { Cancellation } from '../platform/contracts';
import type { MediaSession } from './contracts';
export { batchEqual, batchRevision } from './batch-contracts';
export type BatchIdentity = post.BatchIdentity | discussion.BatchIdentity;
export type BatchStatus = post.BatchStatus | discussion.BatchStatus;
export type MemberStatus = post.MemberStatus | discussion.MemberStatus;
export type MemberPrepare = post.MemberPrepare;
export type OrderedAsset = post.OrderedAsset;
export type BatchCommand =
  | { readonly kind: 'layout'; readonly payload: post.LayoutCommand }
  | {
      readonly kind: 'seal';
      readonly payload: Omit<post.SealCommand, 'publication'> & {
        readonly publication: PublicationReference;
      };
    }
  | {
      readonly kind: 'reopen';
      readonly payload: Omit<post.ReopenCommand, 'publication'> & {
        readonly publication: PublicationReference;
      };
    };
export type PublicationCancellation =
  post.PublicationCancellation | discussion.PublicationCancellation;
export type PublicationReference = PostReference | DiscussionReference;
export type BatchRecovery = post.BatchRecovery | discussion.BatchRecovery;
export type BatchPublicationRecovery =
  post.BatchPublicationRecovery | discussion.BatchPublicationRecovery;
export type BatchFenceResult =
  post.BatchFenceResult | discussion.BatchFenceResult;
export type BatchTarget = MediaTarget & {
  readonly target?: discussion.DiscussionTarget;
};
export type { DiscussionTarget } from './discussion-batch-contracts';
export type ProtocolVersion = 3 | 4;
export const protocolFor = (identity: BatchIdentity): ProtocolVersion =>
  identity.version === 1 ? 3 : 4;
export const batchLimit = (identity: BatchIdentity): 3 | 9 =>
  identity.version === 1 ? 9 : 3;
export const codecFor = (version: ProtocolVersion) =>
  version === 4 ? discussion : post;
export function decodeBatchIdentity(raw: unknown): BatchIdentity {
  if (!isRecord(raw)) uploadInvalid();
  return raw.version === 2
    ? discussion.decodeBatchIdentity(raw)
    : post.decodeBatchIdentity(raw);
}
export function decodeBatchStatus(raw: unknown): BatchStatus {
  if (!isRecord(raw)) uploadInvalid();
  return raw.version === 4
    ? discussion.decodeBatchStatus(raw)
    : post.decodeBatchStatus(raw);
}
export function decodeMemberStatus(raw: unknown): MemberStatus {
  if (!isRecord(raw)) uploadInvalid();
  return raw.version === 4
    ? discussion.decodeMemberStatus(raw)
    : post.decodeMemberStatus(raw);
}
export function decodePublicationReference(raw: unknown): PublicationReference {
  if (!isRecord(raw)) uploadInvalid();
  return raw.operation === 'publish_post'
    ? postReference(raw)
    : discussionReference(raw);
}
export function decodePublicationCancellation(
  raw: unknown,
): PublicationCancellation {
  if (!isRecord(raw)) uploadInvalid();
  return raw.operation === 'publish_post'
    ? post.decodePublicationCancellation(raw)
    : discussion.decodePublicationCancellation(raw);
}
export function decodeBatchFenceResult(raw: unknown): BatchFenceResult {
  if (!isRecord(raw)) uploadInvalid();
  return raw.version === 4
    ? discussion.decodeBatchFenceResult(raw)
    : post.decodeBatchFenceResult(raw);
}
export const batchRequestHash = (actor: string, identity: BatchIdentity) =>
  identity.version === 2
    ? discussion.batchRequestHash(actor, identity)
    : post.batchRequestHash(actor, identity);
export const memberRequestHash = (
  actor: string,
  identity: BatchIdentity,
  prepare: unknown,
) =>
  identity.version === 2
    ? discussion.memberRequestHash(actor, identity, prepare)
    : post.memberRequestHash(actor, identity, prepare);
export const batchIds = (raw: unknown, min = 0, version: ProtocolVersion = 3) =>
  codecFor(version).batchIds(raw, min);
export const decodeMemberPrepare = (
  raw: unknown,
  version: ProtocolVersion = 3,
) => codecFor(version).decodeMemberPrepare(raw);
export const decodeOrderedAssets = (
  raw: unknown,
  version: ProtocolVersion = 3,
) => codecFor(version).decodeOrderedAssets(raw);
export const decodeBatchCommand = (
  kind: BatchCommand['kind'],
  raw: unknown,
  version: ProtocolVersion = 3,
): BatchCommand => codecFor(version).decodeBatchCommand(kind, raw);
export const attachmentPlanDigest = (
  id: string,
  revision: string,
  assets: readonly OrderedAsset[],
  version: ProtocolVersion = 3,
): string => codecFor(version).attachmentPlanDigest(id, revision, assets);
export function batchCommandHash(
  id: string,
  command: BatchCommand,
  version: ProtocolVersion = 3,
): string {
  return version === 4
    ? discussion.batchCommandHash(
        id,
        discussion.decodeBatchCommand(command.kind, command.payload),
      )
    : post.batchCommandHash(
        id,
        post.decodeBatchCommand(command.kind, command.payload),
      );
}
export interface BatchGateway {
  prepare(
    identity: BatchIdentity,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchStatus>;
  recover(
    id: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchRecovery>;
  cancel(
    id: string,
    hash: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchRecovery>;
  command(
    id: string,
    command: BatchCommand,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<BatchStatus>;
  recoverPublication(
    reference: PublicationReference,
    assets: readonly string[],
    session: MediaSession,
    cancel: Cancellation,
    target?: discussion.DiscussionTarget,
  ): Promise<BatchPublicationRecovery>;
  fencePublication(
    id: string,
    reference: PublicationReference,
    assets: readonly string[],
    session: MediaSession,
    cancel: Cancellation,
    target?: discussion.DiscussionTarget,
  ): Promise<BatchFenceResult>;
  prepareMember(
    id: string,
    input: MemberPrepare,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MemberStatus>;
  memberStatus(
    id: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MemberStatus>;
  grant: post.BatchGateway['grant'];
  finalize(
    id: string,
    session: MediaSession,
    cancel: Cancellation,
  ): Promise<MemberStatus>;
}
