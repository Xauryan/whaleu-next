import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  MEDIA_MAX_INPUT_BYTES,
  mediaDigestSchema,
  mediaMimeSchema,
} from './contracts.js';
import {
  mediaV2IdSchema,
  mediaGenerationSchema,
  mediaStatusV2Schema,
} from './contracts-v2.js';

export const MEDIA_BATCH_LIMITS = Object.freeze({
  live: 3,
  retiring: 3,
  commands: 128,
  dailyBatches: 16,
});
const id = mediaV2IdSchema;
const instant = z.number().int().positive().safe();
const uniqueIds = z
  .array(id)
  .max(3)
  .refine((xs) => new Set(xs).size === xs.length);
export const publicationReferenceSchema = z.strictObject({
  clientRequestId: mediaV2IdSchema,
  operation: z.enum(['publish_comment', 'publish_reply']),
  intentHash: mediaDigestSchema,
});
export const mediaStatusV4Schema = z.discriminatedUnion('status', [
  mediaStatusV2Schema.options[0].extend({ version: z.literal(4) }),
  mediaStatusV2Schema.options[1].extend({ version: z.literal(4) }),
  mediaStatusV2Schema.options[2].extend({ version: z.literal(4) }),
  mediaStatusV2Schema.options[3].extend({ version: z.literal(4) }),
  mediaStatusV2Schema.options[4].extend({
    version: z.literal(4),
    publication: publicationReferenceSchema.nullable(),
  }),
  mediaStatusV2Schema.options[5].extend({ version: z.literal(4) }),
  mediaStatusV2Schema.options[6].extend({ version: z.literal(4) }),
]);
export type MediaStatusV4 = z.infer<typeof mediaStatusV4Schema>;
export const discussionMediaTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('comment'), postId: id }),
  z.strictObject({
    kind: z.literal('reply'),
    rootCommentId: id,
    targetReplyId: id.nullable(),
  }),
]);
const identityBase = {
  version: z.literal(2),
  batchRequestId: id,
  draftId: id,
  spaceId: id,
};
export const mediaBatchIdentitySchema = z.discriminatedUnion('purpose', [
  z.strictObject({
    ...identityBase,
    purpose: z.literal('community-comment-images'),
    target: discussionMediaTargetSchema.options[0],
  }),
  z.strictObject({
    ...identityBase,
    purpose: z.literal('community-reply-images'),
    target: discussionMediaTargetSchema.options[1],
  }),
]);
export type MediaBatchIdentity = z.infer<typeof mediaBatchIdentitySchema>;
export const mediaMemberPrepareSchema = z.strictObject({
  clientRequestId: id,
  memberId: id,
  sourceSlot: z.number().int().min(0).max(2),
  declaration: z.strictObject({
    mime: mediaMimeSchema,
    bytes: z.number().int().positive().max(MEDIA_MAX_INPUT_BYTES),
    sha256: mediaDigestSchema,
  }),
});
export type MediaMemberPrepare = z.infer<typeof mediaMemberPrepareSchema>;
/** Internal version dispatch only; never accepted by legacy HTTP routes. */
export const prepareMediaV4Schema = z
  .strictObject({
    protocolVersion: z.literal(4),
    clientRequestId: id,
    purpose: z.enum(['community-comment-image', 'community-reply-image']),
    draftId: id,
    spaceId: id,
    slot: z.literal('images'),
    ordinal: z.number().int().min(0).max(2),
    declaration: mediaMemberPrepareSchema.shape.declaration,
    batchId: id,
    batchIdentity: mediaBatchIdentitySchema,
    memberId: id,
  })
  .refine(
    (x) =>
      x.draftId === x.batchIdentity.draftId &&
      x.spaceId === x.batchIdentity.spaceId &&
      x.purpose ===
        (x.batchIdentity.target.kind === 'comment'
          ? 'community-comment-image'
          : 'community-reply-image'),
  );
export type PrepareMediaV4Input = z.infer<typeof prepareMediaV4Schema>;
function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\n`)
    .update(JSON.stringify(value))
    .digest('hex');
}
export function mediaBatchRequestHash(actor: string, raw: unknown): string {
  const i = mediaBatchIdentitySchema.parse(raw);
  return digest('whaleu-media-batch:v2', {
    actorAccountId: id.parse(actor),
    identity: {
      version: 2,
      batchRequestId: i.batchRequestId,
      draftId: i.draftId,
      spaceId: i.spaceId,
      purpose: i.purpose,
      target: i.target,
    },
  });
}
export function mediaMemberRequestHash(
  actor: string,
  identity: unknown,
  raw: unknown,
): string {
  const i = mediaBatchIdentitySchema.parse(identity),
    m = mediaMemberPrepareSchema.parse(raw);
  return digest('whaleu-media-member:v4', {
    version: 4,
    actorAccountId: id.parse(actor),
    batchRequestHash: mediaBatchRequestHash(actor, i),
    clientRequestId: m.clientRequestId,
    memberId: m.memberId,
    sourceSlot: m.sourceSlot,
    declaration: {
      mime: m.declaration.mime,
      bytes: m.declaration.bytes,
      sha256: m.declaration.sha256,
    },
  });
}
const command = { commandId: id, expectedRevision: mediaGenerationSchema };
export const mediaBatchLayoutSchema = z
  .strictObject({
    ...command,
    orderedMemberIds: uniqueIds,
    removeMemberIds: uniqueIds,
  })
  .refine((x) =>
    x.removeMemberIds.every((m) => !x.orderedMemberIds.includes(m)),
  );
export const mediaBatchSealSchema = z.strictObject({
  ...command,
  orderedMemberIds: uniqueIds.min(1),
  publication: publicationReferenceSchema,
});
export const mediaBatchReopenSchema = z.strictObject({
  ...command,
  publication: publicationReferenceSchema,
});
export const mediaBatchCancelSchema = z.strictObject({
  batchRequestHash: mediaDigestSchema,
});
export const mediaBatchRecoverPublicationSchema = z.strictObject({
  publication: publicationReferenceSchema,
  assetIds: uniqueIds.min(1),
  target: discussionMediaTargetSchema,
});
export type PublicationMediaContext = z.infer<
  typeof publicationReferenceSchema
>;
export type MediaBatchCommandKind = 'layout' | 'seal' | 'reopen';
export function mediaBatchCommandHash(
  kind: MediaBatchCommandKind,
  batchId: string,
  raw: unknown,
): string {
  const parsed =
    kind === 'layout'
      ? mediaBatchLayoutSchema.parse(raw)
      : kind === 'seal'
        ? mediaBatchSealSchema.parse(raw)
        : mediaBatchReopenSchema.parse(raw);
  return digest('whaleu-media-batch-command:v2', {
    version: 2,
    batchId: id.parse(batchId),
    kind,
    command: parsed,
  });
}
export const mediaBatchOrderedAssetSchema = z.strictObject({
  memberId: id,
  assetId: id,
  manifestDigest: mediaDigestSchema,
});
export type MediaBatchOrderedAsset = z.infer<
  typeof mediaBatchOrderedAssetSchema
>;
export function mediaAttachmentPlanDigest(
  batchId: string,
  revision: string,
  assets: readonly MediaBatchOrderedAsset[],
): string {
  return digest('whaleu-media-attachment-plan:v2', {
    version: 2,
    batchId: id.parse(batchId),
    revision: mediaGenerationSchema.parse(revision),
    orderedAssets: z
      .array(mediaBatchOrderedAssetSchema)
      .min(1)
      .max(3)
      .parse(assets),
  });
}
export const mediaMemberStatusSchema = z
  .strictObject({
    version: z.literal(4),
    batchId: id,
    memberId: id,
    sourceSlot: z.number().int().min(0).max(2),
    requestId: id,
    requestHash: mediaDigestSchema,
    intentId: id,
    assetId: id.nullable(),
    prepare: mediaMemberPrepareSchema,
    manifestDigest: mediaDigestSchema.nullable(),
    observation: mediaStatusV4Schema,
  })
  .superRefine((m, ctx) => {
    if (
      m.prepare.memberId !== m.memberId ||
      m.prepare.clientRequestId !== m.requestId ||
      m.prepare.sourceSlot !== m.sourceSlot ||
      m.observation.intentId !== m.intentId ||
      m.observation.requestId !== m.requestId ||
      m.observation.requestHash !== m.requestHash ||
      (m.assetId === null) !== (m.manifestDigest === null) ||
      ('assetId' in m.observation && m.observation.assetId !== m.assetId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Member immutable identity mismatch',
      });
  });
export type MediaMemberStatus = z.infer<typeof mediaMemberStatusSchema>;
const base = {
  version: z.literal(4),
  batchRequestId: id,
  batchRequestHash: mediaDigestSchema,
  batchIdentity: mediaBatchIdentitySchema.nullable(),
  resolvedPostId: id.nullable(),
  batchId: id.nullable(),
  revision: mediaGenerationSchema,
  serverNow: instant,
  orderedMemberIds: uniqueIds,
  members: z.array(mediaMemberStatusSchema).max(3),
  retiring: z.array(mediaMemberStatusSchema).max(3),
};
const publication = {
  publication: publicationReferenceSchema,
  attachmentPlanDigest: mediaDigestSchema,
  orderedAssets: z.array(mediaBatchOrderedAssetSchema).min(1).max(3),
};
export const mediaBatchStatusSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...base, status: z.literal('editing') }),
    z.strictObject({ ...base, status: z.literal('preparing') }),
    z.strictObject({
      ...base,
      status: z.literal('ready_unbound'),
      orderedAssets: z.array(mediaBatchOrderedAssetSchema).min(1).max(3),
      draftExpiresAt: instant,
      bindBefore: instant,
    }),
    z.strictObject({
      ...base,
      status: z.literal('publication_pending'),
      ...publication,
    }),
    z.strictObject({
      ...base,
      status: z.literal('bound_history'),
      ...publication,
      parent: z.strictObject({
        ownerKind: z.literal('community'),
        resourceKind: z.enum(['comment', 'reply']),
        resourceId: id,
        contentVersion: z.literal(1),
      }),
      bindings: z
        .array(
          mediaBatchOrderedAssetSchema.extend({
            bindingId: id,
            ordinal: z.number().int().min(0).max(2),
            attachmentState: z.enum(['active', 'detached']),
          }),
        )
        .min(1)
        .max(3),
    }),
    z.strictObject({ ...base, status: z.literal('cancelling') }),
    z.strictObject({
      ...base,
      status: z.literal('terminal'),
      reason: z.literal('cancelled'),
      cleanup: z.enum(['pending', 'retained', 'confirmed']),
    }),
    z.strictObject({
      ...base,
      status: z.literal('unavailable'),
      reason: z.literal('MEDIA_UNAVAILABLE'),
      retryable: z.boolean(),
    }),
  ])
  .superRefine((batch, ctx) => {
    if (
      'publication' in batch &&
      batch.batchIdentity &&
      batch.publication.operation !==
        (batch.batchIdentity.target.kind === 'comment'
          ? 'publish_comment'
          : 'publish_reply')
    )
      ctx.addIssue({ code: 'custom', message: 'Publication target mismatch' });
    if (
      batch.status === 'bound_history' &&
      batch.batchIdentity &&
      batch.parent.resourceKind !== batch.batchIdentity.target.kind
    )
      ctx.addIssue({ code: 'custom', message: 'Bound parent kind mismatch' });
    const ids = batch.members.map((m) => m.memberId),
      retired = batch.retiring.map((m) => m.memberId);
    if (
      (batch.batchIdentity === null) !== (batch.resolvedPostId === null) ||
      (batch.batchIdentity?.target.kind === 'comment' &&
        batch.batchIdentity.target.postId !== batch.resolvedPostId) ||
      (batch.batchIdentity === null) !== (batch.batchId === null) ||
      (batch.batchId === null &&
        (batch.status !== 'terminal' ||
          batch.members.length ||
          batch.retiring.length)) ||
      (batch.batchIdentity &&
        batch.batchIdentity.batchRequestId !== batch.batchRequestId) ||
      JSON.stringify(ids) !== JSON.stringify(batch.orderedMemberIds) ||
      new Set(ids).size !== ids.length ||
      new Set(batch.members.map((m) => m.sourceSlot)).size !== ids.length ||
      new Set(retired).size !== retired.length ||
      retired.some((id) => ids.includes(id)) ||
      [...batch.members, ...batch.retiring].some(
        (m) => m.batchId !== batch.batchId,
      ) ||
      new Set([...batch.members, ...batch.retiring].map((m) => m.requestId))
        .size !==
        batch.members.length + batch.retiring.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Batch complete membership mismatch',
      });
    if (
      'orderedAssets' in batch &&
      (batch.orderedAssets.length !== batch.members.length ||
        new Set(batch.orderedAssets.map((a) => a.assetId)).size !==
          batch.members.length ||
        batch.orderedAssets.some(
          (a, i) =>
            a.memberId !== batch.members[i]?.memberId ||
            a.assetId !== batch.members[i]?.assetId ||
            a.manifestDigest !== batch.members[i]?.manifestDigest,
        ))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Batch ordered asset set mismatch',
      });
    if (
      batch.status === 'ready_unbound' &&
      (batch.retiring.length ||
        batch.members.some((m) => m.observation.status !== 'ready_unbound'))
    )
      ctx.addIssue({ code: 'custom', message: 'Whole set is not ready' });
    if (
      batch.status === 'bound_history' &&
      (batch.bindings.length !== batch.members.length ||
        new Set(batch.bindings.map((b) => b.bindingId)).size !==
          batch.members.length ||
        batch.bindings.some(
          (b, i) =>
            b.ordinal !== i ||
            b.memberId !== batch.members[i]?.memberId ||
            b.assetId !== batch.members[i]?.assetId ||
            b.manifestDigest !== batch.members[i]?.manifestDigest ||
            batch.members[i]?.observation.status !== 'bound_history',
        ))
    )
      ctx.addIssue({ code: 'custom', message: 'Incomplete binding history' });
  });
export type MediaBatchStatus = z.infer<typeof mediaBatchStatusSchema>;
export const mediaBatchRecoverySchema = z.discriminatedUnion('state', [
  z.strictObject({
    version: z.literal(4),
    state: z.literal('not_recorded'),
    batchRequestId: id,
    serverNow: instant,
  }),
  z.strictObject({
    version: z.literal(4),
    state: z.literal('recorded'),
    status: mediaBatchStatusSchema,
  }),
]);
export type MediaBatchRecovery = z.infer<typeof mediaBatchRecoverySchema>;
export const mediaBatchPublicationRecoverySchema = z.discriminatedUnion(
  'state',
  [
    z.strictObject({
      version: z.literal(4),
      state: z.literal('unknown'),
      serverNow: instant,
    }),
    z.strictObject({
      version: z.literal(4),
      state: z.literal('recorded'),
      status: mediaBatchStatusSchema,
    }),
  ],
);
export type MediaBatchPublicationRecovery = z.infer<
  typeof mediaBatchPublicationRecoverySchema
>;
export const mediaBatchPublicationReceiptSchema = z.discriminatedUnion(
  'outcome',
  [
    z.strictObject({
      requestId: id,
      operation: z.enum(['publish_comment', 'publish_reply']),
      outcome: z.literal('created'),
      resourceId: id,
      createdAt: z.string().datetime(),
    }),
    z.strictObject({
      requestId: id,
      operation: z.enum(['publish_comment', 'publish_reply']),
      outcome: z.literal('rejected'),
      code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
    }),
  ],
);
export type MediaBatchPublicationReceipt = z.infer<
  typeof mediaBatchPublicationReceiptSchema
>;
export const mediaBatchFencePublicationSchema =
  mediaBatchRecoverPublicationSchema;
export const mediaBatchPublicationCancellationSchema = z.union([
  mediaBatchPublicationReceiptSchema,
  z.strictObject({
    outcome: z.literal('cancelled'),
    requestId: id,
    operation: z.enum(['publish_comment', 'publish_reply']),
    intentHash: mediaDigestSchema,
  }),
]);
export type MediaBatchPublicationCancellation = z.infer<
  typeof mediaBatchPublicationCancellationSchema
>;
export const mediaBatchFencePublicationResultSchema = z.strictObject({
  version: z.literal(4),
  status: mediaBatchStatusSchema,
  cancellation: mediaBatchPublicationCancellationSchema,
});
export type MediaBatchFencePublicationResult = z.infer<
  typeof mediaBatchFencePublicationResultSchema
>;

export const mediaCancelV4Schema = z.discriminatedUnion('result', [
  z.strictObject({
    version: z.literal(4),
    result: z.literal('cancelled'),
    status: mediaStatusV4Schema.options[5].extend({
      reason: z.literal('cancelled'),
    }),
  }),
  z.strictObject({
    version: z.literal(4),
    result: z.literal('already_terminal'),
    status: mediaStatusV4Schema.options[5],
  }),
  z.strictObject({
    version: z.literal(4),
    result: z.literal('bound_history'),
    status: mediaStatusV4Schema.options[4],
  }),
]);
export type MediaCancelV4 = z.infer<typeof mediaCancelV4Schema>;
