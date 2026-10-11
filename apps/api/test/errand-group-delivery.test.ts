import assert from 'node:assert/strict';
import test from 'node:test';
import {
  groupReward,
  groupTitle,
  groupWindow,
  nativeErrandLocator,
  publicGroupPayloadSchema,
} from '../src/notifications/errand-group/contracts.js';
import { groupDeliveryKey } from '../src/notifications/errand-group/repository.js';
const p = {
  eventId: '00000000-0000-4000-8000-000000000001',
  orderId: '00000000-0000-4000-8000-000000000002',
  targetRegionId: '00000000-0000-4000-8000-000000000003',
  publishedAt: 100000,
  firstConfirmedAt: 200000,
};
test('source windows include 16, 15 and 30 minute boundaries and use first proven ACK', () => {
  assert.equal(groupWindow(p, 'errand', p.publishedAt - 1), 'waiting');
  assert.equal(groupWindow(p, 'errand', p.publishedAt + 960000), 'eligible');
  assert.equal(groupWindow(p, 'errand', p.publishedAt + 960001), 'expired');
  assert.equal(groupWindow(p, 'forum', p.firstConfirmedAt + 899999), 'waiting');
  assert.equal(
    groupWindow(p, 'forum', p.firstConfirmedAt + 900000),
    'eligible',
  );
  assert.equal(
    groupWindow(p, 'forum', p.firstConfirmedAt + 1800000),
    'eligible',
  );
  assert.equal(
    groupWindow(p, 'forum', p.firstConfirmedAt + 1800001),
    'expired',
  );
  assert.equal(
    groupWindow({ ...p, firstConfirmedAt: null }, 'forum', 9999999),
    'waiting',
  );
});
test('legacy title distinction and exact decimal public reward, without private payload widening', () => {
  const title = '🦊'.repeat(35);
  assert.equal([...groupTitle(title + '\nprivate line', 'errand')].length, 35);
  assert.equal([...groupTitle(title + '\nprivate line', 'forum')].length, 28);
  assert.equal([...groupTitle(title, 'errand')].length, 28);
  assert.equal(groupReward('12.34567890123456789'), '12.35');
  assert.equal(groupReward('1.005'), '1.01');
  assert.equal(groupReward('499.999'), '500.00');
  const payload = {
    title: 'A',
    reward: '1.00',
    expectedTime: 'Tomorrow',
    sourceLabel: null,
    locator: nativeErrandLocator(p.orderId),
  };
  for (const field of [
    'publicText',
    'privateText',
    'publisherContacts',
    'publicMedia',
    'privateMedia',
    'imageIds',
    'qr',
    'credentials',
  ])
    assert.equal(
      publicGroupPayloadSchema.safeParse({ ...payload, [field]: 'secret' })
        .success,
      false,
    );
  assert.equal(
    groupDeliveryKey(p.eventId, 'errand', 'synthetic:a'),
    groupDeliveryKey(p.eventId, 'errand', 'synthetic:a'),
  );
  assert.notEqual(
    groupDeliveryKey(p.eventId, 'errand', 'synthetic:a'),
    groupDeliveryKey(p.eventId, 'forum', 'synthetic:a'),
  );
});
