import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
/** Compiled page, real gateway/decoders and app lifecycle; synthetic transport, no native device/provider. */
export async function smokeExperience({ app, dist, mountPage, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpExperienceGateway } = require(
    path.join(dist, 'experience/gateway.js'),
  );
  const { PendingExperienceStore } = require(
    path.join(dist, 'experience/pending.js'),
  );
  const { ExperienceRuntime } = require(
    path.join(dist, 'experience/runtime.js'),
  );
  const { experienceThresholds } = require(
    path.join(dist, 'experience/contract.js'),
  );
  const original = app.experience,
    accountId = app.identity.sessions.snapshot().credentials.accountId;
  const records = new Map(),
    requests = [],
    receipts = new Map();
  let id = 0,
    signedIn = false,
    loseResponse = true,
    unknown = false;
  const at = '2026-10-08T01:00:00.000Z';
  const titles = [
    {
      key: 'default_jingxiaoyu',
      name: '鲸小语',
      kind: 'default',
      unlockLevel: null,
    },
    ...Array.from({ length: 15 }, (_, i) => ({
      key: `level_${i * 2 + 1}`,
      name: i === 0 ? '萌新小白' : `合成头衔${i}`,
      kind: 'level',
      unlockLevel: i * 2 + 1,
    })),
  ];
  const rules = [
    'publish',
    'comment',
    'like_save',
    'received_like_save',
    'received_comment',
  ].map((action, i) => ({
    action,
    amount: [10, 3, 1, 2, 3][i],
    dailyLimit: [1, 5, 10, 10, 5][i],
    refundLimit: [1, 3, 0, 0, 0][i],
  }));
  const catalog = {
    ruleVersion: 'local-experience-v1',
    timezone: 'Asia/Shanghai',
    levels: experienceThresholds.map((threshold, i) => ({
      level: i + 1,
      threshold: String(threshold),
    })),
    rules,
    signInRewards: [2, 4, 6, 8, 10, 12, 15],
    titles,
    colors: Array.from({ length: 26 }, (_, id) => ({
      id,
      name: `颜色 ${id}`,
      unlockLevel: id < 11 ? 0 : (id - 10) * 2,
    })),
  };
  let appearance = {
    coverage: 'complete',
    titles: titles
      .slice(0, 2)
      .map((t) => ({ ...t, earnedAt: null, recordedAt: at })),
    titleKey: null,
    colorId: null,
    eligibleColorIds: Array.from({ length: 11 }, (_, i) => i),
    revision: '0',
  };
  const summary = () => ({
    ruleVersion: 'local-experience-v1',
    timezone: 'Asia/Shanghai',
    serverDay: '2026-10-08',
    baseline: unknown ? 'baseline_unknown' : 'known',
    coverage: {
      history: unknown ? 'partial' : 'complete',
      entitlements: unknown ? 'partial' : 'complete',
    },
    balance: unknown ? null : signedIn ? '2' : '0',
    level: unknown ? null : 1,
    progress: unknown
      ? null
      : {
          currentThreshold: '0',
          nextThreshold: '15',
          pointsIntoLevel: signedIn ? '2' : '0',
          pointsToNextLevel: signedIn ? '13' : '15',
          percent: signedIn ? 13 : 0,
        },
    signIn: unknown
      ? {
          signedIn: null,
          lastDay: null,
          streak: null,
          nextStreak: null,
          nextReward: null,
        }
      : {
          signedIn,
          lastDay: signedIn ? '2026-10-08' : null,
          streak: signedIn ? 1 : 0,
          nextStreak: signedIn ? 2 : 1,
          nextReward: signedIn ? 4 : 2,
        },
    tasks: rules.map((r) => ({
      action: r.action,
      amount: r.amount,
      dailyLimit: r.dailyLimit,
      rewardedCount: unknown ? null : 0,
      refundCount: unknown ? null : 0,
      remaining: unknown ? null : r.dailyLimit,
      grossPositiveAwarded: unknown ? null : '0',
    })),
    pending: { count: 0, reason: null },
    stateRevision: unknown ? null : signedIn ? '1' : '0',
  });
  const pending = new PendingExperienceStore(
    {
      get: (k) => records.get(k),
      set: (k, v) => records.set(k, v),
      remove: (k) => records.delete(k),
    },
    'https://experience-smoke.invalid',
  );
  const api = new ApiClient(
    'https://experience-smoke.invalid',
    {
      async send(request) {
        requests.push(request);
        assert.equal(
          request.headers.Authorization,
          `Bearer ${app.identity.sessions.snapshot().credentials.accessToken}`,
        );
        const route = request.url
          .replace('https://experience-smoke.invalid', '')
          .split('?')[0];
        let body;
        if (route === '/v1/me/experience/sign-in') {
          assert.equal(request.method, 'POST');
          assert.ok(pending.load(accountId, 'sign_in'));
          assert.deepEqual(Object.keys(request.body), ['requestId']);
          signedIn = true;
          body = {
            requestId: request.body.requestId,
            operation: 'sign_in',
            outcome: 'awarded',
            rewardDay: '2026-10-08',
            appliedDelta: '2',
            balance: '2',
            streak: 1,
            stateRevision: '1',
          };
          receipts.set(request.body.requestId, body);
          if (loseResponse) throw new ClientError('timeout', 'synthetic');
        } else if (route.startsWith('/v1/me/experience/requests/'))
          body = receipts.get(route.split('/').at(-1));
        else if (
          route === '/v1/me/experience/appearance' &&
          request.method === 'PUT'
        ) {
          assert.ok(pending.load(accountId, 'appearance'));
          appearance = {
            ...appearance,
            titleKey: request.body.titleKey,
            colorId: request.body.colorId,
            revision: String(BigInt(appearance.revision) + 1n),
          };
          body = {
            requestId: request.body.requestId,
            operation: 'appearance',
            outcome: 'applied',
            titleKey: appearance.titleKey,
            colorId: appearance.colorId,
            revision: appearance.revision,
          };
          receipts.set(request.body.requestId, body);
        } else if (route === '/v1/me/experience') body = summary();
        else if (route === '/v1/experience/catalog') body = catalog;
        else if (route === '/v1/me/experience/appearance') body = appearance;
        else if (route === '/v1/me/experience/records')
          body = {
            items: [],
            nextCursor: null,
            coverage: unknown ? 'partial' : 'complete',
          };
        else if (route === '/v1/me/experience/unlocks') body = { items: [] };
        else assert.fail(`Unexpected experience route ${route}`);
        return { status: 200, headers: {}, body };
      },
    },
    app.identity.sessions,
    { refresh: async () => app.identity.sessions.snapshot() },
  );
  const runtime = new ExperienceRuntime(
    app.identity.sessions,
    new HttpExperienceGateway(api),
    pending,
    async () => `abababab-abab-4bab-8bab-${String(++id).padStart(12, '0')}`,
  );
  app.experience = runtime;
  let page = mountPage(path.join(dist, 'pages/experience/experience.js'));
  await flush();
  assert.equal(page.data.balanceLabel, '0');
  assert.equal(page.data.appearance.titles.length, 2);
  assert.equal(requests.filter((r) => r.method === 'POST').length, 0);
  const template = readFileSync(
    path.join(dist, 'pages/experience/experience.wxml'),
    'utf8',
  );
  for (const [, handler] of template.matchAll(
    /(?:bindtap|catchtap)="([^"]+)"/g,
  ))
    assert.equal(typeof page[handler], 'function');
  assert.match(template, /获得日期不可用/);
  assert.match(template, /记录覆盖|recordsCoverage/);
  assert.equal(
    /accessToken|refreshToken|authorId|bodyPreview/.test(template),
    false,
  );
  assert.match(
    readFileSync(path.join(dist, 'pages/experience/experience.wxss'), 'utf8'),
    /\.colors/,
  );
  app.onShow();
  await runtime.foreground();
  await flush();
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1);
  assert.ok(pending.load(accountId, 'sign_in'));
  assert.equal(page.data.signInPending, true);
  app.onHide();
  assert.equal(page.data.summary, null);
  page.onHide();
  page = mountPage(path.join(dist, 'pages/experience/experience.js'));
  await flush();
  assert.equal(page.data.signInPending, true);
  app.onShow();
  await runtime.foreground();
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1);
  loseResponse = false;
  page.onRecover({ currentTarget: { dataset: { operation: 'sign_in' } } });
  await flush();
  assert.equal(pending.load(accountId, 'sign_in'), null);
  assert.equal(page.data.summary.signIn.signedIn, true);
  assert.match(page.data.receiptStatus, /签到已确认/);
  unknown = true;
  appearance = { ...appearance, coverage: 'partial' };
  page.onReload();
  await flush();
  assert.match(page.data.balanceLabel, /基准未确认/);
  page.onTitle({ currentTarget: { dataset: { key: 'level_1' } } });
  page.onColor({ currentTarget: { dataset: { id: 0 } } });
  page.onSave();
  await flush();
  assert.equal(appearance.titleKey, 'level_1');
  assert.equal(appearance.colorId, 0);
  assert.equal(page.data.appearance.titles[0].earnedAt, null);
  app.onHide();
  assert.equal(page.data.appearance, null);
  page.onUnload();
  runtime.dispose();
  app.experience = original;
  console.log(
    'Experience compiled native smoke passed: read-only GET, known zero/two owned defaults, explicit coalesced foreground POST, loss/hide/reopen/manual receipt recovery, unknown baseline and undated title/base-color selection',
  );
}
