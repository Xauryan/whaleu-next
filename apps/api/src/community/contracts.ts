import { textSourceDescriptorSchema } from './text-source/protocol.js';
import type { RatingTargetLinkView } from './rating-target-link/contracts.js';
import { feedbackInputSchema } from './feedback/contracts.js';
import type { FeedbackView } from './feedback/contracts.js';
import type { FormationView } from './formation/contracts.js';
import { z } from 'zod';
import {
  tradingInputSchema,
  tradingSubtypeSchema,
} from './trading/contracts.js';
import type { TradingView } from './trading/contracts.js';
import { textSchema } from './text.js';
import { postComponentSchema } from './polls/contracts.js';
import type { PollView } from './polls/contracts.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
import type { PublicExperienceDisplay } from '../experience/public-display.contract.js';

export const legacyCategorySchema = z.enum([
  'discussion',
  'feedback',
  'confession',
  'companions',
  'pets',
  'internships',
  'scenery',
  'dorms',
  'research',
  'deep_sea',
  'trading',
]);
export type LegacyCategory = z.infer<typeof legacyCategorySchema>;
/** Readable taxonomy. Historical Review envelopes retain legacyCategorySchema. */
export const categorySchema = legacyCategorySchema;
export const readableCategorySchema = legacyCategorySchema.or(
  z.literal('water'),
);
export type Category = z.infer<typeof readableCategorySchema>;
export const authorModeSchema = z.enum(['named', 'anonymous']);
export type AuthorMode = z.infer<typeof authorModeSchema>;
const imagesSchema = (maximum: number) =>
  z
    .array(z.uuid())
    .max(maximum)
    .refine((ids) => new Set(ids).size === ids.length)
    .default([]);
export const publishPostSchema = z
  .strictObject({
    clientRequestId: z.uuidv4(),
    spaceId: z.uuid(),
    category: legacyCategorySchema,
    text: textSchema(2500).refine((value) => value.trim().length > 0),
    imageAssetIds: imagesSchema(9),
    authorMode: authorModeSchema,
    commentsPolicy: z.enum(['open', 'restricted']).default('open'),
    // Absence retains the historical publication intent and Review v1 bytes.
    allowAnonymousDm: z.boolean().optional(),
    syncToRelatedCampuses: z.boolean().optional(),
    component: postComponentSchema.optional(),
    trading: tradingInputSchema.optional(),
    feedback: feedbackInputSchema.optional(),
    textSource: textSourceDescriptorSchema.optional(),
  })
  .refine(
    (body) =>
      body.textSource === undefined ||
      (body.clientRequestId === body.clientRequestId.toLowerCase() &&
        body.spaceId === body.spaceId.toLowerCase() &&
        body.category !== 'feedback' &&
        body.category !== 'trading' &&
        body.commentsPolicy === 'open' &&
        body.syncToRelatedCampuses !== true &&
        body.allowAnonymousDm !== true &&
        (!body.component || body.component.kind === 'none') &&
        body.trading === undefined &&
        body.feedback === undefined),
    'Explicit source supports ordinary publications only',
  )
  .refine(
    (body) =>
      body.component?.kind !== 'rating_target_link' ||
      (body.category === 'discussion' &&
        body.imageAssetIds.length === 0 &&
        body.syncToRelatedCampuses !== true &&
        body.allowAnonymousDm === undefined &&
        body.trading === undefined &&
        body.feedback === undefined),
    'Rating target cards require one text-only regional discussion without synchronization',
  )
  .refine((body) =>
    body.category === 'feedback'
      ? !!body.feedback &&
        body.allowAnonymousDm === undefined &&
        body.commentsPolicy === 'open' &&
        (!body.component || body.component.kind === 'none')
      : body.feedback === undefined,
  )
  .refine(
    (body) =>
      body.allowAnonymousDm === undefined || body.authorMode === 'named',
    'Anonymous DM opt-in belongs only to named posts',
  )
  .refine((body) =>
    body.category === 'trading'
      ? !!body.trading &&
        body.authorMode === 'named' &&
        (!body.component || body.component.kind === 'none')
      : body.trading === undefined,
  );
export const publishCommentSchema = z
  .strictObject({
    clientRequestId: z.uuidv4(),
    text: textSchema(500),
    imageAssetIds: imagesSchema(3),
    authorMode: authorModeSchema,
    textSource: textSourceDescriptorSchema.optional(),
  })
  .refine(
    (value) => value.text.trim().length > 0 || value.imageAssetIds.length > 0,
  )
  .refine(
    (value) =>
      value.textSource === undefined ||
      value.clientRequestId === value.clientRequestId.toLowerCase(),
    'Source request identifiers must be canonical',
  );
export type PublishPost = z.infer<typeof publishPostSchema>;
export type PublishComment = z.infer<typeof publishCommentSchema>;
export const idSchema = z.uuid();
export const requestIdSchema = z.uuidv4();
export const campusSpaceQuerySchema = z.strictObject({ campusId: z.uuid() });
export const postViewQuerySchema = z.strictObject({
  viewSpaceId: z.uuid().optional(),
});
export const capabilitiesQuerySchema = z.strictObject({
  spaceId: z.uuid(),
  category: categorySchema,
});
const pageShape = {
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|10)$/)
    .default('10')
    .transform(Number),
};
export const pageQuerySchema = z.strictObject(pageShape);
export const feedQuerySchema = z
  .strictObject({
    ...pageShape,
    spaceId: z.uuid(),
    category: categorySchema.optional(),
    tradingSubtype: tradingSubtypeSchema.optional(),
  })
  .refine((query) => !query.tradingSubtype || query.category === 'trading');
export const ownTradingQuerySchema = z.strictObject({
  ...pageShape,
  tradingSubtype: tradingSubtypeSchema.optional(),
});
export type OwnTradingQuery = z.infer<typeof ownTradingQuerySchema>;
export type PageQuery = z.infer<typeof pageQuerySchema>;
export type FeedQuery = z.infer<typeof feedQuerySchema>;
export interface CommunitySpace {
  id: string;
  kind: 'regional' | 'global';
  name: string;
  isActive: boolean;
  operatingRegionId: string | null;
}
export type MediaView =
  import('../media/contracts.js').MediaAttachmentDescriptor;
export type AuthorView =
  | {
      kind: 'named';
      profileId: string;
      displayName: string;
      avatar: MediaView | null;
      experienceDisplay: PublicExperienceDisplay;
    }
  | {
      kind: 'anonymous';
      personaId: string;
      displayName: string;
      avatar: MediaView | null;
      isPostAuthor: boolean;
    };
export interface PostView {
  isRelatedCampusSync?: boolean;
  sourceRegion?: { id: string; name: string };
  feedback?: FeedbackView;
  saveCount: number;
  trading: TradingView | null;
  component:
    | { kind: 'none' }
    | { kind: 'poll'; poll: PollView }
    | { kind: 'formation'; formation: FormationView }
    | RatingTargetLinkView;
  id: string;
  space: Pick<CommunitySpace, 'id' | 'kind' | 'name'>;
  category: Category;
  text: string;
  images: MediaView[];
  author: AuthorView;
  publishedAt: string;
  likeCount: number;
  commentCount: number | null;
  replyCount: number | null;
  discussionCount: number | null;
  viewer: {
    isSelf: boolean;
    isLiked: boolean;
    canDelete: boolean;
    canComment: boolean;
    isSaved: boolean;
    canSave: boolean;
    canSetUpdatePreference: boolean;
  };
  commentsPolicy: 'open' | 'restricted';
  /** Advisory only. Entry creation rechecks exact current reviewed provenance. */
  allowAnonymousDm: boolean;
}
export interface CommentView {
  id: string;
  postId: string;
  text: string;
  images: MediaView[];
  author: AuthorView;
  createdAt: string;
  likeCount: number;
  replyCount: number | null;
  isPinned: boolean;
  replyPreview: { items: ReplyView[]; nextCursor: string | null };
  viewer: {
    isSelf: boolean;
    canDelete: boolean;
    isLiked: boolean;
    canPin: boolean;
  };
}
export interface ReplyView {
  id: string;
  postId: string;
  rootCommentId: string;
  target:
    | {
        kind: 'comment' | 'reply';
        id: string;
        status: 'available';
        author: AuthorView;
      }
    | { status: 'unavailable' };
  text: string;
  images: MediaView[];
  author: AuthorView;
  createdAt: string;
  likeCount: number;
  viewer: { isSelf: boolean; canDelete: boolean; isLiked: boolean };
}
export type PublicationOperation =
  'publish_post' | 'publish_comment' | 'publish_reply';
export type PublicationReceipt =
  | {
      requestId: string;
      operation: PublicationOperation;
      outcome: 'created';
      resourceId: string;
      createdAt: string;
    }
  | {
      requestId: string;
      operation: PublicationOperation;
      outcome: 'rejected';
      code: ApplicationErrorCode;
    };
export interface Capabilities {
  ratingTargetLink?: {
    availability: 'allowed' | 'denied' | 'unavailable';
    reason: ApplicationErrorCode | null;
    authorModes: AuthorMode[];
  };
  relatedCampusSync?: {
    authorModes?: AuthorMode[];
    canDisableComments?: boolean;
    availability: 'allowed' | 'denied' | 'unavailable';
    reason: ApplicationErrorCode | null;
  };
  publish: {
    availability: 'allowed' | 'denied' | 'unavailable';
    reason: ApplicationErrorCode | null;
  };
  authorModes: AuthorMode[];
  canDisableComments: boolean;
  postImageLimit: 9;
  commentImageLimit: 3;
  mediaAvailability: 'unavailable';
  commentRules: {
    unverifiedRequiresNamed: true;
    ownAnonymousPostForcesAnonymous: true;
  };
}
export interface FeedPage {
  relatedCampusDistribution?: 'complete' | 'unavailable';
  items: PostView[];
  nextCursor: string | null;
  continuation:
    'available' | 'end' | 'login_required' | 'phone_verification_required';
}
export interface OwnPublication {
  id: string;
  spaceId: string;
  category: Category;
  status: 'published' | 'hidden' | 'deleted';
  ownerVisibility: {
    ownerHidden: boolean;
    version: number;
    canChange: boolean;
  };
  publishedAt: string;
}

export interface CommentCapabilities {
  inheritsRelatedCampusSync?: boolean;
  lastAuthorMode: AuthorMode | null;
  availability: 'allowed' | 'denied' | 'unavailable';
  reason: ApplicationErrorCode | null;
  authorModes: AuthorMode[];
  forcedAuthorMode: 'anonymous' | null;
}
