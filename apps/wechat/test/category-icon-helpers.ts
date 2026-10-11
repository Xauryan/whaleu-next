import type { CommunityRuntime } from '../src/community/runtime';
import { ClientError } from '../src/api/errors';
import {
  categoryIconTextIntent,
  decodeRatingCategoryIconContext,
  decodeRatingCategoryIconIntent,
  decodeRatingCategoryIconPreparation,
  decodeRatingCategoryIconReceipt,
  decodeRatingManagedIconCategory,
  ratingCategoryIconIntentHash,
  type RatingCategoryIconIntent,
  type RatingCategoryIconReceipt,
} from '../src/ratings/category-icon-contract';
import {
  categoryIconDraftSlots,
  sealCategoryIconDraft,
} from '../src/ratings/category-icon-draft';
import type { RatingCategoryScopedOperation } from '../src/ratings/category-scoped-contract';
import { PendingRatingCategoryIconStore } from '../src/ratings/category-icon-pending';
import type { RatingCategoryIconGateway } from '../src/ratings/category-icon-gateway';
import {
  RatingCategoryScopedController,
  initialRatingCategoryScopedView,
} from '../src/ratings/category-scoped-controller';
import {
  categoryScopedHarness,
  managementIntent,
  managementContext,
  managementPreparation,
  managementReceipt,
  managedCategories,
  managedSnapshot,
  managementNow,
} from './category-scoped-helpers';
export const iconId = (n: number) =>
  `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const mediaSnapshot = 'c'.repeat(64);
export function iconContext(
  selector = managementContext().commandContext.selector,
  now = managementNow,
) {
  return decodeRatingCategoryIconContext({
    ...managementContext(selector, now),
    protocolVersion: 5,
    mediaSnapshot,
    capabilities: ['category_icon'],
  });
}
export function iconIntent(
  operation: RatingCategoryScopedOperation = 'edit_category_base_scoped',
): RatingCategoryIconIntent {
  const text = managementIntent(operation),
    slots = categoryIconDraftSlots(text, new Map());
  return sealCategoryIconDraft(text, mediaSnapshot, slots, []);
}
export function iconPreparation(intent = iconIntent(), now = managementNow) {
  return decodeRatingCategoryIconPreparation({
    ...managementPreparation(categoryIconTextIntent(intent), now),
    protocolVersion: 5,
    mediaSnapshot: intent.mediaSnapshot,
    changedIconCount: 0,
    iconChanges: [],
  });
}
export function iconReceipt(
  intent = iconIntent(),
  outcome: 'applied' | 'noop' | 'closed' = 'applied',
): RatingCategoryIconReceipt {
  const old = managementReceipt(categoryIconTextIntent(intent), outcome);
  return decodeRatingCategoryIconReceipt({
    ...old,
    protocolVersion: 5,
    intentHash: ratingCategoryIconIntentHash(intent),
    ...(old.outcome === 'closed'
      ? {}
      : {
          result: {
            ...old.result,
            mediaReleaseDigest:
              old.result.releaseId === null ? null : 'd'.repeat(64),
          },
        }),
  });
}
export function iconCategory(index = 0) {
  return decodeRatingManagedIconCategory({
    ...managedCategories()[index]!,
    icon: {
      base: { state: 'absent', appearanceId: null },
      override: {
        mode: 'inherit',
        state: { state: 'inherit', appearanceId: null },
      },
      effective: { state: 'absent', appearanceId: null },
    },
  });
}
export function categoryIconHarness() {
  const old = categoryScopedHarness();
  old.controller.dispose();
  const calls: string[] = [],
    prepared: RatingCategoryIconIntent[] = [],
    committed: RatingCategoryIconIntent[] = [],
    current = { now: managementNow };
  const gateway: RatingCategoryIconGateway = {
    entryContext: async (selector) => {
      calls.push('entry');
      return { kind: 'icon', context: iconContext(selector, current.now) };
    },
    context: async (selector) => {
      calls.push('context');
      return iconContext(selector, current.now);
    },
    categories: async () => {
      calls.push('categories');
      return {
        items: managedCategories().map((_item, index) => iconCategory(index)),
        snapshotRevision: managedSnapshot,
        mediaSnapshot,
        complete: true,
      };
    },
    category: async (_context, id) => {
      calls.push('category');
      return managedCategories()
        .map((_item, index) => iconCategory(index))
        .find((item) => item.id === id)!;
    },
    history: async () => ({ items: [], nextCursor: null }),
    systemOptions: async () => ({
      items: [
        {
          systemKey: 'synthetic_general',
          kind: 'general',
          maximumDepth: 3,
          allowCampusOverride: true,
          allowDisable: true,
        },
      ],
    }),
    prepare: async (intent) => {
      calls.push('prepare');
      prepared.push(decodeRatingCategoryIconIntent(intent));
      return iconPreparation(intent, current.now);
    },
    commit: async (intent) => {
      calls.push('commit');
      committed.push(intent);
      return iconReceipt(intent);
    },
    cancel: async (intent) => {
      calls.push('cancel');
      return iconReceipt(intent, 'closed');
    },
    receipt: async () => {
      calls.push('receipt');
      throw new ClientError('http', 'unknown', {
        serverCode: 'REQUEST_NOT_FOUND',
        httpStatus: 404,
      });
    },
    cancelByHash: async (requestId, operation, intentHash) => {
      calls.push('cancel-by-hash');
      return decodeRatingCategoryIconReceipt({
        protocolVersion: 5,
        requestId,
        operation,
        intentHash,
        outcome: 'closed',
        code: 'RATING_CATEGORY_CANCELLED',
      });
    },
    retirementStatus: async () => {
      calls.push('retirement-status');
      throw new ClientError('business', 'No retirement fixture configured');
    },
    cleanupRetirement: async () => {
      calls.push('retirement-cleanup');
      throw new ClientError('business', 'No cleanup fixture configured');
    },
  };
  const store = new PendingRatingCategoryIconStore(
    old.storage,
    'category-scoped',
  );
  store.watchSession(old.runtime.sessions);
  const runtime: CommunityRuntime = {
    ...old.runtime,
    pendingRatingCategoryIcon: store,
    ratingCategoryIcon: gateway,
  };
  let view = initialRatingCategoryScopedView();
  const controller = new RatingCategoryScopedController(
    runtime,
    (value) => {
      view = value;
    },
    true,
    { now: () => current.now, schedule: () => () => undefined },
  );
  return {
    ...old,
    runtime,
    gateway,
    store,
    controller,
    calls,
    prepared,
    committed,
    current,
    view: () => view,
  };
}
