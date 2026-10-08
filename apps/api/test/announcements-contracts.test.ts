import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  announcementAckCommandSchema,
  announcementChangesQuerySchema,
  announcementChangesSchema,
  announcementListQuerySchema,
  announcementMediaSchema,
  announcementOwnerPopupSchema,
  announcementPageSchema,
  announcementTextSchema,
} from '../src/announcements/contracts.js';
import { optionalAnnouncementBearer } from '../src/announcements/access.js';
import {
  announcementDetail,
  announcementPopup,
  announcementSummary,
} from '../src/announcements/projection.js';
import type { StoredAnnouncement } from '../src/announcements/projection.js';
import {
  announcementCursorScope,
  announcementPositionSchema,
} from '../src/announcements/cursor.js';
function row(overrides: Partial<StoredAnnouncement> = {}): StoredAnnouncement {
  return {
    id: randomUUID(),
    revision: randomUUID(),
    source_ordinal: '9007199254740993',
    version_label: 'v2 / 同版本',
    title: '公告',
    body_text: '第一段\n\n  缩进\n\t制表符 😀\n',
    announcement_date: null,
    source_created_at: null,
    source_updated_at: null,
    highlight: true,
    popup_enabled: true,
    popup_title_state: 'absent',
    popup_title: null,
    popup_body_state: 'absent',
    popup_body_text: null,
    media_state: 'unavailable',
    ...overrides,
  };
}
test('announcement inputs are strict, guest is absent-only, since retains exact microseconds and zone', () => {
  assert.deepEqual(announcementListQuerySchema.parse({}), { limit: 20 });
  for (const value of [
    { limit: 51 },
    { limit: '01' },
    { limit: ['2', '3'] },
    { campusId: ['x'] },
    { regionId: randomUUID() },
    { ownerId: randomUUID() },
    { cursor: 'hello' },
  ])
    assert.equal(announcementListQuerySchema.safeParse(value).success, false);
  assert.equal(optionalAnnouncementBearer(undefined), null);
  for (const value of [null, '', 'Bearer bad', 'Basic abc', ['Bearer bad']])
    assert.throws(() => optionalAnnouncementBearer(value), {
      code: 'AUTHENTICATION_REQUIRED',
    });
  const since = '2026-10-08T13:30:20.123456+08:00';
  assert.equal(announcementChangesQuerySchema.parse({ since }).since, since);
  for (const since of [
    '2026-10-08T13:30:20',
    '2026-10-08',
    '2026-10-08T13:30:20.1234567Z',
    'yesterday',
  ])
    assert.equal(
      announcementChangesQuerySchema.safeParse({ since }).success,
      false,
    );
  assert.equal(
    announcementAckCommandSchema.safeParse({
      campusId: null,
      expectedRevision: randomUUID(),
      accountId: randomUUID(),
    }).success,
    false,
  );
  assert.equal(
    announcementAckCommandSchema.safeParse({ expectedRevision: randomUUID() })
      .success,
    false,
  );
});
test('announcement text projection preserves paragraphs, independent dates and no private/source/media facts', () => {
  const source = {
    ...row(),
    created_by: randomUUID(),
    source_reference: 'PRIVATE',
    raw_url: 'https://private.invalid/image',
  };
  const detail = announcementDetail(source, source.id);
  assert.equal(detail.bodyText, source.body_text);
  assert.equal(detail.isLatest, true);
  assert.equal(detail.createdAt, null);
  assert.equal(detail.announcementDate, null);
  assert.equal(detail.updatedAt, null);
  assert.deepEqual(detail.media, { status: 'unavailable', items: null });
  assert.equal(JSON.stringify(detail).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(detail).includes('private.invalid'), false);
  const sameVersion = row({ version_label: source.version_label });
  assert.notEqual(announcementSummary(sameVersion, source.id).id, detail.id);
  assert.equal(announcementSummary(sameVersion, source.id).isLatest, false);
  for (const text of [{ body: 'bad' }, ['one', 'two'], 'x\0y', '\ud800'])
    assert.equal(announcementTextSchema.safeParse(text).success, false);
  assert.equal(
    announcementTextSchema.parse('😀\n\n  末尾\n'),
    '😀\n\n  末尾\n',
  );
});
test('popup overrides fall back only when known absent and unknown media never becomes empty', () => {
  const source = row();
  const popup = announcementPopup(source);
  assert.equal(popup.title, source.title);
  assert.equal(popup.bodyText, source.body_text);
  assert.equal(
    announcementPopup(
      row({
        popup_title_state: 'value',
        popup_title: '',
        popup_body_state: 'value',
        popup_body_text: '\n\n',
      }),
    ).bodyText,
    '\n\n',
  );
  assert.throws(() => announcementPopup(row({ popup_body_state: 'unknown' })), {
    code: 'ANNOUNCEMENTS_UNAVAILABLE',
  });
  assert.equal(
    announcementMediaSchema.safeParse({
      status: 'known_empty',
      items: ['https://source.invalid'],
    }).success,
    false,
  );
  assert.equal(
    announcementMediaSchema.safeParse({ status: 'unavailable', items: [] })
      .success,
    false,
  );
  assert.equal(
    announcementOwnerPopupSchema.safeParse({
      context: { campusId: null },
      candidate: null,
      acknowledgement: { status: 'unseen', acknowledgedAt: null },
    }).success,
    false,
  );
});
test('newness keeps arbitrary precision decimal and available-zero distinct from unknown', () => {
  const base = {
    context: { campusId: null },
    since: '2026-10-01T00:00:00.000001Z',
    checkedAt: '2026-10-08T00:00:00.000001Z',
  };
  const result = announcementChangesSchema.parse({
    ...base,
    newness: {
      status: 'available',
      hasNew: true,
      newCount: '9007199254740993',
    },
  });
  assert.equal(result.newness.newCount, '9007199254740993');
  for (const newness of [
    { status: 'available', hasNew: true, newCount: '0' },
    { status: 'available', hasNew: false, newCount: '1' },
    { status: 'available', hasNew: false, newCount: 0 },
    { status: 'available', hasNew: true, newCount: '01' },
    { status: 'unavailable', hasNew: false, newCount: '0' },
  ])
    assert.equal(
      announcementChangesSchema.safeParse({ ...base, newness }).success,
      false,
    );
  assert.equal(
    announcementChangesSchema.parse({
      ...base,
      newness: { status: 'unavailable', hasNew: null, newCount: null },
    }).newness.newCount,
    null,
  );
});
test('opaque announcement navigation binds guest/session/campus/limit/catalog with exact ordinals', () => {
  const catalog = {
    id: randomUUID(),
    orderingVersion: 'source-id-desc-v1' as const,
  };
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: 10,
    refreshExpiresAt: 20,
  };
  const guest = announcementCursorScope(catalog, null, 20, null);
  assert.notEqual(guest, announcementCursorScope(catalog, null, 20, session));
  assert.notEqual(
    guest,
    announcementCursorScope(catalog, randomUUID(), 20, null),
  );
  assert.notEqual(guest, announcementCursorScope(catalog, null, 50, null));
  assert.notEqual(
    guest,
    announcementCursorScope({ ...catalog, id: randomUUID() }, null, 20, null),
  );
  assert.notEqual(
    announcementCursorScope(catalog, null, 20, session),
    announcementCursorScope(catalog, null, 20, {
      ...session,
      sessionId: randomUUID(),
    }),
  );
  const position = {
    v: 1,
    kind: 'announcements',
    catalogRevision: catalog.id,
    after: '9223372036854775807',
  };
  assert.equal(
    announcementPositionSchema.parse(position).after,
    position.after,
  );
  for (const after of ['01', '-1', '9223372036854775808', 9007199254740992])
    assert.equal(
      announcementPositionSchema.safeParse({ ...position, after }).success,
      false,
    );
  const item = announcementSummary(row(), null);
  assert.equal(
    announcementPageSchema.safeParse({
      context: { campusId: null },
      items: [item, item],
      continuation: 'end',
      nextCursor: null,
    }).success,
    false,
  );
});
