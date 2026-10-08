import { publicExperienceDisplay } from './community-helpers';
import type {
  AvailableProfile,
  LikedItem,
  LikedList,
  ProfileList,
  PublicProfile,
} from '../src/profile/discovery-contract';
import type { DiscoveryGateway } from '../src/profile/discovery-gateway';
import {
  createdAt,
  otherId,
  post,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { SafetyChanges } from '../src/community/safety-changes';
export const profileId = otherId;
export const namedAuthor = () => ({
  kind: 'named' as const,
  experienceDisplay: publicExperienceDisplay(),
  profileId,
  displayName: '合成公开昵称',
  avatar: null,
});
export const publicProfile = (
  patch: Partial<AvailableProfile> = {},
): AvailableProfile => ({
  status: 'available',
  profileId,
  isOwn: false,
  displayName: '合成公开昵称',
  bio: '合成简介',
  avatar: null,
  affiliation: null,
  publicUid: null,
  experienceDisplay: publicExperienceDisplay(),
  totalInteractions: null,
  totalInteractionsStatus: 'unavailable',
  postsHidden: false,
  postCount: 1,
  postCountStatus: 'known',
  tradeCount: 0,
  tradeCountStatus: 'known',
  ...patch,
});
export const namedPost = () => post({ author: namedAuthor() });
export const profileList = (
  patch: Partial<Extract<ProfileList, { items: unknown }>> = {},
): ProfileList => ({
  status: 'available',
  profileId,
  items: [namedPost()],
  total: 1,
  totalStatus: 'known',
  nextCursor: null,
  continuation: patch.nextCursor ? 'more' : 'end',
  ...patch,
});
export const likedItem = (patch: Partial<LikedItem> = {}): LikedItem => ({
  kind: 'post',
  targetId: postId,
  postId,
  rootCommentId: null,
  likedAt: createdAt,
  likeId: requestId,
  preview: {
    text: '合成点赞内容',
    images: [],
    author: namedAuthor(),
    createdAt,
    isSelf: false,
  },
  ...patch,
});
export const likedList = (patch: Partial<LikedList> = {}): LikedList => ({
  items: [likedItem()],
  visibleLikedCount: 1,
  visibleLikedCountStatus: 'known',
  nextCursor: null,
  continuation: patch.nextCursor ? 'more' : 'end',
  ...patch,
});
export function discoverySetup(loggedIn = true) {
  const s = setup(loggedIn);
  const calls: { method: string; args: unknown[] }[] = [];
  const behavior: DiscoveryGateway = {
    profile: async (): Promise<PublicProfile> => publicProfile(),
    list: async () => profileList(),
    ownProfileRef: async () => ({ profileId }),
    liked: async () => likedList(),
  };
  const discovery: DiscoveryGateway = {
    profile: (...args) => {
      calls.push({ method: 'profile', args });
      return behavior.profile(...args);
    },
    list: (...args) => {
      calls.push({ method: 'list', args });
      return behavior.list(...args);
    },
    ownProfileRef: (...args) => {
      calls.push({ method: 'ownProfileRef', args });
      return behavior.ownProfileRef(...args);
    },
    liked: (...args) => {
      calls.push({ method: 'liked', args });
      return behavior.liked(...args);
    },
  };
  const safetyChanges = new SafetyChanges(s.runtime.privateViews);
  return {
    ...s,
    calls,
    behavior,
    discovery,
    runtime: { ...s.runtime, discovery, safetyChanges },
  };
}
