import assert from 'node:assert/strict';
import test from 'node:test';
import { SyntheticDeletionMedia } from '../src/account-deletion/synthetic-media.js';
test('only exact owned versions disappear; shared version survives', () => {
  const media = new SyntheticDeletionMedia(),
    own = media.create(['owner'], Buffer.from('private')),
    shared = media.create(['owner', 'other'], Buffer.from('shared'));
  assert.equal(
    media.settle('owner', 'request', media.cohortId).kind,
    'complete',
  );
  assert.equal(media.exists(own), false);
  assert.equal(media.exists(shared), true);
  assert.equal(
    media.settle('owner', 'request', media.cohortId).kind,
    'complete',
  );
});
test('active writers must actually retire; observation/timeouts do not manufacture quiescence', () => {
  const media = new SyntheticDeletionMedia(),
    own = media.create(['owner'], Buffer.from('private')),
    writer = media.writer(own);
  for (let i = 0; i < 10; i++)
    assert.equal(
      media.settle('owner', 'request', media.cohortId).kind,
      'waiting',
    );
  writer.write(Buffer.from('late write'));
  writer.stop();
  assert.throws(() => writer.write(Buffer.from('resurrection')));
  assert.equal(
    media.settle('owner', 'request', media.cohortId).kind,
    'complete',
  );
  assert.equal(media.exists(own), false);
});
test('unknown effect is nonterminal and recoverable', () => {
  const media = new SyntheticDeletionMedia(),
    own = media.create(['owner'], Buffer.from('private'));
  media.setUnknown(own, true);
  assert.deepEqual(media.settle('owner', 'request', media.cohortId).pending, [
    'MEDIA_EFFECT_UNKNOWN',
  ]);
  assert.equal(media.exists(own), true);
  media.setUnknown(own, false);
  assert.equal(
    media.settle('owner', 'request', media.cohortId).kind,
    'complete',
  );
});
test('a new version after settlement invalidates final completion', () => {
  const media = new SyntheticDeletionMedia();
  media.create(['owner'], Buffer.from('old'));
  assert.equal(
    media.settle('owner', 'request', media.cohortId).kind,
    'complete',
  );
  media.create(['owner'], Buffer.from('new'));
  assert.deepEqual(media.settle('owner', 'request', media.cohortId).pending, [
    'MEDIA_INVENTORY_CHANGED',
  ]);
});

test('a replaced or missing storage cohort is unknown, never empty completion', () => {
  const original = new SyntheticDeletionMedia(),
    owned = original.create(['owner'], Buffer.from('still private')),
    writer = original.writer(owned),
    replacement = new SyntheticDeletionMedia();
  assert.notEqual(original.cohortId, replacement.cohortId);
  assert.deepEqual(replacement.settle('owner', 'request', original.cohortId), {
    kind: 'waiting',
    proof: null,
    pending: ['MEDIA_COHORT_UNAVAILABLE'],
  });
  assert.equal(replacement.settle('owner', 'request', null).kind, 'waiting');
  assert.equal(original.exists(owned), true);
  writer.write(Buffer.from('still writing'));
  assert.equal(
    original.settle('owner', 'request', original.cohortId).kind,
    'waiting',
  );
  writer.stop();
  assert.equal(
    original.settle('owner', 'request', original.cohortId).kind,
    'complete',
  );
});
