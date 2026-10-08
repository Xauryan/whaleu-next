import { PendingPostLikeStore } from '../src/community/post-like-pending';
import { PendingSavedStore } from '../src/community/saved-pending';
import type { PostUpdatePreferences } from '../src/community/saved-contract';
import { PendingFormationJoinStore } from '../src/community/formation-pending';
import type {
  Formation,
  FormationReceipt,
} from '../src/community/formation-contract';
import { PendingDiscussionStore } from '../src/community/discussion-pending';
import { PendingTradingStore } from '../src/community/trading-pending';
import type { Reply } from '../src/community/discussion-contract';
import { SessionStore } from '../src/auth/session';
import type { CommunityGateway } from '../src/community/gateway';
import type {
  Author,
  Capabilities,
  Comment,
  CommentCapabilities,
  CommunitySpace,
  Post,
  PostIntent,
  Receipt,
} from '../src/community/contract';
import {
  DraftStore,
  PendingAttemptStore,
} from '../src/community/pending-attempt';
import type { CommunityRuntime } from '../src/community/runtime';
import { PendingBallotStore } from '../src/community/poll-pending';
import type { Poll, BallotReceipt } from '../src/community/poll-contract';
import type {
  TradingContacts,
  TradingIntent,
  TradingReceipt,
  TradingView,
} from '../src/community/trading-contract';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { campus, FakeProfileGateway, ownProfile } from './profile-helpers';
export const spaceId = '55555555-5555-4555-8555-555555555555';
export const postId = '66666666-6666-4666-8666-666666666666';
export const requestId = '77777777-7777-4777-8777-777777777777';
export const commentId = '88888888-8888-4888-8888-888888888888';
export const otherId = '99999999-9999-4999-8999-999999999999';
export const createdAt = '2026-10-07T00:00:00.000Z';
export const space = (
  overrides: Partial<CommunitySpace> = {},
): CommunitySpace => ({
  id: spaceId,
  kind: 'regional',
  name: '合成测试地区',
  isActive: true,
  operatingRegionId: otherId,
  ...overrides,
});
export const anonymous = (): Author => ({
  kind: 'anonymous',
  personaId: otherId,
  displayName: '合成匿名鲸鱼',
  avatar: null,
  isPostAuthor: true,
});
export const post = (overrides: Partial<Post> = {}): Post => ({
  trading: null,
  component: { kind: 'none' },
  id: postId,
  space: { id: spaceId, kind: 'regional', name: '合成测试地区' },
  category: 'discussion',
  text: '合成测试正文',
  images: [],
  author: anonymous(),
  publishedAt: createdAt,
  likeCount: 0,
  saveCount: 0,
  commentCount: 1,
  replyCount: 0,
  discussionCount: 1,
  viewer: {
    isSelf: true,
    isLiked: false,
    canDelete: true,
    canComment: true,
    isSaved: false,
    canSave: true,
    canSetUpdatePreference: true,
  },
  commentsPolicy: 'open',
  ...overrides,
});
export const comment = (overrides: Partial<Comment> = {}): Comment => ({
  id: commentId,
  postId,
  text: '合成测试评论',
  images: [],
  author: anonymous(),
  createdAt,
  likeCount: 0,
  replyCount: 0,
  isPinned: false,
  replyPreview: { items: [], nextCursor: null },
  viewer: { isSelf: true, canDelete: true, isLiked: false, canPin: true },
  ...overrides,
});
export const capabilities = (
  overrides: Partial<Capabilities> = {},
): Capabilities => ({
  publish: { availability: 'allowed', reason: null },
  authorModes: ['named', 'anonymous'],
  canDisableComments: false,
  postImageLimit: 9,
  commentImageLimit: 3,
  mediaAvailability: 'unavailable',
  commentRules: {
    unverifiedRequiresNamed: true,
    ownAnonymousPostForcesAnonymous: true,
  },
  ...overrides,
});
export const commentCapabilities = (
  overrides: Partial<CommentCapabilities> = {},
): CommentCapabilities => ({
  availability: 'allowed',
  reason: null,
  authorModes: ['anonymous'],
  forcedAuthorMode: 'anonymous',
  lastAuthorMode: null,
  ...overrides,
});
export const intent = (overrides: Partial<PostIntent> = {}): PostIntent => ({
  clientRequestId: requestId,
  spaceId,
  category: 'discussion',
  text: '原始文字',
  imageAssetIds: [],
  authorMode: 'anonymous',
  commentsPolicy: 'open',
  ...overrides,
});
export const receipt = (
  overrides: Partial<Extract<Receipt, { outcome: 'created' }>> = {},
): Receipt => ({
  requestId,
  operation: 'publish_post',
  outcome: 'created',
  resourceId: postId,
  createdAt,
  ...overrides,
});
export const replyId = '12121212-1212-4212-8212-121212121212';
export const reply = (overrides: Partial<Reply> = {}): Reply => ({
  id: replyId,
  postId,
  rootCommentId: commentId,
  target: {
    kind: 'comment',
    id: commentId,
    status: 'available',
    author: anonymous(),
  },
  text: '合成测试回复',
  images: [],
  author: anonymous(),
  createdAt,
  likeCount: 0,
  viewer: { isSelf: true, canDelete: true, isLiked: false },
  ...overrides,
});
export const postUpdatePreferences = (
  overrides: Partial<PostUpdatePreferences> = {},
): PostUpdatePreferences => ({
  postId,
  savedUpdatesEnabled: true,
  externalUpdatesEnabled: true,
  revision: '0',
  canSetPreference: true,
  reason: null,
  inAppCapability: 'local',
  inAppProcessing: 'manual_only',
  externalCapability: 'unavailable',
  ...overrides,
});
export class FakeCommunityGateway implements CommunityGateway {
  updatesImpl: CommunityGateway['updates'] = async () => ({
    items: [],
    nextCursor: null,
    unreadCount: 0,
  });
  updatesUnreadImpl: CommunityGateway['updatesUnread'] = async () => ({
    unreadCount: 0,
  });
  readUpdateImpl: CommunityGateway['readUpdate'] = async (noticeId) => ({
    noticeId,
    readAt: createdAt,
    unreadCount: 0,
  });
  updateTargetImpl: CommunityGateway['updateTarget'] = async (noticeId) => ({
    noticeId,
    status: 'unavailable',
  });
  updates(...args: Parameters<CommunityGateway['updates']>) {
    this.calls.push({ method: 'updates', args });
    return this.updatesImpl(...args);
  }
  updatesUnread(...args: Parameters<CommunityGateway['updatesUnread']>) {
    this.calls.push({ method: 'updatesUnread', args });
    return this.updatesUnreadImpl(...args);
  }
  readUpdate(...args: Parameters<CommunityGateway['readUpdate']>) {
    this.calls.push({ method: 'readUpdate', args });
    return this.readUpdateImpl(...args);
  }
  updateTarget(...args: Parameters<CommunityGateway['updateTarget']>) {
    this.calls.push({ method: 'updateTarget', args });
    return this.updateTargetImpl(...args);
  }

  savedImpl: CommunityGateway['saved'] = async () => ({
    items: [],
    nextCursor: null,
    visibleSavedCount: 0,
  });
  savedStatusesImpl: CommunityGateway['savedStatuses'] = async (ids) => ({
    items: ids.map((id) => ({ postId: id, status: 'unavailable' })),
  });
  postUpdatePreferencesImpl: CommunityGateway['postUpdatePreferences'] = async (
    id,
  ) => postUpdatePreferences({ postId: id });
  applySavedImpl: CommunityGateway['applySaved'] = async ({
    clientRequestId,
    ...intent
  }) => ({ requestId: clientRequestId, ...intent, outcome: 'applied' });
  savedReceiptImpl: CommunityGateway['savedReceipt'] = async (id) => ({
    requestId: id,
    operation: 'set_post_saved',
    postId,
    desired: true,
    channel: null,
    outcome: 'applied',
  });
  saved(...args: Parameters<CommunityGateway['saved']>) {
    this.calls.push({ method: 'saved', args });
    return this.savedImpl(...args);
  }
  savedStatuses(...args: Parameters<CommunityGateway['savedStatuses']>) {
    this.calls.push({ method: 'savedStatuses', args });
    return this.savedStatusesImpl(...args);
  }
  postUpdatePreferences(
    ...args: Parameters<CommunityGateway['postUpdatePreferences']>
  ) {
    this.calls.push({ method: 'postUpdatePreferences', args });
    return this.postUpdatePreferencesImpl(...args);
  }
  applySaved(...args: Parameters<CommunityGateway['applySaved']>) {
    this.calls.push({ method: 'applySaved', args });
    return this.applySavedImpl(...args);
  }
  savedReceipt(...args: Parameters<CommunityGateway['savedReceipt']>) {
    this.calls.push({ method: 'savedReceipt', args });
    return this.savedReceiptImpl(...args);
  }

  formationImpl: CommunityGateway['formation'] = async () => formation();
  joinFormationImpl: CommunityGateway['joinFormation'] = async (
    _post,
    intent,
  ) => formationReceipt({ requestId: intent.clientRequestId });
  formationReceiptImpl: CommunityGateway['formationReceipt'] = async (
    requestId,
  ) => formationReceipt({ requestId });
  ownFormationMembershipImpl: CommunityGateway['ownFormationMembership'] =
    async (postId) => ({
      postId,
      membershipId: otherId,
      joinedAt: createdAt,
      isCreator: false,
    });
  formationContactsImpl: CommunityGateway['formationContacts'] = async (
    postId,
  ) => ({
    postId,
    members: [
      {
        membershipId: otherId,
        contacts: { wechat: 'synthetic-member', qq: '', phone: '' },
      },
    ],
  });
  formation(...args: Parameters<CommunityGateway['formation']>) {
    this.calls.push({ method: 'formation', args });
    return this.formationImpl(...args);
  }
  joinFormation(...args: Parameters<CommunityGateway['joinFormation']>) {
    this.calls.push({ method: 'joinFormation', args });
    return this.joinFormationImpl(...args);
  }
  formationReceipt(...args: Parameters<CommunityGateway['formationReceipt']>) {
    this.calls.push({ method: 'formationReceipt', args });
    return this.formationReceiptImpl(...args);
  }
  ownFormationMembership(
    ...args: Parameters<CommunityGateway['ownFormationMembership']>
  ) {
    this.calls.push({ method: 'ownFormationMembership', args });
    return this.ownFormationMembershipImpl(...args);
  }
  formationContacts(
    ...args: Parameters<CommunityGateway['formationContacts']>
  ) {
    this.calls.push({ method: 'formationContacts', args });
    return this.formationContactsImpl(...args);
  }

  ownTradingImpl: CommunityGateway['ownTrading'] = async (
    _after,
    _cancel,
    subtype,
  ) => ({
    items: [
      tradingPost({
        trading: tradingView({
          subtype: { kind: 'known', key: subtype ?? 'shuma', legacyText: null },
        }),
      }),
    ],
    nextCursor: null,
  });
  ownTrading(...args: Parameters<CommunityGateway['ownTrading']>) {
    this.calls.push({ method: 'ownTrading', args });
    return this.ownTradingImpl(...args);
  }
  tradingContactsImpl: CommunityGateway['tradingContacts'] = async (
    postId,
  ) => ({ postId, contacts: tradingContacts() });
  setTradingResolutionImpl: CommunityGateway['setTradingResolution'] = async (
    resourceId,
    resolution,
    requestId,
  ) => tradingReceipt({ resourceId, resolution, requestId });
  tradingReceiptImpl: CommunityGateway['tradingReceipt'] = async (requestId) =>
    tradingReceipt({ requestId });
  tradingContacts(...args: Parameters<CommunityGateway['tradingContacts']>) {
    this.calls.push({ method: 'tradingContacts', args });
    return this.tradingContactsImpl(...args);
  }
  setTradingResolution(
    ...args: Parameters<CommunityGateway['setTradingResolution']>
  ) {
    this.calls.push({ method: 'setTradingResolution', args });
    return this.setTradingResolutionImpl(...args);
  }
  tradingReceipt(...args: Parameters<CommunityGateway['tradingReceipt']>) {
    this.calls.push({ method: 'tradingReceipt', args });
    return this.tradingReceiptImpl(...args);
  }
  commentImpl: CommunityGateway['comment'] = async () => comment();
  replyImpl: CommunityGateway['reply'] = async () => reply();
  repliesImpl: CommunityGateway['replies'] = async () => ({
    items: [reply()],
    nextCursor: null,
  });
  discussionContextImpl: CommunityGateway['discussionContext'] = async (
    _postId,
    target,
  ) => ({
    comment: comment(),
    reply: 'replyId' in target ? reply({ id: target.replyId }) : null,
    replies: { items: [reply()], nextCursor: null },
  });
  publishReplyImpl: CommunityGateway['publishReply'] = async (_root, payload) =>
    receipt({
      operation: 'publish_reply',
      resourceId: replyId,
      requestId: payload.clientRequestId,
    });
  discussionLikeImpl: CommunityGateway['discussionLike'] = async (
    kind,
    targetId,
    desired,
    requestId,
  ) => ({
    requestId,
    operation: kind === 'reply' ? 'set_reply_like' : 'set_comment_like',
    outcome: 'applied',
    resourceId: targetId,
    desired,
  });
  pinCommentImpl: CommunityGateway['pinComment'] = async (
    _post,
    targetId,
    desired,
    requestId,
  ) => ({
    requestId,
    operation: 'set_comment_pin',
    outcome: 'applied',
    resourceId: targetId,
    desired,
  });
  discussionReceiptImpl: CommunityGateway['discussionReceipt'] = async (
    requestId,
  ) => ({
    requestId,
    operation: 'set_comment_like',
    outcome: 'applied',
    resourceId: commentId,
    desired: true,
  });
  deleteReplyImpl: CommunityGateway['deleteReply'] = async () => undefined;
  comment(...args: Parameters<CommunityGateway['comment']>) {
    this.calls.push({ method: 'comment', args });
    return this.commentImpl(...args);
  }
  reply(...args: Parameters<CommunityGateway['reply']>) {
    this.calls.push({ method: 'reply', args });
    return this.replyImpl(...args);
  }
  replies(...args: Parameters<CommunityGateway['replies']>) {
    this.calls.push({ method: 'replies', args });
    return this.repliesImpl(...args);
  }
  discussionContext(
    ...args: Parameters<CommunityGateway['discussionContext']>
  ) {
    this.calls.push({ method: 'discussionContext', args });
    return this.discussionContextImpl(...args);
  }
  publishReply(...args: Parameters<CommunityGateway['publishReply']>) {
    this.calls.push({ method: 'publishReply', args });
    return this.publishReplyImpl(...args);
  }
  discussionLike(...args: Parameters<CommunityGateway['discussionLike']>) {
    this.calls.push({ method: 'discussionLike', args });
    return this.discussionLikeImpl(...args);
  }
  pinComment(...args: Parameters<CommunityGateway['pinComment']>) {
    this.calls.push({ method: 'pinComment', args });
    return this.pinCommentImpl(...args);
  }
  discussionReceipt(
    ...args: Parameters<CommunityGateway['discussionReceipt']>
  ) {
    this.calls.push({ method: 'discussionReceipt', args });
    return this.discussionReceiptImpl(...args);
  }
  deleteReply(...args: Parameters<CommunityGateway['deleteReply']>) {
    this.calls.push({ method: 'deleteReply', args });
    return this.deleteReplyImpl(...args);
  }

  calls: { method: string; args: unknown[] }[] = [];
  pollImpl: CommunityGateway['poll'] = async () => poll();
  castBallotImpl: CommunityGateway['castBallot'] = async (
    target,
    payload,
    cancel,
  ) => {
    const current = await this.pollImpl(target, cancel);
    this.pollImpl = async () => ({
      ...current,
      voterCount: current.voterCount + 1,
      selectionCount: current.selectionCount + payload.optionIds.length,
      options: current.options.map((option) => ({
        ...option,
        count: option.count + (payload.optionIds.includes(option.id) ? 1 : 0),
      })),
      viewer: {
        hasVoted: true,
        selectedOptionIds: payload.optionIds,
        canVote: false,
        reason: 'POLL_ALREADY_VOTED',
      },
    });
    return ballotReceipt({ requestId: payload.clientRequestId });
  };
  ballotReceiptImpl: CommunityGateway['ballotReceipt'] = async (id) =>
    ballotReceipt({ requestId: id });
  ownBallotImpl: CommunityGateway['ownBallot'] = async (id) => ({
    postId: id,
    ballotId,
    createdAt,
    selectedOptionIds: [optionOne],
  });
  poll(...args: Parameters<CommunityGateway['poll']>) {
    this.calls.push({ method: 'poll', args });
    return this.pollImpl(...args);
  }
  castBallot(...args: Parameters<CommunityGateway['castBallot']>) {
    this.calls.push({ method: 'castBallot', args });
    return this.castBallotImpl(...args);
  }
  ballotReceipt(...args: Parameters<CommunityGateway['ballotReceipt']>) {
    this.calls.push({ method: 'ballotReceipt', args });
    return this.ballotReceiptImpl(...args);
  }
  ownBallot(...args: Parameters<CommunityGateway['ownBallot']>) {
    this.calls.push({ method: 'ownBallot', args });
    return this.ownBallotImpl(...args);
  }

  spacesImpl: CommunityGateway['spaces'] = async () => ({
    regional: space(),
    global: [],
  });
  capabilitiesImpl: CommunityGateway['capabilities'] = async () =>
    capabilities();
  commentCapabilitiesImpl: CommunityGateway['commentCapabilities'] = async () =>
    commentCapabilities();
  feedImpl: CommunityGateway['feed'] = async (query) => ({
    items: [
      (query.category === 'trading' ? tradingPost : post)({
        space: { id: query.spaceId, kind: 'regional', name: '合成测试地区' },
        category: query.category ?? 'discussion',
        ...(query.category === 'trading'
          ? {
              trading: tradingView({
                subtype: {
                  kind: 'known',
                  key: query.tradingSubtype ?? 'shuma',
                  legacyText: null,
                },
              }),
            }
          : {}),
      }),
    ],
    nextCursor: null,
    continuation: 'end',
  });
  postImpl: CommunityGateway['post'] = async () => post();
  commentsImpl: CommunityGateway['comments'] = async () => ({
    items: [comment()],
    nextCursor: null,
  });
  mineImpl: CommunityGateway['mine'] = async () => ({
    items: [
      {
        id: postId,
        spaceId,
        category: 'discussion',
        status: 'published',
        publishedAt: createdAt,
      },
    ],
    nextCursor: null,
  });
  publishPostImpl: CommunityGateway['publishPost'] = async (payload) =>
    receipt({ requestId: payload.clientRequestId });
  publishCommentImpl: CommunityGateway['publishComment'] = async (
    _postId,
    payload,
  ) =>
    receipt({
      requestId: payload.clientRequestId,
      operation: 'publish_comment',
      resourceId: commentId,
    });
  receiptImpl: CommunityGateway['receipt'] = async (id) =>
    receipt({ requestId: id });
  likeImpl: CommunityGateway['like'] = async (intent) => ({
    ...intent,
    outcome: 'applied',
  });
  postLikeReceiptImpl: CommunityGateway['postLikeReceipt'] = async (id) => ({
    requestId: id,
    operation: 'set_post_like',
    postId,
    liked: true,
    outcome: 'applied',
  });
  deletePostImpl: CommunityGateway['deletePost'] = async () => undefined;
  deleteCommentImpl: CommunityGateway['deleteComment'] = async () => undefined;
  spaces(...args: Parameters<CommunityGateway['spaces']>) {
    this.calls.push({ method: 'spaces', args });
    return this.spacesImpl(...args);
  }
  capabilities(...args: Parameters<CommunityGateway['capabilities']>) {
    this.calls.push({ method: 'capabilities', args });
    return this.capabilitiesImpl(...args);
  }
  commentCapabilities(
    ...args: Parameters<CommunityGateway['commentCapabilities']>
  ) {
    this.calls.push({ method: 'commentCapabilities', args });
    return this.commentCapabilitiesImpl(...args);
  }
  feed(...args: Parameters<CommunityGateway['feed']>) {
    this.calls.push({ method: 'feed', args });
    return this.feedImpl(...args);
  }
  post(...args: Parameters<CommunityGateway['post']>) {
    this.calls.push({ method: 'post', args });
    return this.postImpl(...args);
  }
  comments(...args: Parameters<CommunityGateway['comments']>) {
    this.calls.push({ method: 'comments', args });
    return this.commentsImpl(...args);
  }
  mine(...args: Parameters<CommunityGateway['mine']>) {
    this.calls.push({ method: 'mine', args });
    return this.mineImpl(...args);
  }
  publishPost(...args: Parameters<CommunityGateway['publishPost']>) {
    this.calls.push({ method: 'publishPost', args });
    return this.publishPostImpl(...args);
  }
  publishComment(...args: Parameters<CommunityGateway['publishComment']>) {
    this.calls.push({ method: 'publishComment', args });
    return this.publishCommentImpl(...args);
  }
  receipt(...args: Parameters<CommunityGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
  like(...args: Parameters<CommunityGateway['like']>) {
    this.calls.push({ method: 'like', args });
    return this.likeImpl(...args);
  }
  postLikeReceipt(...args: Parameters<CommunityGateway['postLikeReceipt']>) {
    this.calls.push({ method: 'postLikeReceipt', args });
    return this.postLikeReceiptImpl(...args);
  }
  deletePost(...args: Parameters<CommunityGateway['deletePost']>) {
    this.calls.push({ method: 'deletePost', args });
    return this.deletePostImpl(...args);
  }
  deleteComment(...args: Parameters<CommunityGateway['deleteComment']>) {
    this.calls.push({ method: 'deleteComment', args });
    return this.deleteCommentImpl(...args);
  }
}
export function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeCommunityGateway(),
    profiles = new FakeProfileGateway(),
    storage = new MemoryStorage();
  profiles.current = ownProfile({ selectedCampus: campus() });
  const runtime: CommunityRuntime = {
    sessions,
    gateway,
    profiles,
    privateViews: new PrivateViewLifecycle(),
    pendingFormations: new PendingFormationJoinStore(storage, 'synthetic'),
    pendingBallots: new PendingBallotStore(storage, 'synthetic'),
    pendingDiscussion: new PendingDiscussionStore(storage, 'synthetic'),
    pendingTrading: new PendingTradingStore(storage, 'synthetic'),
    pendingSaved: new PendingSavedStore(storage, 'synthetic'),
    pendingPostLikes: new PendingPostLikeStore(storage, 'synthetic'),
    pending: new PendingAttemptStore(storage, 'synthetic'),
    drafts: new DraftStore(storage, 'synthetic'),
    newRequestId: async () => requestId,
  };
  return {
    runtime,
    gateway,
    profiles,
    storage,
    sessions,
    accountId: wireCredentials().accountId,
  };
}

export const pollId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const optionOne = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const optionTwo = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const optionThree = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const ballotId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const poll = (overrides: Partial<Poll> = {}): Poll => ({
  id: pollId,
  postId,
  question: '合成测试问题',
  selectionMode: 'single',
  options: [
    { id: optionOne, label: '甲', position: 0, count: 0 },
    { id: optionTwo, label: '乙', position: 1, count: 0 },
    { id: optionThree, label: '吃瓜🍉', position: 2, count: 0 },
  ],
  deadline: null,
  expired: false,
  voterCount: 0,
  selectionCount: 0,
  viewer: {
    hasVoted: false,
    selectedOptionIds: [],
    canVote: true,
    reason: null,
  },
  ...overrides,
});
export const pollPost = (value: Poll = poll()): Post =>
  post({ component: { kind: 'poll', poll: value } });
export const ballotReceipt = (
  overrides: Partial<Extract<BallotReceipt, { outcome: 'created' }>> = {},
): BallotReceipt => ({
  requestId,
  operation: 'cast_poll_ballot',
  outcome: 'created',
  resourceId: ballotId,
  createdAt,
  ...overrides,
});
export const tradingContacts = (
  overrides: Partial<TradingContacts> = {},
): TradingContacts => ({
  wechat: 'synthetic-wechat',
  qq: '',
  phone: '',
  ...overrides,
});
export const tradingIntent = (
  overrides: Partial<TradingIntent> = {},
): TradingIntent => ({
  subtype: 'shuma',
  price: '123.456789',
  urgency: 'normal',
  location: '合成校区北门',
  contacts: tradingContacts(),
  ...overrides,
});
export const tradingView = (
  overrides: Partial<TradingView> = {},
): TradingView => ({
  subtype: { kind: 'known', key: 'shuma', legacyText: null },
  price: { kind: 'exact', amount: '123.456789', legacyText: null },
  urgency: 'normal',
  location: '合成校区北门',
  resolution: 'open',
  viewer: { canSetResolution: true },
  ...overrides,
});
export const tradingPost = (overrides: Partial<Post> = {}): Post =>
  post({
    category: 'trading',
    trading: tradingView(),
    author: {
      kind: 'named',
      profileId: otherId,
      displayName: '合成卖家',
      avatar: null,
    },
    ...overrides,
  });
export const tradingReceipt = (
  overrides: Partial<Extract<TradingReceipt, { outcome: 'applied' }>> = {},
): TradingReceipt => ({
  requestId,
  operation: 'set_trading_resolution',
  outcome: 'applied',
  resourceId: postId,
  resolution: 'resolved',
  ...overrides,
});

export const formation = (overrides: Partial<Formation> = {}): Formation => ({
  id: pollId,
  postId,
  capacity: 2,
  theme: '合成组队',
  status: 'open',
  memberCount: 1,
  members: [
    {
      id: otherId,
      author: anonymous(),
      isCreator: true,
      joinedAt: createdAt,
      viewer: { isSelf: false },
    },
  ],
  viewer: {
    isMember: false,
    isCreator: false,
    canJoin: true,
    reason: null,
    canReadContacts: false,
  },
  ...overrides,
});
export const formationPost = (value: Formation = formation()): Post =>
  post({
    component: { kind: 'formation', formation: value },
    viewer: {
      isSelf: false,
      isLiked: false,
      canDelete: false,
      canComment: true,
      isSaved: false,
      canSave: true,
      canSetUpdatePreference: true,
    },
  });
export const formationReceipt = (
  overrides: Partial<Extract<FormationReceipt, { outcome: 'created' }>> = {},
): FormationReceipt => ({
  requestId,
  operation: 'join_formation',
  outcome: 'created',
  resourceId: ballotId,
  createdAt,
  ...overrides,
});
