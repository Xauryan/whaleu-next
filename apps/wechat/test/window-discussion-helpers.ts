import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  WindowDiscussionController,
  type WindowDiscussionView,
  type DiscussionMode,
} from '../src/window-discussion/controller';
import type {
  DiscussionIntent,
  DiscussionItem,
  DiscussionPage,
  DiscussionReceipt,
  DiscussionOwn,
  DiscussionNotice,
} from '../src/window-discussion/contract';
import type { WindowDiscussionGateway } from '../src/window-discussion/gateway';
import {
  PendingWindowDiscussionStore,
  type PendingWindowDiscussion,
} from '../src/window-discussion/pending';
import { setup } from './community-helpers';
import {
  id,
  catalogRevision,
  revision,
  requestId,
  otherId,
  scoreRevision,
  recordedAt,
  floorId,
} from './window-ratings-helpers';
export {
  id,
  catalogRevision,
  revision,
  requestId,
  otherId,
  scoreRevision,
  recordedAt,
  floorId,
};
export const rootId = otherId,
  replyId = floorId;
export const author = {
  mode: 'named' as const,
  profileId: scoreRevision,
  displayName: '合成用户',
};
export const item = (patch: Partial<DiscussionItem> = {}): DiscussionItem => ({
  id: rootId,
  windowId: id,
  rootId: null,
  replyToReplyId: null,
  body: '合成评论 😀',
  author,
  addressedAuthor: null,
  createdAt: recordedAt,
  likes: 0,
  replyCount: 0,
  isLiked: false,
  myMembershipRevision: null,
  ...patch,
});
export const page = (patch: Partial<DiscussionPage> = {}): DiscussionPage => ({
  windowId: id,
  catalogRevision,
  windowRevision: revision,
  discussionRevision: '1',
  root: null,
  items: [item()],
  totalCount: 1,
  nextCursor: null,
  continuation: 'end',
  creatorNotice: 'unavailable',
  ...patch,
});
export const source = () => ({
  clientRequestId: requestId,
  expectedCatalogRevision: catalogRevision,
  expectedWindowRevision: revision,
});
export const intent = (body = '合成原文'): DiscussionIntent => ({
  operation: 'window.discussion.root.v1',
  windowId: id,
  command: { ...source(), body },
});
export const like = (
  active = true,
  expectedMembershipRevision: string | null = null,
): DiscussionIntent => ({
  operation: 'window.discussion.like.v1',
  windowId: id,
  commentId: rootId,
  command: { ...source(), active, expectedMembershipRevision },
});
export const own = (active = true): DiscussionOwn => ({
  kind: 'recorded',
  active,
  revision: scoreRevision,
  recordedAt,
  catalogRevision,
  windowRevision: revision,
});
export const receipt = (i: DiscussionIntent = intent()): DiscussionReceipt => ({
  requestId: i.command.clientRequestId,
  windowId: i.windowId,
  ...(i.operation === 'window.discussion.like.v1'
    ? {
        operation: i.operation,
        commentId: i.commentId,
        outcome: 'applied',
        active: i.command.active,
        membershipRevision:
          i.command.expectedMembershipRevision === scoreRevision
            ? replyId
            : scoreRevision,
        recordedAt,
      }
    : i.operation === 'window.discussion.reply.v1'
      ? {
          operation: i.operation,
          rootId: i.rootId,
          outcome: 'applied',
          commentId: replyId,
          createdAt: recordedAt,
        }
      : {
          operation: i.operation,
          outcome: 'applied',
          commentId: rootId,
          createdAt: recordedAt,
        }),
});
export const cancelled = (i: DiscussionIntent = intent()): DiscussionReceipt =>
  ({
    requestId: i.command.clientRequestId,
    windowId: i.windowId,
    operation: i.operation,
    outcome: 'rejected',
    code: 'WINDOW_DISCUSSION_CANCELLED',
    ...(i.operation === 'window.discussion.reply.v1'
      ? { rootId: i.rootId }
      : i.operation === 'window.discussion.like.v1'
        ? { commentId: i.commentId }
        : {}),
  }) as DiscussionReceipt;
export const missing = () =>
  new ClientError('http', 'Missing', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
export const notice = (): DiscussionNotice => ({
  noticeId: requestId,
  createdAt: recordedAt,
  readAt: null,
  status: 'available',
  kind: 'reply',
  preview: { text: '合成回复', author },
  target: { windowId: id, rootId, commentId: replyId },
});
export function discussionHarness(mode: DiscussionMode = 'roots') {
  const s = setup(),
    store = new PendingWindowDiscussionStore(
      s.storage,
      'https://discussion.example',
    ),
    calls: string[] = [],
    commands: DiscussionIntent[] = [],
    ids = { next: async () => requestId };
  const impl: WindowDiscussionGateway = {
    list: async () => page(),
    own: async () => own(),
    submit: async (i) => receipt(i),
    cancel: async (i) => cancelled(i),
    receipt: async () => {
      throw missing();
    },
    notices: async () => ({
      items: [notice()],
      nextCursor: null,
      unreadCount: 1,
    }),
    target: async () => ({ windowId: id, rootId, commentId: replyId }),
    read: async (noticeId) => {
      impl.notices = async () => ({
        items: [{ ...notice(), readAt: recordedAt }],
        nextCursor: null,
        unreadCount: 0,
      });
      return { noticeId, readAt: recordedAt };
    },
  };
  const gateway: WindowDiscussionGateway = {
    list: (...a) => {
      calls.push('list');
      return impl.list(...a);
    },
    own: (...a) => {
      calls.push('own');
      return impl.own(...a);
    },
    submit: (...a) => {
      calls.push('submit');
      commands.push(a[0]);
      return impl.submit(...a);
    },
    cancel: (...a) => {
      calls.push('cancel');
      commands.push(a[0]);
      return impl.cancel(...a);
    },
    receipt: (...a) => {
      calls.push('receipt');
      return impl.receipt(...a);
    },
    notices: (...a) => {
      calls.push('notices');
      return impl.notices(...a);
    },
    target: (...a) => {
      calls.push('target');
      return impl.target(...a);
    },
    read: (...a) => {
      calls.push('read');
      return impl.read(...a);
    },
  };
  const runtime: CommunityRuntime = {
      ...s.runtime,
      windowDiscussion: gateway,
      pendingWindowDiscussion: store,
      newRequestId: () => ids.next(),
    },
    views: WindowDiscussionView[] = [],
    controller = new WindowDiscussionController(runtime, mode, (v) =>
      views.push(v),
    );
  const pending = (
    i = intent(),
    phase: 'submit' | 'cancel' = 'submit',
  ): PendingWindowDiscussion => ({
    version: 1,
    accountId: s.accountId,
    origin: store.origin,
    intent: i,
    phase,
  });
  return {
    ...s,
    runtime,
    store,
    calls,
    commands,
    ids,
    impl,
    controller,
    views,
    pending,
    view: () => views[views.length - 1]!,
  };
}
