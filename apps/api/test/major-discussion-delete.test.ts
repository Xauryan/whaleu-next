import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  majorDiscussionDeleteCapabilitySchema,
  majorDiscussionDeleteCapabilityQuerySchema,
  majorDiscussionDeleteSchema,
  majorDiscussionDeleteCancelSchema,
  majorDiscussionDeleteReceiptSchema,
} from '../src/majors/discussion/delete-contracts.js';
import { majorDiscussionDeleteIntentHash } from '../src/majors/discussion/delete-service.js';
const actor = '11111111-1111-4111-8111-111111111111',
  major = '22222222-2222-4222-8222-222222222222',
  comment = '33333333-3333-4333-8333-333333333333',
  key = '44444444-4444-4444-8444-444444444444';
test('independent strict Major logical delete command and minimum receipt', () => {
  const command = { clientRequestId: key, rootId: null };
  assert.deepEqual(majorDiscussionDeleteSchema.parse(command), command);
  for (const invalid of [
    { ...command, body: 'hidden' },
    { clientRequestId: key },
    { ...command, rootId: 'not-an-id' },
    { ...command, expectedCatalogRevision: major },
  ])
    assert.equal(majorDiscussionDeleteSchema.safeParse(invalid).success, false);
  assert.equal(
    majorDiscussionDeleteCancelSchema.safeParse({
      operation: 'major.discussion.delete.v1',
      majorId: major,
      commentId: comment,
      command,
    }).success,
    true,
  );
  const receipt = {
    requestId: key,
    operation: 'major.discussion.delete.v1',
    majorId: major,
    commentId: comment,
    rootId: null,
    outcome: 'applied',
    tombstoneId: actor,
    recordedAt: '2026-10-12T08:00:00.000Z',
  };
  assert.deepEqual(majorDiscussionDeleteReceiptSchema.parse(receipt), receipt);
  assert.equal(
    majorDiscussionDeleteReceiptSchema.safeParse({ ...receipt, body: 'secret' })
      .success,
    false,
  );
  const hash = majorDiscussionDeleteIntentHash(actor, major, comment, command);
  assert.equal(
    hash,
    majorDiscussionDeleteIntentHash(actor, major, comment, {
      rootId: null,
      clientRequestId: key,
    }),
  );
  assert.notEqual(
    hash,
    majorDiscussionDeleteIntentHash(actor, major, comment, {
      ...command,
      rootId: major,
    }),
  );
  assert.notEqual(
    hash,
    majorDiscussionDeleteIntentHash(actor, major, actor, command),
  );
});

test('delete capability is independent strict locator and boolean only', () => {
  const capability = {
    majorId: major,
    commentId: comment,
    rootId: null,
    allowed: false,
  };
  assert.deepEqual(
    majorDiscussionDeleteCapabilitySchema.parse(capability),
    capability,
  );
  for (const extra of [
    { body: 'hidden' },
    { authorId: actor },
    { role: 'super_admin' },
    { source: major },
  ])
    assert.equal(
      majorDiscussionDeleteCapabilitySchema.safeParse({
        ...capability,
        ...extra,
      }).success,
      false,
    );
  assert.equal(
    majorDiscussionDeleteCapabilityQuerySchema.safeParse({}).success,
    true,
  );
  assert.equal(
    majorDiscussionDeleteCapabilityQuerySchema.safeParse({ rootId: actor })
      .success,
    true,
  );
  assert.equal(
    majorDiscussionDeleteCapabilityQuerySchema.safeParse({ rootId: null })
      .success,
    false,
  );
});
