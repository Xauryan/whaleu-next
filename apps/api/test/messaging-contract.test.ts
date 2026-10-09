import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  dmOpenSchema,
  dmSendSchema,
  dmDisplaySchema,
  dmMessageSchema,
  dmReceiptSchema,
  dmSequence,
} from '../src/messaging/contracts.js';
import { encodeDmCursor, decodeDmCursor } from '../src/messaging/cursor.js';
test('DM strict immutable intent rejects hidden identity and media injection', () => {
  const open = {
    clientRequestId: randomUUID(),
    entry: { kind: 'profile', profileId: randomUUID() },
    initiationMode: 'named',
  };
  assert.ok(dmOpenSchema.safeParse(open).success);
  for (const extra of [
    { accountId: randomUUID() },
    { peerAccountId: randomUUID() },
    { personaId: randomUUID() },
    { approvalId: randomUUID() },
  ])
    assert.equal(dmOpenSchema.safeParse({ ...open, ...extra }).success, false);
  const text = { clientRequestId: randomUUID(), text: 'one\r\ntwo' };
  assert.equal(dmSendSchema.parse(text).text, 'one\ntwo');
  for (const value of [' '.repeat(3), '😀'.repeat(501), 'a\u0000b', '\ud800'])
    assert.equal(
      dmSendSchema.safeParse({ ...text, text: value }).success,
      false,
    );
  assert.ok(
    dmSendSchema.safeParse({ ...text, text: '😀'.repeat(500) }).success,
  );
  assert.equal(
    dmSendSchema.safeParse({ ...text, assetIds: [] }).success,
    false,
  );
  assert.equal(
    dmOpenSchema.safeParse({
      ...open,
      entry: { kind: 'reply', postId: randomUUID(), replyId: randomUUID() },
    }).success,
    false,
  );
});
test('DM response types cannot attach profiles to anonymous identities or revive recalled bodies', () => {
  assert.equal(
    dmDisplaySchema.safeParse({
      mode: 'anonymous',
      displayName: '鲸鱼',
      profileId: randomUUID(),
    }).success,
    false,
  );
  const message = {
    id: randomUUID(),
    sequence: '9007199254740993',
    sender: 'peer',
    state: 'recalled',
    text: null,
    createdAt: new Date().toISOString(),
    canRecall: false,
  };
  assert.ok(dmMessageSchema.safeParse(message).success);
  assert.equal(
    dmMessageSchema.safeParse({ ...message, text: 'secret' }).success,
    false,
  );
  assert.equal(dmSequence.safeParse('9223372036854775808').success, false);
  assert.equal(dmSequence.safeParse('01').success, false);
  const receipt = {
    requestId: randomUUID(),
    operation: 'send',
    outcome: 'applied',
    conversationId: randomUUID(),
    messageId: randomUUID(),
    occurredAt: new Date().toISOString(),
  };
  assert.ok(dmReceiptSchema.safeParse(receipt).success);
  assert.equal(
    dmReceiptSchema.safeParse({ ...receipt, text: 'secret' }).success,
    false,
  );
});
test('DM cursors bind owner, purpose, conversation and exact limits without account IDs', () => {
  const actor = randomUUID(),
    conversation = randomUUID();
  const value = encodeDmCursor(actor, {
    purpose: 'events',
    conversation,
    sequence: '9007199254740993',
    epoch: '0',
    at: null,
    id: null,
    limit: 20,
  });
  assert.equal(
    decodeDmCursor(value, actor, 'events', conversation, 20).sequence,
    '9007199254740993',
  );
  assert.equal(
    Buffer.from(value, 'base64url').toString().includes(actor),
    false,
  );
  for (const args of [
    [randomUUID(), 'events', conversation, 20],
    [actor, 'history', conversation, 20],
    [actor, 'events', randomUUID(), 20],
    [actor, 'events', conversation, 10],
  ] as const)
    assert.throws(() =>
      decodeDmCursor(value, args[0], args[1], args[2], args[3]),
    );
});
