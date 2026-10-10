import { mediaAttachmentDescriptorSchema } from '../../media/contracts.js';
import { z } from 'zod';
import { categorySchema } from '../contracts.js';
import { tradingSubtypeSchema } from '../trading/contracts.js';
const uuid = z.uuid(),
  text = z.string(),
  count = z.number().int().nonnegative(),
  bool = z.boolean();
const media = mediaAttachmentDescriptorSchema;
const unavailable = z.strictObject({
  status: z.literal('unavailable'),
  value: z.null(),
});
const author = z.union([
  z.strictObject({
    kind: z.literal('named'),
    profileId: uuid,
    displayName: text,
    avatar: media.nullable(),
    experienceDisplay: z.strictObject({
      title: z.union([
        z.strictObject({
          status: z.literal('known'),
          value: z.strictObject({ key: text, name: text }).nullable(),
        }),
        unavailable,
      ]),
      color: z.union([
        z.strictObject({
          status: z.literal('known'),
          value: z.number().int().nullable(),
        }),
        unavailable,
      ]),
      level: z.union([
        z.strictObject({ status: z.literal('known'), value: count }),
        unavailable,
      ]),
    }),
  }),
  z.strictObject({
    kind: z.literal('anonymous'),
    personaId: uuid,
    displayName: text,
    avatar: media.nullable(),
    isPostAuthor: bool,
  }),
]);
const poll = z.strictObject({
  id: uuid,
  postId: uuid,
  question: text,
  selectionMode: z.enum(['single', 'multiple']),
  options: z.array(
    z.strictObject({ id: uuid, label: text, position: count, count }),
  ),
  deadline: text.nullable(),
  expired: bool,
  voterCount: count,
  selectionCount: count,
  viewer: z.strictObject({
    hasVoted: bool,
    selectedOptionIds: z.array(uuid),
    canVote: bool,
    reason: text.nullable(),
  }),
});
const formation = z.strictObject({
  id: uuid,
  postId: uuid,
  capacity: z.number().int().min(1).max(20),
  theme: text,
  status: z.enum(['open', 'full', 'unavailable']),
  memberCount: count,
  members: z.array(
    z.strictObject({
      id: uuid,
      author,
      isCreator: bool,
      joinedAt: text,
      viewer: z.strictObject({ isSelf: bool }),
    }),
  ),
  viewer: z.strictObject({
    isMember: bool,
    isCreator: bool,
    canJoin: bool,
    reason: text.nullable(),
    canReadContacts: bool,
  }),
});
const trading = z.strictObject({
  subtype: z.union([
    z.strictObject({
      kind: z.literal('known'),
      key: tradingSubtypeSchema,
      legacyText: text.nullable(),
    }),
    z.strictObject({ kind: z.literal('legacy'), text }),
  ]),
  price: z.union([
    z.strictObject({
      kind: z.literal('exact'),
      amount: text,
      legacyText: text.nullable(),
    }),
    z.strictObject({ kind: z.literal('legacy'), text }),
  ]),
  urgency: z.enum(['normal', 'urgent']),
  location: text,
  resolution: z.enum(['open', 'resolved']),
  viewer: z.strictObject({ canSetResolution: bool }),
});
/** Existing serializer projection only. Global heat inputs never enter this
 * schema; visible comment/reply counts retain their independent owner rules. */
export const hotPostViewSchema = z
  .strictObject({
    id: uuid,
    space: z.strictObject({
      id: uuid,
      kind: z.enum(['regional', 'global']),
      name: text,
    }),
    category: categorySchema,
    text,
    images: z.array(media),
    author,
    publishedAt: text,
    likeCount: count,
    commentCount: count,
    replyCount: count,
    discussionCount: count,
    saveCount: count,
    trading: trading.nullable(),
    component: z.union([
      z.strictObject({ kind: z.literal('none') }),
      z.strictObject({ kind: z.literal('poll'), poll }),
      z.strictObject({ kind: z.literal('formation'), formation }),
    ]),
    viewer: z.strictObject({
      isSelf: bool,
      isLiked: bool,
      canDelete: bool,
      canComment: bool,
      isSaved: bool,
      canSave: bool,
      canSetUpdatePreference: bool,
    }),
    commentsPolicy: z.enum(['open', 'restricted']),
  })
  .meta({ id: 'HotPostView' });
export const hotPageSchema = z
  .strictObject({
    items: z.array(hotPostViewSchema).max(10),
    nextCursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .nullable(),
    continuation: z.enum([
      'more',
      'scan_pending',
      'end',
      'login_required',
      'phone_verification_required',
    ]),
  })
  .meta({ id: 'HotPage' });
