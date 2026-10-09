import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRatingCategoryCreationInput,
  decodeRatingCategoryCreationIntent,
  decodeRatingCategoryCreationReceipt,
  decodeRatingCategoryManagementContext,
  decodeRatingCategoryManagementRoute,
  decodeRatingCategoryNodes,
  decodeRatingCategoryPreparation,
  decodeRatingCategoryPrepared,
  matchRatingCategoryCreationReceipt,
  matchRatingCategoryPreparation,
  ratingCategoryManagementPath,
  ratingCategoryRejections,
} from '../src/ratings/category-management-contract';
import { otherId, regionId, revision } from './ratings-helpers';
import {
  cancelledCategoryReceipt,
  categoryCampusIds,
  categoryCreationIntent,
  categoryCreationReceipt,
  categoryManagementContext,
  categoryPreparation,
  categoryTestId,
  existingCategoryParentId,
  existingCategoryParentRevision,
} from './category-management-helpers';

const firstNode = () => ({ ...categoryCreationIntent().payload.nodes[0]! });

test('category intent is exact, deeply frozen and preserves canonical original text without repairing it', () => {
  const original = categoryCreationIntent();
  assert.deepEqual(decodeRatingCategoryCreationIntent(original), original);
  assert.deepEqual(
    decodeRatingCategoryCreationInput(original.payload),
    original.payload,
  );
  const decoded = decodeRatingCategoryCreationIntent({
    ...original,
    payload: {
      ...original.payload,
      nodes: [
        {
          ...firstNode(),
          name: '🌊'.repeat(100),
          description: '鲸'.repeat(500),
        },
      ],
    },
  });
  assert.equal(decoded.payload.nodes[0]!.name, '🌊'.repeat(100));
  for (const value of [
    decoded,
    decoded.payload,
    decoded.payload.nodes,
    decoded.payload.nodes[0],
    decoded.payload.assetIds,
  ])
    assert.equal(Object.isFrozen(value), true);
  for (const patch of [
    { name: '' },
    { name: ' \t\n ' },
    { name: ' leading' },
    { name: 'trailing ' },
    { name: 'first\r\nsecond' },
    { description: ' text ' },
    { description: '\t' },
    { description: 'first\r\nsecond' },
    { name: '🌊'.repeat(101) },
    { description: '🌊'.repeat(501) },
    { name: '\ud800' },
    { description: '\udfff' },
    { name: 'bad\u0000text' },
    { description: '\u007f' },
    { description: '\u0085' },
    { name: 1 },
    { description: null },
  ])
    assert.throws(
      () => decodeRatingCategoryNodes([{ ...firstNode(), ...patch }]),
      { kind: 'protocol' },
    );
  const canonical = { ...firstNode(), name: '鲸\n鱼', description: 'a\tb\nc' };
  assert.deepEqual(decodeRatingCategoryNodes([canonical]), [canonical]);
});

test('category intent rejects every missing field, injected authority, special kind and preparation token', () => {
  const original = categoryCreationIntent();
  for (const key of Object.keys(original.payload)) {
    const payload: Record<string, unknown> = { ...original.payload };
    delete payload[key];
    assert.throws(() =>
      decodeRatingCategoryCreationIntent({ ...original, payload }),
    );
  }
  for (const patch of [
    { operation: 'create_target' },
    { targetId: otherId },
    { accepted: true },
    { expectedContextRevision: 'x'.repeat(43) },
  ])
    assert.throws(() =>
      decodeRatingCategoryCreationIntent({ ...original, ...patch }),
    );
  for (const patch of [
    { actorId: otherId },
    { campusIds: categoryCampusIds },
    { scope: 'global' },
    { isGlobal: true },
    { isSystem: false },
    { systemKey: null },
    { kind: 'general' },
    { accepted: true },
    { source: 'new_native' },
    { expectedContextRevision: 'x'.repeat(43) },
    { assetIds: [otherId] },
    { assetIds: null },
    { assetIds: {} },
  ])
    assert.throws(() =>
      decodeRatingCategoryCreationInput({ ...original.payload, ...patch }),
    );
  for (const patch of [
    { id: otherId },
    { revision },
    { level: 1 },
    { parentId: null },
    { kind: 'general' },
    { isSystem: false },
    { systemKey: null },
    { isGlobal: true },
  ])
    assert.throws(() =>
      decodeRatingCategoryNodes([{ ...firstNode(), ...patch }]),
    );
  for (const key of Object.keys(firstNode())) {
    const node: Record<string, unknown> = firstNode();
    delete node[key];
    assert.throws(() => decodeRatingCategoryNodes([node]));
  }
  for (const raw of [
    null,
    [],
    {},
    { payload: original.payload },
    { operation: original.operation },
  ])
    assert.throws(() => decodeRatingCategoryCreationIntent(raw));
});

test('category creation accepts exactly one ordered root and one to thirty-two unique keyed nodes', () => {
  const root = firstNode();
  assert.deepEqual(decodeRatingCategoryNodes([root]), [root]);
  const maximum = [
    root,
    ...Array.from({ length: 31 }, (_, i) => ({
      key: `child_${i}`,
      parentKey: 'root',
      name: `Child ${i}`,
      description: '',
    })),
  ];
  assert.equal(decodeRatingCategoryNodes(maximum).length, 32);
  assert.throws(() =>
    decodeRatingCategoryNodes([
      ...maximum,
      { ...root, key: 'extra', parentKey: 'root' },
    ]),
  );
  const tree = categoryCreationIntent().payload.nodes;
  const sibling = {
    key: 'sibling',
    parentKey: 'root',
    name: 'Sibling',
    description: '',
  };
  assert.equal(decodeRatingCategoryNodes([...tree, sibling]).length, 4);
  for (const nodes of [
    null,
    {},
    [],
    [null],
    [{ ...root, parentKey: 'root' }],
    [root, { ...sibling, parentKey: null }],
    [root, { ...sibling, parentKey: 'absent' }],
    [root, { ...sibling, parentKey: 'later' }, { ...sibling, key: 'later' }],
    [root, { ...sibling, parentKey: 'sibling' }],
    [root, { ...sibling, key: 'root' }],
    [tree[0], tree[2], tree[1]],
    [...tree, { ...sibling, parentKey: 'leaf' }],
  ])
    assert.throws(() => decodeRatingCategoryNodes(nodes));
  for (const key of [
    '',
    'Root',
    '_root',
    '1root',
    'a-b',
    'a b',
    '鲸',
    'a'.repeat(33),
    null,
    4,
  ])
    assert.throws(() => decodeRatingCategoryNodes([{ ...root, key }]));
  assert.equal(
    decodeRatingCategoryNodes([{ ...root, key: 'a'.repeat(32) }])[0]!.key
      .length,
    32,
  );
});

test('scope and external parent bindings are explicit, exact and paired with a current catalog', () => {
  const input = categoryCreationIntent().payload;
  for (const key of [
    'clientRequestId',
    'regionId',
    'expectedCatalogRevision',
    'parentId',
    'expectedParentRevision',
  ])
    for (const value of ['invalid', '', undefined, 1])
      assert.throws(() =>
        decodeRatingCategoryCreationInput({ ...input, [key]: value }),
      );
  for (const expectedScopeRevision of [
    null,
    '',
    'x'.repeat(42),
    'x'.repeat(44),
    '+'.repeat(43),
    '/'.repeat(43),
    '='.repeat(43),
  ])
    assert.throws(() =>
      decodeRatingCategoryCreationInput({ ...input, expectedScopeRevision }),
    );
  for (const patch of [
    { parentId: existingCategoryParentId },
    { expectedParentRevision: existingCategoryParentRevision },
    {
      parentId: existingCategoryParentId,
      expectedParentRevision: existingCategoryParentRevision,
      expectedCatalogRevision: null,
    },
  ])
    assert.throws(() =>
      decodeRatingCategoryCreationInput({ ...input, ...patch }),
    );
  assert.equal(
    categoryCreationIntent({ expectedCatalogRevision: null }).payload
      .expectedCatalogRevision,
    null,
  );
  const parented = categoryCreationIntent({
    regionId,
    parentId: existingCategoryParentId,
    expectedParentRevision: existingCategoryParentRevision,
    nodes: input.nodes.slice(0, 2),
  });
  assert.deepEqual(decodeRatingCategoryCreationIntent(parented), parented);
  const prepared = categoryPreparation(parented);
  matchRatingCategoryPreparation(
    parented,
    decodeRatingCategoryPreparation(prepared),
  );
  assert.deepEqual(
    prepared.categories.map((node) => node.level),
    [2, 3],
  );
  assert.equal(prepared.categories[0]!.parentId, existingCategoryParentId);
  const underLevelTwo = categoryCreationIntent({
    ...parented.payload,
    nodes: input.nodes.slice(0, 1),
  });
  matchRatingCategoryPreparation(
    underLevelTwo,
    decodeRatingCategoryPreparation(categoryPreparation(underLevelTwo, 2)),
  );
  assert.throws(() =>
    decodeRatingCategoryPreparation(categoryPreparation(parented, 2)),
  );
  assert.throws(() =>
    decodeRatingCategoryPreparation(
      categoryPreparation(
        categoryCreationIntent({
          parentId: existingCategoryParentId,
          expectedParentRevision: existingCategoryParentRevision,
        }),
      ),
    ),
  );
});

test('context preserves the complete sorted unique campus list and requires nonempty regional mappings', () => {
  for (const scope of [null, regionId]) {
    const raw = categoryManagementContext(scope);
    const decoded = decodeRatingCategoryManagementContext(raw);
    assert.deepEqual(decoded, raw);
    for (const value of [
      decoded,
      decoded.campusIds,
      decoded.parents,
      ...decoded.parents,
    ])
      assert.equal(Object.isFrozen(value), true);
    for (const campusIds of [
      null,
      {},
      ['invalid'],
      [categoryCampusIds[1], categoryCampusIds[0]],
      [categoryCampusIds[0], categoryCampusIds[0]],
      [categoryCampusIds[0], null],
    ])
      assert.throws(() =>
        decodeRatingCategoryManagementContext({ ...raw, campusIds }),
      );
  }
  assert.throws(() =>
    decodeRatingCategoryManagementContext({
      ...categoryManagementContext(regionId),
      campusIds: [],
    }),
  );
  assert.deepEqual(
    decodeRatingCategoryManagementContext({
      ...categoryManagementContext(),
      campusIds: [],
    }).campusIds,
    [],
  );
  const empty = {
    ...categoryManagementContext(),
    catalogRevision: null,
    parents: [],
  };
  assert.deepEqual(decodeRatingCategoryManagementContext(empty), empty);
  assert.throws(() =>
    decodeRatingCategoryManagementContext({
      ...categoryManagementContext(),
      catalogRevision: null,
    }),
  );
});

test('context parents and fixed bounds cannot be broadened with opaque definitions or authority fields', () => {
  const raw = categoryManagementContext();
  for (const patch of [
    { regionId: 'bad' },
    { catalogRevision: 'bad' },
    { scopeRevision: 'bad' },
    { maximumNodes: 31 },
    { maximumNodes: '32' },
    { maximumDepth: 4 },
    { maximumDepth: '3' },
    { parents: null },
    { campusId: otherId },
    { authorized: true },
    { review: 'approved' },
    { parents: [raw.parents[0], raw.parents[0]] },
  ])
    assert.throws(() =>
      decodeRatingCategoryManagementContext({ ...raw, ...patch }),
    );
  for (const patch of [
    { id: 'bad' },
    { revision: 'bad' },
    { name: '' },
    { name: ' leading' },
    { name: 'x'.repeat(101) },
    { level: 0 },
    { level: 3 },
    { level: 1.5 },
    { level: '1' },
    { source: 'opaque_historical' },
    { regionId },
    { accepted: true },
  ])
    assert.throws(() =>
      decodeRatingCategoryManagementContext({
        ...raw,
        parents: [{ ...raw.parents[0], ...patch }],
      }),
    );
  for (const key of Object.keys(raw.parents[0]!)) {
    const parent: Record<string, unknown> = { ...raw.parents[0] };
    delete parent[key];
    assert.throws(() =>
      decodeRatingCategoryManagementContext({ ...raw, parents: [parent] }),
    );
  }
});

test('preparation strictly reserves a bounded list of unique IDs, revisions and keys with no publication fields', () => {
  const prepared = categoryPreparation();
  const decoded = decodeRatingCategoryPreparation(prepared);
  assert.deepEqual(decoded, prepared);
  for (const value of [decoded, decoded.categories, ...decoded.categories])
    assert.equal(Object.isFrozen(value), true);
  for (const patch of [
    { requestId: 'bad' },
    { contextRevision: 'x'.repeat(42) },
    { contextRevision: 'x'.repeat(44) },
    { contextRevision: '!'.repeat(43) },
    { categories: [] },
    { categories: null },
    { releaseId: otherId },
    { occurredAt: '2026-10-08T12:00:00Z' },
    { outcome: 'applied' },
    {
      categories: Array.from({ length: 33 }, (_, i) => ({
        ...prepared.categories[0],
        key: `n${i}`,
        id: categoryTestId(1000 + i),
        revision: categoryTestId(2000 + i),
      })),
    },
  ])
    assert.throws(() =>
      decodeRatingCategoryPreparation({ ...prepared, ...patch }),
    );
  for (const patch of [
    { key: 'Invalid' },
    { id: 'bad' },
    { revision: 'bad' },
    { parentId: 'bad' },
    { parentId: prepared.categories[0]!.id },
    { level: 0 },
    { level: 4 },
    { level: 1.5 },
    { level: '1' },
    { name: 'private' },
    { description: 'private' },
    { kind: 'general' },
  ])
    assert.throws(() =>
      decodeRatingCategoryPreparation({
        ...prepared,
        categories: [
          { ...prepared.categories[0], ...patch },
          ...prepared.categories.slice(1),
        ],
      }),
    );
  for (const field of ['key', 'id', 'revision'] as const)
    assert.throws(() =>
      decodeRatingCategoryPreparation({
        ...prepared,
        categories: [
          prepared.categories[0],
          {
            ...prepared.categories[1],
            [field]: prepared.categories[0]![field],
          },
          prepared.categories[2],
        ],
      }),
    );
  for (const key of Object.keys(prepared.categories[0]!)) {
    const category: Record<string, unknown> = { ...prepared.categories[0] };
    delete category[key];
    assert.throws(() =>
      decodeRatingCategoryPreparation({ ...prepared, categories: [category] }),
    );
  }
});

test('preparation matches original key, node order, count, ancestry, parent identity and depth', () => {
  const intent = categoryCreationIntent(),
    prepared = categoryPreparation();
  matchRatingCategoryPreparation(intent, prepared);
  for (const patch of [
    { requestId: otherId },
    { categories: prepared.categories.slice(0, 2) },
    { categories: [...prepared.categories].reverse() },
    {
      categories: [
        { ...prepared.categories[0]!, key: 'another' },
        ...prepared.categories.slice(1),
      ],
    },
    {
      categories: [
        { ...prepared.categories[0]!, parentId: otherId },
        ...prepared.categories.slice(1),
      ],
    },
    {
      categories: [
        { ...prepared.categories[0]!, level: 2 as const },
        ...prepared.categories.slice(1),
      ],
    },
    {
      categories: [
        prepared.categories[0]!,
        { ...prepared.categories[1]!, parentId: otherId },
        prepared.categories[2]!,
      ],
    },
    {
      categories: [
        prepared.categories[0]!,
        { ...prepared.categories[1]!, level: 3 as const },
        prepared.categories[2]!,
      ],
    },
    {
      categories: [
        prepared.categories[0]!,
        prepared.categories[1]!,
        { ...prepared.categories[2]!, parentId: prepared.categories[0]!.id },
      ],
    },
  ])
    assert.throws(() =>
      matchRatingCategoryPreparation(intent, { ...prepared, ...patch }),
    );
  const parented = categoryCreationIntent({
    parentId: existingCategoryParentId,
    expectedParentRevision: existingCategoryParentRevision,
    nodes: intent.payload.nodes.slice(0, 1),
  });
  for (const patch of [
    { parentId: null },
    { parentId: otherId },
    { level: 1 as const },
    { id: existingCategoryParentId },
  ])
    assert.throws(() =>
      matchRatingCategoryPreparation(parented, {
        ...categoryPreparation(parented),
        categories: [
          { ...categoryPreparation(parented).categories[0]!, ...patch },
        ],
      }),
    );
});

test('applied receipts require exact new category structure and scope-specific new catalog releases', () => {
  for (const intent of [
    categoryCreationIntent(),
    categoryCreationIntent({ regionId }),
  ]) {
    const receipt = categoryCreationReceipt(intent),
      decoded = decodeRatingCategoryCreationReceipt(receipt);
    assert.deepEqual(decoded, receipt);
    matchRatingCategoryCreationReceipt(intent, decoded);
    for (const patch of [
      { requestId: otherId },
      { categories: receipt.categories.slice(0, 2) },
      { categories: [...receipt.categories].reverse() },
      {
        categories: [
          { ...receipt.categories[0]!, parentId: otherId },
          ...receipt.categories.slice(1),
        ],
      },
      {
        catalogs: [{ regionId: otherId, catalogRevision: categoryTestId(401) }],
      },
      {
        catalogs: [
          { regionId: intent.payload.regionId, catalogRevision: revision },
        ],
      },
    ])
      assert.throws(() =>
        matchRatingCategoryCreationReceipt(intent, { ...receipt, ...patch }),
      );
  }
  const regional = categoryCreationIntent({ regionId });
  assert.throws(() =>
    matchRatingCategoryCreationReceipt(regional, {
      ...categoryCreationReceipt(regional),
      catalogs: categoryCreationReceipt().catalogs,
    }),
  );
  const global = categoryCreationReceipt();
  assert.equal(global.catalogs.length, 2);
  assert.throws(() =>
    matchRatingCategoryCreationReceipt(categoryCreationIntent(), {
      ...global,
      catalogs: global.catalogs.slice(1),
    }),
  );
  matchRatingCategoryCreationReceipt(
    categoryCreationIntent({ expectedCatalogRevision: null }),
    global,
  );
});

test('applied receipts reject noop, malformed releases and duplicate scope or catalog identities', () => {
  const raw = categoryCreationReceipt();
  for (const patch of [
    { operation: 'create_target' },
    { outcome: 'noop' },
    { outcome: 'pending' },
    { releaseId: 'bad' },
    { occurredAt: 'not a timestamp' },
    { categories: [] },
    { catalogs: [] },
    { catalogs: null },
    { catalogs: [{ ...raw.catalogs[0], campusIds: categoryCampusIds }] },
    { catalogs: [{ regionId: 'bad', catalogRevision: categoryTestId(401) }] },
    { catalogs: [{ regionId: null, catalogRevision: null }] },
    { catalogs: [raw.catalogs[0], raw.catalogs[0]] },
    {
      catalogs: [
        raw.catalogs[0],
        { regionId, catalogRevision: raw.catalogs[0]!.catalogRevision },
      ],
    },
    { name: 'private' },
    { expectedScopeRevision: 's'.repeat(43) },
    { contextRevision: 'c'.repeat(43) },
  ])
    assert.throws(() =>
      decodeRatingCategoryCreationReceipt({ ...raw, ...patch }),
    );
  const decoded = decodeRatingCategoryCreationReceipt(raw);
  if (decoded.outcome !== 'applied')
    throw new Error('Expected applied fixture');
  for (const value of [
    decoded,
    decoded.catalogs,
    ...decoded.catalogs,
    decoded.categories,
    ...decoded.categories,
  ])
    assert.equal(Object.isFrozen(value), true);
  for (const key of Object.keys(raw.catalogs[0]!)) {
    const catalog: Record<string, unknown> = { ...raw.catalogs[0] };
    delete catalog[key];
    assert.throws(() =>
      decodeRatingCategoryCreationReceipt({ ...raw, catalogs: [catalog] }),
    );
  }
});

test('only exact durable rejection codes are terminal; unknown Review, topology and auth cannot be rejection receipts', () => {
  assert.deepEqual(
    [...ratingCategoryRejections].sort(),
    [
      'RATING_CATEGORY_CONTEXT_CHANGED',
      'CONTENT_REJECTED',
      'RATING_CATEGORY_CANCELLED',
      'RATING_NOT_FOUND',
      'PHONE_VERIFICATION_REQUIRED',
      'SAFETY_ACTION_RESTRICTED',
    ].sort(),
  );
  for (const code of ratingCategoryRejections) {
    const receipt = { ...cancelledCategoryReceipt(), code };
    assert.deepEqual(decodeRatingCategoryCreationReceipt(receipt), receipt);
    assert.deepEqual(decodeRatingCategoryPrepared(receipt), receipt);
    matchRatingCategoryCreationReceipt(categoryCreationIntent(), receipt);
    assert.throws(() =>
      matchRatingCategoryCreationReceipt(categoryCreationIntent(), {
        ...receipt,
        requestId: otherId,
      }),
    );
    for (const patch of [
      { releaseId: otherId },
      { categories: [] },
      { occurredAt: '2026-10-08T00:00:00Z' },
      { detail: 'private' },
    ])
      assert.throws(() =>
        decodeRatingCategoryCreationReceipt({ ...receipt, ...patch }),
      );
  }
  for (const code of [
    'RATING_UNAVAILABLE',
    'CONTENT_REVIEW_UNAVAILABLE',
    'VERIFICATION_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'TOPOLOGY_UNAVAILABLE',
    'REQUEST_NOT_FOUND',
    'INTERNAL_ERROR',
    'AFFILIATION_VERIFICATION_REQUIRED',
    'RATING_CATEGORY_REVISION_CONFLICT',
    '',
    null,
  ])
    assert.throws(() =>
      decodeRatingCategoryCreationReceipt({
        ...cancelledCategoryReceipt(),
        code,
      }),
    );
  assert.deepEqual(
    decodeRatingCategoryPrepared(categoryPreparation()),
    categoryPreparation(),
  );
  assert.throws(() => decodeRatingCategoryPrepared(categoryCreationReceipt()));
  for (const value of [
    null,
    {},
    [],
    { outcome: 'pending' },
    { ...categoryCreationReceipt(), outcome: 'noop' },
  ])
    assert.throws(() => decodeRatingCategoryCreationReceipt(value));
});

test('all context, preparation and receipt fields are mandatory rather than silently defaulted', () => {
  for (const [value, decode] of [
    [categoryManagementContext(), decodeRatingCategoryManagementContext],
    [categoryPreparation(), decodeRatingCategoryPreparation],
    [categoryCreationReceipt(), decodeRatingCategoryCreationReceipt],
    [cancelledCategoryReceipt(), decodeRatingCategoryCreationReceipt],
  ] as const)
    for (const key of Object.keys(value)) {
      const incomplete: Record<string, unknown> = { ...value };
      delete incomplete[key];
      assert.throws(() => decode(incomplete));
    }
});

test('native route has only an explicit optional region and does not accept campus or parent authority', () => {
  for (const value of [{}, { regionId: null }, { regionId: undefined }])
    assert.deepEqual(decodeRatingCategoryManagementRoute(value), {
      regionId: null,
    });
  assert.deepEqual(decodeRatingCategoryManagementRoute({ regionId }), {
    regionId,
  });
  assert.equal(
    ratingCategoryManagementPath(null),
    '/pages/rating-category-create/rating-category-create',
  );
  assert.equal(
    ratingCategoryManagementPath(regionId),
    `/pages/rating-category-create/rating-category-create?regionId=${regionId}`,
  );
  assert.equal(ratingCategoryManagementPath('bad'), null);
  for (const value of [
    null,
    [],
    { regionId: '' },
    { regionId: 'global' },
    { regionId: 'bad' },
    { campusId: otherId },
    { regionId, parentId: otherId },
  ])
    assert.throws(() => decodeRatingCategoryManagementRoute(value));
});

test('context and receipt mirror server cardinality bounds without truncating any scope evidence', () => {
  const context = categoryManagementContext();
  assert.throws(() =>
    decodeRatingCategoryManagementContext({
      ...context,
      campusIds: Array.from({ length: 1001 }, (_, i) =>
        categoryTestId(10000 + i),
      ),
    }),
  );
  assert.throws(() =>
    decodeRatingCategoryManagementContext({
      ...context,
      parents: Array.from({ length: 10001 }, (_, i) => ({
        id: categoryTestId(20000 + i),
        revision: categoryTestId(40000 + i),
        name: 'Parent',
        level: 1,
      })),
    }),
  );
  assert.throws(() =>
    decodeRatingCategoryCreationReceipt({
      ...categoryCreationReceipt(),
      catalogs: Array.from({ length: 34 }, (_, i) => ({
        regionId: i === 0 ? null : categoryTestId(60000 + i),
        catalogRevision: categoryTestId(70000 + i),
      })),
    }),
  );
  assert.throws(() =>
    decodeRatingCategoryCreationInput({
      ...categoryCreationIntent().payload,
      parentId: existingCategoryParentId,
      expectedParentRevision: existingCategoryParentRevision,
    }),
  );
});
