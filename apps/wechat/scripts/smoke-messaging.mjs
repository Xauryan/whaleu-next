import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);
/** Native Page handlers and actual WXML synthetic acceptance. No device/provider claim. */
export async function smokeMessaging({
  app,
  dist,
  extension = 'js',
  flush,
  conversationId,
  messageId,
}) {
  const globals = {
    Page: globalThis.Page,
    wx: globalThis.wx,
    getApp: globalThis.getApp,
  };
  const pages = [];
  let clipboard = '';
  let stoppedPullDown = 0;
  let observed;
  const instantiate = (name, query = {}) => {
    let page;
    globalThis.Page = (definition) => {
      page = { ...definition, data: structuredClone(definition.data) };
      page.setData = (patch, callback) => {
        Object.assign(page.data, patch);
        callback?.();
      };
    };
    const filename = path.join(
      dist,
      `pages/private-message-${name}/private-message-${name}.${extension}`,
    );
    delete require.cache[require.resolve(filename)];
    require(filename);
    assert.ok(page);
    page.onLoad?.(query);
    pages.push(page);
    return page;
  };
  const shown = (name, page) =>
    render(
      parse(
        readFileSync(
          path.join(
            dist,
            `pages/private-message-${name}/private-message-${name}.wxml`,
          ),
          'utf8',
        ),
      ).children,
      page.data,
      {},
    );
  globalThis.getApp = () => app;
  globalThis.wx = {
    ...globals.wx,
    stopPullDownRefresh: () => {
      stoppedPullDown++;
    },
    navigateTo: ({ success }) => success(),
    setClipboardData: ({ data, success }) => {
      clipboard = data;
      success();
    },
    createIntersectionObserver: () => ({
      relativeToViewport() {
        return this;
      },
      observe(_selector, callback) {
        observed = callback;
      },
      disconnect() {
        observed = undefined;
      },
    }),
  };
  try {
    const list = instantiate('list');
    list.onShow();
    await flush();
    assert.equal(list.data.loaded, true);
    assert.equal(list.data.unread, 1);
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(
            dist,
            'pages/private-message-list/private-message-list.json',
          ),
          'utf8',
        ),
      ).enablePullDownRefresh,
      true,
    );
    await list.onPullDownRefresh();
    assert.equal(stoppedPullDown, 1);
    assert.equal(list.data.loaded, true);
    assert.match(JSON.stringify(shown('list', list)), /我的私信/);
    list.onHideConversation({
      currentTarget: { dataset: { id: conversationId } },
    });
    assert.equal(list.data.confirmHide, conversationId);
    list.onDismiss();
    assert.equal(list.data.confirmHide, null);
    list.onHide();
    assert.equal(list.data.items.length, 0);
    await list.onPullDownRefresh();
    assert.equal(
      stoppedPullDown,
      2,
      'hidden page still stops the native refresh spinner',
    );
    const detail = instantiate('detail', { conversationId });
    detail.onShow();
    await flush();
    assert.equal(detail.data.loaded, true);
    assert.equal(detail.data.messages[0].id, messageId);
    observed?.({ intersectionRatio: 1 });
    detail.onCopy({ currentTarget: { dataset: { id: messageId } } });
    assert.ok(clipboard);
    detail.onText({ detail: { value: '原生文字' } });
    detail.onSend();
    detail.onSend();
    await flush();
    assert.equal(detail.data.text, '');
    assert.match(JSON.stringify(shown('detail', detail)), /私信/);
    detail.onAction({ currentTarget: { dataset: { kind: 'block' } } });
    assert.ok(detail.data.confirm);
    detail.onDismiss();
    assert.equal(detail.data.confirm, null);
    detail.onHide();
    assert.equal(detail.data.messages.length, 0);
    assert.equal(detail.data.text, '');
    const recovery = instantiate('recovery');
    recovery.onShow();
    assert.equal(recovery.data.pending, false);
    assert.match(JSON.stringify(shown('recovery', recovery)), /确认原请求/);
    recovery.onHide();
    const messaging = app.community.messaging;
    const accountId = messaging.sessions.snapshot().credentials.accountId;
    messaging.pending.freeze({
      version: 1,
      accountId,
      intent: {
        operation: 'send',
        clientRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        conversationId,
        text: '退出前未确认的合成原文',
      },
    });
    messaging.pending.scrubBodies();
    recovery.onShow();
    assert.equal(recovery.data.pending, true);
    assert.equal(recovery.data.pendingText, '');
    assert.equal(recovery.data.canRetry, false);
    recovery.onRequestCancel();
    assert.match(JSON.stringify(shown('recovery', recovery)), /迟到请求/);
    recovery.onDismissCancel();
    assert.ok(messaging.pending.load(accountId));
    recovery.onRequestCancel();
    recovery.onConfirmCancel();
    await flush();
    assert.equal(recovery.data.status, '原请求已安全取消');
    assert.equal(messaging.pending.load(accountId), null);
    recovery.onUnload();
  } finally {
    for (const page of pages) page.onUnload?.();
    Object.assign(globalThis, globals);
  }
}
