import { formationComponentSchema } from '../formation/contracts.js';
import { z } from 'zod';
import type { ApplicationErrorCode } from '../../http/application-error.js';
import { textSchema } from '../text.js';
export const pollComponentSchema = z.strictObject({
  kind: z.literal('poll'),
  question: textSchema(255).refine((value) => value.trim().length > 0),
  selectionMode: z.enum(['single', 'multiple']),
  options: z
    .array(textSchema(255).refine((value) => value.trim().length > 0))
    .min(2)
    .max(5)
    .refine((options) => {
      const labels = options.map((label) => label.trim());
      const optional = labels.indexOf('吃瓜🍉');
      return (
        new Set(labels).size === labels.length &&
        (optional === -1 ||
          (optional === labels.length - 1 && labels.length >= 3))
      );
    }),
});
export const postComponentSchema = z.union([
  z.strictObject({ kind: z.literal('none') }),
  pollComponentSchema,
  formationComponentSchema,
]);
export type PollComponent = z.infer<typeof pollComponentSchema>;
export const emptyPollQuerySchema = z.strictObject({});
export const ballotSchema = z.strictObject({
  clientRequestId: z.uuidv4(),
  optionIds: z
    .array(z.uuid().transform((id) => id.toLowerCase()))
    .min(1)
    .max(5)
    .refine((ids) => new Set(ids).size === ids.length)
    .transform((ids) => ids.sort()),
});
export type CastBallot = z.infer<typeof ballotSchema>;
export type BallotReceipt =
  | {
      requestId: string;
      operation: 'cast_poll_ballot';
      outcome: 'created';
      resourceId: string;
      createdAt: string;
    }
  | {
      requestId: string;
      operation: 'cast_poll_ballot';
      outcome: 'rejected';
      code: ApplicationErrorCode;
    };
export interface OwnBallot {
  postId: string;
  ballotId: string;
  createdAt: string;
  selectedOptionIds: string[];
}
export interface PollView {
  id: string;
  postId: string;
  question: string;
  selectionMode: 'single' | 'multiple';
  options: { id: string; label: string; position: number; count: number }[];
  deadline: string | null;
  expired: boolean;
  voterCount: number;
  selectionCount: number;
  viewer: {
    hasVoted: boolean;
    selectedOptionIds: string[];
    canVote: boolean;
    reason: ApplicationErrorCode | null;
  };
}
