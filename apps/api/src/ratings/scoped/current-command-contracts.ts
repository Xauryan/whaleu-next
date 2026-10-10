import { z } from 'zod';
import {
  ratingCurrentScopedIntentSchema as historicalIntent,
  ratingCurrentScopedReceiptSchema as historicalReceipt,
  ratingCurrentScopedCommandHash as historicalHash,
} from './target-cover-contracts.js';
import {
  ratingDiscussionMediaIntentSchema,
  ratingDiscussionMediaReceiptSchema,
  ratingDiscussionMediaCommandHash,
} from './discussion-media-contracts.js';
/** Additive dispatch. Historical codecs and their byte domains stay unchanged. */
export const ratingCurrentScopedIntentSchema = z.union([
  historicalIntent,
  ratingDiscussionMediaIntentSchema,
]);
export const ratingCurrentScopedReceiptSchema = z.union([
  historicalReceipt,
  ratingDiscussionMediaReceiptSchema,
]);
export type RatingCurrentScopedIntent = z.infer<
  typeof ratingCurrentScopedIntentSchema
>;
export type RatingCurrentScopedReceipt = z.infer<
  typeof ratingCurrentScopedReceiptSchema
>;
export function ratingCurrentScopedCommandHash(
  intent: RatingCurrentScopedIntent,
): string {
  return intent.protocolVersion === 4
    ? ratingDiscussionMediaCommandHash(intent)
    : historicalHash(intent);
}
