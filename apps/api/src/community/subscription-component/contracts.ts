import { z } from 'zod';
export const subscriptionWorkerSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    obligationIds: z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .max(50)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine((input) => input.mode !== 'apply' || input.obligationIds.length > 0);
export type SubscriptionWorkerOptions = z.infer<
  typeof subscriptionWorkerSchema
>;
export type SubscriptionResult =
  | 'applied'
  | 'alreadyCompleted'
  | 'blockedBaseline'
  | 'blockedPredecessor'
  | 'sourceUnavailable'
  | 'missing'
  | 'pending';
export function parseSubscriptionCommand(
  args: readonly string[],
): SubscriptionWorkerOptions {
  const remaining = [...args];
  let mode: 'dry-run' | 'apply' = 'dry-run';
  if (remaining[0] === 'dry-run' || remaining[0] === 'apply')
    mode = remaining.shift() as typeof mode;
  const obligationIds = remaining.map((arg) => {
    const match = /^--obligation-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid subscription processing arguments');
    return match[1]!;
  });
  return subscriptionWorkerSchema.parse({ mode, obligationIds });
}
export interface SubscriptionSource {
  obligation_id: string;
  epoch_id: string;
  transition: 'saved' | 'unsaved';
  post_id: string;
  actor_id: string;
  source_sequence: string | null;
  delta: number;
  status: string;
  source_valid: boolean;
}
export interface SubscriptionState {
  count: string;
  last_sequence: string;
  last_receipt_id: string | null;
}
export interface SubscriptionMembership {
  active_epoch_id: string | null;
  last_sequence: string;
  last_receipt_id: string;
}
