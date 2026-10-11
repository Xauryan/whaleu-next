import type { Decision } from '../community-policy.js';
import { scopedId } from '../../ratings/scoped/contracts.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import { canonicalEqual } from './contracts.js';
import {
  canonicalRatingCategoryIconDefinition,
  canonicalRatingCategoryIconEnvelope,
  ratingCategoryIconApprovalDigest,
  type AcceptedRatingCategoryIconApproval,
  type RatingCategoryIconDefinitionDescriptor,
} from './rating-category-icon-contracts.js';

export interface RatingCategoryIconReviewBinding {
  id: string;
  definition_id: string;
  definition_digest: string;
  decision_id: string;
  account_id: string;
  request_id: string;
  approval_digest: string;
  envelope: unknown;
}

/** Exact immutable composite definition, not a current catalog authorization.
 * The Category owner separately checks current release, coverage and Media. */
export function ratingCategoryIconBindingMatches(
  binding: RatingCategoryIconReviewBinding,
  raw: RatingCategoryIconDefinitionDescriptor,
): boolean {
  try {
    const definition = canonicalRatingCategoryIconDefinition(raw);
    const envelope = definition.envelope;
    return (
      scopedId.safeParse(binding.id).success &&
      scopedId.safeParse(binding.decision_id).success &&
      binding.definition_id === definition.definitionId &&
      binding.definition_digest === definition.definitionDigest &&
      binding.account_id === envelope.accountId &&
      binding.request_id === envelope.clientRequestId &&
      binding.approval_digest === ratingCategoryIconApprovalDigest(envelope) &&
      canonicalEqual(binding.envelope, envelope)
    );
  } catch {
    return false;
  }
}

/** A v5 text-source approval and an image-only approval cannot establish this
 * composite. Held/revoked evidence is unavailable; an exact reject denies the
 * indivisible definition, including its body, even when the icon is absent. */
export function validateRatingCategoryIconApprovalRow(
  row: RatingApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedRatingCategoryIconApproval>;
  optionalUntil: number | null;
} {
  const unavailable = {
    decision: { kind: 'unavailable' as const },
    optionalUntil: null,
  };
  if (
    !row ||
    !scopedId.safeParse(row.id).success ||
    !scopedId.safeParse(row.policy_revision_id).success ||
    row.result === 'pending' ||
    row.result === 'failed' ||
    (consume &&
      (!(row.consume_until instanceof Date) ||
        row.consume_until.getTime() <= now))
  )
    return unavailable;
  try {
    const envelope = canonicalRatingCategoryIconEnvelope(row.envelope);
    if (
      row.envelope_version !== 8 ||
      row.account_id !== envelope.accountId ||
      row.operation !== envelope.purpose ||
      row.digest !== ratingCategoryIconApprovalDigest(envelope)
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
        row.state === 'held' || row.state === 'revoked'
          ? { kind: 'unavailable' }
          : result.decision.kind === 'allow'
            ? {
                kind: 'allow',
                value: Object.freeze({
                  version: 8,
                  decisionId: row.id,
                  digest: row.digest,
                  envelope,
                }),
              }
            : result.decision,
    };
  } catch {
    return unavailable;
  }
}
