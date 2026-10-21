import assert from 'node:assert/strict';
import type { RatingDiscussionMediaContext } from '../src/ratings/discussion-media-contract';
import type { CommunityRuntime } from '../src/community/runtime';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { RatingTargetChanges } from '../src/ratings/target-changes';
import { RatingCatalogChanges } from '../src/ratings/catalog-changes';
import { decodeRatingDiscussionMediaContext } from '../src/ratings/discussion-media-contract';
import type { RatingDiscussionMediaGateway } from '../src/ratings/discussion-media-gateway';
import {
  decodeDiscussionNotice,
  type DiscussionReplyPage,
} from '../src/ratings/discussion-media-read-contract';
import { PendingRatingDiscussionMediaStore } from '../src/ratings/discussion-media-pending';
import {
  RatingDiscussionMediaPageController,
  initialDiscussionMediaPage,
} from '../src/ratings/discussion-media-page-controller';
import type { RatingNoticeRead } from '../src/ratings/updates-contract';
import type { RatingNavigationSelector } from '../src/ratings/scoped-contract';
import {
  scopedContext,
  scopedReply,
  generation,
} from './rating-scoped-helpers';
import { accountId } from './identity-helpers';
import {
  categoryId,
  comment,
  commentId,
  otherId,
  revision,
  targetId,
  timestamp,
} from './ratings-helpers';
import { FakeClock, MemoryStorage, signedIn } from './helpers';
export const noticeKinds = [
  'updates',
  'like-updates',
  'subscription-updates',
] as const;
export type NoticeKind = (typeof noticeKinds)[number];
export const noticeRoute = (
  kind: NoticeKind = 'updates',
  noticeId = otherId,
  selector: RatingNavigationSelector = { kind: 'global' },
) => ({
  scope: selector.kind,
  ...(selector.kind === 'campus' ? { campusId: selector.campusId } : {}),
  noticeId,
  noticeKind: kind,
});
export function mediaNoticeHarness(gateways = true) {
  const sessions = signedIn(accountId),
    storage = new MemoryStorage(),
    clock = new FakeClock(),
    directoryScopeChanges = new PrivateViewLifecycle(),
    browsingScopeChanges = new PrivateViewLifecycle(),
    privateViews = new PrivateViewLifecycle();
  const calls: string[] = [],
    marks: { kind: NoticeKind; id: string }[] = [],
    views: ReturnType<typeof initialDiscussionMediaPage>[] = [];
  const state: {
    fail: '' | 'context' | 'notice' | 'unavailable' | 'thread' | 'position';
    read: ((noticeId: string) => Promise<unknown>) | null;
    contextWait: Promise<void> | null;
    noticeWait: Promise<void> | null;
    threadWait: Promise<void> | null;
  } = {
    fail: '',
    read: null,
    contextWait: null,
    noticeWait: null,
    threadWait: null,
  };
  const content = {
    protocolVersion: 4 as const,
    attachmentSetDigest: 'f'.repeat(64),
    images: [],
  };
  const root = { ...comment(), ...content },
    reply = { ...scopedReply(), ...content };
  const pageContext = (context: RatingDiscussionMediaContext) => {
    if (context.purpose === 'random') throw Error('Navigation context only');
    return {
      contextId: context.id,
      selector: context.selector,
      catalogRevision: revision,
      protocolGeneration: generation,
      targetId,
      rootId: commentId,
      order: 'oldest' as const,
    };
  };
  const gateway: Partial<RatingDiscussionMediaGateway> = {
    async context(request) {
      calls.push('context');
      await state.contextWait;
      if (state.fail === 'context') throw Error('synthetic context failure');
      const base = scopedContext(request, clock.now());
      const decoded = decodeRatingDiscussionMediaContext({
        ...base,
        protocolVersion: 4,
        discussionMedia: {
          id: otherId,
          generation,
          sourceDigest: 'c'.repeat(64),
          validUntil: base.expiresAt,
        },
        capabilities: [...base.capabilities, 'discussion_images'],
      });
      assert.notEqual(decoded.purpose, 'random');
      if (decoded.purpose === 'random') throw Error('Navigation context only');
      return decoded;
    },
    async notice(context, noticeId, kind) {
      calls.push(`notice:${kind}:${noticeId}`);
      await state.noticeWait;
      if (state.fail === 'notice') throw Error('synthetic notice failure');
      const common = {
        protocolVersion: 4,
        noticeId,
        createdAt: timestamp,
        readAt: null,
      };
      if (state.fail === 'unavailable')
        return decodeDiscussionNotice({ ...common, status: 'unavailable' });
      return decodeDiscussionNotice({
        ...common,
        status: 'available',
        domain: 'ratings',
        kind:
          kind === 'updates'
            ? 'reply'
            : kind === 'like-updates'
              ? 'like'
              : 'subscription',
        reason:
          kind === 'updates'
            ? 'direct_reply'
            : kind === 'like-updates'
              ? 'like'
              : 'target_subscription',
        ...(kind === 'like-updates'
          ? {
              actor: {
                mode: 'named',
                profileId: accountId,
                displayName: 'Synthetic actor',
              },
            }
          : {}),
        ...(kind === 'subscription-updates' ? { activity: 'reply' } : {}),
        target: {
          selector: context.selector,
          targetId,
          rootId: commentId,
          replyId: reply.id,
          protocolGeneration: generation,
        },
        preview: {
          body: 'Synthetic exact notice preview',
          author: root.author,
          imageCount: 0,
          thumbnail: null,
        },
      });
    },
    async thread(context) {
      calls.push('thread');
      await state.threadWait;
      if (state.fail === 'thread') throw Error('synthetic thread failure');
      return {
        context: pageContext(context),
        root,
        allowedActions: { createReply: true, authorModes: ['named'] },
      };
    },
    async position(context, anchorReplyId) {
      calls.push('position');
      if (state.fail === 'position') throw Error('synthetic position failure');
      const page: DiscussionReplyPage = {
        context: pageContext(context),
        items: [reply],
        nextCursor: null,
        continuation: 'end',
      };
      return { context: page.context, anchorReplyId, page };
    },
    async replies(context) {
      calls.push('replies');
      return {
        context: pageContext(context),
        items: [reply],
        nextCursor: null,
        continuation: 'end',
      };
    },
    async like() {
      calls.push('like');
      return { status: 'unavailable' };
    },
    async composer(context) {
      calls.push('composer');
      return {
        protocolVersion: 4,
        contextId: context.id,
        targetId,
        targetRevision: revision,
        categoryId,
        categoryRevision: revision,
        definitionRevision: revision,
        contentVersion: 1,
        root: { id: commentId, revision },
        allowedActions: { createComment: false, createReply: true },
        authorModes: ['named'],
      };
    },
  };
  const legacy = (kind: NoticeKind) => ({
    async markRead(id: string) {
      marks.push({ kind, id });
      return (
        state.read
          ? await state.read(id)
          : { noticeId: id, readAt: timestamp, unreadCount: 7 }
      ) as RatingNoticeRead;
    },
  });
  const pending = new PendingRatingDiscussionMediaStore(
    storage,
    'https://notice-test.invalid',
  );
  const runtime = {
    sessions,
    ratingDiscussionMedia: gateway,
    pendingRatingDiscussionMedia: pending,
    privateViews,
    directoryScopeChanges,
    browsingScopeChanges,
    ratingTargetChanges: new RatingTargetChanges(),
    ratingCatalogChanges: new RatingCatalogChanges(),
    ...(gateways
      ? {
          ratingUpdates: legacy('updates'),
          ratingLikeUpdates: legacy('like-updates'),
          ratingSubscriptionUpdates: legacy('subscription-updates'),
        }
      : {}),
    newRequestId: async () => {
      throw Error('No content command is allowed in notice tests');
    },
  } as unknown as CommunityRuntime;
  const controller = new RatingDiscussionMediaPageController(
    runtime,
    (view) => views.push(view),
    clock,
  );
  return {
    runtime,
    controller,
    sessions,
    clock,
    pending,
    storage,
    calls,
    marks,
    state,
    views,
    view: () => views[views.length - 1]!,
    key: () => views[views.length - 1]!.noticeRead!.interactionKey,
    directoryScopeChanges,
    browsingScopeChanges,
    privateViews,
  };
}
