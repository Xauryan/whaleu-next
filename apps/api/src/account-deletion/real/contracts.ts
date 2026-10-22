import { z } from 'zod';

export const REAL_DELETION_PROTOCOL = 'real-account-deletion-v1' as const;
export const REAL_DELETION_CONSENT =
  'explicit-real-account-deletion-v1' as const;
export const PREPARATION_TTL_SECONDS = 15 * 60;
export const REAUTHENTICATION_TTL_SECONDS = 30;
export const COOLING_SECONDS = 604800;
export const TERMINAL_RECEIPT_SECONDS = 2592000;
export const MAX_ACCOUNT_PREPARATIONS = 4;

const uuid = z.uuid().transform((value) => value.toLowerCase());
const generation = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) < 9223372036854775807n);
/** The caller creates and persists this secret before prepare. No server response
 * is its only recoverable copy. Canonical decoding is checked before hashing. */
export const recoverySecretSchema = z
  .string()
  .regex(/^wu_dr_[A-Za-z0-9_-]{43}$/)
  .refine((value) => {
    const encoded = value.slice(6);
    const bytes = Buffer.from(encoded, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === encoded;
  })
  .meta({
    writeOnly: true,
    description:
      'Private purpose-specific32-byte canonical base64url capability; body only, never retained raw or returned.',
  });
export const preparationIntentSchema = z.strictObject({
  version: z.literal(1),
  intentId: uuid,
  expectedGeneration: generation,
  consent: z.literal(REAL_DELETION_CONSENT),
});
export const prepareDeletionSchema = preparationIntentSchema.extend({
  recoverySecret: recoverySecretSchema,
});
export const deletionStatusSchema = z.strictObject({
  intentId: uuid,
  recoverySecret: recoverySecretSchema,
});
export const acceptDeletionSchema = prepareDeletionSchema.extend({
  code: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const cancelDeletionSchema = deletionStatusSchema.extend({
  commandId: uuid,
  expectedRevision: generation,
  action: z.literal('explicitly-cancel-real-account-deletion-v1'),
});
export type PreparationIntent = z.infer<typeof preparationIntentSchema>;
export type PrepareDeletion = z.infer<typeof prepareDeletionSchema>;
export type AcceptDeletion = z.infer<typeof acceptDeletionSchema>;
export type CancelDeletion = z.infer<typeof cancelDeletionSchema>;
export type DeletionStatusCommand = z.infer<typeof deletionStatusSchema>;
export type RealDeletionPhase =
  'prepared' | 'cooling' | 'irreversible' | 'cancelled' | 'completed';
/** Capability responses never expose account/session/provider identity or a list
 * of requests. Expiry values are display data, never authorization decisions. */
export interface RealDeletionReceipt {
  readonly protocol: typeof REAL_DELETION_PROTOCOL;
  readonly intentId: string;
  readonly phase: RealDeletionPhase;
  readonly revision: string;
  readonly preparedAt: string;
  readonly preparationExpiresAt: string;
  readonly acceptedAt: string | null;
  readonly cancelBefore: string | null;
  readonly completedAt: string | null;
}
export class RealDeletionProtocolError extends Error {
  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'SCOPE_UNAVAILABLE'
      | 'INTENT_CONFLICT'
      | 'CANCELLATION_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'RealDeletionProtocolError';
  }
}
