// Delete is an independent wire operation. Published v1 codecs remain unchanged.
import { exact, timestamp } from '../community/contract';
import { majorId } from '../majors/contract';
import { isRecord } from '../api/errors';
import {
  decodeDiscussionIntent as decodeLegacyIntent,
  decodeDiscussionReceipt as decodeLegacyReceipt,
  matchDiscussionReceipt as matchLegacyReceipt,
  invalidDiscussion,
  type DiscussionIntent as LegacyIntent,
  type DiscussionReceipt as LegacyReceipt,
} from './contract';
export * from './contract';
export interface DiscussionDeleteIntent {
  readonly operation: 'major.discussion.delete.v1';
  readonly majorId: string;
  readonly commentId: string;
  readonly command: {
    readonly clientRequestId: string;
    readonly rootId: string | null;
  };
}
export type DiscussionDeleteReceipt = {
  readonly requestId: string;
  readonly operation: 'major.discussion.delete.v1';
  readonly majorId: string;
  readonly commentId: string;
  readonly rootId: string | null;
} & (
  | {
      readonly outcome: 'applied' | 'noop';
      readonly tombstoneId: string;
      readonly recordedAt: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: 'MAJOR_DISCUSSION_CANCELLED';
    }
);
export type DiscussionIntent = LegacyIntent | DiscussionDeleteIntent;
export type DiscussionReceipt = LegacyReceipt | DiscussionDeleteReceipt;
export function decodeDiscussionIntent(raw: unknown): DiscussionIntent {
  if (!isRecord(raw) || raw.operation !== 'major.discussion.delete.v1')
    return decodeLegacyIntent(raw);
  exact(raw, ['operation', 'majorId', 'commentId', 'command']);
  exact(raw.command, ['clientRequestId', 'rootId']);
  if (
    !majorId(raw.majorId) ||
    !majorId(raw.commentId) ||
    !majorId(raw.command.clientRequestId) ||
    (raw.command.rootId !== null &&
      (!majorId(raw.command.rootId) || raw.command.rootId === raw.commentId))
  )
    invalidDiscussion();
  return Object.freeze({
    operation: 'major.discussion.delete.v1',
    majorId: raw.majorId,
    commentId: raw.commentId,
    command: Object.freeze({
      clientRequestId: raw.command.clientRequestId,
      rootId: raw.command.rootId,
    }),
  });
}
export function decodeDiscussionReceipt(raw: unknown): DiscussionReceipt {
  if (!isRecord(raw) || raw.operation !== 'major.discussion.delete.v1')
    return decodeLegacyReceipt(raw);
  exact(raw, [
    'requestId',
    'operation',
    'majorId',
    'commentId',
    'rootId',
    'outcome',
    ...(raw.outcome === 'rejected' ? ['code'] : ['tombstoneId', 'recordedAt']),
  ]);
  if (
    !majorId(raw.requestId) ||
    !majorId(raw.majorId) ||
    !majorId(raw.commentId) ||
    (raw.rootId !== null &&
      (!majorId(raw.rootId) || raw.rootId === raw.commentId))
  )
    invalidDiscussion();
  const base = {
    requestId: raw.requestId,
    operation: 'major.discussion.delete.v1' as const,
    majorId: raw.majorId,
    commentId: raw.commentId,
    rootId: raw.rootId,
  };
  if (raw.outcome === 'rejected') {
    if (raw.code !== 'MAJOR_DISCUSSION_CANCELLED') invalidDiscussion();
    return Object.freeze({
      ...base,
      outcome: 'rejected',
      code: 'MAJOR_DISCUSSION_CANCELLED',
    });
  }
  if (
    (raw.outcome !== 'applied' && raw.outcome !== 'noop') ||
    !majorId(raw.tombstoneId) ||
    !timestamp(raw.recordedAt)
  )
    invalidDiscussion();
  return Object.freeze({
    ...base,
    outcome: raw.outcome,
    tombstoneId: raw.tombstoneId,
    recordedAt: raw.recordedAt,
  });
}
export function matchDiscussionReceipt(
  intent: DiscussionIntent,
  receipt: DiscussionReceipt,
): void {
  if (intent.operation !== 'major.discussion.delete.v1') {
    if (receipt.operation === 'major.discussion.delete.v1') invalidDiscussion();
    return matchLegacyReceipt(intent, receipt);
  }
  if (
    receipt.operation !== intent.operation ||
    receipt.requestId !== intent.command.clientRequestId ||
    receipt.majorId !== intent.majorId ||
    receipt.commentId !== intent.commentId ||
    receipt.rootId !== intent.command.rootId
  )
    invalidDiscussion();
}

export interface DiscussionDeleteLocator {
  readonly majorId: string;
  readonly commentId: string;
  readonly rootId: string | null;
}
export interface DiscussionDeleteCapability extends DiscussionDeleteLocator {
  readonly allowed: boolean;
}
export function decodeDeleteLocator(raw: unknown): DiscussionDeleteLocator {
  exact(raw, ['majorId', 'commentId', 'rootId']);
  if (
    !majorId(raw.majorId) ||
    !majorId(raw.commentId) ||
    (raw.rootId !== null &&
      (!majorId(raw.rootId) || raw.rootId === raw.commentId))
  )
    invalidDiscussion();
  return Object.freeze({
    majorId: raw.majorId,
    commentId: raw.commentId,
    rootId: raw.rootId,
  });
}
export function decodeDeleteCapability(
  raw: unknown,
): DiscussionDeleteCapability {
  exact(raw, ['majorId', 'commentId', 'rootId', 'allowed']);
  if (typeof raw.allowed !== 'boolean') invalidDiscussion();
  return Object.freeze({
    ...decodeDeleteLocator({
      majorId: raw.majorId,
      commentId: raw.commentId,
      rootId: raw.rootId,
    }),
    allowed: raw.allowed,
  });
}
