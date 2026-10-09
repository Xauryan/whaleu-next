import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { RatingController, type RatingView } from '../src/ratings/controller';
import {
  RatingThreadController,
  type RatingThreadView,
} from '../src/ratings/discussion-controller';
import {
  RatingUpdatesController,
  type RatingUpdatesView,
} from '../src/ratings/updates-controller';
import type {
  RatingSubscriptionIntent,
  RatingSubscriptionReceipt,
  RatingSubscriptionState,
  RatingSubscriptionBatch,
} from '../src/ratings/subscription-contract';
import type { RatingSubscriptionsGateway } from '../src/ratings/subscription-gateway';
import type {
  RatingSubscriptionNotice,
  RatingSubscriptionNoticeLocator,
  RatingSubscriptionNoticeTarget,
  RatingSubscriptionUpdatesPage,
} from '../src/ratings/subscription-updates-contract';
import type { RatingSubscriptionUpdatesGateway } from '../src/ratings/subscription-updates-gateway';
import {
  comment,
  commentId,
  nextRevision,
  requestId,
  revision,
  targetId,
  timestamp,
} from './ratings-helpers';
import { noticeId, readReceipt } from './ratings-r2a-helpers';
import { r2bHarness } from './ratings-r2b-helpers';

export const subscriptionRevision = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const subscriptionState = (
  patch: Partial<Extract<RatingSubscriptionState, { status: 'known' }>> = {},
): Extract<RatingSubscriptionState, { status: 'known' }> => ({
  status: 'known',
  targetId,
  subscribed: false,
  count: 0,
  revision: subscriptionRevision,
  allowedActions: { setSubscription: true },
  ...patch,
});
export const subscriptionIntent = (
  subscribed = true,
): RatingSubscriptionIntent => ({
  operation: 'set_target_subscription',
  targetId,
  payload: {
    clientRequestId: requestId,
    regionId: null,
    expectedTargetRevision: revision,
    expectedSubscriptionRevision: subscriptionRevision,
    subscribed,
  },
});
export const subscriptionReceipt = (
  intent = subscriptionIntent(),
  patch: Partial<
    Extract<RatingSubscriptionReceipt, { outcome: 'applied' | 'noop' }>
  > = {},
): Extract<RatingSubscriptionReceipt, { outcome: 'applied' | 'noop' }> => ({
  requestId: intent.payload.clientRequestId,
  operation: intent.operation,
  outcome: 'applied',
  targetId: intent.targetId,
  subscribed: intent.payload.subscribed,
  revision: nextRevision,
  occurredAt: timestamp,
  ...patch,
});
export const subscriptionBatch = (
  ids: readonly string[] = [targetId],
): RatingSubscriptionBatch => ({
  items: ids.map((id) => ({
    targetId: id,
    state: subscriptionState({ targetId: id }),
  })),
});
export const subscriptionLocator = (
  patch: Partial<RatingSubscriptionNoticeLocator> = {},
): RatingSubscriptionNoticeLocator => ({
  regionId: null,
  targetId,
  rootId: commentId,
  replyId: null,
  ...patch,
});
export const subscriptionNotice = (
  patch: Partial<
    Extract<RatingSubscriptionNotice, { status: 'available' }>
  > = {},
): Extract<RatingSubscriptionNotice, { status: 'available' }> => ({
  noticeId,
  createdAt: timestamp,
  readAt: null,
  status: 'available',
  domain: 'ratings',
  kind: 'subscription',
  reason: 'target_subscription',
  activity: 'root',
  target: subscriptionLocator(),
  preview: {
    text: 'Synthetic current subscription text',
    author: comment().author,
  },
  ...patch,
});
export const subscriptionUpdates = (
  patch: Partial<RatingSubscriptionUpdatesPage> = {},
): RatingSubscriptionUpdatesPage => ({
  items: [subscriptionNotice()],
  nextCursor: null,
  unreadCount: 1,
  ...patch,
});
export const subscriptionNoticeTarget = (
  patch: Partial<
    Extract<RatingSubscriptionNoticeTarget, { status: 'available' }>
  > = {},
): Extract<RatingSubscriptionNoticeTarget, { status: 'available' }> => ({
  noticeId,
  status: 'available',
  target: subscriptionLocator(),
  ...patch,
});

export class FakeRatingSubscriptionsGateway implements RatingSubscriptionsGateway {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  readonly commands: RatingSubscriptionIntent[] = [];
  stateImpl: RatingSubscriptionsGateway['state'] = async (_region, id) =>
    subscriptionState({ targetId: id });
  statesImpl: RatingSubscriptionsGateway['states'] = async (_region, targets) =>
    subscriptionBatch(targets.map((t) => t.targetId));
  commandImpl: RatingSubscriptionsGateway['command'] = async (command) =>
    subscriptionReceipt(command);
  receiptImpl: RatingSubscriptionsGateway['receipt'] = async () => {
    throw new ClientError('http', 'Synthetic missing receipt', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  state(...args: Parameters<RatingSubscriptionsGateway['state']>) {
    this.calls.push({ method: 'state', args });
    return this.stateImpl(...args);
  }
  states(...args: Parameters<RatingSubscriptionsGateway['states']>) {
    this.calls.push({ method: 'states', args });
    return this.statesImpl(...args);
  }
  command(...args: Parameters<RatingSubscriptionsGateway['command']>) {
    this.calls.push({ method: 'command', args });
    this.commands.push(args[0]);
    return this.commandImpl(...args);
  }
  receipt(...args: Parameters<RatingSubscriptionsGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
}
export class FakeRatingSubscriptionUpdatesGateway implements RatingSubscriptionUpdatesGateway {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  listImpl: RatingSubscriptionUpdatesGateway['list'] = async () =>
    subscriptionUpdates();
  unreadImpl: RatingSubscriptionUpdatesGateway['unread'] = async () => ({
    unreadCount: 1,
  });
  targetImpl: RatingSubscriptionUpdatesGateway['target'] = async () =>
    subscriptionNoticeTarget();
  markReadImpl: RatingSubscriptionUpdatesGateway['markRead'] = async () =>
    readReceipt();
  list(...args: Parameters<RatingSubscriptionUpdatesGateway['list']>) {
    this.calls.push({ method: 'list', args });
    return this.listImpl(...args);
  }
  unread(...args: Parameters<RatingSubscriptionUpdatesGateway['unread']>) {
    this.calls.push({ method: 'unread', args });
    return this.unreadImpl(...args);
  }
  target(...args: Parameters<RatingSubscriptionUpdatesGateway['target']>) {
    this.calls.push({ method: 'target', args });
    return this.targetImpl(...args);
  }
  markRead(...args: Parameters<RatingSubscriptionUpdatesGateway['markRead']>) {
    this.calls.push({ method: 'markRead', args });
    return this.markReadImpl(...args);
  }
}
export function r2cHarness(onRender?: (view: RatingThreadView) => void) {
  const s = r2bHarness();
  s.controller.dispose();
  s.detailController.dispose();
  s.updatesController.dispose();
  const ratingSubscriptions = new FakeRatingSubscriptionsGateway(),
    ratingSubscriptionUpdates = new FakeRatingSubscriptionUpdatesGateway();
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingSubscriptions,
    ratingSubscriptionUpdates,
  };
  const threadViews: RatingThreadView[] = [],
    detailViews: RatingView[] = [],
    directoryViews: RatingView[] = [],
    updateViews: RatingUpdatesView[] = [],
    navigation: string[] = [];
  const controller = new RatingThreadController(runtime, (v) => {
    threadViews.push(v);
    onRender?.(v);
  });
  const detailController = new RatingController(runtime, 'detail', (v) =>
    detailViews.push(v),
  );
  const directoryController = new RatingController(runtime, 'catalog', (v) =>
    directoryViews.push(v),
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
    ratingSubscriptions,
    ratingSubscriptionUpdates,
    controller,
    detailController,
    directoryController,
    updatesController,
    navigation,
    threadViews,
    detailViews,
    directoryViews,
    updateViews,
    view: () => threadViews[threadViews.length - 1]!,
    detailView: () => detailViews[detailViews.length - 1]!,
    directoryView: () => directoryViews[directoryViews.length - 1]!,
    updateView: () => updateViews[updateViews.length - 1]!,
  };
}
