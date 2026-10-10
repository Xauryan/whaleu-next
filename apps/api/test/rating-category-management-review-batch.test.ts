import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingScopedContentReviewFacade } from '../src/community/content-review/rating-scoped-content-review.facade.js';
import {
  canonicalRatingScopedCategorySource,
  ratingScopedApprovalDigest,
} from '../src/community/content-review/rating-scoped-contracts.js';
import type {
  AcceptedRatingScopedApproval,
  RatingScopedCategorySourceDescriptor,
} from '../src/community/content-review/rating-scoped-contracts.js';
const id = (n: number) =>
  `98000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function source(
  override = false,
  accountId = id(1),
): RatingScopedCategorySourceDescriptor {
  const sourceId = id(override ? 3 : 2),
    sourceRevision = id(override ? 5 : 4),
    categoryId = id(6);
  return canonicalRatingScopedCategorySource({
    sourceId,
    sourceRevision,
    categoryId,
    envelope: {
      version: 5,
      purpose: override
        ? 'publish_rating_category_override_scoped'
        : 'publish_rating_category_base_scoped',
      accountId,
      sourceId,
      sourceRevision,
      categoryId,
      identityId: id(7),
      issuanceId: sourceId,
      issuanceDigest: 'b'.repeat(64),
      placement: { kind: 'campuses', campusIds: [id(8)] },
      assetIds: [],
      ...(override
        ? {
            baseSourceId: id(2),
            baseSourceRevision: id(4),
            scope: { kind: 'campus', campusId: id(8) },
            body: { name: 'Exact campus body', description: '' },
          }
        : {
            body: {
              parentId: null,
              level: 1,
              kind: 'general',
              systemKey: null,
              name: 'Base body',
              description: '',
            },
          }),
    },
  });
}
function fixture() {
  const review = new RatingScopedContentReviewFacade();
  const consumed: string[] = [],
    bound: string[] = [];
  review.accepted = async (envelope) => {
    if (
      envelope.purpose !== 'publish_rating_category_base_scoped' &&
      envelope.purpose !== 'publish_rating_category_override_scoped'
    )
      assert.fail();
    consumed.push(envelope.sourceId);
    return Object.freeze({
      decisionId: envelope.sourceId,
      version: 5,
      digest: ratingScopedApprovalDigest(envelope),
      envelope,
    });
  };
  review.bind = async (accepted, descriptor) => {
    if (descriptor.kind !== 'category') assert.fail();
    assert.deepEqual(accepted.envelope, descriptor.source.envelope);
    bound.push(descriptor.source.sourceId);
  };
  return { review, consumed, bound, tx: {} as PoolClient };
}
test('category batch reuses unchanged exact v5 base and override descriptors', async () => {
  const f = fixture(),
    sources = [source(), source(true)];
  const digests = sources.map((entry) =>
    ratingScopedApprovalDigest(entry.envelope),
  );
  const accepted = await f.review.acceptedCategorySources(sources, f.tx);
  assert.deepEqual(
    accepted.map((entry) => entry.digest),
    digests,
  );
  assert(Object.isFrozen(accepted));
  await f.review.bindCategorySources(accepted, sources, f.tx);
  assert.deepEqual(
    f.consumed,
    sources.map((entry) => entry.sourceId),
  );
  assert.deepEqual(
    f.bound,
    sources.map((entry) => entry.sourceId),
  );
});
test('duplicate sources, mixed actors and oversized vectors fail before any consume', async () => {
  for (const sources of [
    [source(), source()],
    [source(), source(true, id(99))],
    Array.from({ length: 129 }, () => source()),
  ]) {
    const f = fixture();
    await assert.rejects(() => f.review.acceptedCategorySources(sources, f.tx));
    assert.deepEqual(f.consumed, []);
  }
});
test('entire category binding vector is validated before any binding mutation', async () => {
  for (const failure of [
    'swapped',
    'digest',
    'duplicate',
    'missing',
    'version',
  ] as const) {
    const f = fixture(),
      sources = [source(), source(true)];
    const accepted = [
      ...(await f.review.acceptedCategorySources(sources, f.tx)),
    ];
    if (failure === 'swapped') accepted.reverse();
    if (failure === 'digest')
      accepted[1] = { ...accepted[1]!, digest: 'c'.repeat(64) };
    if (failure === 'duplicate')
      accepted[1] = { ...accepted[1]!, decisionId: accepted[0]!.decisionId };
    if (failure === 'missing') accepted.pop();
    if (failure === 'version')
      accepted[1] = {
        ...accepted[1]!,
        version: 4,
      } as unknown as AcceptedRatingScopedApproval;
    await assert.rejects(() =>
      f.review.bindCategorySources(accepted, sources, f.tx),
    );
    assert.deepEqual(f.bound, []);
  }
});
test('metadata-only empty Review batch does not synthesize an approval or provider call', async () => {
  const f = fixture();
  assert.deepEqual(await f.review.acceptedCategorySources([], f.tx), []);
  await f.review.bindCategorySources([], [], f.tx);
  assert.deepEqual(f.consumed, []);
  assert.deepEqual(f.bound, []);
});
