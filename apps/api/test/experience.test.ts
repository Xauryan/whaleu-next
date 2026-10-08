import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionDelta,
  experienceCatalog,
  levelFor,
  progressFor,
  rewardActions,
  rules,
  signInPreview,
  thresholds,
  titles,
} from '../src/experience/catalog.js';
import {
  appearanceSchema,
  signInSchema,
  experiencePageSchema,
} from '../src/experience/contracts.js';
import {
  assertLocalExperienceWorker,
  experienceWorkerSchema,
  parseExperienceCommand,
} from '../src/experience/worker.js';
import { loadConfig } from '../src/config/config.js';
import { randomUUID } from 'node:crypto';
for (const [index, threshold] of thresholds.entries())
  test(`experience level ${index + 1} threshold boundary`, () => {
    assert.equal(levelFor(BigInt(threshold)), index + 1);
    if (index > 0) assert.equal(levelFor(BigInt(threshold - 1)), index);
  });
test('maximum level and exact large balances retain decimal precision', () => {
  assert.equal(levelFor(9223372036854775807n), 30);
  assert.deepEqual(progressFor(15n), {
    currentThreshold: '15',
    nextThreshold: '40',
    pointsIntoLevel: '0',
    pointsToNextLevel: '25',
    percent: 0,
  });
  assert.equal(progressFor(17150n).percent, 100);
  assert.equal(progressFor(17150n).pointsToNextLevel, null);
});
test('rule caps and per-transition slot restoration retain gross grants', () => {
  for (const action of rewardActions) {
    const rule = rules[action];
    assert.equal(
      actionDelta(action, 0n, rule.dailyLimit - 1, 0).delta,
      BigInt(rule.amount),
    );
    const capped = actionDelta(action, 0n, rule.dailyLimit, 0);
    assert.equal(capped.outcome, 'capped');
    assert.equal(capped.delta, 0n);
  }
  assert.deepEqual(actionDelta('delete_post', 2n, 1, 0), {
    nominal: -10n,
    delta: -2n,
    outcome: 'deducted',
    used: 0,
    refunded: 1,
    gross: 0,
  });
  assert.equal(actionDelta('delete_post', 0n, 1, 1).used, 1);
  assert.equal(actionDelta('delete_comment', 20n, 5, 2).refunded, 3);
  assert.equal(actionDelta('delete_reply', 0n, 4, 3).used, 4);
  assert.equal(actionDelta('delete_post', 20n, 0, 0).delta, -10n);
});
test('sign-in preview shares reset, saturation and confirmed-day semantics', () => {
  assert.equal(signInPreview(null, 0, '2026-10-08').nextReward, 2);
  assert.equal(signInPreview('2026-10-07', 1, '2026-10-08').nextReward, 4);
  assert.equal(signInPreview('2026-10-07', 6, '2026-10-08').nextReward, 15);
  assert.equal(signInPreview('2026-10-07', 7, '2026-10-08').nextStreak, 7);
  assert.equal(signInPreview('2026-10-06', 7, '2026-10-08').nextReward, 2);
  assert.equal(signInPreview('2026-10-08', 1, '2026-10-08').nextReward, 4);
});
test('safe catalog retains all titles, colors, thresholds without source identifiers or CSS', () => {
  const catalog = experienceCatalog();
  assert.equal(catalog.levels.length, 30);
  assert.equal(catalog.titles.length, 17);
  assert.equal(catalog.colors.length, 26);
  assert.equal(catalog.colors[0]!.unlockLevel, 0);
  assert.equal(catalog.colors[25]!.unlockLevel, 30);
  assert.ok(titles.some((x) => x.key === 'default_jingxiaoyu'));
  assert.ok(!JSON.stringify(catalog).includes('css'));
});
test('strict owner commands reject client authority and invalid revision/color', () => {
  const requestId = randomUUID();
  assert.ok(signInSchema.safeParse({ requestId }).success);
  assert.ok(!signInSchema.safeParse({ requestId, day: '2026-10-08' }).success);
  assert.ok(
    !appearanceSchema.safeParse({
      requestId,
      expectedRevision: '0',
      titleKey: null,
      colorId: 26,
    }).success,
  );
  assert.ok(
    !appearanceSchema.safeParse({
      requestId,
      expectedRevision: '9223372036854775808',
      titleKey: null,
      colorId: null,
    }).success,
  );
  assert.ok(
    appearanceSchema.safeParse({
      requestId,
      expectedRevision: '0',
      titleKey: null,
      colorId: 0,
    }).success,
  );
  assert.equal(experiencePageSchema.parse({}).limit, 20);
  assert.ok(!experiencePageSchema.safeParse({ limit: '51' }).success);
});
test('worker defaults dry-run and requires bounded explicit apply selection', () => {
  assert.equal(parseExperienceCommand([]).mode, 'dry-run');
  assert.throws(() => parseExperienceCommand(['apply']));
  assert.ok(!experienceWorkerSchema.safeParse({ mode: 'apply' }).success);
  assert.ok(experienceWorkerSchema.safeParse({}).success);
  assert.throws(() => parseExperienceCommand(['apply', '--all']));
  assert.equal(
    parseExperienceCommand(['apply', `--unit-id=${randomUUID()}`]).unitIds
      .length,
    1,
  );
  const config = loadConfig({
    DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/whaleu_test',
    PG_SSL_MODE: 'disable',
    NODE_ENV: 'test',
  });
  assert.doesNotThrow(() => assertLocalExperienceWorker(config));
  assert.throws(() =>
    assertLocalExperienceWorker({ ...config, NODE_ENV: 'production' }),
  );
  assert.throws(() =>
    assertLocalExperienceWorker({
      ...config,
      DATABASE_URL: 'postgresql://fixture@remote.invalid/db',
    }),
  );
});
