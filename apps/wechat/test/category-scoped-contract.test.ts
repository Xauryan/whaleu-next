import { categoryTestId } from './category-management-helpers';
import { categoryScopedGoldenHashes } from './category-scoped-hash-vectors';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  RATING_CATEGORY_SCOPED_HTTP_BODY_LIMIT,
  RATING_CATEGORY_SCOPED_BODY_RESERVE,
  RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET,
  RATING_CATEGORY_SCOPED_PREPARATION_TOKEN_LENGTH,
  ratingCategoryScopedJsonByteLength,
  ratingCategoryScopedRequestBodyBytes,
  ratingCategoryScopedCommitEnvelope,
  decodeRatingCategoryPlacement,
  decodeRatingCategoryScopedContext,
  decodeRatingCategoryScopedIntent,
  decodeRatingCategoryScopedPrepared,
  decodeRatingCategoryScopedReceipt,
  decodeRatingManagedCategories,
  matchRatingCategoryScopedReceipt,
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedOperations,
} from '../src/ratings/category-scoped-contract';
import {
  canonicalRatingScopedJson,
  RATING_SCOPED_HASH_DOMAIN,
} from '../src/ratings/scoped-contract';
import {
  decodeRatingCategoryScopedRoute,
  ratingCategoryScopedPath,
} from '../src/ratings/category-scoped-route';
import {
  managedCampus,
  managedCampusB,
  managedCategories,
  managedSnapshot,
  managementContext,
  managementIntent,
  managementPreparation,
  managementReceipt,
} from './category-scoped-helpers';

test('all nine operations are exact canonical immutable intent/hash branches in the unchanged shared domain', () => {
  const hashes = new Set<string>();
  for (const operation of ratingCategoryScopedOperations) {
    const intent = managementIntent(operation);
    assert.deepEqual(
      decodeRatingCategoryScopedIntent(JSON.parse(JSON.stringify(intent))),
      intent,
    );
    assert.equal(Object.isFrozen(intent.payload), true);
    const expected = createHash('sha256')
      .update(
        RATING_SCOPED_HASH_DOMAIN +
          canonicalRatingScopedJson({
            protocolVersion: 2,
            operation,
            intent: { context: intent.context, payload: intent.payload },
          }),
      )
      .digest('hex');
    assert.equal(ratingCategoryScopedIntentHash(intent), expected);
    assert.equal(
      ratingCategoryScopedIntentHash(intent),
      categoryScopedGoldenHashes[operation],
    );
    hashes.add(expected);
    assert.throws(() =>
      decodeRatingCategoryScopedIntent({ ...intent, accepted: true }),
    );
    assert.throws(() =>
      decodeRatingCategoryScopedIntent({
        ...intent,
        payload: { ...intent.payload, sourceId: managedCampus },
      }),
    );
    matchRatingCategoryScopedReceipt(intent, managementReceipt(intent));
  }
  assert.equal(hashes.size, 9);
});
test('global, exact nonempty canonical campuses, inherit and clear descriptions cannot be conflated', () => {
  assert.deepEqual(decodeRatingCategoryPlacement({ kind: 'global' }), {
    kind: 'global',
  });
  for (const placement of [
    { kind: 'campuses', campusIds: [] },
    { kind: 'campuses', campusIds: [managedCampusB, managedCampus] },
    { kind: 'campuses', campusIds: [managedCampus, managedCampus] },
    { kind: 'global', campusIds: [] },
    { kind: 'campus', campusId: managedCampus },
  ])
    assert.throws(() => decodeRatingCategoryPlacement(placement));
  const intent = managementIntent('set_category_override_scoped');
  for (const name of [
    null,
    '',
    { mode: 'set', value: '' },
    { mode: 'inherit', value: '' },
    { mode: 'set', value: ' leading ' },
  ])
    assert.throws(() =>
      decodeRatingCategoryScopedIntent({
        ...intent,
        payload: { ...intent.payload, name },
      }),
    );
  assert.notEqual(
    ratingCategoryScopedIntentHash(intent),
    ratingCategoryScopedIntentHash(
      decodeRatingCategoryScopedIntent({
        ...intent,
        payload: { ...intent.payload, description: { mode: 'inherit' } },
      }),
    ),
  );
  const zero = decodeRatingCategoryScopedIntent({
    ...intent,
    payload: { ...intent.payload, name: { mode: 'set', value: '0' } },
  });
  assert.equal(zero.operation, 'set_category_override_scoped');
});
test('management DTOs are complete and strict; unknown outcomes never manufacture durable closure', () => {
  assert.deepEqual(
    decodeRatingCategoryScopedContext(managementContext()),
    managementContext(),
  );
  assert.throws(() =>
    decodeRatingCategoryScopedContext({
      ...managementContext(),
      capabilities: ['manage_categories'],
    }),
  );
  assert.throws(() =>
    decodeRatingManagedCategories({
      items: managedCategories(),
      snapshotRevision: managedSnapshot,
      complete: false,
    }),
  );
  assert.throws(() =>
    decodeRatingManagedCategories({
      items: [managedCategories()[0], managedCategories()[0]],
      snapshotRevision: managedSnapshot,
      complete: true,
    }),
  );
  assert.deepEqual(
    decodeRatingCategoryScopedPrepared(managementPreparation()),
    managementPreparation(),
  );
  for (const value of [
    { ...managementReceipt(), outcome: 'unknown' },
    { ...managementReceipt(undefined, 'closed'), code: 'RATING_UNAVAILABLE' },
    { ...managementReceipt(undefined, 'closed'), code: 'REQUEST_NOT_FOUND' },
  ])
    assert.throws(() => decodeRatingCategoryScopedReceipt(value));
  assert.throws(() =>
    matchRatingCategoryScopedReceipt(managementIntent(), {
      ...managementReceipt(),
      intentHash: 'f'.repeat(64),
    }),
  );
  assert.throws(() =>
    matchRatingCategoryScopedReceipt(
      managementIntent(),
      managementReceipt(managementIntent('set_category_visibility_scoped')),
    ),
  );
});
test('strict management routes require explicit view and never accept tokens or authority', () => {
  for (const raw of [
    {},
    { scope: 'campus' },
    { scope: 'global', campusId: managedCampus },
    { scope: 'global', token: 'x' },
    { scope: 'region', regionId: managedCampus },
  ])
    assert.throws(() => decodeRatingCategoryScopedRoute(raw));
  assert.equal(
    ratingCategoryScopedPath({
      selector: { kind: 'campus', campusId: managedCampus },
      categoryId: null,
    }),
    `/pages/rating-category-manage/rating-category-manage?scope=campus&campusId=${managedCampus}`,
  );
});

test('preview status distinguishes unavailable redaction, absent creation and a real available empty string', () => {
  const preparation = managementPreparation(),
    change = preparation.changes[0]!;
  const statuses = [
    {
      ...change,
      field: 'create',
      before: null,
      beforeStatus: 'absent',
      after: 'new body',
      afterStatus: 'available',
    },
    {
      ...change,
      field: 'effective_body',
      before: null,
      beforeStatus: 'unavailable',
      after: null,
      afterStatus: 'unavailable',
    },
    {
      ...change,
      field: 'effective_body',
      before: '',
      beforeStatus: 'available',
      after: '',
      afterStatus: 'available',
    },
  ];
  const decoded = decodeRatingCategoryScopedPrepared({
    ...preparation,
    changes: statuses,
  });
  assert.ok('changes' in decoded);
  assert.deepEqual(decoded.changes, statuses);
  for (const wrong of [
    { ...change, beforeStatus: undefined },
    { ...change, afterStatus: undefined },
    { ...change, before: null, beforeStatus: 'available' },
    { ...change, after: null, afterStatus: 'available' },
    { ...change, after: 'old cached text', afterStatus: 'unavailable' },
    {
      ...change,
      field: 'effective_body',
      before: null,
      beforeStatus: 'absent',
    },
    { ...change, field: 'create', before: null, beforeStatus: 'unavailable' },
    { ...change, after: null, afterStatus: 'absent' },
  ])
    assert.throws(
      () =>
        decodeRatingCategoryScopedPrepared({
          ...preparation,
          changes: [wrong],
        }),
      { kind: 'protocol' },
    );
});

test('request-body UTF-8 count matches actual JSON bytes for ASCII, Chinese, emoji and escaping without TextEncoder', () => {
  for (const value of [
    '',
    'ascii',
    '校园中文',
    '🌊😀',
    'é e\u0301',
    '"\\\n\t\u0000',
    '\ud800',
    '\udfff',
    { text: '中文 🌊 "\\\n', nested: ['😀', '校园'], number: 123 },
  ])
    assert.equal(
      ratingCategoryScopedJsonByteLength(value),
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    );
  assert.equal(ratingCategoryScopedJsonByteLength('中文'), 8);
  assert.equal(ratingCategoryScopedJsonByteLength('🌊'), 6);
  assert.equal(ratingCategoryScopedJsonByteLength('"'), 4);
  assert.equal(ratingCategoryScopedJsonByteLength('\n'), 4);
  assert.throws(() => ratingCategoryScopedJsonByteLength(undefined), {
    kind: 'protocol',
  });
});

test('every current envelope is measured and exact safe-budget boundary includes commit token, wrapper and named reserve', () => {
  assert.equal(RATING_CATEGORY_SCOPED_HTTP_BODY_LIMIT, 65536);
  assert.equal(RATING_CATEGORY_SCOPED_BODY_RESERVE, 1024);
  assert.equal(RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET, 64512);
  assert.equal(RATING_CATEGORY_SCOPED_PREPARATION_TOKEN_LENGTH, 43);
  const base = managementIntent('batch_update_subcategories_scoped');
  assert.equal(base.operation, 'batch_update_subcategories_scoped');
  if (base.operation !== 'batch_update_subcategories_scoped') assert.fail();
  const nodes = Array.from({ length: 32 }, (_, index) => ({
    key: `n${index}`,
    parentKey: null,
    name: `Node ${index}`,
    description: '',
  }));
  const payload = {
    ...base.payload,
    addNodes: nodes,
    disableIds: [],
    restoreIds: [],
    enableIds: [],
    orderedChildren: [
      ...Array.from({ length: 900 }, (_, index) => ({
        kind: 'existing',
        id: categoryTestId(3000 + index),
      })),
      ...nodes.map((node) => ({ kind: 'new', key: node.key })),
    ],
  };
  const decode = () => decodeRatingCategoryScopedIntent({ ...base, payload });
  let remaining =
    RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET -
    ratingCategoryScopedRequestBodyBytes(decode()).maximum;
  assert.ok(
    remaining > 0 && remaining < 32 * 500,
    'Fixture must have room to fill exact UTF-8 boundary with valid descriptions',
  );
  for (const node of nodes) {
    const length = Math.min(500, remaining);
    node.description = 'x'.repeat(length);
    remaining -= length;
  }
  assert.equal(remaining, 0);
  const boundary = decode(),
    sizes = ratingCategoryScopedRequestBodyBytes(boundary);
  assert.equal(
    sizes.prepare,
    Buffer.byteLength(JSON.stringify(boundary), 'utf8'),
  );
  assert.equal(sizes.cancel, sizes.prepare);
  assert.equal(
    sizes.status,
    0,
    'GET status has no request body, and its response is not counted',
  );
  assert.equal(
    sizes.commit,
    Buffer.byteLength(
      JSON.stringify({
        intent: boundary,
        preparationContextRevision: 'p'.repeat(43),
      }),
      'utf8',
    ),
  );
  assert.equal(sizes.maximum, sizes.commit);
  assert.equal(sizes.maximum, RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET);
  assert.ok(sizes.prepare < sizes.commit);
  assert.deepEqual(
    ratingCategoryScopedCommitEnvelope(boundary, 'p'.repeat(43)),
    { intent: boundary, preparationContextRevision: 'p'.repeat(43) },
  );
  nodes.find((node) => node.description.length < 500)!.description += 'x';
  const justOver = ratingCategoryScopedRequestBodyBytes(decode());
  assert.equal(justOver.maximum, RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET + 1);
  assert.ok(
    justOver.prepare <= RATING_CATEGORY_SCOPED_DRAFT_BODY_BUDGET,
    'Checking just intent would miss this overflow',
  );
  assert.ok(
    justOver.commit < RATING_CATEGORY_SCOPED_HTTP_BODY_LIMIT,
    'Named reserve is enforced independently of the parser hard limit',
  );
});
