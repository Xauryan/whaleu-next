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
  component: { kind: 'none' },
  id: postId,
  space: { id: spaceId, kind: 'regional', name: '合成测试地区' },
  category: 'discussion',
  text: '合成测试正文',
  images: [],
  author: anonymous(),
  publishedAt: createdAt,
  likeCount: 0,
  commentCount: 1,
  viewer: { isSelf: true, isLiked: false, canDelete: true, canComment: true },
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
  viewer: { isSelf: true, canDelete: true },
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
export class FakeCommunityGateway implements CommunityGateway {
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
      post({
        space: { id: query.spaceId, kind: 'regional', name: '合成测试地区' },
        category: query.category ?? 'discussion',
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
  likeImpl: CommunityGateway['like'] = async (id, liked) => ({
    postId: id,
    isLiked: liked,
    likeCount: liked ? 1 : 0,
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
    pendingBallots: new PendingBallotStore(storage, 'synthetic'),
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
