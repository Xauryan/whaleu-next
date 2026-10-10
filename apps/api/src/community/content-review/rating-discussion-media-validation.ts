import type { Decision } from '../community-policy.js';
import { validateApprovalMetadata } from './approval-metadata.js';
import { canonicalEqual } from './contracts.js';
import type { RatingApprovalRow } from './rating-approval-validation.js';
import type { RatingScopedContentBinding } from './rating-scoped-approval-validation.js';
import { scopedId } from '../../ratings/scoped/contracts.js';
import {
  canonicalRatingDiscussionMediaEnvelope,
  ratingDiscussionMediaApprovalDigest,
  type RatingDiscussionMediaEnvelope,
  type AcceptedRatingDiscussionMediaApproval,
} from './rating-discussion-media-contracts.js';
export interface RatingDiscussionMediaBinding extends RatingScopedContentBinding {
  attachment_set_digest: string;
}
export function ratingDiscussionMediaBindingMatches(
  binding: RatingDiscussionMediaBinding,
  kind: 'comment' | 'reply',
  subjectId: string,
  raw: RatingDiscussionMediaEnvelope,
): boolean {
  try {
    const envelope = canonicalRatingDiscussionMediaEnvelope(raw);
    return (
      scopedId.safeParse(binding.decision_id).success &&
      binding.account_id === envelope.accountId &&
      binding.operation === envelope.purpose &&
      binding.envelope_version === 7 &&
      binding.digest === ratingDiscussionMediaApprovalDigest(envelope) &&
      canonicalEqual(binding.envelope, envelope) &&
      binding.kind === kind &&
      binding.subject_id === subjectId &&
      envelope.subjectId === subjectId &&
      binding.subject_revision === envelope.subjectRevision &&
      binding.content_version === 1 &&
      binding.attachment_set_digest === envelope.attachmentSetDigest &&
      canonicalEqual(binding.scope, envelope.scope) &&
      envelope.purpose ===
        (kind === 'comment'
          ? 'publish_rating_comment_media_scoped'
          : 'publish_rating_reply_media_scoped')
    );
  } catch {
    return false;
  }
}
/** One exact Review over text, persona mode, the real ancestors, opaque quote
 * CAS at publication and every ordered manifest. Per-image approvals alone can
 * never be decoded as this decision. */
export function validateRatingDiscussionMediaApprovalRow(
  row: RatingApprovalRow | null,
  consume: boolean,
  now: number,
): {
  decision: Decision<AcceptedRatingDiscussionMediaApproval>;
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
    row.result === 'failed'
  )
    return unavailable;
  try {
    const envelope = canonicalRatingDiscussionMediaEnvelope(row.envelope);
    if (
      row.envelope_version !== 7 ||
      row.operation !== envelope.purpose ||
      row.account_id !== envelope.accountId ||
      row.digest !== ratingDiscussionMediaApprovalDigest(envelope)
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
                version: 7,
                envelope,
              }),
            }
          : metadata.decision,
    };
  } catch {
    return unavailable;
  }
}
