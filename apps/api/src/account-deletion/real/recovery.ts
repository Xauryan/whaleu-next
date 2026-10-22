import { createHash, timingSafeEqual } from 'node:crypto';
import {
  REAL_DELETION_PROTOCOL,
  preparationIntentSchema,
  recoverySecretSchema,
  type PreparationIntent,
  type CancelDeletion,
  RealDeletionProtocolError,
} from './contracts.js';

function digest(domain: string, fields: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([REAL_DELETION_PROTOCOL, domain, ...fields]), 'utf8')
    .digest('hex');
}
export function preparationIntentHash(input: PreparationIntent): string {
  const intent = preparationIntentSchema.parse(input);
  return digest('preparation-intent', [
    String(intent.version),
    intent.intentId,
    intent.expectedGeneration,
    intent.consent,
  ]);
}
/** This is a hash of a high-entropy private capability, not a provider identifier.
 * Its binding is derived exclusively from the current authenticated DB account. */
export function preparationRecoveryHash(
  accountId: string,
  input: PreparationIntent,
  secret: string,
): string {
  const intent = preparationIntentSchema.parse(input);
  const checked = recoverySecretSchema.safeParse(secret);
  if (
    !checked.success ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(accountId)
  )
    throw new RealDeletionProtocolError('SCOPE_UNAVAILABLE');
  return digest('prepared-status-and-accepted-cooling-cancel', [
    accountId,
    intent.intentId,
    intent.expectedGeneration,
    String(BigInt(intent.expectedGeneration) + 1n),
    preparationIntentHash(intent),
    checked.data,
  ]);
}
export function equalRecoveryHash(
  expected: unknown,
  presented: string,
): boolean {
  return (
    typeof expected === 'string' &&
    /^[a-f0-9]{64}$/.test(expected) &&
    /^[a-f0-9]{64}$/.test(presented) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(presented, 'hex'))
  );
}
export function cancellationIntentHash(input: CancelDeletion): string {
  // The recovery secret is intentionally absent from all command intent material.
  return digest('explicit-cancellation-command', [
    input.intentId,
    input.commandId,
    input.expectedRevision,
    input.action,
  ]);
}
