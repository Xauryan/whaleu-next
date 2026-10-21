import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import {
  privateMessageRows,
  privateMessageTime,
} from '../src/pages/private-message-detail/presentation';
import {
  conversationId,
  harness,
  message,
  messageId,
} from './messaging-helpers';

const source = (page: string, extension = 'wxml') =>
  readFileSync(
    path.join(__dirname, '../src/pages', page, `${page}.${extension}`),
    'utf8',
  );
type Action = { tag: string; attrs: Record<string, string> };
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/private-chat-action-inventory.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
function actions(template: string): Action[] {
  return [...template.matchAll(/<([\w-]+)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g)].map(
    (match) =>
      normalizeFramework7ActionNode({
        tag: match[1]!,
        attrs: Object.fromEntries(
          [...match[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map((attr) => [
            attr[1]!,
            attr[2]!,
          ]),
        ),
        children: [],
      }),
  );
}
for (const [page, original] of Object.entries(inventory)) {
  test(`${page} retains every original action, identifier, permission and pending-request gate`, () => {
    const current = actions(source(page));
    for (const previous of original)
      assert.ok(
        current.some(
          (candidate) =>
            candidate.tag === previous.tag &&
            Object.entries(previous.attrs).every(
              ([key, value]) => candidate.attrs[key] === value,
            ),
        ),
        `Missing safety/action binding ${JSON.stringify(previous)}`,
      );
    assert.match(
      source(page, 'wxss'),
      /@import '\.\.\/\.\.\/design\/framework7-ios\.wxss';/,
    );
    assert.doesNotMatch(
      source(page),
      /WHALEU|旧版完整历史尚未迁移|GIF、HEIC|站外通知投递|匿名|评论/,
    );
  });
}

test('chronology formats real timestamps and does not invent read/delivery/avatar facts', () => {
  const now = new Date(2026, 9, 20, 12).getTime();
  const first = new Date(2026, 9, 20, 9, 30).toISOString();
  const next = new Date(2026, 9, 20, 9, 31).toISOString();
  const later = new Date(2026, 9, 20, 9, 39).toISOString();
  const rows = privateMessageRows(
    [
      message({ createdAt: first }),
      message({ createdAt: next }),
      message({ createdAt: later }),
    ],
    now,
  );
  assert.deepEqual(
    rows.map((item) => item.showTime),
    [true, false, true],
  );
  assert.equal(rows[0]?.timeLabel, '09:30');
  assert.equal(rows[2]?.timeLabel, '09:39');
  assert.equal(privateMessageTime('not a date', now), '');
  assert.match(
    privateMessageTime(new Date(2025, 9, 19, 8).toISOString(), now),
    /2025年10月19日 08:00/,
  );
  assert.equal(rows[0]?.text, '本地合成私信');
  assert.doesNotMatch(
    source('private-message-detail'),
    /已送达|对方已读|正在输入|avatarUrl/,
  );
});

test('chat composer has no Enter/change send, keeps read observation and keyboard safe area', () => {
  const template = source('private-message-detail');
  assert.equal(template.match(/bind:press="onSend"/g)?.length, 1);
  assert.doesNotMatch(template, /bind(?:confirm|blur|focus|change)="onSend"/);
  assert.match(template, /bindkeyboardheightchange="onKeyboardHeight"/);
  assert.match(template, /adjust-position="false"/);
  assert.match(template, /show-confirm-bar="false"/);
  assert.match(template, /env\(safe-area-inset-bottom\)/);
  assert.match(template, /conversation &amp;&amp; uiPanel === 'conversation'/);
  assert.match(
    source('private-message-detail', 'ts'),
    /intersectionRatio >= 0.5/,
  );
  assert.match(
    source('private-message-detail', 'wxss'),
    /\.history\s*\{[^}]*flex: 1;[^}]*min-height: 0;[^}]*height: 0;/s,
  );
});

interface NativePage {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, done?: () => void): void;
  [key: string]: unknown;
}
const invoke = (page: NativePage, name: string, ...args: unknown[]) => {
  const handler = page[name];
  assert.equal(typeof handler, 'function', name);
  return (handler as (...values: unknown[]) => unknown).apply(page, args);
};
const event = (dataset: Record<string, string>) => ({
  currentTarget: { dataset },
});
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

test('native private chat menus are presentation-only, null-safe and scrubbed on hide/account change', async () => {
  const require = createRequire(__filename);
  const h = harness();
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    wx?: unknown;
    getApp?: unknown;
  };
  const previous = {
    Page: globals.Page,
    wx: globals.wx,
    getApp: globals.getApp,
  };
  let captured: NativePage | undefined;
  const pages: NativePage[] = [];
  Object.assign(globals, {
    wx: {},
    getApp: () => ({ community: { messaging: h.runtime } }),
    Page(definition: NativePage) {
      captured = {
        ...definition,
        data: structuredClone(definition.data),
        setData(patch, done) {
          Object.assign(this.data, patch);
          done?.();
        },
      };
    },
  });
  const load = (suffix: string) => {
    const file = path.join(
      __dirname,
      `../src/pages/private-message-${suffix}/private-message-${suffix}.ts`,
    );
    delete require.cache[require.resolve(file)];
    require(file);
    assert.ok(captured);
    pages.push(captured);
    return captured;
  };
  try {
    const detail = load('detail');
    invoke(detail, 'onTogglePanel', event({ panel: 'conversation' }));
    assert.equal(detail.data.uiPanel, '');
    invoke(detail, 'onLoad', { conversationId });
    invoke(detail, 'onShow');
    await flush();
    invoke(detail, 'onText', { detail: { value: '仅供编辑，不应自动发送' } });
    const appliedBefore = h.applied.length;
    invoke(detail, 'onTogglePanel', event({ panel: 'media' }));
    invoke(detail, 'onTogglePanel', event({ panel: 'conversation' }));
    invoke(detail, 'onKeyboardHeight', { detail: { height: 312 } });
    assert.equal(detail.data.uiKeyboardHeight, 312);
    assert.equal(h.applied.length, appliedBefore);
    assert.equal(detail.data.text, '仅供编辑，不应自动发送');
    invoke(detail, 'onMessageMenu', event({ id: messageId }));
    assert.equal(detail.data.uiMessageMenu, messageId);
    invoke(detail, 'onHide');
    assert.equal(detail.data.uiMessageMenu, '');
    assert.equal(detail.data.uiPanel, '');
    assert.equal(detail.data.uiKeyboardHeight, 0);
    invoke(detail, 'onKeyboardHeight', { detail: { height: 312 } });
    assert.equal(detail.data.uiKeyboardHeight, 0);
    assert.deepEqual(detail.data.uiMessages, []);
    assert.equal(detail.data.text, '');
    invoke(detail, 'onShow');
    await flush();
    invoke(detail, 'onTogglePanel', event({ panel: 'conversation' }));
    const list = load('list');
    invoke(list, 'onShow');
    await flush();
    invoke(list, 'onToggleRow', event({ id: conversationId }));
    const recovery = load('recovery');
    invoke(recovery, 'onShow');
    invoke(recovery, 'onToggleDetails');
    h.sessions.logout();
    assert.equal(detail.data.uiPanel, '');
    assert.deepEqual(detail.data.uiMessages, []);
    assert.equal(list.data.uiRowMenu, '');
    assert.deepEqual(list.data.uiItems, []);
    assert.equal(recovery.data.uiDetails, false);
    assert.equal(recovery.data.uiActions, false);
    invoke(detail, 'onTogglePanel', event({ panel: 'conversation' }));
    assert.equal(detail.data.uiPanel, '');
    assert.equal(h.applied.length, appliedBefore);
  } finally {
    for (const page of pages) invoke(page, 'onUnload');
    Object.assign(globals, previous);
  }
});

test('read observation pauses behind overlays and resumes only after the current visible render commits', async () => {
  const require = createRequire(__filename);
  const h = harness();
  const globals = globalThis as typeof globalThis & {
    Page?: unknown;
    wx?: unknown;
    getApp?: unknown;
  };
  const previous = {
    Page: globals.Page,
    wx: globals.wx,
    getApp: globals.getApp,
  };
  const observers: {
    disconnected: boolean;
    callback?: (result: { intersectionRatio: number }) => void;
  }[] = [];
  const completions: (() => void)[] = [];
  let deferCompletion = false;
  let page: NativePage | undefined;
  const completeRenders = () => {
    while (completions.length) completions.shift()!();
  };
  Object.assign(globals, {
    getApp: () => ({ community: { messaging: h.runtime } }),
    wx: {
      createIntersectionObserver() {
        const observer: {
          disconnected: boolean;
          callback?: (result: { intersectionRatio: number }) => void;
        } = { disconnected: false };
        observers.push(observer);
        return {
          relativeToViewport() {
            return this;
          },
          observe(
            _selector: string,
            callback: (result: { intersectionRatio: number }) => void,
          ) {
            observer.callback = callback;
          },
          disconnect() {
            observer.disconnected = true;
          },
        };
      },
    },
    Page(definition: NativePage) {
      page = {
        ...definition,
        data: structuredClone(definition.data),
        setData(patch, done) {
          Object.assign(this.data, patch);
          if (done) {
            if (deferCompletion) completions.push(done);
            else done();
          }
        },
      };
    },
  });
  try {
    const file = path.join(
      __dirname,
      '../src/pages/private-message-detail/private-message-detail.ts',
    );
    delete require.cache[require.resolve(file)];
    require(file);
    assert.ok(page);
    invoke(page, 'onLoad', { conversationId });
    invoke(page, 'onShow');
    await flush();
    assert.ok(observers.length > 0);
    const controller = page.controller as {
      observeMessage(id: string): void;
      readonly keepPicker: boolean;
    };
    const seen: string[] = [];
    controller.observeMessage = (id) => seen.push(id);
    const initial = observers[observers.length - 1]!;
    const count = observers.length;
    deferCompletion = true;
    invoke(page, 'onTogglePanel', event({ panel: 'conversation' }));
    assert.equal(
      initial.disconnected,
      true,
      'opening a sheet synchronously disconnects',
    );
    initial.callback?.({ intersectionRatio: 1 });
    assert.deepEqual(
      seen,
      [],
      'a queued pre-overlay callback cannot acknowledge',
    );
    completeRenders();
    assert.equal(
      observers.length,
      count,
      'sheet render never creates an observer',
    );
    invoke(page, 'onText', {
      detail: { value: 'controller render behind sheet' },
    });
    completeRenders();
    assert.equal(
      observers.length,
      count,
      'controller refresh behind sheet stays paused',
    );
    invoke(page, 'onCloseMenus');
    assert.equal(
      observers.length,
      count,
      'clearing state alone is not a committed close',
    );
    initial.callback?.({ intersectionRatio: 1 });
    assert.deepEqual(seen, []);
    completeRenders();
    assert.equal(
      observers.length,
      count + 1,
      'closed current render resumes observation',
    );
    const resumed = observers[observers.length - 1]!;
    resumed.callback?.({ intersectionRatio: 1 });
    assert.deepEqual(seen, [messageId]);
    seen.length = 0;

    invoke(page, 'onMessageMenu', event({ id: messageId }));
    resumed.callback?.({ intersectionRatio: 1 });
    completeRenders();
    assert.deepEqual(seen, []);
    assert.equal(observers.length, count + 1);
    invoke(page, 'onAction', event({ kind: 'block' }));
    assert.ok(page.data.confirm);
    completeRenders();
    assert.equal(
      observers.length,
      count + 1,
      'menu-to-confirm transition never resumes behind confirmation',
    );
    invoke(page, 'onText', {
      detail: { value: 'controller render behind confirmation' },
    });
    completeRenders();
    assert.equal(observers.length, count + 1);
    invoke(page, 'onDismiss');
    assert.equal(observers.length, count + 1);
    completeRenders();
    assert.equal(observers.length, count + 2);

    const beforePicker = observers[observers.length - 1]!;
    Object.defineProperty(controller, 'keepPicker', {
      configurable: true,
      value: true,
    });
    invoke(page, 'observeLatest');
    beforePicker.callback?.({ intersectionRatio: 1 });
    assert.deepEqual(seen, []);
    assert.equal(
      observers.length,
      count + 2,
      'native picker pause cannot observe',
    );
    delete (controller as { keepPicker?: boolean }).keepPicker;
    invoke(page, 'observeLatest');
    const beforeHide = observers[observers.length - 1]!;
    invoke(page, 'onTogglePanel', event({ panel: 'conversation' }));
    completeRenders();
    invoke(page, 'onCloseMenus');
    const beforeHideCount = observers.length;
    invoke(page, 'onHide');
    beforeHide.callback?.({ intersectionRatio: 1 });
    completeRenders();
    assert.equal(
      observers.length,
      beforeHideCount,
      'late close/controller completions cannot resume after hide',
    );
    assert.deepEqual(seen, []);
    assert.equal(page.pageVisible, false);
    invoke(page, 'observeLatest');
    assert.equal(observers.length, beforeHideCount);
  } finally {
    deferCompletion = false;
    if (page) invoke(page, 'onUnload');
    completeRenders();
    Object.assign(globals, previous);
  }
});
