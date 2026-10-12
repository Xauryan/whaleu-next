import { ClientError, isRecord } from '../api/errors';
import { exact, timestamp } from '../community/contract';
import { majorCursor, majorId } from '../majors/contract';
export {
  majorTextBody as discussionBody,
  majorTextBytes as discussionBytes,
} from '../majors/contract';
import { majorTextBody as discussionBody } from '../majors/contract';
export type DiscussionSort = 'likes' | 'time';
export interface DiscussionAuthor {
  readonly mode: 'named';
  readonly profileId: string;
  readonly displayName: string;
}
export interface DiscussionItem {
  readonly id: string;
  readonly majorId: string;
  readonly rootId: string | null;
  readonly replyToReplyId: string | null;
  readonly body: string;
  readonly author: DiscussionAuthor;
  readonly addressedAuthor: DiscussionAuthor | null;
  readonly createdAt: string;
  readonly likes: number;
  readonly replyCount: number;
  readonly isLiked: boolean;
  readonly myMembershipRevision: string | null;
}
export interface DiscussionPage {
  readonly majorId: string;
  readonly catalogRevision: string;
  readonly majorRevision: string;
  readonly discussionRevision: string;
  readonly root: DiscussionItem | null;
  readonly items: readonly DiscussionItem[];
  readonly totalCount: number;
  readonly nextCursor: string | null;
  readonly continuation: 'more' | 'end';
}
export interface DiscussionSource {
  readonly clientRequestId: string;
  readonly expectedCatalogRevision: string;
  readonly expectedMajorRevision: string;
}
export interface DiscussionPublish extends DiscussionSource {
  readonly body: string;
}
export interface DiscussionReply extends DiscussionPublish {
  readonly replyToReplyId: string | null;
}
export interface DiscussionLike extends DiscussionSource {
  readonly active: boolean;
  readonly expectedMembershipRevision: string | null;
}
export type DiscussionIntent =
  | {
      readonly operation: 'major.discussion.root.v1';
      readonly majorId: string;
      readonly command: DiscussionPublish;
    }
  | {
      readonly operation: 'major.discussion.reply.v1';
      readonly majorId: string;
      readonly rootId: string;
      readonly command: DiscussionReply;
    }
  | {
      readonly operation: 'major.discussion.like.v1';
      readonly majorId: string;
      readonly commentId: string;
      readonly command: DiscussionLike;
    };
type Rejection = {
  readonly outcome: 'rejected';
  readonly code:
    | 'MAJOR_REVISION_CONFLICT'
    | 'MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT'
    | 'MAJOR_DISCUSSION_CANCELLED'
    | 'CONTENT_REJECTED';
};
type Published = {
  readonly outcome: 'applied';
  readonly commentId: string;
  readonly createdAt: string;
};
export type DiscussionReceipt = {
  readonly requestId: string;
  readonly majorId: string;
} & (
  | ({ readonly operation: 'major.discussion.root.v1' } & (
      Published | Rejection
    ))
  | ({
      readonly operation: 'major.discussion.reply.v1';
      readonly rootId: string;
    } & (Published | Rejection))
  | ({
      readonly operation: 'major.discussion.like.v1';
      readonly commentId: string;
    } & (
      | Rejection
      | {
          readonly outcome: 'applied' | 'noop';
          readonly active: boolean;
          readonly membershipRevision: string | null;
          readonly recordedAt: string | null;
        }
    ))
);
export type DiscussionOwn =
  | { readonly kind: 'not_liked' | 'unavailable' }
  | {
      readonly kind: 'recorded';
      readonly active: boolean;
      readonly revision: string;
      readonly recordedAt: string;
      readonly catalogRevision: string;
      readonly majorRevision: string;
    };
export interface DiscussionTarget {
  readonly majorId: string;
  readonly rootId: string;
  readonly commentId: string;
}
export type DiscussionNotice = {
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
      };
      readonly target: DiscussionTarget;
    }
);
export interface DiscussionNotices {
  readonly items: readonly DiscussionNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export function invalidDiscussion(): never {
  throw new ClientError('protocol', 'Invalid major discussion data');
}
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullableId = (v: unknown): v is string | null => v === null || majorId(v);
const nullableTime = (v: unknown): v is string | null =>
  v === null || timestamp(v);
export function decodeDiscussionAuthor(v: unknown): DiscussionAuthor {
  exact(v, ['mode', 'profileId', 'displayName']);
  if (
    v.mode !== 'named' ||
    !majorId(v.profileId) ||
    typeof v.displayName !== 'string' ||
    !v.displayName.length ||
    v.displayName.length > 200
  )
    invalidDiscussion();
  return Object.freeze({
    mode: 'named',
    profileId: v.profileId,
    displayName: v.displayName,
  });
}
export function decodeDiscussionItem(v: unknown): DiscussionItem {
  exact(v, [
    'id',
    'majorId',
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
  if (
    !majorId(v.id) ||
    !majorId(v.majorId) ||
    !nullableId(v.rootId) ||
    !nullableId(v.replyToReplyId) ||
    !discussionBody(v.body) ||
    !timestamp(v.createdAt) ||
    !count(v.likes) ||
    !count(v.replyCount) ||
    typeof v.isLiked !== 'boolean' ||
    !nullableId(v.myMembershipRevision) ||
    (v.isLiked && (!v.myMembershipRevision || v.likes === 0)) ||
    (v.rootId === null &&
      (v.replyToReplyId !== null || v.addressedAuthor !== null)) ||
    (v.rootId !== null && (v.rootId === v.id || v.replyCount !== 0)) ||
    (v.replyToReplyId !== null && v.addressedAuthor === null) ||
    v.replyToReplyId === v.id
  )
    invalidDiscussion();
  return Object.freeze({
    id: v.id,
    majorId: v.majorId,
    rootId: v.rootId,
    replyToReplyId: v.replyToReplyId,
    body: v.body,
    author: decodeDiscussionAuthor(v.author),
    addressedAuthor:
      v.addressedAuthor === null
        ? null
        : decodeDiscussionAuthor(v.addressedAuthor),
    createdAt: v.createdAt,
    likes: v.likes,
    replyCount: v.replyCount,
    isLiked: v.isLiked,
    myMembershipRevision: v.myMembershipRevision,
  });
}
export function decodeDiscussionPage(v: unknown): DiscussionPage {
  exact(v, [
    'majorId',
    'catalogRevision',
    'majorRevision',
    'discussionRevision',
    'root',
    'items',
    'totalCount',
    'nextCursor',
    'continuation',
  ]);
  if (
    !majorId(v.majorId) ||
    !majorId(v.catalogRevision) ||
    !majorId(v.majorRevision) ||
    typeof v.discussionRevision !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(v.discussionRevision) ||
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    !count(v.totalCount) ||
    !(v.nextCursor === null || majorCursor(v.nextCursor)) ||
    !['more', 'end'].includes(String(v.continuation)) ||
    (v.nextCursor === null) !== (v.continuation === 'end') ||
    (v.continuation === 'more' && !v.items.length)
  )
    invalidDiscussion();
  const root = v.root === null ? null : decodeDiscussionItem(v.root),
    items = v.items.map(decodeDiscussionItem);
  if (
    (root && (root.majorId !== v.majorId || root.rootId !== null)) ||
    items.some(
      (i) => i.majorId !== v.majorId || i.rootId !== (root?.id ?? null),
    ) ||
    new Set(items.map((i) => i.id)).size !== items.length ||
    v.totalCount < items.length
  )
    invalidDiscussion();
  return Object.freeze({
    majorId: v.majorId,
    catalogRevision: v.catalogRevision,
    majorRevision: v.majorRevision,
    discussionRevision: v.discussionRevision,
    root,
    items: Object.freeze(items),
    totalCount: v.totalCount,
    nextCursor: v.nextCursor,
    continuation: v.continuation as 'more' | 'end',
  });
}
export function decodeDiscussionIntent(v: unknown): DiscussionIntent {
  if (!isRecord(v)) invalidDiscussion();
  const root = v.operation === 'major.discussion.root.v1',
    reply = v.operation === 'major.discussion.reply.v1',
    like = v.operation === 'major.discussion.like.v1';
  if (!root && !reply && !like) invalidDiscussion();
  exact(v, [
    'operation',
    'majorId',
    'command',
    ...(reply ? ['rootId'] : like ? ['commentId'] : []),
  ]);
  if (
    !majorId(v.majorId) ||
    (reply && !majorId(v.rootId)) ||
    (like && !majorId(v.commentId))
  )
    invalidDiscussion();
  const c = v.command;
  exact(c, [
    'clientRequestId',
    'expectedCatalogRevision',
    'expectedMajorRevision',
    ...(like
      ? ['active', 'expectedMembershipRevision']
      : reply
        ? ['body', 'replyToReplyId']
        : ['body']),
  ]);
  if (
    !majorId(c.clientRequestId) ||
    !majorId(c.expectedCatalogRevision) ||
    !majorId(c.expectedMajorRevision) ||
    (like
      ? typeof c.active !== 'boolean' ||
        !nullableId(c.expectedMembershipRevision)
      : !discussionBody(c.body) || (reply && !nullableId(c.replyToReplyId)))
  )
    invalidDiscussion();
  const source = {
    clientRequestId: c.clientRequestId,
    expectedCatalogRevision: c.expectedCatalogRevision,
    expectedMajorRevision: c.expectedMajorRevision,
  };
  if (like)
    return Object.freeze({
      operation: 'major.discussion.like.v1',
      majorId: v.majorId,
      commentId: v.commentId as string,
      command: Object.freeze({
        ...source,
        active: c.active as boolean,
        expectedMembershipRevision: c.expectedMembershipRevision as
          string | null,
      }),
    });
  if (reply)
    return Object.freeze({
      operation: 'major.discussion.reply.v1',
      majorId: v.majorId,
      rootId: v.rootId as string,
      command: Object.freeze({
        ...source,
        body: c.body as string,
        replyToReplyId: c.replyToReplyId as string | null,
      }),
    });
  return Object.freeze({
    operation: 'major.discussion.root.v1',
    majorId: v.majorId,
    command: Object.freeze({ ...source, body: c.body as string }),
  });
}
export function decodeDiscussionReceipt(v: unknown): DiscussionReceipt {
  if (!isRecord(v)) invalidDiscussion();
  const like = v.operation === 'major.discussion.like.v1',
    reply = v.operation === 'major.discussion.reply.v1',
    rejected = v.outcome === 'rejected';
  if (!like && !reply && v.operation !== 'major.discussion.root.v1')
    invalidDiscussion();
  exact(v, [
    'requestId',
    'majorId',
    'operation',
    'outcome',
    ...(reply ? ['rootId'] : []),
    ...(like ? ['commentId'] : []),
    ...(rejected
      ? ['code']
      : like
        ? ['active', 'membershipRevision', 'recordedAt']
        : ['commentId', 'createdAt']),
  ]);
  if (
    !majorId(v.requestId) ||
    !majorId(v.majorId) ||
    (reply && !majorId(v.rootId)) ||
    (like && !majorId(v.commentId))
  )
    invalidDiscussion();
  if (rejected) {
    if (
      ![
        'MAJOR_REVISION_CONFLICT',
        'MAJOR_DISCUSSION_MEMBERSHIP_CONFLICT',
        'MAJOR_DISCUSSION_CANCELLED',
        'CONTENT_REJECTED',
      ].includes(String(v.code))
    )
      invalidDiscussion();
  } else if (like) {
    if (
      !['applied', 'noop'].includes(String(v.outcome)) ||
      typeof v.active !== 'boolean' ||
      !nullableId(v.membershipRevision) ||
      !nullableTime(v.recordedAt) ||
      (v.membershipRevision === null) !== (v.recordedAt === null) ||
      ((v.active || v.outcome === 'applied') && v.membershipRevision === null)
    )
      invalidDiscussion();
  } else if (
    v.outcome !== 'applied' ||
    !majorId(v.commentId) ||
    !timestamp(v.createdAt)
  )
    invalidDiscussion();
  return Object.freeze({ ...v }) as DiscussionReceipt;
}
export function matchDiscussionReceipt(
  i: DiscussionIntent,
  r: DiscussionReceipt,
): void {
  if (
    i.majorId !== r.majorId ||
    i.operation !== r.operation ||
    i.command.clientRequestId !== r.requestId ||
    (i.operation === 'major.discussion.reply.v1' &&
      (r.operation !== i.operation || r.rootId !== i.rootId)) ||
    (i.operation === 'major.discussion.like.v1' &&
      (r.operation !== i.operation ||
        r.commentId !== i.commentId ||
        (r.outcome !== 'rejected' &&
          (r.active !== i.command.active ||
            (r.outcome === 'applied' &&
              r.membershipRevision === i.command.expectedMembershipRevision) ||
            (r.outcome === 'noop' &&
              r.membershipRevision !== i.command.expectedMembershipRevision)))))
  )
    invalidDiscussion();
}
export function decodeDiscussionOwn(v: unknown): DiscussionOwn {
  if (!isRecord(v)) invalidDiscussion();
  if (v.kind === 'not_liked' || v.kind === 'unavailable') {
    exact(v, ['kind']);
    return Object.freeze({ kind: v.kind });
  }
  exact(v, [
    'kind',
    'active',
    'revision',
    'recordedAt',
    'catalogRevision',
    'majorRevision',
  ]);
  if (
    v.kind !== 'recorded' ||
    typeof v.active !== 'boolean' ||
    !majorId(v.revision) ||
    !timestamp(v.recordedAt) ||
    !majorId(v.catalogRevision) ||
    !majorId(v.majorRevision)
  )
    invalidDiscussion();
  return Object.freeze({
    kind: 'recorded',
    active: v.active,
    revision: v.revision,
    recordedAt: v.recordedAt,
    catalogRevision: v.catalogRevision,
    majorRevision: v.majorRevision,
  });
}
export function decodeDiscussionTarget(v: unknown): DiscussionTarget {
  exact(v, ['majorId', 'rootId', 'commentId']);
  if (!majorId(v.majorId) || !majorId(v.rootId) || !majorId(v.commentId))
    invalidDiscussion();
  return Object.freeze({
    majorId: v.majorId,
    rootId: v.rootId,
    commentId: v.commentId,
  });
}
export function decodeDiscussionNotice(v: unknown): DiscussionNotice {
  if (!isRecord(v)) invalidDiscussion();
  exact(v, [
    'noticeId',
    'createdAt',
    'readAt',
    'status',
    ...(v.status === 'available' ? ['kind', 'preview', 'target'] : []),
  ]);
  if (
    !majorId(v.noticeId) ||
    !timestamp(v.createdAt) ||
    !nullableTime(v.readAt)
  )
    invalidDiscussion();
  const base = {
    noticeId: v.noticeId,
    createdAt: v.createdAt,
    readAt: v.readAt,
  };
  if (v.status === 'unavailable')
    return Object.freeze({ ...base, status: 'unavailable' });
  if (v.status !== 'available' || (v.kind !== 'reply' && v.kind !== 'like'))
    invalidDiscussion();
  exact(v.preview, ['text', 'author']);
  if (typeof v.preview.text !== 'string' || v.preview.text.length > 100)
    invalidDiscussion();
  return Object.freeze({
    ...base,
    status: 'available',
    kind: v.kind,
    preview: Object.freeze({
      text: v.preview.text,
      author: decodeDiscussionAuthor(v.preview.author),
    }),
    target: decodeDiscussionTarget(v.target),
  });
}
export function decodeDiscussionNotices(v: unknown): DiscussionNotices {
  exact(v, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(v.items) ||
    v.items.length > 50 ||
    !(v.nextCursor === null || majorCursor(v.nextCursor)) ||
    !count(v.unreadCount)
  )
    invalidDiscussion();
  const items = v.items.map(decodeDiscussionNotice);
  if (
    new Set(items.map((i) => i.noticeId)).size !== items.length ||
    (v.nextCursor !== null && items.length === 0)
  )
    invalidDiscussion();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: v.nextCursor,
    unreadCount: v.unreadCount,
  });
}
export function decodeDiscussionRead(v: unknown): {
  readonly noticeId: string;
  readonly readAt: string;
} {
  exact(v, ['noticeId', 'readAt']);
  if (!majorId(v.noticeId) || !timestamp(v.readAt)) invalidDiscussion();
  return Object.freeze({ noticeId: v.noticeId, readAt: v.readAt });
}
