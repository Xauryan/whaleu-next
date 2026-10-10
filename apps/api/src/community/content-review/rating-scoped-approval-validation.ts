import { z } from 'zod';
import type { Decision } from '../community-policy.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import {
  canonicalRatingScopedEnvelope,
  canonicalRatingScopedTargetDefinition,
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
} from './rating-scoped-contracts.js';
import type {
  AcceptedRatingScopedApproval,
  RatingScopedContentEnvelope,
  RatingScopedTargetDefinitionDescriptor,
  RatingScopedCategorySourceDescriptor,
} from './rating-scoped-contracts.js';

const id = z.uuid().refine((value) => value === value.toLowerCase());
interface Binding {
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
}
export interface RatingScopedContentBinding extends Binding {
  kind: 'comment' | 'reply';
  subject_id: string;
  subject_revision: string;
  content_version: number;
  scope: unknown;
}
export interface RatingScopedTargetDefinitionBinding extends Binding {
  target_id: string;
  content_version: number;
  definition_revision: string;
  applied_target_revision: string;
  scope: unknown;
}
export interface RatingScopedCategorySourceBinding extends Binding {
  source_id: string;
  source_revision: string;
  category_id: string;
  issuance_id: string;
  issuance_digest: string;
}
function exact(binding: Binding, input: unknown): boolean {
  const envelope = canonicalRatingScopedEnvelope(input);
  return (
    id.safeParse(binding.decision_id).success &&
    binding.account_id === envelope.accountId &&
    binding.operation === envelope.purpose &&
    binding.envelope_version === 5 &&
    binding.digest === ratingScopedApprovalDigest(envelope) &&
    canonicalEqual(binding.envelope, envelope)
  );
}
export function ratingScopedContentBindingMatches(
  binding: RatingScopedContentBinding,
  kind: 'comment' | 'reply',
  subjectId: string,
  input: RatingScopedContentEnvelope,
): boolean {
  try {
    const envelope = canonicalRatingScopedEnvelope(input);
    const purpose =
      kind === 'comment'
        ? 'publish_rating_comment_scoped'
        : 'publish_rating_reply_scoped';
    return (
      (envelope.purpose === 'publish_rating_comment_scoped' ||
        envelope.purpose === 'publish_rating_reply_scoped') &&
      envelope.purpose === purpose &&
      binding.kind === kind &&
      binding.subject_id === subjectId &&
      envelope.subjectId === subjectId &&
      binding.subject_revision === envelope.subjectRevision &&
      binding.content_version === 1 &&
      canonicalEqual(binding.scope, envelope.scope) &&
      exact(binding, envelope)
    );
  } catch {
    return false;
  }
}
export function ratingScopedTargetDefinitionBindingMatches(
  binding: RatingScopedTargetDefinitionBinding,
  input: RatingScopedTargetDefinitionDescriptor,
): boolean {
  try {
    const descriptor = canonicalRatingScopedTargetDefinition(input);
    return (
      binding.target_id === descriptor.targetId &&
      binding.content_version === descriptor.contentVersion &&
      binding.definition_revision === descriptor.definitionRevision &&
      binding.applied_target_revision === descriptor.appliedTargetRevision &&
      canonicalEqual(binding.scope, descriptor.envelope.scope) &&
      exact(binding, descriptor.envelope)
    );
  } catch {
    return false;
  }
}
export function ratingScopedCategorySourceBindingMatches(
  binding: RatingScopedCategorySourceBinding,
  input: RatingScopedCategorySourceDescriptor,
): boolean {
  try {
    const descriptor = canonicalRatingScopedCategorySource(input);
    return (
      binding.source_id === descriptor.sourceId &&
      binding.source_revision === descriptor.sourceRevision &&
      binding.category_id === descriptor.categoryId &&
      binding.issuance_id === descriptor.envelope.issuanceId &&
      binding.issuance_digest === descriptor.envelope.issuanceDigest &&
      exact(binding, descriptor.envelope)
    );
  } catch {
    return false;
  }
}
export function validateRatingScopedApprovalRow(
  row: RatingApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedRatingScopedApproval>;
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
    const envelope = canonicalRatingScopedEnvelope(row.envelope);
    if (
      row.envelope_version !== 5 ||
      row.operation !== envelope.purpose ||
      row.account_id !== envelope.accountId ||
      row.digest !== ratingScopedApprovalDigest(envelope)
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
                version: 5,
                envelope,
              }),
            }
          : result.decision,
    };
  } catch {
    return unavailable;
  }
}
