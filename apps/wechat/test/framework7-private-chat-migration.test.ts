import { runtimeIdentityPredecessor } from './reviewed-reading-runtime-identity-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { Receipt } from '../src/messaging/contract';
import type { PrivateMessageImages } from '../src/messaging/image-runtime';
import type { MessagingRuntime } from '../src/messaging/runtime';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import { deferred } from './helpers';
import {
  accountId,
  conversationId,
  harness,
  messageId,
  otherId,
  receipt,
  requestId,
  sendIntent,
} from './messaging-helpers';

const root = path.resolve(__dirname, '..');
const requireNative = createRequire(__filename);
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, extension = 'wxml') =>
  read(`src/pages/${page}/${page}.${extension}`);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-private-chat-before-actions.json'),
) as Record<
  string,
  { sourceSha256: string; typescriptSha256: string; actions: Action[] }
>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-private-chat-before-protected.json'),
) as Record<string, string>;
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      /^wx:(if|elif|else|for|for-item|for-index|key)$/.test(key),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    ...(node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : []),
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scopes),
    ),
  ];
}
for (const [page, before] of Object.entries(baseline)) {
  test(`${page}: all original actions retain exact guard ancestry, constraints, identifiers and navigation`, () => {
    const current = actions(parse(source(page)));
    assert.equal(current.length, before.actions.length);
    for (const original of before.actions) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === original.tag &&
          JSON.stringify(candidate.scopes) ===
            JSON.stringify(original.scopes) &&
          Object.entries(original.attrs).every(
            ([key, value]) => candidate.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(original));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    assert.equal(hash(source(page, 'ts')), before.typescriptSha256);
  });
  test(`${page}: registered isolated native components do not replace native permissions, text or media`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-button'));
    for (const node of nodes.filter((candidate) =>
      candidate.tag.startsWith('wu-f7-'),
    )) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-list-item') {
        assert.equal(node.attrs.link, '{{true}}');
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (child) =>
                /^(button|textarea|input|navigator|wu-f7-button)$/.test(
                  child.tag,
                ) ||
                Object.keys(child.attrs).some((key) =>
                  /^(bind|catch)/.test(key),
                ),
            ),
        );
      }
    }
    assert.doesNotMatch(
      source(page),
      /<web-view|<wu-f7-(sheet|dialog|actions)|bind(?:confirm|blur|focus|change)="onSend|已送达|对方已读|正在输入|avatarUrl/,
    );
    assert.match(source(page, 'wxss'), /framework7-ios\.wxss/);
  });
}
test('private chat preserves all 124 controller/runtime/component/accepted-layout boundaries', () => {
  assert.equal(Object.keys(protectedFiles).length, 124);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(
      hash(
        runtimeIdentityPredecessor(file, Buffer.from(read(file))).toString(
          'utf8',
        ),
      ),
      expected,
      file,
    );
});
test('native longpress anchors, keyboard textarea, image and accessibility expansion controls remain native', () => {
  for (const [page, before] of Object.entries(baseline)) {
    const nodes = flatten(parse(source(page)));
    for (const original of before.actions.filter(
      (node) =>
        node.tag === 'textarea' ||
        node.tag === 'navigator' ||
        'bindlongpress' in node.attrs ||
        'aria-expanded' in node.attrs ||
        ['onMessageMenu', 'onShowImage'].includes(node.attrs.bindtap ?? ''),
    )) {
      assert.ok(
        nodes.some(
          (node) =>
            node.tag === original.tag &&
            Object.entries(original.attrs).every(
              ([key, value]) => node.attrs[key] === value,
            ),
        ),
        JSON.stringify(original),
      );
    }
  }
  assert.match(source('private-message-detail'), /id="message-{{item.id}}"/);
  assert.match(
    source('private-message-detail'),
    /scroll-into-view="{{anchor}}"/,
  );
});

interface PageOwner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, done?: () => void): void;
}
interface Control {
  press(): boolean;
  detach(): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Control;
  sync(): void;
  lifecycle(name: string): void;
  emissions: unknown[];
}
const { createNativePressBridge } = requireNative(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: {
    page: PageOwner;
    pageFile: string;
    dist: string;
    extension?: string;
  }): Bridge;
};
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
function invoke(page: PageOwner, handler: string, value?: unknown) {
  assert.equal(typeof page[handler], 'function');
  return (page[handler] as (value?: unknown) => unknown).call(page, value);
}
function mount(suffix: string, runtime: MessagingRuntime) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    wx: globals.wx,
    getApp: globals.getApp,
  };
  const observers: {
    disconnected: boolean;
    callback?: (value: { intersectionRatio: number }) => void;
  }[] = [];
  const completions: (() => void)[] = [];
  let defer = false;
  let page!: PageOwner;
  Object.assign(globals, {
    getApp: () => ({ community: { messaging: runtime } }),
    wx: {
      createIntersectionObserver() {
        const observer: (typeof observers)[number] = { disconnected: false };
        observers.push(observer);
        return {
          relativeToViewport() {
            return this;
          },
          observe(
            _selector: string,
            callback: NonNullable<typeof observer.callback>,
          ) {
            observer.callback = callback;
          },
          disconnect() {
            observer.disconnected = true;
          },
        };
      },
    },
    Page(definition: PageOwner) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(patch, done) {
          Object.assign(this.data, patch);
          if (done) {
            if (defer) completions.push(done);
            else done();
          }
        },
      };
    },
  });
  const file = path.join(
    root,
    `src/pages/private-message-${suffix}/private-message-${suffix}`,
  );
  delete requireNative.cache[requireNative.resolve(`${file}.ts`)];
  requireNative(`${file}.ts`);
  const bridge = createNativePressBridge({
    page,
    pageFile: file,
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  if (page.onLoad) invoke(page, 'onLoad', { conversationId });
  invoke(page, 'onShow');
  const native = (handler: string, value?: unknown) => {
    assert.ok(
      flatten(parse(readFileSync(`${file}.wxml`, 'utf8'))).some((node) =>
        Object.entries(node.attrs).some(
          ([key, val]) => /^bind(?!:)/.test(key) && val === handler,
        ),
      ),
      `actual native binding ${handler}`,
    );
    invoke(page, handler, value);
    bridge.sync();
  };
  return {
    page,
    bridge,
    native,
    observers,
    defer(value = true) {
      defer = value;
    },
    complete() {
      while (completions.length) completions.shift()!();
    },
    press(handler: string, dataset: Record<string, unknown> = {}) {
      bridge.sync();
      const control = bridge.capture(handler, dataset);
      const result = control.press();
      control.detach();
      bridge.sync();
      return result;
    },
    hide() {
      bridge.lifecycle('hide');
      invoke(page, 'onHide');
    },
    close() {
      defer = false;
      bridge.lifecycle('detach');
      invoke(page, 'onUnload');
      while (completions.length) completions.shift()!();
      Object.assign(globals, previous);
    },
  };
}

test('source-ts bridge executes real registration and rejects path-like or unknown entrypoint extensions', () => {
  const h = harness(),
    f = mount('list', h.runtime);
  try {
    for (const extension of ['', '../js', 'mjs', '.ts', 'ts/js'])
      assert.throws(
        () =>
          createNativePressBridge({
            page: f.page,
            pageFile: path.join(
              root,
              'src/pages/private-message-list/private-message-list',
            ),
            dist: path.join(root, 'src'),
            extension,
          }),
        /extension must be js or ts/,
      );
  } finally {
    f.close();
  }
});

test('real private-list Button events preserve row identity, cancellation, unread and account teardown', async () => {
  const h = harness(),
    f = mount('list', h.runtime);
  try {
    await flush();
    assert.equal(f.page.data.unread, 1);
    assert.equal(f.press('onToggleRow', { id: conversationId }), true);
    assert.equal(f.press('onHideConversation', { id: conversationId }), true);
    assert.equal(f.page.data.confirmHide, conversationId);
    assert.equal(h.applied.length, 0);
    const stale = f.bridge.capture('onConfirmHide');
    f.press('onDismiss');
    assert.equal(stale.press(), false);
    assert.equal(h.applied.length, 0);
    f.press('onToggleRow', { id: conversationId });
    f.press('onHideConversation', { id: conversationId });
    f.press('onConfirmHide');
    await flush();
    assert.deepEqual(h.applied[0], {
      operation: 'hide',
      conversationId,
      clientRequestId: requestId,
    });
    assert.equal(
      f.page.data.unread,
      1,
      'hiding never invents an unread acknowledgement',
    );
    h.sessions.logout();
    assert.deepEqual(f.page.data.uiItems, []);
    assert.equal(f.page.data.uiRowMenu, '');
    assert.ok(f.bridge.emissions.length >= 5);
  } finally {
    f.close();
  }
});

test('real send Button requires explicit activation; stopping or leaving retains the immutable original despite a late receipt', async () => {
  const h = harness(),
    pending = deferred<Receipt>();
  h.gateway.apply = async (intent) => {
    h.applied.push(intent);
    return pending.promise;
  };
  const f = mount('detail', h.runtime);
  try {
    await flush();
    f.native('onText', { detail: { value: '  输入不是发送  ' } });
    f.native('onKeyboardHeight', { detail: { height: 280 } });
    assert.equal(h.applied.length, 0);
    assert.equal(f.page.data.text, '  输入不是发送  ');
    const send = f.bridge.capture('onSend');
    assert.equal(send.press(), true);
    assert.equal(send.press(), false);
    await flush();
    assert.equal(h.applied.length, 1);
    const original = h.runtime.pending.load(accountId)!;
    assert.ok(original);
    assert.equal(
      f.press('onSend'),
      false,
      'pending/busy component emits nothing',
    );
    assert.equal(f.press('onCancel'), true);
    assert.deepEqual(h.runtime.pending.load(accountId), original);
    f.hide();
    assert.equal(f.page.data.uiKeyboardHeight, 0);
    assert.equal(f.page.data.text, '');
    f.native('onKeyboardHeight', { detail: { height: 400 } });
    assert.equal(f.page.data.uiKeyboardHeight, 0);
    pending.resolve(receipt(h.applied[0]!));
    await flush();
    assert.deepEqual(h.runtime.pending.load(accountId), original);
    assert.deepEqual(f.page.data.messages, []);
    assert.equal(h.applied.length, 1);
    assert.equal(h.clock.timers, 0);
  } finally {
    f.close();
  }
});

test('real recovery ListItem queries before retry and repeats only the original journal identity and text', async () => {
  const h = harness();
  h.runtime.pending.freeze({
    version: 1,
    accountId,
    intent: sendIntent('不可替换的原文'),
  });
  h.gateway.receipt = async (id) => {
    h.queried.push(id);
    throw new ClientError('business', 'missing', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  const f = mount('recovery', h.runtime);
  try {
    assert.equal(f.press('onReceipt'), true);
    await flush();
    assert.equal(h.applied.length, 0);
    assert.deepEqual(h.queried, [requestId]);
    f.press('onToggleActions');
    assert.equal(f.press('onRetry'), true);
    await flush();
    assert.deepEqual(h.queried, [requestId, requestId]);
    assert.deepEqual(h.applied, [sendIntent('不可替换的原文')]);
    assert.equal(h.runtime.pending.load(accountId), null);
    assert.equal(f.page.data.pending, false);
  } finally {
    f.close();
  }
});

test('real recovery confirmation dismissal and hidden late cancellation cannot clear the original request', async () => {
  const h = harness();
  const original = h.runtime.pending.freeze({
    version: 1,
    accountId,
    intent: sendIntent(),
  });
  const pending = deferred<Awaited<ReturnType<typeof h.gateway.cancel>>>();
  let cancelled = 0;
  h.gateway.cancel = async () => {
    cancelled++;
    return pending.promise;
  };
  const f = mount('recovery', h.runtime);
  try {
    f.press('onToggleActions');
    f.press('onRequestCancel');
    const stale = f.bridge.capture('onConfirmCancel');
    f.press('onDismissCancel');
    assert.equal(stale.press(), false);
    assert.equal(cancelled, 0);
    f.press('onToggleActions');
    f.press('onRequestCancel');
    f.press('onConfirmCancel');
    await flush();
    assert.equal(cancelled, 1);
    f.hide();
    pending.resolve({
      outcome: 'cancelled',
      receipt: {
        requestId,
        operation: 'send',
        outcome: 'rejected',
        code: 'DM_COMMAND_CANCELLED',
      },
    });
    await flush();
    assert.deepEqual(h.runtime.pending.load(accountId), original);
    assert.equal(f.page.data.confirmCancel, false);
    assert.equal(f.page.data.draftText, '');
  } finally {
    f.close();
  }
});

test('real rejected-draft Button keeps native text editing nonautomatic and uses a distinct explicitly sent request', async () => {
  const h = harness();
  h.runtime.pending.freeze({
    version: 1,
    accountId,
    intent: sendIntent('被拒绝的合成原文'),
  });
  h.gateway.receipt = async () => ({
    requestId,
    operation: 'send',
    outcome: 'rejected',
    code: 'CONTENT_REJECTED',
  });
  const runtime = { ...h.runtime, newRequestId: async () => otherId };
  const f = mount('recovery', runtime);
  try {
    f.press('onReceipt');
    await flush();
    assert.equal(f.page.data.canReedit, true);
    f.press('onReedit');
    f.native('onDraftText', { detail: { value: '  重新编辑的合成草稿  ' } });
    assert.equal(h.applied.length, 0);
    assert.equal(f.page.data.draftText, '  重新编辑的合成草稿  ');
    f.press('onSendDraft');
    await flush();
    assert.equal(h.applied.length, 1);
    assert.equal(h.applied[0]!.clientRequestId, otherId);
    assert.equal(h.applied[0]!.operation, 'send');
    f.hide();
    assert.equal(f.page.data.draftText, '');
  } finally {
    f.close();
  }
});

test('real close and confirm Button events keep reads paused through current render, stacked menus and stale hide callbacks', async () => {
  const h = harness(),
    f = mount('detail', h.runtime);
  try {
    await flush();
    const controller = f.page.controller as {
      observeMessage(id: string): void;
    };
    const seen: string[] = [];
    controller.observeMessage = (id) => seen.push(id);
    const first = f.observers[f.observers.length - 1]!;
    const count = f.observers.length;
    f.defer();
    f.native('onTogglePanel', {
      currentTarget: { dataset: { panel: 'conversation' } },
    });
    assert.equal(first.disconnected, true);
    first.callback?.({ intersectionRatio: 1 });
    f.complete();
    assert.deepEqual(seen, []);
    assert.equal(f.observers.length, count);
    f.press('onAction', { kind: 'block' });
    f.complete();
    assert.ok(f.page.data.confirm);
    assert.equal(f.observers.length, count);
    f.press('onDismiss');
    assert.equal(
      f.observers.length,
      count,
      'no read before closed render commits',
    );
    f.complete();
    assert.equal(f.observers.length, count + 1);
    const resumed = f.observers[f.observers.length - 1]!;
    resumed.callback?.({ intersectionRatio: 1 });
    assert.deepEqual(seen, [messageId]);
    seen.length = 0;
    f.native('onMessageMenu', {
      currentTarget: { dataset: { id: messageId } },
    });
    f.complete();
    resumed.callback?.({ intersectionRatio: 1 });
    assert.deepEqual(seen, []);
    f.press('onCloseMenus');
    f.hide();
    f.complete();
    assert.equal(f.observers.length, count + 1);
    assert.deepEqual(seen, []);
    assert.equal(h.applied.length, 0);
  } finally {
    f.close();
  }
});

test('real image-picker Button suspends reads; native cancellation and unload cannot send or revive hidden observation', async () => {
  const h = harness(),
    selected = deferred<never>();
  let selections = 0,
    sends = 0;
  h.runtime.images = {
    pending: { load: () => null },
    select: async () => {
      selections++;
      return selected.promise;
    },
    sendSelected: async () => {
      sends++;
    },
    release: async () => undefined,
    upload: { remove: async () => undefined },
  } as unknown as PrivateMessageImages;
  const f = mount('detail', h.runtime);
  try {
    await flush();
    const seen: string[] = [];
    (f.page.controller as { observeMessage(id: string): void }).observeMessage =
      (id) => seen.push(id);
    const first = f.observers[f.observers.length - 1]!;
    f.native('onTogglePanel', {
      currentTarget: { dataset: { panel: 'media' } },
    });
    f.press('onImageAlbum');
    await flush();
    const before = f.observers.length;
    assert.equal(selections, 1);
    assert.equal(
      (f.page.controller as { keepPicker: boolean }).keepPicker,
      true,
    );
    first.callback?.({ intersectionRatio: 1 });
    for (const observer of f.observers) {
      assert.equal(observer.disconnected, true);
      observer.callback?.({ intersectionRatio: 1 });
    }
    assert.deepEqual(seen, []);
    assert.equal(f.observers.length, before);
    f.hide();
    selected.reject(new ClientError('cancelled', 'picker dismissed'));
    await flush();
    assert.equal(sends, 0);
    assert.equal(h.applied.length, 0);
    assert.equal(f.observers.length, before);
    assert.equal(f.page.data.uiKeyboardHeight, 0);
  } finally {
    f.close();
  }
});

test('23 synthetic source fixtures cover native chat, occlusion and immutable-request recovery without private data or device claims', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-private-chat-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  const { render } = requireNative('../scripts/smoke-ratings.mjs') as {
    render(
      nodes: (PresentationNode | string)[],
      scope: object,
      templates: object,
    ): unknown;
  };
  assert.equal(fixtures.length, 23);
  assert.deepEqual(
    [...new Set(fixtures.map((fixture) => fixture.page))].sort(),
    Object.keys(baseline).sort(),
  );
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^framework7-private-chat-/);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|wxfile:\/\/|accessToken|refreshToken|phoneNumber|studentNumberValue/,
    );
    const rendered = JSON.stringify(
      render(parse(source(fixture.page)).children, fixture.patch, {}),
    );
    for (const text of fixture.expectedText)
      assert.ok(rendered.includes(text), `${fixture.id}: ${text}`);
  }
});
