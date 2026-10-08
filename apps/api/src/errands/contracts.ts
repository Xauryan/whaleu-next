import { z } from 'zod';

export const errandIdSchema = z
  .uuid()
  .transform((value) => value.toLowerCase());
const publicId = z.uuid().refine((value) => value === value.toLowerCase());
export const errandCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const errandTimeSchema = z.iso.datetime({ offset: true });
export const errandEmptyQuerySchema = z.strictObject({});
export const errandEmptyBodySchema = z.union([
  z.undefined(),
  z.strictObject({}),
]);
/** Fresh text: CRLF becomes LF, surrounding whitespace is trimmed; no NFC or
 * destructive truncation. Limits count Unicode code points, not UTF-16 units. */
export const errandText = (maximum: number, required = true) =>
  z
    .string()
    .max(maximum * 2 + 100)
    .transform((value) => value.replaceAll('\r\n', '\n').trim())
    .refine(
      (value) =>
        (!required || value.length > 0) &&
        [...value].length <= maximum &&
        [...value].every((c) => {
          const n = c.codePointAt(0)!;
          return (
            n === 9 ||
            n === 10 ||
            (n >= 32 &&
              !(n >= 127 && n <= 159) &&
              !(n >= 0xd800 && n <= 0xdfff))
          );
        }),
    );
/** Exact base-10 string, range 1–500 inclusive. The 100-digit transport budget
 * is a fresh-input hardening limit, not a claim about historical precision. */
export const errandRewardSchema = z
  .string()
  .max(101)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
  .refine((value) => {
    if (
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ||
      value.replace('.', '').length > 100
    )
      return false;
    const [whole, fraction = ''] = value.split('.');
    return (
      BigInt(whole!) >= 1n &&
      (BigInt(whole!) < 500n ||
        (BigInt(whole!) === 500n && !/[1-9]/.test(fraction)))
    );
  })
  .transform((value) =>
    value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value,
  );
export const errandContactsSchema = z.strictObject({
  wechat: errandText(50, false),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9]{0,11}$/),
});
export const errandPublisherContactsSchema = errandContactsSchema.refine(
  (value) => !!value.wechat && !!value.phone,
);
export const errandAccepterContactsSchema = errandContactsSchema.refine(
  (value) => !!value.wechat || !!value.phone,
);
export const publishErrandSchema = z.strictObject({
  clientRequestId: errandIdSchema,
  targetRegionId: errandIdSchema,
  title: errandText(50),
  publicText: errandText(500),
  privateText: errandText(200, false),
  expectedTimeText: errandText(50),
  reward: errandRewardSchema,
  publisherContacts: errandPublisherContactsSchema,
  publicAssetIds: z.array(errandIdSchema).max(3),
  privateAssetIds: z.array(errandIdSchema).max(3),
});
export const errandCommandSchema = z.strictObject({
  clientRequestId: errandIdSchema,
  expectedRevision: publicId,
});
export const acceptErrandSchema = errandCommandSchema.extend({
  contacts: errandAccepterContactsSchema,
});
const listFields = {
  limit: z
    .union([
      z.number(),
      z
        .string()
        .regex(/^[1-9][0-9]?$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(1).max(50))
    .default(20),
  cursor: errandCursorSchema.optional(),
};
export const errandsQuerySchema = z.strictObject({
  regionId: errandIdSchema,
  filter: z.enum(['all', 'pending']).default('all'),
  sort: z.enum(['created', 'reward']).default('created'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  ...listFields,
});
export const ownErrandsQuerySchema = z.strictObject({
  relation: z.enum(['published', 'accepted']),
  ...listFields,
});
export const errandStateSchema = z.enum([
  'pending',
  'accepted',
  'completed',
  'cancelled',
]);
export const errandOperationSchema = z.enum([
  'publish',
  'accept',
  'cancel',
  'complete',
  'delete',
]);
export const errandRejectionSchema = z.enum([
  'ERRAND_NOT_FOUND',
  'ERRAND_REVISION_CONFLICT',
  'ERRAND_STATE_CONFLICT',
  'ERRAND_ACTION_RESTRICTED',
  'ERRAND_SELF_ACCEPT',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'CONTENT_REJECTED',
]);
export const errandReceiptSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    requestId: publicId,
    operation: errandOperationSchema,
    outcome: z.literal('applied'),
    orderId: publicId,
    revision: publicId,
    occurredAt: errandTimeSchema,
  }),
  z.strictObject({
    requestId: publicId,
    operation: errandOperationSchema,
    outcome: z.literal('rejected'),
    code: errandRejectionSchema,
  }),
]);
export const errandRegionSchema = z.strictObject({
  id: publicId,
  label: z.string().min(1).max(200),
});
const outputText = (maximum: number, required = true) =>
  z
    .string()
    .max(maximum * 2)
    .refine((value) => {
      const parsed = errandText(maximum, required).safeParse(value);
      return parsed.success && parsed.data === value;
    });
const outputReward = z
  .string()
  .max(101)
  .regex(/^[1-9][0-9]*(?:\.[0-9]+)?$/)
  .refine((value) => {
    const parsed = errandRewardSchema.safeParse(value);
    return parsed.success && parsed.data === value;
  });
const outputContacts = z
  .strictObject({
    wechat: outputText(50, false),
    phone: z.string().regex(/^[0-9]{0,11}$/),
  })
  .refine((value) => !!value.wechat || !!value.phone);
export const errandSummarySchema = z
  .strictObject({
    id: publicId,
    revision: publicId,
    title: outputText(50),
    publicText: outputText(500),
    expectedTimeText: outputText(50),
    reward: outputReward,
    state: errandStateSchema,
    createdAt: errandTimeSchema,
    acceptedAt: errandTimeSchema.nullable(),
    completedAt: errandTimeSchema.nullable(),
    cancelledAt: errandTimeSchema.nullable(),
    targetRegion: errandRegionSchema,
    sourceRegion: errandRegionSchema,
    scope: z.enum(['home', 'related', 'foreign']),
  })
  .refine(
    (value) =>
      (value.state !== 'pending' || value.acceptedAt === null) &&
      (!['accepted', 'completed'].includes(value.state) ||
        value.acceptedAt !== null) &&
      (value.state === 'completed') === (value.completedAt !== null) &&
      (value.state === 'cancelled') === (value.cancelledAt !== null) &&
      (value.acceptedAt === null ||
        Date.parse(value.acceptedAt) >= Date.parse(value.createdAt)) &&
      (value.completedAt === null ||
        Date.parse(value.completedAt) >= Date.parse(value.acceptedAt!)) &&
      (value.cancelledAt === null ||
        Date.parse(value.cancelledAt) >=
          Date.parse(value.acceptedAt ?? value.createdAt)),
  );
export const errandParticipantDisplaySchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    displayName: z.string().min(1).max(200),
  }),
  z.strictObject({ status: z.literal('unavailable') }),
]);
export const errandDetailSchema = errandSummarySchema
  .safeExtend({
    relation: z.enum(['publisher', 'accepter', 'none']),
    privateText: outputText(200, false).optional(),
    oppositeContact: z
      .strictObject({
        display: errandParticipantDisplaySchema,
        contacts: outputContacts,
      })
      .optional(),
    capabilities: z.strictObject({
      accept: z.boolean(),
      cancel: z.boolean(),
      complete: z.boolean(),
      delete: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    if (
      (value.relation === 'none') !== (value.privateText === undefined) ||
      (value.relation === 'accepter' && value.acceptedAt === null) ||
      (value.capabilities.accept &&
        (value.relation !== 'none' || value.state !== 'pending')) ||
      (value.capabilities.cancel &&
        (value.relation !== 'publisher' ||
          !['pending', 'accepted'].includes(value.state))) ||
      (value.capabilities.complete &&
        (value.relation !== 'publisher' || value.state !== 'accepted')) ||
      (value.capabilities.delete && value.relation !== 'publisher') ||
      (value.oppositeContact !== undefined &&
        (value.relation === 'none' || value.state !== 'accepted'))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid participant projection',
      });
  });
export const errandPageSchema = z
  .strictObject({
    context: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('discovery'),
        regionId: publicId,
        discoveryMode: z.enum(['home', 'own_only']),
      }),
      z.strictObject({
        kind: z.literal('own'),
        relation: z.enum(['published', 'accepted']),
      }),
    ]),
    items: z.array(errandSummarySchema).max(50),
    continuation: z.enum(['more', 'end']),
    nextCursor: errandCursorSchema.nullable(),
  })
  .refine(
    (value) => (value.continuation === 'end') === (value.nextCursor === null),
  )
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.id)).size === value.items.length,
  );
export const errandContactHistorySchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('empty') }),
  z.strictObject({ status: z.literal('available'), contacts: outputContacts }),
]);
export type PublishErrand = z.infer<typeof publishErrandSchema>;
export type ErrandCommand = z.infer<typeof errandCommandSchema>;
export type AcceptErrand = z.infer<typeof acceptErrandSchema>;
export type ErrandsQuery = z.infer<typeof errandsQuerySchema>;
export type OwnErrandsQuery = z.infer<typeof ownErrandsQuerySchema>;
export type ErrandReceipt = z.infer<typeof errandReceiptSchema>;
export type ErrandOperation = z.infer<typeof errandOperationSchema>;
export type ErrandSummary = z.infer<typeof errandSummarySchema>;
export type ErrandDetail = z.infer<typeof errandDetailSchema>;
export type ErrandContacts = z.infer<typeof errandContactsSchema>;
