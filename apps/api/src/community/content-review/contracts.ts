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
const contentEnvelopeShape = {
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
};
const contentEnvelopeV1Schema = z.strictObject({
  version: z.literal(1),
  ...contentEnvelopeShape,
});
const contentEnvelopeV2Schema = z.strictObject({
  ...contentEnvelopeShape,
  version: z.literal(2),
  purpose: z.literal('publish_post'),
  authorMode: z.literal('named'),
  allowAnonymousDm: z.boolean(),
});
export const effectiveContentEnvelopeSchema = z
  .discriminatedUnion('version', [
    contentEnvelopeV1Schema,
    contentEnvelopeV2Schema,
  ])
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
export type EffectiveContentEnvelopeV1 = Extract<
  EffectiveContentEnvelope,
  { version: 1 }
>;
export type EffectiveContentEnvelopeV2 = Extract<
  EffectiveContentEnvelope,
  { version: 2 }
>;
export type EffectiveContentEnvelopeDraft =
  | Omit<z.input<typeof contentEnvelopeV1Schema>, 'images'>
  | Omit<z.input<typeof contentEnvelopeV2Schema>, 'images'>;
export interface AcceptedApproval {
  decisionId: string;
  digest: string;
  version: 1 | 2;
  envelope: EffectiveContentEnvelope;
}
export interface ContentApprovalInput {
  accountId: string;
  purpose: PublicationOperation;
  envelope: EffectiveContentEnvelope;
}
// Only objects produced by the strict parser enter these weak identity caches.
// Object.isFrozen alone is not proof of canonical validation or deep immutability.
// Weak keys cannot retain a previous count batch or grow with complete histories.
const canonicalRoots = new WeakSet<object>();
const canonicalTexts = new WeakMap<object, string>();
const canonicalDigests = new WeakMap<object, string>();

/** Stable object-key ordering, ordered arrays, and no omitted/undefined fields. */
export function canonicalJson(value: unknown): string {
  if (
    typeof value === 'object' &&
    value !== null &&
    canonicalRoots.has(value)
  ) {
    const cached = canonicalTexts.get(value);
    if (cached !== undefined) return cached;
    const encoded = encodeCanonicalJson(value);
    canonicalTexts.set(value, encoded);
    return encoded;
  }
  return encodeCanonicalJson(value);
}
function encodeCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(encodeCanonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${encodeCanonicalJson(object[key])}`,
      )
      .join(',')}}`;
  }
  throw new TypeError('Unsupported canonical content');
}
/** Equality of supported canonical JSON values without allocating/sorting two
 * strings. Object-key order is irrelevant; array order and every own field are
 * retained. Unsupported/nonfinite values never acquire canonical equivalence. */
export function canonicalEqual(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left === 'string' || typeof left === 'boolean')
    return left === right;
  if (typeof left === 'number')
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    for (let index = 0; index < left.length; index++) {
      if (
        !Object.hasOwn(left, index) ||
        !Object.hasOwn(right, index) ||
        !canonicalEqual(left[index], right[index])
      )
        return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && canonicalEqual(a[key], b[key]))
  );
}
export function canonicalEnvelope(
  value: EffectiveContentEnvelopeV1,
): EffectiveContentEnvelopeV1;
export function canonicalEnvelope(
  value: EffectiveContentEnvelopeV2,
): EffectiveContentEnvelopeV2;
export function canonicalEnvelope(value: unknown): EffectiveContentEnvelope;
export function canonicalEnvelope(value: unknown): EffectiveContentEnvelope {
  if (typeof value === 'object' && value !== null && canonicalRoots.has(value))
    return value as EffectiveContentEnvelope;
  const envelope = effectiveContentEnvelopeSchema.parse(value);
  // Transformations are the same normalizations used by the publication DTOs.
  // New inputs are detached before freezing; only an internally proven result
  // can reuse identity. A caller-frozen or subsequently mutated input is reparsed.
  const freeze = (item: unknown): void => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(envelope);
  canonicalRoots.add(envelope);
  return envelope;
}
export function approvalDigest(value: EffectiveContentEnvelope): string {
  const envelope = canonicalEnvelope(value);
  const cached = canonicalDigests.get(envelope);
  if (cached !== undefined) return cached;
  const digest = createHash('sha256')
    .update(
      `whaleu-content-approval:v${envelope.version}\n${canonicalJson(envelope)}`,
    )
    .digest('hex');
  canonicalDigests.set(envelope, digest);
  return digest;
}
export function operationForKind(kind: ContentKind): PublicationOperation {
  return kind === 'post'
    ? 'publish_post'
    : kind === 'comment'
      ? 'publish_comment'
      : 'publish_reply';
}
