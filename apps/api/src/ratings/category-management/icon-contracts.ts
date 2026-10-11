import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { scopedDigest, scopedId, scopedToken } from '../scoped/contracts.js';
import {
  ratingCategoryScopedOperationSchema,
  ratingCategoryManagementContextSchema,
  ratingCategoryScopedReceiptSchema,
  ratingCategoryScopedPreparationSchema,
  ratingManagedCategorySchema,
  ratingManagedCategoriesSchema,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedIntentHash,
  type RatingCategoryScopedIntent,
} from './scoped-contracts.js';

/** New, independently dispatched protocols. No existing codec accepts these. */
export const RATING_CATEGORY_ICON_PROTOCOL = 5 as const;
export const RATING_CATEGORY_ICON_REVIEW = 8 as const;
export const RATING_CATEGORY_ICON_MEDIA = 8 as const;
export const RATING_CATEGORY_ICON_JOURNAL = 13 as const;
export const RATING_CATEGORY_ICON_CAPABILITY = 'category_icon' as const;
export const RATING_CATEGORY_ICON_EXTENSION =
  'ratings-category-icon-v1' as const;

export const categoryIconReplacementSchema = z.strictObject({
  mode: z.literal('replace'),
  assetId: scopedId,
  uploadScopeId: scopedId,
});
export const categoryIconCreateSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('clear') }),
  categoryIconReplacementSchema,
]);
export const categoryIconBaseEditSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('keep') }),
  z.strictObject({ mode: z.literal('clear') }),
  categoryIconReplacementSchema,
]);
export const categoryIconOverrideEditSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('inherit') }),
  z.strictObject({
    mode: z.literal('set'),
    value: z
      .discriminatedUnion('mode', [
        z.strictObject({ mode: z.literal('keep') }),
        categoryIconReplacementSchema,
      ])
      .nullable(),
  }),
]);
export type CategoryIconReplacement = z.infer<
  typeof categoryIconReplacementSchema
>;
export type CategoryIconBaseEdit = z.infer<typeof categoryIconBaseEditSchema>;
export type CategoryIconOverrideEdit = z.infer<
  typeof categoryIconOverrideEditSchema
>;

const old = ratingCategoryScopedIntentSchema.options;
const envelope = {
  protocolVersion: z.literal(RATING_CATEGORY_ICON_PROTOCOL),
  mediaSnapshot: scopedDigest,
};
const rawIconIntent = z.discriminatedUnion('operation', [
  old[0].extend({
    ...envelope,
    payload: old[0].shape.payload.extend({
      nodes: z
        .array(
          old[0].shape.payload.shape.nodes.element.extend({
            icon: categoryIconCreateSchema,
          }),
        )
        .min(1)
        .max(32),
    }),
  }),
  old[1].extend({
    ...envelope,
    payload: old[1].shape.payload.extend({ icon: categoryIconBaseEditSchema }),
  }),
  old[2].extend({
    ...envelope,
    payload: old[2].shape.payload.extend({
      icon: categoryIconOverrideEditSchema,
    }),
  }),
  old[3].extend(envelope),
  old[4].extend(envelope),
  old[5].extend(envelope),
  old[6].extend(envelope),
  old[7].extend({
    ...envelope,
    payload: old[7].shape.payload.extend({
      addNodes: z
        .array(
          old[7].shape.payload.shape.addNodes.element.extend({
            icon: categoryIconCreateSchema,
          }),
        )
        .max(32),
    }),
  }),
  old[8].extend({
    ...envelope,
    payload: old[8].shape.payload.extend({ icon: categoryIconCreateSchema }),
  }),
]);
export type RatingCategoryIconIntent = z.infer<typeof rawIconIntent>;

/** Enumerates every new slot, including every node of a 32-node atomic create. */
export function categoryIconReplacements(
  intent: RatingCategoryIconIntent,
): CategoryIconReplacement[] {
  switch (intent.operation) {
    case 'create_categories_scoped':
      return intent.payload.nodes.flatMap((node) =>
        node.icon.mode === 'replace' ? [node.icon] : [],
      );
    case 'batch_update_subcategories_scoped':
      return intent.payload.addNodes.flatMap((node) =>
        node.icon.mode === 'replace' ? [node.icon] : [],
      );
    case 'edit_category_base_scoped':
    case 'create_system_category_scoped':
      return intent.payload.icon.mode === 'replace'
        ? [intent.payload.icon]
        : [];
    case 'set_category_override_scoped': {
      const icon = intent.payload.icon;
      return icon.mode === 'set' && icon.value?.mode === 'replace'
        ? [icon.value]
        : [];
    }
    default:
      return [];
  }
}
export const ratingCategoryIconIntentSchema = rawIconIntent.superRefine(
  (intent, ctx) => {
    const refs = categoryIconReplacements(intent);
    if (new Set(refs.map((ref) => ref.assetId)).size !== refs.length)
      ctx.addIssue({
        code: 'custom',
        message: 'A new image belongs to exactly one Category icon slot',
      });
    if (new Set(refs.map((ref) => ref.uploadScopeId)).size !== refs.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Each Category icon requires its exact upload scope',
      });
    if (
      intent.operation === 'set_category_override_scoped' &&
      intent.context.selector.kind !== 'campus'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Category icon overrides require an exact campus',
      });
  },
);

/** Pure text-planner input, never a v2 wire command or a second request claim.
 * The original text hash is retained only inside the composite plan; the shared
 * request claim always uses the v5 outer hash. Node IDs use this text hash. */
export function categoryIconTextIntent(
  raw: RatingCategoryIconIntent,
): RatingCategoryScopedIntent {
  const intent = ratingCategoryIconIntentSchema.parse(raw);
  const { mediaSnapshot: _snapshot, ...base } = intent;
  void _snapshot;
  let payload: unknown = intent.payload;
  switch (intent.operation) {
    case 'create_categories_scoped':
      payload = {
        ...intent.payload,
        nodes: intent.payload.nodes.map(({ icon: _icon, ...node }) => node),
      };
      break;
    case 'batch_update_subcategories_scoped':
      payload = {
        ...intent.payload,
        addNodes: intent.payload.addNodes.map(
          ({ icon: _icon, ...node }) => node,
        ),
      };
      break;
    case 'edit_category_base_scoped':
    case 'set_category_override_scoped':
    case 'create_system_category_scoped': {
      const { icon: _icon, ...text } = intent.payload;
      void _icon;
      payload = text;
      break;
    }
  }
  return ratingCategoryScopedIntentSchema.parse({
    ...base,
    protocolVersion: 2,
    payload,
  });
}
export function ratingCategoryIconIntentHash(raw: RatingCategoryIconIntent) {
  return createHash('sha256')
    .update(
      `ratings-category-icon-command:v1:${canonicalJson(ratingCategoryIconIntentSchema.parse(raw))}`,
    )
    .digest('hex');
}
export const ratingCategoryIconContextSchema =
  ratingCategoryManagementContextSchema.extend({
    protocolVersion: z.literal(RATING_CATEGORY_ICON_PROTOCOL),
    mediaSnapshot: scopedDigest,
    capabilities: z.tuple([z.literal(RATING_CATEGORY_ICON_CAPABILITY)]),
  });

/** Provider metadata is never accepted as an upload or command authorization. */
export const categoryIconAppearanceSchema = z.strictObject({
  appearanceId: scopedId,
  assetId: scopedId,
  manifestDigest: scopedDigest,
  actorId: scopedId,
  categoryId: scopedId,
  identityId: scopedId,
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('base') }),
    z.strictObject({ kind: z.literal('override'), campusId: scopedId }),
  ]),
});
export type CategoryIconAppearance = z.infer<
  typeof categoryIconAppearanceSchema
>;

export function categoryIconTextHash(raw: RatingCategoryIconIntent) {
  return ratingCategoryScopedIntentHash(categoryIconTextIntent(raw));
}

export const categoryIconStateSchema = z
  .strictObject({
    state: z.enum(['image', 'absent', 'inherit', 'unavailable']),
    appearanceId: scopedId.nullable(),
  })
  .refine(
    (state) => (state.state === 'image') === (state.appearanceId !== null),
  );
export const categoryIconChangeSchema = z
  .strictObject({
    categoryId: scopedId,
    kind: z.enum(['base', 'override']),
    campusId: scopedId.nullable(),
    before: categoryIconStateSchema,
    after: categoryIconStateSchema,
  })
  .refine((change) => (change.kind === 'base') === (change.campusId === null));
export const ratingCategoryIconPreparationSchema =
  ratingCategoryScopedPreparationSchema.extend({
    protocolVersion: z.literal(5),
    mediaSnapshot: scopedDigest,
    changedIconCount: z.number().int().min(0).max(100000),
    iconChanges: z.array(categoryIconChangeSchema).max(100000),
  });
const oldReceipt = ratingCategoryScopedReceiptSchema.options;
export const ratingCategoryIconReceiptSchema = z.discriminatedUnion('outcome', [
  oldReceipt[0]
    .extend({
      protocolVersion: z.literal(5),
      result: oldReceipt[0].shape.result.extend({
        mediaReleaseDigest: scopedDigest.nullable(),
      }),
    })
    .refine(
      (receipt) =>
        (receipt.result.releaseId === null) ===
        (receipt.result.mediaReleaseDigest === null),
    ),
  oldReceipt[1].extend({ protocolVersion: z.literal(5) }),
]);
export type RatingCategoryIconReceipt = z.infer<
  typeof ratingCategoryIconReceiptSchema
>;
export const ratingCategoryIconPrepareResultSchema = z.union([
  ratingCategoryIconPreparationSchema,
  ratingCategoryIconReceiptSchema,
]);
export const ratingCategoryIconCommitSchema = z.strictObject({
  intent: ratingCategoryIconIntentSchema,
  preparationContextRevision: scopedToken,
});
export const ratingManagedCategoryIconSchema =
  ratingManagedCategorySchema.extend({
    icon: z
      .strictObject({
        base: categoryIconStateSchema,
        override: z.strictObject({
          mode: z.enum(['inherit', 'set']),
          state: categoryIconStateSchema,
        }),
        effective: categoryIconStateSchema,
      })
      .refine(
        (value) =>
          value.base.state !== 'inherit' &&
          value.effective.state !== 'inherit' &&
          (value.override.mode === 'inherit') ===
            (value.override.state.state === 'inherit'),
      ),
  });
export const ratingManagedCategoryIconsSchema =
  ratingManagedCategoriesSchema.extend({
    items: z.array(ratingManagedCategoryIconSchema).max(10000),
    mediaSnapshot: scopedDigest,
  });
const uploadScopeFields = {
  protocolVersion: z.literal(5),
  mediaSnapshot: scopedDigest,
  clientRequestId: scopedId,
  draftRevision: scopedId,
  slot: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('new'),
      key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    }),
    z.strictObject({ kind: z.literal('base'), categoryId: scopedId }),
    z.strictObject({
      kind: z.literal('override'),
      categoryId: scopedId,
      campusId: scopedId,
    }),
  ]),
  declaration: z.strictObject({
    mime: z.enum(['image/jpeg', 'image/png']),
    bytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    sha256: scopedDigest,
  }),
};
/** A scope reserves one exact future slot. Its protocol5 payload carries only
 * text planning fields; it is neither a publishable v2 intent nor a claim. */
export const ratingCategoryIconUploadScopeSchema = z
  .discriminatedUnion('operation', [
    old[0].extend(uploadScopeFields),
    old[1].extend(uploadScopeFields),
    old[2].extend(uploadScopeFields),
    old[3].extend(uploadScopeFields),
    old[4].extend(uploadScopeFields),
    old[5].extend(uploadScopeFields),
    old[6].extend(uploadScopeFields),
    old[7].extend(uploadScopeFields),
    old[8].extend(uploadScopeFields),
  ])
  .superRefine((input, ctx) => {
    let valid = false;
    switch (input.operation) {
      case 'create_categories_scoped':
        valid =
          input.slot.kind === 'new' &&
          input.payload.nodes.some(
            (node) => input.slot.kind === 'new' && node.key === input.slot.key,
          );
        break;
      case 'batch_update_subcategories_scoped':
        valid =
          input.slot.kind === 'new' &&
          input.payload.addNodes.some(
            (node) => input.slot.kind === 'new' && node.key === input.slot.key,
          );
        break;
      case 'create_system_category_scoped':
        valid = input.slot.kind === 'new' && input.slot.key === 'root';
        break;
      case 'edit_category_base_scoped':
        valid =
          input.slot.kind === 'base' &&
          input.slot.categoryId === input.payload.categoryId;
        break;
      case 'set_category_override_scoped':
        valid =
          input.slot.kind === 'override' &&
          input.slot.categoryId === input.payload.categoryId &&
          input.context.selector.kind === 'campus' &&
          input.slot.campusId === input.context.selector.campusId;
        break;
    }
    if (!valid || input.clientRequestId === input.payload.clientRequestId)
      ctx.addIssue({
        code: 'custom',
        message:
          'Upload scope must name one new exact icon slot and a distinct upload request',
      });
  });
export type RatingCategoryIconUploadScopeInput = z.infer<
  typeof ratingCategoryIconUploadScopeSchema
>;
export const ratingCategoryIconUploadScopeResultSchema = z.strictObject({
  editScopeId: scopedId,
  scopeRevision: scopedDigest,
  categoryId: scopedId,
  identityId: scopedId,
  expiresAt: z.iso.datetime(),
});

export function categoryIconUploadScopeRequestHash(
  raw: RatingCategoryIconUploadScopeInput,
) {
  return createHash('sha256')
    .update(
      `ratings-category-icon-upload-scope:v1:${canonicalJson(ratingCategoryIconUploadScopeSchema.parse(raw))}`,
    )
    .digest('hex');
}
export const ratingCategoryIconUploadScopeRecoverySchema = z.strictObject({
  clientRequestId: scopedId,
  requestHash: scopedDigest,
});
export const ratingCategoryIconRecoveryClosureSchema = z.strictObject({
  protocolVersion: z.literal(5),
  requestId: scopedId,
  operation: ratingCategoryScopedOperationSchema,
  intentHash: scopedDigest,
});

export const categoryIconRetirementRequestSchema = z.strictObject({
  requestId: scopedId,
  appearanceIds: z
    .array(scopedId)
    .min(1)
    .max(256)
    .refine((ids) => new Set(ids).size === ids.length),
});
export const categoryIconRetirementStatusRequestSchema = z.union([
  z.strictObject({ requestId: scopedId }),
  categoryIconRetirementRequestSchema,
]);
export const categoryIconRetirementStatusSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        appearanceId: scopedId,
        state: z.enum(['eligible', 'held', 'retired']),
      }),
    )
    .max(100000),
});
export const categoryIconRetirementCleanupSchema = z.strictObject({
  state: z.literal('cleanup_pending'),
  appearanceIds: z
    .array(scopedId)
    .min(1)
    .max(256)
    .refine((ids) => new Set(ids).size === ids.length),
});
