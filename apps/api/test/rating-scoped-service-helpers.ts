import { createHash } from 'node:crypto';
import { canonicalRatingTargetDefinition } from '../src/community/content-review/rating-target-definition-contracts.js';
import type { CurrentTargetRow } from '../src/ratings/repository.js';
import type {
  RatingScopedContext,
  RatingNavigationSelector,
} from '../src/ratings/scoped/contracts.js';
export const scopedTestId = (value: number) =>
  `95000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const scopedTestToken = 't'.repeat(43);
export const scopedTestTime = '2026-10-09T20:00:00.000Z';
export function scopedTestContext(
  selector: RatingNavigationSelector = {
    kind: 'campus',
    campusId: scopedTestId(2),
  },
): RatingScopedContext {
  return {
    protocolVersion: 2,
    id: scopedTestId(1),
    token: scopedTestToken,
    tokenDigest: createHash('sha256').update(scopedTestToken).digest('hex'),
    actorId: scopedTestId(3),
    sessionGeneration: 'a'.repeat(64),
    selector,
    purpose: 'read',
    mode: 'public',
    scopeRevision: 'b'.repeat(64),
    protocolGeneration: scopedTestId(4),
    heads: [
      {
        scopeKey:
          selector.kind === 'global' ? 'global' : `campus:${selector.campusId}`,
        catalogRevision: scopedTestId(5),
        headRevision: scopedTestId(6),
      },
    ],
    sourceDigest: 'c'.repeat(64),
    identityCampusId: null,
    issuedAt: scopedTestTime,
    expiresAt: '2026-10-09T20:05:00.000Z',
    capabilities: ['navigation_v2', 'shared_recovery_v9'],
  };
}
export function scopedTestTarget(
  id = scopedTestId(10),
  regionId: string | null = null,
): CurrentTargetRow {
  const revision = scopedTestId(11);
  const definition = canonicalRatingTargetDefinition({
    targetId: id,
    contentVersion: 1,
    definitionRevision: revision,
    appliedTargetRevision: revision,
    envelope: {
      version: 1,
      accountId: scopedTestId(3),
      purpose: 'publish_rating_target',
      clientRequestId: scopedTestId(12),
      targetId: id,
      targetRevision: revision,
      categoryId: scopedTestId(13),
      categoryRevision: scopedTestId(14),
      catalogRevision: scopedTestId(5),
      scope: { regionId },
      assetIds: [],
      name: 'Synthetic scoped target',
      description: '',
    },
  });
  return {
    id,
    category_id: scopedTestId(13),
    creator_id: scopedTestId(3),
    region_id: regionId,
    active: true,
    revision,
    name: definition.envelope.name,
    description: '',
    envelope: definition.envelope,
    definition,
  };
}
export const scopedTestSummary = {
  status: 'known' as const,
  count: 1,
  sum: 5,
  average: 5,
  distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 },
  revision: scopedTestId(15),
};
