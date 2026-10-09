import { smokeRatingCategoryManagement } from './smoke-rating-category-management.mjs';
import { smokeRatingOwnerEditing } from './smoke-rating-owner-editing.mjs';
import { smokeRatingOwnerManagement } from './smoke-rating-owner-management.mjs';
import { smokeRatingsR3A } from './smoke-ratings-r3a.mjs';
import { smokeRatingsR3R } from './smoke-ratings-r3r.mjs';
import { smokeRatings } from './smoke-ratings.mjs';
import { smokeRatingsR2A } from './smoke-ratings-r2a.mjs';
import { smokeRatingsR2B } from './smoke-ratings-r2b.mjs';
import { smokeRatingsR2C } from './smoke-ratings-r2c.mjs';
import { smokeErrandAdminNotices } from './smoke-errand-admin-notices.mjs';
import { smokeErrandAdminMutations } from './smoke-errand-admin-mutations.mjs';
import { smokeErrandAdmin } from './smoke-errand-admin.mjs';
import { smokeErrands } from './smoke-errands.mjs';
import { smokeActivities } from './smoke-activities.mjs';
import { smokeAnnouncements } from './smoke-announcements.mjs';
import { smokeDirectory } from './smoke-directory.mjs';
import { smokeViewReporting } from './smoke-view-reporting.mjs';
import { smokeSearch } from './smoke-search.mjs';
import { smokeHot } from './smoke-hot.mjs';
import { smokePublicExperience } from './smoke-public-experience.mjs';
import { smokeExperience } from './smoke-experience.mjs';
import { smokeProfileDiscovery } from './smoke-profile-discovery.mjs';
import { smokeIdentityCampus } from './smoke-identity-campus.mjs';
import { smokeTradingContacts } from './smoke-trading-contacts.mjs';
import { smokeRuntimePolicy } from './smoke-runtime-policy.mjs';
import { smokeReporting } from './smoke-reporting.mjs';
import { smokeSystemNotices } from './smoke-system-notices.mjs';
import { smokeNamedBlocks } from './smoke-blocks.mjs';
import { smokeDiscussionPagination } from './smoke-discussion-pagination.mjs';
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
// Creation is a form, not a loaded content projection. Assert its actual
// privacy/action state instead of manufacturing a meaningless loaded flag.
function assertColdRatingCreation(current) {
  for (const key of [
    'ready',
    'frozen',
    'canCancelCreation',
    'cancelCreationConfirmation',
    'needsRefresh',
    'busy',
  ])
    assert.equal(current.data[key], false, `rating-create: ${key}`);
  for (const key of [
    'name',
    'description',
    'receiptStatus',
    'recoveryOperation',
  ])
    assert.equal(current.data[key], '', `rating-create: ${key}`);
  assert.equal(current.context, null);
}
function assertColdRatingCategoryCreation(current) {
  for (const key of [
    'ready',
    'creationConfirmation',
    'canCancelCategoryCreation',
    'cancelCategoryCreationConfirmation',
    'frozen',
    'needsRefresh',
    'busy',
  ])
    assert.equal(current.data[key], false, `rating-category-create: ${key}`);
  for (const key of ['nodes', 'campusIds', 'parents'])
    assert.deepEqual(current.data[key], [], `rating-category-create: ${key}`);
  for (const key of ['parentName', 'receiptStatus', 'recoveryOperation'])
    assert.equal(current.data[key], '', `rating-category-create: ${key}`);
  assert.equal(current.data.regionId, null);
  assert.equal(current.data.parentId, null);
  assert.equal(current.data.parentLevel, 0);
  assert.equal('loaded' in current.data, false);
  assert.equal(current.route, null);
}
function assertColdTargetOwnerDeletion(current) {
  for (const key of [
    'ready',
    'deleted',
    'deleteConfirmation',
    'canCancelDeletion',
    'cancelDeletionConfirmation',
    'frozen',
    'needsRefresh',
    'returnToCatalog',
    'busy',
  ])
    assert.equal(current.data[key], false, `target-owner-delete: ${key}`);
  for (const key of ['receiptStatus', 'recoveryOperation'])
    assert.equal(current.data[key], '', `target-owner-delete: ${key}`);
  assert.equal(current.locator, null);
}
function assertColdTargetOwnerEditing(current) {
  for (const key of [
    'ready',
    'editConfirmation',
    'canCancelEditing',
    'cancelEditingConfirmation',
    'frozen',
    'needsRefresh',
    'busy',
  ])
    assert.equal(current.data[key], false, `target-owner-edit: ${key}`);
  for (const key of [
    'name',
    'description',
    'receiptStatus',
    'recoveryOperation',
  ])
    assert.equal(current.data[key], '', `target-owner-edit: ${key}`);
  assert.equal(current.locator, null);
}
for (const route of config.pages.filter(
  (route) => !['pages/login/login', 'pages/status/status'].includes(route),
)) {
  require(path.join(dist, `${route}.js`));
  const current = page;
  current.setData = (data) => {
    current.data = { ...current.data, ...data };
  };
  current.onLoad?.(
    [
      'pages/activity-list/activity-list',
      'pages/rating-updates/rating-updates',
    ].includes(route)
      ? {}
      : {
          postId: '66666666-6666-4666-8666-666666666666',
          spaceId: '55555555-5555-4555-8555-555555555555',
          category: 'discussion',
          ...(route.endsWith('community-thread')
            ? { rootCommentId: '88888888-8888-4888-8888-888888888888' }
            : {}),
        },
  );
  current.onShow();
  if (route === 'pages/rating-create/rating-create')
    assertColdRatingCreation(current);
  else if (route === 'pages/rating-category-create/rating-category-create')
    assertColdRatingCategoryCreation(current);
  else if (route === 'pages/target-owner-delete/target-owner-delete')
    assertColdTargetOwnerDeletion(current);
  else if (route === 'pages/target-owner-edit/target-owner-edit')
    assertColdTargetOwnerEditing(current);
  else assert.equal(current.data.loaded, false);
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
  if (route === 'pages/rating-create/rating-create')
    assertColdRatingCreation(current);
  else if (route === 'pages/rating-category-create/rating-category-create')
    assertColdRatingCategoryCreation(current);
  else if (route === 'pages/target-owner-delete/target-owner-delete')
    assertColdTargetOwnerDeletion(current);
  else if (route === 'pages/target-owner-edit/target-owner-edit')
    assertColdTargetOwnerEditing(current);
  else assert.equal(current.data.loaded, false);
  current.onShow();
  assert.ok(current.controller);
  current.onUnload();
  if (route === 'pages/rating-create/rating-create') {
    assertColdRatingCreation(current);
    assert.equal(current.controller, undefined);
  }
  if (route === 'pages/rating-category-create/rating-category-create') {
    assertColdRatingCategoryCreation(current);
    assert.equal(current.controller, undefined);
    assert.equal(current.navigator, undefined);
  }
  if (route === 'pages/target-owner-edit/target-owner-edit') {
    assertColdTargetOwnerEditing(current);
    assert.equal(current.controller, undefined);
    assert.equal(current.navigator, undefined);
  }
  if (route === 'pages/target-owner-delete/target-owner-delete') {
    assertColdTargetOwnerDeletion(current);
    assert.equal(current.controller, undefined);
    assert.equal(current.navigator, undefined);
  }
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
  trading: null,
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
  saveCount: 0,
  commentCount: 0,
  replyCount: 0,
  discussionCount: 0,
  viewer: {
    isSelf: true,
    isLiked: false,
    canDelete: true,
    canComment: true,
    isSaved: false,
    canSave: true,
    canSetUpdatePreference: true,
  },
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
// Compiled thread + reply composer exercise the real controllers and durable stores.
const rootId = '88888888-8888-4888-8888-888888888888';
const discussionReplyId = '12121212-1212-4212-8212-121212121212';
const rootWire = () => ({
  id: rootId,
  postId: pollPostId,
  text: '合成根评论',
  images: [],
  author: pollPostWire().author,
  createdAt: '2026-10-07T00:00:00.000Z',
  likeCount: 0,
  replyCount: 1,
  isPinned: false,
  replyPreview: { items: [], nextCursor: null },
  viewer: { isSelf: true, canDelete: true, isLiked: false, canPin: true },
});
const replyWire = () => ({
  id: discussionReplyId,
  postId: pollPostId,
  rootCommentId: rootId,
  target: {
    kind: 'comment',
    id: rootId,
    status: 'available',
    author: pollPostWire().author,
  },
  text: '合成回复',
  images: [],
  author: pollPostWire().author,
  createdAt: '2026-10-07T00:00:00.000Z',
  likeCount: 0,
  viewer: { isSelf: true, canDelete: true, isLiked: false },
});
let finishInteraction,
  interactionSends = 0;
const interactionReceipt = {
  requestId: pollRequestId,
  operation: 'set_reply_like',
  outcome: 'applied',
  resourceId: discussionReplyId,
  desired: true,
};
app.community.gateway = {
  post: async () => ({
    ...pollPostWire(),
    component: { kind: 'none' },
    commentCount: 1,
    replyCount: 1,
    discussionCount: 2,
  }),
  comment: async () => rootWire(),
  reply: async () => replyWire(),
  replies: async () => ({ items: [replyWire()], nextCursor: null }),
  discussionContext: async () => ({
    comment: rootWire(),
    reply: replyWire(),
    replies: { items: [replyWire()], nextCursor: null },
  }),
  discussionLike: async () => {
    interactionSends++;
    return new Promise((resolve) => {
      finishInteraction = resolve;
    });
  },
  discussionReceipt: async () => interactionReceipt,
};
const threadModule = path.join(
  dist,
  'pages/community-thread/community-thread.js',
);
delete require.cache[require.resolve(threadModule)];
require(threadModule);
const threadPage = page;
threadPage.setData = (data) => {
  threadPage.data = { ...threadPage.data, ...data };
};
threadPage.onLoad({
  postId: pollPostId,
  rootCommentId: rootId,
  replyId: discussionReplyId,
});
threadPage.onShow();
for (let i = 0; i < 50; i++) await Promise.resolve();
assert.equal(threadPage.data.loaded, true);
assert.equal(threadPage.data.replies.length, 1);
assert.equal(threadPage.data.contextReplies.length, 0);
threadPage.onLikeReply({
  currentTarget: { dataset: { id: discussionReplyId } },
});
for (let i = 0; i < 20; i++) await Promise.resolve();
threadPage.onLikeReply({
  currentTarget: { dataset: { id: discussionReplyId } },
});
assert.equal(interactionSends, 1);
assert.ok(app.community.pendingDiscussion.load(pollAccount));
app.onHide();
assert.equal(threadPage.data.root, null);
assert.deepEqual(threadPage.data.replies, []);
finishInteraction(interactionReceipt);
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.ok(app.community.pendingDiscussion.load(pollAccount));
threadPage.onShow();
for (let i = 0; i < 50; i++) await Promise.resolve();
assert.equal(threadPage.data.interaction.frozen, true);
threadPage.onInteractionReceipt();
for (let i = 0; i < 50; i++) await Promise.resolve();
assert.equal(app.community.pendingDiscussion.load(pollAccount), null);
threadPage.onUnload();
const originalProfiles = app.community.profiles;
app.community.profiles = {
  profile: async () => ({
    accountId: pollAccount,
    preferences: {
      defaultCommentAnonymousEnabled: false,
      defaultCommentNonAnonymousEnabled: false,
    },
  }),
};
let finishReply,
  replySends = 0;
const replyReceipt = {
  requestId: pollRequestId,
  operation: 'publish_reply',
  outcome: 'created',
  resourceId: discussionReplyId,
  createdAt: '2026-10-07T00:00:00.000Z',
};
app.community.gateway = {
  ...app.community.gateway,
  commentCapabilities: async () => ({
    availability: 'allowed',
    reason: null,
    authorModes: ['anonymous'],
    forcedAuthorMode: 'anonymous',
    lastAuthorMode: null,
  }),
  publishReply: async (root, payload) => {
    replySends++;
    assert.equal(root, rootId);
    assert.deepEqual(app.community.pending.load(pollAccount).payload, payload);
    return new Promise((resolve) => {
      finishReply = resolve;
    });
  },
  receipt: async () => replyReceipt,
};
const composeModule = path.join(
  dist,
  'pages/community-compose/community-compose.js',
);
delete require.cache[require.resolve(composeModule)];
require(composeModule);
const replyPage = page;
replyPage.setData = (data) => {
  replyPage.data = { ...replyPage.data, ...data };
};
replyPage.onLoad({
  postId: pollPostId,
  rootCommentId: rootId,
  copyReplyId: discussionReplyId,
});
replyPage.onShow();
for (let i = 0; i < 50; i++) await Promise.resolve();
assert.equal(replyPage.data.text, '合成回复');
replyPage.onText({ detail: { value: '合成新回复' } });
replyPage.onSubmit();
for (let i = 0; i < 30; i++) await Promise.resolve();
replyPage.onSubmit();
assert.equal(replySends, 1);
assert.equal(
  app.community.pending.load(pollAccount).operation,
  'publish_reply',
);
app.onHide();
assert.equal(replyPage.data.text, '');
finishReply(replyReceipt);
for (let i = 0; i < 20; i++) await Promise.resolve();
assert.ok(app.community.pending.load(pollAccount));
replyPage.onShow();
for (let i = 0; i < 30; i++) await Promise.resolve();
assert.equal(replyPage.data.frozen, true);
replyPage.onReceipt();
for (let i = 0; i < 30; i++) await Promise.resolve();
assert.equal(app.community.pending.load(pollAccount), null);
assert.equal(replyPage.data.resourceRootCommentId, rootId);
replyPage.onUnload();
// Trading smoke uses only synthetic in-memory gateways and compiled native handlers.
// Authorized contacts remain separate from public DTOs, sharing and durable status recovery.
const flushTrading = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
const mountTradingPage = (module, query) => {
  delete require.cache[require.resolve(module)];
  require(module);
  const current = page;
  current.setData = (data) => {
    current.data = { ...current.data, ...data };
  };
  current.onLoad?.(query);
  current.onShow();
  return current;
};
let tradingResolution = 'open';
const tradingPostWire = () => ({
  ...pollPostWire(),
  category: 'trading',
  component: { kind: 'none' },
  author: {
    kind: 'named',
    profileId: '99999999-9999-4999-8999-999999999999',
    displayName: '合成交易作者',
    avatar: null,
    experienceDisplay: {
      title: { status: 'unavailable', value: null },
      color: { status: 'unavailable', value: null },
      level: { status: 'unavailable', value: null },
    },
  },
  trading: {
    subtype: { kind: 'known', key: 'shuma', legacyText: null },
    price: { kind: 'exact', amount: '12.3456789', legacyText: null },
    urgency: 'urgent',
    location: '合成校园北门',
    resolution: tradingResolution,
    viewer: { canSetResolution: true },
  },
});
let tradingContactReads = 0,
  tradingStatusSends = 0,
  tradingPostReads = 0;
let finishTradingStatus, tradingStatusCancellation;
let contactValue = 'synthetic-public-contact';
const clipboard = [];
globalThis.wx.setClipboardData = ({ data, success }) => {
  clipboard.push(data);
  success();
};
const tradingStatusReceipt = {
  requestId: pollRequestId,
  operation: 'set_trading_resolution',
  outcome: 'applied',
  resourceId: pollPostId,
  resolution: 'resolved',
};
app.community.gateway = {
  post: async () => {
    tradingPostReads++;
    return tradingPostWire();
  },
  comments: async () => ({ items: [], nextCursor: null }),
  tradingContacts: async (postId) => {
    tradingContactReads++;
    assert.equal(postId, pollPostId);
    return { postId, contacts: { wechat: contactValue, qq: '', phone: '' } };
  },
  setTradingResolution: async (postId, resolution, requestId, cancel) => {
    tradingStatusSends++;
    tradingStatusCancellation = cancel;
    assert.deepEqual(app.community.pendingTrading.load(pollAccount), {
      version: 1,
      accountId: pollAccount,
      postId,
      resolution,
      clientRequestId: requestId,
    });
    return new Promise((resolve) => {
      finishTradingStatus = resolve;
    });
  },
  tradingReceipt: async () => tradingStatusReceipt,
};
const tradingPage = mountTradingPage(detailModule, { postId: pollPostId });
await flushTrading();
assert.equal(tradingPage.data.loaded, true);
assert.equal(tradingPage.data.tradingContacts.contacts, null);
assert.equal(
  tradingContactReads,
  0,
  'public detail does not fetch contacts automatically',
);
tradingPage.onTradingContacts();
await flushTrading();
assert.equal(tradingContactReads, 1);
assert.equal(tradingPage.data.tradingContacts.contacts.wechat, contactValue);
assert.equal(
  JSON.stringify(tradingPage.data.post).includes(contactValue),
  false,
);
assert.deepEqual(tradingPage.onShareAppMessage(), {
  title: '校园交易信息',
  path: `/pages/community-detail/community-detail?postId=${pollPostId}`,
});
contactValue = 'synthetic-updated-public-contact';
tradingPage.onCopyTradingContact({
  currentTarget: { dataset: { field: 'wechat' } },
});
await flushTrading();
assert.equal(
  tradingContactReads,
  2,
  'copy must recheck current contact permission and value',
);
assert.deepEqual(clipboard, [contactValue]);
assert.equal(
  JSON.stringify([...storage.values()]).includes(contactValue),
  false,
  'revealed contact must not enter storage',
);
tradingPage.onTradingResolution();
await flushTrading();
tradingPage.onTradingResolution();
assert.equal(tradingStatusSends, 1);
assert.equal(tradingPage.data.tradingMutation.frozen, true);
app.onHide();
assert.equal(tradingStatusCancellation.isCancelled, true);
assert.equal(tradingPage.data.post, null);
assert.equal(tradingPage.data.tradingContacts.contacts, null);
finishTradingStatus(tradingStatusReceipt);
await flushTrading();
assert.ok(app.community.pendingTrading.load(pollAccount));
tradingPage.onShow();
await flushTrading();
assert.equal(tradingPage.data.tradingMutation.frozen, true);
assert.equal(tradingPage.data.tradingContacts.contacts, null);
const readsBeforeReceipt = tradingPostReads;
tradingPage.onTradingReceipt();
await flushTrading();
assert.equal(app.community.pendingTrading.load(pollAccount), null);
assert.equal(tradingPage.data.tradingMutation.frozen, false);
assert.ok(
  tradingPostReads > readsBeforeReceipt,
  'settled immutable receipt must trigger a current listing read',
);
assert.equal(
  tradingPage.data.post.trading.resolution,
  'open',
  'historical resolved receipt cannot overwrite a newer reopened listing',
);
tradingPage.onUnload();
assert.equal(tradingPage.data.tradingContacts.contacts, null);
assert.equal(tradingPage.tradingContactsController, undefined);

// Compose saves an incomplete trading draft, forces named identity and separately
// confirms contact disclosure before durable publication with exact decimal text.
let tradingPublicationSends = 0,
  finishTradingPublication;
const tradingPublicationReceipt = {
  ...replyReceipt,
  operation: 'publish_post',
  resourceId: pollPostId,
};
app.community.profiles = {
  profile: async () => ({
    accountId: pollAccount,
    preferences: { defaultAnonymousEnabled: true },
  }),
};
app.community.gateway = {
  capabilities: async () => ({
    publish: { availability: 'allowed', reason: null },
    authorModes: ['named'],
    canDisableComments: false,
    postImageLimit: 9,
    commentImageLimit: 3,
    mediaAvailability: 'unavailable',
    commentRules: {
      unverifiedRequiresNamed: true,
      ownAnonymousPostForcesAnonymous: true,
    },
  }),
  publishPost: async (payload) => {
    tradingPublicationSends++;
    assert.deepEqual(app.community.pending.load(pollAccount).payload, payload);
    assert.equal(payload.authorMode, 'named');
    assert.equal(payload.category, 'trading');
    assert.equal(payload.trading.price, '12.3456789');
    assert.deepEqual(payload.trading.contacts, {
      wechat: 'synthetic-consented-contact',
      qq: '',
      phone: '',
    });
    assert.equal(
      Object.prototype.hasOwnProperty.call(payload, 'component'),
      false,
    );
    return new Promise((resolve) => {
      finishTradingPublication = resolve;
    });
  },
  receipt: async () => tradingPublicationReceipt,
};
const tradingCompose = mountTradingPage(composeModule, {
  spaceId: '55555555-5555-4555-8555-555555555555',
  category: 'trading',
});
await flushTrading();
assert.equal(tradingCompose.data.isTrading, true);
assert.equal(tradingCompose.data.authorMode, 'named');
assert.equal(tradingCompose.data.identityForced, true);
assert.equal(tradingCompose.data.canAddPoll, false);
assert.equal(tradingCompose.data.tradingDraft.urgency, 'urgent');
tradingCompose.onText({ detail: { value: '合成交易发布正文' } });
tradingCompose.onTradingField({
  currentTarget: { dataset: { field: 'price' } },
  detail: { value: '00012.345678900' },
});
tradingCompose.onHide();
tradingCompose.onShow();
await flushTrading();
assert.equal(
  tradingCompose.data.tradingDraft.price,
  '00012.345678900',
  'editable draft retains exact unfinished input',
);
assert.equal(tradingCompose.data.tradingDraft.contactConsent, false);
tradingCompose.onTradingSubtype({
  currentTarget: { dataset: { key: 'qiugou' } },
});
assert.equal(tradingCompose.data.tradingDraft.urgency, 'normal');
tradingCompose.onTradingUrgency({
  currentTarget: { dataset: { key: 'urgent' } },
});
assert.equal(tradingCompose.data.tradingDraft.urgency, 'normal');
tradingCompose.onTradingSubtype({
  currentTarget: { dataset: { key: 'shuma' } },
});
assert.equal(tradingCompose.data.tradingDraft.urgency, 'urgent');
for (const [field, value] of [
  ['location', '合成校区'],
  ['wechat', 'synthetic-consented-contact'],
])
  tradingCompose.onTradingField({
    currentTarget: { dataset: { field } },
    detail: { value },
  });
assert.equal(tradingCompose.data.canSubmit, false);
tradingCompose.onSubmit();
await flushTrading();
assert.equal(
  tradingPublicationSends,
  0,
  'publishing requires explicit contact disclosure consent',
);
tradingCompose.onContactConsent({ detail: { value: true } });
assert.equal(tradingCompose.data.canSubmit, true);
tradingCompose.onSubmit();
await flushTrading();
tradingCompose.onSubmit();
assert.equal(tradingPublicationSends, 1);
assert.equal(tradingCompose.data.frozen, true);
const frozenTradingPayload = app.community.pending.load(pollAccount).payload;
tradingCompose.onTradingField({
  currentTarget: { dataset: { field: 'wechat' } },
  detail: { value: 'replacement-contact' },
});
assert.deepEqual(
  app.community.pending.load(pollAccount).payload,
  frozenTradingPayload,
);
app.onHide();
assert.equal(tradingCompose.data.tradingDraft.wechat, '');
assert.equal(tradingCompose.data.text, '');
finishTradingPublication(tradingPublicationReceipt);
await flushTrading();
assert.ok(app.community.pending.load(pollAccount));
tradingCompose.onShow();
await flushTrading();
assert.equal(tradingCompose.data.frozen, true);
assert.equal(tradingCompose.data.tradingDraft.price, '12.3456789');
tradingCompose.onReceipt();
await flushTrading();
assert.equal(app.community.pending.load(pollAccount), null);
assert.equal(tradingCompose.data.resourcePostId, pollPostId);
assert.equal(tradingCompose.data.tradingDraft.wechat, '');
tradingCompose.onUnload();
// Native feed/mine controls exercise ordinary browsing, subtype filters and
// owner recovery links without loading contacts or treating a campus as identity.
const tradingCampusId = '33333333-3333-4333-8333-333333333333';
const tradingSpaceId = '55555555-5555-4555-8555-555555555555';
const tradingCampus = {
  id: tradingCampusId,
  fullName: '合成校园',
  isActive: true,
};
const tradingFeedQueries = [],
  tradingOwnQueries = [];
app.community.profiles = {
  profile: async () => ({
    accountId: pollAccount,
    selectedCampus: tradingCampus,
  }),
  campuses: async () => ({
    items: [tradingCampus],
    page: 1,
    pageSize: 100,
    total: 1,
  }),
};
app.community.gateway = {
  spaces: async () => ({
    regional: {
      id: tradingSpaceId,
      kind: 'regional',
      name: '合成地区',
      isActive: true,
      operatingRegionId: '99999999-9999-4999-8999-999999999999',
    },
    global: [],
  }),
  feed: async (query) => {
    tradingFeedQueries.push(query);
    const listing = tradingPostWire();
    listing.trading = {
      ...listing.trading,
      urgency: query.category === 'trading' ? 'urgent' : 'normal',
      subtype: {
        kind: 'known',
        key: query.tradingSubtype ?? 'shuma',
        legacyText: null,
      },
    };
    return { items: [listing], nextCursor: null, continuation: 'end' };
  },
  mine: async () => ({ items: [], nextCursor: null }),
  ownTrading: async (after, _cancel, subtype) => {
    tradingOwnQueries.push({ after, subtype });
    const listing = tradingPostWire();
    listing.trading = {
      ...listing.trading,
      subtype: { kind: 'known', key: subtype ?? 'shuma', legacyText: null },
    };
    return { items: [listing], nextCursor: null };
  },
};
const tradingFeedPage = mountTradingPage(
  path.join(dist, 'pages/community-feed/community-feed.js'),
  {},
);
await flushTrading();
assert.deepEqual(tradingFeedQueries[0], { spaceId: tradingSpaceId });
assert.equal(tradingFeedPage.data.posts[0].trading.urgency, 'normal');
tradingFeedPage.onCategory({ currentTarget: { dataset: { key: 'trading' } } });
await flushTrading();
assert.equal(tradingFeedPage.data.posts[0].trading.urgency, 'urgent');
tradingFeedPage.onTradingSubtype({
  currentTarget: { dataset: { key: 'shujia' } },
});
await flushTrading();
assert.deepEqual(tradingFeedQueries[tradingFeedQueries.length - 1], {
  spaceId: tradingSpaceId,
  category: 'trading',
  tradingSubtype: 'shujia',
});
assert.equal(tradingFeedPage.data.posts[0].trading.subtype.key, 'shujia');
tradingFeedPage.onCategory({ currentTarget: { dataset: { key: 'all' } } });
await flushTrading();
assert.deepEqual(tradingFeedQueries[tradingFeedQueries.length - 1], {
  spaceId: tradingSpaceId,
});
assert.equal(tradingFeedPage.data.tradingSubtype, '');
app.onHide();
assert.deepEqual(tradingFeedPage.data.posts, []);
tradingFeedPage.onUnload();
app.community.pendingTrading.freeze({
  version: 1,
  accountId: pollAccount,
  postId: pollPostId,
  resolution: 'resolved',
  clientRequestId: pollRequestId,
});
const tradingMinePage = mountTradingPage(
  path.join(dist, 'pages/community-mine/community-mine.js'),
  {},
);
await flushTrading();
assert.equal(tradingMinePage.data.tradingRecoveryPostId, pollPostId);
tradingMinePage.onOwnTrading();
await flushTrading();
assert.equal(tradingMinePage.data.tradingPosts[0].trading.urgency, 'urgent');
tradingMinePage.onTradingSubtype({
  currentTarget: { dataset: { key: 'shuma' } },
});
await flushTrading();
assert.deepEqual(tradingOwnQueries[tradingOwnQueries.length - 1], {
  after: null,
  subtype: 'shuma',
});
tradingMinePage.onAllPublications();
await flushTrading();
assert.deepEqual(tradingMinePage.data.tradingPosts, []);
assert.equal(
  tradingContactReads,
  2,
  'feed and own listings do not fetch private contacts',
);
app.onHide();
assert.equal(tradingMinePage.data.tradingRecoveryPostId, '');
assert.deepEqual(tradingMinePage.data.tradingPosts, []);
tradingMinePage.onUnload();
app.community.pendingTrading.settle(
  app.community.pendingTrading.load(pollAccount),
  tradingStatusReceipt,
);
// Compiled formation composition, durable joining and private contacts share the real page lifecycle.
const formationMembershipId = 'edededed-eded-4ded-8ded-edededededed';
const formationCreatorId = 'acacacac-acac-4cac-8cac-acacacacacac';
let formationJoined = false,
  formationHidden = false,
  formationSends = 0,
  formationContactReads = 0,
  finishFormationJoin;
const formationJoinReceipt = {
  ...pollReceipt,
  operation: 'join_formation',
  resourceId: formationMembershipId,
};
const formationWire = () => ({
  id: pollWire.id,
  postId: pollPostId,
  capacity: 2,
  theme: '合成组队',
  status: formationJoined ? 'full' : 'open',
  memberCount: formationJoined ? 2 : 1,
  members: [
    {
      id: formationCreatorId,
      author: pollPostWire().author,
      isCreator: true,
      joinedAt: pollReceipt.createdAt,
      viewer: { isSelf: false },
    },
    ...(formationJoined
      ? [
          {
            id: formationMembershipId,
            author: {
              kind: 'named',
              profileId: pollOptionOne,
              displayName: '合成加入者',
              avatar: null,
              experienceDisplay: {
                title: { status: 'unavailable', value: null },
                color: { status: 'unavailable', value: null },
                level: { status: 'unavailable', value: null },
              },
            },
            isCreator: false,
            joinedAt: pollReceipt.createdAt,
            viewer: { isSelf: true },
          },
        ]
      : []),
  ],
  viewer: {
    isMember: formationJoined,
    isCreator: false,
    canJoin: !formationJoined,
    reason: formationJoined ? 'FORMATION_ALREADY_JOINED' : null,
    canReadContacts: formationJoined,
  },
});
const formationPostWire = () => ({
  ...pollPostWire(),
  component: { kind: 'formation', formation: formationWire() },
  viewer: {
    isSelf: false,
    isLiked: false,
    canDelete: false,
    canComment: true,
    isSaved: false,
    canSave: true,
    canSetUpdatePreference: true,
  },
});
app.community.profiles = {
  profile: async () => ({
    accountId: pollAccount,
    preferences: { defaultAnonymousEnabled: true },
  }),
};
app.community.gateway = {
  capabilities: async () => ({
    publish: { availability: 'allowed', reason: null },
    authorModes: ['named', 'anonymous'],
    canDisableComments: false,
    postImageLimit: 9,
    commentImageLimit: 3,
    mediaAvailability: 'unavailable',
    commentRules: {
      unverifiedRequiresNamed: true,
      ownAnonymousPostForcesAnonymous: true,
    },
  }),
  publishPost: async (payload) => {
    assert.equal(payload.component.kind, 'formation');
    assert.equal(payload.component.capacity, 1);
    assert.equal(payload.component.contactSharing, 'members_v1');
    assert.equal(payload.component.contacts.wechat, 'synthetic-creator');
    assert.equal(payload.authorMode, 'anonymous');
    assert.deepEqual(app.community.pending.load(pollAccount).payload, payload);
    return tradingPublicationReceipt;
  },
  post: async () => {
    if (formationHidden) throw new Error('Synthetic unavailable parent');
    return formationPostWire();
  },
  comments: async () => ({ items: [], nextCursor: null }),
  formation: async () => formationWire(),
  joinFormation: async (_post, payload) => {
    formationSends++;
    assert.deepEqual(
      app.community.pendingFormations.load(pollAccount).payload,
      payload,
    );
    assert.equal(payload.contactSharing, 'members_v1');
    return new Promise((resolve) => {
      finishFormationJoin = resolve;
    });
  },
  formationReceipt: async () => formationJoinReceipt,
  ownFormationMembership: async () => ({
    postId: pollPostId,
    membershipId: formationMembershipId,
    joinedAt: pollReceipt.createdAt,
    isCreator: false,
  }),
  formationContacts: async () => {
    formationContactReads++;
    return {
      postId: pollPostId,
      members: [
        {
          membershipId: formationCreatorId,
          contacts: {
            wechat: 'synthetic-received-member-secret',
            qq: '',
            phone: '',
          },
        },
      ],
    };
  },
};
const formationCompose = mountTradingPage(composeModule, {
  spaceId: tradingSpaceId,
  category: 'companions',
});
await flushTrading();
assert.equal(formationCompose.data.formationDraft.wechat, '');
formationCompose.onFormationEnabled({ detail: { value: true } });
formationCompose.onText({ detail: { value: '合成组队正文' } });
for (const [field, value] of [
  ['theme', '一个人的队伍'],
  ['capacity', '1'],
  ['wechat', 'synthetic-creator'],
])
  formationCompose.onFormationField({
    currentTarget: { dataset: { field } },
    detail: { value },
  });
assert.equal(formationCompose.data.canSubmit, false);
formationCompose.onFormationConsent({ detail: { value: true } });
assert.equal(formationCompose.data.canSubmit, true);
formationCompose.onSubmit();
await flushTrading();
assert.equal(app.community.pending.load(pollAccount), null);
assert.equal(formationCompose.data.formationDraft.wechat, '');
formationCompose.onUnload();
const originalIdentityPrivacy = app.community.identityPrivacy;
const formationIdentityTargets = [];
app.community.identityPrivacy = {
  authorization: async () => ({
    role: 'developer',
    management: { global: true, operatingRegionIds: [] },
    identityView: { allowed: true, maxBatchSize: 20 },
  }),
  identities: async (targets) => {
    assert.ok(targets.length <= 20);
    formationIdentityTargets.push(...targets);
    return targets.map((target) => ({
      target,
      status: 'available',
      authorMode: target.id === formationMembershipId ? 'named' : 'anonymous',
      identity: {
        accountId: pollAccount,
        nickname: 'synthetic-developer-overlay-private',
        avatar: null,
        studentNumber: null,
        studentNumberStatus: 'unavailable',
      },
    }));
  },
};
const formationPage = mountTradingPage(detailModule, { postId: pollPostId });
await flushTrading();
assert.equal(formationPage.data.formationView.canJoin, true);
assert.equal(
  formationPage.data.formationIdentityOverlay.developerEnabled,
  true,
);
assert.ok(
  formationIdentityTargets.some(
    (target) =>
      target.kind === 'formation_member' && target.id === formationCreatorId,
  ),
);
assert.equal(
  formationPage.data.formationIdentityOverlay.items[formationCreatorId]
    .nickname,
  'synthetic-developer-overlay-private',
);
assert.equal(
  JSON.stringify([...storage]).includes('synthetic-developer-overlay-private'),
  false,
);
assert.equal(formationPage.data.formationContacts.enabled, false);
formationPage.onFormationContact({
  currentTarget: { dataset: { field: 'wechat' } },
  detail: { value: 'synthetic-join-contact' },
});
formationPage.onFormationConsent({ detail: { value: true } });
formationPage.onFormationJoin();
formationPage.onFormationJoin();
await flushTrading();
assert.equal(formationSends, 1);
assert.equal(formationPage.data.formationView.frozen, true);
app.onHide();
assert.equal(formationPage.data.formationView.formation, null);
assert.equal(formationPage.data.formationView.contacts.wechat, '');
formationJoined = true;
finishFormationJoin(formationJoinReceipt);
await flushTrading();
assert.ok(app.community.pendingFormations.load(pollAccount));
formationHidden = true;
formationPage.onShow();
await flushTrading();
assert.equal(formationPage.data.formationView.frozen, true);
assert.equal(formationPage.data.formationView.formation, null);
formationPage.onFormationOwn();
await flushTrading();
assert.ok(app.community.pendingFormations.load(pollAccount));
formationPage.onFormationReceipt();
await flushTrading();
assert.equal(app.community.pendingFormations.load(pollAccount), null);
assert.equal(formationPage.data.formationView.formation, null);
formationHidden = false;
formationPage.onReload();
await flushTrading();
assert.equal(formationPage.data.formationView.formation.memberCount, 2);
assert.equal(formationPage.data.formationView.canJoin, false);
assert.equal(formationPage.data.formationContacts.enabled, true);
formationPage.onFormationContacts();
assert.deepEqual(formationPage.data.formationIdentityOverlay.items, {});
await flushTrading();
assert.equal(
  formationPage.data.formationContacts.rows[0].contacts.wechat,
  'synthetic-received-member-secret',
);
assert.equal(
  JSON.stringify([...storage]).includes('synthetic-received-member-secret'),
  false,
);
formationPage.onCopyFormationContact({
  currentTarget: { dataset: { id: formationCreatorId, field: 'wechat' } },
});
await flushTrading();
assert.equal(formationContactReads, 2);
formationHidden = true;
formationPage.onReload();
await flushTrading();
assert.deepEqual(formationPage.data.formationContacts.rows, []);
assert.equal(formationPage.data.formationContacts.enabled, false);
app.onHide();
assert.deepEqual(formationPage.data.formationContacts.rows, []);
formationPage.onUnload();
assert.deepEqual(formationPage.data.formationIdentityOverlay.items, {});
// Saved increment 1: durable intent, independent bits and a current visible list.
// These synthetic handlers never enroll a provider or manufacture delivered updates.
let savedActive = false,
  savedHidden = false,
  savedFirst = true,
  savedSends = 0;
let finishSaved, savedCancellation;
let savedBits = { savedUpdatesEnabled: true, externalUpdatesEnabled: true };
let savedRevision = 0;
let savedProcessing = 'manual_only';
const savedReceipts = new Map();
let savedRequestSequence = 10;
app.community.newRequestId = async () =>
  `77777777-7777-4777-8777-${String(savedRequestSequence++).padStart(12, '0')}`;
const savedPostWire = () => {
  const current = tradingPostWire();
  return {
    ...current,
    saveCount: savedActive ? 1 : 0,
    viewer: {
      ...current.viewer,
      isSaved: savedActive,
      canSave: true,
      canSetUpdatePreference: true,
    },
  };
};
const savedPreferencesWire = () => ({
  postId: pollPostId,
  ...savedBits,
  revision: String(savedRevision),
  canSetPreference: true,
  reason: null,
  inAppCapability: 'local',
  inAppProcessing: savedProcessing,
  externalCapability: 'unavailable',
});
app.community.gateway = {
  post: async () => {
    if (savedHidden) throw new Error('Unavailable parent');
    return savedPostWire();
  },
  comments: async () => ({ items: [], nextCursor: null }),
  postUpdatePreferences: async () => savedPreferencesWire(),
  saved: async () => ({
    items:
      savedActive && !savedHidden
        ? [
            {
              post: savedPostWire(),
              savedAt: pollReceipt.createdAt,
              saveEpochId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            },
          ]
        : [],
    nextCursor: null,
    visibleSavedCount: savedActive && !savedHidden ? 1 : 0,
  }),
  applySaved: async (intent, cancel) => {
    savedSends++;
    savedCancellation = cancel;
    const frozen = app.community.pendingSaved.load(pollAccount);
    assert.equal(frozen.clientRequestId, intent.clientRequestId);
    assert.equal(frozen.operation, intent.operation);
    assert.equal(frozen.desired, intent.desired);
    if (intent.operation === 'set_post_saved') savedActive = intent.desired;
    else {
      savedBits = {
        ...savedBits,
        [intent.channel === 'saved'
          ? 'savedUpdatesEnabled'
          : 'externalUpdatesEnabled']: intent.desired,
      };
      savedRevision++;
    }
    const { clientRequestId, ...identity } = intent;
    const receipt = {
      requestId: clientRequestId,
      ...identity,
      outcome: 'applied',
    };
    savedReceipts.set(clientRequestId, receipt);
    if (savedFirst) {
      savedFirst = false;
      return new Promise((resolve) => {
        finishSaved = () => resolve(receipt);
      });
    }
    return receipt;
  },
  savedReceipt: async (requestId) => savedReceipts.get(requestId),
};
app.community.identityPrivacy = undefined;
const savedDetail = mountTradingPage(detailModule, { postId: pollPostId });
await flushTrading();
assert.equal(
  savedDetail.data.savedMutation.preferences.savedUpdatesEnabled,
  true,
);
assert.match(
  savedDetail.data.savedMutation.processingStatus,
  /仅手动处理本地事件/,
);
savedProcessing = 'disabled';
savedDetail.onReload();
await flushTrading();
assert.match(
  savedDetail.data.savedMutation.processingStatus,
  /未启用新站内更新生成/,
);
savedProcessing = 'automatic';
savedDetail.onReload();
await flushTrading();
assert.match(
  savedDetail.data.savedMutation.processingStatus,
  /配置为自动处理本地新事件/,
);
assert.match(
  savedDetail.data.savedMutation.processingStatus,
  /仅显示已生成的记录/,
);
savedProcessing = 'manual_only';
savedDetail.onReload();
await flushTrading();
savedDetail.onSavedToggle();
await flushTrading();
savedDetail.onSavedToggle();
assert.equal(savedSends, 1);
assert.equal(savedDetail.data.savedMutation.frozen, true);
app.onHide();
assert.equal(savedCancellation.isCancelled, true);
assert.equal(savedDetail.data.savedMutation.preferences, null);
finishSaved();
await flushTrading();
assert.ok(app.community.pendingSaved.load(pollAccount));
savedHidden = true;
savedDetail.onShow();
await flushTrading();
assert.equal(savedDetail.data.post, null);
assert.equal(savedDetail.data.savedMutation.frozen, true);
savedDetail.onSavedReceipt();
await flushTrading();
assert.equal(app.community.pendingSaved.load(pollAccount), null);
assert.equal(savedDetail.data.post, null);
// A later independent unsave wins; replay A must not restore its historic desired bit.
savedActive = false;
savedHidden = false;
savedDetail.onReload();
await flushTrading();
assert.equal(savedDetail.data.post.viewer.isSaved, false);
for (const channel of ['saved', 'external']) {
  savedDetail.onSavedPreference({
    currentTarget: { dataset: { channel } },
    detail: { value: false },
  });
  await flushTrading();
  assert.equal(
    savedDetail.data.savedMutation.preferences[
      channel === 'saved' ? 'savedUpdatesEnabled' : 'externalUpdatesEnabled'
    ],
    false,
  );
  if (channel === 'saved')
    assert.equal(
      savedDetail.data.savedMutation.preferences.externalUpdatesEnabled,
      true,
    );
}
savedDetail.onSavedToggle();
await flushTrading();
assert.equal(savedDetail.data.post.viewer.isSaved, true);
assert.equal(
  savedDetail.data.savedMutation.preferences.savedUpdatesEnabled,
  false,
);
assert.equal(
  savedDetail.data.savedMutation.preferences.externalUpdatesEnabled,
  false,
);
savedDetail.onUnload();
const savedPrivateId = '99999999-9999-4999-8999-999999999999';
app.community.identityPrivacy = {
  authorization: async () => ({
    role: 'developer',
    management: { global: true, operatingRegionIds: [] },
    identityView: { allowed: true, maxBatchSize: 20 },
  }),
  identities: async (targets) =>
    targets.map((target) => ({
      target,
      status: 'available',
      authorMode: 'named',
      identity: {
        accountId: savedPrivateId,
        nickname: 'synthetic-saved-private-name',
        avatar: null,
        studentNumber: null,
        studentNumberStatus: 'unavailable',
      },
    })),
};
const savedPageModule = path.join(
  dist,
  'pages/community-saved/community-saved.js',
);
const savedPage = mountTradingPage(savedPageModule, {});
await flushTrading();
assert.equal(savedPage.data.items.length, 1);
assert.equal(savedPage.data.items[0].post.trading.urgency, 'urgent');
assert.equal(savedPage.data.visibleSavedCount, 1);
assert.ok(savedPage.data.identityOverlay.items[pollPostId]);
assert.equal(
  JSON.stringify(savedPage.data.items).includes('synthetic-saved-private-name'),
  false,
);
assert.equal(
  JSON.stringify([...storage.values()]).includes(
    'synthetic-saved-private-name',
  ),
  false,
);
savedPage.onReload();
assert.deepEqual(savedPage.data.identityOverlay.items, {});
await flushTrading();
assert.ok(savedPage.data.identityOverlay.items[pollPostId]);
savedPage.onUnsave({ currentTarget: { dataset: { id: pollPostId } } });
await flushTrading();
assert.equal(savedPage.data.visibleSavedCount, 0);
assert.deepEqual(savedPage.data.items, []);
assert.deepEqual(savedPage.data.identityOverlay.items, {});
savedPage.onHide();
assert.equal(savedPage.controller, undefined);
assert.equal(savedPage.savedMutations, undefined);
assert.equal(savedPage.identityOverlay, undefined);
savedPage.onShow();
await flushTrading();
assert.equal(savedPage.data.visibleSavedCount, 0);
app.onHide();
assert.deepEqual(savedPage.data.items, []);
assert.deepEqual(savedPage.data.identityOverlay.items, {});
savedPage.onUnload();
const savedTemplate = readFileSync(
  path.join(dist, 'pages/community-saved/community-saved.wxml'),
  'utf8',
);
assert.match(savedTemplate, /尚未接入/);
assert.equal(
  /requestSubscribeMessage|requestPermission|unread|badgeCount/.test(
    savedTemplate,
  ),
  false,
);
// Compiled local Updates: ordinary DTOs, separate audited overlay, exact read acknowledgment,
// fresh root/reply locator, unread badge and lifecycle suppression. No device/provider claim.
const updatesNoticeId = 'adadadad-adad-4dad-8dad-adadadadadad';
const unavailableNoticeId = 'bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd';
const updatesReadAt = '2026-10-07T03:00:00.000Z';
let updatesRead = false,
  updatesUnavailable = false,
  updateReads = 0;
let finishUpdateRead, updatesReadCancellation;
const updateRoutes = [],
  updateLocators = [],
  updateOverlayTargets = [];
const updateNotice = () => ({
  noticeId: updatesNoticeId,
  createdAt: pollReceipt.createdAt,
  readAt: updatesRead ? updatesReadAt : null,
  ...(updatesUnavailable
    ? { status: 'unavailable' }
    : {
        status: 'available',
        kind: 'reply',
        reason: 'direct',
        target: {
          postId: pollPostId,
          commentId: rootId,
          replyId: discussionReplyId,
        },
        preview: {
          text: '合成新回复预览',
          images: [],
          author: pollPostWire().author,
        },
      }),
});
const missingNotice = () => ({
  noticeId: unavailableNoticeId,
  createdAt: pollReceipt.createdAt,
  readAt: null,
  status: 'unavailable',
});
globalThis.wx.navigateTo = ({ url, success }) => {
  updateRoutes.push(url);
  success();
};
globalThis.wx.requestSubscribeMessage = forbiddenNativeCall;
globalThis.wx.authorize = forbiddenNativeCall;
app.community.gateway = {
  updates: async () => ({
    items: [updateNotice(), missingNotice()],
    nextCursor: null,
    unreadCount: updatesRead ? 8 : 9,
  }),
  updatesUnread: async () => ({ unreadCount: updatesRead ? 8 : 9 }),
  updateTarget: async (noticeId) => ({
    noticeId,
    ...(updatesUnavailable
      ? { status: 'unavailable' }
      : { status: 'available', target: updateNotice().target }),
  }),
  readUpdate: async (noticeId, cancellation) => {
    updateReads++;
    updatesReadCancellation = cancellation;
    return new Promise((resolve) => {
      finishUpdateRead = () => {
        updatesRead = true;
        resolve({ noticeId, readAt: updatesReadAt, unreadCount: 8 });
      };
    });
  },
  post: async () => ({ ...pollPostWire(), component: { kind: 'none' } }),
  comment: async () => rootWire(),
  comments: async () => ({ items: [], nextCursor: null }),
  replies: async () => ({ items: [], nextCursor: null }),
  discussionContext: async (_postId, target) => {
    updateLocators.push(target);
    return {
      comment: rootWire(),
      reply: target.replyId ? replyWire() : null,
      replies: { items: [], nextCursor: null },
    };
  },
};
app.community.identityPrivacy = {
  authorization: async () => ({
    role: 'developer',
    management: { global: true, operatingRegionIds: [] },
    identityView: { allowed: true, maxBatchSize: 20 },
  }),
  identities: async (targets) => {
    updateOverlayTargets.push(...targets);
    return targets.map((target) => ({
      target,
      status: 'available',
      authorMode: 'anonymous',
      identity: {
        accountId: pollAccount,
        nickname: 'synthetic-updates-private-name',
        avatar: null,
        studentNumber: null,
        studentNumberStatus: 'unavailable',
      },
    }));
  },
};
const updatesModule = path.join(
  dist,
  'pages/community-updates/community-updates.js',
);
const updatesPage = mountTradingPage(updatesModule, {});
await flushTrading();
assert.equal(updatesPage.data.items.length, 2);
assert.equal(updatesPage.data.unreadCount, 9);
assert.equal(updateReads, 0);
assert.ok(updatesPage.data.identityOverlay.items[discussionReplyId]);
assert.deepEqual(updateOverlayTargets, [
  { kind: 'reply', id: discussionReplyId },
]);
assert.equal(
  JSON.stringify(updatesPage.data.items).includes(
    'synthetic-updates-private-name',
  ),
  false,
);
assert.equal(
  JSON.stringify([...storage]).includes('synthetic-updates-private-name'),
  false,
);
updatesPage.onOpen({ currentTarget: { dataset: { id: updatesNoticeId } } });
await flushTrading();
assert.deepEqual(updateRoutes, [
  `/pages/community-thread/community-thread?postId=${pollPostId}&rootCommentId=${rootId}&replyId=${discussionReplyId}`,
]);
assert.deepEqual(updateLocators[0], { replyId: discussionReplyId });
assert.equal(
  updateReads,
  0,
  'Navigation is separate from explicit acknowledgment',
);
const locatedUpdatesThread = mountTradingPage(threadModule, {
  postId: pollPostId,
  rootCommentId: rootId,
  replyId: discussionReplyId,
});
await flushTrading();
assert.equal(locatedUpdatesThread.data.locatedReply.id, discussionReplyId);
assert.deepEqual(locatedUpdatesThread.data.replies, []);
locatedUpdatesThread.onUnload();
updatesPage.onRead({ currentTarget: { dataset: { id: updatesNoticeId } } });
updatesPage.onRead({ currentTarget: { dataset: { id: updatesNoticeId } } });
await flushTrading();
assert.equal(updateReads, 1);
assert.equal(updatesPage.data.items[0].readAt, null);
assert.deepEqual(updatesPage.data.identityOverlay.items, {});
app.onHide();
assert.equal(updatesReadCancellation.isCancelled, true);
assert.deepEqual(updatesPage.data.items, []);
assert.equal(updatesPage.data.unreadCount, 0);
finishUpdateRead();
await flushTrading();
assert.deepEqual(updatesPage.data.items, []);
assert.equal(updatesPage.data.unreadCount, 0);
updatesPage.onShow();
await flushTrading();
assert.equal(updatesPage.data.items[0].readAt, updatesReadAt);
assert.equal(updatesPage.data.unreadCount, 8);
updatesPage.onRead({ currentTarget: { dataset: { id: updatesNoticeId } } });
await flushTrading();
assert.equal(updateReads, 1);
updatesUnavailable = true;
updatesPage.onOpen({ currentTarget: { dataset: { id: updatesNoticeId } } });
await flushTrading();
assert.deepEqual(updatesPage.data.items[0], updateNotice());
assert.deepEqual(updatesPage.data.identityOverlay.items, {});
assert.equal(updateRoutes.length, 1);
// Unavailable placeholders retain owner read state but never regain content/identity on refresh.
updatesPage.onReload();
await flushTrading();
assert.equal(updatesPage.data.items[0].status, 'unavailable');
assert.deepEqual(updatesPage.data.identityOverlay.items, {});
updatesPage.onHide();
assert.equal(updatesPage.controller, undefined);
updatesPage.onShow();
await flushTrading();
const badgePage = mountTradingPage(
  path.join(dist, 'pages/community-feed/community-feed.js'),
  {},
);
await flushTrading();
assert.equal(badgePage.data.updatesBadge.loaded, true);
assert.equal(badgePage.data.updatesBadge.unreadCount, 8);
app.identity.sessions.completeLogin(app.identity.sessions.beginLogin(), {
  accountId: savedPrivateId,
  sessionId: '22345678-1234-4123-8123-123456789abc',
  accessToken: `wu_a_${'b'.repeat(43)}`,
  refreshToken: `wu_r_${'b'.repeat(43)}`,
  expiresAt: 1900000000000,
  refreshExpiresAt: 1900600000000000,
});
assert.equal(badgePage.data.updatesBadge.unreadCount, 0);
assert.equal(badgePage.data.updatesBadge.loaded, false);
assert.deepEqual(updatesPage.data.items, []);
assert.equal(updatesPage.data.unreadCount, 0);
badgePage.onUnload();
updatesPage.onUnload();
const updatesTemplate = readFileSync(
  path.join(dist, 'pages/community-updates/community-updates.wxml'),
  'utf8',
);
assert.match(updatesTemplate, /标记已读/);
assert.match(updatesTemplate, /外部通知尚未接入/);
assert.equal(
  /requestSubscribeMessage|requestPermission|actorId|studentNumber|contacts/.test(
    updatesTemplate,
  ),
  false,
);
app.identity.sessions.completeLogin(app.identity.sessions.beginLogin(), {
  accountId: pollAccount,
  sessionId: '22345678-1234-4123-8123-123456789abc',
  accessToken: `wu_a_${'a'.repeat(43)}`,
  refreshToken: `wu_r_${'a'.repeat(43)}`,
  expiresAt: 1900000000000,
  refreshExpiresAt: 1900600000000000,
});
await smokeDiscussionPagination({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
  rootWire,
  replyWire,
  accountId: pollAccount,
});
await smokeNamedBlocks({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
  rootWire,
  replyWire,
  accountId: pollAccount,
});
app.identity.sessions.completeLogin(app.identity.sessions.beginLogin(), {
  accountId: pollAccount,
  sessionId: '22345678-1234-4123-8123-123456789abc',
  accessToken: `wu_a_${'a'.repeat(43)}`,
  refreshToken: `wu_r_${'a'.repeat(43)}`,
  expiresAt: 1900000000000,
  refreshExpiresAt: 1900600000000000,
});
await smokeReporting({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
  rootWire,
  replyWire,
});
await smokeSystemNotices({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
});
await smokeRuntimePolicy({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
});
await smokeExperience({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
});
await smokeIdentityCampus({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
});
await smokeTradingContacts({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
});
await smokeProfileDiscovery({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
  rootWire,
  replyWire,
});
await smokeDirectory({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
});
await smokeSearch({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
  tradingWire: tradingPostWire,
});
await smokeHot({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
});
await smokePublicExperience({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
});
await smokeViewReporting({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
  postWire: pollPostWire,
});
await smokeErrands({ app, dist, flush: flushTrading });
await smokeRatings({ app, dist, flush: flushTrading });
await smokeRatingsR2A({ app, dist, flush: flushTrading });
await smokeRatingsR2B({ app, dist, flush: flushTrading });
await smokeRatingsR2C({ app, dist, flush: flushTrading });
await smokeRatingsR3A({ app, dist, flush: flushTrading });
await smokeRatingsR3R({ app, dist, flush: flushTrading });
await smokeRatingOwnerManagement({ app, dist, flush: flushTrading });
await smokeRatingOwnerEditing({ app, dist, flush: flushTrading });
await smokeRatingCategoryManagement({ app, dist, flush: flushTrading });
await smokeErrandAdmin({ app, dist, flush: flushTrading });
await smokeErrandAdminMutations({ app, dist, flush: flushTrading });
await smokeErrandAdminNotices({ app, dist, flush: flushTrading });
await smokeActivities({ app, dist, flush: flushTrading });
await smokeAnnouncements({
  app,
  dist,
  mountPage: mountTradingPage,
  flush: flushTrading,
});
app.community.identityPrivacy = originalIdentityPrivacy;
app.community.profiles = originalProfiles;
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
  'Native build smoke passed: local bootstrap, all identity/campus/profile/community/verification handlers, hide/show cancellation, assets, navigation, private-overlay, own-verification durable-poll, reply-publication, discussion-interaction, private trading contacts, exact trading publication and immutable trading-resolution app-hide clearing/recovery, formation creation/join/member-contact fresh-copy/hidden-parent recovery/audited roster overlay, Saved list, independent update preferences, original-intent hidden-parent recovery, separate audited Saved overlay, local Updates exact read state, authorized off-page reply navigation, unavailable previews, audited Updates overlay, owner badge clearing, unavailable runtime publication with independent readable/like paths and preserved receipts, and configuration gating',
);
