import type { Decision } from '../community-policy.js';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalEqual,
  operationForKind,
} from './contracts.js';
import type {
  AcceptedApproval,
  ContentKind,
  ContentScopeSnapshot,
  EffectiveContentEnvelope,
} from './contracts.js';

export interface ApprovalRow {
  id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
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
export interface ApprovalBinding {
  content_kind: ContentKind;
  content_id: string;
  content_version: number;
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: EffectiveContentEnvelope;
  scope: ContentScopeSnapshot;
}
/** Shared canonical evaluation; callers explicitly choose locked deadline registration
 * or conditional snapshot facts. Consumption expiry is not ongoing expiry. */
export function validateApprovalRow(
  row: ApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedApproval>;
  optionalUntil: number | null;
} {
  let optionalUntil: number | null = null;
  const retain = (until: number | null) => {
    if (until !== null)
      optionalUntil = Math.min(optionalUntil ?? Infinity, until);
  };
  const evaluate = (): Decision<AcceptedApproval> => {
    if (!row) return { kind: 'unavailable' };
    let envelope: EffectiveContentEnvelope;
    try {
      envelope = canonicalEnvelope(row.envelope);
      if (
        !canonicalEqual(row.envelope, envelope) ||
        row.digest !== approvalDigest(envelope)
      )
        return { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
    if (
      row.envelope_version !== 1 ||
      row.account_id !== envelope.accountId ||
      row.operation !== envelope.purpose ||
      row.policy_key !== 'local-explicit-v1' ||
      row.policy_version !== 1 ||
      row.coverage !== 'complete' ||
      row.policy_coverage !== 'complete' ||
      row.event_coverage !== 'complete' ||
      row.provenance !== 'accepted' ||
      row.policy_provenance !== 'accepted' ||
      row.event_provenance !== 'accepted' ||
      !row.issuer?.trim() ||
      !row.provenance_ref?.trim() ||
      !row.policy_issuer?.trim() ||
      !row.policy_provenance_ref?.trim() ||
      !row.event_issuer?.trim() ||
      !row.event_provenance_ref?.trim()
    )
      return { kind: 'unavailable' };
    const evaluated = row.evaluated_at?.getTime();
    const policyFrom = row.policy_valid_from?.getTime();
    const policyUntil =
      row.policy_valid_until === null
        ? null
        : row.policy_valid_until?.getTime();
    const eventAt = row.event_at?.getTime();
    const consumeUntil = row.consume_until?.getTime();
    const visibilityUntil =
      row.visibility_until === null ? null : row.visibility_until?.getTime();
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(evaluated) ||
      !Number.isFinite(eventAt) ||
      !Number.isFinite(policyFrom) ||
      evaluated > now! ||
      eventAt > now! ||
      eventAt < evaluated ||
      policyFrom > evaluated ||
      (policyUntil !== null &&
        (!Number.isFinite(policyUntil) || policyUntil <= now!)) ||
      !Number.isFinite(consumeUntil) ||
      consumeUntil <= evaluated ||
      (row.visibility_model !== 'durable' &&
        row.visibility_model !== 'until') ||
      (row.visibility_model === 'durable'
        ? visibilityUntil !== null
        : visibilityUntil === null || !Number.isFinite(visibilityUntil)) ||
      (visibilityUntil !== null && visibilityUntil <= now!)
    )
      return { kind: 'unavailable' };
    retain(policyUntil);
    retain(visibilityUntil);
    if (row.result === 'reject' || row.state === 'revoked')
      return {
        kind: 'deny',
        reason: consume ? 'CONTENT_REJECTED' : 'POST_NOT_FOUND',
      };
    if (row.state === 'held')
      return consume
        ? { kind: 'unavailable' }
        : { kind: 'deny', reason: 'POST_NOT_FOUND' };
    if (row.result !== 'allow' || row.state !== 'allow')
      return { kind: 'unavailable' };
    if (consume) {
      if (consumeUntil <= now!) return { kind: 'unavailable' };
      retain(consumeUntil);
    }
    return {
      kind: 'allow',
      value: { decisionId: row.id, digest: row.digest, version: 1, envelope },
    };
  };
  const decision = evaluate();
  return { decision, optionalUntil };
}

export function validateApprovalBinding(
  binding: ApprovalBinding,
  result: Decision<AcceptedApproval>,
): Decision<AcceptedApproval> {
  // An authoritative denied review short-circuits binding-envelope comparison.
  if (result.kind !== 'allow') return result;
  const accepted = result.value;
  try {
    if (
      binding.content_version !== 1 ||
      binding.envelope_version !== 1 ||
      binding.operation !== operationForKind(binding.content_kind) ||
      binding.account_id !== accepted.envelope.accountId ||
      binding.operation !== accepted.envelope.purpose ||
      binding.digest !== accepted.digest ||
      !canonicalEqual(binding.envelope, accepted.envelope) ||
      !canonicalEqual(binding.scope, accepted.envelope.scope)
    )
      return { kind: 'unavailable' };
    return result;
  } catch {
    return { kind: 'unavailable' };
  }
}
