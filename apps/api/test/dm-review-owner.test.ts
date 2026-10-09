import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalDmEnvelope,
  dmApprovalDigest,
} from '../src/community/content-review/dm-contracts.js';
import type {
  DmContentEnvelope,
  DmMessageDescriptor,
} from '../src/community/content-review/dm-contracts.js';
import {
  dmBindingMatches,
  validateDmApprovalRow,
} from '../src/community/content-review/dm-approval-validation.js';
import type {
  DmApprovalBinding,
  DmApprovalRow,
} from '../src/community/content-review/dm-approval-validation.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 9);
function envelope(): DmContentEnvelope {
  return canonicalDmEnvelope({
    version: 1,
    purpose: 'send_private_message',
    accountId: id(1),
    clientRequestId: id(2),
    conversationId: id(3),
    contextDigest: 'a'.repeat(64),
    senderSlot: 0,
    participantModes: ['anonymous', 'named'],
    text: 'Synthetic private text',
    assetIds: [],
  });
}
function row(e = envelope()): DmApprovalRow {
  return {
    id: id(4),
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: 1,
    digest: dmApprovalDigest(e),
    envelope: e,
    policy_revision_id: id(5),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-dm-review',
    provenance_ref: 'synthetic-dm-fact',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now + 10000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic-policy',
    policy_provenance_ref: 'synthetic-policy',
    policy_valid_from: new Date(now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic-dm-review',
    event_provenance_ref: 'synthetic-dm-event',
    issuer_trusted: true,
    issuer_valid_until: null,
  };
}
function descriptor(): DmMessageDescriptor {
  return {
    messageId: id(6),
    conversationId: id(3),
    senderSlot: 0,
    sequence: '9007199254740993',
    envelope: envelope(),
  };
}
function binding(d = descriptor()): DmApprovalBinding {
  return {
    message_id: d.messageId,
    conversation_id: d.conversationId,
    sender_slot: d.senderSlot,
    message_seq: d.sequence,
    content_version: 1,
    decision_id: id(4),
    account_id: d.envelope.accountId,
    operation: d.envelope.purpose,
    envelope_version: 1,
    digest: dmApprovalDigest(d.envelope),
    envelope: d.envelope,
  };
}
test('DM envelope normalization is exact, frozen, purpose-bound and privately contextual', () => {
  const e = envelope();
  assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(e.participantModes));
  assert.ok(Object.isFrozen(e.assetIds));
  assert.equal(canonicalDmEnvelope({ ...e, text: 'a\r\nb' }).text, 'a\nb');
  for (const patch of [
    { purpose: 'publish_rating_comment' },
    { version: 2 },
    { assetIds: [id(9)] },
    { participantModes: ['anonymous'] },
    { senderSlot: 2 },
    { text: '\t\n\u3000' },
    { text: '\u0000' },
    { text: 'x'.repeat(501) },
    { text: '😀'.repeat(501) },
    { accountId: 'A0000000-0000-4000-8000-000000000001' },
    { clientRequestId: '10000000-0000-5000-8000-000000000001' },
    { approvalId: id(9) },
  ])
    assert.throws(() => canonicalDmEnvelope({ ...e, ...patch }));
});
test('every authority-relevant DM field participates in the approval digest', () => {
  const e = envelope(),
    base = dmApprovalDigest(e);
  const patches = [
    { text: 'Changed text' },
    { accountId: id(8) },
    { clientRequestId: id(8) },
    { conversationId: id(8) },
    { contextDigest: 'b'.repeat(64) },
    { senderSlot: 1 as const },
    { participantModes: ['named', 'named'] as ['named', 'named'] },
  ];
  for (const patch of patches)
    assert.notEqual(
      dmApprovalDigest(canonicalDmEnvelope({ ...e, ...patch })),
      base,
    );
});
test('untrusted/missing/wrong-purpose DM approval never grants and pending fails unavailable', () => {
  assert.equal(validateDmApprovalRow(row(), true, now).decision.kind, 'allow');
  assert.equal(
    validateDmApprovalRow(null, true, now).decision.kind,
    'unavailable',
  );
  for (const patch of [
    { issuer_trusted: false },
    { coverage: 'missing' },
    { provenance: 'unreconciled' },
    { operation: 'publish_rating_comment' },
    { digest: 'b'.repeat(64) },
    { account_id: id(9) },
    { envelope_version: 2 },
    { result: 'pending' as const },
    { result: 'failed' as const },
    { issuer_valid_until: new Date(now) },
    { policy_valid_until: new Date(now) },
  ])
    assert.equal(
      validateDmApprovalRow({ ...row(), ...patch }, true, now).decision.kind,
      'unavailable',
    );
});
test('consumption expiry does not expire committed durable messages, while hold and revocation suppress them', () => {
  const expired = { ...row(), consume_until: new Date(now - 1) };
  assert.equal(
    validateDmApprovalRow(expired, true, now).decision.kind,
    'unavailable',
  );
  assert.equal(
    validateDmApprovalRow(expired, false, now).decision.kind,
    'allow',
  );
  assert.equal(
    validateDmApprovalRow({ ...row(), state: 'held' }, true, now).decision.kind,
    'unavailable',
  );
  assert.equal(
    validateDmApprovalRow({ ...row(), state: 'held' }, false, now).decision
      .kind,
    'deny',
  );
  assert.equal(
    validateDmApprovalRow({ ...row(), state: 'revoked' }, false, now).decision
      .kind,
    'deny',
  );
  assert.equal(
    validateDmApprovalRow({ ...row(), result: 'reject' }, true, now).decision
      .kind,
    'deny',
  );
});
test('DM binding compares exact descriptor, body, modes, slot and bigint sequence', () => {
  const d = descriptor(),
    b = binding(d);
  assert.equal(dmBindingMatches(b, d), true);
  for (const patch of [
    { message_id: id(9) },
    { conversation_id: id(9) },
    { sender_slot: 1 },
    { message_seq: '9007199254740992' },
    { content_version: 2 },
    { account_id: id(9) },
    { operation: 'publish_post' },
    { envelope_version: 2 },
    { digest: 'b'.repeat(64) },
    { envelope: { ...d.envelope, text: 'other' } },
  ])
    assert.equal(dmBindingMatches({ ...b, ...patch }, d), false);
  for (const patch of [
    { messageId: id(9) },
    { conversationId: id(9) },
    { senderSlot: 1 as const },
    { sequence: '01' },
    { sequence: '9223372036854775808' },
    {
      envelope: canonicalDmEnvelope({
        ...d.envelope,
        participantModes: ['named', 'named'],
      }),
    },
  ])
    assert.equal(dmBindingMatches(b, { ...d, ...patch }), false);
});
