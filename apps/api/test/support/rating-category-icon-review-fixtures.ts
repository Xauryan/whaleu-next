import {
  canonicalRatingCategoryIconEnvelope,
  canonicalRatingCategoryIconDefinition,
  ratingCategoryIconApprovalDigest,
  type RatingCategoryIconEnvelope,
} from '../../src/community/content-review/rating-category-icon-contracts.js';
import {
  categoryIconContentDigest,
  type CategoryIconContent,
} from '../../src/ratings/category-management/icon-extension.js';
import type { RatingApprovalRow } from '../../src/community/content-review/rating-approval-validation.js';
import type { RatingCategoryIconReviewBinding } from '../../src/community/content-review/rating-category-icon-validation.js';

export const review8Id = (n: number) =>
  `88000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const review8Now = Date.UTC(2026, 9, 10);
export function review8Envelope(
  options: { image?: boolean; override?: boolean; textOverride?: boolean } = {},
): RatingCategoryIconEnvelope {
  const { image = false, override = false, textOverride = false } = options;
  const origin = override
    ? { kind: 'override' as const, campusId: review8Id(20) }
    : { kind: 'base' as const };
  const content: CategoryIconContent = {
    categoryId: review8Id(3),
    identityId: review8Id(4),
    parentId: null,
    level: 1,
    kind: 'general',
    systemKey: null,
    name: 'Exact reviewed category',
    description: '',
    selector: override
      ? { kind: 'campus', campusId: review8Id(20) }
      : { kind: 'global' },
    baseSource: { id: review8Id(5), revision: review8Id(6) },
    overrideSource: textOverride
      ? { id: review8Id(21), revision: review8Id(22) }
      : null,
    baseDefinitionId: review8Id(7),
    overrideDefinitionId: override ? review8Id(23) : null,
    icon: image
      ? {
          kind: 'image',
          origin: origin.kind,
          definitionId: override ? review8Id(23) : review8Id(7),
          appearance: {
            appearanceId: review8Id(8),
            assetId: review8Id(9),
            manifestDigest: 'b'.repeat(64),
            actorId: review8Id(1),
            categoryId: review8Id(3),
            identityId: review8Id(4),
            origin,
          },
        }
      : {
          kind: 'absent',
          origin: origin.kind,
          definitionId: override ? review8Id(23) : review8Id(7),
          evidenceId: review8Id(10),
          evidenceDigest: 'c'.repeat(64),
        },
  };
  return canonicalRatingCategoryIconEnvelope({
    version: 8,
    purpose: 'publish_rating_category_icon',
    accountId: review8Id(1),
    clientRequestId: review8Id(2),
    operation: override
      ? 'set_category_override_scoped'
      : 'edit_category_base_scoped',
    intentHash: 'a'.repeat(64),
    textHash: 'd'.repeat(64),
    textPlanDigest: 'e'.repeat(64),
    mediaPlanDigest: 'f'.repeat(64),
    beforeSnapshot: '1'.repeat(64),
    context: {
      id: review8Id(11),
      digest: '2'.repeat(64),
      protocolGeneration: review8Id(12),
      topologySnapshotId: override ? review8Id(13) : null,
      sourceDigest: '3'.repeat(64),
    },
    definitionId: review8Id(14),
    definitionDigest: categoryIconContentDigest(content),
    content,
    assetIds: image ? [review8Id(9)] : [],
  });
}
export function review8Definition(envelope = review8Envelope()) {
  return canonicalRatingCategoryIconDefinition({
    definitionId: envelope.definitionId,
    definitionDigest: envelope.definitionDigest,
    envelope,
  });
}
/** Synthetic-only metadata. This helper never connects to a DB or provider. */
export function review8ApprovalRow(
  envelope = review8Envelope(),
): RatingApprovalRow {
  return {
    id: review8Id(80),
    account_id: envelope.accountId,
    operation: envelope.purpose,
    envelope_version: 8,
    digest: ratingCategoryIconApprovalDigest(envelope),
    envelope,
    policy_revision_id: review8Id(81),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-only',
    provenance_ref: 'unit-test',
    evaluated_at: new Date(review8Now - 1000),
    consume_until: new Date(review8Now + 1000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic-only',
    policy_provenance_ref: 'unit-test',
    policy_valid_from: new Date(review8Now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(review8Now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic-only',
    event_provenance_ref: 'unit-test',
  };
}
export function review8Binding(
  envelope = review8Envelope(),
): RatingCategoryIconReviewBinding {
  return {
    id: review8Id(90),
    definition_id: envelope.definitionId,
    definition_digest: envelope.definitionDigest,
    decision_id: review8Id(80),
    account_id: envelope.accountId,
    request_id: envelope.clientRequestId,
    approval_digest: ratingCategoryIconApprovalDigest(envelope),
    envelope,
  };
}
