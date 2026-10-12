import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { uploadDigest } from '../media/upload-contracts';
import { canonicalRatingScopedJson } from '../ratings/scoped-contract';
import { windowId } from '../window-ratings/contract';
import {
  decodeDiscussionIntent,
  decodeDiscussionItem,
  decodeDiscussionNotice,
  decodeDiscussionNotices,
  decodeDiscussionPage,
  decodeDiscussionReceipt,
  discussionBody,
  invalidDiscussion,
  type DiscussionAuthor,
  type DiscussionItem,
  type DiscussionPage,
  type DiscussionSource,
  type DiscussionTarget,
} from './contract';

export const WINDOW_DISCUSSION_V2 = 'window-discussion-v2' as const;
export const WINDOW_DISCUSSION_MAX_IMAGES = 3;
export interface DiscussionV2Image {
  readonly assetId: string;
  readonly manifestDigest: string;
}
/** A locator only. It never contains a credential, URL or media descriptor. */
export interface DiscussionV2ImageReference {
  readonly windowId: string;
  readonly commentId: string;
  readonly bindingId: string;
  readonly ordinal: number;
}
export interface DiscussionV2Publish extends DiscussionSource {
  readonly protocol: typeof WINDOW_DISCUSSION_V2;
  readonly body: string;
  readonly images: readonly DiscussionV2Image[];
}
export interface DiscussionV2Reply extends DiscussionV2Publish {
  readonly replyToReplyId: string | null;
}
export type DiscussionV2Operation =
  'window.discussion.root.v2' | 'window.discussion.reply.v2';
export type DiscussionV2Intent =
  | {
      readonly operation: 'window.discussion.root.v2';
      readonly windowId: string;
      readonly command: DiscussionV2Publish;
    }
  | {
      readonly operation: 'window.discussion.reply.v2';
      readonly windowId: string;
      readonly rootId: string;
      readonly command: DiscussionV2Reply;
    };
/** Durable publication context; deliberately excludes body and image facts. */
export type DiscussionV2CancelTarget = DiscussionSource & {
  readonly protocol: typeof WINDOW_DISCUSSION_V2;
  readonly windowId: string;
} & (
    | { readonly operation: 'window.discussion.root.v2' }
    | {
        readonly operation: 'window.discussion.reply.v2';
        readonly rootId: string;
        readonly replyToReplyId: string | null;
      }
  );
export type DiscussionV2Receipt = {
  readonly requestId: string;
  readonly windowId: string;
} & (
  | { readonly operation: 'window.discussion.root.v2' }
  | {
      readonly operation: 'window.discussion.reply.v2';
      readonly rootId: string;
    }
) &
  (
    | {
        readonly outcome: 'applied';
        readonly commentId: string;
        readonly createdAt: string;
      }
    | {
        readonly outcome: 'rejected';
        readonly code:
          | 'WINDOW_REVISION_CONFLICT'
          | 'WINDOW_DISCUSSION_CANCELLED'
          | 'CONTENT_REJECTED';
      }
  );
export interface DiscussionV2Item extends DiscussionItem {
  readonly protocol: typeof WINDOW_DISCUSSION_V2;
  readonly images: readonly DiscussionV2ImageReference[];
}
export interface DiscussionV2Page extends Omit<
  DiscussionPage,
  'root' | 'items'
> {
  readonly protocol: typeof WINDOW_DISCUSSION_V2;
  readonly root: DiscussionV2Item | null;
  readonly items: readonly DiscussionV2Item[];
}
export type DiscussionV2Notice = {
  readonly noticeId: string;
  readonly createdAt: string;
  readonly readAt: string | null;
} & (
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'available';
      readonly kind: 'reply' | 'like';
      readonly preview: {
        readonly text: string;
        readonly author: DiscussionAuthor;
        readonly thumbnail: DiscussionV2ImageReference | null;
      };
      readonly target: DiscussionTarget;
    }
);
export interface DiscussionV2Notices {
  readonly protocol: typeof WINDOW_DISCUSSION_V2;
  readonly items: readonly DiscussionV2Notice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}

function without(
  raw: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !keys.includes(key)),
  );
}
const v1Operation = (operation: DiscussionV2Operation) =>
  operation === 'window.discussion.root.v2'
    ? ('window.discussion.root.v1' as const)
    : ('window.discussion.reply.v1' as const);

export function discussionV2Body(
  body: unknown,
  imageCount: number,
): body is string {
  return discussionBody(body) || (body === '' && imageCount > 0);
}
export function decodeDiscussionV2Images(
  raw: unknown,
): readonly DiscussionV2Image[] {
  if (!Array.isArray(raw) || raw.length > WINDOW_DISCUSSION_MAX_IMAGES)
    invalidDiscussion();
  const images = Array.from(raw).map((value) => {
    exact(value, ['assetId', 'manifestDigest']);
    if (!windowId(value.assetId) || !uploadDigest(value.manifestDigest))
      invalidDiscussion();
    return Object.freeze({
      assetId: value.assetId,
      manifestDigest: value.manifestDigest,
    });
  });
  if (new Set(images.map((image) => image.assetId)).size !== images.length)
    invalidDiscussion();
  return Object.freeze(images);
}
export function decodeDiscussionV2ImageReference(
  raw: unknown,
): DiscussionV2ImageReference {
  exact(raw, ['windowId', 'commentId', 'bindingId', 'ordinal']);
  if (
    !windowId(raw.windowId) ||
    !windowId(raw.commentId) ||
    !windowId(raw.bindingId) ||
    typeof raw.ordinal !== 'number' ||
    !Number.isSafeInteger(raw.ordinal) ||
    raw.ordinal < 0 ||
    raw.ordinal >= WINDOW_DISCUSSION_MAX_IMAGES
  )
    invalidDiscussion();
  return Object.freeze({
    windowId: raw.windowId,
    commentId: raw.commentId,
    bindingId: raw.bindingId,
    ordinal: raw.ordinal,
  });
}
export function decodeDiscussionV2Intent(raw: unknown): DiscussionV2Intent {
  if (
    !isRecord(raw) ||
    (raw.operation !== 'window.discussion.root.v2' &&
      raw.operation !== 'window.discussion.reply.v2') ||
    !isRecord(raw.command) ||
    raw.command.protocol !== WINDOW_DISCUSSION_V2
  )
    invalidDiscussion();
  exact(raw, [
    'operation',
    'windowId',
    'command',
    ...(raw.operation === 'window.discussion.reply.v2' ? ['rootId'] : []),
  ]);
  exact(raw.command, [
    'protocol',
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedWindowRevision',
    'body',
    'images',
    ...(raw.operation === 'window.discussion.reply.v2'
      ? ['replyToReplyId']
      : []),
  ]);
  const images = decodeDiscussionV2Images(raw.command.images);
  if (!discussionV2Body(raw.command.body, images.length)) invalidDiscussion();
  // Preserve all established v1 source, target and exact-key validation without
  // widening v1's text-only contract. The placeholder exists only in this call.
  const base = decodeDiscussionIntent({
    ...raw,
    operation: v1Operation(raw.operation),
    command: {
      ...without(raw.command, ['protocol', 'images']),
      body: raw.command.body === '' ? '[image]' : raw.command.body,
    },
  });
  return Object.freeze({
    ...base,
    operation: raw.operation,
    command: Object.freeze({
      ...base.command,
      protocol: WINDOW_DISCUSSION_V2,
      body: raw.command.body,
      images,
    }),
  }) as DiscussionV2Intent;
}
export function decodeDiscussionV2CancelTarget(
  raw: unknown,
): DiscussionV2CancelTarget {
  if (!isRecord(raw)) invalidDiscussion();
  const reply = raw.operation === 'window.discussion.reply.v2';
  exact(raw, [
    'protocol',
    'operation',
    'windowId',
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedWindowRevision',
    ...(reply ? ['rootId', 'replyToReplyId'] : []),
  ]);
  if (
    raw.protocol !== WINDOW_DISCUSSION_V2 ||
    (!reply && raw.operation !== 'window.discussion.root.v2') ||
    !windowId(raw.windowId) ||
    !windowId(raw.clientRequestId) ||
    !windowId(raw.expectedCatalogRevision) ||
    !windowId(raw.expectedWindowRevision) ||
    (reply &&
      (!windowId(raw.rootId) ||
        !(raw.replyToReplyId === null || windowId(raw.replyToReplyId))))
  )
    invalidDiscussion();
  const base = {
    protocol: WINDOW_DISCUSSION_V2,
    windowId: raw.windowId,
    clientRequestId: raw.clientRequestId,
    expectedCatalogRevision: raw.expectedCatalogRevision,
    expectedWindowRevision: raw.expectedWindowRevision,
  };
  return reply
    ? Object.freeze({
        ...base,
        operation: 'window.discussion.reply.v2',
        rootId: raw.rootId as string,
        replyToReplyId: raw.replyToReplyId as string | null,
      })
    : Object.freeze({ ...base, operation: 'window.discussion.root.v2' });
}
export function discussionV2CancelTarget(
  raw: DiscussionV2Intent,
): DiscussionV2CancelTarget {
  const intent = decodeDiscussionV2Intent(raw);
  return decodeDiscussionV2CancelTarget({
    protocol: WINDOW_DISCUSSION_V2,
    operation: intent.operation,
    windowId: intent.windowId,
    clientRequestId: intent.command.clientRequestId,
    expectedCatalogRevision: intent.command.expectedCatalogRevision,
    expectedWindowRevision: intent.command.expectedWindowRevision,
    ...(intent.operation === 'window.discussion.reply.v2'
      ? { rootId: intent.rootId, replyToReplyId: intent.command.replyToReplyId }
      : {}),
  });
}
export function computeDiscussionV2IntentHash(
  actorId: string,
  raw: DiscussionV2Intent,
): string {
  if (!windowId(actorId)) invalidDiscussion();
  const intent = decodeDiscussionV2Intent(raw);
  return sha256(
    'whaleu:window-discussion-command:v2\n' +
      canonicalRatingScopedJson({
        actorId,
        windowId: intent.windowId,
        subjectId:
          intent.operation === 'window.discussion.reply.v2'
            ? intent.rootId
            : null,
        operation: intent.operation,
        command: intent.command,
      }),
  );
}
export function decodeDiscussionV2Receipt(raw: unknown): DiscussionV2Receipt {
  if (
    !isRecord(raw) ||
    (raw.operation !== 'window.discussion.root.v2' &&
      raw.operation !== 'window.discussion.reply.v2') ||
    raw.code === 'WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT'
  )
    invalidDiscussion();
  const receipt = decodeDiscussionReceipt({
    ...raw,
    operation: v1Operation(raw.operation),
  });
  return Object.freeze({
    ...receipt,
    operation: raw.operation,
  }) as DiscussionV2Receipt;
}
export function matchDiscussionV2Receipt(
  raw: DiscussionV2Intent | DiscussionV2CancelTarget,
  receipt: DiscussionV2Receipt,
): void {
  const target =
    'command' in raw
      ? discussionV2CancelTarget(raw)
      : decodeDiscussionV2CancelTarget(raw);
  const decoded = decodeDiscussionV2Receipt(receipt);
  if (
    target.windowId !== decoded.windowId ||
    target.operation !== decoded.operation ||
    target.clientRequestId !== decoded.requestId ||
    (target.operation === 'window.discussion.reply.v2' &&
      (decoded.operation !== target.operation ||
        decoded.rootId !== target.rootId))
  )
    invalidDiscussion();
}
function v1Item(item: DiscussionV2Item): Record<string, unknown> {
  return {
    ...without({ ...item }, ['protocol', 'images']),
    body: item.body === '' ? '[image]' : item.body,
  };
}
export function decodeDiscussionV2Item(raw: unknown): DiscussionV2Item {
  if (
    !isRecord(raw) ||
    raw.protocol !== WINDOW_DISCUSSION_V2 ||
    !Array.isArray(raw.images) ||
    raw.images.length > WINDOW_DISCUSSION_MAX_IMAGES
  )
    invalidDiscussion();
  exact(raw, [
    'protocol',
    'images',
    'id',
    'windowId',
    'rootId',
    'replyToReplyId',
    'body',
    'author',
    'addressedAuthor',
    'createdAt',
    'likes',
    'replyCount',
    'isLiked',
    'myMembershipRevision',
  ]);
  const images = Array.from(raw.images).map(decodeDiscussionV2ImageReference);
  if (!discussionV2Body(raw.body, images.length)) invalidDiscussion();
  const base = decodeDiscussionItem({
    ...without(raw, ['protocol', 'images']),
    body: raw.body === '' ? '[image]' : raw.body,
  });
  if (
    images.some(
      (image, ordinal) =>
        image.windowId !== base.windowId ||
        image.commentId !== base.id ||
        image.ordinal !== ordinal,
    ) ||
    new Set(images.map((image) => image.bindingId)).size !== images.length
  )
    invalidDiscussion();
  return Object.freeze({
    ...base,
    protocol: WINDOW_DISCUSSION_V2,
    body: raw.body,
    images: Object.freeze(images),
  });
}
export function decodeDiscussionV2Page(raw: unknown): DiscussionV2Page {
  if (
    !isRecord(raw) ||
    raw.protocol !== WINDOW_DISCUSSION_V2 ||
    !Array.isArray(raw.items) ||
    raw.items.length > 50
  )
    invalidDiscussion();
  exact(raw, [
    'protocol',
    'windowId',
    'catalogRevision',
    'windowRevision',
    'discussionRevision',
    'root',
    'items',
    'totalCount',
    'nextCursor',
    'continuation',
    'creatorNotice',
  ]);
  const root = raw.root === null ? null : decodeDiscussionV2Item(raw.root);
  const items = Array.from(raw.items).map(decodeDiscussionV2Item);
  const base = decodeDiscussionPage({
    ...without(raw, ['protocol']),
    root: root === null ? null : v1Item(root),
    items: items.map(v1Item),
  });
  return Object.freeze({
    ...base,
    protocol: WINDOW_DISCUSSION_V2,
    root,
    items: Object.freeze(items),
  });
}
function v1Notice(notice: DiscussionV2Notice): Record<string, unknown> {
  return notice.status === 'unavailable'
    ? { ...notice }
    : {
        ...notice,
        preview: { text: notice.preview.text, author: notice.preview.author },
      };
}
export function decodeDiscussionV2Notice(raw: unknown): DiscussionV2Notice {
  if (!isRecord(raw)) invalidDiscussion();
  if (raw.status !== 'available')
    return decodeDiscussionNotice(raw) as DiscussionV2Notice;
  exact(raw.preview, ['text', 'author', 'thumbnail']);
  const thumbnail =
    raw.preview.thumbnail === null
      ? null
      : decodeDiscussionV2ImageReference(raw.preview.thumbnail);
  const base = decodeDiscussionNotice({
    ...raw,
    preview: without(raw.preview, ['thumbnail']),
  });
  if (
    base.status !== 'available' ||
    (base.kind === 'like' && thumbnail !== null) ||
    (thumbnail !== null &&
      (thumbnail.windowId !== base.target.windowId ||
        thumbnail.commentId !== base.target.commentId ||
        thumbnail.ordinal !== 0))
  )
    invalidDiscussion();
  return Object.freeze({
    ...base,
    preview: Object.freeze({ ...base.preview, thumbnail }),
  });
}
export function decodeDiscussionV2Notices(raw: unknown): DiscussionV2Notices {
  if (
    !isRecord(raw) ||
    raw.protocol !== WINDOW_DISCUSSION_V2 ||
    !Array.isArray(raw.items) ||
    raw.items.length > 50
  )
    invalidDiscussion();
  exact(raw, ['protocol', 'items', 'nextCursor', 'unreadCount']);
  const items = Array.from(raw.items).map(decodeDiscussionV2Notice);
  const base = decodeDiscussionNotices({
    ...without(raw, ['protocol']),
    items: items.map(v1Notice),
  });
  return Object.freeze({
    ...base,
    protocol: WINDOW_DISCUSSION_V2,
    items: Object.freeze(items),
  });
}
