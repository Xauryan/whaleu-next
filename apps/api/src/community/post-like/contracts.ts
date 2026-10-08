import { createHash } from 'node:crypto';
import { z } from 'zod';
export const postLikeIntentSchema = z.strictObject({
  requestId: z.uuidv4().transform((value) => value.toLowerCase()),
  liked: z.boolean(),
});
export type PostLikeIntent = z.infer<typeof postLikeIntentSchema>;
export const postLikeRejectionCodes = [
  'POST_NOT_FOUND',
  'COMMUNITY_SCOPE_UNAVAILABLE',
  'PHONE_VERIFICATION_REQUIRED',
  'COMMUNITY_ACTION_RESTRICTED',
] as const;
export type PostLikeRejectionCode = (typeof postLikeRejectionCodes)[number];
export type PostLikeReceipt = {
  requestId: string;
  operation: 'set_post_like';
  postId: string;
  liked: boolean;
} & (
  { outcome: 'applied' } | { outcome: 'rejected'; code: PostLikeRejectionCode }
);
export function postLikeIntentHash(postId: string, liked: boolean): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        operation: 'set_post_like',
        postId: postId.toLowerCase(),
        liked,
      }),
    )
    .digest('hex');
}
