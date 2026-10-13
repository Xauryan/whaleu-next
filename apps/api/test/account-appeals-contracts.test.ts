import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  appealSubmitCommandSchema,
  appealDecisionCommandSchema,
  appealSubmitReceiptSchema,
  appealDecisionReceiptSchema,
  moderationRecoverySchema,
} from '../src/safety/account-moderation/contracts.js';
import {
  appealIntentHash,
  safeAppealText,
} from '../src/safety/account-appeals/evidence.js';
import {
  decodeAppealCursor,
  encodeAppealCursor,
} from '../src/safety/account-appeals/cursor.js';
const actor = randomUUID();
const submit = {
  clientRequestId: randomUUID(),
  action: 'submit_appeal' as const,
  punishment: {
    punishmentId: randomUUID(),
    kind: 'interaction_mute' as const,
    revision: '1',
  },
  text: '请复核这条处罚。\n仅作为私密申诉。',
};
test('appeal intent binds owner, exact punishment kind and revision, key, and private text', () => {
  assert.deepEqual(appealSubmitCommandSchema.parse(submit), submit);
  for (const extra of [
    { ownerId: actor },
    { accountId: actor },
    { recipientId: actor },
    { attachments: [] },
    { public: true },
    { provider: 'feedback' },
  ])
    assert.equal(
      appealSubmitCommandSchema.safeParse({ ...submit, ...extra }).success,
      false,
    );
  const hash = appealIntentHash(actor, submit);
  for (const altered of [
    { ...submit, text: '不同证据' },
    { ...submit, clientRequestId: randomUUID() },
    { ...submit, punishment: { ...submit.punishment, revision: '2' } },
    {
      ...submit,
      punishment: { ...submit.punishment, kind: 'access_suspension' as const },
    },
    {
      ...submit,
      punishment: { ...submit.punishment, punishmentId: randomUUID() },
    },
  ])
    assert.notEqual(appealIntentHash(actor, altered), hash);
  assert.notEqual(appealIntentHash(randomUUID(), submit), hash);
  assert.equal(
    appealSubmitCommandSchema.safeParse({ ...submit, text: 'x'.repeat(4001) })
      .success,
    false,
  );
  assert.equal(
    appealSubmitCommandSchema.safeParse({ ...submit, text: ' \n\t' }).success,
    false,
  );
});
test('private evidence remains literal text and disallows hidden transport/bidi controls', () => {
  assert.equal(
    safeAppealText(
      '<script>alert(1)</script>\n[link](https://example.com)\t引用',
    ),
    true,
  );
  for (const bad of ['\0', '\u0001', '\u007f', '\u0085', '\u202e', '\u2066'])
    assert.equal(safeAppealText(`text${bad}`), false);
});
test('decision names one immutable case and bounded reason, never caller recipient/account/release override', () => {
  const command = {
    clientRequestId: randomUUID(),
    action: 'decide_appeal',
    appealId: randomUUID(),
    expectedStateVersion: 'a'.repeat(64),
    decision: 'released',
    reason: '复核撤销此条处罚。',
  };
  assert.ok(appealDecisionCommandSchema.safeParse(command).success);
  for (const patch of [
    { decision: 'release_all' },
    { punishment: submit.punishment },
    { subjectId: actor },
    { grantId: randomUUID() },
    { reason: 'x'.repeat(256) },
    { expectedStateVersion: 'A'.repeat(64) },
  ])
    assert.equal(
      appealDecisionCommandSchema.safeParse({ ...command, ...patch }).success,
      false,
    );
});
test('minimal original-key receipts never contain appeal evidence or hidden identity', () => {
  const receipt = {
    requestId: submit.clientRequestId,
    action: submit.action,
    punishment: submit.punishment,
    outcome: 'applied',
    appealId: randomUUID(),
    recordedAt: '2026-10-13T08:00:00.000Z',
    reusedOpenCase: false,
  };
  assert.ok(appealSubmitReceiptSchema.safeParse(receipt).success);
  assert.ok(
    moderationRecoverySchema(appealSubmitReceiptSchema).safeParse({
      state: 'recorded',
      receipt,
    }).success,
  );
  for (const extra of [
    { text: submit.text },
    { actorId: actor },
    { sessionId: randomUUID() },
    { moderatorId: randomUUID() },
  ])
    assert.equal(
      appealSubmitReceiptSchema.safeParse({ ...receipt, ...extra }).success,
      false,
    );
  assert.ok(
    appealDecisionReceiptSchema.safeParse({
      requestId: randomUUID(),
      action: 'decide_appeal',
      appealId: receipt.appealId,
      outcome: 'applied',
      decision: 'closed_no_longer_effective',
      eventId: randomUUID(),
      recordedAt: receipt.recordedAt,
    }).success,
  );
});
test('appeal cursors are actor, own/management scope and page-size bound without plain account ID', () => {
  const seek = { at: '2026-10-13T08:00:00.000Z', id: randomUUID() };
  const cursor = encodeAppealCursor(seek, actor, false, 20);
  assert.deepEqual(decodeAppealCursor(cursor, actor, false, 20), seek);
  assert.equal(
    Buffer.from(cursor, 'base64url').toString().includes(actor),
    false,
  );
  assert.throws(() => decodeAppealCursor(cursor, randomUUID(), false, 20));
  assert.throws(() => decodeAppealCursor(cursor, actor, true, 20));
  assert.throws(() => decodeAppealCursor(cursor, actor, false, 50));
  assert.throws(() => decodeAppealCursor(cursor + '=', actor, false, 20));
  assert.equal(decodeAppealCursor(undefined, actor, true, 50), null);
});
