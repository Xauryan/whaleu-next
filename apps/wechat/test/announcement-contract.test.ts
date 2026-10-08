import assert from 'node:assert/strict';
import test from 'node:test';
import {
  announcementTimestamp,
  decodeAnnouncementChanges,
  decodeAnnouncementDetail,
  decodeAnnouncementOwnerPopup,
  decodeAnnouncementPage,
  decodeAnnouncementPublicPopup,
  decodeAnnouncementReceipt,
} from '../src/announcements/contract';
import {
  bodyText,
  changes,
  detail,
  popup,
  summary,
  timestamp,
} from './announcement-helpers';
test('announcement DTOs preserve paragraphs, indentation, literal markup, unknown timestamps and exact microseconds', () => {
  assert.equal(decodeAnnouncementDetail(detail()).bodyText, bodyText);
  assert.equal(decodeAnnouncementDetail(detail()).createdAt, timestamp);
  assert.equal(decodeAnnouncementDetail(detail()).updatedAt, null);
  assert.equal(
    decodeAnnouncementChanges(changes()).newness.newCount,
    '9007199254740993',
  );
  for (const value of [
    timestamp,
    '2026-10-08T00:00:00.000001Z',
    '2024-02-29T23:59:59-05:00',
  ])
    assert.equal(announcementTimestamp(value), true);
  for (const value of [
    '2026-02-29T00:00:00Z',
    '2026-10-08T24:00:00Z',
    '2026-10-08T00:00:00.1234567Z',
    '2026-10-08T00:00:00',
    '2026-10-08T00:00:00+08:99',
  ])
    assert.equal(announcementTimestamp(value), false);
});
test('strict announcement decoders reject private facts/raw media, malformed dates/text and inconsistent discriminants', () => {
  for (const value of [
    { ...detail(), accountId: 'private' },
    { ...detail(), bodyText: { a: 'bad' } },
    { ...detail(), bodyText: '\u0000' },
    { ...detail(), title: 'x'.repeat(200001) },
    { ...detail(), bodyText: '\uD800' },
    { ...detail(), announcementDate: '2026-02-30' },
    {
      ...detail(),
      media: { status: 'known_empty', items: ['https://private.example'] },
    },
    { ...detail(), media: { status: 'unavailable', items: [] } },
  ])
    assert.throws(() => decodeAnnouncementDetail(value));
  assert.throws(() =>
    decodeAnnouncementChanges({
      ...changes(),
      newness: { status: 'available', hasNew: false, newCount: '1' },
    }),
  );
  assert.throws(() =>
    decodeAnnouncementChanges({
      ...changes(),
      newness: { status: 'available', hasNew: true, newCount: '01' },
    }),
  );
  assert.throws(() =>
    decodeAnnouncementOwnerPopup({
      context: { campusId: null },
      candidate: null,
      acknowledgement: { status: 'unseen', acknowledgedAt: null },
    }),
  );
  assert.throws(() =>
    decodeAnnouncementOwnerPopup({
      context: { campusId: null },
      candidate: popup(),
      acknowledgement: { status: 'unavailable', acknowledgedAt: timestamp },
    }),
  );
  assert.throws(() =>
    decodeAnnouncementReceipt({
      announcementId: summary().id,
      acknowledgement: { status: 'unseen', acknowledgedAt: null },
    }),
  );
  assert.deepEqual(
    decodeAnnouncementPublicPopup({ context: { campusId: null }, popup: null }),
    { context: { campusId: null }, popup: null },
  );
  assert.equal(
    decodeAnnouncementOwnerPopup({
      context: { campusId: null },
      candidate: popup(),
      acknowledgement: { status: 'acknowledged', acknowledgedAt: null },
    }).candidate?.id,
    popup().id,
  );
  assert.throws(() =>
    decodeAnnouncementPage({
      context: { campusId: null },
      items: [summary(), summary()],
      continuation: 'end',
      nextCursor: null,
    }),
  );
});
