import { z } from 'zod';
import type { Decision } from '../community-policy.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import type { RatingScopedTargetDefinitionBinding } from './rating-scoped-approval-validation.js';
import {
  canonicalRatingTargetCoverDefinition,
  canonicalRatingTargetCoverEnvelope,
  ratingTargetCoverApprovalDigest,
  type AcceptedRatingTargetCoverApproval,
  type RatingTargetCoverDefinitionDescriptor,
} from './rating-target-cover-contracts.js';
const id = z.uuid().refine((v) => v === v.toLowerCase());
export function ratingTargetCoverBindingMatches(
  binding: RatingScopedTargetDefinitionBinding,
  input: RatingTargetCoverDefinitionDescriptor,
): boolean {
  try {
    const d = canonicalRatingTargetCoverDefinition(input),
      e = d.envelope;
    return (
      id.safeParse(binding.decision_id).success &&
      binding.account_id === e.accountId &&
      binding.operation === e.purpose &&
      binding.envelope_version === 6 &&
      binding.digest === ratingTargetCoverApprovalDigest(e) &&
      canonicalEqual(binding.envelope, e) &&
      binding.target_id === d.targetId &&
      binding.content_version === d.contentVersion &&
      binding.definition_revision === d.definitionRevision &&
      binding.applied_target_revision === d.appliedTargetRevision &&
      canonicalEqual(binding.scope, e.scope)
    );
  } catch {
    return false;
  }
}
export function validateRatingTargetCoverApprovalRow(
  row: RatingApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedRatingTargetCoverApproval>;
  optionalUntil: number | null;
} {
  const unavailable = {
    decision: { kind: 'unavailable' as const },
    optionalUntil: null,
  };
  if (
    !row ||
    !id.safeParse(row.id).success ||
    !id.safeParse(row.policy_revision_id).success ||
    row.result === 'pending' ||
    row.result === 'failed'
  )
    return unavailable;
  try {
    const envelope = canonicalRatingTargetCoverEnvelope(row.envelope);
    if (
      row.envelope_version !== 6 ||
      row.operation !== envelope.purpose ||
      row.account_id !== envelope.accountId ||
      row.digest !== ratingTargetCoverApprovalDigest(envelope)
    )
      return unavailable;
    const result = validateApprovalMetadata(
      row,
      consume,
      now,
      'RATING_NOT_FOUND',
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
                version: 6,
                envelope,
              }),
            }
          : result.decision,
    };
  } catch {
    return unavailable;
  }
}
