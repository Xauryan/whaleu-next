import type { ExperienceAction } from '../../experience/ingress.js';
import type { AuthorMode } from '../contracts.js';

export const rewardEventTypes = [
  'post_created',
  'comment_created',
  'reply_created',
  'post_liked',
  'comment_liked',
  'reply_liked',
  'post_saved',
  'post_deleted',
  'comment_deleted',
  'reply_deleted',
] as const;
export type RewardEventType = (typeof rewardEventTypes)[number];
export function isRewardEventType(value: string): value is RewardEventType {
  return rewardEventTypes.some((type) => type === value);
}
export interface RewardFacts {
  eventType: RewardEventType;
  actorId: string;
  resourceAuthorId: string;
  postAuthorId: string;
  rootAuthorId: string | null;
  targetReplyAuthorId: string | null;
}
export interface RewardBeneficiary {
  beneficiaryId: string;
  action: ExperienceAction;
}
/** Source-domain facts only. This never consults present relationships or public
 * display identity and never adds a reply's post author to its recipients. */
export function rewardBeneficiaries(facts: RewardFacts): RewardBeneficiary[] {
  const { actorId, eventType } = facts;
  let action: ExperienceAction;
  let received: ExperienceAction | null = null;
  let recipients: (string | null)[] = [];
  switch (eventType) {
    case 'post_created':
      action = 'publish';
      break;
    case 'comment_created':
      action = 'comment';
      received = 'received_comment';
      recipients = [facts.postAuthorId];
      break;
    case 'reply_created':
      action = 'comment';
      received = 'received_comment';
      recipients = [facts.rootAuthorId, facts.targetReplyAuthorId];
      break;
    case 'post_liked':
    case 'comment_liked':
    case 'reply_liked':
    case 'post_saved':
      action = 'like_save';
      received = 'received_like_save';
      recipients = [facts.resourceAuthorId];
      break;
    case 'post_deleted':
      action = 'delete_post';
      break;
    case 'comment_deleted':
      action = 'delete_comment';
      break;
    case 'reply_deleted':
      action = 'delete_reply';
      break;
  }
  const units: RewardBeneficiary[] = [{ beneficiaryId: actorId, action }];
  if (received)
    for (const recipient of new Set(recipients))
      if (recipient && recipient !== actorId)
        units.push({ beneficiaryId: recipient, action: received });
  return units.sort((a, b) => a.beneficiaryId.localeCompare(b.beneficiaryId));
}
export interface ExperienceSourceUnit {
  unitId: string;
  groupId: string;
  beneficiaryId: string;
  action: ExperienceAction;
  occurredAt: string | null;
  sourceKind: 'community_outbox' | 'saved_obligation';
  sourceId: string;
}
export interface CapturedResource {
  resourceKind: 'post' | 'comment' | 'reply';
  postId: string;
  rootCommentId: string | null;
  replyId: string | null;
  targetReplyId: string | null;
  resourceAuthorId: string;
  resourceAuthorMode: AuthorMode;
  postAuthorId: string;
  rootAuthorId: string | null;
  targetReplyAuthorId: string | null;
  /** PostgreSQL text preserves the authoritative submillisecond coordinate. */
  createdAt: string;
  deletedAt: string | null;
  creationFresh: boolean;
  deletionFresh: boolean;
}
