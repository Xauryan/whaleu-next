import { ClientError, isRecord } from '../api/errors';

export const factStatuses = [
  'verified',
  'unverified',
  'unavailable',
  'expired',
  'revoked',
] as const;
export const applicationStatuses = [
  'none',
  'pending',
  'rejected',
  'unavailable',
] as const;
export type FactStatus = (typeof factStatuses)[number];
export type ApplicationStatus = (typeof applicationStatuses)[number];
export interface VerificationSummary {
  readonly affiliation: { readonly status: FactStatus };
  readonly studentNumber: { readonly status: FactStatus };
  readonly phone: { readonly status: FactStatus };
  readonly application: { readonly status: ApplicationStatus };
}
function invalid(): never {
  throw new ClientError('protocol', 'Invalid verification summary');
}
function exact(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid();
}
function status<T extends string>(
  value: unknown,
  allowed: readonly T[],
): { readonly status: T } {
  exact(value, ['status']);
  if (typeof value.status !== 'string' || !allowed.includes(value.status as T))
    invalid();
  return Object.freeze({ status: value.status as T });
}
/** Status-only own-account contract: extra private values are rejected, never projected away. */
export function decodeVerificationSummary(value: unknown): VerificationSummary {
  exact(value, ['affiliation', 'studentNumber', 'phone', 'application']);
  return Object.freeze({
    affiliation: status(value.affiliation, factStatuses),
    studentNumber: status(value.studentNumber, factStatuses),
    phone: status(value.phone, factStatuses),
    application: status(value.application, applicationStatuses),
  });
}
