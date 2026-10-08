import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalDirectoryQuery,
  decodeDirectoryCategoryPage,
  decodeDirectoryContext,
  decodeDirectoryDetail,
  decodeDirectoryEntry,
  decodeDirectoryEntryPage,
  decodeDirectoryListIntent,
} from '../src/directory/contract';
import { decodeDirectoryRoute } from '../src/directory/controller';
import {
  directoryCategory,
  directoryDetail,
  directoryEntry,
  directoryListRoute,
  directoryRegion,
  directoryToken,
} from './directory-helpers';
test('directory axes, leading-zero QQ number, unknown dates and independent optional facts survive strict decoding', () => {
  for (const platform of ['qq', 'wechat', 'official'] as const) {
    const detail = decodeDirectoryDetail(directoryDetail(platform));
    assert.equal(detail.kind, 'org');
    assert.equal(detail.platform, platform);
    assert.deepEqual(detail.badge, { status: 'known', value: 'official' });
    assert.equal(detail.createdAt, null);
    assert.deepEqual(detail.visits, { status: 'unavailable', value: null });
    assert.equal(detail.introImages.items, null);
    if (platform === 'qq')
      assert.equal(detail.qqGroupNumber.value, '0012345678901234');
    else assert.equal(detail.qqGroupNumber.status, 'not_applicable');
  }
});
test('historical display strings are preserved without new-write caps or normalization', () => {
  const name = '📚'.repeat(8000),
    introText = '<text>\n'.repeat(20000);
  const detail = decodeDirectoryDetail({
    ...directoryDetail(),
    name,
    introText,
    introPreview: introText,
  });
  assert.equal(detail.name, name);
  assert.equal(detail.introText, introText);
  assert.equal(detail.introPreview, introText);
});
test('known absence differs from unknown gallery, contact and badge facts', () => {
  const detail = decodeDirectoryDetail({
    ...directoryDetail(),
    introImages: { status: 'known', items: [] },
    qqGroupNumber: { status: 'known', value: null },
    badge: { status: 'known', value: null },
  });
  assert.deepEqual(detail.introImages, { status: 'known', items: [] });
  assert.deepEqual(detail.qqGroupNumber, { status: 'known', value: null });
  assert.deepEqual(
    decodeDirectoryDetail({
      ...directoryDetail(),
      qqGroupNumber: { status: 'unavailable', value: null },
    }).qqGroupNumber,
    { status: 'unavailable', value: null },
  );
});
test('recursive detail privacy rejects raw URLs/identities, fake available media, wrong platform slots and invented zero counts', () => {
  const invalid = [
    { createdBy: 'private' },
    { avatar: { status: 'unavailable', value: null, url: 'https://private' } },
    { mainQr: { status: 'available', value: 'https://private' } },
    { managerWechatImage: { status: 'absent', value: null } },
    { qqGroupNumber: { status: 'known', value: 12345 } },
    { qqGroupNumber: { status: 'known', value: '1234' } },
    { badge: { status: 'known', value: 'admin' } },
    { badge: { status: 'unavailable', value: 'official' } },
    { introImages: { status: 'known', items: ['private'] } },
    { introImages: { status: 'unavailable', items: [] } },
    { visits: { status: 'known', value: 0 } },
    { managers: { status: 'unavailable', items: [] } },
    { management: { status: 'unavailable', canManage: false } },
    { createdAt: '2026-02-31T00:00:00Z' },
  ];
  for (const patch of invalid)
    assert.throws(() =>
      decodeDirectoryDetail({ ...directoryDetail(), ...patch }),
    );
  assert.throws(() =>
    decodeDirectoryDetail({
      ...directoryDetail('official'),
      linkedOfficialAccountQr: { status: 'absent', value: null },
    }),
  );
});
test('summary, category and context have exact whitelists, contacts never appear in list rows', () => {
  assert.throws(() =>
    decodeDirectoryEntry({ ...directoryEntry(), qqGroupNumber: '12345' }),
  );
  assert.throws(() =>
    decodeDirectoryCategoryPage({
      items: [{ ...directoryCategory(), accent: 'red;url(https://private)' }],
      continuation: 'end',
      nextCursor: null,
    }),
  );
  assert.throws(() =>
    decodeDirectoryContext({ regionId: directoryRegion, accountId: 'private' }),
  );
  assert.deepEqual(decodeDirectoryContext({ regionId: directoryRegion }), {
    regionId: directoryRegion,
  });
});
test('pages enforce cursor states, unique IDs, strict rows, and genuine empty only at end', () => {
  const page = {
    items: [directoryEntry()],
    continuation: 'more',
    nextCursor: directoryToken(),
  };
  assert.equal(decodeDirectoryEntryPage(page).nextCursor, directoryToken());
  for (const patch of [
    { nextCursor: null },
    { nextCursor: 'bad' },
    { items: [] },
    { items: [directoryEntry(), directoryEntry()] },
    { total: 100 },
  ])
    assert.throws(() => decodeDirectoryEntryPage({ ...page, ...patch }));
  assert.deepEqual(
    decodeDirectoryEntryPage({
      items: [],
      continuation: 'end',
      nextCursor: null,
    }).items,
    [],
  );
});
test('literal Unicode search normalization and route selectors reject authority injection and invalid bytes', () => {
  assert.equal(
    canonicalDirectoryQuery('  校园 AbC%_\\ 📚  '),
    '校园 AbC%_\\ 📚',
  );
  assert.equal(canonicalDirectoryQuery('📚'.repeat(100)), '📚'.repeat(100));
  for (const q of ['', '  ', '\nabc', 'abc\t', '\ud800', '中'.repeat(101)])
    assert.throws(() => canonicalDirectoryQuery(q));
  assert.throws(() =>
    decodeDirectoryListIntent({ regionId: directoryRegion, kind: 'org' }),
  );
  assert.throws(() =>
    decodeDirectoryListIntent({ ...directoryListRoute, admin: true }),
  );
  assert.throws(() =>
    decodeDirectoryRoute({ ...directoryListRoute, categoryId: 'no' }, 'list'),
  );
  assert.throws(() =>
    decodeDirectoryRoute({ kind: 'org', regionId: directoryRegion }, 'hub'),
  );
  assert.throws(() =>
    decodeDirectoryRoute(
      { ...directoryListRoute, entryId: '../escape' },
      'detail',
    ),
  );
});
