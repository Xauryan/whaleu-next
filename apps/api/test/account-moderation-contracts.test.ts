import { z } from 'zod';
import { adminPostRemovalReceiptSchema } from '../src/community/admin-removal/contracts.js';
import { adminDiscussionRemovalReceiptSchema } from '../src/community/admin-discussion-removal/contracts.js';
import { punishmentReferenceOutputSchema } from '../src/safety/account-moderation/contracts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  punishmentSelectionSchema,
  punishmentStatusSchema,
  punishmentReferenceSchema,
  punishmentReleaseCommandSchema,
  appealSubmitCommandSchema,
} from '../src/safety/account-moderation/contracts.js';
import {
  moderationCursor,
  encodeModerationCursor,
} from '../src/safety/account-moderation/cursor.js';
const id = '10000000-0000-4000-8000-000000000001';
const reference = { punishmentId: id, kind: 'interaction_mute', revision: '1' };

test('punishment kinds have independent exact revisions, never Identity status', () => {
  for (const kind of ['interaction_mute', 'access_suspension'])
    assert.equal(
      punishmentSelectionSchema.parse({
        kind,
        duration: { kind: 'finite', unit: 'days', value: 7 },
        reason: ' Moderation reason ',
        expectedRevision: '0',
      }).reason,
      'Moderation reason',
    );
  for (const kind of ['blocked', 'banned', 'all', 'verified'])
    assert.equal(
      punishmentSelectionSchema.safeParse({
        kind,
        duration: { kind: 'permanent' },
        reason: 'reason',
        expectedRevision: '0',
      }).success,
      false,
    );
});
test('duration accepts explicit source units and rejects ambiguity, coercion and overflow', () => {
  for (const unit of ['minutes', 'hours', 'days'])
    assert.equal(
      punishmentSelectionSchema.safeParse({
        kind: 'interaction_mute',
        duration: { kind: 'finite', unit, value: 1 },
        reason: 'reason',
        expectedRevision: '0',
      }).success,
      true,
    );
  for (const value of [0, -1, 0.5, NaN, Infinity, 2147483648, '7'])
    assert.equal(
      punishmentSelectionSchema.safeParse({
        kind: 'interaction_mute',
        duration: { kind: 'finite', unit: 'days', value },
        reason: 'reason',
        expectedRevision: '0',
      }).success,
      false,
    );
  assert.equal(
    punishmentSelectionSchema.safeParse({
      kind: 'interaction_mute',
      duration: { kind: 'permanent', value: 7 },
      reason: 'reason',
      expectedRevision: '0',
    }).success,
    false,
  );
});
test('private commands contain an exact owned punishment but no caller subject or authority', () => {
  const command = {
    clientRequestId: id,
    action: 'submit_appeal',
    punishment: reference,
    text: 'Please review my case.',
  };
  assert.equal(appealSubmitCommandSchema.safeParse(command).success, true);
  for (const extra of [
    { subjectId: id },
    { administrator: true },
    { files: ['https://example.test/file'] },
    { public: true },
  ])
    assert.equal(
      appealSubmitCommandSchema.safeParse({ ...command, ...extra }).success,
      false,
    );
  assert.equal(
    punishmentReferenceSchema.safeParse({ ...reference, accountId: id })
      .success,
    false,
  );
  assert.equal(
    punishmentReleaseCommandSchema.safeParse({
      clientRequestId: id,
      action: 'release',
      punishment: reference,
      expectedStateVersion: 'a'.repeat(64),
      reason: 'Reviewed',
    }).success,
    true,
  );
});
test('unknown base coverage remains explicit after overlay expiry or release', () => {
  assert.deepEqual(
    punishmentStatusSchema.parse({
      coverage: 'unavailable',
      effective: 'unavailable',
      checkedAt: '2026-10-13T00:00:00.000Z',
      current: [],
    }).effective,
    'unavailable',
  );
  assert.equal(
    punishmentStatusSchema.safeParse({
      coverage: 'complete',
      effective: 'blocked',
      checkedAt: '2026-10-13T00:00:00.000Z',
      current: [],
    }).success,
    false,
  );
});
test('moderation cursors are bounded, actor and exact page-family bound', () => {
  const seek = { at: '2026-10-13T00:00:00.000Z', id };
  const cursor = encodeModerationCursor(seek, id, 'own', 20);
  assert.deepEqual(moderationCursor(cursor, id, 'own', 20), seek);
  for (const args of [
    [id, 'admin', 20],
    ['20000000-0000-4000-8000-000000000001', 'own', 20],
    [id, 'own', 50],
  ] as const)
    assert.throws(() => moderationCursor(cursor, args[0], args[1], args[2]));
  assert.throws(() => moderationCursor(cursor + '=', id, 'own', 20));
});

test('documented punishment references preserve canonical input while strict output has no transforms', () => {
  const reference = {
    punishmentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'interaction_mute' as const,
    revision: '1',
  };
  assert.deepEqual(
    punishmentReferenceSchema.parse({
      ...reference,
      punishmentId: reference.punishmentId.toUpperCase(),
    }),
    reference,
  );
  assert.deepEqual(punishmentReferenceOutputSchema.parse(reference), reference);
  assert.equal(
    punishmentReferenceOutputSchema.safeParse({
      ...reference,
      punishmentId: reference.punishmentId.toUpperCase(),
    }).success,
    false,
  );
  const json = z.toJSONSchema(punishmentReferenceOutputSchema);
  assert.equal(json.additionalProperties, false);
  const patterns = (
    json.properties!['punishmentId'] as { allOf: { pattern: string }[] }
  ).allOf.map((item) => new RegExp(item.pattern));
  assert.equal(patterns.length, 2);
  assert.ok(patterns.every((pattern) => pattern.test(reference.punishmentId)));
  assert.equal(
    patterns.every((pattern) =>
      pattern.test(reference.punishmentId.toUpperCase()),
    ),
    false,
  );
  assert.doesNotThrow(() => z.toJSONSchema(adminPostRemovalReceiptSchema));
  assert.doesNotThrow(() =>
    z.toJSONSchema(adminDiscussionRemovalReceiptSchema),
  );
});
