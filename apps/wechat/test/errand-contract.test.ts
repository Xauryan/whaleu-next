import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalErrandText,
  decodeErrandContactHistory,
  decodeErrandContacts,
  decodeErrandDetail,
  decodeErrandIntent,
  decodeErrandPage,
  decodeErrandReceipt,
  decodeErrandSummary,
  decodeOperatingRegions,
  decodePublishErrand,
  errandRejections,
  exactErrandReward,
  matchErrandReceipt,
  type ErrandDetail,
  type ErrandIntent,
  type ErrandReceipt,
  type ErrandSummary,
  type PublishErrand,
} from '../src/errands/contract';

const orderId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const revision = '33333333-3333-4333-8333-333333333333';
const regionId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const timestamp = '2026-10-08T12:00:00.000Z';
const contacts = () => ({ wechat: 'synthetic-contact', phone: '12345678901' });
const publish = (patch: Partial<PublishErrand> = {}): PublishErrand => ({
  clientRequestId: requestId,
  targetRegionId: regionId,
  title: 'Synthetic errand',
  publicText: 'Public instructions',
  privateText: 'Participant instructions',
  expectedTimeText: 'Tomorrow',
  reward: '12.3456789',
  publisherContacts: contacts(),
  publicAssetIds: [],
  privateAssetIds: [],
  ...patch,
});
const summary = (patch: Partial<ErrandSummary> = {}): ErrandSummary => ({
  id: orderId,
  revision,
  title: 'Synthetic errand',
  publicText: 'Public instructions',
  expectedTimeText: 'Tomorrow',
  reward: '12.3456789',
  state: 'pending',
  createdAt: timestamp,
  acceptedAt: null,
  completedAt: null,
  cancelledAt: null,
  targetRegion: { id: regionId, label: 'Synthetic target' },
  sourceRegion: { id: otherId, label: 'Synthetic source' },
  scope: 'home',
  ...patch,
});
const capabilities = () => ({
  accept: false,
  cancel: false,
  complete: false,
  delete: false,
});
const detail = (patch: Partial<ErrandDetail> = {}): ErrandDetail => ({
  ...summary(),
  relation: 'none',
  capabilities: capabilities(),
  ...patch,
});
const accepted = (patch: Partial<ErrandDetail> = {}): ErrandDetail =>
  detail({
    state: 'accepted',
    acceptedAt: timestamp,
    relation: 'publisher',
    privateText: 'Participant instructions',
    oppositeContact: {
      display: { status: 'available', displayName: 'Synthetic participant' },
      contacts: contacts(),
    },
    capabilities: { accept: false, cancel: true, complete: true, delete: true },
    ...patch,
  });
const command = (
  operation: 'accept' | 'cancel' | 'complete' | 'delete' = 'accept',
): ErrandIntent =>
  operation === 'accept'
    ? {
        operation,
        orderId,
        payload: {
          clientRequestId: requestId,
          expectedRevision: revision,
          contacts: contacts(),
        },
      }
    : {
        operation,
        orderId,
        payload: { clientRequestId: requestId, expectedRevision: revision },
      };
const receipt = (
  patch: Partial<Extract<ErrandReceipt, { outcome: 'applied' }>> = {},
): ErrandReceipt => ({
  requestId,
  operation: 'accept',
  outcome: 'applied',
  orderId,
  revision,
  occurredAt: timestamp,
  ...patch,
});

test('errand rewards preserve exact base-ten precision from one through five hundred with a 100-digit transport budget', () => {
  for (const [raw, canonical] of [
    ['1', '1'],
    ['1.0000', '1'],
    ['1.001', '1.001'],
    ['12.3456789000', '12.3456789'],
    ['499.9999999999999999999999999999', '499.9999999999999999999999999999'],
    ['500.000000', '500'],
    ['1.' + '0'.repeat(98) + '1', '1.' + '0'.repeat(98) + '1'],
    ['500.' + '0'.repeat(97), '500'],
  ])
    assert.equal(exactErrandReward(raw), canonical, raw);
  for (const value of [
    undefined,
    null,
    1,
    NaN,
    Infinity,
    ['1'],
    { amount: '1' },
    '',
    ' ',
    '0',
    '0.999999999999999999999999999999',
    '01',
    '001.20',
    '-1',
    '+1',
    '.1',
    '1.',
    '1.2.3',
    '1e2',
    '1E2',
    '0x10',
    '1,000',
    '¥1',
    '1元',
    ' 1',
    '1 ',
    '1\n',
    '1\r\n',
    '1\t',
    '1\0',
    '１',
    '١',
    '501',
    '500.00000000000000000000000000001',
    '1.' + '0'.repeat(99) + '1',
    '500.' + '0'.repeat(98),
    '9'.repeat(100),
  ])
    assert.throws(
      () => exactErrandReward(value),
      { kind: 'protocol' },
      String(value),
    );
});

test('fresh errand text normalizes CRLF and outer whitespace without NFC, truncation or UTF-16 length limits', () => {
  assert.equal(
    canonicalErrandText(' \tfirst\r\nsecond \n', 50),
    'first\nsecond',
  );
  assert.equal(canonicalErrandText('e\u0301', 2), 'e\u0301');
  assert.equal(canonicalErrandText(' \r\n ', 200, false), '');
  for (const [key, maximum] of [
    ['title', 50],
    ['publicText', 500],
    ['privateText', 200],
    ['expectedTimeText', 50],
  ] as const) {
    const value = '🐳'.repeat(maximum);
    assert.equal(
      decodePublishErrand({ ...publish(), [key]: value })[key],
      value,
    );
    assert.throws(
      () => decodePublishErrand({ ...publish(), [key]: value + 'x' }),
      { kind: 'protocol' },
    );
    for (const bad of [
      'a\rb',
      'a\0b',
      'a\u007fb',
      'a\u009fb',
      '\ud800',
      '\udfff',
    ])
      assert.throws(() => decodePublishErrand({ ...publish(), [key]: bad }), {
        kind: 'protocol',
      });
    if (key !== 'privateText')
      assert.throws(() =>
        decodePublishErrand({ ...publish(), [key]: ' \r\n ' }),
      );
  }
  assert.throws(() => canonicalErrandText(' '.repeat(201) + 'x', 50));
});

test('publisher requires both contact channels while an accepter needs one, with source-backed character and digit limits', () => {
  assert.deepEqual(
    decodeErrandContacts(
      { wechat: ' 🐳 '.repeat(1).trim(), phone: ' 123 ' },
      'publisher',
    ),
    { wechat: '🐳', phone: '123' },
  );
  assert.equal(
    decodeErrandContacts({ wechat: '🐳'.repeat(50), phone: '' }).wechat,
    '🐳'.repeat(50),
  );
  for (const value of [
    { wechat: 'synthetic', phone: '' },
    { wechat: '', phone: '123' },
  ]) {
    assert.deepEqual(decodeErrandContacts(value), value);
    assert.throws(() => decodeErrandContacts(value, 'publisher'));
  }
  assert.deepEqual(
    decodeErrandContacts({ wechat: '', phone: '' }, 'optional'),
    { wechat: '', phone: '' },
  );
  for (const value of [
    { wechat: '', phone: '' },
    { wechat: ' ', phone: '\t' },
    { ...contacts(), wechat: '🐳'.repeat(51) },
    { ...contacts(), wechat: '\ud800' },
    { ...contacts(), phone: '123456789012' },
    { ...contacts(), phone: '+123' },
    { ...contacts(), phone: '123-456' },
    { ...contacts(), phone: '１２３' },
    { ...contacts(), phone: 123 },
    { ...contacts(), accountId: otherId },
    { ...contacts(), qq: 'private' },
    { ...contacts(), phone: { value: '123' } },
  ])
    assert.throws(() => decodeErrandContacts(value), { kind: 'protocol' });
});

test('publish payloads are immutable, canonical and strict, with media explicitly unavailable', () => {
  const raw = publish({
    title: '  Task\r\nname ',
    reward: '12.345678900',
    publisherContacts: { wechat: ' synthetic ', phone: ' 123 ' },
  });
  const decoded = decodePublishErrand(raw);
  assert.equal(decoded.title, 'Task\nname');
  assert.equal(decoded.reward, '12.3456789');
  assert.deepEqual(decoded.publisherContacts, {
    wechat: 'synthetic',
    phone: '123',
  });
  for (const value of [
    decoded,
    decoded.publisherContacts,
    decoded.publicAssetIds,
    decoded.privateAssetIds,
  ])
    assert.ok(Object.isFrozen(value));
  for (const patch of [
    { accountId: otherId },
    { state: 'pending' },
    { sourceRegionId: otherId },
    { operation: 'publish' },
    { publisherContacts: { ...contacts(), profileId: otherId } },
  ])
    assert.throws(() => decodePublishErrand({ ...publish(), ...patch }));
  for (const key of ['publicAssetIds', 'privateAssetIds'])
    assert.throws(
      () => decodePublishErrand({ ...publish(), [key]: [otherId] }),
      { kind: 'configuration', details: { serverCode: 'MEDIA_UNAVAILABLE' } },
    );
});

test('mutation intents freeze exact revision/contact snapshots and reject client actor, state and operation injection', () => {
  for (const operation of ['accept', 'cancel', 'complete', 'delete'] as const) {
    const raw = command(operation),
      decoded = decodeErrandIntent(raw);
    assert.deepEqual(decoded, raw);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.payload));
    for (const patch of [
      { accountId: otherId },
      { publisherId: otherId },
      { revision },
      { requestedState: 'completed' },
    ])
      assert.throws(() => decodeErrandIntent({ ...raw, ...patch }));
    for (const patch of [
      { expectedRevision: 'not-an-id' },
      { clientRequestId: 'bad' },
      { state: 'completed' },
      { accountId: otherId },
    ])
      assert.throws(() =>
        decodeErrandIntent({ ...raw, payload: { ...raw.payload, ...patch } }),
      );
  }
  assert.deepEqual(
    decodeErrandIntent({ operation: 'publish', payload: publish() }),
    { operation: 'publish', payload: publish() },
  );
  assert.throws(() =>
    decodeErrandIntent({ operation: 'publish', orderId, payload: publish() }),
  );
  assert.throws(() =>
    decodeErrandIntent({ ...command(), operation: 'refund' }),
  );
  assert.throws(() =>
    decodeErrandIntent({
      ...command('cancel'),
      payload: { ...command('cancel').payload, contacts: contacts() },
    }),
  );
});

test('public errand summaries never admit participant text, contacts, identities or nested projection leaks', () => {
  const raw = summary(),
    decoded = decodeErrandSummary(raw);
  assert.deepEqual(decoded, raw);
  for (const value of [decoded, decoded.targetRegion, decoded.sourceRegion])
    assert.ok(Object.isFrozen(value));
  for (const patch of [
    { privateText: 'secret' },
    { contacts: contacts() },
    { publisherContacts: contacts() },
    { publisherAccountId: otherId },
    { accepterAccountId: otherId },
    { oppositeContact: contacts() },
    { targetRegion: { ...raw.targetRegion, ownerAccountId: otherId } },
    { sourceRegion: { ...raw.sourceRegion, phone: 'private' } },
    { reward: '12.345678900' },
    { title: ' Synthetic errand' },
    { scope: 'global' },
    { id: 'not-an-id' },
    { revision: 'not-an-id' },
    { state: 'deleted' },
    { createdAt: '2026-02-30T12:00:00Z' },
  ])
    assert.throws(() => decodeErrandSummary({ ...raw, ...patch }), {
      kind: 'protocol',
    });
});

test('state timestamps cannot describe impossible lifecycle states or an accepter before acceptance', () => {
  for (const patch of [
    { state: 'pending', acceptedAt: timestamp },
    { state: 'accepted', acceptedAt: null },
    { state: 'completed', acceptedAt: timestamp, completedAt: null },
    { state: 'completed', acceptedAt: null, completedAt: timestamp },
    { state: 'cancelled', cancelledAt: null },
    { completedAt: timestamp },
    { cancelledAt: timestamp },
    { state: 'accepted', acceptedAt: timestamp, cancelledAt: timestamp },
    { state: 'cancelled', cancelledAt: timestamp, completedAt: timestamp },
  ])
    assert.throws(() => decodeErrandSummary({ ...summary(), ...patch }));
  assert.equal(
    decodeErrandSummary(summary({ state: 'cancelled', cancelledAt: timestamp }))
      .state,
    'cancelled',
  );
  assert.equal(
    decodeErrandSummary(
      summary({
        state: 'cancelled',
        acceptedAt: timestamp,
        cancelledAt: timestamp,
      }),
    ).state,
    'cancelled',
  );
  assert.equal(
    decodeErrandSummary(
      summary({
        state: 'completed',
        acceptedAt: timestamp,
        completedAt: timestamp,
      }),
    ).state,
    'completed',
  );
  assert.throws(() =>
    decodeErrandDetail(detail({ relation: 'accepter', privateText: '' })),
  );
});

test('participant detail reveals private text only to participants and opposite contact only while accepted', () => {
  assert.deepEqual(decodeErrandDetail(detail()), detail());
  const raw = accepted(),
    decoded = decodeErrandDetail(raw);
  assert.deepEqual(decoded, raw);
  for (const value of [
    decoded,
    decoded.capabilities,
    decoded.oppositeContact,
    decoded.oppositeContact!.display,
    decoded.oppositeContact!.contacts,
  ])
    assert.ok(Object.isFrozen(value));
  assert.equal(
    decodeErrandDetail(
      accepted({ relation: 'accepter', capabilities: capabilities() }),
    ).relation,
    'accepter',
  );
  const unavailable = accepted({
    oppositeContact: {
      display: { status: 'unavailable' },
      contacts: contacts(),
    },
  });
  assert.deepEqual(decodeErrandDetail(unavailable), unavailable);
  const missingPrivate = { ...raw };
  delete missingPrivate.privateText;
  assert.throws(() => decodeErrandDetail(missingPrivate));
  for (const value of [
    detail({ privateText: 'leak' }),
    { ...detail(), privateText: undefined },
    detail({ oppositeContact: raw.oppositeContact! }),
    accepted({ relation: 'none' }),
    accepted({
      state: 'completed',
      completedAt: timestamp,
      capabilities: capabilities(),
    }),
    accepted({
      state: 'cancelled',
      cancelledAt: timestamp,
      capabilities: capabilities(),
    }),
    { ...raw, oppositeContact: { ...raw.oppositeContact, accountId: otherId } },
    {
      ...raw,
      oppositeContact: {
        ...raw.oppositeContact,
        display: {
          status: 'available',
          displayName: 'Synthetic',
          profileId: otherId,
        },
      },
    },
    {
      ...raw,
      oppositeContact: {
        ...raw.oppositeContact,
        display: { status: 'unavailable', displayName: 'hidden' },
      },
    },
    {
      ...raw,
      oppositeContact: {
        ...raw.oppositeContact,
        contacts: { ...contacts(), accountId: otherId },
      },
    },
    {
      ...raw,
      oppositeContact: {
        ...raw.oppositeContact,
        contacts: { ...contacts(), phone: ' 123 ' },
      },
    },
    { ...raw, capabilities: { ...raw.capabilities, accountId: otherId } },
  ])
    assert.throws(() => decodeErrandDetail(value), { kind: 'protocol' });
});

test('capabilities cannot grant an impossible actor/state action and false remains a valid server restriction', () => {
  assert.equal(
    decodeErrandDetail(
      detail({ capabilities: { ...capabilities(), accept: true } }),
    ).capabilities.accept,
    true,
  );
  assert.deepEqual(
    decodeErrandDetail(accepted({ capabilities: capabilities() })).capabilities,
    capabilities(),
  );
  for (const [relation, state, key] of [
    ['publisher', 'pending', 'accept'],
    ['accepter', 'accepted', 'accept'],
    ['none', 'accepted', 'accept'],
    ['none', 'pending', 'cancel'],
    ['accepter', 'accepted', 'cancel'],
    ['publisher', 'completed', 'cancel'],
    ['publisher', 'cancelled', 'cancel'],
    ['none', 'accepted', 'complete'],
    ['accepter', 'accepted', 'complete'],
    ['publisher', 'pending', 'complete'],
    ['publisher', 'completed', 'complete'],
    ['publisher', 'cancelled', 'complete'],
    ['none', 'pending', 'delete'],
    ['accepter', 'accepted', 'delete'],
  ] as const) {
    const value = {
      ...summary({
        state,
        acceptedAt:
          state === 'pending' || state === 'cancelled' ? null : timestamp,
        completedAt: state === 'completed' ? timestamp : null,
        cancelledAt: state === 'cancelled' ? timestamp : null,
      }),
      relation,
      ...(relation === 'none' ? {} : { privateText: '' }),
      capabilities: { ...capabilities(), [key]: true },
    };
    assert.throws(
      () => decodeErrandDetail(value),
      { kind: 'protocol' },
      `${relation}/${state}/${key}`,
    );
  }
  assert.throws(() =>
    decodeErrandDetail({
      ...detail(),
      capabilities: { ...capabilities(), accept: 1 },
    }),
  );
});

test('errand pages enforce exact context, bounded unique summaries and cursor/continuation agreement', () => {
  const page = {
    context: { kind: 'discovery', regionId, discoveryMode: 'home' },
    items: [summary()],
    continuation: 'end',
    nextCursor: null,
  };
  const decoded = decodeErrandPage(page);
  assert.deepEqual(decoded, page);
  assert.ok(Object.isFrozen(decoded.items));
  assert.ok(Object.isFrozen(decoded.context));
  assert.equal(
    decodeErrandPage({
      ...page,
      continuation: 'more',
      nextCursor: 'a'.repeat(43),
    }).continuation,
    'more',
  );
  assert.deepEqual(
    decodeErrandPage({
      ...page,
      context: { kind: 'own', relation: 'accepted' },
    }).context,
    { kind: 'own', relation: 'accepted' },
  );
  for (const patch of [
    { items: [summary(), summary()] },
    { items: Array.from({ length: 51 }, () => summary()) },
    { continuation: 'more' },
    { nextCursor: 'a'.repeat(43) },
    { continuation: 'more', nextCursor: 'a'.repeat(42) },
    { continuation: 'more', nextCursor: 'a'.repeat(42) + '&' },
    { contacts: contacts() },
    { context: { ...page.context, accountId: otherId } },
    { context: { ...page.context, discoveryMode: 'all' } },
    { context: { kind: 'own', relation: 'publisher' } },
  ])
    assert.throws(() => decodeErrandPage({ ...page, ...patch }), {
      kind: 'protocol',
    });
});

test('errand terminal receipts are minimal immutable outcomes with a closed rejection vocabulary', () => {
  const raw = receipt();
  assert.deepEqual(decodeErrandReceipt(raw), raw);
  assert.ok(Object.isFrozen(decodeErrandReceipt(raw)));
  for (const operation of [
    'publish',
    'accept',
    'cancel',
    'complete',
    'delete',
  ] as const)
    assert.equal(
      decodeErrandReceipt(receipt({ operation })).operation,
      operation,
    );
  for (const code of errandRejections)
    assert.equal(
      decodeErrandReceipt({
        requestId,
        operation: 'accept',
        outcome: 'rejected',
        code,
      }).outcome,
      'rejected',
    );
  for (const patch of [
    { requestId: 'bad' },
    { operation: 'refund' },
    { outcome: 'pending' },
    { outcome: 'created' },
    { revision: 'bad' },
    { orderId: 'bad' },
    { occurredAt: '2026-02-30T12:00:00Z' },
    { contacts: contacts() },
    { order: summary() },
    { privateText: 'hidden' },
    { accountId: otherId },
  ])
    assert.throws(() => decodeErrandReceipt({ ...raw, ...patch }), {
      kind: 'protocol',
    });
  for (const code of [
    'REQUEST_NOT_FOUND',
    'SESSION_REVOKED',
    'MEDIA_UNAVAILABLE',
    'ERRAND_SCOPE_UNAVAILABLE',
    'invented',
  ])
    assert.throws(() =>
      decodeErrandReceipt({
        requestId,
        operation: 'accept',
        outcome: 'rejected',
        code,
      }),
    );
  assert.throws(() =>
    decodeErrandReceipt({
      requestId,
      operation: 'accept',
      outcome: 'rejected',
      code: 'ERRAND_NOT_FOUND',
      orderId,
    }),
  );
});

test('receipt matching binds request, operation and command order without inventing a publish order ID', () => {
  assert.doesNotThrow(() => matchErrandReceipt(command(), receipt()));
  for (const patch of [
    { requestId: otherId },
    { operation: 'cancel' as const },
    { orderId: otherId },
  ])
    assert.throws(() => matchErrandReceipt(command(), receipt(patch)), {
      kind: 'protocol',
    });
  const rejected: ErrandReceipt = {
    requestId,
    operation: 'accept',
    outcome: 'rejected',
    code: 'ERRAND_REVISION_CONFLICT',
  };
  assert.doesNotThrow(() => matchErrandReceipt(command(), rejected));
  assert.throws(() => matchErrandReceipt(command('cancel'), rejected));
  assert.doesNotThrow(() =>
    matchErrandReceipt(
      { operation: 'publish', payload: publish() },
      receipt({ operation: 'publish', orderId: otherId }),
    ),
  );
});

test('contact history and operating regions are strict private/minimal projections', () => {
  assert.deepEqual(decodeErrandContactHistory({ status: 'empty' }), {
    status: 'empty',
  });
  const history = decodeErrandContactHistory({
    status: 'available',
    contacts: contacts(),
  });
  assert.ok(Object.isFrozen(history));
  if (history.status === 'available')
    assert.ok(Object.isFrozen(history.contacts));
  for (const value of [
    { status: 'empty', contacts: contacts() },
    { status: 'available', contacts: { wechat: ' synthetic ', phone: '' } },
    { status: 'available', contacts: { ...contacts(), accountId: otherId } },
    { status: 'unavailable' },
  ])
    assert.throws(() => decodeErrandContactHistory(value));
  assert.deepEqual(
    decodeOperatingRegions({
      items: [{ id: regionId, name: 'Synthetic region', isActive: true }],
    }),
    [{ id: regionId, label: 'Synthetic region' }],
  );
  for (const value of [
    {
      items: [
        {
          id: regionId,
          name: 'Synthetic region',
          isActive: true,
          accountId: otherId,
        },
      ],
    },
    { items: [], contacts: contacts() },
  ])
    assert.throws(() => decodeOperatingRegions(value));
  assert.throws(
    () =>
      decodeOperatingRegions({
        items: [{ id: regionId, name: 'Synthetic region', isActive: false }],
      }),
    { kind: 'forbidden' },
  );
});
