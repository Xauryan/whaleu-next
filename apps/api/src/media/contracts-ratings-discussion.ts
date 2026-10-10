import { mediaGrantSchema, mediaUploadObservedSchema } from './contracts-v2.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../community/content-review/contracts.js';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaMimeSchema,
  mediaVariantSchema,
} from './contracts.js';
import {
  scopedId as id,
  scopedDigest as digest,
  scopedToken,
} from '../ratings/scoped/contracts.js';
import { ratingDiscussionCommandContextSchema } from '../ratings/scoped/discussion-media-contracts.js';

export const RATINGS_DISCUSSION_MEDIA_PROTOCOL =
  'ratings-discussion-media-v1' as const;
const base = { protocol: z.literal(RATINGS_DISCUSSION_MEDIA_PROTOCOL) };
const target = {
  targetId: id,
  expectedTargetRevision: id,
  expectedDefinitionRevision: id,
  expectedContentVersion: z.number().int().min(1).max(2147483647),
};
export const ratingsDiscussionMediaTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...target, kind: z.literal('root') }),
  z
    .strictObject({
      ...target,
      kind: z.literal('reply'),
      rootId: id,
      expectedRootRevision: id,
      replyTo: z.strictObject({ replyId: id, expectedRevision: id }).nullable(),
    })
    .refine((value) => value.replyTo?.replyId !== value.rootId),
]);
export const ratingsDiscussionBatchIdentitySchema = z
  .strictObject({
    ...base,
    batchRequestId: id,
    commandRequestId: id,
    draftRevision: id,
    categoryId: id,
    expectedCategoryRevision: id,
    context: ratingDiscussionCommandContextSchema,
    target: ratingsDiscussionMediaTargetSchema,
  })
  .refine((value) => value.batchRequestId !== value.commandRequestId);
export type RatingsDiscussionBatchIdentity = z.infer<
  typeof ratingsDiscussionBatchIdentitySchema
>;
export function ratingsDiscussionBatchHash(
  actorAccountId: string,
  raw: unknown,
): string {
  const identity = ratingsDiscussionBatchIdentitySchema.parse(raw);
  return createHash('sha256')
    .update(
      'whaleu:ratings-discussion-media-batch:v1\n' +
        canonicalJson({ actorAccountId: id.parse(actorAccountId), identity }),
    )
    .digest('hex');
}
export const ratingsDiscussionMemberPrepareSchema = z.strictObject({
  ...base,
  clientRequestId: id,
  batchId: id,
  batchIdentityHash: digest,
  memberId: id,
  // A stable selection identity, not the final publication ordinal.
  sourceSlot: z.number().int().min(0).max(127),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: digest,
  }),
});
export type RatingsDiscussionMemberPrepare = z.infer<
  typeof ratingsDiscussionMemberPrepareSchema
>;
export function ratingsDiscussionMemberHash(
  actorAccountId: string,
  raw: unknown,
): string {
  const member = ratingsDiscussionMemberPrepareSchema.parse(raw);
  return createHash('sha256')
    .update(
      'whaleu:ratings-discussion-media-member:v1\n' +
        canonicalJson({ actorAccountId: id.parse(actorAccountId), member }),
    )
    .digest('hex');
}
export const ratingsDiscussionSealSchema = z.strictObject({
  ...base,
  batchId: id,
  batchIdentityHash: digest,
  expectedRevision: id,
  orderedMemberIds: z
    .array(id)
    .min(1)
    .max(9)
    .refine((values) => new Set(values).size === values.length),
});
/** Typed parents cannot be decoded as a target cover or Community subject. */
export const ratingsDiscussionMediaParentSchema = z.discriminatedUnion(
  'resourceKind',
  [
    z.strictObject({
      ownerKind: z.literal('ratings'),
      resourceKind: z.literal('rating_comment'),
      targetId: id,
      resourceId: id,
      contentVersion: z.literal(1),
    }),
    z
      .strictObject({
        ownerKind: z.literal('ratings'),
        resourceKind: z.literal('rating_reply'),
        targetId: id,
        rootId: id,
        resourceId: id,
        contentVersion: z.literal(1),
      })
      .refine((value) => value.rootId !== value.resourceId),
  ],
);
export type RatingsDiscussionMediaParent = z.infer<
  typeof ratingsDiscussionMediaParentSchema
>;
export const ratingsDiscussionMediaDescriptorSchema = z
  .strictObject({
    ...base,
    kind: z.literal('ratings-discussion-media'),
    targetId: id,
    rootId: id,
    replyId: id.nullable(),
    subjectRevision: id,
    contextId: id,
    contextToken: scopedToken,
    bindingId: id,
    ordinal: z.number().int().min(0).max(8),
    attachmentSetDigest: digest,
    width: z.number().int().positive().max(2048),
    height: z.number().int().positive().max(2048),
    variants: z.tuple([z.literal('thumb-v1'), z.literal('display-v1')]),
  })
  .refine(
    (value) =>
      value.replyId === null ||
      (value.ordinal < 3 && value.replyId !== value.rootId),
  );
export type RatingsDiscussionMediaDescriptor = z.infer<
  typeof ratingsDiscussionMediaDescriptorSchema
>;
export const ratingsDiscussionMediaDeliverySchema = z
  .strictObject({
    ...base,
    targetId: id,
    rootId: id,
    replyId: id.nullable(),
    subjectRevision: id,
    contextId: id,
    contextToken: scopedToken,
    bindingId: id,
    ordinal: z.number().int().min(0).max(8),
    attachmentSetDigest: digest,
    variant: mediaVariantSchema,
  })
  .refine(
    (value) =>
      value.replyId === null ||
      (value.ordinal < 3 && value.replyId !== value.rootId),
  );
export const ratingsDiscussionSealedPlanSchema = z.strictObject({
  batchId: id,
  batchIdentityHash: digest,
  orderedMembers: z
    .array(
      z.strictObject({
        ordinal: z.number().int().min(0).max(8),
        memberId: id,
        assetId: id,
        manifestDigest: digest,
      }),
    )
    .min(1)
    .max(9)
    .refine(
      (members) =>
        members.every((member, index) => member.ordinal === index) &&
        new Set(members.map((member) => member.memberId)).size ===
          members.length &&
        new Set(members.map((member) => member.assetId)).size ===
          members.length,
    ),
});
export function ratingsDiscussionSealedPlanHash(raw: unknown): string {
  const plan = ratingsDiscussionSealedPlanSchema.parse(raw);
  return createHash('sha256')
    .update('whaleu:ratings-discussion-media-plan:v1\n' + canonicalJson(plan))
    .digest('hex');
}

const instant = z.number().int().positive().safe();
const memberBase = {
  ...base,
  batchId: id,
  memberId: id,
  intentId: id,
  requestId: id,
  requestHash: digest,
  serverNow: instant,
};
export const ratingsDiscussionMemberStatusSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      ...memberBase,
      status: z.literal('prepared'),
      operationDeadlineAt: instant,
      upload: z.enum(['none', 'in_flight', 'reconcile_needed']),
    }),
    z.strictObject({
      ...memberBase,
      status: z.literal('uploaded'),
      operationDeadlineAt: instant,
    }),
    z.strictObject({
      ...memberBase,
      status: z.literal('processing'),
      operationDeadlineAt: instant,
      retryAfterMs: z.number().int().min(250).max(30000),
    }),
    z.strictObject({
      ...memberBase,
      status: z.literal('ready_unbound'),
      assetId: id,
      manifestDigest: digest,
      bindBefore: instant,
      mediaProof: z.literal('current'),
    }),
    z.strictObject({
      ...memberBase,
      status: z.literal('bound_history'),
      assetId: id,
      bindingId: id,
      parent: ratingsDiscussionMediaParentSchema,
      attachmentState: z.enum(['active', 'detached']),
    }),
    z.strictObject({
      ...memberBase,
      status: z.literal('terminal'),
      reason: z.enum(['cancelled', 'expired', 'rejected', 'deleted']),
      cleanup: z.enum(['pending', 'retained', 'confirmed']),
    }),
    z.strictObject({
      ...memberBase,
      status: z.literal('unavailable'),
      reason: z.literal('MEDIA_UNAVAILABLE'),
      retryable: z.literal(true),
    }),
  ],
);
export type RatingsDiscussionMemberStatus = z.infer<
  typeof ratingsDiscussionMemberStatusSchema
>;
export const ratingsDiscussionMemberRecoverySchema = z.discriminatedUnion(
  'state',
  [
    z.strictObject({
      ...base,
      requestId: id,
      serverNow: instant,
      state: z.literal('not_recorded'),
      requestHash: z.null(),
    }),
    z.strictObject({
      ...base,
      requestId: id,
      serverNow: instant,
      state: z.literal('cancelled_before_prepare'),
      requestHash: digest,
    }),
    z.strictObject({
      ...base,
      requestId: id,
      serverNow: instant,
      state: z.literal('recorded'),
      requestHash: digest,
      status: ratingsDiscussionMemberStatusSchema,
    }),
  ],
);
export const ratingsDiscussionCancelRequestSchema = z.strictObject({
  ...base,
  requestHash: digest,
});
export const ratingsDiscussionBatchStatusSchema = z
  .strictObject({
    ...base,
    batchId: id,
    identity: ratingsDiscussionBatchIdentitySchema,
    batchIdentityHash: digest,
    revision: id,
    state: z.enum(['editing', 'sealed', 'consumed', 'cancelled']),
    expiresAt: instant,
    serverNow: instant,
    members: z
      .array(
        z.strictObject({
          memberId: id,
          requestId: id,
          intentId: id,
          sourceSlot: z.number().int().min(0).max(127),
          state: z.enum(['live', 'removed', 'bound']),
        }),
      )
      .max(128),
    sealedPlan: ratingsDiscussionSealedPlanSchema.nullable(),
    sealedPlanDigest: digest.nullable(),
    consumedParent: ratingsDiscussionMediaParentSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const reply = value.identity.target.kind === 'reply',
      plan = value.sealedPlan;
    if (
      (plan === null) !== (value.sealedPlanDigest === null) ||
      (['sealed', 'consumed'].includes(value.state) && plan === null) ||
      (value.state === 'editing' && plan !== null) ||
      (value.state === 'consumed') !== (value.consumedParent !== null) ||
      new Set(value.members.map((x) => x.memberId)).size !==
        value.members.length ||
      new Set(value.members.map((x) => x.requestId)).size !==
        value.members.length ||
      new Set(value.members.map((x) => x.intentId)).size !==
        value.members.length ||
      new Set(value.members.map((x) => x.sourceSlot)).size !==
        value.members.length ||
      value.members.filter((x) => x.state !== 'removed').length >
        (reply ? 3 : 9) ||
      value.members.some(
        (x) => x.state === 'bound' && value.state !== 'consumed',
      ) ||
      (plan !== null &&
        (plan.batchId !== value.batchId ||
          plan.batchIdentityHash !== value.batchIdentityHash ||
          plan.orderedMembers.length > (reply ? 3 : 9) ||
          ratingsDiscussionSealedPlanHash(plan) !== value.sealedPlanDigest ||
          plan.orderedMembers.some(
            (x) =>
              !value.members.some(
                (m) =>
                  m.memberId === x.memberId &&
                  (value.state === 'consumed'
                    ? m.state === 'bound'
                    : m.state === 'live'),
              ),
          ))) ||
      (value.consumedParent !== null &&
        (value.consumedParent.targetId !== value.identity.target.targetId ||
          value.consumedParent.resourceKind !==
            (reply ? 'rating_reply' : 'rating_comment') ||
          (value.consumedParent.resourceKind === 'rating_reply' &&
            value.identity.target.kind === 'reply' &&
            value.consumedParent.rootId !== value.identity.target.rootId)))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Inconsistent Ratings discussion batch receipt',
      });
  });
export type RatingsDiscussionBatchStatus = z.infer<
  typeof ratingsDiscussionBatchStatusSchema
>;
export const ratingsDiscussionBatchRecoverySchema = z.discriminatedUnion(
  'state',
  [
    z.strictObject({
      ...base,
      batchRequestId: id,
      serverNow: instant,
      state: z.literal('not_recorded'),
    }),
    z.strictObject({
      ...base,
      batchRequestId: id,
      serverNow: instant,
      state: z.literal('recorded'),
      status: ratingsDiscussionBatchStatusSchema,
    }),
    z.strictObject({
      ...base,
      batchRequestId: id,
      serverNow: instant,
      state: z.literal('cancelled_before_prepare'),
      identityHash: digest,
    }),
  ],
);
export const ratingsDiscussionBatchCancelRequestSchema = z.strictObject({
  ...base,
  identityHash: digest,
});
export const ratingsDiscussionBatchMutationSchema = z.strictObject({
  ...base,
  batchIdentityHash: digest,
  expectedRevision: id,
});
export const ratingsDiscussionRemoveMemberSchema =
  ratingsDiscussionBatchMutationSchema.extend({ memberId: id });

export const ratingsDiscussionMediaGrantSchema = mediaGrantSchema
  .omit({ version: true })
  .extend({ ...base, batchId: id, memberId: id });
export const ratingsDiscussionMediaUploadObservedSchema =
  mediaUploadObservedSchema
    .omit({ version: true })
    .extend({ ...base, batchId: id, memberId: id });
