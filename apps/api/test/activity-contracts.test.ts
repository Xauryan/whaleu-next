import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  activityListQuerySchema,
  activityVisitCommandSchema,
  activityMediaSchema,
  activityGallerySchema,
  activityPageSchema,
  activityTimestampSchema,
  activityTextSchema,
} from '../src/activities/contracts.js';
import {
  activityPositionSchema,
  activityCursorScope,
} from '../src/activities/cursor.js';
import {
  activitySummary,
  activityDetail,
} from '../src/activities/projection.js';
import type { StoredActivity } from '../src/activities/projection.js';
import { ActivitiesRepository } from '../src/activities/repository.js';
const catalog = {
  id: randomUUID(),
  regionId: randomUUID(),
  orderingVersion: 'source-created-desc-v1' as const,
};
const row: StoredActivity = {
  id: randomUUID(),
  revision: randomUUID(),
  region_id: catalog.regionId,
  display_ordinal: '9007199254740993',
  title: '标题',
  body_text: '\n第一段\n\n  缩进\t😀\n',
  organizer_label: '组织',
  activity_time: null,
  activity_location: '待定',
  reward: null,
  online: null,
  source_created_at: null,
  cover_state: 'absent',
  avatar_state: 'unavailable',
  gallery_state: 'unavailable',
  qr_state: 'unavailable',
};
test('activity strict contracts preserve unknown, original text, precise timestamps and no private/media fields', () => {
  assert.deepEqual(activityListQuerySchema.parse({}), {
    window: 'entry',
    limit: 20,
  });
  for (const value of [
    { limit: '01' },
    { limit: 0 },
    { limit: 51 },
    { window: 'past' },
    { q: 'x' },
    { limit: ['1', '2'] },
    { cursor: 'bad' },
  ])
    assert.equal(activityListQuerySchema.safeParse(value).success, false);
  assert.equal(
    activityVisitCommandSchema.safeParse({
      regionId: catalog.regionId,
      expectedCatalogRevision: catalog.id,
      userId: randomUUID(),
    }).success,
    false,
  );
  assert.equal(
    activityMediaSchema.safeParse({
      status: 'unavailable',
      url: 'https://example.org',
    }).success,
    false,
  );
  assert.equal(
    activityMediaSchema.safeParse({
      status: 'available',
      url: 'https://example.org',
    }).success,
    false,
  );
  assert.equal(
    activityGallerySchema.safeParse({ status: 'unavailable', items: [] })
      .success,
    false,
  );
  assert.equal(
    activityGallerySchema.safeParse({ status: 'known_empty', items: ['asset'] })
      .success,
    false,
  );
  assert.equal(
    activityTimestampSchema.safeParse('2026-10-08T10:00:00.1234567Z').success,
    false,
  );
  assert.equal(
    activityTimestampSchema.parse('2026-10-08T10:00:00.123456Z'),
    '2026-10-08T10:00:00.123456Z',
  );
  for (const text of ['\0', '\u000b', '\uD800'])
    assert.equal(activityTextSchema.safeParse(text).success, false);
  assert.equal(activityDetail(row).bodyText, row.body_text);
  assert.deepEqual(activitySummary(row).reward, {
    status: 'unavailable',
    value: null,
  });
  assert.deepEqual(activitySummary(row).createdAt, {
    status: 'unavailable',
    value: null,
  });
  const page = {
    context: { regionId: catalog.regionId, catalogRevision: catalog.id },
    selection: { kind: 'historical', maximum: 10 },
    items: [activitySummary(row)],
    continuation: 'end',
    nextCursor: null,
    pageCursor: 'a'.repeat(43),
  };
  assert.equal(activityPageSchema.safeParse(page).success, true);
  for (const patch of [
    { items: [activitySummary(row), activitySummary(row)] },
    { nextCursor: 'b'.repeat(43) },
    { pageCursor: undefined },
    { sourceId: 'raw' },
  ])
    assert.equal(
      activityPageSchema.safeParse({ ...page, ...patch }).success,
      false,
    );
});
test('activity cursor selection is immutable strict coordinate; scope excludes mutable visit state and includes all current authority', () => {
  const position = {
    v: 1,
    kind: 'activities',
    catalogRevision: catalog.id,
    after: null,
    selection: { kind: 'historical', maximum: 10 },
    remaining: 10,
  };
  assert.equal(activityPositionSchema.safeParse(position).success, true);
  for (const patch of [
    { after: '9223372036854775808' },
    { remaining: 0 },
    { remaining: null },
    { selection: { kind: 'all' } },
    { bodyText: 'private' },
  ])
    assert.equal(
      activityPositionSchema.safeParse({ ...position, ...patch }).success,
      false,
    );
  const actor = {
      accountId: randomUUID(),
      sessionId: randomUUID(),
      expiresAt: 10000,
      refreshExpiresAt: 20000,
    },
    selection = randomUUID(),
    topology = randomUUID(),
    query = activityListQuerySchema.parse({});
  const scope = activityCursorScope(catalog, query, actor, selection, topology);
  for (const changed of [
    activityCursorScope(
      catalog,
      { ...query, window: 'all' },
      actor,
      selection,
      topology,
    ),
    activityCursorScope(
      catalog,
      { ...query, limit: 2 },
      actor,
      selection,
      topology,
    ),
    activityCursorScope(
      { ...catalog, id: randomUUID() },
      query,
      actor,
      selection,
      topology,
    ),
    activityCursorScope(
      catalog,
      query,
      { ...actor, sessionId: randomUUID() },
      selection,
      topology,
    ),
    activityCursorScope(catalog, query, actor, randomUUID(), topology),
    activityCursorScope(catalog, query, actor, selection, randomUUID()),
  ])
    assert.notEqual(changed, scope);
});
test('first-entry selection retains exact DB anchor and strict 72-hour SQL; known visited and explicit all bypass unknown creation facts', async () => {
  const records = new ActivitiesRepository();
  let history: 'visited' | 'never_visited' | 'unavailable' = 'never_visited';
  records.history = async () => history;
  let unknown = false,
    recent = true,
    calls = 0;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls++;
      if (sql.includes("interval '72 hours'"))
        return { rows: [{ since: '2026-10-05T10:00:00.000001Z' }] };
      assert.ok(sql.includes('r.source_created_at>$3::timestamptz'));
      assert.deepEqual(values, [
        catalog.id,
        catalog.regionId,
        '2026-10-05T10:00:00.000001Z',
      ]);
      return { rows: [{ unknown, recent }] };
    },
  } as unknown as PoolClient;
  assert.deepEqual(
    await records.selection(catalog, randomUUID(), 'entry', tx),
    { kind: 'recent', since: '2026-10-05T10:00:00.000001Z' },
  );
  recent = false;
  assert.deepEqual(
    await records.selection(catalog, randomUUID(), 'entry', tx),
    { kind: 'historical', maximum: 10 },
  );
  unknown = true;
  await assert.rejects(records.selection(catalog, randomUUID(), 'entry', tx));
  const before = calls;
  history = 'visited';
  assert.deepEqual(
    await records.selection(catalog, randomUUID(), 'entry', tx),
    { kind: 'all' },
  );
  history = 'unavailable';
  assert.deepEqual(await records.selection(catalog, randomUUID(), 'all', tx), {
    kind: 'all',
  });
  assert.equal(calls, before);
  await assert.rejects(records.selection(catalog, randomUUID(), 'entry', tx));
});
