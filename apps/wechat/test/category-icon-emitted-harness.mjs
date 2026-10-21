/** Actual emitted CommonJS Page/controller/adapters with synthetic native callbacks.
 * WXML uses the repository's bounded condition/loop model, not a physical device.
 * No source controller, hand-written Page projection or fake transfer is mounted.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from '../scripts/smoke-ratings.mjs';
import { createRecoveryPressBridge } from './framework7-rating-recovery-native-harness.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(
  process.env.WHALEU_WECHAT_DIST ?? path.join(root, 'dist'),
);
const emitted = (name) => require(path.join(dist, `${name}.js`));
const { SessionStore } = emitted('auth/session');
const { ClientError } = emitted('api/errors');
const { systemClock } = emitted('platform/clock');
const { MediaLocalFiles } = emitted('media/local-files');
const { PendingRatingStore } = emitted('ratings/pending');
const { PendingRatingCategoryIconStore } = emitted(
  'ratings/category-icon-pending',
);
const { RatingCategoryScopedController } = emitted(
  'ratings/category-scoped-controller',
);
const { CategoryIconUpload } = emitted('ratings/category-icon-upload');
const { CategoryIconDownload } = emitted('ratings/category-icon-download');
const { categoryIconPrepareHash } = emitted(
  'ratings/category-icon-media-contract',
);
const { categoryIconScopeRequestHash } = emitted(
  'ratings/category-icon-upload-scope',
);
const { decodeRatingManagedIconCategory } = emitted(
  'ratings/category-icon-contract',
);
const { setup } = require('./community-helpers.ts');
const { FakeClock, deferred } = require('./helpers.ts');
const { wireCredentials, accountId } = require('./identity-helpers.ts');
const {
  iconContext,
  iconCategory,
  iconPreparation,
  iconReceipt,
  iconId,
  mediaSnapshot,
} = require('./category-icon-helpers.ts');
const {
  managedRoute,
  managedCampus,
  managedSnapshot,
  managementNow,
} = require('./category-scoped-helpers.ts');
const {
  DownloadCall,
  imageHeaders,
} = require('./support/media-read-fixtures.ts');
const protocol = 'ratings-category-icon-media-v1';
const origin = 'https://category-icon-emitted.invalid';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aSUcAAAAASUVORK5CYII=',
  'base64',
);
const digest = createHash('sha256').update(png).digest('hex');
const MiB = 1024 * 1024;
const drain = async () => {
  for (let i = 0; i < 250; i++) await Promise.resolve();
};
const flatten = (nodes) =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
// Expand the include from the *emitted entrypoint* rather than reading src WXML.
function emittedWxml(file) {
  assert.ok(
    file.startsWith(`${dist}${path.sep}`),
    'WXML stays inside emitted output',
  );
  const source = readFileSync(file, 'utf8');
  return source.replace(/<include\s+src="([^"]+)"\s*\/>/g, (_all, relative) =>
    emittedWxml(path.resolve(path.dirname(file), relative)),
  );
}
const tree = parse(
  emittedWxml(
    path.join(dist, 'pages/rating-category-editor/rating-category-editor.wxml'),
  ),
);
const nodes = (page) => flatten(render(tree.children, page.data));
const visibleText = (page) =>
  nodes(page)
    .filter((node) => typeof node === 'string')
    .join(' ');
const buttons = (page, handler, dataset = {}) =>
  nodes(page).filter(
    (node) =>
      typeof node !== 'string' &&
      node.tag === 'wu-f7-button' &&
      node.attrs['bind:press'] === handler &&
      Object.entries(dataset).every(
        ([key, value]) => node.attrs[`data-${key}`] === value,
      ),
  );
function invoke(page, handler, dataset = {}, value = '') {
  assert.equal(
    typeof page[handler],
    'function',
    `Emitted handler ${handler} is registered`,
  );
  page[handler]({ currentTarget: { dataset }, detail: { value } });
}
function tap(page, handler, dataset = {}) {
  const button = buttons(page, handler, dataset)[0];
  assert.ok(
    button,
    `Emitted WXML renders ${handler} ${JSON.stringify(dataset)}`,
  );
  assert.notEqual(button.attrs.disabled, 'true', `${handler} is enabled`);
  const renderedDataset = Object.fromEntries(
    Object.entries(button.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [key.slice(5), value]),
  );
  const bridge = createRecoveryPressBridge({
    page,
    dist,
    pageFile: path.join(
      dist,
      'pages/rating-category-editor/rating-category-editor',
    ),
  });
  try {
    const control = bridge.capture(handler, renderedDataset);
    try {
      assert.equal(
        control.press(),
        true,
        `${handler} crosses actual native Component boundary`,
      );
    } finally {
      control.detach();
    }
  } finally {
    bridge.disposeProjection();
  }
}

function assertPrivateProjection(page) {
  for (const value of page.patches) {
    const json = JSON.stringify(value);
    assert.doesNotMatch(
      json,
      /contextToken|tokenDigest|accessToken|refreshToken|uploadScopeId/,
    );
    assert.equal(json.includes(wireCredentials().accessToken), false);
  }
}

function harness(mode = 'inherit') {
  const seed = setup(),
    sessions = new SessionStore(),
    clock = new FakeClock();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  clock.advance(managementNow - clock.now());
  const store = new PendingRatingCategoryIconStore(
    seed.storage,
    'emitted-category',
  );
  const stopWatch = store.watchSession(sessions);
  const resident = new Map(),
    deleted = [],
    pickers = [],
    uploads = [],
    downloads = [];
  const effects = [],
    contexts = [],
    scopeInputs = [],
    prepareInputs = [],
    recoveries = [];
  const prepared = [],
    committed = [],
    grants = [];
  const state = {
    mode,
    limitStage: null,
    limited: false,
    expired: false,
    descriptorHold: null,
    sequence: 0,
    scope: null,
    prepare: null,
  };
  const files = {
    stat: async (file) => resident.get(file)?.length ?? 0,
    image: async (file) => {
      assert.deepEqual(resident.get(file)?.subarray(0, 8), png.subarray(0, 8));
      return { width: 1, height: 1, type: 'png' };
    },
    digest: async (file, _bytes, current) => {
      current();
      return createHash('sha256').update(resident.get(file)).digest('hex');
    },
    readError: async () => null,
    unlink: async (file) => {
      deleted.push(file);
      resident.delete(file);
    },
  };
  const registry = new MediaLocalFiles(files);
  const wx = {
    navigateTo: ({ success }) => success?.(),
    chooseMedia: (options) => {
      pickers.push(options);
    },
    uploadFile: (options) => {
      const call = {
        options,
        aborted: 0,
        abort() {
          this.aborted++;
        },
      };
      uploads.push(call);
      return call;
    },
    downloadFile: (options) => {
      const call = new DownloadCall(options);
      downloads.push(call);
      return call;
    },
  };
  const transfer = new CategoryIconUpload(
    origin,
    wx,
    files,
    registry,
    sessions,
    clock,
  );
  const download = new CategoryIconDownload(
    origin,
    wx,
    files,
    registry,
    sessions,
    { refresh: async () => sessions.snapshot() },
    clock,
  );
  function category(index = 0) {
    const value = iconCategory(index);
    if (index) return value;
    const base = { state: 'image', appearanceId: iconId(701) };
    const override =
      state.mode === 'inherit'
        ? { mode: 'inherit', state: { state: 'inherit', appearanceId: null } }
        : {
            mode: 'set',
            state:
              state.mode === 'set-empty'
                ? { state: 'absent', appearanceId: null }
                : { state: 'image', appearanceId: iconId(702) },
          };
    return decodeRatingManagedIconCategory({
      ...value,
      icon: {
        base,
        override,
        effective: override.mode === 'inherit' ? base : override.state,
      },
    });
  }
  const missing = async () => {
    effects.push('receipt');
    throw new ClientError('http', 'Original receipt absent', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  const gateway = {
    entryContext: async (selector) => {
      effects.push('entry');
      const context = iconContext(selector, clock.now());
      contexts.push(context);
      return { kind: 'icon', context };
    },
    context: async () => {
      assert.fail('Recovery must not mint a replacement context');
    },
    categories: async () => ({
      items: [0, 1, 2, 3].map(category),
      snapshotRevision: managedSnapshot,
      mediaSnapshot,
      complete: true,
    }),
    category: async (_context, id) =>
      [0, 1, 2, 3].map(category).find((item) => item.id === id),
    history: async () => ({ items: [], nextCursor: null }),
    systemOptions: async () => ({ items: [] }),
    prepare: async (intent) => {
      effects.push('business-prepare');
      prepared.push(intent);
      return iconPreparation(intent, clock.now());
    },
    commit: async (intent) => {
      effects.push('business-commit');
      committed.push(intent);
      return iconReceipt(intent);
    },
    cancel: async (intent) => iconReceipt(intent, 'closed'),
    receipt: missing,
    cancelByHash: async () => assert.fail('Unexpected opaque cancellation'),
    retirementStatus: async () => assert.fail('Unexpected retirement read'),
    cleanupRetirement: async () => assert.fail('Unexpected retirement write'),
  };
  const limit = () => {
    throw new ClientError('http', 'Synthetic provider message', {
      httpStatus: 429,
      serverCode: 'MEDIA_RATE_LIMITED',
    });
  };
  const status = (kind = 'ready_unbound') => {
    assert.ok(state.prepare);
    const input = state.prepare;
    return {
      protocol,
      editScopeId: input.editScopeId,
      intentId: iconId(802),
      requestId: input.clientRequestId,
      requestHash: categoryIconPrepareHash(accountId, input),
      serverNow: clock.now(),
      status: kind,
      ...(kind === 'prepared'
        ? { operationDeadlineAt: clock.now() + 1800000, upload: 'none' }
        : {
            assetId: iconId(803),
            readyRetentionUntil: clock.now() + 300000,
            editExpiresAt: Date.parse(state.scope.expiresAt),
            bindBefore: Date.parse(state.scope.expiresAt),
            mediaProof: 'current',
          }),
    };
  };
  const media = {
    descriptor: async (
      categoryId,
      appearanceId,
      contextId,
      contextToken,
      purpose,
    ) => {
      effects.push('descriptor');
      assert.equal(purpose, 'management-preview');
      const value = {
        protocol,
        kind: 'ratings-category-icon-media',
        categoryId,
        appearanceId,
        contextId,
        contextToken,
        bindingId: iconId(703),
        width: 1,
        height: 1,
        variants: ['thumb-v1', 'display-v1'],
      };
      if (state.descriptorHold) await state.descriptorHold.promise;
      return value;
    },
    scope: async (input) => {
      effects.push('scope');
      scopeInputs.push(input);
      assert.deepEqual(
        store.load(accountId).uploads.members[0].scopeInput,
        input,
        'Original identity is durable before requesting a scope',
      );
      if (state.limited && state.limitStage === 'scope') limit();
      state.scope = {
        editScopeId: iconId(800),
        scopeRevision: 'd'.repeat(64),
        categoryId: iconCategory().id,
        identityId: iconId(801),
        expiresAt: new Date(clock.now() + 300000).toISOString(),
      };
      return state.scope;
    },
    prepare: async (input) => {
      effects.push('media-prepare');
      prepareInputs.push(input);
      state.prepare = input;
      if (state.limited && state.limitStage === 'prepare') limit();
      if (state.expired)
        throw new ClientError('business', 'Original scope expired', {
          httpStatus: 409,
          serverCode: 'RATING_SCOPED_CONTEXT_CHANGED',
        });
      return status('prepared');
    },
    recover: async (requestId) => ({
      protocol,
      requestId,
      serverNow: clock.now(),
      state: 'not_recorded',
      requestHash: null,
    }),
    recoverScope: async (requestId, requestHash) => {
      effects.push('recover-scope');
      recoveries.push({ requestId, requestHash });
      assert.ok(
        effects.lastIndexOf('receipt') < effects.lastIndexOf('recover-scope'),
      );
      assert.ok(
        effects.includes('receipt'),
        'Original business receipt is read first',
      );
      return state.scope
        ? { state: 'known', scope: state.scope, recovery: null }
        : { state: 'unknown', scope: null, recovery: null };
    },
    grant: async () => {
      const input = state.prepare;
      const value = {
        protocol,
        editScopeId: input.editScopeId,
        intentId: iconId(802),
        strategy: 'authenticated-multipart-v1',
        generation: '9007199254740993',
        grantId: iconId(804),
        method: 'POST',
        fieldName: 'file',
        maxBytes: 5 * MiB,
        expectedBytes: png.length,
        expectedMime: 'image/png',
        expectedSha256: digest,
        grantExpiresAt: clock.now() + 100000,
        operationDeadlineAt: clock.now() + 1800000,
        serverNow: clock.now(),
      };
      grants.push(value);
      return value;
    },
    finalize: async () => status(),
    status: async () => status(),
    cancelScope: async (requestId, requestHash) => {
      effects.push('cancel-scope');
      recoveries.push({ requestId, requestHash });
      return state.scope
        ? {
            state: 'cancelled',
            scope: state.scope,
            recovery: {
              protocol,
              requestId,
              serverNow: clock.now(),
              state: 'cancelled_before_prepare',
              requestHash: categoryIconPrepareHash(accountId, state.prepare),
              reason: 'cancelled',
            },
          }
        : { state: 'cancelled', scope: null, recovery: null };
    },
    cancelRequest: async () =>
      assert.fail('Unexpected direct media cancellation'),
  };
  const runtime = {
    ...seed.runtime,
    sessions,
    newRequestId: async () => iconId(++state.sequence),
    pendingRatings: new PendingRatingStore(seed.storage, 'emitted-category'),
    pendingRatingCategoryIcon: store,
    ratingCategoryScoped: gateway,
    ratingCategoryIcon: gateway,
    ratingCategoryIconMedia: media,
    ratingCategoryIconUpload: transfer,
    ratingCategoryIconDownload: download,
  };
  const originalClock = { ...systemClock };
  Object.assign(systemClock, {
    now: () => clock.now(),
    schedule: (fn, ms) => clock.schedule(fn, ms),
  });
  let page;
  globalThis.Page = (value) => {
    page = value;
  };
  globalThis.wx = wx;
  globalThis.getApp = () => ({ community: runtime });
  const entry = path.join(
    dist,
    'pages/rating-category-editor/rating-category-editor.js',
  );
  delete require.cache[require.resolve(entry)];
  require(entry);
  assert.ok(page, 'Actual compiled entrypoint called Page()');
  page.patches = [];
  page.setData = (patch, complete) => {
    page.patches.push(structuredClone(patch));
    page.data = { ...page.data, ...patch };
    complete?.();
  };
  // Inspect *all* emitted event bindings, even branches initially hidden.
  for (const node of flatten(tree.children)) {
    if (typeof node === 'string') continue;
    for (const [name, handler] of Object.entries(node.attrs))
      if (/^bind(?:tap|input)$/.test(name))
        assert.equal(typeof page[handler], 'function');
  }
  async function mount() {
    page.onLoad(managedRoute);
    page.onShow();
    await drain();
    assert.ok(page.controller instanceof RatingCategoryScopedController);
    assert.equal(page.data.loaded, true, page.data.error);
    assert.equal(page.data.iconEnabled, true);
    return page;
  }
  async function choose() {
    const picker = pickers.at(-1);
    assert.ok(picker, 'Actual emitted chooser entered wx.chooseMedia');
    const file = `wxfile://tmp/category-emitted-pick-${pickers.length}.png`;
    resident.set(file, png);
    picker.success({
      tempFiles: [{ tempFilePath: file, size: png.length, fileType: 'image' }],
    });
    picker.complete();
    await drain();
  }
  async function finishUpload(complete = true) {
    const call = uploads.at(-1),
      grant = grants.at(-1);
    assert.ok(call, 'Actual emitted upload entered wx.uploadFile');
    assert.equal(
      call.options.url,
      `${origin}/v3/media/ratings-category-icon/upload-scopes/${grant.editScopeId}/uploads/${grant.grantId}`,
    );
    assert.equal(
      call.options.header.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
    call.options.success({
      statusCode: 200,
      data: JSON.stringify({
        protocol,
        editScopeId: grant.editScopeId,
        status: 'uploadObserved',
        intentId: grant.intentId,
        generation: grant.generation,
        grantId: grant.grantId,
        bytes: png.length,
        sha256: digest,
        next: 'finalize',
      }),
    });
    await drain();
    if (complete) {
      call.options.complete();
      await drain();
    }
  }
  async function finishDownload(call = downloads.at(-1), name = 'current') {
    assert.ok(call, 'Actual emitted reader entered wx.downloadFile');
    assert.equal(
      new URL(call.options.url).searchParams.get('purpose'),
      'management-preview',
    );
    assert.equal(
      call.options.header.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
    const file = `wxfile://tmp/category-emitted-${name}.png`;
    resident.set(file, png);
    call.headers(imageHeaders(png.length));
    call.success(file);
    call.complete();
    await drain();
    return file;
  }
  return {
    page,
    mount,
    state,
    clock,
    sessions,
    store,
    registry,
    transfer,
    resident,
    deleted,
    pickers,
    uploads,
    downloads,
    effects,
    contexts,
    scopeInputs,
    prepareInputs,
    recoveries,
    prepared,
    committed,
    choose,
    finishUpload,
    finishDownload,
    async close() {
      page.onUnload();
      await drain();
      stopWatch();
      Object.assign(systemClock, originalClock);
      assertPrivateProjection(page);
    },
  };
}

async function freezeReplacement(h) {
  tap(h.page, 'onOperation', { operation: 'set_category_override_scoped' });
  const key = `override:${iconCategory().id}:${managedCampus}`;
  tap(h.page, 'onIconChoice', { key, value: 'replace' });
  tap(h.page, 'onPrepare');
  await drain();
  assert.equal(h.page.data.iconFrozen, true, h.page.data.error);
  assert.equal(h.prepared.length, 0, 'Replacement cannot skip native upload');
  assert.equal(buttons(h.page, 'onIconChoice').length, 0);
  assert.equal(buttons(h.page, 'onIconUpload', { key }).length, 1);
  return key;
}

export async function runCategoryIconEmittedSmoke(t) {
  const globals = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: globalThis.wx,
  };
  try {
    await t.test(
      'emitted branches distinguish inherit, set(null), set(image) and explicit commit',
      async () => {
        for (const mode of ['inherit', 'set-empty', 'set-image']) {
          const h = harness(mode);
          try {
            await h.mount();
            const expected =
              mode === 'inherit'
                ? '继承共享基础'
                : mode === 'set-empty'
                  ? '本校园设置：明确无图'
                  : '本校园设置：已设置图标';
            assert.ok(visibleText(h.page).includes(`本校园图标：${expected}`));
            assert.equal(
              nodes(h.page).filter((n) => n.tag === 'image').length,
              0,
              'Metadata never becomes a remote image src',
            );
            tap(h.page, 'onOperation', {
              operation: 'set_category_override_scoped',
            });
            const key = `override:${iconCategory().id}:${managedCampus}`;
            assert.equal(
              h.page.data.iconSlots[0].selection,
              mode === 'set-image' ? 'keep' : mode,
            );
            for (const value of ['inherit', 'set-empty', 'replace'])
              assert.equal(
                buttons(h.page, 'onIconChoice', { key, value }).length,
                1,
              );
            assert.equal(
              buttons(h.page, 'onIconChoice', { key, value: 'clear' }).length,
              0,
            );
            assert.equal(
              buttons(h.page, 'onIconChoice', { key, value: 'keep' }).length,
              mode === 'inherit' ? 0 : 1,
            );
            const selection = mode === 'inherit' ? 'inherit' : 'set-empty';
            tap(h.page, 'onIconChoice', { key, value: selection });
            tap(h.page, 'onPrepare');
            await drain();
            assert.ok(h.page.data.preview, h.page.data.error);
            assert.deepEqual(
              h.prepared[0].payload.icon,
              selection === 'inherit'
                ? { mode: 'inherit' }
                : { mode: 'set', value: null },
            );
            assert.equal(h.committed.length, 0);
            tap(h.page, 'onClosePreview');
            await drain();
            assert.equal(buttons(h.page, 'onCommit').length, 0);
            assert.ok(h.store.load(accountId).command);
            tap(h.page, 'onPreparePending');
            await drain();
            tap(h.page, 'onCommit');
            invoke(h.page, 'onCommit');
            await drain();
            assert.equal(
              h.committed.length,
              1,
              'Repeated handler does not double commit',
            );
            assert.equal(h.store.load(accountId).command, null);
          } finally {
            await h.close();
          }
        }
      },
    );

    await t.test(
      'real download handlers render loading/image/unavailable and reject hidden or A→B→A generations',
      async () => {
        const h = harness('set-image');
        try {
          await h.mount();
          tap(h.page, 'onIconOpen', { value: 'effective' });
          await drain();
          assert.equal(h.downloads.length, 1);
          assert.ok(visibleText(h.page).includes('正在核验并读取当前图标'));
          invoke(h.page, 'onIconOpen', { value: 'base' });
          await drain();
          assert.equal(
            h.downloads.length,
            1,
            'Repeated action shares the current controller generation',
          );
          const src = await h.finishDownload();
          assert.equal(h.page.data.iconRead.state, 'image');
          assert.deepEqual(
            nodes(h.page)
              .filter((n) => n.tag === 'image')
              .map((n) => n.attrs.src),
            [src],
          );
          assert.equal(
            visibleText(h.page).includes('图标暂不可用（不是无图）'),
            false,
          );
          tap(h.page, 'onIconClose');
          await drain();
          assert.equal(h.resident.size, 0);
          assert.equal(
            nodes(h.page).filter((n) => n.tag === 'image').length,
            0,
          );
          tap(h.page, 'onIconOpen', { value: 'base' });
          await drain();
          h.downloads.at(-1).options.fail({ errMsg: 'synthetic unavailable' });
          h.downloads.at(-1).complete();
          await drain();
          assert.equal(h.page.data.iconRead.state, 'unavailable');
          assert.ok(visibleText(h.page).includes('图标暂不可用（不是无图）'));
          tap(h.page, 'onIconClose');
          tap(h.page, 'onIconOpen', { value: 'base' });
          await drain();
          const oldDownload = h.downloads.at(-1),
            oldController = h.page.controller;
          h.page.onHide();
          await drain();
          const hiddenCount = h.page.patches.length;
          await h.finishDownload(oldDownload, 'hidden-late');
          assert.equal(
            h.page.patches.length,
            hiddenCount,
            'Hidden native success cannot call setData',
          );
          assert.ok(oldDownload.aborted > 0);
          assert.equal(h.resident.size, 0, 'Late hidden bytes are removed');
          h.page.onShow();
          await drain();
          assert.notEqual(h.page.controller, oldController);
          const pendingDescriptor = deferred();
          h.state.descriptorHold = pendingDescriptor;
          tap(h.page, 'onIconOpen', { value: 'effective' });
          await drain();
          const count = h.downloads.length;
          const accountB = { ...wireCredentials('b'), accountId: iconId(950) };
          h.sessions.completeLogin(h.sessions.beginLogin(), accountB);
          h.sessions.completeLogin(
            h.sessions.beginLogin(),
            wireCredentials('c'),
          );
          h.page.onShow();
          await drain();
          assert.equal(h.page.data.loaded, true);
          const current = JSON.stringify(h.page.data),
            patchCount = h.page.patches.length;
          h.state.descriptorHold = null;
          pendingDescriptor.resolve();
          await drain();
          assert.equal(
            h.downloads.length,
            count,
            'Old A descriptor cannot allocate bytes after A→B→A',
          );
          assert.equal(JSON.stringify(h.page.data), current);
          assert.equal(
            h.page.patches.length,
            patchCount,
            'No old generation races a later setData',
          );
        } finally {
          await h.close();
        }
      },
    );

    for (const stage of ['scope', 'prepare']) {
      await t.test(
        `${stage} 429 continues the same emitted journal/context/keys through real upload`,
        async () => {
          const h = harness();
          try {
            h.state.limitStage = stage;
            h.state.limited = true;
            await h.mount();
            const key = await freezeReplacement(h);
            const original = h.store.load(accountId).uploads;
            tap(h.page, 'onIconUpload', { key });
            await drain();
            invoke(h.page, 'onIconUpload', { key });
            await drain();
            assert.equal(
              h.pickers.length,
              1,
              'Repeated handler cannot open a second chooser',
            );
            await h.choose();
            assert.match(visibleText(h.page), /限流.*等待.*继续原请求/);
            assert.match(visibleText(h.page), /不会延长.*5 分钟/);
            assert.equal(h.page.data.busy, false);
            assert.equal(h.resident.size, 0);
            const pending = h.store.load(accountId).uploads,
              member = pending.members[0];
            const sequence = h.state.sequence;
            assert.deepEqual(pending.identity, original.identity);
            assert.equal(pending.identityHash, original.identityHash);
            assert.equal(h.uploads.length, 0);
            h.clock.advance(60000);
            h.state.limited = false;
            tap(h.page, 'onRecover');
            await drain();
            assert.deepEqual(h.recoveries, [
              {
                requestId: member.scopeInput.clientRequestId,
                requestHash: categoryIconScopeRequestHash(member.scopeInput),
              },
            ]);
            tap(h.page, 'onIconUpload', { key });
            await drain();
            await h.choose();
            await h.finishUpload(false);
            assert.equal(
              h.page.data.busy,
              true,
              'Success is not native completion',
            );
            assert.equal(h.transfer.settled(accountId), false);
            assert.equal(h.resident.size, 1);
            const otherIO = h.registry.acquireTransfer();
            assert.throws(() => h.registry.acquireTransfer(), {
              kind: 'configuration',
            });
            otherIO();
            h.uploads.at(-1).options.complete();
            await drain();
            assert.equal(h.resident.size, 0);
            assert.equal(h.transfer.settled(accountId), true);
            const continued = h.store.load(accountId).uploads;
            assert.equal(continued.members[0].state, 'ready');
            assert.deepEqual(continued.identity, original.identity);
            assert.deepEqual(
              continued.members[0].scopeInput,
              member.scopeInput,
            );
            assert.equal(h.state.sequence, sequence);
            assert.equal(
              h.contexts.length,
              1,
              'No renewed context silently extends authority',
            );
            assert.ok(
              h.scopeInputs.every(
                (input) =>
                  categoryIconScopeRequestHash(input) ===
                  categoryIconScopeRequestHash(member.scopeInput),
              ),
            );
            if (stage === 'prepare')
              assert.deepEqual(h.prepareInputs[1], h.prepareInputs[0]);
            assert.equal(buttons(h.page, 'onIconUpload', { key }).length, 0);
            tap(h.page, 'onPreparePending');
            await drain();
            assert.ok(h.page.data.preview, h.page.data.error);
            assert.deepEqual(h.prepared[0].payload.icon, {
              mode: 'set',
              value: {
                mode: 'replace',
                assetId: iconId(803),
                uploadScopeId: iconId(800),
              },
            });
            assert.equal(
              h.committed.length,
              0,
              'Uploading an image never publishes it',
            );
          } finally {
            await h.close();
          }
        },
      );
    }

    await t.test(
      'expired rate-limited scope keeps its original request until explicit recovery and cancellation',
      async () => {
        const h = harness();
        try {
          h.state.limitStage = 'prepare';
          h.state.limited = true;
          await h.mount();
          const key = await freezeReplacement(h);
          tap(h.page, 'onIconUpload', { key });
          await drain();
          await h.choose();
          const pending = h.store.load(accountId).uploads,
            sequence = h.state.sequence;
          h.clock.advance(300001);
          h.state.limited = false;
          h.state.expired = true;
          tap(h.page, 'onRecover');
          await drain();
          tap(h.page, 'onIconUpload', { key });
          await drain();
          await h.choose();
          assert.match(visibleText(h.page), /原请求须先确认关闭/);
          assert.deepEqual(h.store.load(accountId).uploads, pending);
          assert.equal(h.state.sequence, sequence);
          assert.equal(h.contexts.length, 1);
          assert.equal(h.scopeInputs.length, 1);
          assert.deepEqual(h.prepareInputs[1], h.prepareInputs[0]);
          assert.equal(h.uploads.length, 0);
          assert.equal(h.resident.size, 0);
          tap(h.page, 'onRequestCancel');
          assert.equal(buttons(h.page, 'onConfirmCancel').length, 1);
          assert.ok(
            h.store.load(accountId).uploads,
            'Opening confirmation is not cancellation',
          );
          tap(h.page, 'onConfirmCancel');
          await drain();
          assert.equal(
            h.store.load(accountId).uploads,
            null,
            h.page.data.error,
          );
          assert.ok(h.effects.includes('cancel-scope'));
          assert.equal(h.state.sequence, sequence);
          tap(h.page, 'onRefresh');
          await drain();
          assert.equal(h.page.data.loaded, true);
          assert.equal(
            h.contexts.length,
            2,
            'New authority is obtained only after the original closes',
          );
        } finally {
          await h.close();
        }
      },
    );

    await t.test(
      'emitted Page respects one shared 2 IO / 4 lease / 10 MiB native budget',
      async () => {
        const h = harness();
        try {
          await h.mount();
          const key = await freezeReplacement(h);
          const original = h.store.load(accountId).uploads;
          const assertBlocked = async () => {
            const picks = h.pickers.length;
            tap(h.page, 'onIconUpload', { key });
            await drain();
            assert.equal(
              h.pickers.length,
              picks,
              'Shared owners block native allocation',
            );
            assert.equal(h.page.data.busy, false);
            assert.deepEqual(h.store.load(accountId).uploads, original);
          };
          const io = [
            h.registry.acquireTransfer(),
            h.registry.acquireTransfer(),
          ];
          await assertBlocked();
          io.forEach((release) => release());
          const leases = [];
          for (let i = 0; i < 4; i++) {
            const file = `wxfile://tmp/shared-owner-${i}.png`;
            h.resident.set(file, png);
            leases.push(
              h.registry.adopt(
                file,
                png.length,
                {},
                h.sessions.snapshot(),
                h.registry.reserve(png.length),
              ),
            );
          }
          assert.equal(h.registry.capacityAvailable, false);
          await assertBlocked();
          await Promise.all(leases.map((file) => h.registry.release(file)));
          const bytes = [
            h.registry.reserve(5 * MiB),
            h.registry.reserve(5 * MiB),
          ];
          assert.equal(
            h.registry.capacityAvailable,
            true,
            'Byte budget is independent from four leases',
          );
          await assertBlocked();
          bytes.forEach((reservation) =>
            h.registry.releaseReservation(reservation),
          );
          assert.equal(h.resident.size, 0);
          tap(h.page, 'onIconUpload', { key });
          await drain();
          await h.choose();
          const upload = h.uploads.at(-1);
          assert.ok(
            upload,
            'The real native upload is in flight before hiding',
          );
          h.page.onHide();
          await drain();
          const count = h.page.patches.length;
          assert.ok(upload.aborted > 0);
          assert.equal(h.transfer.settled(accountId), false);
          assert.equal(
            h.resident.size,
            1,
            'Hide/abort retains bytes until the real complete callback',
          );
          const remaining = h.registry.acquireTransfer();
          assert.throws(() => h.registry.acquireTransfer(), {
            kind: 'configuration',
          });
          remaining();
          upload.options.complete();
          await drain();
          assert.equal(h.resident.size, 0);
          assert.equal(
            h.page.patches.length,
            count,
            'Aborted upload cannot race hidden Page setData',
          );
          assert.equal(h.transfer.settled(accountId), true);
          assert.equal(
            h.store.load(accountId).uploads.members[0].state,
            'pending',
            'A hidden generation does not mark the original member ready',
          );
        } finally {
          await h.close();
        }
      },
    );
  } finally {
    Object.assign(globalThis, globals);
  }
}
