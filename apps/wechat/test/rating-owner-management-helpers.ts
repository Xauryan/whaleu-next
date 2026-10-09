import type { CommunityRuntime } from '../src/community/runtime';
import {
  RatingTargetOwnerDeletionController,
  type RatingTargetOwnerDeletionView,
} from '../src/ratings/target-owner-deletion-controller';
import type { RatingTargetOwnerDeletionGateway } from '../src/ratings/target-owner-deletion-gateway';
import {
  decodeRatingTargetOwnerDeletionIntent,
  type RatingTargetOwnerDeletionContext,
  type RatingTargetOwnerDeletionReceipt,
} from '../src/ratings/target-owner-deletion-contract';
import { RatingTargetChanges } from '../src/ratings/target-changes';
import {
  harness,
  requestId,
  revision,
  nextRevision,
  targetId,
  timestamp,
} from './ratings-helpers';
import { missing } from './ratings-r3a-helpers';
export const ownerContext = (): RatingTargetOwnerDeletionContext => ({
  targetId,
  revision,
  deletion: { kind: 'not_owner_deleted' },
});
export const ownerIntent = () =>
  decodeRatingTargetOwnerDeletionIntent({
    operation: 'delete_target',
    payload: {
      clientRequestId: requestId,
      targetId,
      expectedTargetRevision: revision,
    },
  });
export const ownerReceipt = (
  outcome: 'applied' | 'noop' = 'applied',
): Extract<
  RatingTargetOwnerDeletionReceipt,
  { outcome: 'applied' | 'noop' }
> => ({
  requestId,
  operation: 'delete_target',
  outcome,
  targetId,
  revision: outcome === 'applied' ? nextRevision : revision,
  occurredAt: timestamp,
});
export const cancelledReceipt = (): RatingTargetOwnerDeletionReceipt => ({
  requestId,
  operation: 'delete_target',
  outcome: 'rejected',
  code: 'RATING_TARGET_DELETION_CANCELLED',
});
export function ownerHarness() {
  const s = harness('recovery');
  const calls: string[] = [];
  const gateway: RatingTargetOwnerDeletionGateway = {
    context: async () => {
      calls.push('context');
      return ownerContext();
    },
    command: async () => {
      calls.push('command');
      return ownerReceipt();
    },
    cancel: async () => {
      calls.push('cancel');
      return cancelledReceipt();
    },
    receipt: async () => {
      calls.push('receipt');
      throw missing();
    },
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingTargetOwnerDeletion: gateway,
    ratingTargetChanges: new RatingTargetChanges(),
  };
  const views: RatingTargetOwnerDeletionView[] = [];
  const controller = new RatingTargetOwnerDeletionController(runtime, (view) =>
    views.push(view),
  );
  return {
    ...s,
    runtime,
    gateway,
    calls,
    controller,
    views,
    view: () => views[views.length - 1]!,
  };
}
