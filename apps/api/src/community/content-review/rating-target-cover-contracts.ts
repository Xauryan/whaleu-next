import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ratingText } from '../../ratings/contracts.js';
import { ratingTargetCoverReferenceSchema } from '../../ratings/scoped/target-cover-contracts.js';
import { ratingScopedReviewScopeSchema } from './rating-scoped-contracts.js';
import { canonicalEqual, canonicalJson } from './contracts.js';
const id = z.uuid().refine((value) => value === value.toLowerCase());
const base = {
  version: z.literal(6),
  accountId: id,
  clientRequestId: id,
  targetId: id,
  targetRevision: id,
  categoryId: id,
  categoryRevision: id,
  scope: ratingScopedReviewScopeSchema,
  targetOrigin: z.strictObject({
    regionId: id.nullable(),
    originCampusId: id.nullable(),
  }),
  definitionRevision: id,
  name: ratingText(100),
  description: ratingText(500, false),
  cover: ratingTargetCoverReferenceSchema.nullable(),
};
export const ratingTargetCoverEnvelopeSchema = z.discriminatedUnion('purpose', [
  z
    .strictObject({
      ...base,
      purpose: z.literal('publish_rating_target_cover_scoped'),
      contentVersion: z.literal(1),
    })
    .refine((v) => v.definitionRevision === v.targetRevision),
  z
    .strictObject({
      ...base,
      purpose: z.literal('edit_rating_target_cover_scoped'),
      contentVersion: z.number().int().min(2).max(2147483647),
      previousTargetRevision: id,
      previousDefinitionRevision: id,
    })
    .refine(
      (v) =>
        v.previousTargetRevision !== v.targetRevision &&
        v.previousDefinitionRevision !== v.definitionRevision,
    ),
]);
export type RatingTargetCoverEnvelope = z.infer<
  typeof ratingTargetCoverEnvelopeSchema
>;
export interface AcceptedRatingTargetCoverApproval {
  readonly decisionId: string;
  readonly digest: string;
  readonly version: 6;
  readonly envelope: RatingTargetCoverEnvelope;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function canonicalRatingTargetCoverEnvelope(
  value: unknown,
): RatingTargetCoverEnvelope {
  const envelope = ratingTargetCoverEnvelopeSchema.parse(value);
  if (!canonicalEqual(envelope, value))
    throw new Error('Noncanonical target cover Review envelope');
  return freeze(envelope);
}
export function ratingTargetCoverApprovalDigest(
  value: RatingTargetCoverEnvelope,
): string {
  return createHash('sha256')
    .update(
      `whaleu-rating-content-approval:v6\n${canonicalJson(canonicalRatingTargetCoverEnvelope(value))}`,
    )
    .digest('hex');
}
export interface RatingTargetCoverDefinitionDescriptor {
  readonly targetId: string;
  readonly contentVersion: number;
  readonly definitionRevision: string;
  readonly appliedTargetRevision: string;
  readonly envelope: RatingTargetCoverEnvelope;
}
export function canonicalRatingTargetCoverDefinition(
  value: unknown,
): RatingTargetCoverDefinitionDescriptor {
  const descriptor = z
    .strictObject({
      targetId: id,
      contentVersion: z.number().int().min(1).max(2147483647),
      definitionRevision: id,
      appliedTargetRevision: id,
      envelope: z.unknown(),
    })
    .parse(value);
  const envelope = canonicalRatingTargetCoverEnvelope(descriptor.envelope);
  if (
    envelope.targetId !== descriptor.targetId ||
    envelope.contentVersion !== descriptor.contentVersion ||
    envelope.definitionRevision !== descriptor.definitionRevision ||
    envelope.targetRevision !== descriptor.appliedTargetRevision
  )
    throw new Error('Invalid exact target cover definition');
  return Object.freeze({ ...descriptor, envelope });
}
