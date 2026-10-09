import { z } from 'zod';
import type { Decision } from '../community-policy.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import {
  canonicalRatingCategoryBase,
  canonicalRatingCategoryEnvelope,
  ratingCategoryApprovalDigest,
} from './rating-category-contracts.js';
import type {
  AcceptedRatingCategoryApproval,
  RatingCategoryBaseDescriptor,
} from './rating-category-contracts.js';
export interface RatingCategoryBaseBinding {
  category_id: string;
  base_revision: string;
  release_id: string;
  decision_id: string;
  account_id: string;
  operation: string;
  envelope_version: number;
  digest: string;
  envelope: unknown;
  scope: unknown;
}
export function ratingCategoryBaseBindingMatches(
  binding: RatingCategoryBaseBinding,
  input: RatingCategoryBaseDescriptor,
): boolean {
  try {
    const descriptor = canonicalRatingCategoryBase(input),
      envelope = descriptor.envelope;
    return (
      z.uuid().safeParse(binding.decision_id).success &&
      binding.category_id === descriptor.categoryId &&
      binding.base_revision === descriptor.baseRevision &&
      binding.release_id === envelope.releaseId &&
      binding.account_id === envelope.accountId &&
      binding.operation === envelope.purpose &&
      binding.envelope_version === 4 &&
      binding.digest === ratingCategoryApprovalDigest(envelope) &&
      canonicalEqual(binding.envelope, envelope) &&
      canonicalEqual(binding.scope, envelope.scope)
    );
  } catch {
    return false;
  }
}
export function validateRatingCategoryApprovalRow(
  row: RatingApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedRatingCategoryApproval>;
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
  try {
    const envelope = canonicalRatingCategoryEnvelope(row.envelope);
    if (
      row.envelope_version !== 4 ||
      row.operation !== envelope.purpose ||
      row.account_id !== envelope.accountId ||
      row.digest !== ratingCategoryApprovalDigest(envelope)
    )
      return unavailable;
    const metadata = validateApprovalMetadata(
      row,
      consume,
      now,
      'RATING_NOT_FOUND',
    );
    return {
      optionalUntil: metadata.optionalUntil,
      decision:
        metadata.decision.kind === 'allow'
          ? {
              kind: 'allow',
              value: Object.freeze({
                decisionId: row.id,
                digest: row.digest,
                version: 4,
                envelope,
              }),
            }
          : metadata.decision,
    };
  } catch {
    return unavailable;
  }
}
