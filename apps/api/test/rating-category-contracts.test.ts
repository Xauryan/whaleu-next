import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';
import {
  prepareRatingCategoriesSchema,
  commitRatingCategoriesSchema,
  ratingCategoryManagementContextSchema,
  ratingCategoryPreparationSchema,
  ratingCategoryReceiptSchema,
} from '../src/ratings/category-management/contracts.js';
import { ratingCategoryIntentHash } from '../src/ratings/category-management/requests.js';
const intent = () => ({
  clientRequestId: randomUUID(),
  regionId: null,
  expectedCatalogRevision: null,
  expectedScopeRevision: 'a'.repeat(43),
  parentId: null,
  expectedParentRevision: null,
  nodes: [
    { key: 'root', parentKey: null, name: 'Reviewed tree', description: '' },
  ],
  assetIds: [],
});
test('category creation strict canonical tree intent and original hash domain', () => {
  const base = prepareRatingCategoriesSchema.parse(intent());
  assert.equal(
    ratingCategoryIntentHash(base),
    ratingCategoryIntentHash({ ...base }),
  );
  assert.match(ratingCategoryIntentHash(base), /^[0-9a-f]{64}$/);
  assert.notEqual(
    ratingCategoryIntentHash(base),
    ratingCategoryIntentHash({
      ...base,
      nodes: [{ ...base.nodes[0]!, description: 'changed' }],
    }),
  );
  assert.equal(
    prepareRatingCategoriesSchema.parse({
      ...base,
      nodes: [{ ...base.nodes[0]!, name: '  Clean\r\nname  ' }],
    }).nodes[0]!.name,
    'Clean\nname',
  );
  const tree = prepareRatingCategoriesSchema.parse({
    ...base,
    nodes: [
      base.nodes[0]!,
      { key: 'child', parentKey: 'root', name: 'Child', description: '' },
      { key: 'leaf', parentKey: 'child', name: 'Leaf', description: '' },
    ],
  });
  assert.equal(tree.nodes.length, 3);
  const parent = randomUUID();
  assert.equal(
    prepareRatingCategoriesSchema.parse({
      ...base,
      parentId: parent,
      expectedParentRevision: randomUUID(),
    }).parentId,
    parent,
  );
});
test('category creation rejects invented roles, inconsistent parents and malformed tree sets', () => {
  const base = intent();
  const invalid = [
    { ...base, role: 'super_admin' },
    { ...base, isGlobal: true },
    { ...base, isSystem: true },
    { ...base, kind: 'course' },
    { ...base, campusIds: [randomUUID()] },
    { ...base, reviewDecisionId: randomUUID() },
    { ...base, assetIds: [randomUUID()] },
    { ...base, parentId: randomUUID() },
    { ...base, expectedParentRevision: randomUUID() },
    { ...base, expectedScopeRevision: 'a'.repeat(42) },
    { ...base, nodes: [] },
    { ...base, nodes: [{ ...base.nodes[0], name: '' }] },
    { ...base, nodes: [{ ...base.nodes[0], description: '\u0000' }] },
    { ...base, nodes: [{ ...base.nodes[0], key: '../escape' }] },
    {
      ...base,
      nodes: [base.nodes[0], { ...base.nodes[0], parentKey: 'root' }],
    },
    {
      ...base,
      nodes: [
        base.nodes[0],
        { key: 'other', parentKey: null, name: 'Second root', description: '' },
      ],
    },
    {
      ...base,
      nodes: [
        base.nodes[0],
        {
          key: 'child',
          parentKey: 'later',
          name: 'Forward parent',
          description: '',
        },
      ],
    },
    {
      ...base,
      nodes: [
        base.nodes[0],
        { key: 'child', parentKey: 'root', name: 'Child', description: '' },
        { key: 'leaf', parentKey: 'child', name: 'Leaf', description: '' },
        { key: 'deep', parentKey: 'leaf', name: 'Too deep', description: '' },
      ],
    },
    {
      ...base,
      nodes: [
        base.nodes[0],
        ...Array.from({ length: 32 }, (_, index) => ({
          key: `c${index}`,
          parentKey: 'root',
          name: 'Child',
          description: '',
        })),
      ],
    },
  ];
  for (const value of invalid)
    assert.equal(
      prepareRatingCategoriesSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  assert.equal(
    commitRatingCategoriesSchema.safeParse({
      ...base,
      expectedContextRevision: 'x'.repeat(43),
    }).success,
    true,
  );
  assert.equal(
    commitRatingCategoriesSchema.safeParse({
      ...base,
      expectedContextRevision: 'x'.repeat(42),
    }).success,
    false,
  );
});
test('category response schemas remain transform-free strict canonical output', () => {
  for (const schema of [
    ratingCategoryManagementContextSchema,
    ratingCategoryPreparationSchema,
    ratingCategoryReceiptSchema,
  ])
    assert.doesNotThrow(() => z.toJSONSchema(schema));
  const context = {
    regionId: null,
    catalogRevision: null,
    scopeRevision: 'x'.repeat(43),
    campusIds: [],
    parents: [],
    maximumNodes: 32,
    maximumDepth: 3,
  };
  assert.deepEqual(
    ratingCategoryManagementContextSchema.parse(context),
    context,
  );
  assert.equal(
    ratingCategoryManagementContextSchema.safeParse({
      ...context,
      grant: 'super_admin',
    }).success,
    false,
  );
  assert.equal(
    ratingCategoryManagementContextSchema.safeParse({
      ...context,
      parents: [
        {
          id: randomUUID(),
          revision: randomUUID(),
          name: ' trailing ',
          level: 1,
        },
      ],
    }).success,
    false,
  );
  const rejected = {
    requestId: randomUUID(),
    operation: 'create_categories',
    outcome: 'rejected',
    code: 'RATING_CATEGORY_CANCELLED',
  };
  assert.deepEqual(ratingCategoryReceiptSchema.parse(rejected), rejected);
  for (const code of [
    'CONTENT_REVIEW_UNAVAILABLE',
    'RATING_UNAVAILABLE',
    'AUTHORIZATION_UNAVAILABLE',
    'IDENTITY_CAMPUS_UNAVAILABLE',
    'unknown',
  ])
    assert.equal(
      ratingCategoryReceiptSchema.safeParse({ ...rejected, code }).success,
      false,
    );
  assert.equal(
    ratingCategoryReceiptSchema.safeParse({
      ...rejected,
      name: 'private category text',
    }).success,
    false,
  );
});
