import type { CommunityRuntime } from '../src/community/runtime';
import {
  RatingTargetOwnerEditingController,
  type RatingTargetOwnerEditingView,
} from '../src/ratings/target-owner-editing-controller';
import type { RatingTargetOwnerEditingGateway } from '../src/ratings/target-owner-editing-gateway';
import {
  decodeRatingTargetOwnerEditingIntent,
  type RatingTargetOwnerEditingContext,
  type RatingTargetOwnerEditingPreparation,
  type RatingTargetOwnerEditingReceipt,
} from '../src/ratings/target-owner-editing-contract';
import { RatingTargetChanges } from '../src/ratings/target-changes';
import {
  categoryId,
  harness,
  nextRevision,
  requestId,
  revision,
  targetId,
  timestamp,
} from './ratings-helpers';
import { missing } from './ratings-r3a-helpers';

export const definitionRevision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const nextDefinitionRevision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const editedName = 'Edited synthetic target';
export const editedDescription = 'Edited synthetic description';
export const editingContext = (): RatingTargetOwnerEditingContext => ({
  targetId,
  revision,
  definitionRevision,
  contentVersion: 3,
  regionId: null,
  categoryId,
  categoryRevision: revision,
  catalogRevision: revision,
  name: 'Current authorized target',
  description: 'Current authorized description',
});
export const editingIntent = () =>
  decodeRatingTargetOwnerEditingIntent({
    operation: 'edit_target',
    payload: {
      clientRequestId: requestId,
      targetId,
      regionId: null,
      expectedTargetRevision: revision,
      expectedDefinitionRevision: definitionRevision,
      expectedContentVersion: 3,
      categoryId,
      expectedCategoryRevision: revision,
      expectedCatalogRevision: revision,
      name: editedName,
      description: editedDescription,
      assetIds: [],
    },
  });
export const editingPreparation = (): RatingTargetOwnerEditingPreparation => ({
  requestId,
  targetId,
  revision: nextRevision,
  definitionRevision: nextDefinitionRevision,
  contentVersion: 4,
  contextRevision: 'x'.repeat(43),
});
export const editingReceipt = (
  outcome: 'applied' | 'noop' = 'applied',
): Extract<
  RatingTargetOwnerEditingReceipt,
  { outcome: 'applied' | 'noop' }
> => ({
  requestId,
  operation: 'edit_target',
  outcome,
  targetId,
  revision: outcome === 'applied' ? nextRevision : revision,
  definitionRevision:
    outcome === 'applied' ? nextDefinitionRevision : definitionRevision,
  contentVersion: outcome === 'applied' ? 4 : 3,
  occurredAt: timestamp,
});
export const cancelledEditingReceipt = (): Extract<
  RatingTargetOwnerEditingReceipt,
  { outcome: 'rejected' }
> => ({
  requestId,
  operation: 'edit_target',
  outcome: 'rejected',
  code: 'RATING_EDIT_CANCELLED',
});
export function editingHarness() {
  const s = harness('recovery');
  const calls: string[] = [];
  const gateway: RatingTargetOwnerEditingGateway = {
    context: async () => {
      calls.push('context');
      return editingContext();
    },
    prepare: async () => {
      calls.push('prepare');
      return editingPreparation();
    },
    command: async () => {
      calls.push('command');
      return editingReceipt();
    },
    cancel: async () => {
      calls.push('cancel');
      return cancelledEditingReceipt();
    },
    receipt: async () => {
      calls.push('receipt');
      throw missing();
    },
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingTargetOwnerEditing: gateway,
    ratingTargetChanges: new RatingTargetChanges(),
  };
  const views: RatingTargetOwnerEditingView[] = [];
  const controller = new RatingTargetOwnerEditingController(runtime, (view) =>
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
