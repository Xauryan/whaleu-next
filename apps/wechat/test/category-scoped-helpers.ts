import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { RatingCatalogChanges } from '../src/ratings/catalog-changes';
import {
  decodeRatingCategoryScopedIntent,
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedOperations,
  type RatingCategoryScopedContext,
  type RatingCategoryScopedIntent,
  type RatingCategoryScopedOperation,
  type RatingCategoryScopedPreparation,
  type RatingCategoryScopedReceipt,
  type RatingManagedCategory,
} from '../src/ratings/category-scoped-contract';
import {
  initialRatingCategoryScopedView,
  RatingCategoryScopedController,
  type RatingCategoryScopedView,
} from '../src/ratings/category-scoped-controller';
import type { RatingCategoryScopedGateway } from '../src/ratings/category-scoped-gateway';
import { PendingRatingStore } from '../src/ratings/pending';
import {
  ratingScopedCommandContext,
  type RatingNavigationSelector,
} from '../src/ratings/scoped-contract';
import { setup } from './community-helpers';
import { accountId } from './identity-helpers';
import { scopedContext, scopedNow } from './rating-scoped-helpers';
import { categoryTestId } from './category-management-helpers';
import { requestId, revision, timestamp } from './ratings-helpers';
export const managedId = categoryTestId(901);
export const managedChild = categoryTestId(902);
export const managedArchivedChild = categoryTestId(903);
export const managedOtherRoot = categoryTestId(904);
export const managedCampus = categoryTestId(921);
export const managedCampusB = categoryTestId(922);
export const managedSnapshot = 'a'.repeat(64);
export const managedRoute = {
  scope: 'campus',
  campusId: managedCampus,
  categoryId: managedId,
};
export const managementNow = scopedNow;
export function managementContext(
  selector: RatingNavigationSelector = {
    kind: 'campus',
    campusId: managedCampus,
  },
  now = managementNow,
): RatingCategoryScopedContext {
  return {
    protocolVersion: 2,
    commandContext: ratingScopedCommandContext(
      scopedContext({ selector, purpose: 'interact', mode: 'public' }, now),
    ),
    expiresAt: new Date(now + 300000).toISOString(),
    snapshotRevision: managedSnapshot,
    campusIds: [managedCampus, managedCampusB],
    canManageGlobal: true,
    operations: [...ratingCategoryScopedOperations],
  };
}
export function managedCategory(
  patch: Partial<RatingManagedCategory> = {},
): RatingManagedCategory {
  return {
    id: managedId,
    parentId: null,
    level: 1,
    kind: 'general',
    systemKey: null,
    name: '有效名称',
    description: '校园简介',
    revision,
    baseRevision: categoryTestId(940),
    placementRevision: categoryTestId(941),
    lifecycleRevision: null,
    overrideRevision: null,
    orderRevision: null,
    ordinal: '10',
    businessState: 'enabled',
    hidden: false,
    scopeKeys: [`campus:${managedCampus}`, `campus:${managedCampusB}`],
    baseName: '共享基础名称',
    baseDescription: '共享基础简介',
    override: {
      name: { mode: 'inherit' },
      description: { mode: 'set', value: '校园简介' },
    },
    blockedReason: null,
    ...patch,
  };
}
export function managedCategories(): readonly RatingManagedCategory[] {
  return [
    managedCategory(),
    managedCategory({
      id: managedOtherRoot,
      name: '另一个根分类',
      ordinal: '20',
    }),
    managedCategory({
      id: managedChild,
      parentId: managedId,
      level: 2,
      name: '直接子项',
      ordinal: '30',
      businessState: 'enabled',
    }),
    managedCategory({
      id: managedArchivedChild,
      parentId: managedId,
      level: 2,
      name: '归档子项',
      ordinal: '40',
      businessState: 'archived',
    }),
  ];
}
export function managementIntent(
  operation: RatingCategoryScopedOperation = 'edit_category_base_scoped',
): RatingCategoryScopedIntent {
  const common = {
      clientRequestId: requestId,
      expectedSnapshot: managedSnapshot,
    },
    category = { ...common, categoryId: managedId };
  const node = {
    key: 'root',
    parentKey: null,
    name: '分类 🌊',
    description: '',
  };
  const payloads = {
    create_categories_scoped: {
      ...common,
      parentId: null,
      placement: { kind: 'campuses', campusIds: [managedCampus] },
      nodes: [node],
    },
    edit_category_base_scoped: {
      ...category,
      name: '分类 🌊',
      description: '',
    },
    set_category_override_scoped: {
      ...category,
      name: { mode: 'inherit' },
      description: { mode: 'set', value: '' },
    },
    set_category_visibility_scoped: { ...category, hidden: true },
    reorder_categories_scoped: {
      ...common,
      parentId: null,
      action: 'set',
      orderedIds: [managedOtherRoot, managedId],
    },
    set_category_scope_scoped: {
      ...category,
      placement: { kind: 'campuses', campusIds: [managedCampus] },
      propagation: 'subtree',
    },
    set_category_lifecycle_scoped: {
      ...category,
      state: 'disabled',
      restore: false,
    },
    batch_update_subcategories_scoped: {
      ...common,
      parentId: managedId,
      addNodes: [node],
      disableIds: [managedChild],
      restoreIds: [managedArchivedChild],
      enableIds: [],
      orderedChildren: [
        { kind: 'existing', id: managedChild },
        { kind: 'new', key: 'root' },
        { kind: 'existing', id: managedArchivedChild },
      ],
    },
    create_system_category_scoped: {
      ...common,
      systemKey: 'synthetic_general',
      name: '系统分类',
      description: '',
      placement: { kind: 'global' },
      levelCount: 3,
    },
  };
  return decodeRatingCategoryScopedIntent({
    protocolVersion: 2,
    operation,
    context: managementContext().commandContext,
    payload: payloads[operation],
  });
}
export function managementPreparation(
  intent = managementIntent(),
  now = managementNow,
): RatingCategoryScopedPreparation {
  return {
    requestId: intent.payload.clientRequestId,
    contextRevision: 'p'.repeat(43),
    categoryIds: [managedId],
    affectedScopeKeys: [`campus:${managedCampus}`, `campus:${managedCampusB}`],
    changedSourceCount: 2,
    affectedTargetCount: 7,
    previewDigest: 'b'.repeat(64),
    summary: '完整预览：两个校园共同变更',
    changes: [
      {
        categoryId: managedId,
        scopeKeys: [`campus:${managedCampus}`],
        field: 'body',
        beforeStatus: 'available',
        afterStatus: 'available',
        before: '原共享名称',
        after: '分类 🌊',
      },
    ],
    expiresAt: new Date(now + 180000).toISOString(),
  };
}
export function managementReceipt(
  intent = managementIntent(),
  outcome: 'applied' | 'noop' | 'closed' = 'applied',
): RatingCategoryScopedReceipt {
  const common = {
    protocolVersion: 2 as const,
    requestId: intent.payload.clientRequestId,
    operation: intent.operation,
    intentHash: ratingCategoryScopedIntentHash(intent),
  };
  return outcome === 'closed'
    ? { ...common, outcome, code: 'RATING_CATEGORY_CANCELLED' }
    : {
        ...common,
        outcome,
        result: {
          releaseId: outcome === 'applied' ? categoryTestId(980) : null,
          categoryIds: [managedId],
          heads: [
            {
              scopeKey: `campus:${managedCampus}`,
              catalogRevision: categoryTestId(981),
              headRevision: categoryTestId(982),
            },
          ],
          occurredAt: timestamp,
        },
      };
}
export const missingManagementReceipt = () =>
  new ClientError('http', 'Unknown original result', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
export async function flushManagement(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
export function categoryScopedHarness(editor = true) {
  const s = setup(),
    calls: string[] = [],
    prepared: RatingCategoryScopedIntent[] = [],
    committed: RatingCategoryScopedIntent[] = [],
    cancelled: RatingCategoryScopedIntent[] = [];
  const current = { now: managementNow, rows: managedCategories() };
  const gateway: RatingCategoryScopedGateway = {
    context: async (selector) => {
      calls.push('context');
      return managementContext(selector, current.now);
    },
    categories: async () => {
      calls.push('categories');
      return {
        items: current.rows,
        snapshotRevision: managedSnapshot,
        complete: true,
      };
    },
    category: async (_context, id) => {
      calls.push('category');
      return current.rows.find((item) => item.id === id)!;
    },
    history: async () => {
      calls.push('history');
      return {
        items: [
          {
            requestId,
            operation: 'edit_category_base_scoped',
            outcome: 'applied',
            releaseId: categoryTestId(980),
            occurredAt: timestamp,
          },
        ],
        nextCursor: null,
      };
    },
    systemOptions: async () => {
      calls.push('system-options');
      return {
        items: [
          {
            systemKey: 'synthetic_general',
            kind: 'general',
            maximumDepth: 3,
            allowCampusOverride: true,
            allowDisable: true,
          },
        ],
      };
    },
    prepare: async (intent) => {
      calls.push('prepare');
      prepared.push(intent);
      return managementPreparation(intent, current.now);
    },
    commit: async (intent) => {
      calls.push('commit');
      committed.push(intent);
      return managementReceipt(intent);
    },
    cancel: async (intent) => {
      calls.push('cancel');
      cancelled.push(intent);
      return managementReceipt(intent, 'closed');
    },
    receipt: async () => {
      calls.push('receipt');
      throw missingManagementReceipt();
    },
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ratingCategoryScoped: gateway,
    pendingRatings: new PendingRatingStore(s.storage, 'category-scoped'),
    ratingCatalogChanges: new RatingCatalogChanges(),
    directoryScopeChanges: new PrivateViewLifecycle(),
    browsingScopeChanges: new PrivateViewLifecycle(),
  };
  let view = initialRatingCategoryScopedView();
  const views: RatingCategoryScopedView[] = [];
  const controller = new RatingCategoryScopedController(
    runtime,
    (value) => {
      view = value;
      views.push(value);
    },
    editor,
    { now: () => current.now, schedule: () => () => undefined },
  );
  return {
    ...s,
    runtime,
    gateway,
    calls,
    prepared,
    committed,
    cancelled,
    current,
    controller,
    views,
    view: () => view,
    pending: () => runtime.pendingRatings!.load(accountId),
  };
}
