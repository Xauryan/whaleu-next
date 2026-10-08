import { z } from 'zod';
export const likeWorkerSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    sourceIds: z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .max(50)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine((input) => input.mode !== 'apply' || input.sourceIds.length > 0);
export type LikeWorkerOptions = z.infer<typeof likeWorkerSchema>;
export type LikeResult =
  | 'applied'
  | 'alreadyCompleted'
  | 'blockedBaseline'
  | 'blockedPredecessor'
  | 'sourceUnavailable'
  | 'missing'
  | 'pending';
export function parseLikeCommand(args: readonly string[]): LikeWorkerOptions {
  const remaining = [...args];
  let mode: 'dry-run' | 'apply' = 'dry-run';
  if (remaining[0] === 'dry-run' || remaining[0] === 'apply')
    mode = remaining.shift() as typeof mode;
  const sourceIds = remaining.map((arg) => {
    const match = /^--source-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid like processing arguments');
    return match[1]!;
  });
  return likeWorkerSchema.parse({ mode, sourceIds });
}
export interface LikeSource {
  source_id: string;
  like_id: string;
  transition: 'liked' | 'unliked';
  post_id: string;
  actor_id: string;
  source_sequence: string;
  delta: number;
  positive_source_id: string | null;
}
export interface LikeState {
  count: string;
  last_sequence: string;
  last_receipt_id: string | null;
}
export interface LikeMembership {
  active_like_id: string | null;
  last_sequence: string;
  last_receipt_id: string;
}
