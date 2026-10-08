import { z } from 'zod';
export const commentWorkerSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    sourceIds: z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .max(50)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine((input) => input.mode !== 'apply' || input.sourceIds.length > 0);
export type CommentWorkerOptions = z.infer<typeof commentWorkerSchema>;
export type CommentResult =
  | 'applied'
  | 'alreadyCompleted'
  | 'blockedBaseline'
  | 'blockedPredecessor'
  | 'sourceUnavailable'
  | 'missing'
  | 'pending';
export function parseCommentCommand(
  args: readonly string[],
): CommentWorkerOptions {
  const remaining = [...args];
  let mode: 'dry-run' | 'apply' = 'dry-run';
  if (remaining[0] === 'dry-run' || remaining[0] === 'apply')
    mode = remaining.shift() as typeof mode;
  const sourceIds = remaining.map((arg) => {
    const match = /^--source-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid comment processing arguments');
    return match[1]!;
  });
  return commentWorkerSchema.parse({ mode, sourceIds });
}
export interface CommentSource {
  source_id: string;
  post_id: string;
  actor_id: string;
  kind: 'root' | 'reply';
  content_id: string;
  root_id: string | null;
  transition: 'created' | 'deleted';
  source_sequence: string;
  delta: number;
  positive_source_id: string | null;
}
export interface CommentCounts {
  root_count: string;
  reply_count: string;
  eligible_count: string;
  unique_actor_count: string;
}
export interface CommentState extends CommentCounts {
  last_sequence: string;
  last_receipt_id: string | null;
}
export interface CommentContribution {
  actor_id: string;
  root_id: string | null;
  eligible: boolean;
  active: boolean;
  positive_source_id: string;
  last_sequence: string;
  last_receipt_id: string;
}
export interface CommentMembership {
  active_count: string;
  last_sequence: string;
  last_receipt_id: string;
}
