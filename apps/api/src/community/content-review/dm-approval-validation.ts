import { z } from 'zod';
import type { Decision } from '../community-policy.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import type { ApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
import { canonicalDmEnvelope, dmApprovalDigest } from './dm-contracts.js';
import type {
  AcceptedDmApproval,
  DmContentEnvelope,
  DmMessageDescriptor,
} from './dm-contracts.js';
export interface DmApprovalRow extends ApprovalMetadata {
  id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
  issuer_trusted: boolean;
  issuer_valid_until: Date | null;
}
export interface DmApprovalBinding {
  message_id: string;
  conversation_id: string;
  sender_slot: number;
  message_seq: string;
  content_version: number;
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
}
export function validateDmApprovalRow(
  row: DmApprovalRow | null,
  consume: boolean,
  now: number,
): { decision: Decision<AcceptedDmApproval>; optionalUntil: number | null } {
  const unavailable = {
    decision: { kind: 'unavailable' as const },
    optionalUntil: null,
  };
  if (
    !row ||
    !z.uuid().safeParse(row.id).success ||
    !z.uuid().safeParse(row.policy_revision_id).success ||
    row.issuer_trusted !== true
  )
    return unavailable;
  let envelope: DmContentEnvelope;
  try {
    envelope = canonicalDmEnvelope(row.envelope);
    if (
      !canonicalEqual(envelope, row.envelope) ||
      row.envelope_version !== 1 ||
      row.account_id !== envelope.accountId ||
      row.operation !== envelope.purpose ||
      row.digest !== dmApprovalDigest(envelope)
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
  const until = row.issuer_valid_until?.getTime() ?? null;
  if (until !== null && (!Number.isFinite(until) || until <= now))
    return unavailable;
  return {
    optionalUntil:
      until === null
        ? result.optionalUntil
        : Math.min(result.optionalUntil ?? Infinity, until),
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
export function dmBindingMatches(
  binding: DmApprovalBinding,
  descriptor: DmMessageDescriptor,
): boolean {
  try {
    const envelope = canonicalDmEnvelope(descriptor.envelope);
    return (
      z.uuid().safeParse(descriptor.messageId).success &&
      z.uuid().safeParse(binding.decision_id).success &&
      /^[1-9][0-9]{0,18}$/.test(descriptor.sequence) &&
      BigInt(descriptor.sequence) <= 9223372036854775807n &&
      binding.message_id === descriptor.messageId &&
      binding.conversation_id === descriptor.conversationId &&
      envelope.conversationId === descriptor.conversationId &&
      binding.sender_slot === descriptor.senderSlot &&
      envelope.senderSlot === descriptor.senderSlot &&
      binding.message_seq === descriptor.sequence &&
      binding.content_version === 1 &&
      binding.envelope_version === 1 &&
      binding.account_id === envelope.accountId &&
      binding.operation === envelope.purpose &&
      binding.digest === dmApprovalDigest(envelope) &&
      canonicalEqual(envelope, descriptor.envelope) &&
      canonicalEqual(binding.envelope, envelope)
    );
  } catch {
    return false;
  }
}
