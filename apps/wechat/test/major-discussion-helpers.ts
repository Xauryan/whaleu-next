import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  MajorDiscussionController,
  type MajorDiscussionView,
  type DiscussionMode,
} from '../src/major-discussion/controller';
import type {
  DiscussionIntent,
  DiscussionItem,
  DiscussionPage,
  DiscussionReceipt,
  DiscussionOwn,
  DiscussionNotice,
} from '../src/major-discussion/contract';
import type { MajorDiscussionGateway } from '../src/major-discussion/gateway';
import {
  PendingMajorDiscussionStore,
  type PendingMajorDiscussion,
} from '../src/major-discussion/pending';
import { setup } from './community-helpers';
export const id = '11111111-1111-4111-8111-111111111111';
export const revision = '22222222-2222-4222-8222-222222222222';
export const catalogRevision = '33333333-3333-4333-8333-333333333333';
export const requestId = '55555555-5555-4555-8555-555555555555';
export const otherId = '66666666-6666-4666-8666-666666666666';
export const floorId = '88888888-8888-4888-8888-888888888888';
export const scoreRevision = '99999999-9999-4999-8999-999999999999';
export const recordedAt = '2026-07-01T10:00:00.000Z';
export const rootId = otherId,
  replyId = floorId;
export const author = {
  mode: 'named' as const,
  profileId: scoreRevision,
  displayName: '合成用户',
};
export const item = (patch: Partial<DiscussionItem> = {}): DiscussionItem => ({
  id: rootId,
  majorId: id,
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
  majorId: id,
  catalogRevision,
  majorRevision: revision,
  discussionRevision: '1',
  root: null,
  items: [item()],
  totalCount: 1,
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const source = () => ({
  clientRequestId: requestId,
  expectedCatalogRevision: catalogRevision,
  expectedMajorRevision: revision,
});
export const intent = (body = '合成原文'): DiscussionIntent => ({
  operation: 'major.discussion.root.v1',
  majorId: id,
  command: { ...source(), body },
});
export const like = (
  active = true,
  expectedMembershipRevision: string | null = null,
): DiscussionIntent => ({
  operation: 'major.discussion.like.v1',
  majorId: id,
  commentId: rootId,
  command: { ...source(), active, expectedMembershipRevision },
});
export const own = (active = true): DiscussionOwn => ({
  kind: 'recorded',
  active,
  revision: scoreRevision,
  recordedAt,
  catalogRevision,
  majorRevision: revision,
});
export const receipt = (i: DiscussionIntent = intent()): DiscussionReceipt => ({
  requestId: i.command.clientRequestId,
  majorId: i.majorId,
  ...(i.operation === 'major.discussion.like.v1'
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
    : i.operation === 'major.discussion.reply.v1'
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
    majorId: i.majorId,
    operation: i.operation,
    outcome: 'rejected',
    code: 'MAJOR_DISCUSSION_CANCELLED',
    ...(i.operation === 'major.discussion.reply.v1'
      ? { rootId: i.rootId }
      : i.operation === 'major.discussion.like.v1'
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
  target: { majorId: id, rootId, commentId: replyId },
});
export function discussionHarness(mode: DiscussionMode = 'roots') {
  const s = setup(),
    store = new PendingMajorDiscussionStore(
      s.storage,
      'https://discussion.example',
    ),
    calls: string[] = [],
    commands: DiscussionIntent[] = [],
    ids = { next: async () => requestId };
  const impl: MajorDiscussionGateway = {
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
    target: async () => ({ majorId: id, rootId, commentId: replyId }),
    read: async (noticeId) => {
      impl.notices = async () => ({
        items: [{ ...notice(), readAt: recordedAt }],
        nextCursor: null,
        unreadCount: 0,
      });
      return { noticeId, readAt: recordedAt };
    },
  };
  const gateway: MajorDiscussionGateway = {
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
      majorDiscussion: gateway,
      pendingMajorDiscussion: store,
      newRequestId: () => ids.next(),
    },
    views: MajorDiscussionView[] = [],
    controller = new MajorDiscussionController(runtime, mode, (v) =>
      views.push(v),
    );
  const pending = (
    i = intent(),
    phase: 'submit' | 'cancel' = 'submit',
  ): PendingMajorDiscussion => ({
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
