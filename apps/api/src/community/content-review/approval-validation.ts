import { validateApprovalMetadata } from './approval-metadata.js';
import type { ApprovalMetadata } from './approval-metadata.js';
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

export interface ApprovalRow extends ApprovalMetadata {
  id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
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
  if (!row) return { decision: { kind: 'unavailable' }, optionalUntil: null };
  let envelope: EffectiveContentEnvelope;
  try {
    envelope = canonicalEnvelope(row.envelope);
    if (
      !canonicalEqual(row.envelope, envelope) ||
      row.digest !== approvalDigest(envelope)
    )
      return { decision: { kind: 'unavailable' }, optionalUntil: null };
  } catch {
    return { decision: { kind: 'unavailable' }, optionalUntil: null };
  }
  if (
    row.envelope_version !== 1 ||
    row.account_id !== envelope.accountId ||
    row.operation !== envelope.purpose
  )
    return { decision: { kind: 'unavailable' }, optionalUntil: null };
  const result = validateApprovalMetadata(row, consume, now);
  return {
    optionalUntil: result.optionalUntil,
    decision:
      result.decision.kind === 'allow'
        ? {
            kind: 'allow',
            value: {
              decisionId: row.id,
              digest: row.digest,
              version: 1,
              envelope,
            },
          }
        : result.decision,
  };
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
