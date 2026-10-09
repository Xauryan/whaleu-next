import {
  commentId,
  nextRevision,
  otherId,
  requestId,
  revision,
  targetId,
  timestamp,
} from './ratings-helpers';
import { noticeId, replyId } from './ratings-r2a-helpers';
import type {
  RatingLikeIntent,
  RatingLikeReceipt,
  RatingLikeState,
} from '../src/ratings/like-contract';
import type {
  RatingLikeNotice,
  RatingLikeNoticeLocator,
  RatingLikeNoticeTarget,
  RatingLikeUpdatesPage,
} from '../src/ratings/like-updates-contract';

export const likeRevision = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const likeState = (
  patch: Partial<Extract<RatingLikeState, { status: 'known' }>> = {},
): Extract<RatingLikeState, { status: 'known' }> => ({
  status: 'known',
  targetId,
  rootId: commentId,
  replyId: null,
  count: 0,
  liked: false,
  revision: likeRevision,
  allowedActions: { setLike: true },
  ...patch,
});
export function likeIntent(
  operation: RatingLikeIntent['operation'] = 'set_comment_like',
  liked = true,
): RatingLikeIntent {
  const payload = {
    clientRequestId: requestId,
    regionId: null,
    targetId,
    expectedTargetRevision: revision,
    expectedRevision: revision,
    expectedLikeRevision: likeRevision,
    liked,
  };
  return operation === 'set_comment_like'
    ? { operation, rootId: commentId, payload }
    : {
        operation,
        replyId,
        payload: {
          ...payload,
          rootId: commentId,
          expectedRootRevision: revision,
        },
      };
}
export const likeReceipt = (
  intent: RatingLikeIntent = likeIntent(),
  patch: Partial<
    Extract<RatingLikeReceipt, { outcome: 'applied' | 'noop' }>
  > = {},
): Extract<RatingLikeReceipt, { outcome: 'applied' | 'noop' }> => ({
  requestId: intent.payload.clientRequestId,
  operation: intent.operation,
  outcome: 'applied',
  targetId: intent.payload.targetId,
  rootId:
    intent.operation === 'set_comment_like'
      ? intent.rootId
      : intent.payload.rootId,
  replyId: intent.operation === 'set_reply_like' ? intent.replyId : null,
  liked: intent.payload.liked,
  revision: nextRevision,
  occurredAt: timestamp,
  ...patch,
});
export const likeLocator = (
  patch: Partial<RatingLikeNoticeLocator> = {},
): RatingLikeNoticeLocator => ({
  regionId: null,
  targetId,
  rootId: commentId,
  replyId: null,
  ...patch,
});
export const likeNotice = (
  patch: Partial<Extract<RatingLikeNotice, { status: 'available' }>> = {},
): Extract<RatingLikeNotice, { status: 'available' }> => ({
  noticeId,
  createdAt: timestamp,
  readAt: null,
  status: 'available',
  domain: 'ratings',
  kind: 'like',
  reason: 'like',
  actor: { mode: 'named', profileId: otherId, displayName: 'Synthetic liker' },
  target: likeLocator(),
  preview: { text: 'Synthetic currently visible liked text' },
  ...patch,
});
export const likeUpdates = (
  patch: Partial<RatingLikeUpdatesPage> = {},
): RatingLikeUpdatesPage => ({
  items: [likeNotice()],
  nextCursor: null,
  unreadCount: 1,
  ...patch,
});
export const likeNoticeTarget = (
  patch: Partial<Extract<RatingLikeNoticeTarget, { status: 'available' }>> = {},
): Extract<RatingLikeNoticeTarget, { status: 'available' }> => ({
  noticeId,
  status: 'available',
  target: likeLocator(),
  ...patch,
});

import { ClientError } from '../src/api/errors';
import type { RatingLikesGateway } from '../src/ratings/like-gateway';
import type { RatingLikeUpdatesGateway } from '../src/ratings/like-updates-gateway';
import { RatingController, type RatingView } from '../src/ratings/controller';
import {
  RatingThreadController,
  type RatingThreadView,
} from '../src/ratings/discussion-controller';
import {
  RatingUpdatesController,
  type RatingUpdatesView,
} from '../src/ratings/updates-controller';
import type { CommunityRuntime } from '../src/community/runtime';
import { r2aHarness, readReceipt } from './ratings-r2a-helpers';

export class FakeRatingLikesGateway implements RatingLikesGateway {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly commands: RatingLikeIntent[] = [];
  stateImpl: RatingLikesGateway['state'] = async (_region, subject) =>
    likeState(subject);
  commandImpl: RatingLikesGateway['command'] = async (command) =>
    likeReceipt(command);
  receiptImpl: RatingLikesGateway['receipt'] = async () => {
    throw new ClientError('http', 'Synthetic missing receipt', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  state(...args: Parameters<RatingLikesGateway['state']>) {
    this.calls.push({ method: 'state', args });
    return this.stateImpl(...args);
  }
  command(...args: Parameters<RatingLikesGateway['command']>) {
    this.calls.push({ method: 'command', args });
    this.commands.push(args[0]);
    return this.commandImpl(...args);
  }
  receipt(...args: Parameters<RatingLikesGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
}
export class FakeRatingLikeUpdatesGateway implements RatingLikeUpdatesGateway {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  listImpl: RatingLikeUpdatesGateway['list'] = async () => likeUpdates();
  unreadImpl: RatingLikeUpdatesGateway['unread'] = async () => ({
    unreadCount: 1,
  });
  targetImpl: RatingLikeUpdatesGateway['target'] = async () =>
    likeNoticeTarget();
  markReadImpl: RatingLikeUpdatesGateway['markRead'] = async () =>
    readReceipt();
  list(...args: Parameters<RatingLikeUpdatesGateway['list']>) {
    this.calls.push({ method: 'list', args });
    return this.listImpl(...args);
  }
  unread(...args: Parameters<RatingLikeUpdatesGateway['unread']>) {
    this.calls.push({ method: 'unread', args });
    return this.unreadImpl(...args);
  }
  target(...args: Parameters<RatingLikeUpdatesGateway['target']>) {
    this.calls.push({ method: 'target', args });
    return this.targetImpl(...args);
  }
  markRead(...args: Parameters<RatingLikeUpdatesGateway['markRead']>) {
    this.calls.push({ method: 'markRead', args });
    return this.markReadImpl(...args);
  }
}
export function r2bHarness(onRender?: (view: RatingThreadView) => void) {
  const s = r2aHarness();
  s.controller.dispose();
  s.updatesController.dispose();
  const ratingLikes = new FakeRatingLikesGateway(),
    ratingLikeUpdates = new FakeRatingLikeUpdatesGateway();
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingLikes,
    ratingLikeUpdates,
  };
  const threadViews: RatingThreadView[] = [],
    detailViews: RatingView[] = [],
    updateViews: RatingUpdatesView[] = [],
    navigation: string[] = [];
  const controller = new RatingThreadController(runtime, (v) => {
    threadViews.push(v);
    onRender?.(v);
  });
  const detailController = new RatingController(runtime, 'detail', (v) =>
    detailViews.push(v),
  );
  const updatesController = new RatingUpdatesController(
    runtime,
    (v) => updateViews.push(v),
    async (path) => {
      navigation.push(path);
    },
  );
  return {
    ...s,
    runtime,
    ratingLikes,
    ratingLikeUpdates,
    controller,
    detailController,
    updatesController,
    navigation,
    threadViews,
    detailViews,
    updateViews,
    view: () => threadViews[threadViews.length - 1]!,
    detailView: () => detailViews[detailViews.length - 1]!,
    updateView: () => updateViews[updateViews.length - 1]!,
  };
}
