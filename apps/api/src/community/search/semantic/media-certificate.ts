import { z } from 'zod';
import type { ContentKind } from '../../content-review/contracts.js';
import type { MediaContentFact } from '../../../media/content-snapshot.facade.js';

const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const semanticMediaAttachmentSchema = z.strictObject({
  slot: z.literal('images'),
  bindingId: uuid,
  assetId: uuid,
  manifestDigest: digest,
  policyRevision: z.string().min(1).max(200),
  intentId: uuid,
  intentState: z.literal('ready'),
  headRevision: revision,
  eventId: uuid,
  ordinal: z.number().int().min(0).max(8),
});
/** A review denial short-circuits Media. Null means deliberately unconsulted,
 * never an assertion that the ancestor has no attachments. Empty [] is exact. */
export const semanticMediaNodeSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    kind: z.enum(['post', 'comment', 'reply']),
    id: uuid,
    decision: z.enum(['allow', 'deny']),
    validUntil: z.number().finite().nullable(),
    attachments: z.array(semanticMediaAttachmentSchema).max(9),
  }),
  z.strictObject({
    kind: z.enum(['post', 'comment', 'reply']),
    id: uuid,
    decision: z.literal('review-denied'),
    validUntil: z.null(),
    attachments: z.null(),
  }),
]);
export const semanticMediaChainSchema = z
  .array(semanticMediaNodeSchema)
  .min(1)
  .max(3)
  .superRefine((nodes, ctx) => {
    for (const [index, node] of nodes.entries()) {
      if (
        node.kind !== ['post', 'comment', 'reply'][index] ||
        (node.kind !== 'post' && node.attachments?.length) ||
        (node.decision !== 'allow' && index !== nodes.length - 1)
      )
        ctx.addIssue({ code: 'custom', message: 'Invalid Media ancestry' });
      if (
        node.attachments &&
        (node.attachments.some(
          (attachment, ordinal) => attachment.ordinal !== ordinal,
        ) ||
          new Set(node.attachments.map((attachment) => attachment.assetId))
            .size !== node.attachments.length ||
          new Set(node.attachments.map((attachment) => attachment.bindingId))
            .size !== node.attachments.length)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid complete ordered Media set',
        });
      if (node.decision === 'deny' && !node.attachments.length)
        ctx.addIssue({ code: 'custom', message: 'Missing denied attachment' });
    }
  });
export type SemanticMediaNode = z.infer<typeof semanticMediaNodeSchema>;
export type SemanticMediaChain = z.infer<typeof semanticMediaChainSchema>;
export function semanticMediaNode(
  kind: ContentKind,
  id: string,
  fact: MediaContentFact,
): SemanticMediaNode | null {
  if (
    fact.version !== 1 ||
    fact.parent.ownerKind !== 'community' ||
    fact.parent.resourceKind !== kind ||
    fact.parent.resourceId !== id ||
    fact.parent.contentVersion !== 1 ||
    fact.decision === 'unknown'
  )
    return null;
  const result = semanticMediaNodeSchema.safeParse({
    kind,
    id,
    decision: fact.decision,
    validUntil: fact.validUntil,
    attachments: fact.attachments,
  });
  return result.success ? result.data : null;
}
