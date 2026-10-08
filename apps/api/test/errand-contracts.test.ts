import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  publishErrandSchema,
  acceptErrandSchema,
  errandRewardSchema,
  errandText,
  errandReceiptSchema,
  errandDetailSchema,
  errandPageSchema,
} from '../src/errands/contracts.js';
import { evaluateErrandRestrictions } from '../src/safety/errand.facade.js';
import { temporaryErrandBaseStatus } from '../src/verification/errand-base.source.js';
const base = () => ({
  clientRequestId: randomUUID(),
  targetRegionId: randomUUID(),
  title: 'Errand',
  publicText: 'Public description',
  privateText: 'Private description',
  expectedTimeText: 'Tomorrow after lunch',
  reward: '1.1234567890123456789',
  publisherContacts: { wechat: 'synthetic_wechat', phone: '12345678901' },
  publicAssetIds: [],
  privateAssetIds: [],
});
test('errand exact decimal reward has no cent rounding or Number conversion', () => {
  for (const [input, expected] of [
    ['1', '1'],
    ['1.00000000000000000000000', '1'],
    [
      '499.999999999999999999999999999999999999',
      '499.999999999999999999999999999999999999',
    ],
    ['500.0000000000000', '500'],
    ['1.' + '2'.repeat(99), '1.' + '2'.repeat(99)],
  ])
    assert.equal(errandRewardSchema.parse(input), expected);
  for (const input of [
    '0.99999999999999999999999',
    '500.00000000000000000000001',
    '501',
    '01',
    '1e2',
    '+2',
    '2.',
    '1.' + '2'.repeat(100),
    1,
    NaN,
  ])
    assert.equal(
      errandRewardSchema.safeParse(input).success,
      false,
      String(input),
    );
});
test('errand source-native form bounds count codepoints and preserve free expected-time text', () => {
  const input = base();
  input.title = '🙂'.repeat(50);
  input.publicText = '中'.repeat(500);
  input.privateText = '🙂'.repeat(200);
  input.expectedTimeText = '明天下课后';
  assert.equal(publishErrandSchema.parse(input).title, input.title);
  for (const [field, length] of [
    ['title', 51],
    ['publicText', 501],
    ['privateText', 201],
    ['expectedTimeText', 51],
  ] as const)
    assert.equal(
      publishErrandSchema.safeParse({ ...base(), [field]: '🙂'.repeat(length) })
        .success,
      false,
    );
  assert.equal(errandText(50).parse('  a\r\nb  '), 'a\nb');
  for (const value of ['x\0y', 'x\u0085y', 'x\ud800y', 'x\u000by'])
    assert.equal(errandText(50).safeParse(value).success, false);
});
test('publisher needs both contacts, accepter one, and ownership/status/client digests cannot be forged', () => {
  for (const publisherContacts of [
    { wechat: '', phone: '123' },
    { wechat: 'wx', phone: '' },
    { wechat: 'wx', phone: '123456789012' },
    { wechat: 'wx', phone: '+123' },
  ])
    assert.equal(
      publishErrandSchema.safeParse({ ...base(), publisherContacts }).success,
      false,
    );
  const command = {
    clientRequestId: randomUUID(),
    expectedRevision: randomUUID(),
  };
  for (const contacts of [
    { wechat: 'wx', phone: '' },
    { wechat: '', phone: '123' },
    { wechat: 'wx', phone: '123' },
  ])
    assert.ok(acceptErrandSchema.safeParse({ ...command, contacts }).success);
  assert.equal(
    acceptErrandSchema.safeParse({
      ...command,
      contacts: { wechat: '', phone: '' },
    }).success,
    false,
  );
  for (const field of [
    'publisherId',
    'accountId',
    'acceptedAt',
    'state',
    'reviewDigest',
    'approvalId',
  ])
    assert.equal(
      publishErrandSchema.safeParse({ ...base(), [field]: randomUUID() })
        .success,
      false,
    );
});
test('private-free receipts reject contacts and current bodies; sparse pages explicitly continue', () => {
  const receipt = {
    requestId: randomUUID(),
    operation: 'accept',
    outcome: 'applied',
    orderId: randomUUID(),
    revision: randomUUID(),
    occurredAt: new Date().toISOString(),
  };
  assert.ok(errandReceiptSchema.safeParse(receipt).success);
  for (const field of [
    'contacts',
    'privateText',
    'title',
    'current',
    'publisherId',
  ])
    assert.equal(
      errandReceiptSchema.safeParse({ ...receipt, [field]: 'secret' }).success,
      false,
    );
  assert.ok(
    errandPageSchema.safeParse({
      context: { kind: 'own', relation: 'published' },
      items: [],
      continuation: 'more',
      nextCursor: 'a'.repeat(43),
    }).success,
  );
  assert.equal(
    errandPageSchema.safeParse({
      context: { kind: 'own', relation: 'published' },
      items: [],
      continuation: 'end',
      nextCursor: 'a'.repeat(43),
    }).success,
    false,
  );
  assert.equal(
    errandDetailSchema.safeParse({ ...receipt, privateText: 'secret' }).success,
    false,
  );
});
test('feature restrictions are action-typed with complete provenance, expiry and release semantics', () => {
  const now = Date.now(),
    r = {
      id: randomUUID(),
      action: 'publish',
      reason: 'Synthetic fixture',
      startsAt: new Date(now - 1000).toISOString(),
      endsAt: null,
      releasedAt: null,
      provenance: 'accepted',
      issuer: 'fixture',
      sourceReference: 'fixture-source',
      policyReference: 'fixture-policy',
    };
  assert.equal(evaluateErrandRestrictions([r], now, 'publish'), 'restricted');
  assert.equal(evaluateErrandRestrictions([r], now, 'accept'), 'allowed');
  assert.equal(
    evaluateErrandRestrictions([{ ...r, action: 'all' }], now, 'accept'),
    'restricted',
  );
  assert.equal(
    evaluateErrandRestrictions(
      [{ ...r, endsAt: new Date(now - 1).toISOString() }],
      now,
      'publish',
    ),
    'allowed',
  );
  assert.equal(
    evaluateErrandRestrictions(
      [{ ...r, releasedAt: new Date(now).toISOString() }],
      now,
      'publish',
    ),
    'allowed',
  );
  for (const change of [
    { issuer: '' },
    { provenance: 'unknown' },
    { action: 'posts' },
    { startsAt: new Date(now + 100).toISOString() },
    { releasedAt: new Date(now + 1).toISOString() },
  ])
    assert.equal(
      evaluateErrandRestrictions([{ ...r, ...change }], now, 'publish'),
      'unavailable',
    );
  assert.equal(
    evaluateErrandRestrictions([r, r], now, 'publish'),
    'unavailable',
  );
});
test('temporary entitlement cannot fabricate affiliation, lifetime or source provenance', () => {
  const accountId = randomUUID(),
    now = Date.now(),
    fact = {
      account_id: accountId,
      state: 'verified' as const,
      coverage: 'complete',
      provenance: 'accepted',
      issuer: 'fixture',
      source_reference: 'fixture-source',
      policy_reference: 'fixture-policy',
      effective_at: new Date(now - 1000),
      valid_until: new Date(now + 1000),
    };
  assert.equal(temporaryErrandBaseStatus(fact, accountId, now), 'verified');
  assert.equal(
    temporaryErrandBaseStatus({ ...fact, state: 'revoked' }, accountId, now),
    'unverified',
  );
  assert.equal(
    temporaryErrandBaseStatus(
      { ...fact, valid_until: new Date(now) },
      accountId,
      now,
    ),
    'unverified',
  );
  for (const change of [
    { issuer: '' },
    { coverage: 'missing' },
    { provenance: 'unknown' },
    { effective_at: new Date(now + 1) },
    { valid_until: new Date(NaN) },
    { account_id: randomUUID() },
  ])
    assert.equal(
      temporaryErrandBaseStatus({ ...fact, ...change }, accountId, now),
      'unavailable',
    );
  assert.equal(
    temporaryErrandBaseStatus(undefined, accountId, now),
    'unavailable',
  );
});
