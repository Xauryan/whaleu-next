import { z } from 'zod';
import type { Decision } from '../community-policy.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import type { ApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
  ratingOperation,
} from './rating-contracts.js';
import type {
  AcceptedRatingApproval,
  RatingContentEnvelope,
  RatingContentKind,
} from './rating-contracts.js';
import { canonicalRatingTargetDefinition } from './rating-target-definition-contracts.js';
import type { RatingTargetDefinitionDescriptor } from './rating-target-definition-contracts.js';

export interface RatingApprovalRow extends ApprovalMetadata {
  id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
}
export interface RatingApprovalBinding {
  kind: RatingContentKind;
  subject_id: string;
  content_version: number;
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
  scope: unknown;
}

export interface RatingTargetDefinitionBinding {
  target_id: string;
  content_version: number;
  definition_revision: string;
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
  scope: unknown;
}

/** A wrong-version authoritative denial is still not evidence for this exact
 * immutable target definition. Never weaken the legacy v1 binding matcher. */
export function ratingTargetDefinitionBindingMatches(
  binding: RatingTargetDefinitionBinding,
  descriptor: RatingTargetDefinitionDescriptor,
): boolean {
  try {
    const definition = canonicalRatingTargetDefinition(descriptor);
    const envelope = definition.envelope;
    return (
      envelope.purpose === 'edit_rating_target' &&
      z.uuid().safeParse(binding.decision_id).success &&
      binding.target_id === definition.targetId &&
      binding.content_version === definition.contentVersion &&
      binding.definition_revision === definition.definitionRevision &&
      binding.account_id === envelope.accountId &&
      binding.operation === 'edit_rating_target' &&
      binding.envelope_version === 3 &&
      binding.digest === ratingApprovalDigest(envelope) &&
      canonicalEqual(binding.envelope, envelope) &&
      canonicalEqual(binding.scope, envelope.scope)
    );
  } catch {
    return false;
  }
}

export function validateRatingApprovalRow(
  row: RatingApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedRatingApproval>;
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
  let envelope: RatingContentEnvelope;
  try {
    envelope = canonicalRatingEnvelope(row.envelope);
    if (
      !canonicalEqual(envelope, row.envelope) ||
      row.envelope_version !== envelope.version ||
      row.account_id !== envelope.accountId ||
      row.operation !== envelope.purpose ||
      row.digest !== ratingApprovalDigest(envelope)
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
              version: envelope.version,
              envelope,
            }),
          }
        : result.decision,
  };
}

/** Always validate the complete immutable row definition as well as the binding.
 * Even authoritative denial is not evidence that a mismatching definition exists. */
export function ratingBindingMatches(
  binding: RatingApprovalBinding,
  kind: RatingContentKind,
  subjectId: string,
  envelope: RatingContentEnvelope,
): boolean {
  try {
    const canonical = canonicalRatingEnvelope(envelope);
    return (
      canonicalEqual(envelope, canonical) &&
      z.uuid().safeParse(subjectId).success &&
      z.uuid().safeParse(binding.decision_id).success &&
      binding.subject_id === subjectId &&
      binding.content_version === 1 &&
      binding.envelope_version === canonical.version &&
      binding.kind === kind &&
      binding.operation === ratingOperation(kind) &&
      canonical.purpose === ratingOperation(kind) &&
      (kind !== 'target' || canonical.targetId === subjectId) &&
      (canonical.purpose !== 'publish_rating_reply' ||
        canonical.replyTo?.replyId !== subjectId) &&
      binding.account_id === canonical.accountId &&
      binding.digest === ratingApprovalDigest(canonical) &&
      canonicalEqual(binding.envelope, canonical) &&
      canonicalEqual(binding.scope, canonical.scope)
    );
  } catch {
    return false;
  }
}
