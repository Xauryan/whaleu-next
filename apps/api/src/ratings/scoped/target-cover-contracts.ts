import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../community/content-review/contracts.js';
import { ratingCanonicalText, ratingTimeSchema } from '../contracts.js';
import {
  scopedId,
  scopedDigest,
  scopedToken,
  ratingScopedCommandContextSchema,
  ratingScopedClosureSchema,
  ratingScopedIntentSchema,
  ratingScopedReceiptSchema,
  ratingScopedPreparationSchema,
  ratingScopedContextSchema,
} from './contracts.js';
import { ratingScopedCommandHash } from './protocol-registry.js';

// Separate wire codec; frozen v2 decoder continues to reject this protocol.
export const ratingTargetCoverContextSchema = z
  .strictObject({
    ...ratingScopedContextSchema.shape,
    protocolVersion: z.literal(3),
  })
  .superRefine((value, ctx) => {
    const base = ratingScopedContextSchema.safeParse({
      ...value,
      protocolVersion: 2,
    });
    if (!base.success)
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid exact target-cover context',
      });
  });
export type RatingTargetCoverContext = z.infer<
  typeof ratingTargetCoverContextSchema
>;
export type RatingCurrentContext =
  z.infer<typeof ratingScopedContextSchema> | RatingTargetCoverContext;

export const RATING_TARGET_COVER_CAPABILITY = 'target_cover' as const;
export const ratingTargetCoverReferenceSchema = z.strictObject({
  appearanceId: scopedId,
  assetId: scopedId,
  manifestDigest: scopedDigest,
});
export type RatingTargetCoverReference = z.infer<
  typeof ratingTargetCoverReferenceSchema
>;
const replacement = z.strictObject({
  action: z.literal('replace'),
  assetId: scopedId,
  uploadScopeId: scopedId,
});
const clear = z.strictObject({ action: z.literal('clear') });
const body = {
  clientRequestId: scopedId,
  categoryId: scopedId,
  expectedCategoryRevision: scopedId,
  name: ratingCanonicalText(100),
  description: ratingCanonicalText(500, false),
};
const base = {
  protocolVersion: z.literal(3),
  context: ratingScopedCommandContextSchema,
};
/** A new codec; v2's empty assetIds never means clearing a cover. */
export const ratingTargetCoverIntentSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...base,
    operation: z.literal('create_target_scoped'),
    payload: z.strictObject({
      ...body,
      cover: z.discriminatedUnion('action', [clear, replacement]),
    }),
  }),
  z.strictObject({
    ...base,
    operation: z.literal('edit_target_scoped'),
    payload: z.strictObject({
      ...body,
      targetId: scopedId,
      expectedTargetRevision: scopedId,
      expectedDefinitionRevision: scopedId,
      expectedContentVersion: z.number().int().min(1).max(2147483646),
      cover: z.discriminatedUnion('action', [
        z.strictObject({ action: z.literal('keep') }),
        clear,
        replacement,
      ]),
    }),
  }),
]);
export type RatingTargetCoverIntent = z.infer<
  typeof ratingTargetCoverIntentSchema
>;
export function ratingTargetCoverCommandHash(
  raw: RatingTargetCoverIntent,
): string {
  const value = ratingTargetCoverIntentSchema.parse(raw);
  return createHash('sha256')
    .update(
      'whaleu:rating-target-cover-command:v1\n' +
        canonicalJson({
          protocolVersion: value.protocolVersion,
          operation: value.operation,
          intent: { context: value.context, payload: value.payload },
        }),
    )
    .digest('hex');
}
const result = {
  targetId: scopedId,
  revision: scopedId,
  occurredAt: ratingTimeSchema,
};
const resultSchemas = {
  create_target_scoped: z.strictObject({
    ...result,
    catalogRevision: scopedId,
  }),
  edit_target_scoped: z.strictObject({
    ...result,
    definitionRevision: scopedId,
    contentVersion: z.number().int().min(1).max(2147483647),
  }),
};
const receipt = {
  protocolVersion: z.literal(3),
  requestId: scopedId,
  operation: z.enum(['create_target_scoped', 'edit_target_scoped']),
  intentHash: scopedDigest,
};
export const ratingTargetCoverReceiptSchema = z.union([
  z.strictObject({
    ...receipt,
    outcome: z.literal('closed'),
    code: ratingScopedClosureSchema,
  }),
  z
    .strictObject({
      ...receipt,
      outcome: z.enum(['applied', 'noop']),
      result: z.unknown(),
    })
    .superRefine((v, c) => {
      if (!resultSchemas[v.operation].safeParse(v.result).success)
        c.addIssue({
          code: 'custom',
          message: 'Exact target cover result required',
        });
    }),
]);
export type RatingTargetCoverReceipt = z.infer<
  typeof ratingTargetCoverReceiptSchema
>;
export const ratingTargetCoverPreparationSchema =
  ratingScopedPreparationSchema.extend({
    intent: ratingTargetCoverIntentSchema,
  });
export const ratingTargetCoverCommitSchema = z.discriminatedUnion('operation', [
  ratingTargetCoverIntentSchema.options[0].extend({
    preparationContextRevision: scopedToken,
  }),
  ratingTargetCoverIntentSchema.options[1].extend({
    preparationContextRevision: scopedToken,
  }),
]);
/** Dispatch lives outside the frozen historical codecs and hash functions. */
export const ratingCurrentScopedIntentSchema = z.union([
  ratingScopedIntentSchema,
  ratingTargetCoverIntentSchema,
]);
export type RatingCurrentScopedIntent = z.infer<
  typeof ratingCurrentScopedIntentSchema
>;
export const ratingCurrentScopedReceiptSchema = z.union([
  ratingScopedReceiptSchema,
  ratingTargetCoverReceiptSchema,
]);
export type RatingCurrentScopedReceipt = z.infer<
  typeof ratingCurrentScopedReceiptSchema
>;
export function ratingCurrentScopedCommandHash(
  value: RatingCurrentScopedIntent,
): string {
  return value.protocolVersion === 3
    ? ratingTargetCoverCommandHash(value)
    : ratingScopedCommandHash(value);
}
const declaration = z.strictObject({
  mime: z.enum(['image/jpeg', 'image/png']),
  bytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
  sha256: scopedDigest,
});
export const ratingTargetCoverUploadScopeSchema = z.strictObject({
  protocolVersion: z.literal(3),
  context: ratingScopedCommandContextSchema,
  clientRequestId: scopedId,
  commandRequestId: scopedId,
  draftRevision: scopedId,
  categoryId: scopedId,
  expectedCategoryRevision: scopedId,
  target: z
    .strictObject({
      targetId: scopedId,
      expectedTargetRevision: scopedId,
      expectedDefinitionRevision: scopedId,
      expectedContentVersion: z.number().int().min(1).max(2147483646),
    })
    .nullable(),
  declaration,
});
export type RatingTargetCoverUploadScopeInput = z.infer<
  typeof ratingTargetCoverUploadScopeSchema
>;
