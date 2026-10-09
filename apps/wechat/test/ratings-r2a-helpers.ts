import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import type { RatingDiscussionGateway } from '../src/ratings/discussion-gateway';
import type { RatingUpdatesGateway } from '../src/ratings/updates-gateway';
import type {
  RatingDiscussionContext,
  RatingReply,
  RatingReplyIntent,
  RatingReplyPage,
  RatingReplyPosition,
  RatingReplyReceipt,
} from '../src/ratings/discussion-contract';
import type {
  RatingNotice,
  RatingNoticeLocator,
  RatingNoticeRead,
  RatingNoticeTarget,
  RatingUpdatesPage,
} from '../src/ratings/updates-contract';
import {
  RatingThreadController,
  type RatingThreadView,
} from '../src/ratings/discussion-controller';
import {
  RatingUpdatesController,
  type RatingUpdatesView,
} from '../src/ratings/updates-controller';
import {
  comment,
  commentId,
  harness,
  nextRevision,
  personaId,
  requestId,
  revision,
  targetId,
  timestamp,
} from './ratings-helpers';
export const replyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const secondReplyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const noticeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const replyBody = 'Synthetic R2A text reply';
export const route = { targetId, rootId: commentId };
export const locator = (
  patch: Partial<RatingNoticeLocator> = {},
): RatingNoticeLocator => ({
  regionId: null,
  targetId,
  rootId: commentId,
  replyId,
  ...patch,
});
export const discussion = (
  patch: Partial<RatingDiscussionContext> = {},
): RatingDiscussionContext => ({
  context: {
    regionId: null,
    catalogRevision: revision,
    targetId,
    rootId: commentId,
  },
  root: comment(),
  allowedActions: { createReply: true, authorModes: ['named', 'anonymous'] },
  ...patch,
});
export const reply = (patch: Partial<RatingReply> = {}): RatingReply => ({
  id: replyId,
  targetId,
  rootId: commentId,
  revision,
  createdAt: timestamp,
  body: replyBody,
  author: {
    mode: 'anonymous',
    targetId,
    personaId,
    displayName: 'Synthetic target persona',
  },
  isMine: true,
  allowedActions: { reply: true, delete: true },
  replyTo: { kind: 'root' },
  ...patch,
});
export const replyPage = (
  patch: Partial<RatingReplyPage> = {},
): RatingReplyPage => ({
  context: { ...discussion().context, order: 'oldest' },
  items: [reply()],
  nextCursor: null,
  continuation: 'end',
  ...patch,
});
export const position = (
  patch: Partial<RatingReplyPosition> = {},
): RatingReplyPosition => ({
  context: replyPage().context,
  anchorReplyId: replyId,
  page: replyPage(),
  ...patch,
});
export function replyIntent(
  operation: RatingReplyIntent['operation'] = 'create_reply',
): RatingReplyIntent {
  const payload = {
    clientRequestId: requestId,
    regionId: null,
    targetId,
    expectedTargetRevision: revision,
    expectedRootRevision: revision,
  };
  return operation === 'create_reply'
    ? {
        operation,
        rootId: commentId,
        payload: {
          ...payload,
          replyTo: null,
          authorMode: 'anonymous',
          body: replyBody,
          assetIds: [],
        },
      }
    : {
        operation,
        replyId,
        payload: { ...payload, rootId: commentId, expectedRevision: revision },
      };
}
export const replyReceipt = (
  intent: RatingReplyIntent = replyIntent(),
  patch: Partial<
    Extract<RatingReplyReceipt, { outcome: 'applied' | 'noop' }>
  > = {},
): Extract<RatingReplyReceipt, { outcome: 'applied' | 'noop' }> => ({
  requestId: intent.payload.clientRequestId,
  operation: intent.operation,
  outcome: 'applied',
  targetId: intent.payload.targetId,
  rootId:
    intent.operation === 'create_reply' ? intent.rootId : intent.payload.rootId,
  replyId: intent.operation === 'delete_reply' ? intent.replyId : replyId,
  revision: nextRevision,
  occurredAt: timestamp,
  ...patch,
});
export const notice = (
  patch: Partial<Extract<RatingNotice, { status: 'available' }>> = {},
): RatingNotice => ({
  noticeId,
  createdAt: timestamp,
  readAt: null,
  status: 'available',
  domain: 'ratings',
  kind: 'reply',
  reason: 'direct_root',
  target: locator(),
  preview: { text: replyBody, author: reply().author },
  ...patch,
});
export const updates = (
  patch: Partial<RatingUpdatesPage> = {},
): RatingUpdatesPage => ({
  items: [notice()],
  nextCursor: null,
  unreadCount: 1,
  ...patch,
});
export const noticeTarget = (
  patch: Partial<Extract<RatingNoticeTarget, { status: 'available' }>> = {},
): RatingNoticeTarget => ({
  noticeId,
  status: 'available',
  target: locator(),
  ...patch,
});
export const readReceipt = (
  patch: Partial<RatingNoticeRead> = {},
): RatingNoticeRead => ({
  noticeId,
  readAt: timestamp,
  unreadCount: 0,
  ...patch,
});
export class FakeRatingDiscussionGateway implements RatingDiscussionGateway {
  calls: Array<{ method: string; args: unknown[] }> = [];
  commands: RatingReplyIntent[] = [];
  discussionImpl: RatingDiscussionGateway['discussion'] = async () =>
    discussion();
  repliesImpl: RatingDiscussionGateway['replies'] = async () => replyPage();
  replyImpl: RatingDiscussionGateway['reply'] = async () => reply();
  positionImpl: RatingDiscussionGateway['position'] = async (_regionId, id) =>
    position({
      anchorReplyId: id,
      page: replyPage({ items: [reply({ id })] }),
    });
  commandImpl: RatingDiscussionGateway['command'] = async (intent) =>
    replyReceipt(
      intent,
      intent.operation === 'create_reply' ? { replyId: secondReplyId } : {},
    );
  receiptImpl: RatingDiscussionGateway['receipt'] = async () => {
    throw new ClientError('http', 'Synthetic missing receipt', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  discussion(...args: Parameters<RatingDiscussionGateway['discussion']>) {
    this.calls.push({ method: 'discussion', args });
    return this.discussionImpl(...args);
  }
  replies(...args: Parameters<RatingDiscussionGateway['replies']>) {
    this.calls.push({ method: 'replies', args });
    return this.repliesImpl(...args);
  }
  reply(...args: Parameters<RatingDiscussionGateway['reply']>) {
    this.calls.push({ method: 'reply', args });
    return this.replyImpl(...args);
  }
  position(...args: Parameters<RatingDiscussionGateway['position']>) {
    this.calls.push({ method: 'position', args });
    return this.positionImpl(...args);
  }
  command(...args: Parameters<RatingDiscussionGateway['command']>) {
    this.calls.push({ method: 'command', args });
    this.commands.push(args[0]);
    return this.commandImpl(...args);
  }
  receipt(...args: Parameters<RatingDiscussionGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
}
export class FakeRatingUpdatesGateway implements RatingUpdatesGateway {
  calls: Array<{ method: string; args: unknown[] }> = [];
  listImpl: RatingUpdatesGateway['list'] = async () => updates();
  unreadImpl: RatingUpdatesGateway['unread'] = async () => ({ unreadCount: 1 });
  targetImpl: RatingUpdatesGateway['target'] = async () => noticeTarget();
  markReadImpl: RatingUpdatesGateway['markRead'] = async () => readReceipt();
  list(...args: Parameters<RatingUpdatesGateway['list']>) {
    this.calls.push({ method: 'list', args });
    return this.listImpl(...args);
  }
  unread(...args: Parameters<RatingUpdatesGateway['unread']>) {
    this.calls.push({ method: 'unread', args });
    return this.unreadImpl(...args);
  }
  target(...args: Parameters<RatingUpdatesGateway['target']>) {
    this.calls.push({ method: 'target', args });
    return this.targetImpl(...args);
  }
  markRead(...args: Parameters<RatingUpdatesGateway['markRead']>) {
    this.calls.push({ method: 'markRead', args });
    return this.markReadImpl(...args);
  }
}
export function r2aHarness(onRender?: (view: RatingThreadView) => void) {
  const s = harness();
  s.controller.dispose();
  const ratingDiscussion = new FakeRatingDiscussionGateway(),
    ratingUpdates = new FakeRatingUpdatesGateway();
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingDiscussion,
    ratingUpdates,
  };
  const threadViews: RatingThreadView[] = [],
    updateViews: RatingUpdatesView[] = [],
    navigation: string[] = [];
  const controller = new RatingThreadController(runtime, (view) => {
    threadViews.push(view);
    onRender?.(view);
  });
  const updatesController = new RatingUpdatesController(
    runtime,
    (view) => updateViews.push(view),
    async (path) => {
      navigation.push(path);
    },
  );
  return {
    ...s,
    runtime,
    ratingDiscussion,
    ratingUpdates,
    controller,
    updatesController,
    navigation,
    threadViews,
    updateViews,
    view: () => threadViews[threadViews.length - 1]!,
    updateView: () => updateViews[updateViews.length - 1]!,
  };
}
