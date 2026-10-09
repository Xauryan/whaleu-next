import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ratingText } from '../../ratings/contracts.js';
import { canonicalJson } from './contracts.js';
const id = z.uuid().refine((value) => value === value.toLowerCase());
const shared = {
  accountId: id,
  clientRequestId: id,
  targetId: id,
  targetRevision: id,
  categoryId: id,
  categoryRevision: id,
  catalogRevision: id,
  scope: z.strictObject({ regionId: id.nullable() }),
  assetIds: z.tuple([]),
};
export const ratingTargetEditEnvelopeSchema = z
  .strictObject({
    ...shared,
    version: z.literal(3),
    purpose: z.literal('edit_rating_target'),
    previousTargetRevision: id,
    previousDefinitionRevision: id,
    definitionRevision: id,
    contentVersion: z.number().int().min(2).max(2147483647),
    name: ratingText(100),
    description: ratingText(500, false),
  })
  .refine((value) => value.previousTargetRevision !== value.targetRevision)
  .refine(
    (value) => value.previousDefinitionRevision !== value.definitionRevision,
  );
/** Distinct rating purposes, never post aliases or actor-null content. */
export const ratingContentEnvelopeSchema = z.discriminatedUnion('purpose', [
  z.strictObject({
    ...shared,
    version: z.literal(1),
    purpose: z.literal('publish_rating_target'),
    name: ratingText(100),
    description: ratingText(500, false),
  }),
  z.strictObject({
    ...shared,
    version: z.literal(1),
    purpose: z.literal('publish_rating_comment'),
    authorMode: z.enum(['named', 'anonymous']),
    body: ratingText(500),
  }),
  z.strictObject({
    ...shared,
    version: z.literal(2),
    purpose: z.literal('publish_rating_reply'),
    rootId: id,
    rootRevision: id,
    replyTo: z.strictObject({ replyId: id, revision: id }).nullable(),
    authorMode: z.enum(['named', 'anonymous']),
    body: ratingText(500),
  }),
  ratingTargetEditEnvelopeSchema,
]);
export type RatingContentEnvelope = z.infer<typeof ratingContentEnvelopeSchema>;
export type RatingTargetEditEnvelope = Extract<
  RatingContentEnvelope,
  { purpose: 'edit_rating_target' }
>;
export type RatingReplyEnvelope = Extract<
  RatingContentEnvelope,
  { purpose: 'publish_rating_reply' }
>;
export type RatingContentKind = 'target' | 'comment' | 'reply';
export interface AcceptedRatingApproval {
  decisionId: string;
  digest: string;
  version: 1 | 2 | 3;
  envelope: RatingContentEnvelope;
}
export function canonicalRatingEnvelope(value: unknown): RatingContentEnvelope {
  const envelope = ratingContentEnvelopeSchema.parse(value);
  Object.freeze(envelope.scope);
  Object.freeze(envelope.assetIds);
  if (envelope.purpose === 'publish_rating_reply' && envelope.replyTo)
    Object.freeze(envelope.replyTo);
  return Object.freeze(envelope);
}
export function ratingApprovalDigest(value: RatingContentEnvelope): string {
  const envelope = canonicalRatingEnvelope(value);
  return createHash('sha256')
    .update(
      `whaleu-rating-content-approval:v${envelope.version}\n${canonicalJson(envelope)}`,
    )
    .digest('hex');
}
export function ratingOperation(kind: RatingContentKind) {
  switch (kind) {
    case 'target':
      return 'publish_rating_target' as const;
    case 'comment':
      return 'publish_rating_comment' as const;
    case 'reply':
      return 'publish_rating_reply' as const;
  }
}
