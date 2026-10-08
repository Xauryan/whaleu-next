import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeExperienceSummary,
  decodeExperienceAppearance,
  decodeExperienceCatalog,
  decodeExperienceRecords,
  decodeExperienceReceipt,
  decodeAppearanceIntent,
  decodeSignInIntent,
  decodeExperienceUnlocks,
  matchExperienceReceipt,
  decimal,
} from '../src/experience/contract';
import { experienceColorStyle } from '../src/experience/colors';
import {
  appearance,
  at,
  catalog,
  noticeId,
  receipt,
  recordId,
  requestId,
  summary,
  unknownSummary,
} from './experience-helpers';
test('known zero, unknown independent coverage, exact decimal balance and frozen owner-only DTOs', () => {
  for (const s of [
    summary(),
    unknownSummary(),
    summary({
      balance: '9223372036854775807',
      level: 30,
      progress: {
        currentThreshold: '17150',
        nextThreshold: null,
        pointsIntoLevel: '9223372036854758657',
        pointsToNextLevel: null,
        percent: 100,
      },
    }),
  ]) {
    const decoded = decodeExperienceSummary(s);
    assert.deepEqual(decoded, s);
    assert.ok(Object.isFrozen(decoded.tasks));
  }
  assert.equal(decimal('9223372036854775808'), false);
  assert.equal(decimal('9007199254740993'), true);
});
test('summary rejects null-as-zero, impossible levels/progress, unknown/private fields and false sign-in success', () => {
  for (const s of [
    { ...unknownSummary(), balance: '0' },
    {
      ...summary(),
      level: 30,
      progress: {
        currentThreshold: '0',
        nextThreshold: null,
        pointsIntoLevel: '0',
        pointsToNextLevel: null,
        percent: 100,
      },
    },
    { ...summary(), ownerId: recordId },
    { ...summary(), balance: 0 },
    { ...summary(), balance: '01' },
    {
      ...summary(),
      signIn: {
        signedIn: true,
        lastDay: null,
        streak: 1,
        nextStreak: 2,
        nextReward: 4,
      },
    },
    {
      ...summary(),
      signIn: {
        signedIn: false,
        lastDay: null,
        streak: 7,
        nextStreak: 1,
        nextReward: 2,
      },
    },
    {
      ...summary(),
      signIn: {
        signedIn: false,
        lastDay: '2026-10-01',
        streak: 7,
        nextStreak: 7,
        nextReward: 15,
      },
    },
    { ...summary(), pending: { count: 0, reason: 'queued' } },
    { ...summary(), pending: { count: 1, reason: 'baseline_unknown' } },
    {
      ...summary(),
      tasks: summary().tasks.map((t) => ({ ...t, remaining: 0 })),
    },
    { ...unknownSummary(), tasks: summary().tasks },
  ])
    assert.throws(() => decodeExperienceSummary(s), { kind: 'protocol' });
});
test('authoritative Shanghai sign-in preview accepts yesterday and resets a missed day', () => {
  decodeExperienceSummary(
    summary({
      serverDay: '2026-10-09',
      signIn: {
        signedIn: false,
        lastDay: '2026-10-08',
        streak: 6,
        nextStreak: 7,
        nextReward: 15,
      },
    }),
  );
  decodeExperienceSummary(
    summary({
      serverDay: '2026-10-10',
      signIn: {
        signedIn: false,
        lastDay: '2026-10-08',
        streak: 6,
        nextStreak: 1,
        nextReward: 2,
      },
    }),
  );
});
test('catalog preserves complete thresholds, reward values, distinct default and level titles and palette IDs', () => {
  const c = catalog();
  assert.deepEqual(decodeExperienceCatalog(c), c);
  for (const bad of [
    { ...c, levels: c.levels.slice(1) },
    {
      ...c,
      colors: c.colors.map((v) => (v.id === 0 ? { ...v, unlockLevel: 1 } : v)),
    },
    { ...c, colors: c.colors.map((v) => ({ ...v, css: 'url(private)' })) },
    { ...c, titles: c.titles.map((t) => ({ ...t, role: 'admin' })) },
    { ...c, signInRewards: [2, 4, 6, 8, 10, 12, 16] },
    {
      ...c,
      levels: c.levels.map((l) =>
        l.level === 2 ? { ...l, threshold: '16' } : l,
      ),
    },
  ])
    assert.throws(() => decodeExperienceCatalog(bad), { kind: 'protocol' });
  assert.equal(experienceColorStyle(0), 'background: #CED5E9;');
  assert.match(experienceColorStyle(8), /#7AA1D2, #f5c3c3, #CC95C0/);
  assert.match(experienceColorStyle(25), /#FFD200, #F7971E/);
  assert.equal(experienceColorStyle(26), '');
  assert.equal(experienceColorStyle(Number.NaN), '');
});
test('undated owned titles and records stay readable without baseline, and unsupported labels cannot replace reviewed keys', () => {
  const a = appearance({
    coverage: 'partial',
    titles: appearance().titles.map((t) => ({
      ...t,
      earnedAt: null,
    })),
    titleKey: 'level_1',
    colorId: 25,
  });
  assert.deepEqual(decodeExperienceAppearance(a), a);
  assert.throws(() =>
    decodeExperienceAppearance({
      ...a,
      titles: a.titles.map((t) => ({ ...t, name: '同名头衔' })),
    }),
  );
  const records = {
    items: [
      {
        recordId,
        action: 'publish',
        nominalDelta: null,
        appliedDelta: null,
        balanceAfter: null,
        outcome: 'historical',
        occurredAt: null,
        appliedAt: null,
        recordedAt: at,
      },
    ],
    nextCursor: null,
    coverage: 'partial',
  };
  assert.deepEqual(decodeExperienceRecords(records), records);
  for (const bad of [
    { ...a, titleKey: 'level_29' },
    { ...a, titles: [...a.titles, a.titles[0]] },
    { ...a, eligibleColorIds: [11] },
    { ...a, colorId: 26 },
    {
      ...a,
      titles: a.titles.map((t) => ({
        ...t,
        earnedAt: '2026-02-30T00:00:00.000Z',
      })),
    },
  ])
    assert.throws(() => decodeExperienceAppearance(bad), { kind: 'protocol' });
  assert.throws(
    () =>
      decodeExperienceRecords({
        ...records,
        items: [{ ...records.items[0], body: 'private' }],
      }),
    { kind: 'protocol' },
  );
});
test('strict intent/receipt decoder distinguishes terminal appearance rejection from retryable sign-in errors', () => {
  const intent = {
    requestId,
    expectedRevision: '0',
    titleKey: 'level_1',
    colorId: 25,
  };
  assert.deepEqual(decodeAppearanceIntent(intent), intent);
  decodeSignInIntent({ requestId });
  decodeExperienceReceipt(receipt());
  const rejection = {
    requestId,
    operation: 'appearance',
    outcome: 'rejected',
    code: 'EXPERIENCE_COLOR_INELIGIBLE',
  };
  assert.deepEqual(decodeExperienceReceipt(rejection), rejection);
  for (const v of [
    { ...intent, ownerId: recordId },
    { ...intent, points: 20 },
    { ...intent, colorId: '#fff' },
    { ...intent, titleKey: 'admin' },
    { ...intent, expectedRevision: 0 },
  ])
    assert.throws(() => decodeAppearanceIntent(v), { kind: 'protocol' });
  for (const v of [
    { ...receipt(), rewardDay: '2026-02-30' },
    { ...receipt(), outcome: 'already_signed_in' },
    {
      ...receipt(),
      operation: 'sign_in',
      outcome: 'rejected',
      code: 'EXPERIENCE_PENDING',
    },
    { ...receipt(), balance: '1' },
    { ...receipt(), appliedDelta: 2 },
  ])
    assert.throws(() => decodeExperienceReceipt(v), { kind: 'protocol' });
  assert.throws(
    () =>
      matchExperienceReceipt(
        { operation: 'appearance', ...intent },
        {
          requestId,
          operation: 'appearance',
          outcome: 'applied',
          titleKey: 'level_1',
          colorId: 25,
          revision: '2',
        },
      ),
    { kind: 'protocol' },
  );
});
test('durable notices contain only safe owner unlock metadata', () => {
  const u = {
    items: [
      {
        noticeId,
        fromLevel: 1,
        toLevel: 4,
        titleKeys: ['level_3'],
        colorIds: [11, 12],
        createdAt: at,
      },
    ],
  };
  assert.deepEqual(decodeExperienceUnlocks(u), u);
  assert.throws(
    () =>
      decodeExperienceUnlocks({ items: [{ ...u.items[0], actor: recordId }] }),
    { kind: 'protocol' },
  );
  assert.throws(
    () => decodeExperienceUnlocks({ items: [{ ...u.items[0], toLevel: 1 }] }),
    { kind: 'protocol' },
  );
});
test('progress and record action/delta contradictions are not shown as confirmed rewards', () => {
  assert.throws(
    () =>
      decodeExperienceSummary({
        ...summary(),
        progress: { ...summary().progress, percent: 99 },
      }),
    { kind: 'protocol' },
  );
  const r = {
    recordId,
    action: 'delete_post',
    nominalDelta: '-10',
    appliedDelta: '-2',
    balanceAfter: '0',
    outcome: 'deducted',
    occurredAt: null,
    appliedAt: at,
    recordedAt: at,
  };
  decodeExperienceRecords({
    items: [r],
    nextCursor: null,
    coverage: 'complete',
  });
  for (const v of [
    { ...r, action: 'publish' },
    { ...r, nominalDelta: '-3' },
    { ...r, outcome: 'awarded' },
    {
      ...r,
      action: 'sign_in',
      outcome: 'awarded',
      nominalDelta: '999',
      appliedDelta: '999',
      balanceAfter: '999',
    },
  ])
    assert.throws(
      () =>
        decodeExperienceRecords({
          items: [v],
          nextCursor: null,
          coverage: 'complete',
        }),
      { kind: 'protocol' },
    );
});
