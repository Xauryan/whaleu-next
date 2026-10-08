import type { ApplicationErrorCode } from '../../http/application-error.js';
import type { Decision } from '../community-policy.js';

/** Shared review policy, provenance and time authority; content shapes stay with
 * their discriminated owners. Consumption expiry never becomes ongoing expiry. */
export interface ApprovalMetadata {
  policy_revision_id: string;
  result: 'allow' | 'reject' | 'pending' | 'failed';
  coverage: string;
  provenance: string;
  issuer: string;
  provenance_ref: string;
  evaluated_at: Date;
  consume_until: Date;
  visibility_model: string;
  visibility_until: Date | null;
  policy_key: string;
  policy_version: number;
  policy_coverage: string;
  policy_provenance: string;
  policy_issuer: string;
  policy_provenance_ref: string;
  policy_valid_from: Date;
  policy_valid_until: Date | null;
  state: 'allow' | 'held' | 'revoked';
  event_at: Date;
  event_coverage: string;
  event_provenance: string;
  event_issuer: string;
  event_provenance_ref: string;
}
const timestamp = (value: unknown): number =>
  value instanceof Date ? value.getTime() : NaN;
const present = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

export function validateApprovalMetadata(
  row: ApprovalMetadata,
  consume: boolean,
  now: number,
  currentDeniedReason: ApplicationErrorCode = 'POST_NOT_FOUND',
): { decision: Decision; optionalUntil: number | null } {
  let optionalUntil: number | null = null;
  const retain = (until: number | null) => {
    if (until !== null)
      optionalUntil = Math.min(optionalUntil ?? Infinity, until);
  };
  const evaluate = (): Decision => {
    if (
      row.policy_key !== 'local-explicit-v1' ||
      row.policy_version !== 1 ||
      row.coverage !== 'complete' ||
      row.policy_coverage !== 'complete' ||
      row.event_coverage !== 'complete' ||
      row.provenance !== 'accepted' ||
      row.policy_provenance !== 'accepted' ||
      row.event_provenance !== 'accepted' ||
      !present(row.issuer) ||
      !present(row.provenance_ref) ||
      !present(row.policy_issuer) ||
      !present(row.policy_provenance_ref) ||
      !present(row.event_issuer) ||
      !present(row.event_provenance_ref) ||
      !['allow', 'reject', 'pending', 'failed'].includes(row.result) ||
      !['allow', 'held', 'revoked'].includes(row.state)
    )
      return { kind: 'unavailable' };
    const evaluated = timestamp(row.evaluated_at);
    const policyFrom = timestamp(row.policy_valid_from);
    const policyUntil =
      row.policy_valid_until === null
        ? null
        : timestamp(row.policy_valid_until);
    const eventAt = timestamp(row.event_at);
    const consumeUntil = timestamp(row.consume_until);
    const visibilityUntil =
      row.visibility_until === null ? null : timestamp(row.visibility_until);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(evaluated) ||
      !Number.isFinite(eventAt) ||
      !Number.isFinite(policyFrom) ||
      evaluated > now ||
      eventAt > now ||
      eventAt < evaluated ||
      policyFrom > evaluated ||
      (policyUntil !== null &&
        (!Number.isFinite(policyUntil) || policyUntil <= now)) ||
      !Number.isFinite(consumeUntil) ||
      consumeUntil <= evaluated ||
      (row.visibility_model !== 'durable' &&
        row.visibility_model !== 'until') ||
      (row.visibility_model === 'durable'
        ? visibilityUntil !== null
        : visibilityUntil === null || !Number.isFinite(visibilityUntil)) ||
      (visibilityUntil !== null && visibilityUntil <= now)
    )
      return { kind: 'unavailable' };
    retain(policyUntil);
    retain(visibilityUntil);
    if (row.result === 'reject' || row.state === 'revoked')
      return {
        kind: 'deny',
        reason: consume ? 'CONTENT_REJECTED' : currentDeniedReason,
      };
    if (row.state === 'held')
      return consume
        ? { kind: 'unavailable' }
        : { kind: 'deny', reason: currentDeniedReason };
    if (row.result !== 'allow' || row.state !== 'allow')
      return { kind: 'unavailable' };
    if (consume) {
      if (consumeUntil <= now) return { kind: 'unavailable' };
      retain(consumeUntil);
    }
    return { kind: 'allow', value: undefined };
  };
  const decision = evaluate();
  return { decision, optionalUntil };
}
