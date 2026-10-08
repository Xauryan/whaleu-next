import { z } from 'zod';
import type { HOT_SCORE_NUMERIC_PROFILE } from './formula.js';

export const HOT_SCORE_COMPONENTS = [
  'subscription',
  'like',
  'comment',
  'view',
] as const;
export type HotScoreComponent = (typeof HOT_SCORE_COMPONENTS)[number];
export const hotScoreOptionsSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'compute']).default('dry-run'),
    postIds: z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .max(50)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine((input) => input.mode !== 'compute' || input.postIds.length > 0);
export type HotScoreOptions = z.infer<typeof hotScoreOptionsSchema>;
export function parseHotScoreCommand(args: readonly string[]): HotScoreOptions {
  const remaining = [...args];
  let mode: HotScoreOptions['mode'] = 'dry-run';
  if (remaining[0] === 'dry-run' || remaining[0] === 'compute')
    mode = remaining.shift() as HotScoreOptions['mode'];
  const postIds = remaining.map((arg) => {
    const match = /^--post-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid hot score arguments');
    return match[1]!;
  });
  return hotScoreOptionsSchema.parse({ mode, postIds });
}

export const counterSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      /^(0|[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n,
  );
const xidSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,19}$/)
  .refine(
    (value) =>
      /^[1-9][0-9]{0,19}$/.test(value) &&
      BigInt(value) <= 18446744073709551615n,
  );
export const hotScoreInputsSchema = z
  .strictObject({
    views: counterSchema,
    postLikes: counterSchema,
    subscriptions: counterSchema,
    rawRootComments: counterSchema,
    rawReplies: counterSchema,
    eligibleComments: counterSchema,
    uniqueEligibleAccounts: counterSchema,
  })
  .refine(
    (input) =>
      Object.values(input).every(
        (value) => counterSchema.safeParse(value).success,
      ) &&
      BigInt(input.uniqueEligibleAccounts) <= BigInt(input.eligibleComments) &&
      BigInt(input.eligibleComments) <=
        BigInt(input.rawRootComments) + BigInt(input.rawReplies),
  );
export type HotScoreInputs = z.infer<typeof hotScoreInputsSchema>;

const baselineSchema = z.strictObject({
  postId: z.uuid(),
  componentVersion: z.literal(1),
  origin: z.literal('native_post_creation'),
  ownerId: z.uuid(),
  sourceRequestId: z.uuid(),
  creationXid: xidSchema,
  createdAt: z.string().min(1),
  openingCounts: z.array(z.literal('0')).min(1).max(4),
  publicationVerified: z.literal(true),
});
export type HotScoreBaseline = z.infer<typeof baselineSchema>;
const asyncStateSchema = z.strictObject({
  postId: z.uuid(),
  counts: z.array(counterSchema).min(1).max(4),
  processedHead: counterSchema,
  capturedHead: counterSchema,
  lastReceiptId: z.uuid().nullable(),
  terminalReceiptValid: z.boolean(),
  unresolvedSequence: counterSchema.nullable(),
  invalidReceipt: z.boolean(),
});
export type HotScoreAsyncState = z.infer<typeof asyncStateSchema>;
const snapshotSchema = z.strictObject({
  postId: z.uuid(),
  ownerId: z.uuid(),
  creationXid: xidSchema,
  snapshotAt: z.string().min(1),
  baselines: z.strictObject({
    subscription: baselineSchema.nullable(),
    like: baselineSchema.nullable(),
    comment: baselineSchema.nullable(),
    view: baselineSchema.nullable(),
  }),
  states: z.strictObject({
    subscription: asyncStateSchema.nullable(),
    like: asyncStateSchema.nullable(),
    comment: asyncStateSchema.nullable(),
    view: z.strictObject({ postId: z.uuid(), count: counterSchema }).nullable(),
  }),
});
export type HotScoreSnapshot = z.infer<typeof snapshotSchema>;
export type HotScoreStatus =
  | 'computed'
  | 'missing'
  | 'blockedCoverage'
  | 'blockedFreshness'
  | 'unavailable'
  | 'numericFailure'
  | 'failed';
export type HotScoreResult =
  | {
      status: Exclude<HotScoreStatus, 'computed'>;
      postId: string;
      advisory: boolean;
    }
  | {
      status: 'computed';
      postId: string;
      advisory: boolean;
      score: string;
      sourceFormulaVersion: 6;
      numericProfile: typeof HOT_SCORE_NUMERIC_PROFILE;
      numericProfileVersion: 1;
      formulaFingerprint: string;
      expressionFingerprint: string;
      snapshot: HotScoreSnapshot;
      viewCoverage: 'synchronous_accepted_aggregate';
      viewIntegrity: 'trusted_reporting_owner_and_access_controls';
    };

/** Fail closed before arithmetic. Independent sequences are never compared to
 * one another, and a source returning the live count to zero is still pending. */
export function validateHotScoreSnapshot(
  input: HotScoreSnapshot,
):
  | { status: 'ready'; inputs: HotScoreInputs; snapshot: HotScoreSnapshot }
  | { status: 'blockedCoverage' | 'blockedFreshness' | 'unavailable' } {
  if (
    HOT_SCORE_COMPONENTS.some(
      (component) => input.baselines?.[component] === null,
    )
  )
    return { status: 'blockedCoverage' };
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success) return { status: 'unavailable' };
  const snapshot = parsed.data;
  for (const component of HOT_SCORE_COMPONENTS) {
    const baseline = snapshot.baselines[component]!;
    if (
      baseline.postId !== snapshot.postId ||
      baseline.ownerId !== snapshot.ownerId ||
      baseline.creationXid !== snapshot.creationXid ||
      baseline.openingCounts.length !== (component === 'comment' ? 4 : 1) ||
      baseline.sourceRequestId !==
        snapshot.baselines.subscription!.sourceRequestId ||
      snapshot.states[component]?.postId !== snapshot.postId
    )
      return { status: 'unavailable' };
  }
  const { subscription, like, comment, view } = snapshot.states;
  if (!subscription || !like || !comment || !view)
    return { status: 'unavailable' };
  for (const [state, countLength] of [
    [subscription, 1],
    [like, 1],
    [comment, 4],
  ] as const) {
    if (
      state.counts.length !== countLength ||
      state.invalidReceipt ||
      !state.terminalReceiptValid ||
      (state.processedHead === '0') !== (state.lastReceiptId === null) ||
      (state.processedHead === '0' &&
        state.counts.some((count) => count !== '0')) ||
      BigInt(state.processedHead) > BigInt(state.capturedHead) ||
      (state.unresolvedSequence !== null &&
        (state.unresolvedSequence === '0' ||
          BigInt(state.unresolvedSequence) > BigInt(state.capturedHead)))
    )
      return { status: 'unavailable' };
  }
  const inputs = hotScoreInputsSchema.safeParse({
    views: view.count,
    postLikes: like.counts[0],
    subscriptions: subscription.counts[0],
    rawRootComments: comment.counts[0],
    rawReplies: comment.counts[1],
    eligibleComments: comment.counts[2],
    uniqueEligibleAccounts: comment.counts[3],
  });
  if (!inputs.success) return { status: 'unavailable' };
  if (
    [subscription, like, comment].some(
      (state) =>
        state.unresolvedSequence !== null ||
        state.processedHead !== state.capturedHead,
    )
  )
    return { status: 'blockedFreshness' };
  return { status: 'ready', inputs: inputs.data, snapshot };
}
