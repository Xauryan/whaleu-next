import { createHash } from 'node:crypto';
import { z } from 'zod';
import { textSchema } from '../text.js';
import { canonicalJson } from './contracts.js';
const id = z.uuid().refine((value) => value === value.toLowerCase());
const mode = z.enum(['named', 'anonymous']);
export const dmTextEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  purpose: z.literal('send_private_message'),
  accountId: id,
  clientRequestId: z.uuidv4().refine((value) => value === value.toLowerCase()),
  conversationId: id,
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  senderSlot: z.union([z.literal(0), z.literal(1)]),
  participantModes: z.tuple([mode, mode]),
  text: textSchema(500).refine(
    (value) =>
      value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 2000,
  ),
  assetIds: z.tuple([]),
});
/** PM3 is a distinct exact-content version. The text-v1 shape and digest stay unchanged. */
export const dmImageEnvelopeSchema = dmTextEnvelopeSchema
  .omit({ version: true, text: true, assetIds: true })
  .extend({
    version: z.literal(2),
    kind: z.literal('image'),
    image: z.strictObject({
      assetId: id,
      manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  });
export const dmContentEnvelopeSchema = z.discriminatedUnion('version', [
  dmTextEnvelopeSchema,
  dmImageEnvelopeSchema,
]);
export type DmContentEnvelope = z.infer<typeof dmContentEnvelopeSchema>;
export interface AcceptedDmApproval {
  readonly decisionId: string;
  readonly digest: string;
  readonly version: 1 | 2;
  readonly envelope: DmContentEnvelope;
}
export interface DmMessageDescriptor {
  messageId: string;
  conversationId: string;
  senderSlot: 0 | 1;
  sequence: string;
  envelope: DmContentEnvelope;
}
export function canonicalDmEnvelope<T extends DmContentEnvelope>(value: T): T;
export function canonicalDmEnvelope(value: unknown): DmContentEnvelope;
export function canonicalDmEnvelope(value: unknown): DmContentEnvelope {
  const envelope = dmContentEnvelopeSchema.parse(value);
  Object.freeze(envelope.participantModes);
  if (envelope.version === 1) Object.freeze(envelope.assetIds);
  else Object.freeze(envelope.image);
  return Object.freeze(envelope);
}
export function dmApprovalDigest(value: DmContentEnvelope): string {
  return createHash('sha256')
    .update(
      `whaleu-dm-content-approval:v${value.version}\n${canonicalJson(canonicalDmEnvelope(value))}`,
    )
    .digest('hex');
}
/** A trusted adapter may issue exact decisions outside Messaging commit locks.
 * The digest/account/request triple is its idempotency identity. Issuance and
 * revocation must append owner ledger evidence; no adapter is installed here. */
export interface DmReviewIssuerPort {
  evaluate(
    input: Readonly<{ envelope: DmContentEnvelope; digest: string }>,
  ): Promise<
    | { state: 'issued'; decisionId: string }
    | { state: 'pending' | 'rejected' | 'unavailable' | 'failed' }
  >;
  revoke(
    decisionId: string,
  ): Promise<{ state: 'revoked' | 'unavailable' | 'failed' }>;
}
