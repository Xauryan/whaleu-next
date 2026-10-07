import { z } from 'zod';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import type { PostView } from '../contracts.js';
export const emptySavedQuerySchema = z.strictObject({});
export const saveRequestSchema = z.strictObject({
  clientRequestId: z.uuidv4(),
});
export const updateChannelSchema = z.enum(['saved', 'external']);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;
export const updatePreferenceSchema = z.strictObject({
  clientRequestId: z.uuidv4(),
  channel: updateChannelSchema,
  enabled: z.boolean(),
});
export const savedPageQuerySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
});
export type SavedPageQuery = z.infer<typeof savedPageQuerySchema>;
export const savedStatusSchema = z.strictObject({
  postIds: z
    .array(z.uuid().transform((id) => id.toLowerCase()))
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
});
export type SavedOperation = 'set_post_saved' | 'set_post_update_preference';
export interface SavedIntent {
  operation: SavedOperation;
  postId: string;
  desired: boolean;
  channel: UpdateChannel | null;
}
export type SavedReceipt = SavedIntent & { requestId: string } & (
    { outcome: 'applied' } | { outcome: 'rejected'; code: ApplicationErrorCode }
  );
export interface PostUpdatePreferences {
  postId: string;
  savedUpdatesEnabled: boolean;
  externalUpdatesEnabled: boolean;
  revision: string;
  canSetPreference: boolean;
  reason: ApplicationErrorCode | null;
  inAppCapability: 'local';
  inAppProcessing: 'disabled' | 'manual_only' | 'automatic';
  externalCapability: 'unavailable';
}
export interface SavedPage {
  items: { post: PostView; savedAt: string; saveEpochId: string }[];
  nextCursor: string | null;
  visibleSavedCount: number;
}
export type SavedStatus =
  | { postId: string; status: 'unavailable' }
  | {
      postId: string;
      status: 'available';
      saveCount: number;
      isSaved: boolean;
      savedAt: string | null;
      saveEpochId: string | null;
      preferences: PostUpdatePreferences;
    };
