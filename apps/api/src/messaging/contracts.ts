import { z } from 'zod';
import { textSchema } from '../community/text.js';
export const dmId = z.uuid().refine((v) => v === v.toLowerCase());
export const dmSequence = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (v) =>
      /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n,
  );
export const dmMode = z.enum(['named', 'anonymous']);
export const dmText = textSchema(500).refine(
  (v) => v.trim().length > 0 && Buffer.byteLength(v, 'utf8') <= 2000,
);
export const dmEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('profile'), profileId: dmId }),
  z.strictObject({ kind: z.literal('post'), postId: dmId }),
  z.strictObject({ kind: z.literal('comment'), postId: dmId, commentId: dmId }),
  z.strictObject({
    kind: z.literal('reply'),
    postId: dmId,
    rootCommentId: dmId,
    replyId: dmId,
  }),
]);
export type DmEntry = z.infer<typeof dmEntrySchema>;
export const dmCommandSchema = z.strictObject({
  clientRequestId: z.uuidv4().refine((v) => v === v.toLowerCase()),
});
export const dmOpenSchema = dmCommandSchema.extend({
  entry: dmEntrySchema,
  initiationMode: dmMode,
});
export const dmSendSchema = dmCommandSchema.extend({ text: dmText });
export const dmReadSchema = dmCommandSchema.extend({ observationId: dmId });
export const dmOperation = z.enum([
  'open',
  'send',
  'read',
  'hide',
  'reopen',
  'recall',
  'block',
]);
export type DmOperation = z.infer<typeof dmOperation>;
export const dmCancelSchema = z.strictObject({
  operation: dmOperation,
  intentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const dmRejection = z.enum([
  'DM_COMMAND_CANCELLED',
  'DM_NOT_FOUND',
  'DM_ENTRY_UNAVAILABLE',
  'DM_SEND_UNAVAILABLE',
  'DM_FIRST_CONTACT_LIMIT',
  'DM_RECALL_EXPIRED',
  'DM_OBSERVATION_UNAVAILABLE',
  'CONTENT_REJECTED',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
]);
export const dmReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: dmId,
    operation: dmOperation,
    outcome: z.literal('applied'),
    conversationId: dmId,
    messageId: dmId.nullable(),
    occurredAt: z.iso.datetime(),
  }),
  z.strictObject({
    requestId: dmId,
    operation: dmOperation,
    outcome: z.literal('noop'),
    conversationId: dmId,
    messageId: dmId.nullable(),
    occurredAt: z.iso.datetime(),
  }),
  z.strictObject({
    requestId: dmId,
    operation: dmOperation,
    outcome: z.literal('rejected'),
    code: dmRejection,
  }),
]);
export type DmReceipt = z.infer<typeof dmReceiptSchema>;
export const dmCancellationResultSchema = z
  .strictObject({
    outcome: z.enum(['cancelled', 'already_terminal']),
    receipt: dmReceiptSchema,
  })
  .refine(
    (value) =>
      (value.outcome === 'cancelled') ===
      (value.receipt.outcome === 'rejected' &&
        value.receipt.code === 'DM_COMMAND_CANCELLED'),
  );
export type DmCancellationResult = z.infer<typeof dmCancellationResultSchema>;
export const dmDisplaySchema = z
  .strictObject({
    mode: dmMode,
    displayName: z.string().max(200),
    profileId: dmId
      .nullable()
      .describe(
        'Named-profile navigation locator only, never current access authority. Mixed contexts retain the original locator without consulting a hidden account-pair graph; the destination independently reauthorizes every explicit navigation. Anonymous identities always return null.',
      ),
  })
  .refine((v) => v.mode === 'named' || v.profileId === null);
export const dmConversationSchema = z.strictObject({
  id: dmId,
  self: dmDisplaySchema,
  peer: dmDisplaySchema,
  source: z
    .strictObject({
      kind: z.literal('post'),
      postId: dmId,
      available: z.boolean(),
    })
    .nullable(),
  unreadCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  hidden: z.boolean(),
  sendAvailability: z.enum([
    'available',
    'unavailable',
    'blocked_by_you',
    'awaiting_reply',
  ]),
  blockScope: z.enum(['named', 'conversation', 'named_and_conversation']),
  blockedByYou: z.boolean(),
});
export const dmMessageSchema = z
  .strictObject({
    id: dmId,
    sequence: dmSequence,
    sender: z.enum(['self', 'peer']),
    state: z.enum(['text', 'recalled', 'unavailable']),
    text: z.string().nullable(),
    createdAt: z.iso.datetime(),
    canRecall: z.boolean(),
  })
  .refine((v) => (v.state === 'text' ? v.text !== null : v.text === null));
export type DmMessage = z.infer<typeof dmMessageSchema>;
export const dmCoverage = z.enum(['local', 'complete']);
export const dmListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      conversation: dmConversationSchema,
      latest: dmMessageSchema.nullable(),
      updatedAt: z.iso.datetime(),
    }),
  ),
  nextCursor: z.string().nullable(),
  coverage: dmCoverage,
});
export const dmHistorySchema = z.strictObject({
  items: z.array(dmMessageSchema),
  nextCursor: z.string().nullable(),
  observationId: dmId,
  throughSequence: dmSequence,
  eventCursor: z.string(),
  coverage: dmCoverage,
});
export const dmEventsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      sequence: dmSequence,
      kind: z.enum(['sent', 'recalled']),
      message: dmMessageSchema,
    }),
  ),
  nextCursor: z.string(),
  hasMore: z.boolean(),
  observationId: dmId,
  throughSequence: dmSequence,
});
export const dmUnreadSchema = z.strictObject({
  count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  coverage: dmCoverage,
});
export const dmEmptySchema = z.strictObject({});
export const dmPageQuery = z.strictObject({
  cursor: z.string().min(1).max(1024).optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .default('20')
    .transform(Number),
});
