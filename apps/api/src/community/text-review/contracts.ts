import { z } from 'zod';
import type { PublicationOperation } from '../contracts.js';
import { canonicalEnvelope } from '../content-review/contracts.js';
import type { EffectiveContentEnvelope } from '../content-review/contracts.js';

export const textReviewStatusSchema = z.strictObject({
  requestId: z.uuidv4(),
  operation: z.enum(['publish_post', 'publish_comment', 'publish_reply']),
  status: z.enum([
    'pending',
    'approved',
    'rejected',
    'unavailable',
    'settled',
    'cancelled',
  ]),
});
export const textReviewCancellationSchema = z.strictObject({
  operation: z.enum(['publish_post', 'publish_comment', 'publish_reply']),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TextReviewCancellation = z.infer<
  typeof textReviewCancellationSchema
>;
export type TextReviewStatus = z.infer<typeof textReviewStatusSchema>;

/** Internal control flow only. No HTTP parser accepts this object or envelope. */
export class TextReviewSubmission extends Error {
  readonly envelope: EffectiveContentEnvelope;
  constructor(envelope: EffectiveContentEnvelope) {
    super('Text review submission');
    this.envelope = canonicalEnvelope(envelope);
  }
}
export interface TextReviewRequest {
  account_id: string;
  client_request_id: string;
  operation: PublicationOperation;
  intent_hash: string;
  digest: string;
  envelope: EffectiveContentEnvelope;
  decision_id: string | null;
  expires_at: Date;
}
