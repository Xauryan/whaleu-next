import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  directoryCategoryQuerySchema,
  directoryEntryQuerySchema,
  directorySearchSchema,
  directorySummarySchema,
  directoryDetailSchema,
  directoryCategoryPageSchema,
  directoryEmptyBodySchema,
} from '../src/organizations/directory/contracts.js';
import {
  directoryCategory,
  directorySummary,
  directoryDetail,
  directoryStoredMediaSchema,
} from '../src/organizations/directory/projection.js';
import type { StoredDirectoryEntry } from '../src/organizations/directory/projection.js';
import {
  directoryCursorScope,
  directoryPositionSchema,
  DirectoryCursorRepository,
} from '../src/organizations/directory/cursor.js';
import { literalDirectoryPattern } from '../src/organizations/directory/repository.js';
import type { DirectoryCatalog } from '../src/organizations/directory/repository.js';
import type { DiscoveryContinuationFacade } from '../src/community/discovery-continuation.module.js';
import type { PoolClient } from 'pg';
const absent = { status: 'absent', reference: null };
function row(
  overrides: Partial<StoredDirectoryEntry> = {},
): StoredDirectoryEntry {
  return {
    id: randomUUID(),
    category_id: randomUUID(),
    kind: 'org',
    platform: 'qq',
    name: '校园社团',
    intro_text: '介绍'.repeat(200),
    badge_state: 'known',
    badge: 'official',
    media: {
      avatar: absent,
      mainQr: { status: 'referenced', reference: 'private/legacy.png' },
      managerWechatImage: absent,
      linkedOfficialAccountQr: { status: 'unknown', reference: null },
      introImages: { status: 'unknown', references: null },
    },
    qq_state: 'known',
    qq_number: '00123456789',
    source_created_at: null,
    source_updated_at: null,
    display_ordinal: '9007199254740993',
    search_ordinal: '1',
    ...overrides,
  };
}

test('directory query bounds, literal Unicode normalization, and strict request surface', () => {
  assert.deepEqual(directoryCategoryQuerySchema.parse({ kind: 'official' }), {
    kind: 'official',
    limit: 20,
  });
  assert.equal(
    directoryEntryQuerySchema.safeParse({ kind: 'school' }).success,
    false,
  );
  assert.equal(
    directoryEntryQuerySchema.safeParse({ kind: 'school', q: '社团' }).success,
    true,
  );
  assert.equal(
    directoryEntryQuerySchema.safeParse({
      kind: 'school',
      q: '社团',
      user_id: randomUUID(),
    }).success,
    false,
  );
  for (const limit of [0, 51, 'oops', [], null])
    assert.equal(
      directoryCategoryQuerySchema.safeParse({ kind: 'org', limit }).success,
      false,
    );
  assert.equal(directorySearchSchema.parse('  中文 %_\\  '), '中文 %_\\');
  assert.equal(directorySearchSchema.safeParse('😀'.repeat(100)).success, true);
  for (const q of [
    '',
    '   ',
    'a'.repeat(101),
    'a\0b',
    '\na',
    'a\tb',
    'a\u007fb',
    '\ud800',
    '\udfff',
  ])
    assert.equal(
      directorySearchSchema.safeParse(q).success,
      false,
      JSON.stringify(q),
    );
  assert.equal(literalDirectoryPattern('甲%_\\a'), '%甲\\%\\_\\\\a%');
  assert.equal(
    directoryEmptyBodySchema.safeParse({ user_id: 'x' }).success,
    false,
  );
  assert.equal(directoryEmptyBodySchema.safeParse(undefined).success, true);
});

test('kind, platform, badge remain independent; summary omits contact and private sources', () => {
  const source = row();
  const view = directorySummary(source);
  assert.equal(view.kind, 'org');
  assert.equal(view.platform, 'qq');
  assert.deepEqual(view.badge, { status: 'known', value: 'official' });
  assert.equal(Array.from(view.introPreview).length, 160);
  assert.equal('qqGroupNumber' in view, false);
  assert.equal('media' in view, false);
  assert.equal(JSON.stringify(view).includes('private/'), false);
  assert.equal(
    directorySummarySchema.safeParse({ ...view, qqGroupNumber: '12345' })
      .success,
    false,
  );
  assert.equal(
    directorySummarySchema.safeParse({
      ...view,
      created_by_user_id: randomUUID(),
    }).success,
    false,
  );
  assert.throws(
    () => directorySummary(row({ badge_state: 'unknown', badge: 'official' })),
    /unavailable/,
  );
  const category = directoryCategory({
    id: randomUUID(),
    kind: 'official',
    name: '官方分类',
    description: '保留描述'.repeat(100),
    accent: 'cyan',
    display_ordinal: '0',
  });
  assert.equal(category.description.length, 400);
  assert.equal('display_ordinal' in category, false);
});

test('detail distinguishes known null, unknown, absent, inapplicable and unavailable media without false dates/counts', () => {
  const source = row();
  const view = directoryDetail(source);
  assert.equal(view.platform, 'qq');
  assert.deepEqual(view.qqGroupNumber, {
    status: 'known',
    value: '00123456789',
  });
  assert.deepEqual(view.mainQr, { status: 'unavailable', value: null });
  assert.deepEqual(view.avatar, { status: 'absent', value: null });
  assert.deepEqual(view.introImages, { status: 'unavailable', items: null });
  assert.deepEqual(view.managerWechatImage, {
    status: 'not_applicable',
    value: null,
  });
  assert.equal(view.createdAt, null);
  assert.equal(view.updatedAt, null);
  assert.deepEqual(view.visits, { status: 'unavailable', value: null });
  assert.deepEqual(view.managers, { status: 'unavailable', items: null });
  assert.equal(JSON.stringify(view).includes('private/'), false);
  const inapplicableUnknown = directoryDetail(
    row({
      media: {
        ...(source.media as object),
        managerWechatImage: { status: 'unknown', reference: null },
      },
    }),
  );
  assert.deepEqual(inapplicableUnknown.managerWechatImage, {
    status: 'not_applicable',
    value: null,
  });
  const noNumber = directoryDetail(row({ qq_number: null }));
  assert.deepEqual(noNumber.qqGroupNumber, { status: 'known', value: null });
  const unknown = directoryDetail(
    row({
      qq_state: 'unknown',
      qq_number: null,
      badge_state: 'unknown',
      badge: null,
    }),
  );
  assert.deepEqual(unknown.qqGroupNumber, {
    status: 'unavailable',
    value: null,
  });
  assert.deepEqual(unknown.badge, { status: 'unavailable', value: null });
  const official = directoryDetail(
    row({
      platform: 'official',
      qq_state: 'not_applicable',
      qq_number: null,
      media: {
        avatar: absent,
        mainQr: absent,
        managerWechatImage: absent,
        linkedOfficialAccountQr: absent,
        introImages: { status: 'known', references: [] },
      },
    }),
  );
  assert.deepEqual(official.qqGroupNumber, {
    status: 'not_applicable',
    value: null,
  });
  assert.deepEqual(official.linkedOfficialAccountQr, {
    status: 'not_applicable',
    value: null,
  });
  assert.deepEqual(official.introImages, { status: 'known', items: [] });
  for (const mutate of [
    { platform: 'official' },
    { mainQr: { status: 'available', value: 'https://bad.test' } },
    { visits: { status: 'unavailable', value: 0 } },
    { managers: { status: 'unavailable', items: [] } },
    { extra: true },
  ])
    assert.equal(
      directoryDetailSchema.safeParse({ ...view, ...mutate }).success,
      false,
    );
  assert.throws(
    () => directoryDetail(row({ qq_number: 'abc' })),
    /unavailable/,
  );
  assert.throws(
    () => directoryDetail(row({ source_created_at: new Date(NaN) })),
    /unavailable/,
  );
  assert.equal(
    directoryStoredMediaSchema.safeParse({
      ...(source.media as object),
      arbitraryUrl: 'https://private.test',
    }).success,
    false,
  );
});

test('page/opaque cursor contracts reject extra data, loops coordinates and inconsistent end state', () => {
  assert.equal(
    directoryCategoryPageSchema.safeParse({
      items: [],
      continuation: 'end',
      nextCursor: null,
    }).success,
    true,
  );
  assert.equal(
    directoryCategoryPageSchema.safeParse({
      items: [],
      continuation: 'more',
      nextCursor: 'a'.repeat(43),
    }).success,
    false,
  );
  assert.equal(
    directoryCategoryPageSchema.safeParse({
      items: [],
      continuation: 'end',
      nextCursor: null,
      total: 0,
    }).success,
    false,
  );
  const position = {
    v: 1,
    kind: 'directory-entries',
    catalogRevision: randomUUID(),
    taxonomyRevision: randomUUID(),
    after: '9223372036854775807',
  };
  assert.equal(directoryPositionSchema.safeParse(position).success, true);
  for (const after of [
    '-1',
    '01',
    '1.0',
    '9223372036854775808',
    '1'.repeat(100),
  ])
    assert.equal(
      directoryPositionSchema.safeParse({ ...position, after }).success,
      false,
    );
});

test('cursor binds account/session/identity/region/kind/category/query/limit/revisions/order', () => {
  const catalog: DirectoryCatalog = {
    id: randomUUID(),
    taxonomyId: randomUUID(),
    regionId: randomUUID(),
    kind: 'org',
    orderingVersion: 'source-snapshot-v1',
  };
  const session = {
    accountId: randomUUID(),
    sessionId: randomUUID(),
    expiresAt: 123,
    refreshExpiresAt: 456,
  };
  const query = {
    kind: 'org' as const,
    categoryId: randomUUID(),
    q: '甲',
    limit: 20,
  };
  const scope = directoryCursorScope(
    'entries',
    catalog,
    query,
    session,
    'selection',
    'topology',
  );
  for (const changed of [
    directoryCursorScope(
      'categories',
      catalog,
      query,
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      { ...catalog, id: randomUUID() },
      query,
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      { ...catalog, taxonomyId: randomUUID() },
      query,
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      { ...catalog, regionId: randomUUID() },
      query,
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      { ...catalog, kind: 'school' },
      query,
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      catalog,
      { ...query, categoryId: randomUUID() },
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      catalog,
      { ...query, q: '乙' },
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      catalog,
      { ...query, limit: 50 },
      session,
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      catalog,
      query,
      { ...session, sessionId: randomUUID() },
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      catalog,
      query,
      { ...session, accountId: randomUUID() },
      'selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      catalog,
      query,
      session,
      'new-selection',
      'topology',
    ),
    directoryCursorScope(
      'entries',
      catalog,
      query,
      session,
      'selection',
      'new-topology',
    ),
  ])
    assert.notEqual(changed, scope);
});

test('wrong opaque cursor binding is an explicit restart, never a silent first page', async () => {
  const owner = {
    get: async () => {
      throw new BadRequestException('Invalid request');
    },
  } as unknown as DiscoveryContinuationFacade;
  const cursor = new DirectoryCursorRepository(owner);
  await assert.rejects(
    cursor.get(
      'a'.repeat(43),
      'scope',
      {
        id: randomUUID(),
        taxonomyId: randomUUID(),
        regionId: randomUUID(),
        kind: 'org',
        orderingVersion: 'source-snapshot-v1',
      },
      'entries',
      {} as PoolClient,
    ),
    { code: 'DISCOVERY_RESTART_REQUIRED' },
  );
});
