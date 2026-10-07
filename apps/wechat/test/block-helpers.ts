import type {
  BlockEntry,
  BlockIntent,
  BlockResult,
} from '../src/community/block-contract';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  tradingPost,
} from './community-helpers';
export const blockIntent = (): BlockIntent => ({
  operation: 'block_named',
  source: { kind: 'post', id: postId },
  blocked: true,
  clientRequestId: requestId,
});
export const unblockIntent = (): BlockIntent => ({
  operation: 'unblock_named',
  relationshipId: otherId,
  expectedRevision: '1',
  blocked: false,
  clientRequestId: requestId,
});
export const blockEntry = (): BlockEntry => ({
  relationshipId: otherId,
  revision: '1',
  blocked: true,
  blockedAt: createdAt,
  display: { kind: 'unavailable', displayName: null },
  canUnblock: true,
});
export const blockResult = (
  intent = blockIntent(),
  currentBlocked = intent.blocked,
  currentRevision = intent.blocked ? '1' : '2',
): BlockResult => ({
  receipt: {
    requestId: intent.clientRequestId,
    operation: intent.operation,
    outcome: 'applied',
    relationshipId: otherId,
    blocked: intent.blocked,
    revision: intent.blocked ? '1' : '2',
  },
  current: {
    relationshipId: otherId,
    blocked: currentBlocked,
    revision: currentRevision,
  },
});
export const blockCandidate = () => {
  const value = tradingPost();
  return {
    ...value,
    viewer: { ...value.viewer, isSelf: false, canDelete: false },
  };
};
