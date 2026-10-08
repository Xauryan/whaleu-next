import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeErrandNotice,
  type ErrandNotice,
} from '../src/errands/admin-notice-contract';
import { decodeErrandNotice as decodeLegacyNotice } from '../src/errands/notices';

const noticeId = '11111111-1111-4111-8111-111111111111',
  orderId = '22222222-2222-4222-8222-222222222222',
  restrictionId = '33333333-3333-4333-8333-333333333333',
  eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  time = '2026-10-08T12:00:00.123456Z';
const base = { noticeId, createdAt: time, readAt: null };
const deletion = (): Extract<ErrandNotice, { kind: 'admin_deleted' }> => ({
  ...base,
  kind: 'admin_deleted',
  orderId,
  deletionReason: { status: 'provided', value: '合成删除原因' },
});
const restriction = (): Extract<
  ErrandNotice,
  { kind: 'feature_restricted' }
> => ({
  ...base,
  kind: 'feature_restricted',
  restrictionId,
  eventId,
  action: 'all',
  reason: '合成限制原因',
  startsAt: time,
  endsAt: null,
});
const release = (): Extract<ErrandNotice, { kind: 'feature_released' }> => ({
  ...base,
  kind: 'feature_released',
  restrictionId,
  eventId,
  action: 'accept',
  reason: '合成解除原因',
  releasedAt: time,
});
const notices = (): ErrandNotice[] => [
  { ...base, kind: 'accepted', orderId },
  { ...base, kind: 'completed', orderId },
  deletion(),
  restriction(),
  release(),
];

test('five exact local notice variants retain E1 wire fields and freeze every snapshot', () => {
  for (const raw of notices()) {
    const decoded = decodeErrandNotice(raw);
    assert.deepEqual(decoded, raw);
    assert.ok(Object.isFrozen(decoded));
    if (raw.kind === 'accepted' || raw.kind === 'completed')
      assert.deepEqual(decoded, decodeLegacyNotice(raw));
    if (decoded.kind === 'admin_deleted')
      assert.ok(Object.isFrozen(decoded.deletionReason));
  }
  assert.deepEqual(
    decodeErrandNotice({
      ...deletion(),
      deletionReason: { status: 'not_provided' },
      readAt: time,
    }),
    { ...deletion(), deletionReason: { status: 'not_provided' }, readAt: time },
  );
});

test('restriction and release retain exact actions, permanent/finite ends and immutable identities', () => {
  for (const action of ['publish', 'accept', 'all'] as const) {
    for (const endsAt of [null, '2026-10-15T12:00:00.123456Z']) {
      const raw = { ...restriction(), action, endsAt };
      assert.deepEqual(decodeErrandNotice(raw), raw);
    }
    const raw = { ...release(), action };
    assert.deepEqual(decodeErrandNotice(raw), raw);
    assert.equal('orderId' in decodeErrandNotice(raw), false);
    assert.equal('allActionsAllowed' in decodeErrandNotice(raw), false);
  }
  const oneMicrosecond = {
    ...restriction(),
    startsAt: '2026-10-08T20:00:00.123456+08:00',
    endsAt: '2026-10-08T12:00:00.123457Z',
  };
  assert.deepEqual(decodeErrandNotice(oneMicrosecond), oneMicrosecond);
});

test('notice text uses bounded code points, exact normalized response bytes and local deletion snapshots', () => {
  for (const value of [
    '鲸'.repeat(500),
    '🐋'.repeat(500),
    '原因\n第二行\t细节',
  ]) {
    const raw = {
      ...deletion(),
      deletionReason: { status: 'provided', value },
    };
    assert.deepEqual(decodeErrandNotice(raw), raw);
  }
  for (const create of [restriction, release]) {
    const raw = { ...create(), reason: '🐋'.repeat(255) };
    assert.deepEqual(decodeErrandNotice(raw), raw);
    for (const reason of [
      '',
      ' ',
      ' 原因',
      '原因 ',
      '原因\r\n细节',
      '🐋'.repeat(256),
      '原因\u0000',
      '原因\u007f',
      '原因\ud800',
      null,
      123,
    ])
      assert.throws(() => decodeErrandNotice({ ...create(), reason }));
  }
  for (const value of ['', ' ', ' 原因', '🐋'.repeat(501), '\u0000', '\udfff'])
    assert.throws(() =>
      decodeErrandNotice({
        ...deletion(),
        deletionReason: { status: 'provided', value },
      }),
    );
});

test('closed variants reject private fields, missing fields, foreign event keys and fabricated notices', () => {
  for (const raw of notices()) {
    for (const field of [
      'contacts',
      'privateText',
      'phone',
      'publisher',
      'accountId',
      'grantId',
      'source',
    ])
      assert.throws(() => decodeErrandNotice({ ...raw, [field]: 'private' }));
    for (const field of Object.keys(raw)) {
      const missing = { ...raw } as Record<string, unknown>;
      delete missing[field];
      assert.throws(() => decodeErrandNotice(missing));
    }
  }
  for (const raw of [
    null,
    [],
    { ...base, kind: 'deleted', orderId },
    { ...base, kind: 'cancelled', orderId },
    { ...base, kind: 'feature_expired', restrictionId, eventId },
    {
      ...base,
      kind: 'accepted',
      orderId,
      deletionReason: { status: 'not_provided' },
    },
    { ...deletion(), reason: 'extra' },
    { ...deletion(), deletionReason: null },
    { ...deletion(), deletionReason: { status: 'unavailable' } },
    { ...deletion(), deletionReason: { status: 'not_provided', value: '' } },
    {
      ...deletion(),
      deletionReason: {
        status: 'provided',
        value: '原因',
        contacts: 'private',
      },
    },
    { ...restriction(), orderId },
    { ...restriction(), releasedAt: time },
    { ...release(), startsAt: time },
    { ...release(), endsAt: null },
    { ...release(), allActionsAllowed: true },
    { ...restriction(), action: 'delete' },
    { ...release(), action: 'release_all' },
    { ...restriction(), restrictionId: 'not-an-id' },
    { ...release(), eventId: eventId.toUpperCase() },
  ])
    assert.throws(() => decodeErrandNotice(raw));
});

test('all timestamps are strict and finite ends remain later down to microseconds', () => {
  for (const raw of notices()) {
    for (const patch of [
      { createdAt: '2026-02-30T12:00:00Z' },
      { createdAt: '2026-10-08T12:00:00.1234567Z' },
      { readAt: undefined },
      { readAt: '2026-10-08' },
      { noticeId: 'wrong' },
    ])
      assert.throws(() => decodeErrandNotice({ ...raw, ...patch }));
  }
  for (const patch of [
    { startsAt: null },
    { startsAt: '2026-02-30T00:00:00Z' },
    { endsAt: '2026-02-30T00:00:00Z' },
    { endsAt: time },
    { endsAt: '2026-10-08T12:00:00.123455Z' },
    { endsAt: '2026-10-08T20:00:00.123456+08:00' },
    { endsAt: undefined },
  ])
    assert.throws(() => decodeErrandNotice({ ...restriction(), ...patch }));
  for (const releasedAt of [null, '2026-02-30T12:00:00Z', '2026-10-08'])
    assert.throws(() => decodeErrandNotice({ ...release(), releasedAt }));
});
