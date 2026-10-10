import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ratingText } from '../../ratings/contracts.js';
import { canonicalEqual, canonicalJson } from './contracts.js';

export const RATING_SCOPED_REVIEW_VERSION = 5 as const;
const id = z.uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const selector = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({ kind: z.literal('campus'), campusId: id }),
]);
export const ratingScopedReviewScopeSchema = z
  .strictObject({
    selector,
    scopeKey: z.string(),
    catalogRevision: id,
    headRevision: id,
    scopeRevision: digest,
    contextId: id,
    contextDigest: digest,
    protocolGeneration: id,
    sourceDigest: digest,
    topologySnapshotId: id.nullable(),
  })
  .superRefine((scope, context) => {
    const expected =
      scope.selector.kind === 'global'
        ? 'global'
        : `campus:${scope.selector.campusId}`;
    if (
      scope.scopeKey !== expected ||
      (scope.selector.kind === 'campus' && scope.topologySnapshotId === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Exact scoped selector required',
      });
  });
export type RatingScopedReviewScope = z.infer<
  typeof ratingScopedReviewScopeSchema
>;
const origin = z.strictObject({
  regionId: id.nullable(),
  originCampusId: id.nullable(),
});
const shared = {
  version: z.literal(RATING_SCOPED_REVIEW_VERSION),
  accountId: id,
  clientRequestId: id,
  targetId: id,
  targetRevision: id,
  categoryId: id,
  categoryRevision: id,
  scope: ratingScopedReviewScopeSchema,
  targetOrigin: origin,
  assetIds: z.tuple([]),
};
const target = {
  ...shared,
  definitionRevision: id,
  name: ratingText(100),
  description: ratingText(500, false),
};
const placement = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({
    kind: z.literal('campuses'),
    campusIds: z
      .array(id)
      .min(1)
      .max(1000)
      .refine((ids) =>
        ids.every((value, index) => index === 0 || ids[index - 1]! < value),
      ),
  }),
]);
const source = {
  version: z.literal(RATING_SCOPED_REVIEW_VERSION),
  accountId: id,
  sourceId: id,
  sourceRevision: id,
  categoryId: id,
  identityId: id,
  issuanceId: id,
  issuanceDigest: digest,
  placement,
  assetIds: z.tuple([]),
};
const categoryBody = z
  .strictObject({
    parentId: id.nullable(),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    systemKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,48}$/)
      .nullable(),
    name: ratingText(100),
    description: ratingText(500, false),
  })
  .refine((body) => (body.parentId === null) === (body.level === 1));
/** Review v5 is a separate protocol. Neither legacy scope nor native category
 * release envelopes can be relabelled as scoped content. */
export const ratingScopedEnvelopeSchema = z.discriminatedUnion('purpose', [
  z
    .strictObject({
      ...target,
      purpose: z.literal('publish_rating_target_scoped'),
      contentVersion: z.literal(1),
    })
    .refine((value) => value.definitionRevision === value.targetRevision),
  z
    .strictObject({
      ...target,
      purpose: z.literal('edit_rating_target_scoped'),
      previousTargetRevision: id,
      previousDefinitionRevision: id,
      contentVersion: z.number().int().min(2).max(2147483647),
    })
    .refine((value) => value.previousTargetRevision !== value.targetRevision)
    .refine(
      (value) => value.previousDefinitionRevision !== value.definitionRevision,
    ),
  z.strictObject({
    ...shared,
    purpose: z.literal('publish_rating_comment_scoped'),
    subjectId: id,
    subjectRevision: id,
    targetDefinitionRevision: id,
    targetContentVersion: z.number().int().min(1).max(2147483647),
    authorMode: z.enum(['named', 'anonymous']),
    body: ratingText(500),
  }),
  z
    .strictObject({
      ...shared,
      purpose: z.literal('publish_rating_reply_scoped'),
      subjectId: id,
      subjectRevision: id,
      targetDefinitionRevision: id,
      targetContentVersion: z.number().int().min(1).max(2147483647),
      rootId: id,
      rootRevision: id,
      replyTo: z.strictObject({ replyId: id, revision: id }).nullable(),
      authorMode: z.enum(['named', 'anonymous']),
      body: ratingText(500),
    })
    .refine(
      (value) =>
        value.subjectId !== value.rootId &&
        value.subjectId !== value.replyTo?.replyId,
    ),
  z
    .strictObject({
      ...source,
      purpose: z.literal('publish_rating_category_base_scoped'),
      body: categoryBody,
    })
    .refine((value) => value.issuanceId === value.sourceId),
  z
    .strictObject({
      ...source,
      purpose: z.literal('publish_rating_category_override_scoped'),
      baseSourceId: id,
      baseSourceRevision: id,
      scope: z.strictObject({ kind: z.literal('campus'), campusId: id }),
      body: z.strictObject({
        name: ratingText(100),
        description: ratingText(500, false),
      }),
    })
    .refine((value) => value.issuanceId === value.sourceId)
    .refine(
      (value) =>
        value.placement.kind === 'campuses' &&
        value.placement.campusIds.length === 1 &&
        value.placement.campusIds[0] === value.scope.campusId,
    ),
]);
export type RatingScopedEnvelope = z.infer<typeof ratingScopedEnvelopeSchema>;
export type RatingScopedTargetEnvelope = Extract<
  RatingScopedEnvelope,
  { purpose: 'publish_rating_target_scoped' | 'edit_rating_target_scoped' }
>;
export type RatingScopedContentEnvelope = Extract<
  RatingScopedEnvelope,
  { purpose: 'publish_rating_comment_scoped' | 'publish_rating_reply_scoped' }
>;
export type RatingScopedCategoryEnvelope = Extract<
  RatingScopedEnvelope,
  {
    purpose:
      | 'publish_rating_category_base_scoped'
      | 'publish_rating_category_override_scoped';
  }
>;
export interface AcceptedRatingScopedApproval {
  readonly decisionId: string;
  readonly digest: string;
  readonly version: 5;
  readonly envelope: RatingScopedEnvelope;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function canonicalRatingScopedEnvelope(
  value: unknown,
): RatingScopedEnvelope {
  const envelope = ratingScopedEnvelopeSchema.parse(value);
  if (!canonicalEqual(envelope, value))
    throw new Error('Noncanonical scoped Review envelope');
  return freeze(envelope);
}
export function ratingScopedApprovalDigest(
  value: RatingScopedEnvelope,
): string {
  return createHash('sha256')
    .update(
      `whaleu-rating-content-approval:v5\n${canonicalJson(canonicalRatingScopedEnvelope(value))}`,
    )
    .digest('hex');
}
export interface RatingScopedTargetDefinitionDescriptor {
  readonly targetId: string;
  readonly contentVersion: number;
  readonly definitionRevision: string;
  readonly appliedTargetRevision: string;
  readonly envelope: RatingScopedTargetEnvelope;
}
export function canonicalRatingScopedTargetDefinition(
  value: unknown,
): RatingScopedTargetDefinitionDescriptor {
  const descriptor = z
    .strictObject({
      targetId: id,
      contentVersion: z.number().int().min(1).max(2147483647),
      definitionRevision: id,
      appliedTargetRevision: id,
      envelope: z.unknown(),
    })
    .parse(value);
  const envelope = canonicalRatingScopedEnvelope(descriptor.envelope);
  if (
    (envelope.purpose !== 'publish_rating_target_scoped' &&
      envelope.purpose !== 'edit_rating_target_scoped') ||
    envelope.targetId !== descriptor.targetId ||
    envelope.contentVersion !== descriptor.contentVersion ||
    envelope.definitionRevision !== descriptor.definitionRevision ||
    envelope.targetRevision !== descriptor.appliedTargetRevision
  )
    throw new Error('Invalid exact scoped target definition');
  return Object.freeze({ ...descriptor, envelope });
}
export interface RatingScopedCategorySourceDescriptor {
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly categoryId: string;
  readonly envelope: RatingScopedCategoryEnvelope;
}
export function canonicalRatingScopedCategorySource(
  value: unknown,
): RatingScopedCategorySourceDescriptor {
  const descriptor = z
    .strictObject({
      sourceId: id,
      sourceRevision: id,
      categoryId: id,
      envelope: z.unknown(),
    })
    .parse(value);
  const envelope = canonicalRatingScopedEnvelope(descriptor.envelope);
  if (
    (envelope.purpose !== 'publish_rating_category_base_scoped' &&
      envelope.purpose !== 'publish_rating_category_override_scoped') ||
    envelope.sourceId !== descriptor.sourceId ||
    envelope.sourceRevision !== descriptor.sourceRevision ||
    envelope.categoryId !== descriptor.categoryId
  )
    throw new Error('Invalid exact scoped category source');
  return Object.freeze({ ...descriptor, envelope });
}
