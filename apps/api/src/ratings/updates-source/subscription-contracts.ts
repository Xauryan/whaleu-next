import { z } from 'zod';
import { ratingPublicIdSchema, ratingTimeSchema } from '../contracts.js';
import { ratingOrdinalSchema } from '../cursor.js';
export const ratingSubscriptionSourceSchema = z
  .strictObject({
    id: ratingPublicIdSchema,
    sequence: ratingOrdinalSchema,
    occurredAt: ratingTimeSchema,
    actorAccountId: ratingPublicIdSchema,
    targetOrder: ratingOrdinalSchema,
    coverage: z.enum(['complete', 'unknown']),
    activity: z.enum(['root', 'reply']),
    target: z.strictObject({
      regionId: ratingPublicIdSchema.nullable(),
      targetId: ratingPublicIdSchema,
      rootId: ratingPublicIdSchema,
      replyId: ratingPublicIdSchema.nullable(),
    }),
  })
  .refine(
    (event) => (event.activity === 'root') === (event.target.replyId === null),
  );
export type RatingSubscriptionSource = z.infer<
  typeof ratingSubscriptionSourceSchema
>;
export interface RatingSubscriptionEpoch {
  epochId: string;
  accountId: string;
  startOrder: string;
  eligible: boolean;
}
