import { z } from 'zod';
import type { Decision } from '../community-policy.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import type { ApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
import {
  canonicalErrandEnvelope,
  errandApprovalDigest,
} from './errand-contracts.js';
import type {
  AcceptedErrandApproval,
  ErrandContentEnvelope,
} from './errand-contracts.js';

export interface ErrandApprovalRow extends ApprovalMetadata {
  id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
}
export interface ErrandApprovalBinding {
  order_id: string;
  content_version: number;
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
  scope: unknown;
}

export function validateErrandApprovalRow(
  row: ErrandApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedErrandApproval>;
  optionalUntil: number | null;
} {
  const unavailable = {
    decision: { kind: 'unavailable' as const },
    optionalUntil: null,
  };
  if (
    !row ||
    !z.uuid().safeParse(row.id).success ||
    !z.uuid().safeParse(row.policy_revision_id).success ||
    row.result === 'pending' ||
    row.result === 'failed'
  )
    return unavailable;
  let envelope: ErrandContentEnvelope;
  try {
    envelope = canonicalErrandEnvelope(row.envelope);
    if (
      !canonicalEqual(envelope, row.envelope) ||
      row.envelope_version !== 1 ||
      row.account_id !== envelope.accountId ||
      row.operation !== envelope.purpose ||
      row.digest !== errandApprovalDigest(envelope)
    )
      return unavailable;
  } catch {
    return unavailable;
  }
  const result = validateApprovalMetadata(
    row,
    consume,
    now,
    'CONTENT_REJECTED',
  );
  return {
    optionalUntil: result.optionalUntil,
    decision:
      result.decision.kind === 'allow'
        ? {
            kind: 'allow',
            value: Object.freeze({
              decisionId: row.id,
              digest: row.digest,
              version: 1,
              envelope,
            }),
          }
        : result.decision,
  };
}

/** Always validate the complete immutable row definition as well as the binding.
 * Even authoritative denial is not evidence that a mismatching definition exists. */
export function errandBindingMatches(
  binding: ErrandApprovalBinding,
  orderId: string,
  envelope: ErrandContentEnvelope,
): boolean {
  try {
    const canonical = canonicalErrandEnvelope(envelope);
    return (
      canonicalEqual(envelope, canonical) &&
      z.uuid().safeParse(orderId).success &&
      z.uuid().safeParse(binding.decision_id).success &&
      binding.order_id === orderId &&
      binding.content_version === 1 &&
      binding.envelope_version === 1 &&
      binding.operation === 'publish_errand' &&
      binding.account_id === canonical.accountId &&
      binding.digest === errandApprovalDigest(canonical) &&
      canonicalEqual(binding.envelope, canonical) &&
      canonicalEqual(binding.scope, canonical.scope)
    );
  } catch {
    return false;
  }
}
