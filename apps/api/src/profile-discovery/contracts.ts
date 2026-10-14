import { z } from 'zod';
import type { PublicExperienceDisplay } from '../experience/public-display.contract.js';
import type { PostView } from '../community/contracts.js';
import { tradingSubtypeSchema } from '../community/trading/contracts.js';
import type { BlockState } from '../safety/contracts.js';

export const profileIdSchema = z.uuid().transform((id) => id.toLowerCase());
export const emptyQuerySchema = z.strictObject({});
export const emptyBodySchema = z.strictObject({}).default({});
const pageShape = {
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
};
export const profilePostsQuerySchema = z.strictObject(pageShape);
export const profileTradingQuerySchema = z.strictObject({
  ...pageShape,
  tradingSubtype: tradingSubtypeSchema.optional(),
});
export type ProfileContentQuery = z.infer<typeof profileTradingQuerySchema>;
export type UnavailableProfile =
  | { status: 'unavailable'; profileId: string }
  | {
      status: 'blocked_by_you';
      profileId: string;
      relationship: BlockState & { blocked: true };
    };
export type PublicProfile =
  | UnavailableProfile
  | {
      status: 'available';
      profileId: string;
      isOwn: boolean;
      displayName: string;
      bio: string;
      avatar: null;
      affiliation: { schoolCode: string; schoolName: string } | null;
      publicUid: { value: string; formatted: string } | null;
      schoolUidStatus: 'assigned' | 'unassigned' | 'unavailable';
      experienceDisplay: PublicExperienceDisplay;
      totalInteractions: null;
      totalInteractionsStatus: 'unavailable';
      postsHidden: boolean;
      postCount: number | null;
      postCountStatus: 'known' | 'unavailable';
      tradeCount: number | null;
      tradeCountStatus: 'known' | 'unavailable';
    };
export type PublicProfilePage =
  | UnavailableProfile
  | {
      status: 'available' | 'hidden';
      profileId: string;
      items: PostView[];
      total: number | null;
      totalStatus: 'known' | 'unavailable';
      continuation: 'more' | 'scan_pending' | 'end';
      nextCursor: string | null;
    };

/** Public wire schema; school and UID are one optional, atomically cleared fact. */
const publicId = z.uuid().refine((value) => value === value.toLowerCase());
const unavailableCosmetic = z.strictObject({
  status: z.literal('unavailable'),
  value: z.null(),
});
const experienceDisplaySchema = z.strictObject({
  title: z.union([
    unavailableCosmetic,
    z.strictObject({
      status: z.literal('known'),
      value: z
        .strictObject({ key: z.string().min(1), name: z.string().min(1) })
        .nullable(),
    }),
  ]),
  color: z.union([
    unavailableCosmetic,
    z.strictObject({
      status: z.literal('known'),
      value: z.number().int().min(0).max(25).nullable(),
    }),
  ]),
  level: z.union([
    unavailableCosmetic,
    z.strictObject({
      status: z.literal('known'),
      value: z.number().int().min(0),
    }),
  ]),
});
export const publicProfileSchema = z.union([
  z.strictObject({ status: z.literal('unavailable'), profileId: publicId }),
  z.strictObject({
    status: z.literal('blocked_by_you'),
    profileId: publicId,
    relationship: z.strictObject({
      relationshipId: publicId,
      blocked: z.literal(true),
      revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
    }),
  }),
  z
    .strictObject({
      status: z.literal('available'),
      profileId: publicId,
      isOwn: z.boolean(),
      displayName: z.string().min(1).max(100),
      bio: z.string(),
      avatar: z.null(),
      affiliation: z
        .strictObject({
          schoolCode: z.string().regex(/^[0-9]{5}$/),
          schoolName: z.string().min(1).max(200),
        })
        .nullable(),
      publicUid: z
        .strictObject({
          value: z.string().regex(/^[1-9][0-9]{0,18}$/),
          formatted: z.string(),
        })
        .nullable(),
      schoolUidStatus: z.enum(['assigned', 'unassigned', 'unavailable']),
      experienceDisplay: experienceDisplaySchema,
      totalInteractions: z.null(),
      totalInteractionsStatus: z.literal('unavailable'),
      postsHidden: z.boolean(),
      postCount: z.number().int().min(0).nullable(),
      postCountStatus: z.enum(['known', 'unavailable']),
      tradeCount: z.number().int().min(0).nullable(),
      tradeCountStatus: z.enum(['known', 'unavailable']),
    })
    .refine((value) =>
      value.schoolUidStatus === 'assigned'
        ? value.affiliation !== null &&
          value.publicUid !== null &&
          /^[1-9][0-9]{0,18}$/.test(value.publicUid.value) &&
          BigInt(value.publicUid.value) <= 9223372036854775807n &&
          value.publicUid.formatted === value.publicUid.value.padStart(6, '0')
        : value.affiliation === null && value.publicUid === null,
    ),
]);
