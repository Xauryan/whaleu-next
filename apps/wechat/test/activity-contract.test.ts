import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityTimestamp,
  decodeActivityContext,
  decodeActivityDetail,
  decodeActivityPage,
  decodeActivitySummary,
  decodeActivityVisitIntent,
  decodeActivityVisitReceipt,
} from '../src/activities/contract';
import { decodeActivityRoute } from '../src/activities/controller';
import {
  activityId,
  detail,
  otherRegion,
  page,
  receipt,
  regionId,
  summary,
  token,
  visitIntent,
} from './activity-helpers';
test('activity wire preserves exact source free text, known false, unknown facts and absent versus unavailable media', () => {
  assert.deepEqual(decodeActivityDetail(detail()), detail());
  assert.deepEqual(
    decodeActivityDetail(
      detail({
        activityTime: null,
        activityLocation: '',
        gallery: { status: 'known_empty', items: [] },
        reward: { status: 'known', value: false },
      }),
    ).gallery,
    { status: 'known_empty', items: [] },
  );
  for (const kind of [
    { kind: 'all' },
    { kind: 'recent', since: '2026-10-01T12:00:00.123456+08:00' },
    { kind: 'historical', maximum: 10 },
  ])
    assert.deepEqual(
      decodeActivityPage({ ...page(), selection: kind }).selection,
      kind,
    );
  assert.equal(
    decodeActivityContext({ regionId, visitHistory: 'unavailable' })
      .visitHistory,
    'unavailable',
  );
  assert.deepEqual(decodeActivityVisitReceipt(receipt()), receipt());
});
test('activity decoders reject extra/private/raw media/source fields and inconsistent unknown states at every level', () => {
  for (const value of [
    { ...summary(), publisherId: otherRegion },
    { ...summary(), sourceId: 1 },
    {
      ...summary(),
      cover: { status: 'unavailable', url: 'https://private.example' },
    },
    {
      ...summary(),
      organizerAvatar: { status: 'available', url: 'https://image.example' },
    },
    { ...summary(), reward: { status: 'known', value: null } },
    { ...summary(), online: { status: 'unavailable', value: 'online' } },
    {
      ...summary(),
      createdAt: { status: 'known', value: '2026-02-30T00:00:00Z' },
    },
    { ...summary(), title: '\ud800' },
    { ...summary(), title: 'x'.repeat(200001) },
  ])
    assert.throws(() => decodeActivitySummary(value));
  for (const value of [
    { ...detail(), gallery: { status: 'unavailable', items: [] } },
    { ...detail(), gallery: { status: 'known_empty', items: ['raw-key'] } },
    { ...detail(), organizerQr: { status: 'absent', value: null } },
    { ...detail(), activityTime: 42 },
    { ...detail(), bodyText: '\u000b' },
  ])
    assert.throws(() => decodeActivityDetail(value));
  for (const value of [
    { ...page(), items: [summary(), summary()] },
    { ...page(), nextCursor: token() },
    { ...page(), continuation: 'more' },
    { ...page(), continuation: 'more', nextCursor: token(2), items: [] },
    { ...page(), selection: { kind: 'historical', maximum: 11 } },
    { ...page(), context: { ...page().context, accountId: otherRegion } },
    { ...page(), pageCursor: null },
    { ...page(), count: 0 },
    { ...page(), items: Array.from({ length: 51 }, () => summary()) },
  ])
    assert.throws(() => decodeActivityPage(value));
});
test('activity routes and visit coordinates accept IDs only, never snapshots or account overrides', () => {
  assert.deepEqual(decodeActivityRoute({ regionId, activityId }), {
    regionId,
    activityId,
  });
  for (const route of [
    { regionId, activityId, title: 'snapshot' },
    { regionId, activityId: '../x' },
    {},
    { regionId: [regionId], activityId },
  ])
    assert.throws(() => decodeActivityRoute(route));
  assert.deepEqual(decodeActivityVisitIntent(visitIntent()), visitIntent());
  assert.throws(() =>
    decodeActivityVisitIntent({ ...visitIntent(), accountId: otherRegion }),
  );
  assert.throws(() =>
    decodeActivityVisitReceipt({ ...receipt(), replayed: true }),
  );
  assert.throws(() =>
    decodeActivityContext({ regionId, visitHistory: 'never' }),
  );
  for (const value of [
    '2026-02-29T00:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T00:00:00.1234567Z',
    '2026-01-01',
    42,
  ])
    assert.equal(activityTimestamp(value), false);
});
