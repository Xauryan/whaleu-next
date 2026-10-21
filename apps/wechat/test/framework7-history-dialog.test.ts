import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { BrowsingHistoryController } from '../src/browsing-history/controller';
import { nativeBrowsingHistory } from '../src/browsing-history/native';
import { ClientError } from '../src/api/errors';
import { setup, post, postId, otherId } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';

type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties?: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods?: Record<string, Method>;
  observers?: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
  [key: string]: unknown;
}
interface Instance {
  data: Record<string, unknown>;
  properties: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
  [key: string]: unknown;
}
const requireNative = createRequire(__filename);
function registration(file: string, kind: 'Page' | 'Component'): Definition {
  let definition: Definition | undefined;
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[kind];
  globals[kind] = (value: Definition) => {
    definition = value;
  };
  try {
    const target = requireNative.resolve(`../src/${file}`);
    delete requireNative.cache[target];
    requireNative(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(definition, `executes actual ${kind} registration`);
  return definition;
}
function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { due: number; run: () => void }>();
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((run: () => void, delay: number) => {
    const id = ++next;
    timers.set(id, { due: now + delay, run });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout;
  return {
    advance(delta: number) {
      const until = now + delta;
      for (;;) {
        const current = [...timers]
          .filter(([, timer]) => timer.due <= until)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!current) break;
        timers.delete(current[0]);
        now = current[1].due;
        current[1].run();
      }
      now = until;
    },
    restore() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}
function component(name: 'dialog' | 'button', emit: Instance['triggerEvent']) {
  const definition = registration(
    `components/f7-${name}/f7-${name}.ts`,
    'Component',
  );
  const acknowledgements: (() => void)[] = [];
  let holdRemoval = false;
  const instance: Instance = {
    properties: Object.fromEntries(
      Object.entries(definition.properties!).map(([key, property]) => [
        key,
        structuredClone(property.value),
      ]),
    ),
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      if (callback) {
        if (holdRemoval && patch.rendered === false)
          acknowledgements.push(callback);
        else callback();
      }
    },
    triggerEvent: emit,
  };
  for (const [name, method] of Object.entries(definition.methods!))
    instance[name] = method.bind(instance);
  const call = (name: string, event?: unknown) =>
    definition.methods![name]!.call(instance, event);
  const update = (values: Record<string, unknown>) => {
    Object.assign(instance.properties, values);
    for (const [selector, observer] of Object.entries(
      definition.observers ?? {},
    ))
      if (selector.split(',').some((key) => key.trim() in values))
        observer.call(instance);
  };
  definition.lifetimes!.attached!.call(instance);
  return {
    instance,
    call,
    update,
    holdRemoval(value: boolean) {
      holdRemoval = value;
    },
    acknowledgeRemoval() {
      for (const callback of acknowledgements.splice(0)) callback();
    },
    hide() {
      definition.pageLifetimes!.hide!.call(instance);
    },
    show() {
      definition.pageLifetimes!.show!.call(instance);
    },
    detach() {
      definition.lifetimes!.detached!.call(instance);
    },
  };
}
async function harness(loggedIn = true) {
  const clock = fakeClock();
  const s = setup(loggedIn);
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWx = globals.wx,
    previousApp = globals.getApp;
  const navigated: string[] = [];
  globals.wx = {
    getStorageSync: (key: string) => s.storage.get(key),
    setStorageSync: (key: string, value: unknown) => s.storage.set(key, value),
    removeStorageSync: (key: string) => s.storage.remove(key),
    navigateTo: (options: { url: string; success(): void }) => {
      navigated.push(options.url);
      options.success();
    },
  };
  globals.getApp = () => ({ community: s.runtime });
  const history = nativeBrowsingHistory(s.sessions);
  if (loggedIn) history.record(postId, s.sessions.snapshot());
  const definition = registration(
    'pages/browsing-history/browsing-history.ts',
    'Page',
  );
  const events: { name: string; detail: Record<string, unknown> }[] = [];
  const pageWrites: Record<string, unknown>[] = [];
  const acknowledgements: (() => void)[] = [];
  let holdPage = false;
  const dialog = component('dialog', (name, detail, options) => {
    assert.deepEqual(options, { bubbles: false, composed: false });
    events.push({
      name,
      detail: structuredClone(detail) as Record<string, unknown>,
    });
    const route = {
      opened: 'onClearDialogOpened',
      action: 'onConfirmClear',
      requestclose: 'onDismissClear',
      closed: 'onClearDialogClosed',
    }[name];
    if (route) (page[route] as Method).call(page, { detail });
  });
  const syncDialog = () => {
    const values = {
      open: page.data.clearDialogOpen,
      sessionId: page.data.clearDialogSessionId,
      attemptKey: page.data.clearDialogAttempt,
      loading: page.data.clearDialogLoading,
      mode: 'confirm',
      confirmId: 'clear-history',
      destructive: true,
    };
    const changed = Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) => dialog.instance.properties[key] !== value,
      ),
    );
    if (Object.keys(changed).length) dialog.update(changed);
  };
  const page: Instance = {
    ...definition,
    data: structuredClone(definition.data),
    properties: {},
    setData(patch, callback) {
      pageWrites.push(structuredClone(patch));
      Object.assign(this.data, patch);
      syncDialog();
      if (callback) {
        if (holdPage) acknowledgements.push(callback);
        else callback();
      }
    },
    triggerEvent() {},
  };
  for (const [name, method] of Object.entries(definition))
    if (typeof method === 'function') page[name] = method.bind(page);
  const call = (name: string, event?: unknown) =>
    (page[name] as Method).call(page, event);
  call('onShow');
  await flush();
  let clears = 0;
  const trackController = () => {
    const controller = page.controller as BrowsingHistoryController;
    const clear = controller.clear.bind(controller);
    controller.clear = () => {
      clears += 1;
      clear();
    };
  };
  trackController();
  const button = component('button', (_name, detail) => {
    dialog.call(button.instance.properties.target as string, {
      currentTarget: {
        dataset: {
          sessionId: dialog.instance.data.activeSessionId,
          generation: dialog.instance.data.generation,
          attemptKey: dialog.instance.properties.attemptKey,
        },
      },
      detail,
    });
  });
  const nativeHit = () => ({
    currentTarget: {
      dataset: { interactionKey: dialog.instance.data.buttonInteractionKey },
    },
  });
  const press = (target: 'onConfirm' | 'onCancel', native = nativeHit()) => {
    button.update({
      target,
      interactionKey: dialog.instance.data.buttonInteractionKey,
      disabled: dialog.instance.data.interactionDisabled,
      loading: page.data.clearDialogLoading,
    });
    button.call('onPress', native);
  };
  return {
    ...s,
    history,
    page,
    dialog,
    clock,
    call,
    press,
    events,
    pageWrites,
    navigated,
    clears: () => clears,
    nativeHit,
    holdPage(value: boolean) {
      holdPage = value;
    },
    acknowledgePage() {
      for (const callback of acknowledgements.splice(0)) callback();
    },
    async show() {
      dialog.show();
      call('onShow');
      trackController();
      await flush();
    },
    open() {
      call('onRequestClear');
      clock.advance(416);
      assert.equal(dialog.instance.data.phase, 'open');
    },
    cleanup() {
      call('onUnload');
      dialog.detach();
      button.detach();
      globals.wx = previousWx;
      globals.getApp = previousApp;
      clock.restore();
    },
  };
}

test('actual Button → Dialog → Page holds its native scroll lease before opening through native removal acknowledgement', async () => {
  const h = await harness();
  try {
    h.holdPage(true);
    h.call('onRequestClear');
    assert.equal(h.page.data.historyOverlayLocked, true);
    assert.equal(h.page.data.historyPageStyle, 'overflow: hidden;');
    assert.equal(h.page.data.clearDialogOpen, false);
    assert.equal(h.dialog.instance.data.rendered, false);
    const calls = h.gateway.calls.length;
    for (const name of [
      'onReload',
      'onMore',
      'onPrevious',
      'onRequestClear',
      'onLogin',
    ])
      h.call(name);
    h.call('onOpen', { currentTarget: { dataset: { id: postId } } });
    assert.equal(h.gateway.calls.length, calls);
    assert.equal(h.navigated.length, 0);
    h.holdPage(false);
    h.acknowledgePage();
    h.clock.advance(416);
    assert.equal(h.dialog.instance.data.phase, 'open');
    assert.equal(
      (h.page.data.items as unknown[]).length,
      1,
      'underlying authorized content stays mounted',
    );
    h.dialog.holdRemoval(true);
    h.press('onCancel');
    assert.equal(h.clears(), 0);
    assert.equal(h.history.list().length, 1);
    assert.equal(h.page.data.confirmClear, false);
    assert.equal(h.dialog.instance.data.phase, 'closing');
    assert.equal(h.page.data.historyOverlayLocked, true);
    h.clock.advance(400);
    assert.equal(h.dialog.instance.data.rendered, false);
    assert.equal(h.page.data.historyPageStyle, 'overflow: hidden;');
    assert.equal(h.events.filter((event) => event.name === 'closed').length, 0);
    h.dialog.acknowledgeRemoval();
    assert.equal(h.page.data.historyOverlayLocked, false);
    assert.equal(h.page.data.historyPageStyle, '');
    h.call('onOpen', { currentTarget: { dataset: { id: postId } } });
    assert.equal(
      h.navigated[0],
      `/pages/community-detail/community-detail?postId=${postId}`,
    );
  } finally {
    h.cleanup();
  }
});

test('confirm is allowlisted and one-shot; malformed, old attempt, stale opening and wrong closed generation cannot act', async () => {
  const h = await harness();
  try {
    h.open();
    const firstSession = h.page.data.clearDialogSessionId;
    const oldHit = h.nativeHit();
    h.press('onCancel');
    h.clock.advance(400);
    const oldClose = h.events.find((event) => event.name === 'closed')!;
    h.open();
    assert.notEqual(h.page.data.clearDialogSessionId, firstSession);
    h.press('onConfirm', oldHit);
    assert.equal(h.clears(), 0);
    const identity = {
      sessionId: h.page.data.clearDialogSessionId,
      generation: h.dialog.instance.data.generation,
      attemptKey: 0,
      id: 'clear-history',
    };
    for (const patch of [
      { id: 'delete-post' },
      { attemptKey: 1 },
      { generation: -1 },
      { generation: 0 },
      { sessionId: firstSession },
      { generation: '1' },
    ])
      h.call('onConfirmClear', { detail: { ...identity, ...patch } });
    assert.equal(h.clears(), 0);
    h.holdPage(true);
    h.press('onConfirm');
    h.press('onConfirm');
    assert.equal(h.page.data.clearDialogLoading, true);
    assert.equal(h.clears(), 0, 'loading is acknowledged before mutation');
    h.call('onConfirmClear', { detail: identity });
    h.holdPage(false);
    h.acknowledgePage();
    assert.equal(h.clears(), 1);
    assert.deepEqual(h.history.list(), []);
    assert.equal(h.page.data.status, '本机浏览记录已清空');
    h.call('onClearDialogClosed', { detail: oldClose.detail });
    h.call('onClearDialogClosed', { detail: { ...identity, generation: 999 } });
    assert.equal(h.page.data.historyOverlayLocked, true);
    h.clock.advance(400);
    assert.equal(h.page.data.historyOverlayLocked, false);
    h.call('onConfirmClear', { detail: identity });
    assert.equal(h.clears(), 1);
  } finally {
    h.cleanup();
  }
});

test('known local clear failure hides summaries, stays open, and only a new explicit rearmed tap retries', async () => {
  const h = await harness();
  try {
    h.open();
    const oldHit = h.nativeHit();
    const oldIdentity = {
      sessionId: h.page.data.clearDialogSessionId,
      generation: h.dialog.instance.data.generation,
      attemptKey: 0,
      id: 'clear-history',
    };
    h.storage.failRemove = true;
    h.storage.failWrite = true;
    h.press('onConfirm');
    assert.equal(h.clears(), 1);
    assert.equal(h.page.data.clearDialogOpen, true);
    assert.equal(h.page.data.historyOverlayLocked, true);
    assert.equal(h.page.data.loaded, false);
    assert.deepEqual(h.page.data.items, []);
    assert.match(h.page.data.clearDialogError as string, /本机存储清理失败/);
    assert.equal(h.page.data.clearDialogAttempt, 1);
    assert.throws(() => h.history.list());
    h.press('onConfirm', oldHit);
    h.call('onConfirmClear', { detail: oldIdentity });
    for (const attemptKey of [0, undefined, '1', 2])
      h.call('onDismissClear', {
        detail: { ...oldIdentity, attemptKey, reason: 'cancel' },
      });
    assert.equal(
      h.page.data.clearDialogOpen,
      true,
      'queued earlier or malformed cancellation cannot dismiss a rearmed attempt',
    );
    assert.equal(h.page.data.confirmClear, true);
    assert.equal(h.clears(), 1);
    h.storage.failRemove = false;
    h.storage.failWrite = false;
    h.press('onConfirm');
    assert.equal(h.clears(), 2);
    assert.equal(h.page.data.loaded, true);
    assert.equal(h.page.data.error, '');
    h.clock.advance(400);
    assert.equal(h.page.data.historyOverlayLocked, false);
    assert.equal(h.page.data.clearDialogError, '');
  } finally {
    h.cleanup();
  }
});

for (const action of [
  'logout',
  'account-switch',
  'same-account-login',
] as const)
  test(`${action} invalidates the pending confirmation without clearing another owner`, async () => {
    const h = await harness();
    try {
      h.open();
      h.holdPage(true);
      h.press('onConfirm');
      if (action === 'logout') h.sessions.logout();
      else
        h.sessions.completeLogin(h.sessions.beginLogin(), {
          ...wireCredentials(),
          ...(action === 'account-switch' ? { accountId: otherId } : {}),
        });
      assert.equal(h.page.data.clearDialogOpen, false);
      assert.deepEqual(h.page.data.items, []);
      h.holdPage(false);
      h.acknowledgePage();
      assert.equal(h.clears(), 0);
      assert.equal(h.page.data.historyOverlayLocked, true);
      h.clock.advance(400);
      assert.equal(h.page.data.historyOverlayLocked, false);
      if (action === 'logout') {
        h.call('onLogin');
        assert.equal(h.navigated[0], '/pages/login/login');
      }
    } finally {
      h.cleanup();
    }
  });

test('refresh preserves confirmation ownership; account invalidation during opening closes without opened', async () => {
  const h = await harness();
  try {
    h.open();
    h.sessions.rotate(h.sessions.snapshot(), wireCredentials('rotated'));
    h.press('onConfirm');
    assert.equal(h.clears(), 1);
    h.clock.advance(400);
    h.call('onRequestClear');
    const opened = h.events.filter((event) => event.name === 'opened').length;
    h.sessions.logout();
    h.clock.advance(500);
    assert.equal(
      h.events.filter((event) => event.name === 'opened').length,
      opened,
    );
    assert.equal(h.page.data.historyOverlayLocked, false);
    assert.equal(h.clears(), 1);
  } finally {
    h.cleanup();
  }
});

for (const lifecycle of ['onHide', 'onUnload'])
  test(`${lifecycle} invalidates lock, pending action and late close acknowledgements without reopening/resuming`, async () => {
    const h = await harness();
    try {
      h.open();
      h.dialog.holdRemoval(true);
      h.press('onCancel');
      h.clock.advance(400);
      const oldSession = h.page.data.clearDialogSessionId;
      h.call(lifecycle);
      h.dialog.hide();
      const writes = h.pageWrites.length;
      h.dialog.acknowledgeRemoval();
      h.clock.advance(1000);
      assert.equal(h.pageWrites.length, writes);
      assert.equal(h.page.data.historyOverlayLocked, true);
      assert.equal(h.page.data.clearDialogOpen, false);
      assert.equal(h.page.data.clearDialogSessionId, '');
      for (const name of [
        'onReload',
        'onMore',
        'onPrevious',
        'onRequestClear',
        'onLogin',
      ])
        h.call(name);
      assert.equal(h.clears(), 0);
      await h.show();
      h.open();
      assert.notEqual(h.page.data.clearDialogSessionId, oldSession);
      h.holdPage(true);
      h.press('onConfirm');
      h.call(lifecycle);
      h.dialog.hide();
      h.holdPage(false);
      h.acknowledgePage();
      h.clock.advance(1000);
      assert.equal(h.clears(), 0);
      assert.equal(h.page.data.clearDialogOpen, false);
      assert.equal(h.page.data.historyOverlayLocked, true);
    } finally {
      h.cleanup();
    }
  });

test('hide before the scroll-lock acknowledgement cannot open; late authorized reads cannot repopulate hidden summaries', async () => {
  const h = await harness();
  try {
    h.holdPage(true);
    h.call('onRequestClear');
    h.call('onHide');
    h.dialog.hide();
    h.holdPage(false);
    h.acknowledgePage();
    h.clock.advance(1000);
    assert.equal(h.page.data.clearDialogOpen, false);
    assert.equal(h.events.length, 0);
    await h.show();
    const pending = deferred<ReturnType<typeof post>>();
    h.gateway.postImpl = async () => pending.promise;
    h.call('onReload');
    await flush();
    h.call('onHide');
    h.dialog.hide();
    pending.resolve(post({ text: 'must not reappear' }));
    await flush();
    assert.deepEqual(h.page.data.items, []);
  } finally {
    h.cleanup();
  }
});

test('the page retains authorized-summary denial/network semantics and never grants a backend delete capability', async () => {
  const h = await harness();
  try {
    h.gateway.postImpl = async () => {
      throw new ClientError('business', 'Deleted', {
        serverCode: 'POST_DELETED',
      });
    };
    h.call('onReload');
    await flush();
    assert.deepEqual(h.page.data.items, []);
    assert.equal(h.page.data.loaded, true);
    h.gateway.postImpl = async () => {
      throw new ClientError('network', 'Offline');
    };
    h.call('onReload');
    await flush();
    assert.equal(h.page.data.loaded, false);
    assert.deepEqual(h.page.data.items, []);
    h.open();
    h.press('onCancel');
    h.clock.advance(400);
    assert.ok(h.gateway.calls.every((call) => call.method === 'post'));
    assert.equal(h.history.list().length, 1);
  } finally {
    h.cleanup();
  }
});

test('source mounts the dialog through closing and uses first-node native page-meta with guarded controls, not backdrop-only scrolling', () => {
  const base = path.join(
    __dirname,
    '../src/pages/browsing-history/browsing-history',
  );
  const markup = readFileSync(`${base}.wxml`, 'utf8');
  assert.match(markup, /^<page-meta page-style="\{\{historyPageStyle\}\}" \/>/);
  const dialog = /<wu-f7-dialog\b[^>]+\/>/.exec(markup)![0];
  assert.doesNotMatch(dialog, /wx:if/);
  assert.match(dialog, /open="\{\{clearDialogOpen\}\}"/);
  assert.match(dialog, /destructive="\{\{true\}\}"/);
  assert.match(dialog, /confirm-id="clear-history"/);
  assert.match(dialog, /bind:action="onConfirmClear"/);
  assert.match(dialog, /bind:requestclose="onDismissClear"/);
  assert.match(dialog, /bind:closed="onClearDialogClosed"/);
  assert.doesNotMatch(
    markup,
    /<navigator|history-confirm-clear|wx:if="\{\{!historyOverlayLocked/,
  );
  for (const node of markup.matchAll(
    /<(?:wu-f7-button|wu-f7-list-item)\b[^>]+>/g,
  ))
    assert.match(node[0], /disabled="[^"]*historyOverlayLocked/);
  const source = readFileSync(`${base}.ts`, 'utf8');
  assert.doesNotMatch(
    source,
    /createIntersectionObserver|ViewObserver|\.record\(|gateway.*delete|\.resume\(/,
  );
  assert.equal(
    JSON.parse(readFileSync(`${base}.json`, 'utf8')).usingComponents[
      'wu-f7-dialog'
    ],
    '../../components/f7-dialog/f7-dialog',
  );
});

test('login navigation failures remain contextual and late failures cannot alter a hidden or changed page', async () => {
  const h = await harness(false);
  try {
    const native = wx as unknown as {
      navigateTo?: (options: { fail(error: unknown): void }) => void;
    };
    let fail: ((error: unknown) => void) | undefined;
    native.navigateTo = (options) => {
      fail = options.fail;
    };
    h.call('onLogin');
    fail?.({});
    assert.equal(h.page.data.error, '暂不能打开登录页，请重试');
    h.call('onLogin');
    h.call('onHide');
    fail?.({});
    assert.equal(h.page.data.error, '');
    await h.show();
    delete native.navigateTo;
    h.call('onLogin');
    assert.equal(h.page.data.error, '当前环境不能打开登录页');
  } finally {
    h.cleanup();
  }
});

test('overlay preview fixtures are synthetic source states with normal, confirm and failure light/dark pairs', async () => {
  const { default: fixtures } = (await import(
    pathToFileURL(
      path.join(
        __dirname,
        '../scripts/fixtures/framework7-overlays-preview.mjs',
      ),
    ).href
  )) as {
    default: {
      id: string;
      page: string;
      themes: string[];
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(fixtures.length, 3);
  for (const fixture of fixtures) {
    assert.equal(fixture.page, 'browsing-history');
    assert.deepEqual(fixture.themes, ['light', 'dark']);
    assert.ok(fixture.expectedText.length >= 3);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accessToken|refreshToken|accountId|providerId/,
    );
  }
  assert.equal(fixtures[0]!.patch.clearDialogOpen, false);
  assert.equal(fixtures[1]!.patch.clearDialogOpen, true);
  assert.equal(fixtures[1]!.patch.historyPageStyle, 'overflow: hidden;');
  assert.equal(fixtures[2]!.patch.clearDialogAttempt, 1);
  assert.deepEqual(fixtures[2]!.patch.items, []);
  assert.match(
    fixtures[2]!.patch.clearDialogError as string,
    /本机存储清理失败/,
  );
});

test('a logged-out page cannot request or confirm local clearing, even with a forged dialog detail', async () => {
  const h = await harness(false);
  try {
    h.call('onRequestClear');
    h.call('onConfirmClear', {
      detail: {
        sessionId: 'forged',
        generation: 1,
        attemptKey: 0,
        id: 'clear-history',
      },
    });
    assert.equal(h.page.data.clearDialogOpen, false);
    assert.equal(h.page.data.confirmClear, false);
    assert.equal(h.clears(), 0);
  } finally {
    h.cleanup();
  }
});

test('controller invalidation while loading acknowledgement is queued cancels the intent before any storage clear', async () => {
  const h = await harness();
  try {
    h.open();
    h.holdPage(true);
    h.press('onConfirm');
    (h.page.controller as BrowsingHistoryController).dispose();
    assert.equal(h.page.data.clearDialogOpen, false);
    h.holdPage(false);
    h.acknowledgePage();
    assert.equal(h.clears(), 0);
    assert.equal(h.history.list().length, 1);
    h.clock.advance(400);
    assert.equal(h.page.data.historyOverlayLocked, false);
  } finally {
    h.cleanup();
  }
});

test('background aria-hidden follows the owner lease through closing and only valid closed or fresh onShow releases it', async () => {
  const { parsePreviewWxml } = requireNative('../scripts/preview-wxml.mjs') as {
    parsePreviewWxml(source: string): {
      children: { tag: string; attrs: Record<string, string> }[];
    };
  };
  const tree = parsePreviewWxml(
    readFileSync(
      path.join(
        __dirname,
        '../src/pages/browsing-history/browsing-history.wxml',
      ),
      'utf8',
    ),
  );
  const background = tree.children.find(
    (node) => node.attrs?.class === 'history-screen f7-ios-theme',
  );
  assert.ok(background);
  assert.equal(background.attrs['aria-hidden'], '{{historyOverlayLocked}}');
  assert.equal(
    background.attrs['wx:if'],
    undefined,
    'underlying page stays mounted',
  );
  assert.ok(
    tree.children.some((node) => node.tag === 'wu-f7-dialog'),
    'dialog is a sibling, not hidden with its background',
  );
  const binding = background.attrs['aria-hidden'].slice(2, -2);
  const h = await harness();
  const hidden = () => h.page.data[binding];
  try {
    assert.equal(hidden(), false);
    h.holdPage(true);
    h.call('onRequestClear');
    assert.equal(hidden(), true, 'fenced before dialog opens');
    h.holdPage(false);
    h.acknowledgePage();
    h.clock.advance(416);
    assert.equal(hidden(), true);
    h.dialog.holdRemoval(true);
    h.press('onCancel');
    assert.equal(h.dialog.instance.data.phase, 'closing');
    assert.equal(hidden(), true);
    const identity = {
      sessionId: h.page.data.clearDialogSessionId,
      generation: h.dialog.instance.data.generation,
    };
    h.call('onClearDialogClosed', { detail: { ...identity, generation: 999 } });
    assert.equal(hidden(), true, 'a stale close cannot expose the background');
    h.clock.advance(400);
    assert.equal(
      hidden(),
      true,
      'elapsed animation does not replace native removal acknowledgement',
    );
    h.dialog.acknowledgeRemoval();
    assert.equal(hidden(), false, 'matching native closed releases the lease');
    h.open();
    h.call('onHide');
    h.dialog.hide();
    assert.equal(
      hidden(),
      true,
      'hide invalidates without resuming hidden content',
    );
    h.call('onClearDialogClosed', { detail: identity });
    assert.equal(hidden(), true);
    await h.show();
    assert.equal(
      hidden(),
      false,
      'fresh visible owner can expose its own background',
    );
  } finally {
    h.cleanup();
  }
});
