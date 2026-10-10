/** Emitted Page + repository WXML conditional model; not physical-device rendering. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from '../scripts/smoke-ratings.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(
  process.env.WHALEU_WECHAT_DIST ?? path.join(root, 'dist'),
);
const emitted = (name) => require(path.join(dist, `${name}.js`));
const { registerRatingScopedPage } = emitted('ratings/scoped-page');
const { systemClock } = emitted('platform/clock');
const { ClientError } = emitted('api/errors');
const { ratingTargetCoverIntentHash } = emitted(
  'ratings/target-cover-contract',
);
const { ratingCoverScopeIdentity } = emitted(
  'ratings/target-cover-upload-scope',
);
const { ratingCoverPrepareHash } = emitted(
  'ratings/target-cover-media-contract',
);
const {
  scopedHarness,
  scopedContext,
  scopedPageContext,
  definitionRevision,
} = require('./rating-scoped-helpers.ts');
const {
  target,
  targetId,
  categoryId,
  otherId,
  requestId,
  revision,
  summary,
} = require('./ratings-helpers.ts');
const s = scopedHarness();
s.controller.dispose();
const old = {
  Page: globalThis.Page,
  getApp: globalThis.getApp,
  wx: globalThis.wx,
};
const oldClock = { ...systemClock };
Object.assign(systemClock, {
  now: () => s.clock.now(),
  schedule: (fn, ms) => s.clock.schedule(fn, ms),
});
const protocol = 'ratings-target-media-v1';
let legacyLifetime = 300000,
  coverLifetime = 300000,
  canComment = true,
  prepareReady = true,
  picks = 0,
  serial = 20;
const commands = [],
  pages = [],
  reads = [];
const missing = async () => {
  throw new ClientError('business', 'Unknown receipt', {
    serverCode: 'REQUEST_NOT_FOUND',
  });
};
s.gateway.contextWork = async (request) => ({
  ...scopedContext(request, s.clock.now()),
  expiresAt: new Date(s.clock.now() + legacyLifetime).toISOString(),
});
const cover = {
  context: async (request) => ({
    ...scopedContext(request, s.clock.now()),
    protocolVersion: 3,
    id: otherId,
    expiresAt: new Date(s.clock.now() + coverLifetime).toISOString(),
    capabilities: ['target_cover'],
  }),
  editContext: async (context) => ({
    context: { ...scopedPageContext(), contextId: context.id },
    targetId,
    revision,
    definitionRevision,
    contentVersion: 1,
    categoryId,
    categoryRevision: revision,
    name: 'Mounted cover target',
    description: '',
    cover: null,
  }),
  detail: async (context) => {
    reads.push(context);
    return {
      context: { ...scopedPageContext(), contextId: context.id },
      target: {
        ...target(),
        allowedActions: {
          ...target().allowedActions,
          createComment: canComment,
        },
      },
      cover: null,
    };
  },
  random: async (context) => ({
    context: {
      contextId: context.id,
      selector: context.selector,
      protocolGeneration: context.protocolGeneration,
      categoryId,
      minimumAverage: null,
    },
    candidateCount: 23,
    item: {
      locator: {
        selector: { kind: 'global' },
        targetId,
        rootId: null,
        replyId: null,
        protocolGeneration: context.protocolGeneration,
      },
      target: target(),
      summary: summary(),
      cover: null,
      coverContext: {
        ...scopedContext(
          { purpose: 'read', mode: 'public', selector: { kind: 'global' } },
          s.clock.now(),
        ),
        protocolVersion: 3,
        id: requestId,
      },
    },
  }),
  receipt: missing,
  command: async (intent) => {
    commands.push(intent);
    return {
      protocolVersion: 3,
      requestId: intent.payload.clientRequestId,
      operation: intent.operation,
      intentHash: ratingTargetCoverIntentHash(intent),
      outcome: 'closed',
      code:
        intent.operation === 'edit_target_scoped'
          ? 'RATING_EDIT_CANCELLED'
          : 'RATING_CREATION_CANCELLED',
    };
  },
};
let uploadScope;
const media = {
  scope: async (input) => {
    const identity = ratingCoverScopeIdentity(
      s.sessions.snapshot().credentials.accountId,
      input,
    );
    uploadScope = {
      protocolVersion: 3,
      ...identity,
      targetId,
      expiresAt: new Date(s.clock.now() + 300000).toISOString(),
      prepare: {
        protocol,
        clientRequestId: input.clientRequestId,
        editScopeId: identity.scopeId,
        scopeRevision: identity.scopeRevision,
        slot: 'cover',
        declaration: input.declaration,
      },
    };
    return uploadScope;
  },
  recover: async (id) => ({
    protocol,
    requestId: id,
    serverNow: s.clock.now(),
    state: 'not_recorded',
    requestHash: null,
  }),
  prepare: async (input) => {
    if (!prepareReady)
      throw new ClientError('network', 'Unknown upload preparation');
    return {
      protocol,
      editScopeId: input.editScopeId,
      intentId: requestId,
      requestId: input.clientRequestId,
      requestHash: ratingCoverPrepareHash(
        s.sessions.snapshot().credentials.accountId,
        input,
      ),
      serverNow: s.clock.now(),
      status: 'ready_unbound',
      assetId: targetId,
      readyRetentionUntil: s.clock.now() + 200000,
      editExpiresAt: s.clock.now() + 200000,
      bindBefore: s.clock.now() + 200000,
      mediaProof: 'current',
    };
  },
  cancelScope: async (input) => ({
    protocolVersion: 3,
    clientRequestId: input.clientRequestId,
    scopeId: uploadScope.scopeId,
    scopeRevision: uploadScope.scopeRevision,
    prepare: uploadScope.prepare,
    recovery: {
      protocol,
      requestId: input.clientRequestId,
      serverNow: s.clock.now(),
      state: 'cancelled_before_prepare',
      requestHash: ratingCoverPrepareHash(
        s.sessions.snapshot().credentials.accountId,
        uploadScope.prepare,
      ),
      reason: 'cancelled',
    },
  }),
};
const upload = {
  pickerState: 'ready',
  subscribePicker: () => () => undefined,
  pick: async () => {
    picks++;
    return { localId: `picked-${picks}` };
  },
  inspect: async () => ({
    mime: 'image/png',
    bytes: 100,
    sha256: 'a'.repeat(64),
    width: 80,
    height: 60,
  }),
  preview: async () => 'wxfile://tmp/synthetic-cover.png',
  remove: async () => undefined,
  clearSession: () => undefined,
};
const runtime = {
  ...s.runtime,
  ratingTargetCover: cover,
  ratingCoverMedia: media,
  ratingCoverUpload: upload,
  newRequestId: async () =>
    `${String(serial++).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
};
s.gateway.summary = async (context) => {
  reads.push(context);
  return {
    ...summary(),
    count: 7,
    sum: 21,
    average: 3,
    distribution: { 1: 0, 2: 0, 3: 7, 4: 0, 5: 0 },
  };
};
const source = readFileSync(
  path.join(dist, 'pages/rating-scoped/rating-scoped.wxml'),
  'utf8',
);
const tree = parse(source);
const templates = Object.fromEntries(
  ['ratings/common.wxml', 'ratings/target-cover.wxml']
    .flatMap(
      (file) => parse(readFileSync(path.join(dist, file), 'utf8')).children,
    )
    .filter((node) => typeof node !== 'string' && node.tag === 'template')
    .map((node) => [node.attrs.name, node]),
);
const drain = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve();
};
const nodes = (page) => {
  const flat = [];
  const visit = (items) => {
    for (const item of items) {
      flat.push(item);
      if (typeof item !== 'string') visit(item.children);
    }
  };
  visit(render(tree.children, page.data, templates));
  return flat;
};
const buttons = (page, handler) =>
  nodes(page).filter(
    (node) =>
      typeof node !== 'string' &&
      node.tag === 'button' &&
      node.attrs.bindtap === handler,
  );
const text = (page) =>
  nodes(page)
    .filter((node) => typeof node === 'string')
    .join(' ');
const tap = (page, handler) => {
  const button = buttons(page, handler)[0];
  assert.ok(button, `Mounted button ${handler} is visible`);
  assert.notEqual(button.attrs.disabled, 'true', `${handler} is enabled`);
  page[handler]({ currentTarget: { dataset: {} } });
};
const mount = async (mode) => {
  let page;
  globalThis.Page = (definition) => {
    page = definition;
  };
  registerRatingScopedPage();
  page.setData = (patch, done) => {
    page.data = { ...page.data, ...patch };
    done?.();
  };
  pages.push(page);
  page.onLoad({
    mode,
    scope: 'global',
    ...(['create', 'random'].includes(mode) ? { categoryId } : { targetId }),
  });
  page.onShow();
  await drain();
  assert.equal(page.data.loaded, true);
  return page;
};
try {
  globalThis.getApp = () => ({ community: runtime });
  globalThis.wx = {};
  const create = await mount('create');
  assert.equal(buttons(create, 'onCoverKeep').length, 0);
  assert.equal(buttons(create, 'onCoverClear').length, 1);
  create.onUnload();
  const edit = await mount('edit');
  for (const [handler, action] of [
    ['onCoverKeep', 'keep'],
    ['onCoverClear', 'clear'],
  ]) {
    tap(edit, handler);
    tap(edit, 'onDefinitionConfirm');
    tap(edit, 'onDefinitionCommit');
    await drain();
    assert.equal(commands.at(-1).payload.cover.action, action);
    assert.equal(edit.data.frozen, false, edit.data.error);
    assert.equal(
      s.pendingRatings.load(s.sessions.snapshot().credentials.accountId),
      null,
    );
    tap(edit, 'onRefresh');
    await drain();
  }
  tap(edit, 'onCoverChoose');
  await drain();
  assert.equal(edit.data.coverAction, 'replace');
  assert.equal(edit.data.coverUpload.status, 'ready');
  for (const handler of ['onCoverChoose', 'onCoverKeep', 'onCoverClear'])
    assert.equal(buttons(edit, handler)[0].attrs.disabled, 'true');
  assert.equal(buttons(edit, 'onCoverCancel').length, 1);
  tap(edit, 'onCoverCancel');
  await drain();
  assert.equal(edit.data.coverUpload.localSrc, '');
  assert.equal(
    s.pendingRatings.load(s.sessions.snapshot().credentials.accountId),
    null,
  );
  assert.ok(text(edit).includes('刷新后重新确认'));
  assert.equal(buttons(edit, 'onCoverChoose')[0].attrs.disabled, 'true');
  tap(edit, 'onRefresh');
  await drain();
  tap(edit, 'onCoverChoose');
  await drain();
  assert.equal(picks, 2);
  tap(edit, 'onCoverCancel');
  await drain();
  tap(edit, 'onRefresh');
  await drain();
  prepareReady = false;
  tap(edit, 'onCoverChoose');
  await drain();
  assert.equal(edit.data.coverUpload.status, 'pending');
  assert.equal(buttons(edit, 'onCoverRecover').length, 1);
  assert.ok(text(edit).includes('恢复原封面请求'));
  tap(edit, 'onCoverCancel');
  await drain();
  prepareReady = true;
  edit.onUnload();
  for (const version of [2, 3]) {
    legacyLifetime = version === 2 ? 10 : 300000;
    coverLifetime = version === 3 ? 10 : 300000;
    const expiring = await mount('edit');
    assert.equal(buttons(expiring, 'onCoverChoose')[0].attrs.disabled, 'false');
    s.clock.advance(11);
    await drain();
    assert.equal(expiring.data.loaded, false);
    assert.equal(buttons(expiring, 'onCoverChoose').length, 0);
    assert.ok(text(expiring).includes('刷新后重新确认'));
    legacyLifetime = coverLifetime = 300000;
    tap(expiring, 'onRefresh');
    await drain();
    assert.equal(expiring.data.loaded, true);
    expiring.onUnload();
  }
  const detail = await mount('detail');
  assert.ok(text(detail).includes('7 人评分 · 3'));
  assert.ok(text(detail).includes('0 赞'));
  assert.equal(buttons(detail, 'onCompose').length, 1);
  canComment = false;
  tap(detail, 'onRefresh');
  await drain();
  assert.equal(buttons(detail, 'onCompose').length, 0);
  assert.ok(text(detail).includes('7 人评分 · 3'));
  assert.equal(text(detail).includes('true'), false);
  assert.equal(text(detail).includes('false'), false);
  assert.ok(reads.some((context) => context.protocolVersion === 2));
  assert.ok(reads.some((context) => context.protocolVersion === 3));
  assert.equal(JSON.stringify(detail.data).includes('contextToken'), false);
  const random = await mount('random');
  tap(random, 'onDraw');
  await drain();
  assert.ok(text(random).includes('满足条件的不同对象：23'));
  console.log(
    'Ratings cover emitted Page/WXML smoke passed; synthetic mounted projection, not device acceptance.',
  );
} finally {
  for (const page of pages) page.onUnload();
  Object.assign(globalThis, old);
  Object.assign(systemClock, oldClock);
}
