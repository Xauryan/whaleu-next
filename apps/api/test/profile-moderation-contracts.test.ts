import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  moderationCommandSchema,
  moderationManagementSchema,
  moderationReceiptSchema,
  moderationRecoverySchema,
  moderationTargetSchema,
} from '../src/profile/moderation/contracts.js';
import { moderationIntentHash } from '../src/profile/moderation/evidence.js';

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const eventId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const command = {
  clientRequestId: requestId,
  target: { kind: 'post' as const, id: targetId },
  expectedProfileRevision: 0,
  action: 'reset_nickname' as const,
};
const base = {
  requestId,
  target: command.target,
  expectedProfileRevision: 0,
  action: command.action,
};
const applied = {
  ...base,
  outcome: 'applied' as const,
  revision: 1,
  eventId,
  recordedAt: '2026-10-12T16:00:00.000Z',
};

test('nickname moderation accepts only a content-bound post, comment or reply target', () => {
  for (const kind of ['post', 'comment', 'reply']) {
    assert.ok(moderationTargetSchema.safeParse({ kind, id: targetId }).success);
    assert.ok(
      moderationCommandSchema.safeParse({
        ...command,
        target: { kind, id: targetId },
      }).success,
    );
  }
  for (const target of [
    { kind: 'profile', id: targetId },
    { kind: 'account', id: targetId },
    { kind: 'post', id: '1' },
    { kind: 'post', id: targetId, accountId: actorId },
    { kind: 'comment', id: targetId, postId: eventId },
    { kind: 'reply', id: targetId, originalRegionId: eventId },
  ])
    assert.equal(
      moderationCommandSchema.safeParse({ ...command, target }).success,
      false,
    );
});

test('strict nickname command rejects authority, arbitrary nickname, avatar and unbounded CAS injection', () => {
  for (const key of [
    'actorId',
    'subjectAccountId',
    'accountId',
    'profileId',
    'regionId',
    'spaceId',
    'grantId',
    'nickname',
    'avatar',
    'canReset',
    'displayName',
  ])
    assert.equal(
      moderationCommandSchema.safeParse({ ...command, [key]: targetId })
        .success,
      false,
      key,
    );
  for (const action of ['reset_avatar', 'nickname', 'set_nickname', ''])
    assert.equal(
      moderationCommandSchema.safeParse({ ...command, action }).success,
      false,
    );
  for (const expectedProfileRevision of [-1, 0.5, 2147483647, Number.NaN, '0'])
    assert.equal(
      moderationCommandSchema.safeParse({
        ...command,
        expectedProfileRevision,
      }).success,
      false,
    );
  assert.ok(
    moderationCommandSchema.safeParse({
      ...command,
      expectedProfileRevision: 2147483646,
    }).success,
  );
  assert.equal(
    moderationCommandSchema.safeParse({
      ...command,
      clientRequestId: 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa',
    }).success,
    false,
  );
});

test('management exposes exactly target display and shared Profile revision, never a private identity', () => {
  const management = {
    target: command.target,
    displayName: 'SyntheticName',
    revision: 3,
    canReset: true,
  };
  assert.ok(moderationManagementSchema.safeParse(management).success);
  for (const key of ['accountId', 'profileId', 'subjectId', 'avatar', 'grant'])
    assert.equal(
      moderationManagementSchema.safeParse({ ...management, [key]: actorId })
        .success,
      false,
    );
  assert.equal(
    moderationManagementSchema.safeParse({ ...management, canReset: false })
      .success,
    false,
  );
});

test('applied receipt proves exactly one shared revision step without old or new profile data', () => {
  assert.ok(moderationReceiptSchema.safeParse(applied).success);
  for (const revision of [0, 2, 2147483647])
    assert.equal(
      moderationReceiptSchema.safeParse({ ...applied, revision }).success,
      false,
    );
  assert.ok(
    moderationReceiptSchema.safeParse({
      ...applied,
      expectedProfileRevision: 2147483646,
      revision: 2147483647,
    }).success,
  );
  for (const patch of [
    { eventId: null },
    { outcome: 'unchanged' },
    { accountId: actorId },
    { profileId: targetId },
    { nickname: '违规昵称Abc123' },
    { oldNickname: 'SyntheticName' },
    { displayName: '违规昵称Abc123' },
    { avatar: null },
  ])
    assert.equal(
      moderationReceiptSchema.safeParse({ ...applied, ...patch }).success,
      false,
    );
});

test('rejected and recovered receipts retain only the original intent and terminal result', () => {
  for (const code of [
    'PROFILE_MODERATION_STALE',
    'PROFILE_MODERATION_CANCELLED',
  ]) {
    const receipt = { ...base, outcome: 'rejected', code };
    assert.ok(moderationReceiptSchema.safeParse(receipt).success);
    assert.ok(
      moderationRecoverySchema.safeParse({ state: 'recorded', receipt })
        .success,
    );
    assert.equal(
      moderationReceiptSchema.safeParse({ ...receipt, currentRevision: 4 })
        .success,
      false,
    );
  }
  assert.ok(
    moderationRecoverySchema.safeParse({ state: 'not_recorded' }).success,
  );
  for (const patch of [
    { canReplaceKey: true },
    { target: command.target },
    { accountId: actorId },
  ])
    assert.equal(
      moderationRecoverySchema.safeParse({ state: 'not_recorded', ...patch })
        .success,
      false,
    );
});

test('intent hash binds actor, original request, exact target and expected shared revision', () => {
  const value = moderationIntentHash(actorId, command);
  assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(
    moderationIntentHash(actorId, {
      action: command.action,
      expectedProfileRevision: 0,
      target: { id: targetId, kind: 'post' },
      clientRequestId: requestId,
    }),
    value,
    'JSON object insertion order is not part of the intent',
  );
  assert.notEqual(moderationIntentHash(eventId, command), value);
  for (const change of [
    { clientRequestId: eventId },
    { target: { kind: 'comment' as const, id: targetId } },
    { target: { kind: 'post' as const, id: eventId } },
    { expectedProfileRevision: 1 },
  ])
    assert.notEqual(
      moderationIntentHash(actorId, { ...command, ...change }),
      value,
    );
});
