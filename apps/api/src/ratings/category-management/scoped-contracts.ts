import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ratingCanonicalText, ratingTimeSchema } from '../contracts.js';
import {
  ratingNavigationSelectorSchema,
  ratingScopedCommandContextSchema,
  ratingScopedHeadSchema,
  scopedDigest,
  scopedId,
  scopedToken,
} from '../scoped/contracts.js';

export const RATING_CATEGORY_SCOPED_JOURNAL_VERSION = 10 as const;
export const RATING_CATEGORY_MANAGEMENT_POLICY =
  'native_scoped_category_management' as const;
export const RATING_CATEGORY_SYSTEM_REGISTRY =
  'scoped_category_system_registry' as const;
export const ratingCategoryScopedOperations = [
  'create_categories_scoped',
  'edit_category_base_scoped',
  'set_category_override_scoped',
  'set_category_visibility_scoped',
  'reorder_categories_scoped',
  'set_category_scope_scoped',
  'set_category_lifecycle_scoped',
  'batch_update_subcategories_scoped',
  'create_system_category_scoped',
] as const;
export const ratingCategoryScopedOperationSchema = z.enum(
  ratingCategoryScopedOperations,
);
export type RatingCategoryScopedOperation = z.infer<
  typeof ratingCategoryScopedOperationSchema
>;
export const categoryPlacementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({
    kind: z.literal('campuses'),
    campusIds: z
      .array(scopedId)
      .min(1)
      .max(1000)
      .refine((v) => v.every((id, n) => n === 0 || v[n - 1]! < id)),
  }),
]);
const key = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
export const categoryNodeSchema = z.strictObject({
  key,
  parentKey: key.nullable(),
  name: ratingCanonicalText(100),
  description: ratingCanonicalText(500, false),
});
export const categoryNameOverrideSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('inherit') }),
  z.strictObject({ mode: z.literal('set'), value: ratingCanonicalText(100) }),
]);
export const categoryDescriptionOverrideSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('inherit') }),
  z.strictObject({
    mode: z.literal('set'),
    value: ratingCanonicalText(500, false),
  }),
]);
export const categoryStateSchema = z.enum(['enabled', 'disabled', 'archived']);
const envelope = {
  protocolVersion: z.literal(2),
  context: ratingScopedCommandContextSchema,
};
const common = { clientRequestId: scopedId, expectedSnapshot: scopedDigest };
const category = { ...common, categoryId: scopedId };
export const ratingCategoryScopedIntentSchema = z.discriminatedUnion(
  'operation',
  [
    z.strictObject({
      ...envelope,
      operation: z.literal('create_categories_scoped'),
      payload: z.strictObject({
        ...common,
        parentId: scopedId.nullable(),
        placement: categoryPlacementSchema,
        nodes: z.array(categoryNodeSchema).min(1).max(32),
      }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('edit_category_base_scoped'),
      payload: z.strictObject({
        ...category,
        name: ratingCanonicalText(100),
        description: ratingCanonicalText(500, false),
      }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('set_category_override_scoped'),
      payload: z.strictObject({
        ...category,
        name: categoryNameOverrideSchema,
        description: categoryDescriptionOverrideSchema,
      }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('set_category_visibility_scoped'),
      payload: z.strictObject({ ...category, hidden: z.boolean() }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('reorder_categories_scoped'),
      payload: z.strictObject({
        ...common,
        parentId: scopedId.nullable(),
        action: z.enum(['set', 'inherit']),
        orderedIds: z
          .array(scopedId)
          .max(10000)
          .refine((v) => new Set(v).size === v.length),
      }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('set_category_scope_scoped'),
      payload: z.strictObject({
        ...category,
        placement: categoryPlacementSchema,
        propagation: z.enum(['self', 'subtree']),
      }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('set_category_lifecycle_scoped'),
      payload: z.strictObject({
        ...category,
        state: categoryStateSchema,
        restore: z.boolean(),
      }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('batch_update_subcategories_scoped'),
      payload: z.strictObject({
        ...common,
        parentId: scopedId,
        addNodes: z
          .array(categoryNodeSchema.extend({ parentKey: z.null() }))
          .max(32),
        disableIds: z.array(scopedId).max(10000),
        restoreIds: z.array(scopedId).max(10000),
        enableIds: z.array(scopedId).max(10000),
        orderedChildren: z
          .array(
            z.discriminatedUnion('kind', [
              z.strictObject({ kind: z.literal('existing'), id: scopedId }),
              z.strictObject({ kind: z.literal('new'), key }),
            ]),
          )
          .max(10000),
      }),
    }),
    z.strictObject({
      ...envelope,
      operation: z.literal('create_system_category_scoped'),
      payload: z.strictObject({
        ...common,
        systemKey: z.string().regex(/^[a-z][a-z0-9_]{1,48}$/),
        name: ratingCanonicalText(100),
        description: ratingCanonicalText(500, false),
        placement: categoryPlacementSchema,
        levelCount: z.number().int().min(1).max(3),
      }),
    }),
  ],
);
export type RatingCategoryScopedIntent = z.infer<
  typeof ratingCategoryScopedIntentSchema
>;
export const ratingCategoryManagementContextRequestSchema = z.strictObject({
  selector: ratingNavigationSelectorSchema,
});
export const ratingCategoryManagementContextSchema = z.strictObject({
  protocolVersion: z.literal(2),
  commandContext: ratingScopedCommandContextSchema,
  expiresAt: ratingTimeSchema,
  snapshotRevision: scopedDigest,
  campusIds: z.array(scopedId).max(1000),
  canManageGlobal: z.boolean(),
  operations: z.array(ratingCategoryScopedOperationSchema).max(9),
});
export const ratingCategoryManagementQuerySchema = z.strictObject({
  contextId: scopedId,
  contextToken: scopedToken,
});
export const ratingManagedCategorySchema = z.strictObject({
  id: scopedId,
  parentId: scopedId.nullable(),
  level: z.number().int().min(1).max(3),
  kind: z.string(),
  systemKey: z.string().nullable(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  revision: scopedId,
  baseRevision: scopedId,
  placementRevision: scopedId,
  lifecycleRevision: scopedId.nullable(),
  overrideRevision: scopedId.nullable(),
  orderRevision: scopedId.nullable(),
  ordinal: z.string().regex(/^(0|[1-9][0-9]*)$/),
  businessState: categoryStateSchema,
  hidden: z.boolean(),
  scopeKeys: z.array(z.string()).max(1001),
  baseName: z.string().nullable(),
  baseDescription: z.string().nullable(),
  override: z.strictObject({
    name: categoryNameOverrideSchema,
    description: categoryDescriptionOverrideSchema,
  }),
  blockedReason: z.string().nullable(),
});
export const ratingManagedCategoriesSchema = z.strictObject({
  items: z.array(ratingManagedCategorySchema).max(10000),
  snapshotRevision: scopedDigest,
  complete: z.literal(true),
});
export const ratingCategorySystemOptionsSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        systemKey: z.string(),
        kind: z.string(),
        maximumDepth: z.number().int().min(1).max(3),
        allowCampusOverride: z.boolean(),
        allowDisable: z.boolean(),
      }),
    )
    .max(1000),
});
export const ratingCategoryScopedReceiptSchema = z.discriminatedUnion(
  'outcome',
  [
    z.strictObject({
      protocolVersion: z.literal(2),
      requestId: scopedId,
      operation: ratingCategoryScopedOperationSchema,
      intentHash: scopedDigest,
      outcome: z.enum(['applied', 'noop']),
      result: z.strictObject({
        releaseId: scopedId.nullable(),
        categoryIds: z.array(scopedId).max(10000),
        heads: z.array(ratingScopedHeadSchema).max(1001),
        occurredAt: ratingTimeSchema,
      }),
    }),
    z.strictObject({
      protocolVersion: z.literal(2),
      requestId: scopedId,
      operation: ratingCategoryScopedOperationSchema,
      intentHash: scopedDigest,
      outcome: z.literal('closed'),
      code: z.enum([
        'RATING_CATEGORY_CANCELLED',
        'RATING_SCOPED_CONTEXT_CHANGED',
        'RATING_REVISION_CONFLICT',
        'RATING_NOT_FOUND',
        'CONTENT_REJECTED',
        'PHONE_VERIFICATION_REQUIRED',
        'SAFETY_ACTION_RESTRICTED',
      ]),
    }),
  ],
);
export type RatingCategoryScopedReceipt = z.infer<
  typeof ratingCategoryScopedReceiptSchema
>;
export const ratingCategoryScopedPreparationSchema = z.strictObject({
  requestId: scopedId,
  contextRevision: scopedToken,
  categoryIds: z.array(scopedId).max(10000),
  affectedScopeKeys: z.array(z.string()).min(1).max(1001),
  changedSourceCount: z.number().int().min(0).max(100000),
  affectedTargetCount: z.number().int().min(0),
  previewDigest: scopedDigest,
  summary: z.string(),
  changes: z
    .array(
      z.strictObject({
        categoryId: scopedId,
        scopeKeys: z.array(z.string()).max(1001),
        field: z.enum([
          'body',
          'base_body',
          'effective_body',
          'visibility',
          'lifecycle',
          'scope',
          'order',
          'create',
        ]),
        before: z.string().nullable(),
        after: z.string().nullable(),
        beforeStatus: z.enum(['available', 'absent', 'unavailable']),
        afterStatus: z.enum(['available', 'absent', 'unavailable']),
      }),
    )
    .max(100000),
  expiresAt: ratingTimeSchema,
});
export const ratingCategoryScopedPrepareResultSchema = z.union([
  ratingCategoryScopedPreparationSchema,
  ratingCategoryScopedReceiptSchema,
]);
export const ratingCategoryScopedCommitSchema = z.strictObject({
  intent: ratingCategoryScopedIntentSchema,
  preparationContextRevision: scopedToken,
});
export const ratingCategoryManagementHistoryQuerySchema =
  ratingCategoryManagementQuerySchema.extend({ cursor: scopedId.optional() });
export const ratingCategoryManagementHistorySchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        requestId: scopedId,
        operation: ratingCategoryScopedOperationSchema,
        outcome: z.enum(['applied', 'noop', 'closed']),
        releaseId: scopedId.nullable(),
        occurredAt: ratingTimeSchema,
      }),
    )
    .max(100),
  nextCursor: scopedId.nullable(),
});
export function ratingCategoryScopedIntentHash(
  value: RatingCategoryScopedIntent,
): string {
  return createHash('sha256')
    .update(
      'whaleu:rating-scoped-command:v1\n' +
        canonicalJson({
          protocolVersion: value.protocolVersion,
          operation: value.operation,
          intent: { context: value.context, payload: value.payload },
        }),
    )
    .digest('hex');
}
