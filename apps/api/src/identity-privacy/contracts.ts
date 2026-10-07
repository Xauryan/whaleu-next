import { z } from 'zod';
import type { PoolClient } from 'pg';
import { IDENTITY_BATCH_LIMIT } from '../authorization/contracts.js';

export const contentIdentityTargetSchema = z.strictObject({
  kind: z.enum(['post', 'comment']),
  id: z.uuid(),
});
export type ContentIdentityTarget = z.infer<typeof contentIdentityTargetSchema>;
export const identityBatchSchema = z.strictObject({
  targets: z
    .array(contentIdentityTargetSchema)
    .min(1)
    .max(IDENTITY_BATCH_LIMIT)
    .refine(
      (targets) =>
        new Set(
          targets.map((target) => `${target.kind}:${target.id.toLowerCase()}`),
        ).size === targets.length,
    ),
});
export type IdentityBatch = z.infer<typeof identityBatchSchema>;

/** These facts remain private even for named publications. They never extend a community DTO. */
export interface PrivateIdentity {
  readonly accountId: string;
  readonly nickname: string | null;
  /** Real profile/media integration is not implemented; never use an anonymous persona avatar. */
  readonly avatar: null;
  readonly studentNumber: string | null;
  readonly studentNumberStatus: 'verified' | 'unverified' | 'unavailable';
}
export type IdentityBatchItem =
  | {
      readonly target: ContentIdentityTarget;
      readonly status: 'available';
      readonly authorMode: 'named' | 'anonymous';
      readonly identity: PrivateIdentity;
    }
  | { readonly target: ContentIdentityTarget; readonly status: 'unavailable' };
export interface IdentityBatchView {
  readonly items: IdentityBatchItem[];
}

export type VerifiedStudentIdentity =
  | {
      readonly status: 'verified';
      readonly studentNumber: string;
      readonly validUntil: number | null;
    }
  | { readonly status: 'unverified' | 'unavailable' };
/** Internal snapshot: deadlines never extend public/private identity HTTP DTOs. */
export interface PrivateIdentitySnapshot {
  readonly identity: PrivateIdentity;
  readonly validUntil: number | null;
}
export function identityAt(
  snapshot: PrivateIdentitySnapshot,
  now: number,
): PrivateIdentity {
  if (
    snapshot.identity.studentNumberStatus === 'verified' &&
    snapshot.validUntil !== null &&
    snapshot.validUntil <= now
  ) {
    return {
      ...snapshot.identity,
      studentNumber: null,
      studentNumberStatus: 'unverified',
    };
  }
  return snapshot.identity;
}

export interface StudentIdentitySource {
  /** Must resolve the passed account through an authoritative, current verification record.
   * No UID transformations, profile fields, user request bodies or campus selection as proof.
   * Generic legacy verified status is not a student number. Manual image approval
   * may have none, and legacy xuehao can contain an EMAIL from email verification.
   * A real adapter must qualify record provenance before emitting a number.
   * A verified result MUST include a finite epoch-millisecond validUntil, or null
   * only for an explicit accepted non-expiring policy. Hold the authority lock
   * until this transaction completes; consumers retain this immutable snapshot.
   * Use local transaction-bound records; do not place remote provider calls inside this lock.
   */
  resolve(
    accountId: string,
    transaction: PoolClient,
  ): Promise<VerifiedStudentIdentity>;
}
export const STUDENT_IDENTITY_SOURCE = Symbol('STUDENT_IDENTITY_SOURCE');
export class UnavailableStudentIdentitySource implements StudentIdentitySource {
  async resolve(): Promise<VerifiedStudentIdentity> {
    return { status: 'unavailable' };
  }
}
