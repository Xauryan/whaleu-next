/** Synthetic platform/provider callbacks against actual emitted Pages and WXML.
 * This bounded render model does not establish DevTools or device acceptance. */
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
const { setup, spaceId, requestId } = require('./community-helpers.ts');
const { wireCredentials } = require('./identity-helpers.ts');
const { SessionStore } = emitted('auth/session');
const { ClientError } = emitted('api/errors');
const { ApiClient } = emitted('api/client');
const { WechatTransport } = emitted('platform/wechat');
const { systemClock } = emitted('platform/clock');
const { batchPublicationReference } = emitted('media/batch-publication');
const { ComposeController } = emitted('pages/community-compose/controller');
const { PhoneBindingController } = emitted('verification/phone-binding');
const drain = async () => {
  for (let i = 0; i < 250; i++) await Promise.resolve();
};
const flatten = (nodes) =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
  );
export function mountEmittedPage(name, app, wx) {
  let page;
  globalThis.Page = (value) => {
    page = value;
  };
  globalThis.getApp = () => app;
  globalThis.wx = wx;
  const entry = path.join(dist, `pages/${name}/${name}.js`);
  delete require.cache[require.resolve(entry)];
  require(entry);
  assert.ok(page, 'Actual emitted entrypoint calls Page');
  page.patches = [];
  page.setData = (patch, callback) => {
    page.patches.push(structuredClone(patch));
    page.data = { ...page.data, ...patch };
    callback?.();
  };
  const templates = {};
  const visited = new Set();
  function readTree(file) {
    assert.ok(file.startsWith(`${dist}${path.sep}`));
    if (visited.has(file)) return;
    visited.add(file);
    const tree = parse(readFileSync(file, 'utf8'));
    for (const node of flatten(tree.children)) {
      if (typeof node === 'string') continue;
      if (node.tag === 'import')
        readTree(path.resolve(path.dirname(file), node.attrs.src));
      if (node.tag === 'template' && node.attrs.name)
        templates[node.attrs.name] = node;
    }
    return tree;
  }
  const tree = readTree(path.join(dist, `pages/${name}/${name}.wxml`));
  const nodes = () =>
    flatten(
      render(
        tree.children.filter(
          (node) =>
            typeof node === 'string' ||
            node.tag !== 'template' ||
            !node.attrs.name,
        ),
        page.data,
        templates,
      ),
    );
  const find = (binding, handler, dataset = {}) =>
    nodes().find(
      (node) =>
        typeof node !== 'string' &&
        node.attrs[binding] === handler &&
        Object.entries(dataset).every(
          ([key, value]) => node.attrs[`data-${key}`] === String(value),
        ),
    );
  const button = (binding, handler) =>
    nodes().find(
      (node) =>
        typeof node !== 'string' &&
        node.tag === 'button' &&
        node.attrs[binding] === handler,
    );
  const event = (binding, handler, detail = {}, dataset = {}) => {
    const node = find(binding, handler, dataset);
    assert.ok(node, `Actual WXML renders ${binding}=${handler}`);
    assert.notEqual(node.attrs.disabled, 'true', `${handler} must be enabled`);
    assert.equal(typeof page[handler], 'function');
    page[handler]({ detail, currentTarget: { dataset } });
  };
  const tap = (handler, dataset = {}) => event('bindtap', handler, {}, dataset);
  return { page, button, tap, nodes, event };
}
export async function runTextReviewEmittedSmoke(t) {
  const previous = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: globalThis.wx,
  };
  try {
    await t.test(
      'pending review renders explicit query, retry and server-confirmed cancellation handlers',
      async () => {
        const seed = setup();
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), wireCredentials());
        let reviews = 0,
          publications = 0,
          cancellations = 0;
        Object.assign(seed.gateway, {
          submitReview: async (attempt) => {
            reviews++;
            return {
              requestId: attempt.payload.clientRequestId,
              operation: attempt.operation,
              status: 'pending',
            };
          },
          reviewStatus: async (attempt) => ({
            requestId: attempt.payload.clientRequestId,
            operation: attempt.operation,
            status: 'pending',
          }),
          receipt: async () => {
            throw new ClientError('http', 'Absent', {
              httpStatus: 404,
              serverCode: 'REQUEST_NOT_FOUND',
            });
          },
          publishPost: async () => {
            publications++;
            assert.fail('Pending review cannot publish');
          },
          cancelReview: async (attempt) => {
            cancellations++;
            return {
              requestId: attempt.payload.clientRequestId,
              operation: attempt.operation,
              outcome: 'cancelled',
              intentHash: batchPublicationReference(attempt).intentHash,
            };
          },
        });
        const runtime = { ...seed.runtime, sessions };
        const h = mountEmittedPage(
          'community-compose',
          { community: runtime },
          {},
        );
        try {
          h.page.onLoad({ spaceId, category: 'discussion' });
          h.page.onShow();
          await drain();
          assert.ok(h.page.controller instanceof ComposeController);
          h.page.controller.setAuthorMode('named');
          h.page.controller.setAllowAnonymousDm(false);
          h.page.onText({ detail: { value: 'Emitted review exact body' } });
          h.tap('onSubmit');
          await drain();
          assert.equal(h.page.data.reviewStatus, 'pending', h.page.data.error);
          assert.equal(h.page.data.frozen, true);
          assert.equal(reviews, 1);
          assert.ok(h.button('bindtap', 'onReceipt'));
          assert.ok(h.button('bindtap', 'onRetry'));
          assert.ok(h.button('bindtap', 'onCancelReview'));
          h.tap('onRetry');
          await drain();
          assert.equal(publications, 0);
          h.tap('onCancelReview');
          await drain();
          assert.equal(cancellations, 1);
          assert.equal(runtime.pending.load(seed.accountId), null);
          assert.equal(h.page.data.text, 'Emitted review exact body');
          assert.equal(h.page.data.canSubmit, false);
        } finally {
          h.page.onUnload();
        }
      },
    );
    await t.test('feed popup renders explicitly bound template fields', () => {
      const h = mountEmittedPage('community-feed', {}, {});
      assert.ok(!h.button('bindtap', 'onCloseAnnouncement'));
      h.page.setData({
        announcementPopup: {
          popup: {
            title: 'Synthetic popup title',
            bodyText: 'Synthetic popup body',
            versionLabel: '',
            announcementDate: null,
            media: { status: 'unavailable' },
          },
          status: '',
          error: '',
        },
      });
      assert.ok(h.button('bindtap', 'onCloseAnnouncement'));
      assert.ok(
        h
          .nodes()
          .filter((node) => typeof node === 'string')
          .join('')
          .includes('Synthetic popup body'),
      );
      h.page.setData({
        announcementPopup: { popup: null, status: '', error: '' },
      });
      assert.ok(!h.button('bindtap', 'onCloseAnnouncement'));
    });
    await t.test(
      'getPhoneNumber emitted event sends an accepted code once and cancellation sends none',
      async () => {
        const sessions = new SessionStore(),
          storage = new Map(),
          calls = [];
        sessions.completeLogin(sessions.beginLogin(), wireCredentials());
        const wx = {
          getStorageSync: (key) => storage.get(key),
          setStorageSync: (key, value) =>
            storage.set(key, structuredClone(value)),
          removeStorageSync: (key) => storage.delete(key),
          request: (options) => {
            calls.push({
              path: new URL(options.url).pathname,
              body: options.data,
            });
            queueMicrotask(() =>
              options.success({
                statusCode: 200,
                header: {},
                data: {
                  requestId,
                  state: options.url.endsWith('/authorize')
                    ? 'verified'
                    : 'reserved',
                },
              }),
            );
            return { abort() {} };
          },
        };
        const api = new ApiClient(
          'https://emitted-phone.invalid',
          new WechatTransport(wx, systemClock),
          sessions,
          { refresh: async () => sessions.snapshot() },
        );
        const h = mountEmittedPage(
          'phone-binding',
          {
            identity: { sessions, api },
            community: { newRequestId: async () => requestId },
          },
          wx,
        );
        try {
          h.page.onShow();
          await drain();
          assert.ok(h.page.phone instanceof PhoneBindingController);
          h.tap('onPrepare');
          await drain();
          assert.equal(h.page.data.phase, 'reserved');
          const button = h.button('bindgetphonenumber', 'onPhone');
          assert.ok(button);
          assert.equal(button.attrs['open-type'], 'getPhoneNumber');
          const before = calls.length;
          h.page[button.attrs.bindgetphonenumber]({
            detail: { errMsg: 'getPhoneNumber:fail user deny' },
          });
          await drain();
          assert.equal(
            calls.length,
            before,
            'Denied authorization never transmits a provider code',
          );
          const code = 'synthetic-emitted-provider-code';
          h.page[button.attrs.bindgetphonenumber]({
            detail: { errMsg: 'getPhoneNumber:ok', code },
          });
          await drain();
          const sent = calls.filter((call) => call.path.endsWith('/authorize'));
          assert.equal(sent.length, 1);
          assert.deepEqual(sent[0].body, {
            code,
            consent: 'wechat-phone-verification-v1',
          });
          assert.equal(h.page.data.phase, 'verified');
          assert.equal(
            JSON.stringify([...storage.values()]).includes(code),
            false,
          );
          assert.equal(JSON.stringify(h.page.patches).includes(code), false);
        } finally {
          h.page.onUnload();
        }
      },
    );
  } finally {
    Object.assign(globalThis, previous);
  }
}
