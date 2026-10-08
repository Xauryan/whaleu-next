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
      affiliation: null;
      publicUid: null;
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
