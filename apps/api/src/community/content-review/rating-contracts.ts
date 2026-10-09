import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ratingText } from '../../ratings/contracts.js';
import { canonicalJson } from './contracts.js';
const id = z.uuid().refine((value) => value === value.toLowerCase());
const shared = {
  version: z.literal(1),
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
/** Distinct rating purposes, never post aliases or actor-null content. */
export const ratingContentEnvelopeSchema = z.discriminatedUnion('purpose', [
  z.strictObject({
    ...shared,
    purpose: z.literal('publish_rating_target'),
    name: ratingText(100),
    description: ratingText(500, false),
  }),
  z.strictObject({
    ...shared,
    purpose: z.literal('publish_rating_comment'),
    authorMode: z.enum(['named', 'anonymous']),
    body: ratingText(500),
  }),
]);
export type RatingContentEnvelope = z.infer<typeof ratingContentEnvelopeSchema>;
export type RatingContentKind = 'target' | 'comment';
export interface AcceptedRatingApproval {
  decisionId: string;
  digest: string;
  version: 1;
  envelope: RatingContentEnvelope;
}
export function canonicalRatingEnvelope(value: unknown): RatingContentEnvelope {
  const envelope = ratingContentEnvelopeSchema.parse(value);
  Object.freeze(envelope.scope);
  Object.freeze(envelope.assetIds);
  return Object.freeze(envelope);
}
export function ratingApprovalDigest(value: RatingContentEnvelope): string {
  return createHash('sha256')
    .update(
      `whaleu-rating-content-approval:v1\n${canonicalJson(canonicalRatingEnvelope(value))}`,
    )
    .digest('hex');
}
export function ratingOperation(kind: RatingContentKind) {
  return kind === 'target'
    ? ('publish_rating_target' as const)
    : ('publish_rating_comment' as const);
}
