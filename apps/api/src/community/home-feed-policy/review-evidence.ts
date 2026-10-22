import { createHash } from 'node:crypto';
import { z } from 'zod';
import { legacyCategorySchema, authorModeSchema } from '../contracts.js';
import { formationComponentSchema } from '../formation/contracts.js';
import { pollComponentSchema } from '../polls/contracts.js';
import { textSchema } from '../text.js';
import {
  textSourceDescriptorSchema,
  textSourceIntentHash,
} from '../text-source/protocol.js';
import {
  evaluateLegacyHomePolicy,
  LEGACY_HOME_POLICY_COMMIT,
} from './policy.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid().refine((value) => value === value.toLowerCase());
export const homeRequestedIntentSchema = z.strictObject({
  spaceId: id,
  category: legacyCategorySchema.exclude(['feedback', 'trading']),
  text: textSchema(2500),
  imageAssetIds: z
    .array(id)
    .max(9)
    .refine((ids) => new Set(ids).size === ids.length),
  authorMode: authorModeSchema,
  commentsPolicy: z.enum(['open', 'restricted']),
  component: z
    .union([pollComponentSchema, formationComponentSchema])
    .optional(),
  allowAnonymousDm: z.boolean().optional(),
  syncToRelatedCampuses: z.literal(true).optional(),
  textSource: textSourceDescriptorSchema.optional(),
});
export type HomeRequestedIntent = z.infer<typeof homeRequestedIntentSchema>;
/** Rebuild the historical postIntent property order; never hash sorted Review JSON.
 * Explicit none is omitted by postIntent, as are false synchronization requests. */
export function homeOriginalIntentHash(value: HomeRequestedIntent): string {
  const input = homeRequestedIntentSchema.parse(value);
  const intent = {
    spaceId: input.spaceId,
    category: input.category,
    text: input.text,
    imageAssetIds: input.imageAssetIds,
    authorMode: input.authorMode,
    commentsPolicy: input.commentsPolicy,
    ...(input.component ? { component: input.component } : {}),
    ...(input.allowAnonymousDm === undefined
      ? {}
      : { allowAnonymousDm: input.allowAnonymousDm }),
    ...(input.syncToRelatedCampuses === true
      ? { syncToRelatedCampuses: true as const }
      : {}),
    ...(input.textSource === undefined ? {} : { textSource: input.textSource }),
  };
  return input.textSource === undefined
    ? createHash('sha256')
        .update(JSON.stringify({ operation: 'publish_post', intent }))
        .digest('hex')
    : textSourceIntentHash('publish_post', intent);
}
export const homeReviewEvidenceSchema = z
  .strictObject({
    version: z.literal(1),
    admission: z.strictObject({
      id,
      revision: z.number().int().min(1).max(2147483647),
      digest,
      sourceCommit: z.literal(LEGACY_HOME_POLICY_COMMIT),
      validUntil: z.iso.datetime({ offset: true }),
    }),
    requestedIntent: homeRequestedIntentSchema,
    requestedIntentHash: digest,
    requestedRegionId: id.nullable(),
    legacyChoose: z.number().int().min(1).max(100),
    targetWaterSpaceId: id.nullable(),
    targetWaterRegionId: id.nullable(),
    auditExempt: z.literal(false),
    result: z.enum(['short_text', 'reference_only']).nullable(),
  })
  .superRefine((value, ctx) => {
    const input = value.requestedIntent;
    const decision = evaluateLegacyHomePolicy({
      originalCategory: {
        sourceCommit: value.admission.sourceCommit,
        choose: value.legacyChoose,
      },
      text: input.text,
      format: input.textSource?.format ?? 'plain',
      hasImages: input.imageAssetIds.length > 0,
      hasPoll: input.component?.kind === 'poll',
      hasGroup: input.component?.kind === 'formation',
      hasLink: false,
      auditExempt: false,
    });
    if (
      homeOriginalIntentHash(input) !== value.requestedIntentHash ||
      decision.status !== 'resolved' ||
      decision.restriction?.reason !== (value.result ?? undefined) ||
      (value.targetWaterSpaceId === null) !==
        (value.targetWaterRegionId === null) ||
      (value.result !== null && value.targetWaterSpaceId === null) ||
      (value.result === null && input.syncToRelatedCampuses === true) ||
      (input.authorMode === 'anonymous' && input.allowAnonymousDm !== undefined)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid deterministic Home evidence',
      });
  });
export type HomeReviewEvidence = z.infer<typeof homeReviewEvidenceSchema>;
/** Evidence is not authority: runtime/SQL must resolve the exact current admission
 * and verify mapping and publication identity, then bind this object to approval. */
export function homeDistributionSuppressed(
  evidence: HomeReviewEvidence,
): boolean {
  return evidence.result !== null;
}
