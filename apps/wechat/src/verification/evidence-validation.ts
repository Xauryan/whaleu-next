import { ClientError } from '../api/errors';
import { isUuid } from '../profile/contract';
export function invalidVerificationEvidence(): never {
  throw new ClientError('protocol', 'Invalid verification evidence response');
}
export function verificationEvidenceUuid(value: unknown): string {
  if (!isUuid(value)) invalidVerificationEvidence();
  return value;
}
export function verificationEvidenceRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    invalidVerificationEvidence();
  return value;
}
