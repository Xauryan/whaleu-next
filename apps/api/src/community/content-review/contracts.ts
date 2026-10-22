import { canonicalJson as encodeCanonicalJson } from './canonical-json.js';
import { homeReviewEvidenceSchema } from '../home-feed-policy/review-evidence.js';
import type { HomeReviewEvidence } from '../home-feed-policy/review-evidence.js';
import {
  reviewedTextSourceSchema,
  reviewedTextSourceMatches,
  sourceDescriptor,
} from '../text-source/protocol.js';
import type { ReviewedTextSource } from '../text-source/protocol.js';
import { reviewedRatingTargetLinkSchema } from '../rating-target-link/contracts.js';
import type { ReviewedRatingTargetLink } from '../rating-target-link/contracts.js';
import { feedbackInputSchema } from '../feedback/contracts.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  authorModeSchema,
  legacyCategorySchema,
  readableCategorySchema,
} from '../contracts.js';
import type { PublicationOperation } from '../contracts.js';
import { formationComponentSchema } from '../formation/contracts.js';
import { pollComponentSchema } from '../polls/contracts.js';
import { tradingInputSchema } from '../trading/contracts.js';
import { textSchema } from '../text.js';
import type { AuthorMode, Category, LegacyCategory } from '../contracts.js';
import type { FeedbackInput } from '../feedback/contracts.js';
import type { FormationComponent } from '../formation/contracts.js';
import type { PollComponent } from '../polls/contracts.js';
import type { TradingInput } from '../trading/contracts.js';
import type {
  LegacyContentScope,
  RelatedRootScope,
  InheritedRelatedScope,
} from './scope-contracts.js';

import {
  legacyContentScopeSchema,
  relatedRootScopeSchema,
  inheritedRelatedScopeSchema,
} from './scope-contracts.js';
export {
  legacyContentScopeSchema,
  effectiveContentScopeSchema,
  relatedRootScopeSchema,
  inheritedRelatedScopeSchema,
} from './scope-contracts.js';
export type {
  ContentScopeSnapshot,
  RelatedRootScope,
  InheritedRelatedScope,
  LegacyContentScope,
} from './scope-contracts.js';
export type PublicationScope =
  import('./scope-contracts.js').ContentScopeSnapshot;
/** Keep legacy consumers explicit; new stored/general scope readers use the union. */
export const contentScopeSchema = legacyContentScopeSchema;
export type ContentKind = 'post' | 'comment' | 'reply';
const contentEnvelopeShape = {
  accountId: z.uuid(),
  purpose: z.enum(['publish_post', 'publish_comment', 'publish_reply']),
  spaceId: z.uuid(),
  category: legacyCategorySchema,
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
const contentEnvelopeV3Schema = z.strictObject({
  ...contentEnvelopeShape,
  version: z.literal(3),
  purpose: z.literal('publish_post'),
  category: z.literal('feedback'),
  commentsPolicy: z.literal('open'),
  feedback: feedbackInputSchema,
});
const contentEnvelopeV4Schema = z.strictObject({
  ...contentEnvelopeShape,
  version: z.literal(4),
  allowAnonymousDm: z.boolean().nullable(),
  scope: z.discriminatedUnion('sync', [
    relatedRootScopeSchema,
    inheritedRelatedScopeSchema,
  ]),
});
const contentEnvelopeV5Schema = z.strictObject({
  ...contentEnvelopeShape,
  version: z.literal(5),
  purpose: z.literal('publish_post'),
  category: z.literal('discussion'),
  images: z.tuple([]),
  component: reviewedRatingTargetLinkSchema,
  trading: z.null(),
  scope: legacyContentScopeSchema.refine(
    (scope) => scope.originalRegionId !== null,
  ),
});
const contentEnvelopeV6Schema = z.strictObject({
  ...contentEnvelopeShape,
  version: z.literal(6),
  images: z.tuple([]),
  commentsPolicy: z.literal('open'),
  component: z.strictObject({ kind: z.literal('none') }),
  trading: z.null(),
  allowAnonymousDm: z.literal(false).nullable(),
  textSource: reviewedTextSourceSchema,
});
const contentEnvelopeV7Schema = z.strictObject({
  ...contentEnvelopeShape,
  version: z.literal(7),
  purpose: z.literal('publish_post'),
  category: readableCategorySchema,
  trading: z.null(),
  allowAnonymousDm: z.boolean().nullable(),
  textSource: reviewedTextSourceSchema.nullable(),
  home: homeReviewEvidenceSchema,
});
/** A child inherits exact parent Review authority, never its Home classification. */
const contentEnvelopeV8Schema = z.strictObject({
  ...contentEnvelopeShape,
  version: z.literal(8),
  purpose: z.enum(['publish_comment', 'publish_reply']),
  category: readableCategorySchema,
  component: z.strictObject({ kind: z.literal('none') }),
  trading: z.null(),
  allowAnonymousDm: z.null(),
  textSource: reviewedTextSourceSchema.nullable(),
  homeParent: z.strictObject({
    postId: z.uuid(),
    decisionId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const exactContentEnvelopeSchema = z
  .discriminatedUnion('version', [
    contentEnvelopeV1Schema,
    contentEnvelopeV2Schema,
    contentEnvelopeV3Schema,
    contentEnvelopeV4Schema,
    contentEnvelopeV5Schema,
    contentEnvelopeV6Schema,
    contentEnvelopeV7Schema,
    contentEnvelopeV8Schema,
  ])
  .superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (value.version === 8) {
      if (
        value.category === 'feedback' ||
        value.category === 'trading' ||
        value.scope.sync !== 'none' ||
        value.homeParent.postId !== value.postId
      )
        invalid('Invalid composed Home parent');
      if (
        value.textSource !== null &&
        (value.images.length !== 0 ||
          value.commentsPolicy !== 'open' ||
          !reviewedTextSourceMatches(
            value.text,
            value.textSource,
            value.purpose === 'publish_comment' ? 'comment' : 'reply',
          ))
      )
        invalid('Invalid composed discussion source');
    }
    if (value.version === 7) {
      const requested = value.home.requestedIntent;
      const restricted = value.home.result !== null;
      if (
        value.category === 'feedback' ||
        value.category === 'trading' ||
        value.scope.sync !== 'none' ||
        value.text !== requested.text ||
        value.commentsPolicy !== requested.commentsPolicy ||
        !canonicalEqual(
          value.images.map((image) => image.assetId),
          requested.imageAssetIds,
        ) ||
        !canonicalEqual(
          value.component,
          requested.component ?? { kind: 'none' },
        ) ||
        value.allowAnonymousDm !==
          (value.authorMode === 'named'
            ? (requested.allowAnonymousDm ?? null)
            : null) ||
        value.category !== (restricted ? 'water' : requested.category) ||
        value.spaceId !==
          (restricted ? value.home.targetWaterSpaceId : requested.spaceId) ||
        value.scope.originalRegionId !==
          (restricted
            ? value.home.targetWaterRegionId
            : value.home.requestedRegionId)
      )
        invalid('Invalid composed Home definition');
      if (
        value.textSource === null
          ? requested.textSource !== undefined
          : requested.textSource === undefined ||
            !canonicalEqual(
              sourceDescriptor(value.textSource),
              requested.textSource,
            ) ||
            !reviewedTextSourceMatches(value.text, value.textSource, 'post') ||
            value.images.length !== 0 ||
            value.component.kind !== 'none' ||
            value.commentsPolicy !== 'open' ||
            requested.allowAnonymousDm === true ||
            requested.syncToRelatedCampuses === true
      )
        invalid('Invalid composed reviewed source');
    }
    if (value.version === 6) {
      if (
        value.category === 'feedback' ||
        value.category === 'trading' ||
        value.scope.sync !== 'none' ||
        ((value.purpose !== 'publish_post' ||
          value.authorMode === 'anonymous') &&
          value.allowAnonymousDm !== null) ||
        !reviewedTextSourceMatches(
          value.text,
          value.textSource,
          value.purpose === 'publish_post'
            ? 'post'
            : value.purpose === 'publish_comment'
              ? 'comment'
              : 'reply',
        )
      )
        invalid('Invalid ordinary reviewed source');
    }
    if (value.version === 4) {
      if (
        value.category === 'feedback' ||
        value.category === 'trading' ||
        value.scope.originalRegionId === null
      )
        invalid('Invalid related distribution envelope');
      if (value.purpose === 'publish_post') {
        if (
          value.scope.sync !== 'related' ||
          (value.authorMode !== 'named' && value.allowAnonymousDm !== null)
        )
          invalid('Invalid related root scope');
      } else if (
        value.scope.sync !== 'inherited_related' ||
        value.allowAnonymousDm !== null ||
        value.scope.parentDistribution.postId !== value.postId
      )
        invalid('Invalid inherited distribution scope');
    }
    if (
      value.category === 'feedback' &&
      (value.scope.originalRegionId !== null ||
        value.component.kind !== 'none' ||
        value.trading !== null ||
        (value.purpose === 'publish_post' && value.version !== 3))
    )
      invalid('Invalid global feedback definition');
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
/** A discussion draft has no Media-owned images yet. Validate its shape and
 * ancestry here, without asserting a final nonempty body or granting approval.
 * The publication owner still parses the full canonical envelope after resolving
 * the exact owned images, before Review, binding or content writes. */
const discussionDraftFields = {
  purpose: z.enum(['publish_comment', 'publish_reply']),
  text: textSchema(500),
  component: z.strictObject({ kind: z.literal('none') }),
  trading: z.null(),
};
const discussionEnvelopeDraftSchema = z
  .discriminatedUnion('version', [
    contentEnvelopeV1Schema
      .omit({ images: true })
      .extend(discussionDraftFields),
    contentEnvelopeV4Schema
      .omit({ images: true })
      .extend(discussionDraftFields),
    contentEnvelopeV8Schema
      .omit({ images: true })
      .extend(discussionDraftFields),
  ])
  .superRefine((value, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: 'custom', message });
    if (value.spaceId !== value.scope.originalSpaceId)
      invalid('Scope does not match space');
    if (!value.postId) invalid('Missing post');
    if (
      value.purpose === 'publish_comment'
        ? value.rootCommentId !== null || value.targetReplyId !== null
        : !value.rootCommentId
    )
      invalid('Invalid discussion ancestry');
    if (value.category === 'feedback' && value.scope.originalRegionId !== null)
      invalid('Invalid global feedback definition');
    if (value.version === 4) {
      if (
        value.category === 'feedback' ||
        value.category === 'trading' ||
        value.scope.originalRegionId === null ||
        value.scope.sync !== 'inherited_related' ||
        value.allowAnonymousDm !== null ||
        value.scope.parentDistribution.postId !== value.postId
      )
        invalid('Invalid inherited distribution scope');
    }
    if (value.version === 8) {
      if (
        value.category === 'feedback' ||
        value.category === 'trading' ||
        value.scope.sync !== 'none' ||
        value.homeParent.postId !== value.postId
      )
        invalid('Invalid composed Home parent');
      if (
        value.textSource !== null &&
        (value.commentsPolicy !== 'open' ||
          !reviewedTextSourceMatches(
            value.text,
            value.textSource,
            value.purpose === 'publish_comment' ? 'comment' : 'reply',
          ))
      )
        invalid('Invalid composed discussion source');
    }
  });
export function discussionEnvelopeDraft(
  value: unknown,
): EffectiveContentEnvelopeDraft {
  return discussionEnvelopeDraftSchema.parse(value);
}
export const effectiveContentEnvelopeSchema: z.ZodType<EffectiveContentEnvelope> =
  exactContentEnvelopeSchema;
type RequireProtocolAgreement<T extends true> = T;
export type ContentEnvelopeProtocolAgreement = RequireProtocolAgreement<
  [z.input<typeof exactContentEnvelopeSchema>] extends [
    EffectiveContentEnvelope,
  ]
    ? [EffectiveContentEnvelope] extends [
        z.input<typeof exactContentEnvelopeSchema>,
      ]
      ? true
      : false
    : false
>;
/** Explicit wire types avoid distributing Zod's implementation types through every owner. */
interface ContentEnvelopeFields {
  accountId: string;
  purpose: 'publish_post' | 'publish_comment' | 'publish_reply';
  spaceId: string;
  category: LegacyCategory;
  authorMode: AuthorMode;
  commentsPolicy: 'open' | 'restricted';
  postId: string | null;
  rootCommentId: string | null;
  targetReplyId: string | null;
  text: string;
  images: { assetId: string; digest: string }[];
  component: { kind: 'none' } | PollComponent | FormationComponent;
  trading:
    | (Omit<TradingInput, 'urgency'> & {
        urgency?: 'normal' | 'urgent' | undefined;
      })
    | null;
}
export interface EffectiveContentEnvelopeV1 extends ContentEnvelopeFields {
  version: 1;
  scope: LegacyContentScope;
}
export interface EffectiveContentEnvelopeV2 extends ContentEnvelopeFields {
  version: 2;
  scope: LegacyContentScope;
  purpose: 'publish_post';
  authorMode: 'named';
  allowAnonymousDm: boolean;
}
export interface EffectiveContentEnvelopeV3 extends ContentEnvelopeFields {
  version: 3;
  scope: LegacyContentScope;
  purpose: 'publish_post';
  category: 'feedback';
  commentsPolicy: 'open';
  feedback: FeedbackInput;
}
export interface EffectiveContentEnvelopeV4 extends ContentEnvelopeFields {
  version: 4;
  scope: RelatedRootScope | InheritedRelatedScope;
  allowAnonymousDm: boolean | null;
}
export interface EffectiveContentEnvelopeV5 extends Omit<
  ContentEnvelopeFields,
  'component' | 'images' | 'trading'
> {
  version: 5;
  purpose: 'publish_post';
  category: 'discussion';
  images: [];
  trading: null;
  component: ReviewedRatingTargetLink;
  scope: LegacyContentScope;
}
export interface EffectiveContentEnvelopeV6 extends Omit<
  ContentEnvelopeFields,
  'component' | 'images' | 'trading' | 'commentsPolicy'
> {
  version: 6;
  images: [];
  scope: LegacyContentScope;
  component: { kind: 'none' };
  trading: null;
  commentsPolicy: 'open';
  allowAnonymousDm: false | null;
  textSource: ReviewedTextSource;
}
/** Additive post-only Home/source composition; no historical envelope widens. */
export interface EffectiveContentEnvelopeV7 extends Omit<
  ContentEnvelopeFields,
  'category' | 'purpose' | 'trading'
> {
  version: 7;
  purpose: 'publish_post';
  category: Category;
  trading: null;
  scope: LegacyContentScope;
  allowAnonymousDm: boolean | null;
  textSource: ReviewedTextSource | null;
  home: HomeReviewEvidence;
}
export interface EffectiveContentEnvelopeV8 extends Omit<
  ContentEnvelopeFields,
  'category' | 'purpose' | 'component' | 'trading'
> {
  version: 8;
  purpose: 'publish_comment' | 'publish_reply';
  category: Category;
  component: { kind: 'none' };
  trading: null;
  scope: LegacyContentScope;
  allowAnonymousDm: null;
  textSource: ReviewedTextSource | null;
  homeParent: { postId: string; decisionId: string; digest: string };
}
export type EffectiveContentEnvelope =
  | EffectiveContentEnvelopeV1
  | EffectiveContentEnvelopeV2
  | EffectiveContentEnvelopeV3
  | EffectiveContentEnvelopeV4
  | EffectiveContentEnvelopeV5
  | EffectiveContentEnvelopeV6
  | EffectiveContentEnvelopeV7
  | EffectiveContentEnvelopeV8;
export type EffectiveContentEnvelopeDraft =
  | Omit<EffectiveContentEnvelopeV1, 'images'>
  | Omit<EffectiveContentEnvelopeV2, 'images'>
  | Omit<EffectiveContentEnvelopeV3, 'images'>
  | Omit<EffectiveContentEnvelopeV4, 'images'>
  | Omit<EffectiveContentEnvelopeV5, 'images'>
  | Omit<EffectiveContentEnvelopeV6, 'images'>
  | Omit<EffectiveContentEnvelopeV7, 'images'>
  | Omit<EffectiveContentEnvelopeV8, 'images'>;
export interface AcceptedApproval {
  decisionId: string;
  digest: string;
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
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
