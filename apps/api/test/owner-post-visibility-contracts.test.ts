import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  ownerVisibilityCommandSchema,
  ownerVisibilityManagementSchema,
  ownerVisibilityReceiptSchema,
} from '../src/community/owner-visibility/contracts.js';
import { ownerVisibilityIntentHash } from '../src/community/owner-visibility/service.js';

test('owner visibility is a strict desired-state versioned command, never a toggle or authority DTO', () => {
  const input = {
    clientRequestId: randomUUID(),
    postId: randomUUID(),
    ownerHidden: true,
    expectedVersion: 0,
  };
  assert.deepEqual(ownerVisibilityCommandSchema.parse(input), input);
  assert.deepEqual(
    ownerVisibilityCommandSchema.parse({
      ...input,
      clientRequestId: input.clientRequestId.toUpperCase(),
      postId: input.postId.toUpperCase(),
    }),
    input,
  );
  for (const extra of [
    { actorId: randomUUID() },
    { role: 'super_admin' },
    { hidden: 1 },
    { toggle: true },
    { operation: 'delete' },
    { visibility: 'approved' },
    { content: 'unreviewed' },
  ])
    assert.equal(
      ownerVisibilityCommandSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
  for (const expectedVersion of [
    -1,
    0.5,
    '0',
    null,
    2147483647,
    Number.MAX_SAFE_INTEGER,
  ])
    assert.equal(
      ownerVisibilityCommandSchema.safeParse({ ...input, expectedVersion })
        .success,
      false,
    );
  for (const ownerHidden of [0, 1, 'true', null, undefined])
    assert.equal(
      ownerVisibilityCommandSchema.safeParse({ ...input, ownerHidden }).success,
      false,
    );
  const actor = randomUUID(),
    parsed = ownerVisibilityCommandSchema.parse(input);
  assert.equal(
    ownerVisibilityIntentHash(actor, parsed),
    ownerVisibilityIntentHash(actor, { ...parsed }),
  );
  assert.notEqual(
    ownerVisibilityIntentHash(actor, parsed),
    ownerVisibilityIntentHash(randomUUID(), parsed),
  );
  assert.notEqual(
    ownerVisibilityIntentHash(actor, parsed),
    ownerVisibilityIntentHash(actor, { ...parsed, ownerHidden: false }),
  );
  assert.notEqual(
    ownerVisibilityIntentHash(actor, parsed),
    ownerVisibilityIntentHash(actor, { ...parsed, expectedVersion: 1 }),
  );
});
test('management and recovery projections contain no content or anonymous author identity', () => {
  const postId = randomUUID(),
    requestId = randomUUID();
  const management = { postId, ownerHidden: true, version: 1, canChange: true };
  assert.equal(
    ownerVisibilityManagementSchema.safeParse(management).success,
    true,
  );
  for (const extra of [
    { accountId: randomUUID() },
    { text: 'secret' },
    { imageUrls: [] },
    { authorMode: 'anonymous' },
  ])
    assert.equal(
      ownerVisibilityManagementSchema.safeParse({ ...management, ...extra })
        .success,
      false,
    );
  assert.equal(
    ownerVisibilityReceiptSchema.safeParse({
      requestId,
      postId,
      ownerHidden: true,
      expectedVersion: 0,
      outcome: 'applied',
      version: 1,
      changed: true,
      recordedAt: new Date().toISOString(),
    }).success,
    true,
  );
  assert.equal(
    ownerVisibilityReceiptSchema.safeParse({
      requestId,
      postId,
      ownerHidden: false,
      expectedVersion: 4,
      outcome: 'rejected',
      code: 'POST_OWNER_VISIBILITY_CANCELLED',
    }).success,
    true,
  );
});
