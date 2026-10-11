import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalEqual, canonicalJson } from './contracts.js';
import { scopedDigest, scopedId } from '../../ratings/scoped/contracts.js';
import { ratingCategoryScopedOperationSchema } from '../../ratings/category-management/scoped-contracts.js';
import { RATING_CATEGORY_ICON_REVIEW } from '../../ratings/category-management/icon-contracts.js';
import {
  categoryIconContentDigest,
  categoryIconContentSchema,
} from '../../ratings/category-management/icon-extension.js';

/** A composite approval is never a v5 source approval. New Category publication
 * consumes this decision independently, then binds it to an exact definition. */
export const ratingCategoryIconEnvelopeSchema = z
  .strictObject({
    version: z.literal(RATING_CATEGORY_ICON_REVIEW),
    purpose: z.literal('publish_rating_category_icon'),
    accountId: scopedId,
    clientRequestId: scopedId,
    operation: ratingCategoryScopedOperationSchema,
    intentHash: scopedDigest,
    textHash: scopedDigest,
    textPlanDigest: scopedDigest,
    mediaPlanDigest: scopedDigest,
    beforeSnapshot: scopedDigest,
    context: z.strictObject({
      id: scopedId,
      digest: scopedDigest,
      protocolGeneration: scopedId,
      topologySnapshotId: scopedId.nullable(),
      sourceDigest: scopedDigest,
    }),
    definitionId: scopedId,
    definitionDigest: scopedDigest,
    content: categoryIconContentSchema,
    assetIds: z.array(scopedId).max(1),
  })
  .superRefine((envelope, ctx) => {
    const icon = envelope.content.icon;
    if (
      envelope.definitionDigest !==
        categoryIconContentDigest(envelope.content) ||
      (icon.kind === 'image'
        ? envelope.assetIds.length !== 1 ||
          envelope.assetIds[0] !== icon.appearance.assetId
        : envelope.assetIds.length !== 0) ||
      (envelope.content.selector.kind === 'campus' &&
        envelope.context.topologySnapshotId === null)
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Exact composite Category content, source and trusted icon required',
      });
  });
export type RatingCategoryIconEnvelope = z.infer<
  typeof ratingCategoryIconEnvelopeSchema
>;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function canonicalRatingCategoryIconEnvelope(
  value: unknown,
): RatingCategoryIconEnvelope {
  const envelope = ratingCategoryIconEnvelopeSchema.parse(value);
  if (!canonicalEqual(value, envelope))
    throw new Error('Noncanonical Category icon Review envelope');
  return freeze(envelope);
}
export function ratingCategoryIconApprovalDigest(
  value: RatingCategoryIconEnvelope,
): string {
  return createHash('sha256')
    .update(
      `whaleu-rating-content-approval:v8\n${canonicalJson(canonicalRatingCategoryIconEnvelope(value))}`,
    )
    .digest('hex');
}
export interface RatingCategoryIconDefinitionDescriptor {
  readonly definitionId: string;
  readonly definitionDigest: string;
  readonly envelope: RatingCategoryIconEnvelope;
}
export function canonicalRatingCategoryIconDefinition(
  value: unknown,
): RatingCategoryIconDefinitionDescriptor {
  const descriptor = z
    .strictObject({
      definitionId: scopedId,
      definitionDigest: scopedDigest,
      envelope: z.unknown(),
    })
    .parse(value);
  const envelope = canonicalRatingCategoryIconEnvelope(descriptor.envelope);
  if (
    envelope.definitionId !== descriptor.definitionId ||
    envelope.definitionDigest !== descriptor.definitionDigest
  )
    throw new Error('Invalid exact Category icon definition');
  return Object.freeze({ ...descriptor, envelope });
}

export interface AcceptedRatingCategoryIconApproval {
  readonly version: typeof RATING_CATEGORY_ICON_REVIEW;
  readonly decisionId: string;
  readonly digest: string;
  readonly envelope: RatingCategoryIconEnvelope;
}
