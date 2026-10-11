import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  categoryIconAppearanceSchema,
  categoryIconReplacements,
  categoryIconTextHash,
  categoryIconTextIntent,
  ratingCategoryIconContextSchema,
  ratingCategoryIconIntentHash,
  ratingCategoryIconIntentSchema,
} from '../src/ratings/category-management/icon-contracts.js';
import {
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedOperations,
} from '../src/ratings/category-management/scoped-contracts.js';
const id = (n: number) =>
  `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const context = {
  id: id(1),
  token: 't'.repeat(43),
  tokenDigest: createHash('sha256').update('t'.repeat(43)).digest('hex'),
  selector: { kind: 'campus', campusId: id(2) },
  scopeRevision: 'a'.repeat(64),
  protocolGeneration: id(3),
  catalogRevision: id(4),
  headRevision: id(5),
  sourceDigest: 'b'.repeat(64),
};
const common = { clientRequestId: id(6), expectedSnapshot: 'c'.repeat(64) };
const placement = { kind: 'campuses', campusIds: [id(2)] };
const node = {
  key: 'root',
  parentKey: null,
  name: '图标 🌊',
  description: '',
  icon: { mode: 'clear' },
};
const payloads = [
  { ...common, parentId: null, placement, nodes: [node] },
  {
    ...common,
    categoryId: id(7),
    name: '图标 🌊',
    description: '',
    icon: { mode: 'keep' },
  },
  {
    ...common,
    categoryId: id(7),
    name: { mode: 'inherit' },
    description: { mode: 'inherit' },
    icon: { mode: 'inherit' },
  },
  { ...common, categoryId: id(7), hidden: true },
  { ...common, parentId: null, action: 'set', orderedIds: [id(7)] },
  { ...common, categoryId: id(7), placement, propagation: 'self' },
  { ...common, categoryId: id(7), state: 'archived', restore: false },
  {
    ...common,
    parentId: id(7),
    addNodes: [node],
    disableIds: [],
    restoreIds: [],
    enableIds: [],
    orderedChildren: [{ kind: 'new', key: 'root' }],
  },
  {
    ...common,
    systemKey: 'test_system',
    name: '图标 🌊',
    description: '',
    placement,
    levelCount: 3,
    icon: { mode: 'clear' },
  },
];
function intent(n: number, patch: Record<string, unknown> = {}) {
  return {
    protocolVersion: 5,
    mediaSnapshot: 'd'.repeat(64),
    context,
    operation: ratingCategoryScopedOperations[n],
    payload: { ...payloads[n], ...patch },
  };
}
const replace = (n = 10) => ({
  mode: 'replace',
  assetId: id(n),
  uploadScopeId: id(n + 100),
});
for (let n = 0; n < 9; n++)
  test(`Category icon protocol preserves text projection for ${ratingCategoryScopedOperations[n]}`, () => {
    const next = ratingCategoryIconIntentSchema.parse(intent(n));
    const text = categoryIconTextIntent(next);
    assert.equal(text.protocolVersion, 2);
    assert.equal(text.operation, next.operation);
    assert.equal(
      categoryIconTextHash(next),
      ratingCategoryScopedIntentHash(text),
    );
    assert.equal(
      ratingCategoryScopedIntentSchema.safeParse(next).success,
      false,
    );
    assert.notEqual(
      ratingCategoryIconIntentHash(next),
      categoryIconTextHash(next),
    );
  });
test('every created node has exactly one explicit icon decision; all 32 uploads remain one command', () => {
  const nodes = Array.from({ length: 32 }, (_, n) => ({
    ...node,
    key: `n${n}`,
    icon: replace(n + 20),
  }));
  const next = ratingCategoryIconIntentSchema.parse(intent(0, { nodes }));
  assert.equal(categoryIconReplacements(next).length, 32);
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse(
      intent(0, { nodes: [...nodes, { ...node, key: 'extra' }] }),
    ).success,
    false,
  );
  const { icon: _icon, ...missing } = node;
  void _icon;
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse(intent(0, { nodes: [missing] }))
      .success,
    false,
  );
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse(
      intent(0, { nodes: [{ ...node, icon: { mode: 'keep' } }] }),
    ).success,
    false,
  );
});
test('duplicate asset or upload scope cannot share attachment authority across nodes', () => {
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse(
      intent(0, {
        nodes: [
          { ...node, icon: replace() },
          { ...node, key: 'child', parentKey: 'root', icon: replace() },
        ],
      }),
    ).success,
    false,
  );
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse(
      intent(0, {
        nodes: [
          { ...node, icon: replace() },
          {
            ...node,
            key: 'child',
            parentKey: 'root',
            icon: { ...replace(), assetId: id(30) },
          },
        ],
      }),
    ).success,
    false,
  );
});
test('same text and request with different image has different outer hash, never a second text authority', () => {
  const a = ratingCategoryIconIntentSchema.parse(
    intent(1, { icon: replace(10) }),
  );
  const b = ratingCategoryIconIntentSchema.parse(
    intent(1, { icon: replace(11) }),
  );
  assert.equal(categoryIconTextHash(a), categoryIconTextHash(b));
  assert.notEqual(
    ratingCategoryIconIntentHash(a),
    ratingCategoryIconIntentHash(b),
  );
});
test('base keep, clear and replace stay distinct; override inherit, explicit absence, keep and image stay distinct', () => {
  for (const icon of [{ mode: 'keep' }, { mode: 'clear' }, replace()])
    assert.equal(
      ratingCategoryIconIntentSchema.safeParse(intent(1, { icon })).success,
      true,
    );
  const choices = [
    { mode: 'inherit' },
    { mode: 'set', value: null },
    { mode: 'set', value: { mode: 'keep' } },
    { mode: 'set', value: replace() },
  ];
  const hashes = choices.map((icon) =>
    ratingCategoryIconIntentHash(
      ratingCategoryIconIntentSchema.parse(intent(2, { icon })),
    ),
  );
  assert.equal(new Set(hashes).size, choices.length);
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse({
      ...intent(2),
      context: { ...context, selector: { kind: 'global' } },
    }).success,
    false,
  );
});
test('no URL/key/manifest/cover slots, arrays, legacy versions or hidden fields authorize an icon', () => {
  for (const icon of [
    { ...replace(), url: 'https://example.test/a' },
    { ...replace(), key: 'private' },
    { ...replace(), manifestDigest: 'e'.repeat(64) },
    [replace()],
    null,
  ])
    assert.equal(
      ratingCategoryIconIntentSchema.safeParse(intent(1, { icon })).success,
      false,
    );
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse(intent(1, { cover: replace() }))
      .success,
    false,
  );
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse({
      ...intent(1),
      protocolVersion: 2,
    }).success,
    false,
  );
  assert.equal(
    ratingCategoryIconIntentSchema.safeParse({
      ...intent(1),
      mediaSnapshot: undefined,
    }).success,
    false,
  );
});
test('metadata operations cannot smuggle an icon replacement', () => {
  for (const n of [3, 4, 5, 6])
    assert.equal(
      ratingCategoryIconIntentSchema.safeParse(intent(n, { icon: replace() }))
        .success,
      false,
    );
});
test('Category context and appearance are independently typed', () => {
  const input = {
    protocolVersion: 5,
    commandContext: context,
    expiresAt: '2027-01-01T00:00:00.000Z',
    snapshotRevision: 'c'.repeat(64),
    campusIds: [id(2)],
    canManageGlobal: false,
    operations: ratingCategoryScopedOperations,
    mediaSnapshot: 'd'.repeat(64),
    capabilities: ['category_icon'],
  };
  assert.equal(ratingCategoryIconContextSchema.safeParse(input).success, true);
  assert.equal(
    ratingCategoryIconContextSchema.safeParse({
      ...input,
      capabilities: ['target_cover'],
    }).success,
    false,
  );
  const appearance = {
    appearanceId: id(20),
    assetId: id(21),
    manifestDigest: 'e'.repeat(64),
    actorId: id(22),
    categoryId: id(23),
    identityId: id(24),
    origin: { kind: 'base' },
  };
  assert.equal(
    categoryIconAppearanceSchema.safeParse(appearance).success,
    true,
  );
  assert.equal(
    categoryIconAppearanceSchema.safeParse({ ...appearance, targetId: id(25) })
      .success,
    false,
  );
});
