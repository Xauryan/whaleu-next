import { isRecord } from '../api/errors';
import { activityTimestamp } from '../activities/contract';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  decodeRatingAuthor,
  decodeRatingComment,
  invalidRating,
  ratingCursor,
  ratingId,
  ratingRejections,
  type RatingAuthor,
  type RatingAuthorMode,
  type RatingComment,
} from './contract';

export type RatingReplyTo =
  | { readonly kind: 'root' }
  | { readonly kind: 'reply'; readonly status: 'unavailable' }
  | {
      readonly kind: 'reply';
      readonly status: 'available';
      readonly replyId: string;
      readonly revision: string;
      readonly author: RatingAuthor;
    };
export interface RatingReply {
  readonly id: string;
  readonly targetId: string;
  readonly rootId: string;
  readonly revision: string;
  readonly createdAt: string;
  readonly body: string;
  readonly author: RatingAuthor;
  readonly isMine: boolean;
  readonly allowedActions: {
    readonly reply: boolean;
    readonly delete: boolean;
  };
  readonly replyTo: RatingReplyTo;
}
export interface RatingDiscussionContext {
  readonly context: {
    readonly regionId: string | null;
    readonly catalogRevision: string;
    readonly targetId: string;
    readonly rootId: string;
  };
  readonly root: RatingComment;
  readonly allowedActions: {
    readonly createReply: boolean;
    readonly authorModes: readonly RatingAuthorMode[];
  };
}
export interface RatingReplyPage {
  readonly context: RatingDiscussionContext['context'] & {
    readonly order: 'oldest';
  };
  readonly items: readonly RatingReply[];
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'scan' | 'end';
}
export interface RatingReplyPosition {
  readonly context: RatingReplyPage['context'];
  readonly anchorReplyId: string;
  readonly page: RatingReplyPage;
}
export const ratingTimestamp = (value: unknown): value is string =>
  activityTimestamp(value) && /Z$/.test(value);
export const ratingNullableId = (value: unknown): value is string | null =>
  value === null || ratingId(value);
export function ratingOutputText(value: unknown, max = 500): string {
  const result = canonicalRatingText(value, max);
  if (result !== value) invalidRating();
  return result;
}
function context(value: unknown): RatingDiscussionContext['context'] {
  exact(value, ['regionId', 'catalogRevision', 'targetId', 'rootId']);
  if (
    !ratingNullableId(value.regionId) ||
    !ratingId(value.catalogRevision) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId)
  )
    invalidRating();
  return Object.freeze({
    regionId: value.regionId,
    catalogRevision: value.catalogRevision,
    targetId: value.targetId,
    rootId: value.rootId,
  });
}
function pageContext(value: unknown): RatingReplyPage['context'] {
  exact(value, ['regionId', 'catalogRevision', 'targetId', 'rootId', 'order']);
  if (value.order !== 'oldest') invalidRating();
  const { order, ...rest } = value;
  return Object.freeze({ ...context(rest), order });
}
export function decodeRatingDiscussion(
  value: unknown,
): RatingDiscussionContext {
  exact(value, ['context', 'root', 'allowedActions']);
  const current = context(value.context),
    root = decodeRatingComment(value.root);
  exact(value.allowedActions, ['createReply', 'authorModes']);
  const { createReply, authorModes } = value.allowedActions;
  if (
    root.id !== current.rootId ||
    root.targetId !== current.targetId ||
    typeof createReply !== 'boolean' ||
    !Array.isArray(authorModes) ||
    authorModes.length < 1 ||
    authorModes.length > 2 ||
    authorModes[0] !== 'named' ||
    (authorModes.length === 2 && authorModes[1] !== 'anonymous')
  )
    invalidRating();
  return Object.freeze({
    context: current,
    root,
    allowedActions: Object.freeze({
      createReply,
      authorModes: Object.freeze([
        ...authorModes,
      ]) as readonly RatingAuthorMode[],
    }),
  });
}
export function decodeRatingReply(value: unknown): RatingReply {
  exact(value, [
    'id',
    'targetId',
    'rootId',
    'revision',
    'createdAt',
    'body',
    'author',
    'isMine',
    'allowedActions',
    'replyTo',
  ]);
  exact(value.allowedActions, ['reply', 'delete']);
  if (
    !ratingId(value.id) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    !ratingId(value.revision) ||
    !ratingTimestamp(value.createdAt) ||
    typeof value.isMine !== 'boolean' ||
    typeof value.allowedActions.reply !== 'boolean' ||
    typeof value.allowedActions.delete !== 'boolean' ||
    (value.allowedActions.delete && !value.isMine) ||
    !isRecord(value.replyTo)
  )
    invalidRating();
  const raw = value.replyTo;
  let replyTo: RatingReplyTo;
  if (raw.kind === 'root') {
    exact(raw, ['kind']);
    replyTo = { kind: 'root' };
  } else if (raw.kind === 'reply' && raw.status === 'unavailable') {
    exact(raw, ['kind', 'status']);
    replyTo = { kind: 'reply', status: 'unavailable' };
  } else {
    exact(raw, ['kind', 'status', 'replyId', 'revision', 'author']);
    if (
      raw.kind !== 'reply' ||
      raw.status !== 'available' ||
      !ratingId(raw.replyId) ||
      raw.replyId === value.id ||
      !ratingId(raw.revision)
    )
      invalidRating();
    replyTo = {
      kind: 'reply',
      status: 'available',
      replyId: raw.replyId,
      revision: raw.revision,
      author: decodeRatingAuthor(raw.author, value.targetId),
    };
  }
  return Object.freeze({
    id: value.id,
    targetId: value.targetId,
    rootId: value.rootId,
    revision: value.revision,
    createdAt: value.createdAt,
    body: ratingOutputText(value.body),
    author: decodeRatingAuthor(value.author, value.targetId),
    isMine: value.isMine,
    allowedActions: Object.freeze({
      reply: value.allowedActions.reply,
      delete: value.allowedActions.delete,
    }),
    replyTo: Object.freeze(replyTo),
  });
}
export function decodeRatingReplyPage(value: unknown): RatingReplyPage {
  exact(value, ['context', 'items', 'nextCursor', 'continuation']);
  const current = pageContext(value.context);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || ratingCursor(value.nextCursor)) ||
    !['more', 'scan', 'end'].includes(String(value.continuation)) ||
    (value.nextCursor === null) !== (value.continuation === 'end')
  )
    invalidRating();
  const items = value.items.map(decodeRatingReply);
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        item.targetId !== current.targetId || item.rootId !== current.rootId,
    )
  )
    invalidRating();
  return Object.freeze({
    context: current,
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    continuation: value.continuation as RatingReplyPage['continuation'],
  });
}
export function decodeRatingReplyPosition(value: unknown): RatingReplyPosition {
  exact(value, ['context', 'anchorReplyId', 'page']);
  const current = pageContext(value.context),
    page = decodeRatingReplyPage(value.page);
  if (
    !ratingId(value.anchorReplyId) ||
    page.items[0]?.id !== value.anchorReplyId ||
    Object.entries(current).some(
      ([key, v]) => page.context[key as keyof typeof current] !== v,
    )
  )
    invalidRating();
  return Object.freeze({
    context: current,
    anchorReplyId: value.anchorReplyId,
    page,
  });
}
interface ReplyPayload {
  readonly clientRequestId: string;
  readonly regionId: string | null;
  readonly targetId: string;
  readonly expectedTargetRevision: string;
  readonly expectedRootRevision: string;
}
export type RatingReplyIntent =
  | {
      readonly operation: 'create_reply';
      readonly rootId: string;
      readonly payload: ReplyPayload & {
        readonly replyTo: null | {
          readonly replyId: string;
          readonly expectedRevision: string;
        };
        readonly authorMode: RatingAuthorMode;
        readonly body: string;
        readonly assetIds: readonly [];
      };
    }
  | {
      readonly operation: 'delete_reply';
      readonly replyId: string;
      readonly payload: ReplyPayload & {
        readonly rootId: string;
        readonly expectedRevision: string;
      };
    };
export function decodeRatingReplyIntent(value: unknown): RatingReplyIntent {
  if (!isRecord(value)) invalidRating();
  const create = value.operation === 'create_reply';
  exact(value, ['operation', create ? 'rootId' : 'replyId', 'payload']);
  if (
    (!create && value.operation !== 'delete_reply') ||
    !ratingId(create ? value.rootId : value.replyId)
  )
    invalidRating();
  exact(value.payload, [
    'clientRequestId',
    'regionId',
    'targetId',
    'expectedTargetRevision',
    'expectedRootRevision',
    ...(create
      ? ['replyTo', 'authorMode', 'body', 'assetIds']
      : ['rootId', 'expectedRevision']),
  ]);
  const raw = value.payload;
  if (
    !ratingId(raw.clientRequestId) ||
    !ratingNullableId(raw.regionId) ||
    !ratingId(raw.targetId) ||
    !ratingId(raw.expectedTargetRevision) ||
    !ratingId(raw.expectedRootRevision)
  )
    invalidRating();
  const base = {
    clientRequestId: raw.clientRequestId,
    regionId: raw.regionId,
    targetId: raw.targetId,
    expectedTargetRevision: raw.expectedTargetRevision,
    expectedRootRevision: raw.expectedRootRevision,
  };
  if (create) {
    if (
      !['named', 'anonymous'].includes(String(raw.authorMode)) ||
      !Array.isArray(raw.assetIds) ||
      raw.assetIds.length !== 0
    )
      invalidRating();
    let replyTo: Extract<
      RatingReplyIntent,
      { operation: 'create_reply' }
    >['payload']['replyTo'] = null;
    if (raw.replyTo !== null) {
      exact(raw.replyTo, ['replyId', 'expectedRevision']);
      if (
        !ratingId(raw.replyTo.replyId) ||
        !ratingId(raw.replyTo.expectedRevision)
      )
        invalidRating();
      replyTo = Object.freeze({
        replyId: raw.replyTo.replyId,
        expectedRevision: raw.replyTo.expectedRevision,
      });
    }
    return Object.freeze({
      operation: 'create_reply',
      rootId: value.rootId as string,
      payload: Object.freeze({
        ...base,
        replyTo,
        authorMode: raw.authorMode as RatingAuthorMode,
        body: canonicalRatingText(raw.body),
        assetIds: Object.freeze([]) as readonly [],
      }),
    });
  }
  if (!ratingId(raw.rootId) || !ratingId(raw.expectedRevision)) invalidRating();
  return Object.freeze({
    operation: 'delete_reply',
    replyId: value.replyId as string,
    payload: Object.freeze({
      ...base,
      rootId: raw.rootId,
      expectedRevision: raw.expectedRevision,
    }),
  });
}
export type RatingReplyReceipt =
  | {
      readonly requestId: string;
      readonly operation: RatingReplyIntent['operation'];
      readonly outcome: 'applied' | 'noop';
      readonly targetId: string;
      readonly rootId: string;
      readonly replyId: string;
      readonly revision: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: RatingReplyIntent['operation'];
      readonly outcome: 'rejected';
      readonly code: (typeof ratingRejections)[number];
    };
export function decodeRatingReplyReceipt(value: unknown): RatingReplyReceipt {
  if (!isRecord(value)) invalidRating();
  exact(
    value,
    value.outcome === 'rejected'
      ? ['requestId', 'operation', 'outcome', 'code']
      : [
          'requestId',
          'operation',
          'outcome',
          'targetId',
          'rootId',
          'replyId',
          'revision',
          'occurredAt',
        ],
  );
  if (
    !ratingId(value.requestId) ||
    !['create_reply', 'delete_reply'].includes(String(value.operation))
  )
    invalidRating();
  const operation = value.operation as RatingReplyIntent['operation'];
  if (value.outcome === 'rejected') {
    if (!(ratingRejections as readonly unknown[]).includes(value.code))
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation,
      outcome: 'rejected',
      code: value.code as (typeof ratingRejections)[number],
    });
  }
  if (
    !['applied', 'noop'].includes(String(value.outcome)) ||
    (operation === 'create_reply' && value.outcome === 'noop') ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    !ratingId(value.replyId) ||
    !ratingId(value.revision) ||
    !ratingTimestamp(value.occurredAt)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation,
    outcome: value.outcome as 'applied' | 'noop',
    targetId: value.targetId,
    rootId: value.rootId,
    replyId: value.replyId,
    revision: value.revision,
    occurredAt: value.occurredAt,
  });
}
export function matchRatingReplyReceipt(
  intent: RatingReplyIntent,
  receipt: RatingReplyReceipt,
): void {
  if (
    intent.operation !== receipt.operation ||
    intent.payload.clientRequestId !== receipt.requestId ||
    (receipt.outcome !== 'rejected' &&
      (receipt.targetId !== intent.payload.targetId ||
        receipt.rootId !==
          (intent.operation === 'create_reply'
            ? intent.rootId
            : intent.payload.rootId) ||
        (intent.operation === 'delete_reply' &&
          receipt.replyId !== intent.replyId) ||
        (intent.operation === 'create_reply' &&
          intent.payload.replyTo?.replyId === receipt.replyId)))
  )
    invalidRating();
}
