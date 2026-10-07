import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePost, decodePostIntent } from '../src/community/contract';
import {
  decodeTradingContacts,
  decodeTradingContactView,
  decodeTradingIntent,
  decodeTradingReceipt,
  decodeTradingView,
  exactTradingPrice,
  tradingCategories,
} from '../src/community/trading-contract';
import {
  anonymous,
  intent,
  otherId,
  pollPost,
  post,
  postId,
  requestId,
  tradingContacts,
  tradingIntent,
  tradingPost,
  tradingReceipt,
  tradingView,
} from './community-helpers';

test('trading money preserves exact positive decimal precision and canonicalizes without rounding', () => {
  for (const [input, expected] of [
    ['00012.340000', '12.34'],
    ['00001', '1'],
    ['99999.00000', '99999'],
    [
      '0.0000000000000000000000000000000000000000000000000001',
      '0.0000000000000000000000000000000000000000000000000001',
    ],
    [
      '99998.9999999999999999999999999999999999999999999999999',
      '99998.9999999999999999999999999999999999999999999999999',
    ],
  ])
    assert.equal(exactTradingPrice(input), expected);
  for (const input of [
    undefined,
    null,
    1,
    NaN,
    Infinity,
    ['1'],
    { price: '1' },
    '',
    ' ',
    '0',
    '0.000',
    '00000',
    '-1',
    '+1',
    '1e2',
    '1E2',
    '0x10',
    '.1',
    '1.',
    '1.2.3',
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
    '100000',
    '99999.000000000000000000001',
    '1'.repeat(101),
  ])
    assert.throws(
      () => exactTradingPrice(input),
      { kind: 'protocol' },
      String(input),
    );
});

test('trading has exactly thirteen known subtypes and qiugou cannot be urgent', () => {
  assert.deepEqual(
    tradingCategories.map((item) => item.key),
    [
      'qiugou',
      'shuma',
      'shujia',
      'yifu',
      'meizhuang',
      'yundong',
      'riyong',
      'shipin',
      'kaquan',
      'xiangbao',
      'zixingche',
      'diandongche',
      'xianshiqi',
    ],
  );
  for (const { key } of tradingCategories)
    assert.equal(
      decodeTradingIntent(tradingIntent({ subtype: key })).subtype,
      key,
    );
  for (const value of [
    { ...tradingIntent(), subtype: 'other' },
    { ...tradingIntent(), subtype: ['shuma'] },
    { ...tradingIntent(), subtype: 'qiugou', urgency: 'urgent' },
    { ...tradingIntent(), urgency: 'normal ' },
    { ...tradingIntent(), urgency: ['normal'] },
    { ...tradingIntent(), urgency: { toString: () => 'normal' } },
  ])
    assert.throws(() => decodeTradingIntent(value), { kind: 'protocol' });
});

test('trading contacts and location enforce UTF-8 byte limits, Unicode and a nonblank contact', () => {
  const contacts = tradingContacts({ wechat: '🐳'.repeat(12) + 'ab' });
  assert.deepEqual(decodeTradingContacts(contacts), contacts);
  const raw = tradingIntent({ location: '🐳'.repeat(50), contacts });
  assert.deepEqual(decodeTradingIntent(raw), raw);
  const decoded = decodeTradingIntent(tradingIntent({ price: '00012.3000' }));
  assert.equal(decoded.price, '12.3');
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.contacts));
  for (const value of [
    { ...contacts, wechat: '🐳'.repeat(13) },
    { ...contacts, wechat: '中'.repeat(17) },
    { ...contacts, wechat: 'x'.repeat(51) },
    { ...contacts, wechat: '\ud800' },
    { ...contacts, wechat: 'a\rb' },
    { ...contacts, wechat: 'a\0b' },
    { wechat: '', qq: ' ', phone: '\t\n' },
    { ...contacts, phone: 12345 },
  ])
    assert.throws(() => decodeTradingContacts(value));
  assert.deepEqual(
    decodeTradingContacts({ wechat: '', qq: '', phone: 'synthetic-phone' }),
    { wechat: '', qq: '', phone: 'synthetic-phone' },
  );
  for (const location of [
    '',
    ' ',
    '🐳'.repeat(51),
    '中'.repeat(67),
    'x'.repeat(201),
    '\ud800',
    'a\rb',
  ])
    assert.throws(() => decodeTradingIntent({ ...raw, location }));
});

test('trading post writes are named and component-free while old frozen payload shapes remain unchanged', () => {
  const raw = intent({
    category: 'trading',
    authorMode: 'named',
    trading: tradingIntent(),
  });
  assert.deepEqual(decodePostIntent(raw), raw);
  assert.deepEqual(
    decodePostIntent({ ...raw, component: { kind: 'none' } }).component,
    { kind: 'none' },
  );
  for (const value of [
    { ...raw, authorMode: 'anonymous' },
    { ...raw, category: 'discussion' },
    { ...raw, trading: null },
    {
      ...raw,
      component: {
        kind: 'poll',
        question: 'q',
        selectionMode: 'single',
        options: ['a', 'b'],
      },
    },
    { ...raw, component: { kind: 'group' } },
    { ...raw, contacts: tradingContacts() },
    intent({ category: 'trading', authorMode: 'named' }),
  ])
    assert.throws(() => decodePostIntent(value));
  const old = decodePostIntent(intent());
  assert.equal(Object.prototype.hasOwnProperty.call(old, 'trading'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(old, 'component'), false);
});

test('trading public post/view enforces named regional parent and rejects contact or nested identity leaks', () => {
  const raw = tradingPost();
  assert.deepEqual(decodePost(raw), raw);
  assert.deepEqual(decodePost(post()).trading, null);
  for (const value of [
    { ...raw, author: anonymous() },
    { ...raw, space: { ...raw.space, kind: 'global' } },
    { ...raw, category: 'discussion' },
    { ...raw, component: pollPost().component },
    { ...raw, trading: null },
    { ...raw, trading: undefined },
    { ...raw, viewer: { ...raw.viewer, isSelf: false, canDelete: false } },
    { ...raw, trading: { ...raw.trading, contacts: tradingContacts() } },
    { ...raw, contacts: tradingContacts() },
    { ...raw, author: { ...raw.author, phone: 'private' } },
  ])
    assert.throws(() => decodePost(value));
  for (const value of [
    { ...tradingView(), price: '0012.30' },
    {
      ...tradingView(),
      price: { kind: 'exact', amount: '0012.30', legacyText: null },
    },
    { ...tradingView(), resolution: 'closed' },
    { ...tradingView(), accountId: otherId },
    { ...tradingView(), contacts: tradingContacts() },
    { ...tradingView(), viewer: { canSetResolution: true, phone: 'private' } },
    { ...tradingView(), viewer: { canSetResolution: 1 } },
  ])
    assert.throws(() => decodeTradingView(value));
  assert.deepEqual(
    decodePost(
      tradingPost({
        viewer: { ...raw.viewer, isSelf: false, canDelete: false },
        trading: tradingView({ viewer: { canSetResolution: false } }),
      }),
    ).trading?.viewer,
    { canSetResolution: false },
  );
});

test('historical trading reads preserve tagged raw money, categories, location and contacts without new-write coercion', () => {
  const text = '原始\r\n\t\u0000' + '🐳'.repeat(300);
  const historical = tradingView({
    price: { kind: 'legacy', text: '议价/一箱 8.50 元' },
    subtype: { kind: 'legacy', text: '旧分类未映射' },
    location: text,
  });
  assert.deepEqual(decodeTradingView(historical), historical);
  assert.deepEqual(
    decodePost(tradingPost({ trading: historical })).trading,
    historical,
  );
  const exact = tradingView({
    price: {
      kind: 'exact',
      amount: '12.3456789',
      legacyText: '0012.345678900',
    },
    subtype: { kind: 'known', key: 'shuma', legacyText: '旧数码类别' },
  });
  assert.deepEqual(decodeTradingView(exact), exact);
  assert.ok(Object.isFrozen(decodeTradingView(exact).price));
  assert.ok(Object.isFrozen(decodeTradingView(exact).subtype));
  const contacts = { postId, contacts: { wechat: text, qq: '', phone: '' } };
  assert.deepEqual(decodeTradingContactView(contacts), contacts);
  assert.deepEqual(
    decodeTradingContactView({
      postId,
      contacts: { wechat: '', qq: '', phone: '' },
    }).contacts,
    { wechat: '', qq: '', phone: '' },
  );
  for (const price of [
    { kind: 'exact', amount: '12.30', legacyText: null },
    { kind: 'exact', amount: 12, legacyText: null },
    { kind: 'exact', amount: '12', legacyText: null, phone: 'private' },
    { kind: 'legacy', text: 'old', amount: '12' },
    { kind: 'legacy', text: '\ud800' },
  ])
    assert.throws(() => decodeTradingView({ ...historical, price }));
  for (const subtype of [
    { kind: 'known', key: 'invented', legacyText: null },
    { kind: 'known', key: 'shuma', legacyText: null, accountId: otherId },
    { kind: 'legacy', text: 'old', key: 'shuma' },
    { kind: 'legacy', text: '\ud800' },
  ])
    assert.throws(() => decodeTradingView({ ...historical, subtype }));
  for (const bad of ['\ud800', 'x'.repeat(1_048_577)]) {
    assert.throws(() => decodeTradingView({ ...historical, location: bad }));
    assert.throws(() =>
      decodeTradingContactView({
        postId,
        contacts: { wechat: bad, qq: '', phone: '' },
      }),
    );
  }
  assert.equal(
    decodeTradingView({ ...historical, location: 'x'.repeat(1_048_576) })
      .location.length,
    1_048_576,
  );
});

test('dedicated contact DTO is exact and immutable with no actors, visibility flags or hidden data', () => {
  const raw = { postId, contacts: tradingContacts() };
  const decoded = decodeTradingContactView(raw);
  assert.deepEqual(decoded, raw);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.contacts));
  for (const value of [
    { ...raw, accountId: otherId },
    { ...raw, text: 'hidden body' },
    { ...raw, postId: '1' },
    { ...raw, contacts: { ...raw.contacts, accountId: otherId } },
    { ...raw, contacts: { ...raw.contacts, studentNumber: 'private' } },
    { ...raw, contacts: { ...raw.contacts, phone: { value: 'private' } } },
  ])
    assert.throws(() => decodeTradingContactView(value));
  for (const value of [
    { ...tradingIntent(), resolution: 'resolved' },
    {
      ...tradingIntent(),
      contacts: { ...tradingContacts(), profileId: otherId },
    },
  ])
    assert.throws(() => decodeTradingIntent(value));
});

test('resolution receipts are minimal immutable terminal records, never a mutable listing snapshot', () => {
  const raw = tradingReceipt();
  assert.deepEqual(decodeTradingReceipt(raw), raw);
  assert.ok(Object.isFrozen(decodeTradingReceipt(raw)));
  for (const resolution of ['open', 'resolved'])
    assert.equal(
      decodeTradingReceipt({ ...raw, resolution }).outcome,
      'applied',
    );
  for (const code of [
    'POST_NOT_FOUND',
    'COMMUNITY_SCOPE_UNAVAILABLE',
    'PHONE_VERIFICATION_REQUIRED',
    'COMMUNITY_ACTION_RESTRICTED',
  ])
    assert.equal(
      decodeTradingReceipt({
        requestId,
        operation: 'set_trading_resolution',
        outcome: 'rejected',
        code,
      }).outcome,
      'rejected',
    );
  for (const value of [
    { ...raw, outcome: 'pending' },
    { ...raw, outcome: 'created' },
    { ...raw, operation: 'publish_post' },
    { ...raw, requestId: '77777777-7777-1777-8777-777777777777' },
    { ...raw, resolution: true },
    { ...raw, resourceId: 'bad' },
    { ...raw, accountId: otherId },
    { ...raw, contacts: tradingContacts() },
    { ...raw, text: 'hidden body' },
    { ...raw, trading: tradingView() },
    { ...raw, currentResolution: 'open' },
    {
      requestId,
      operation: 'set_trading_resolution',
      outcome: 'rejected',
      code: 'REQUEST_NOT_FOUND',
    },
    {
      requestId,
      operation: 'set_trading_resolution',
      outcome: 'rejected',
      code: 'SESSION_REVOKED',
    },
    {
      requestId,
      operation: 'set_trading_resolution',
      outcome: 'rejected',
      code: 'POST_NOT_FOUND',
      resourceId: postId,
    },
  ])
    assert.throws(() => decodeTradingReceipt(value));
});
