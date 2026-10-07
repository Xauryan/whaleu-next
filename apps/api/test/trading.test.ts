import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  canonicalPrice,
  tradingInputSchema,
  tradingSubtypeSchema,
  setTradingResolutionSchema,
} from '../src/community/trading/contracts.js';
import {
  publishPostSchema,
  feedQuerySchema,
} from '../src/community/contracts.js';
import { publicationHash } from '../src/community/publication.repository.js';
import { postIntent } from '../src/community/publication-intent.js';
const trading = {
  subtype: 'shuma',
  price: '0001.23000',
  location: ' 北区 ',
  contacts: { wechat: 'chosen-contact', qq: '', phone: '' },
};
const post = {
  clientRequestId: randomUUID(),
  spaceId: randomUUID(),
  category: 'trading',
  text: 'synthetic',
  authorMode: 'named',
  trading,
};
test('trading exact decimal parser never accepts binary float, exponent, junk or rounding', () => {
  for (const [input, expected] of [
    ['0001.23000', '1.23'],
    ['99999.000', '99999'],
    ['0.0000000000000000000000000001', '0.0000000000000000000000000001'],
    ['123.12345678901234567890123456789', '123.12345678901234567890123456789'],
  ])
    assert.equal(canonicalPrice(input!), expected);
  for (const input of [
    '0',
    '0.0',
    '-1',
    '+1',
    '1e1',
    '1元',
    '1.',
    ' 1',
    '1 ',
    'NaN',
    'Infinity',
    '99999.0000000000000001',
    '100000',
    '1.' + '1'.repeat(99),
    '１',
  ])
    assert.equal(canonicalPrice(input), null, input);
  for (const price of [1, 1.25, null, {}, true])
    assert.equal(
      tradingInputSchema.safeParse({ ...trading, price }).success,
      false,
    );
});
test('trading enforces source subtypes, independent required disclosures, byte ceilings and canonical defaults', () => {
  assert.equal(tradingSubtypeSchema.options.length, 13);
  for (const subtype of tradingSubtypeSchema.options) {
    const parsed = tradingInputSchema.parse({ ...trading, subtype });
    assert.equal(parsed.urgency, subtype === 'qiugou' ? 'normal' : 'urgent');
    assert.equal(parsed.price, '1.23');
    assert.equal(parsed.location, ' 北区 ');
  }
  assert.equal(
    tradingInputSchema.parse({
      ...trading,
      subtype: 'qiugou',
      urgency: 'urgent',
    }).urgency,
    'normal',
  );
  for (const extra of [
    { location: ' ' },
    { location: '鲸'.repeat(67) },
    { contacts: { wechat: '鲸'.repeat(17), qq: '', phone: '' } },
    { contacts: { wechat: '', qq: ' ', phone: '' } },
    { contacts: { wechat: 'a', qq: '', phone: '', verifiedPhone: 'b' } },
    { subtype: 'unknown' },
    { price: '1\u0000' },
  ])
    assert.equal(
      tradingInputSchema.safeParse({ ...trading, ...extra }).success,
      false,
    );
  assert.equal(
    tradingInputSchema.safeParse({
      ...trading,
      location: '鲸'.repeat(66) + 'ab',
      contacts: { wechat: 'a'.repeat(50), qq: '', phone: '' },
    }).success,
    true,
  );
  assert.equal(
    tradingInputSchema.parse({ ...trading, location: 'a\r\nb' }).location,
    'a\nb',
  );
});
test('trading composition is named-only and component-exclusive, preserving old post intent hashes', () => {
  assert.equal(publishPostSchema.safeParse(post).success, true);
  for (const change of [
    { authorMode: 'anonymous' },
    { trading: undefined },
    {
      component: {
        kind: 'poll',
        question: 'Q',
        selectionMode: 'single',
        options: ['a', 'b'],
      },
    },
    { component: { kind: 'group' } },
    { category: 'discussion' },
  ])
    assert.equal(
      publishPostSchema.safeParse({ ...post, ...change }).success,
      false,
    );
  const parsed = publishPostSchema.parse(post);
  assert.notEqual(
    publicationHash('publish_post', postIntent(parsed)),
    publicationHash(
      'publish_post',
      postIntent({
        ...parsed,
        trading: {
          ...parsed.trading!,
          contacts: { wechat: 'changed', qq: '', phone: '' },
        },
      }),
    ),
  );
  const old = publishPostSchema.parse({
    ...post,
    category: 'discussion',
    trading: undefined,
  });
  assert.equal(Object.hasOwn(postIntent(old), 'trading'), false);
  assert.equal(
    publishPostSchema.parse({ ...post, component: { kind: 'none' } }).component
      ?.kind,
    'none',
  );
});
test('trading feed filters and resolution intents are strict without actor selectors', () => {
  assert.equal(
    feedQuerySchema.safeParse({
      spaceId: post.spaceId,
      tradingSubtype: 'shuma',
    }).success,
    false,
  );
  assert.equal(
    feedQuerySchema.safeParse({
      spaceId: post.spaceId,
      category: 'trading',
      tradingSubtype: 'shuma',
    }).success,
    true,
  );
  assert.equal(
    feedQuerySchema.safeParse({
      spaceId: post.spaceId,
      category: 'trading',
      tradingSubtype: ['shuma', 'qiugou'],
    }).success,
    false,
  );
  for (const resolution of ['open', 'resolved'])
    assert.equal(
      setTradingResolutionSchema.safeParse({
        clientRequestId: randomUUID(),
        resolution,
      }).success,
      true,
    );
  for (const extra of [
    { resolution: true },
    { resolution: 'sold' },
    { resolution: 'open', actorId: randomUUID() },
    { resolution: 'resolved', urgency: 'normal' },
  ])
    assert.equal(
      setTradingResolutionSchema.safeParse({
        clientRequestId: randomUUID(),
        ...extra,
      }).success,
      false,
    );
});
