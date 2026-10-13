import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeExperienceRanking } from '../src/experience/ranking-contract';
import { rankingItem, rankingPage } from './experience-ranking-helpers';
import { publicExperienceDisplay } from './community-helpers';
test('bounded list decodes all selection states, zero/one/fifty items and independent public cosmetics', () => {
  for (const page of [
    rankingPage({ items: [] }),
    rankingPage(),
    rankingPage({ items: [], selectionStatus: 'scan_limited' }),
    rankingPage({
      items: Array.from({ length: 50 }, (_, i) => rankingItem(i + 1)),
      selectionStatus: 'limit_reached',
    }),
    rankingPage({
      items: [
        { ...rankingItem(), experienceDisplay: publicExperienceDisplay() },
      ],
    }),
  ]) {
    assert.deepEqual(decodeExperienceRanking(page), page);
    assert.ok(Object.isFrozen(decodeExperienceRanking(page).items));
  }
});
test('contract rejects extras, hidden fields, invalid coverage, status, cardinality, names, UUIDs and projections atomically', () => {
  const item = rankingItem();
  for (const raw of [
    { ...rankingPage(), total: 1 },
    { ...rankingPage(), rank: 1 },
    { ...rankingPage(), scope: 'school' },
    { ...rankingPage(), population: 'all' },
    { ...rankingPage(), populationCompleteness: 'complete' },
    { ...rankingPage(), selectionStatus: 'end' },
    { ...rankingPage(), selectionStatus: 'limit_reached' },
    rankingPage({
      items: Array.from({ length: 51 }, (_, i) => rankingItem(i + 1)),
    }),
    rankingPage({ items: [item, item] }),
    ...[
      { ...item, accountId: 'private' },
      { ...item, score: '9000' },
      { ...item, profileId: 'private-owner' },
      { ...item, displayName: '' },
      { ...item, displayName: '\u0000bad' },
      { ...item, displayName: 'a'.repeat(101) },
      { profileId: item.profileId, displayName: item.displayName },
      ...[0, 31].map((value) => ({
        ...item,
        experienceDisplay: {
          ...item.experienceDisplay,
          level: { status: 'known', value },
        },
      })),
      {
        ...item,
        experienceDisplay: {
          ...item.experienceDisplay,
          color: { status: 'known', value: 26 },
        },
      },
      {
        ...item,
        experienceDisplay: {
          ...item.experienceDisplay,
          title: {
            status: 'known',
            value: { key: 'role_fake', name: '管理员' },
          },
        },
      },
    ].map((bad) => ({ ...rankingPage(), items: [bad] })),
  ])
    assert.throws(() => decodeExperienceRanking(raw), { kind: 'protocol' });
});
