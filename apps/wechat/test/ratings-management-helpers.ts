import type { CommunityRuntime } from '../src/community/runtime';
import {
  RatingManagementController,
  type RatingManagementView,
} from '../src/ratings/management-controller';
import type { RatingManagementGateway } from '../src/ratings/management-gateway';
import {
  decodeRatingTargetCreationIntent,
  type RatingTargetCreationReceipt,
} from '../src/ratings/management-contract';
import {
  categoryId,
  harness,
  requestId,
  revision,
  nextRevision,
  targetId,
  timestamp,
} from './ratings-helpers';
import { missing } from './ratings-r3a-helpers';
export const creationContext = {
  regionId: null,
  categoryId,
  expectedCategoryRevision: revision,
  expectedCatalogRevision: revision,
};
export const creationIntent = () =>
  decodeRatingTargetCreationIntent({
    operation: 'create_target',
    payload: {
      clientRequestId: requestId,
      ...creationContext,
      name: 'Synthetic target',
      description: '',
      assetIds: [],
    },
  });
export const preparation = () => ({
  requestId,
  targetId,
  revision,
  contextRevision: 'x'.repeat(43),
});
export const creationReceipt = (): Extract<
  RatingTargetCreationReceipt,
  { outcome: 'applied' }
> => ({
  requestId,
  operation: 'create_target',
  outcome: 'applied',
  targetId,
  revision,
  catalogRevision: nextRevision,
  occurredAt: timestamp,
});
export function managementHarness() {
  const s = harness('recovery');
  const calls: string[] = [];
  const gateway: RatingManagementGateway = {
    cancel: async () => {
      calls.push('cancel');
      return {
        requestId,
        operation: 'create_target',
        outcome: 'rejected',
        code: 'RATING_CREATION_CANCELLED',
      };
    },
    prepare: async () => {
      calls.push('prepare');
      return preparation();
    },
    command: async () => {
      calls.push('command');
      return creationReceipt();
    },
    receipt: async () => {
      calls.push('receipt');
      throw missing();
    },
  };
  const runtime: CommunityRuntime = { ...s.runtime, ratingManagement: gateway };
  const views: RatingManagementView[] = [];
  const controller = new RatingManagementController(runtime, (view) =>
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
