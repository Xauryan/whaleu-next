import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This runs compiled CommonJS with synthetic native globals. It is not WeChat DevTools QA.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const dist = path.join(root, 'dist');
let app;
let page;
let calls = 0;
let storageCalls = 0;
const storage = new Map();
const forbiddenNativeCall = () => {
  calls += 1;
  throw new Error(
    'Unconfigured build must not call a native provider, storage, or network',
  );
};
globalThis.wx = {
  request: forbiddenNativeCall,
  login: forbiddenNativeCall,
  getStorageSync: (key) => {
    storageCalls += 1;
    return storage.get(key);
  },
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: (key) => storage.delete(key),
};
globalThis.App = (options) => {
  app = options;
};
globalThis.getApp = () => app;
globalThis.Page = (options) => {
  page = options;
};
require(path.join(dist, 'app.js'));
assert.ok(app);
app.onLaunch();
assert.ok(app.identity);
const configured = app.identity.auth !== undefined;
if (!configured) assert.equal(storageCalls, 0);
const config = JSON.parse(readFileSync(path.join(dist, 'app.json'), 'utf8'));
assert.equal(config.pages[0], 'pages/login/login');
for (const route of config.pages) {
  for (const extension of ['js', 'json', 'wxml', 'wxss'])
    assert.ok(statSync(path.join(dist, `${route}.${extension}`)).size > 0);
  const template = readFileSync(path.join(dist, `${route}.wxml`), 'utf8');
  for (const match of template.matchAll(/url="\/([^"]+)"/g))
    assert.ok(
      config.pages.includes(match[1].split('?')[0]),
      `Unregistered navigation: ${match[1]}`,
    );
}
require(path.join(dist, 'pages/login/login.js'));
assert.ok(page);
page.setData = (data) => {
  page.data = { ...page.data, ...data };
};
page.onLoad();
assert.equal(page.data.configured, configured);
assert.equal(page.data.verified, false);
if (!configured) assert.ok(page.data.error);
const wxml = readFileSync(path.join(dist, 'pages/login/login.wxml'), 'utf8');
for (const match of wxml.matchAll(/(?:bindtap|catchtap)="([^"]+)"/g))
  assert.equal(typeof page[match[1]], 'function');
assert.equal(/accessToken|refreshToken/.test(wxml), false);
if (!configured) await page.controller.login();
assert.equal(page.data.verified, false);
page.onUnload();
for (const route of config.pages.filter(
  (route) => !['pages/login/login', 'pages/status/status'].includes(route),
)) {
  require(path.join(dist, `${route}.js`));
  const current = page;
  current.setData = (data) => {
    current.data = { ...current.data, ...data };
  };
  current.onLoad?.({
    postId: '66666666-6666-4666-8666-666666666666',
    spaceId: '55555555-5555-4555-8555-555555555555',
    category: 'discussion',
  });
  current.onShow();
  assert.equal(current.data.loaded, false);
  assert.ok(current.data.error);
  const template = readFileSync(path.join(dist, `${route}.wxml`), 'utf8');
  for (const match of template.matchAll(
    /(?:bind|catch)(?:tap|input|change|confirm)="([^"]+)"/g,
  ))
    assert.equal(typeof current[match[1]], 'function', `${route}: ${match[1]}`);
  assert.equal(/accessToken|refreshToken/.test(template), false);
  for (const match of template.matchAll(/url="\/([^"]+)"/g))
    assert.ok(
      config.pages.includes(match[1].split('?')[0]),
      `Unregistered navigation: ${match[1]}`,
    );
  current.onHide();
  assert.equal(current.controller, undefined);
  assert.equal(current.data.loaded, false);
  current.onShow();
  assert.ok(current.controller);
  current.onUnload();
}
// The compiled own-account page must honor the root app-hide boundary even
// before its own onHide callback arrives. Fixtures never call an API/provider.
assert.ok(app.verification);
let verificationCleared = false;
app.verification.privateViews.subscribe(() => {
  verificationCleared = true;
});
const originalGateway = app.verification.gateway;
let summaryCalls = 0;
let pendingSummary;
let pendingCancellation;
app.verification.gateway = {
  summary(cancellation) {
    summaryCalls += 1;
    pendingCancellation = cancellation;
    return new Promise((resolve) => {
      pendingSummary = resolve;
    });
  },
};
app.identity.sessions.completeLogin(app.identity.sessions.beginLogin(), {
  accountId: '12345678-1234-4123-8123-123456789abc',
  sessionId: '22345678-1234-4123-8123-123456789abc',
  accessToken: `wu_a_${'a'.repeat(43)}`,
  refreshToken: `wu_r_${'a'.repeat(43)}`,
  expiresAt: 1900000000000,
  refreshExpiresAt: 1900600000000,
});
const ownSummary = {
  affiliation: { status: 'verified' },
  studentNumber: { status: 'unverified' },
  phone: { status: 'unavailable' },
  application: { status: 'pending' },
};
const verificationModule = path.join(
  dist,
  'pages/verification/verification.js',
);
delete require.cache[require.resolve(verificationModule)];
require(verificationModule);
const verificationPage = page;
verificationPage.setData = (data) => {
  verificationPage.data = { ...verificationPage.data, ...data };
};
verificationPage.onShow();
for (let i = 0; i < 12; i += 1) await Promise.resolve();
assert.equal(summaryCalls, 1);
app.onHide();
assert.equal(verificationCleared, true);
assert.equal(pendingCancellation.isCancelled, true);
assert.equal(verificationPage.data.loaded, false);
assert.deepEqual(verificationPage.data.rows, []);
pendingSummary(ownSummary);
for (let i = 0; i < 12; i += 1) await Promise.resolve();
assert.equal(verificationPage.data.loaded, false);
verificationPage.onReload();
assert.equal(summaryCalls, 1);
verificationPage.onShow();
for (let i = 0; i < 12; i += 1) await Promise.resolve();
assert.equal(summaryCalls, 2);
pendingSummary(ownSummary);
for (let i = 0; i < 12; i += 1) await Promise.resolve();
assert.equal(verificationPage.data.loaded, true);
assert.deepEqual(
  verificationPage.data.rows.map((row) => row.value),
  ['已验证', '未验证', '状态未知或暂不可用', '等待审核'],
);
app.onHide();
assert.equal(verificationPage.data.loaded, false);
assert.deepEqual(verificationPage.data.rows, []);
verificationPage.onUnload();
assert.equal(verificationPage.controller, undefined);
app.identity.sessions.logout();
app.verification.gateway = originalGateway;
const verificationTemplate = readFileSync(
  path.join(dist, 'pages/verification/verification.wxml'),
  'utf8',
);
assert.match(verificationTemplate, /实际操作仍由服务端实时校验/);
assert.match(verificationTemplate, /尚未开放/);
assert.equal(
  /getPhoneNumber|bindgetphonenumber|chooseImage|<input|<textarea/.test(
    verificationTemplate,
  ),
  false,
);
// Exercise compiled poll handlers with local synthetic DTOs, including app-hide
// after persistence and owner-only recovery. No network or provider is involved.
const originalCommunityGateway = app.community.gateway;
const originalNewRequestId = app.community.newRequestId;
const pollAccount = '12345678-1234-4123-8123-123456789abc';
const pollPostId = '66666666-6666-4666-8666-666666666666';
const pollRequestId = '77777777-7777-4777-8777-777777777777';
const pollOptionOne = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const pollOptionTwo = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let pollWire = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  postId: pollPostId,
  question: '合成编译冒烟问题',
  selectionMode: 'single',
  options: [
    { id: pollOptionOne, label: '甲', position: 0, count: 0 },
    { id: pollOptionTwo, label: '乙', position: 1, count: 0 },
  ],
  deadline: null,
  expired: false,
  voterCount: 0,
  selectionCount: 0,
  viewer: {
    hasVoted: false,
    selectedOptionIds: [],
    canVote: true,
    reason: null,
  },
};
const pollReceipt = {
  requestId: pollRequestId,
  operation: 'cast_poll_ballot',
  outcome: 'created',
  resourceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  createdAt: '2026-10-07T00:00:00.000Z',
};
const pollPostWire = () => ({
  id: pollPostId,
  space: {
    id: '55555555-5555-4555-8555-555555555555',
    kind: 'regional',
    name: '合成地区',
  },
  category: 'discussion',
  text: '合成编译测试正文',
  images: [],
  author: {
    kind: 'anonymous',
    personaId: '99999999-9999-4999-8999-999999999999',
    displayName: '合成匿名作者',
    avatar: null,
    isPostAuthor: true,
  },
  publishedAt: '2026-10-07T00:00:00.000Z',
  likeCount: 0,
  commentCount: 0,
  viewer: { isSelf: true, isLiked: false, canDelete: true, canComment: true },
  commentsPolicy: 'open',
  component: { kind: 'poll', poll: pollWire },
});
let finishBallot;
let ballotSends = 0;
app.community.gateway = {
  post: async () => pollPostWire(),
  comments: async () => ({ items: [], nextCursor: null }),
  poll: async () => pollWire,
  castBallot: async (target, payload) => {
    ballotSends += 1;
    assert.equal(target, pollPostId);
    assert.deepEqual(
      app.community.pendingBallots.load(pollAccount).payload,
      payload,
    );
    return new Promise((resolve) => {
      finishBallot = resolve;
    });
  },
  ballotReceipt: async () => pollReceipt,
};
app.community.newRequestId = async () => pollRequestId;
app.identity.sessions.completeLogin(app.identity.sessions.beginLogin(), {
  accountId: pollAccount,
  sessionId: '22345678-1234-4123-8123-123456789abc',
  accessToken: `wu_a_${'a'.repeat(43)}`,
  refreshToken: `wu_r_${'a'.repeat(43)}`,
  expiresAt: 1900000000000,
  refreshExpiresAt: 1900600000000,
});
const detailModule = path.join(
  dist,
  'pages/community-detail/community-detail.js',
);
delete require.cache[require.resolve(detailModule)];
require(detailModule);
const pollPage = page;
pollPage.setData = (data) => {
  pollPage.data = { ...pollPage.data, ...data };
};
pollPage.onLoad({ postId: pollPostId });
pollPage.onShow();
for (let i = 0; i < 40; i += 1) await Promise.resolve();
assert.equal(pollPage.data.pollView.loaded, true);
assert.equal(pollPage.data.pollView.revealResults, false);
pollPage.onPollOption({ currentTarget: { dataset: { id: pollOptionOne } } });
for (let i = 0; i < 20; i += 1) await Promise.resolve();
assert.equal(pollPage.data.pollView.frozen, true);
pollPage.onPollOption({ currentTarget: { dataset: { id: pollOptionTwo } } });
assert.equal(ballotSends, 1);
app.onHide();
assert.equal(pollPage.data.pollView.poll, null);
finishBallot(pollReceipt);
for (let i = 0; i < 20; i += 1) await Promise.resolve();
assert.ok(app.community.pendingBallots.load(pollAccount));
pollWire = {
  ...pollWire,
  voterCount: 1,
  selectionCount: 1,
  options: pollWire.options.map((option) => ({
    ...option,
    count: option.id === pollOptionOne ? 1 : 0,
  })),
  viewer: {
    hasVoted: true,
    selectedOptionIds: [pollOptionOne],
    canVote: false,
    reason: 'POLL_ALREADY_VOTED',
  },
};
pollPage.onShow();
for (let i = 0; i < 40; i += 1) await Promise.resolve();
assert.equal(pollPage.data.pollView.frozen, true);
pollPage.onPollReceipt();
for (let i = 0; i < 40; i += 1) await Promise.resolve();
assert.equal(app.community.pendingBallots.load(pollAccount), null);
assert.equal(pollPage.data.pollView.revealResults, true);
assert.equal(pollPage.data.pollView.canVote, false);
app.onHide();
assert.equal(pollPage.data.pollView.poll, null);
pollPage.onUnload();
app.identity.sessions.logout();
app.community.gateway = originalCommunityGateway;
app.community.newRequestId = originalNewRequestId;
const pollComposerTemplate = readFileSync(
  path.join(dist, 'pages/community-compose/community-compose.wxml'),
  'utf8',
);
assert.match(pollComposerTemplate, /吃瓜🍉/);
assert.equal(
  /mode="date"|mode="time"|bind.*deadline/i.test(pollComposerTemplate),
  false,
);
let privacyCleared = false;
app.community.privateViews.subscribe(() => {
  privacyCleared = true;
});
app.onHide();
assert.equal(privacyCleared, true);
assert.equal(calls, 0);
console.log(
  'Native build smoke passed: local bootstrap, all identity/campus/profile/community/verification handlers, hide/show cancellation, assets, navigation, private-overlay, own-verification and durable-poll app-hide clearing/recovery, and configuration gating',
);
