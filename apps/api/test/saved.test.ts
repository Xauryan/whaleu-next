import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  saveRequestSchema,
  savedPageQuerySchema,
  savedStatusSchema,
  updatePreferenceSchema,
} from '../src/community/saved/contracts.js';
import { savedIntentHash } from '../src/community/saved/mutation.service.js';
import {
  encodeSavedCursor,
  savedCursor,
} from '../src/community/saved/cursor.js';
import { preferenceReason } from '../src/community/saved/read.service.js';
import { requireAction } from '../src/community/community-policy.js';
import { verified } from './support/community-fixtures.js';
test('saved strict desired-state bodies, channels and bounded list/status queries', () => {
  const id = randomUUID();
  assert.deepEqual(saveRequestSchema.parse({ clientRequestId: id }), {
    clientRequestId: id,
  });
  for (const input of [
    {},
    { clientRequestId: id, actor: id },
    { clientRequestId: id, desired: true },
  ])
    assert.equal(saveRequestSchema.safeParse(input).success, false);
  for (const channel of ['saved', 'external'])
    assert.ok(
      updatePreferenceSchema.safeParse({
        clientRequestId: id,
        channel,
        enabled: false,
      }).success,
    );
  for (const input of [
    { channel: 'all', enabled: true },
    { channel: 'saved', enabled: 1 },
    { channel: 'external', enabled: true, notificationsEnabled: false },
  ])
    assert.equal(
      updatePreferenceSchema.safeParse({ clientRequestId: id, ...input })
        .success,
      false,
    );
  assert.deepEqual(savedPageQuerySchema.parse({}), { limit: 20 });
  for (const limit of ['0', '51', '100', '01', '-1'])
    assert.equal(savedPageQuerySchema.safeParse({ limit }).success, false);
  assert.equal(
    savedPageQuerySchema.safeParse({ limit: '50', campusId: id }).success,
    false,
  );
  assert.equal(
    savedStatusSchema.safeParse({ postIds: [id, id.toUpperCase()] }).success,
    false,
  );
  assert.equal(savedStatusSchema.safeParse({ postIds: [] }).success, false);
  assert.equal(
    savedStatusSchema.safeParse({
      postIds: Array.from({ length: 101 }, () => randomUUID()),
    }).success,
    false,
  );
  assert.deepEqual(savedStatusSchema.parse({ postIds: [id.toUpperCase()] }), {
    postIds: [id],
  });
});
test('saved intent hashes bind target, operation, desired value and independent channel', () => {
  const intent = {
    operation: 'set_post_saved' as const,
    postId: randomUUID(),
    desired: true,
    channel: null,
  };
  const hash = savedIntentHash(intent);
  assert.equal(
    hash,
    savedIntentHash({ ...intent, postId: intent.postId.toUpperCase() }),
  );
  for (const changed of [
    { ...intent, desired: false },
    { ...intent, postId: randomUUID() },
    {
      ...intent,
      operation: 'set_post_update_preference' as const,
      channel: 'saved' as const,
    },
    {
      ...intent,
      operation: 'set_post_update_preference' as const,
      channel: 'external' as const,
    },
  ])
    assert.notEqual(hash, savedIntentHash(changed));
});
test('Saved cursors bind owner and page size and exclude parent identifiers', () => {
  const owner = randomUUID(),
    epoch = randomUUID(),
    at = new Date().toISOString();
  const cursor = encodeSavedCursor(at, epoch, owner, 20);
  assert.ok(!Buffer.from(cursor, 'base64url').toString('utf8').includes(owner));
  assert.deepEqual(savedCursor(cursor, owner, 20), { at, id: epoch });
  assert.throws(() => savedCursor(cursor, randomUUID(), 20));
  assert.throws(() => savedCursor(cursor, owner, 50));
  assert.throws(() => savedCursor('malformed', owner, 20));
  assert.equal(savedCursor(undefined, owner, 20), null);
});
test('save and preference gates are independent of student, campus identity and publication gates', () => {
  const authority = {
    ...verified(randomUUID()),
    studentVerified: false,
    identityRegionId: null,
    unverifiedCategories: [],
  };
  for (const action of ['save_post', 'set_post_update_preference'] as const)
    assert.doesNotThrow(() => requireAction(authority, action));
  assert.equal(preferenceReason(authority), null);
  assert.equal(preferenceReason(null), 'COMMUNITY_UNAVAILABLE');
  assert.equal(
    preferenceReason({ ...authority, phoneVerified: false }),
    'PHONE_VERIFICATION_REQUIRED',
  );
  assert.equal(
    preferenceReason({ ...authority, restrictedActions: ['save_post'] }),
    null,
  );
  assert.equal(
    preferenceReason({
      ...authority,
      restrictedActions: ['set_post_update_preference'],
    }),
    'COMMUNITY_ACTION_RESTRICTED',
  );
});
