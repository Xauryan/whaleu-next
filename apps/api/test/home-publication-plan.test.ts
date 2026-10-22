import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishPostSchema } from '../src/community/contracts.js';
import {
  admissionDefinitionDigest,
  HOME_POLICY_SOURCE,
  homeAdmissionDefinitionSchema,
} from '../src/community/home-feed-policy/admission-contract.js';
import { planHomePublication } from '../src/community/home-feed-policy/publication-plan.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const space = {
  id: id(1),
  kind: 'regional' as const,
  name: 'Synthetic campus',
  isActive: true,
  operatingRegionId: id(2),
};
const definition = homeAdmissionDefinitionSchema.parse({
  version: 1,
  sourceCommit: HOME_POLICY_SOURCE,
  categoryMappings: [
    { nativeCategory: 'discussion', sourceKind: 'regional', legacyChoose: 2 },
    { nativeCategory: 'water', sourceKind: 'regional', legacyChoose: 9 },
  ],
  scopeMappings: [
    {
      sourceSpaceId: id(1),
      sourceKind: 'regional',
      sourceRegionId: id(2),
      targetWaterSpaceId: id(1),
      targetRegionId: id(2),
    },
  ],
  authorModes: ['named', 'anonymous'],
  exemptions: { audit: 'none', attachments: 'normalized_server_facts' },
  surfaces: { home: true, hot: 'exclude_water', following: 'excluded' },
  markdownReferences: false,
});
const admission = {
  definition,
  ref: {
    id: id(3),
    revision: 1,
    digest: admissionDefinitionDigest(definition),
    sourceCommit: HOME_POLICY_SOURCE,
    validUntil: '2030-01-01T00:00:00.000Z',
  },
};
const now = new Date('2026-10-22T00:00:00Z');
function body(overrides: Record<string, unknown> = {}) {
  return publishPostSchema.parse({
    clientRequestId: id(4),
    spaceId: id(1),
    category: 'discussion',
    text: 'abc',
    imageAssetIds: [],
    authorMode: 'named',
    commentsPolicy: 'open',
    ...overrides,
  });
}
test('short content changes only planned destination/category and retains exact original request', () => {
  const input = body({ syncToRelatedCampuses: true });
  const before = JSON.stringify(input);
  const p = planHomePublication(input, space, id(2), admission, now);
  assert.equal(p.lane, 'home');
  if (p.lane !== 'home') throw Error('lane');
  assert.equal(p.category, 'water');
  assert.equal(p.suppressDistribution, true);
  assert.equal(p.evidence.requestedIntent.category, 'discussion');
  assert.equal(p.evidence.requestedIntent.syncToRelatedCampuses, true);
  assert.equal(JSON.stringify(input), before);
});
test('unrestricted related publication retains the existing owner and no suppression', () =>
  assert.deepEqual(
    planHomePublication(
      body({ text: 'ordinary longer body', syncToRelatedCampuses: true }),
      space,
      id(2),
      admission,
      now,
    ),
    {
      lane: 'existing',
      reason: 'unrestricted_related',
      suppressDistribution: false,
    },
  ));
test('actual accessory facts preserve the original specialized lane', () =>
  assert.equal(
    planHomePublication(
      body({ imageAssetIds: [id(7)] }),
      space,
      id(2),
      admission,
      now,
    ).lane,
    'existing',
  ));
test('expired admission, wrong scope and unknown mapping fail closed', () => {
  assert.throws(() =>
    planHomePublication(
      body(),
      space,
      id(2),
      admission,
      new Date('2030-01-01'),
    ),
  );
  assert.throws(() =>
    planHomePublication(body(), { ...space, id: id(8) }, id(2), admission, now),
  );
  assert.throws(() =>
    planHomePublication(
      body({ category: 'pets' }),
      space,
      id(2),
      admission,
      now,
    ),
  );
});
test('Markdown short raw source is not exempt; long fenced reference is not reference-only', () => {
  const short = planHomePublication(
    body({ text: '# a', textSource: { version: 1, format: 'markdown' } }),
    space,
    id(2),
    admission,
    now,
  );
  assert.equal(short.lane, 'home');
  if (short.lane !== 'home') throw Error('lane');
  assert.equal(short.evidence.result, 'short_text');
  const code = planHomePublication(
    body({
      text: '`#10000000`',
      textSource: { version: 1, format: 'markdown' },
    }),
    space,
    id(2),
    admission,
    now,
  );
  assert.equal(code.lane, 'home');
  if (code.lane !== 'home') throw Error('lane');
  assert.equal(code.evidence.result, null);
});
