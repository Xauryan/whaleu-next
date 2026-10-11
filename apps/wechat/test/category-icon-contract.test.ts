import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  decodeRatingCategoryScopedIntent,
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedOperations,
} from '../src/ratings/category-scoped-contract';
import {
  decodeRatingCategoryIconIntent,
  categoryIconTextIntent,
  categoryIconTextHash,
  ratingCategoryIconIntentHash,
  decodeRatingCategoryIconReceipt,
  decodeRatingCategoryIconContext,
  decodeRatingManagedIconCategory,
  ratingCategoryIconRequestBodyBytes,
} from '../src/ratings/category-icon-contract';
import {
  categoryIconDraftSlots,
  sealCategoryIconDraft,
} from '../src/ratings/category-icon-draft';
import {
  decodeCategoryIconScopeInput,
  categoryIconScopeRequestHash,
} from '../src/ratings/category-icon-upload-scope';
import { canonicalRatingScopedJson } from '../src/ratings/scoped-contract';
import { managementIntent, managementContext } from './category-scoped-helpers';
import {
  iconContext,
  iconIntent,
  iconReceipt,
  iconCategory,
  iconId,
  mediaSnapshot,
} from './category-icon-helpers';
test('all original nine operations keep frozen text projection while protocol5 hash is independent', () => {
  for (const operation of ratingCategoryScopedOperations) {
    const intent = iconIntent(operation),
      text = managementIntent(operation);
    assert.deepEqual(categoryIconTextIntent(intent), text);
    assert.equal(
      categoryIconTextHash(intent),
      ratingCategoryScopedIntentHash(text),
    );
    assert.equal(
      ratingCategoryIconIntentHash(intent),
      createHash('sha256')
        .update(
          'ratings-category-icon-command:v1:' +
            canonicalRatingScopedJson(intent),
        )
        .digest('hex'),
    );
    assert.throws(() => decodeRatingCategoryScopedIntent(intent));
    assert.throws(() => decodeRatingCategoryIconIntent(text));
  }
});
test('base keep clear replace and override inherit explicit null keep replace are strict', () => {
  const base = iconIntent();
  for (const icon of [
    { mode: 'keep' },
    { mode: 'clear' },
    { mode: 'replace', assetId: iconId(1), uploadScopeId: iconId(2) },
  ])
    assert.doesNotThrow(() =>
      decodeRatingCategoryIconIntent({
        ...base,
        payload: { ...base.payload, icon },
      }),
    );
  const override = iconIntent('set_category_override_scoped');
  for (const icon of [
    { mode: 'inherit' },
    { mode: 'set', value: null },
    { mode: 'set', value: { mode: 'keep' } },
    {
      mode: 'set',
      value: { mode: 'replace', assetId: iconId(1), uploadScopeId: iconId(2) },
    },
  ])
    assert.doesNotThrow(() =>
      decodeRatingCategoryIconIntent({
        ...override,
        payload: { ...override.payload, icon },
      }),
    );
  for (const icon of [
    null,
    { mode: 'set', value: { mode: 'clear' } },
    { mode: 'replace', assetId: iconId(1), uploadScopeId: iconId(2) },
    { mode: 'inherit', url: 'https://untrusted.invalid' },
  ])
    assert.throws(() =>
      decodeRatingCategoryIconIntent({
        ...override,
        payload: { ...override.payload, icon },
      }),
    );
  const metadata = iconIntent('set_category_visibility_scoped');
  assert.throws(() =>
    decodeRatingCategoryIconIntent({
      ...metadata,
      payload: { ...metadata.payload, icon: { mode: 'keep' } },
    }),
  );
});
test('32 atomic new icons have one exact asset and scope each; pending has no fabricated asset', () => {
  const text = managementIntent('batch_update_subcategories_scoped');
  if (text.operation !== 'batch_update_subcategories_scoped')
    throw new Error('fixture');
  const nodes = Array.from({ length: 32 }, (_, i) => ({
    key: `n${i}`,
    parentKey: null,
    name: `节点${i}`,
    description: '',
  }));
  const draft = decodeRatingCategoryScopedIntent({
    ...text,
    payload: {
      ...text.payload,
      addNodes: nodes,
      orderedChildren: nodes.map((n) => ({ kind: 'new', key: n.key })),
    },
  });
  const slots = categoryIconDraftSlots(
    draft,
    new Map(nodes.map((n) => [`new:${n.key}`, 'replace' as const])),
  );
  assert.throws(() => sealCategoryIconDraft(draft, mediaSnapshot, slots, []));
  const ready = slots.map((s, i) => ({
    slotKey: s.key,
    assetId: iconId(100 + i),
    uploadScopeId: iconId(200 + i),
  }));
  const intent = sealCategoryIconDraft(draft, mediaSnapshot, slots, ready);
  assert.deepEqual(categoryIconTextIntent(intent), draft);
  assert.throws(() =>
    sealCategoryIconDraft(
      draft,
      mediaSnapshot,
      slots,
      ready.map((r, i) => (i === 1 ? { ...r, assetId: ready[0]!.assetId } : r)),
    ),
  );
  assert.throws(() =>
    sealCategoryIconDraft(
      draft,
      mediaSnapshot,
      slots,
      ready.map((r, i) =>
        i === 1 ? { ...r, uploadScopeId: ready[0]!.uploadScopeId } : r,
      ),
    ),
  );
});
test('same text projection fixes future category identities before asset exists', () => {
  const text = managementIntent('create_system_category_scoped');
  const slots = categoryIconDraftSlots(
    text,
    new Map([['new:root', 'replace']]),
  );
  const a = sealCategoryIconDraft(text, mediaSnapshot, slots, [
      { slotKey: 'new:root', assetId: iconId(1), uploadScopeId: iconId(2) },
    ]),
    b = sealCategoryIconDraft(text, mediaSnapshot, slots, [
      { slotKey: 'new:root', assetId: iconId(3), uploadScopeId: iconId(4) },
    ]);
  assert.equal(categoryIconTextHash(a), categoryIconTextHash(b));
  assert.notEqual(
    ratingCategoryIconIntentHash(a),
    ratingCategoryIconIntentHash(b),
  );
  const scope = decodeCategoryIconScopeInput({
    ...text,
    protocolVersion: 5,
    mediaSnapshot,
    clientRequestId: iconId(5),
    draftRevision: iconId(6),
    slot: { kind: 'new', key: 'root' },
    declaration: { mime: 'image/png', bytes: 123, sha256: 'a'.repeat(64) },
  });
  assert.equal(
    categoryIconScopeRequestHash(scope),
    createHash('sha256')
      .update(
        'ratings-category-icon-upload-scope:v1:' +
          canonicalRatingScopedJson(scope),
      )
      .digest('hex'),
  );
  assert.throws(() =>
    decodeCategoryIconScopeInput({
      ...scope,
      slot: { kind: 'new', key: 'system' },
    }),
  );
  assert.throws(() =>
    decodeCategoryIconScopeInput({
      ...scope,
      clientRequestId: text.payload.clientRequestId,
    }),
  );
});
test('context and receipt5 preserve exact old fields and reject version or capability borrowing', () => {
  assert.throws(() => decodeRatingCategoryIconContext(managementContext()));
  assert.throws(() =>
    decodeRatingCategoryIconContext({
      ...iconContext(),
      capabilities: ['target_cover'],
    }),
  );
  assert.throws(() =>
    decodeRatingCategoryIconReceipt({ ...iconReceipt(), protocolVersion: 2 }),
  );
  const receipt = iconReceipt();
  if (receipt.outcome === 'closed') throw new Error('fixture');
  assert.throws(() =>
    decodeRatingCategoryIconReceipt({
      ...receipt,
      result: { ...receipt.result, mediaReleaseDigest: null },
    }),
  );
});
test('absence inheritance and unavailable states never collapse into one another', () => {
  const category = iconCategory();
  assert.throws(() =>
    decodeRatingManagedIconCategory({
      ...category,
      icon: {
        ...category.icon,
        base: { state: 'inherit', appearanceId: null },
      },
    }),
  );
  assert.throws(() =>
    decodeRatingManagedIconCategory({
      ...category,
      icon: {
        ...category.icon,
        override: {
          mode: 'set',
          state: { state: 'inherit', appearanceId: null },
        },
      },
    }),
  );
  assert.doesNotThrow(() =>
    decodeRatingManagedIconCategory({
      ...category,
      icon: {
        ...category.icon,
        effective: { state: 'unavailable', appearanceId: null },
      },
    }),
  );
});
test('request budget measures real Unicode escaping, final and cancel wrapper plus fixed reserve', () => {
  const intent = iconIntent();
  const sizes = ratingCategoryIconRequestBodyBytes(intent);
  assert.equal(sizes.prepare, Buffer.byteLength(JSON.stringify(intent)));
  assert.equal(sizes.cancel, sizes.prepare);
  assert.equal(
    sizes.commit,
    Buffer.byteLength(
      JSON.stringify({ intent, preparationContextRevision: '0'.repeat(43) }),
    ),
  );
  assert.equal(sizes.maximum, sizes.commit);
});
