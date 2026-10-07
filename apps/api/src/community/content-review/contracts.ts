import { createHash } from 'node:crypto';
import { z } from 'zod';
import { authorModeSchema, categorySchema } from '../contracts.js';
import type { PublicationOperation } from '../contracts.js';
import { formationComponentSchema } from '../formation/contracts.js';
import { pollComponentSchema } from '../polls/contracts.js';
import { tradingInputSchema } from '../trading/contracts.js';
import { textSchema } from '../text.js';

/** Private, server-derived historical scope. Never project this into public DTOs. */
export const contentScopeSchema = z.strictObject({
  originalSpaceId: z.uuid(),
  originalRegionId: z.uuid().nullable(),
  authorOriginRegionId: z.uuid().nullable(),
  identityRegionId: z.uuid().nullable(),
  topologySnapshotId: z.uuid().nullable(),
  sync: z.literal('none'),
  configurationRevisionId: z.uuid().nullable().default(null),
  identityCampusId: z.uuid().nullable().default(null),
  identitySelectionId: z.uuid().nullable().default(null),
  affiliationSnapshotId: z.uuid().nullable().default(null),
  affiliationAssertionId: z.uuid().nullable().default(null),
});
export type ContentScopeSnapshot = z.input<typeof contentScopeSchema>;
export type PublicationScope = ContentScopeSnapshot;
export type ContentKind = 'post' | 'comment' | 'reply';
export const effectiveContentEnvelopeSchema = z
  .strictObject({
    version: z.literal(1),
    accountId: z.uuid(),
    purpose: z.enum(['publish_post', 'publish_comment', 'publish_reply']),
    spaceId: z.uuid(),
    category: categorySchema,
    authorMode: authorModeSchema,
    commentsPolicy: z.enum(['open', 'restricted']),
    postId: z.uuid().nullable(),
    rootCommentId: z.uuid().nullable(),
    targetReplyId: z.uuid().nullable(),
    text: textSchema(2500),
    images: z
      .array(
        z.strictObject({
          assetId: z.uuid(),
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(9),
    component: z.union([
      z.strictObject({ kind: z.literal('none') }),
      pollComponentSchema,
      formationComponentSchema,
    ]),
    trading: tradingInputSchema.nullable(),
    scope: contentScopeSchema,
  })
  .superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (value.spaceId !== value.scope.originalSpaceId)
      invalid('Scope does not match space');
    if (
      new Set(value.images.map((image) => image.assetId)).size !==
      value.images.length
    )
      invalid('Duplicate assets');
    if (value.purpose === 'publish_post') {
      if (
        value.postId !== null ||
        value.rootCommentId !== null ||
        value.targetReplyId !== null
      )
        invalid('Post ancestry is invalid');
      if (!value.text.trim()) invalid('Empty post');
      if (
        value.category === 'trading'
          ? !value.trading ||
            value.component.kind !== 'none' ||
            value.authorMode !== 'named'
          : value.trading !== null
      )
        invalid('Invalid trading definition');
    } else {
      if (
        !value.postId ||
        value.component.kind !== 'none' ||
        value.trading !== null ||
        value.images.length > 3 ||
        [...value.text].length > 500
      )
        invalid('Invalid discussion definition');
      if (!value.text.trim() && !value.images.length)
        invalid('Empty discussion');
      if (
        value.purpose === 'publish_comment' &&
        (value.rootCommentId !== null || value.targetReplyId !== null)
      )
        invalid('Root ancestry is invalid');
      if (value.purpose === 'publish_reply' && !value.rootCommentId)
        invalid('Missing root');
    }
  });
export type EffectiveContentEnvelope = z.input<
  typeof effectiveContentEnvelopeSchema
>;
export interface AcceptedApproval {
  decisionId: string;
  digest: string;
  version: 1;
  envelope: EffectiveContentEnvelope;
}
export interface ContentApprovalInput {
  accountId: string;
  purpose: PublicationOperation;
  envelope: EffectiveContentEnvelope;
}
/** Stable object-key ordering, ordered arrays, and no omitted/undefined fields. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Unsupported canonical content');
}
export function canonicalEnvelope(value: unknown): EffectiveContentEnvelope {
  const envelope = effectiveContentEnvelopeSchema.parse(value);
  // Transformations are the same normalizations used by the publication DTOs.
  // Return a detached immutable value so later caller mutation cannot alter approval.
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(envelope);
  return envelope;
}
export function approvalDigest(value: EffectiveContentEnvelope): string {
  return createHash('sha256')
    .update(
      `whaleu-content-approval:v1\n${canonicalJson(canonicalEnvelope(value))}`,
    )
    .digest('hex');
}
export function operationForKind(kind: ContentKind): PublicationOperation {
  return kind === 'post'
    ? 'publish_post'
    : kind === 'comment'
      ? 'publish_comment'
      : 'publish_reply';
}
