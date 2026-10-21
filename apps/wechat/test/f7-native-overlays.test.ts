import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { actionItems } from '../src/components/f7-actions/model';
import {
  validActionId,
  validAttemptKey,
  validSessionId,
} from '../src/components/f7-sheet/overlay';

type Name = 'sheet' | 'actions' | 'dialog';
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  options: { styleIsolation: string };
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  observers: Record<string, (this: Instance, ...values: unknown[]) => void>;
  methods: Record<string, Method>;
  lifetimes: Record<string, Method>;
  pageLifetimes: Record<string, Method>;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(data: Record<string, unknown>, callback?: () => void): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
const isolated = { bubbles: false, composed: false };
const names: Name[] = ['sheet', 'actions', 'dialog'];
const read = (name: Name, extension: string) =>
  readFileSync(
    path.join(
      __dirname,
      `../src/components/f7-${name}/f7-${name}.${extension}`,
    ),
    'utf8',
  );
function registration(name: Name | 'button' | 'input'): Definition {
  const require = createRequire(__filename);
  const target = require.resolve(`../src/components/f7-${name}/f7-${name}`);
  let captured: Definition | undefined;
  const globals = globalThis as unknown as {
    Component?: (value: Definition) => void;
  };
  const previous = globals.Component;
  globals.Component = (value) => {
    captured = value;
  };
  try {
    delete require.cache[target];
    require(target);
  } finally {
    if (previous) globals.Component = previous;
    else delete globals.Component;
  }
  assert.ok(captured, 'executes actual native Component registration');
  return captured;
}
function fakeClock() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let now = 0;
  let next = 1;
  const timers = new Map<
    number,
    { callback: () => void; due: number; cancelled: boolean }
  >();
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    const id = next++;
    timers.set(id, { callback, due: now + delay, cancelled: false });
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    const timer = timers.get(id);
    if (timer) timer.cancelled = true;
  }) as unknown as typeof clearTimeout;
  return {
    advance(delta: number) {
      const end = now + delta;
      for (;;) {
        const entry = [...timers.entries()]
          .filter(([, value]) => !value.cancelled && value.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) break;
        const [id, value] = entry;
        now = value.due;
        timers.delete(id);
        value.callback();
      }
      now = end;
    },
    ids: () => [...timers.keys()],
    queued(id: number) {
      timers.get(id)?.callback();
    },
    active: () =>
      [...timers.values()].filter((value) => !value.cancelled).length,
    restore() {
      globalThis.setTimeout = originalSet;
      globalThis.clearTimeout = originalClear;
    },
  };
}
function harness(name: Name, initial: Record<string, unknown> = {}) {
  const definition = registration(name);
  const events: {
    name: string;
    detail: Record<string, unknown>;
    options: unknown;
  }[] = [];
  const writes: Record<string, unknown>[] = [];
  const renderCallbacks: (() => void)[] = [];
  let deferredRender = false;
  let onEvent: ((name: string) => void) | undefined;
  const instance: Instance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, value]) => [
          key,
          structuredClone(value.value),
        ]),
      ),
      ...initial,
    },
    data: structuredClone(definition.data),
    setData(data, callback) {
      writes.push(structuredClone(data));
      Object.assign(this.data, data);
      if (callback) {
        if (deferredRender) renderCallbacks.push(callback);
        else callback();
      }
    },
    triggerEvent(name, detail, options) {
      events.push({
        name,
        detail: structuredClone(detail) as Record<string, unknown>,
        options: structuredClone(options),
      });
      onEvent?.(name);
    },
  };
  for (const [key, method] of Object.entries(definition.methods))
    instance[key] = method.bind(instance);
  const invoke = (name: string, event?: unknown) => {
    const method = definition.methods[name];
    assert.ok(method, name);
    return method.call(instance, event);
  };
  const update = (values: Record<string, unknown>) => {
    Object.assign(instance.properties, values);
    for (const [selector, observer] of Object.entries(definition.observers)) {
      const keys = selector.split(',').map((key) => key.trim());
      if (keys.some((key) => Object.prototype.hasOwnProperty.call(values, key)))
        observer.call(instance, ...keys.map((key) => instance.properties[key]));
    }
  };
  definition.lifetimes.attached!.call(instance);
  return {
    definition,
    instance,
    events,
    writes,
    invoke,
    update,
    event: (extra: Record<string, unknown> = {}, detail?: unknown) => ({
      currentTarget: {
        dataset: {
          sessionId: instance.data.activeSessionId,
          generation: instance.data.generation,
          attemptKey: instance.properties.attemptKey,
          itemsRevision: instance.data.itemsRevision,
          ...extra,
        },
      },
      detail: detail ?? { interactionKey: instance.data.buttonInteractionKey },
    }),
    onEvent(callback: (name: string) => void) {
      onEvent = callback;
    },
    hide: () => definition.pageLifetimes.hide!.call(instance),
    show: () => definition.pageLifetimes.show!.call(instance),
    detach: () => definition.lifetimes.detached!.call(instance),
    attach: () => definition.lifetimes.attached!.call(instance),
    deferRender(value: boolean) {
      deferredRender = value;
    },
    flushRender() {
      const callbacks = renderCallbacks.splice(0);
      for (const callback of callbacks) callback();
    },
  };
}
function withClock(run: (clock: ReturnType<typeof fakeClock>) => void) {
  const clock = fakeClock();
  try {
    run(clock);
  } finally {
    clock.restore();
  }
}
function open(
  name: Name,
  clock: ReturnType<typeof fakeClock>,
  props: Record<string, unknown> = {},
) {
  const h = harness(name, { open: true, sessionId: 'opening-1', ...props });
  clock.advance(name === 'dialog' ? 416 : 316);
  assert.equal(h.instance.data.phase, 'open');
  return h;
}

test('UI session, attempt and action identities are bounded; malformed and duplicate action lists fail closed', () => {
  for (const value of ['', ' ', '<bad>', 'a'.repeat(97), null, 42])
    assert.equal(validSessionId(value), false);
  for (const value of ['opening-1', 'page:2.dialog_3', 'A'.repeat(96)])
    assert.equal(validSessionId(value), true);
  for (const value of ['', '1action', 'unsafe/route', 'x'.repeat(65), null])
    assert.equal(validActionId(value), false);
  for (const value of [
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '0',
    null,
  ])
    assert.equal(validAttemptKey(value), false);
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER])
    assert.equal(validAttemptKey(value), true);
  for (const value of [
    null,
    {},
    [
      { id: 'x', label: 'X' },
      { id: 'x', label: 'again' },
    ],
    [{ id: 'x', label: '' }],
    [{ id: 'x', label: ' '.repeat(5) }],
    [{ id: 'x', label: 'a'.repeat(1001) }],
    [{ id: 'x', label: 'X', disabled: 'false' }],
    Array.from({ length: 101 }, (_, i) => ({ id: `id${i}`, label: 'X' })),
  ])
    assert.deepEqual(actionItems(value), []);
  assert.deepEqual(
    actionItems([
      {
        id: 'remove',
        label: '  删除🙂  ',
        destructive: true,
        onClick: 'not copied',
        url: '/not-copied',
      },
    ]),
    [
      {
        id: 'remove',
        label: '  删除🙂  ',
        disabled: false,
        destructive: true,
        strong: false,
      },
    ],
  );
});

test('controlled overlays mount, open and close exactly once, using pinned 300/400ms lifecycle', () =>
  withClock((clock) => {
    for (const name of names) {
      const h = harness(name);
      assert.equal(h.instance.data.rendered, false);
      h.update({ open: true });
      clock.advance(1000);
      assert.equal(
        h.instance.data.rendered,
        false,
        'missing identity fails closed',
      );
      h.update({ sessionId: 'first' });
      assert.equal(h.instance.data.phase, 'opening');
      assert.equal(h.instance.data.interactionDisabled, true);
      clock.advance(15);
      assert.equal(h.instance.data.visible, false);
      clock.advance(1);
      assert.equal(h.instance.data.visible, true);
      clock.advance(name === 'dialog' ? 399 : 299);
      assert.equal(h.events.length, 0);
      clock.advance(1);
      assert.deepEqual(h.events, [
        {
          name: 'opened',
          detail: { sessionId: 'first', generation: 1 },
          options: isolated,
        },
      ]);
      h.update({ open: false });
      assert.equal(h.instance.data.phase, 'closing');
      assert.equal(h.instance.data.rendered, true);
      assert.equal(h.instance.data.interactionDisabled, true);
      clock.advance(name === 'dialog' ? 400 : 300);
      assert.equal(h.instance.data.rendered, false);
      assert.deepEqual(h.events[1], {
        name: 'closed',
        detail: { sessionId: 'first', generation: 1 },
        options: isolated,
      });
      h.update({ open: false });
      clock.advance(1000);
      assert.equal(h.events.length, 2);
      h.detach();
    }
  }));

test('rapid close/reopen and already queued stale timers cannot close a newer opening or emit stale opened', () =>
  withClock((clock) => {
    for (const name of names) {
      const h = harness(name, { open: true, sessionId: 'first' });
      const initial = clock.ids();
      h.update({ open: false });
      const closing = clock.ids();
      h.update({ open: true, sessionId: 'second' });
      for (const id of [...initial, ...closing]) clock.queued(id);
      clock.advance(1000);
      assert.equal(h.instance.data.phase, 'open');
      assert.equal(h.instance.data.activeSessionId, 'second');
      assert.deepEqual(
        h.events.map((e) => [e.name, e.detail.sessionId]),
        [['opened', 'second']],
      );
      h.update({ open: false });
      const cancelledClose = clock.ids();
      h.update({ open: true });
      for (const id of cancelledClose) clock.queued(id);
      clock.advance(1000);
      assert.equal(h.instance.data.phase, 'open');
      assert.equal(h.events.filter((e) => e.name === 'closed').length, 0);
      assert.equal(h.instance.data.generation, 3);
      h.detach();
    }
  }));

test('page hide and detach cancel all timers, suppress same-session resurrection and never emit stale closed', () =>
  withClock((clock) => {
    for (const name of names) {
      const h = open(name, clock, {
        focus: true,
        mode: 'prompt',
        value: 'owner-draft',
      });
      h.update({ open: false });
      const stale = clock.ids();
      h.hide();
      assert.equal(h.instance.data.rendered, false);
      assert.equal(h.instance.data.editorFocused, false);
      assert.equal(clock.active(), 0);
      for (const id of stale) clock.queued(id);
      h.update({ open: true });
      h.show();
      clock.advance(1000);
      assert.equal(h.instance.data.rendered, false);
      assert.equal(
        h.events.length,
        1,
        'hide never resolves cancellation or confirm',
      );
      assert.equal(
        h.instance.properties.value,
        'owner-draft',
        'owner must clear its own sensitive draft',
      );
      h.update({ sessionId: 'fresh-after-show' });
      clock.advance(1000);
      assert.equal(h.instance.data.phase, 'open');
      h.update({ open: false });
      const detachTimers = clock.ids();
      h.detach();
      const writes = h.writes.length;
      for (const id of detachTimers) clock.queued(id);
      h.update({ sessionId: 'after-detach', open: true, loading: true });
      h.hide();
      h.show();
      clock.advance(1000);
      assert.equal(h.writes.length, writes, 'no renderer writes after detach');
      assert.equal(clock.active(), 0);
      assert.deepEqual(
        h.events.map((e) => e.name),
        ['opened', 'opened'],
      );
    }
  }));

test('hidden opening cancellation and fresh identity written while hidden resume only the fresh session', () =>
  withClock((clock) => {
    const h = harness('dialog', {
      open: true,
      sessionId: 'first',
      mode: 'prompt',
      focus: true,
    });
    const stale = clock.ids();
    h.hide();
    h.update({ open: false });
    h.update({ open: true });
    h.show();
    for (const id of stale) clock.queued(id);
    clock.advance(1000);
    assert.equal(h.instance.data.rendered, false);
    h.hide();
    h.update({ sessionId: 'second' });
    assert.equal(h.instance.data.rendered, false);
    h.show();
    clock.advance(416);
    assert.equal(h.instance.data.editorFocused, true);
    assert.deepEqual(
      h.events.map((e) => e.detail.sessionId),
      ['second'],
    );
    h.detach();
  }));

test('sheet and actions cancellation is isolated, controlled, one-shot and never invokes an action', () =>
  withClock((clock) => {
    for (const name of ['sheet', 'actions'] as const) {
      const h = open(name, clock);
      h.invoke('onBackdrop', h.event());
      h.invoke(name === 'sheet' ? 'onClose' : 'onCancel', h.event());
      h.invoke('onBackdrop', h.event());
      assert.equal(h.instance.properties.open, true);
      assert.equal(h.instance.data.phase, 'open');
      assert.equal(h.instance.data.intentPending, true);
      assert.deepEqual(h.events.slice(1), [
        {
          name: 'requestclose',
          detail: {
            sessionId: 'opening-1',
            generation: 1,
            attemptKey: 0,
            reason: 'backdrop',
          },
          options: isolated,
        },
      ]);
      h.update({ loading: true });
      h.update({ loading: false });
      h.invoke('onBackdrop', h.event());
      assert.equal(h.events.length, 2, 'ordinary props cannot re-arm');
      h.update({ attemptKey: 1, closeByBackdropClick: false });
      h.invoke('onBackdrop', h.event());
      assert.equal(h.events.length, 2);
      h.invoke(name === 'sheet' ? 'onClose' : 'onCancel', h.event());
      assert.equal(
        h.events[2]?.detail.reason,
        name === 'sheet' ? 'close' : 'cancel',
      );
      assert.equal(h.events[2]?.detail.attemptKey, 1);
      assert.equal(
        h.events[1]?.detail.attemptKey,
        0,
        'already-emitted cancellation keeps its captured attempt',
      );
      h.detach();
    }
    const dialog = open('dialog', clock, { mode: 'confirm' });
    dialog.invoke('onConsumeTap', dialog.event());
    assert.equal(dialog.events.length, 1, 'dialog mask cannot cancel/confirm');
    dialog.invoke('onCancel', dialog.event());
    assert.equal(dialog.events[1]?.name, 'requestclose');
    assert.equal(dialog.events[1]?.detail.reason, 'cancel');
    assert.equal(dialog.events[1]?.detail.attemptKey, 0);
    const oldCancel = dialog.event();
    dialog.update({ attemptKey: 1 });
    dialog.invoke('onCancel', oldCancel);
    assert.equal(dialog.events.length, 2);
    dialog.invoke('onCancel', dialog.event());
    assert.equal(dialog.events[2]?.detail.attemptKey, 1);
    assert.equal(dialog.events[1]?.detail.attemptKey, 0);
    dialog.detach();
  }));

test('actions dispatch by current allowlisted identity; disabled, replaced and forged list events fail closed', () =>
  withClock((clock) => {
    const h = open('actions', clock, {
      actions: [
        { id: 'delete', label: '删除', destructive: true },
        { id: 'disabled', label: '不可用', disabled: true },
      ],
    });
    for (const id of ['unknown', 'disabled', '0'])
      h.invoke('onAction', h.event({ id }));
    const stale = h.event({ id: 'delete' });
    h.update({ actions: [{ id: 'delete', label: '新标签' }] });
    h.invoke('onAction', stale);
    assert.equal(h.events.length, 1);
    h.invoke('onAction', h.event({ id: 'delete' }));
    h.invoke('onAction', h.event({ id: 'delete' }));
    h.invoke('onCancel', h.event());
    assert.deepEqual(h.events[1], {
      name: 'action',
      detail: {
        sessionId: 'opening-1',
        generation: 1,
        attemptKey: 0,
        id: 'delete',
      },
      options: isolated,
    });
    assert.equal(h.events.length, 2);
    h.update({
      attemptKey: 1,
      actions: [
        { id: 'duplicate', label: 'A' },
        { id: 'duplicate', label: 'B' },
      ],
    });
    h.invoke('onAction', h.event({ id: 'duplicate' }));
    assert.deepEqual(h.instance.data.items, []);
    assert.equal(h.events.length, 2);
    h.detach();
  }));

test('live disabled/loading guards, invalid attempt keys and mismatched generations block all intents', () =>
  withClock((clock) => {
    for (const name of names) {
      const h = open(name, clock, {
        mode: 'confirm',
        actions: [{ id: 'run', label: 'Run' }],
      });
      const method =
        name === 'sheet'
          ? 'onClose'
          : name === 'actions'
            ? 'onAction'
            : 'onConfirm';
      for (const property of ['disabled', 'loading']) {
        h.update({ [property]: true });
        h.invoke(method, h.event({ id: 'run' }));
        h.update({ [property]: false });
      }
      h.invoke(method, h.event({ id: 'run', generation: 0 }));
      h.invoke(method, h.event({ id: 'run', sessionId: 'wrong' }));
      h.invoke(method, {});
      for (const attemptKey of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        h.update({ attemptKey });
        h.invoke(method, h.event({ id: 'run' }));
      }
      assert.equal(h.events.length, 1);
      h.update({ attemptKey: 0 });
      h.invoke(method, h.event({ id: 'run' }));
      assert.equal(h.events.length, 2);
      h.update({ loading: true });
      h.update({ loading: false });
      h.update({ attemptKey: NaN });
      h.update({ attemptKey: 0 });
      h.invoke(method, h.event({ id: 'run' }));
      assert.equal(
        h.events.length,
        2,
        'invalid attempt key cannot erase the accepted key/latch',
      );
      h.update({ attemptKey: 1 });
      h.invoke(method, h.event({ id: 'run' }));
      assert.equal(h.events.length, 3);
      h.detach();
    }
  }));

test('action latch precedes synchronous owner callbacks, and old events cannot mutate reopened or detached overlays', () =>
  withClock((clock) => {
    const h = open('dialog', clock, { mode: 'confirm' });
    const event = h.event();
    h.onEvent((name) => {
      if (name === 'action') {
        h.invoke('onConfirm', event);
        h.update({ open: false });
      }
    });
    h.invoke('onConfirm', event);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 1);
    assert.equal(h.instance.data.phase, 'closing');
    h.update({ sessionId: 'new', open: true });
    clock.advance(416);
    h.invoke('onConfirm', event);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 1);
    h.onEvent((name) => {
      if (name === 'action') h.detach();
    });
    h.invoke('onConfirm', h.event());
    const writes = h.writes.length;
    h.invoke('onConfirm', h.event());
    clock.advance(1000);
    assert.equal(h.writes.length, writes);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 2);
  }));

test('prompt preserves raw editor input and cursor; keyboard confirm never submits or leaks value in generic actions', () =>
  withClock((clock) => {
    const h = harness('dialog', {
      open: true,
      sessionId: 'prompt-1',
      mode: 'prompt',
      focus: true,
      value: 'owner draft',
    });
    assert.equal(h.instance.data.editorFocused, false);
    h.invoke('onInput', h.event({}, { value: 'opening event' }));
    assert.equal(h.events.length, 0);
    clock.advance(416);
    assert.equal(h.instance.data.editorFocused, true);
    for (const value of ['n', 'ni', '你', ' 你🙂 ']) {
      const writes = h.writes.length;
      assert.equal(
        h.invoke(
          'onInput',
          h.event({}, { value, cursor: 1, keyCode: 229, unrelated: 'discard' }),
        ),
        undefined,
      );
      assert.equal(
        h.writes.length,
        writes,
        'no rewrite of native editor or duplicate value projection',
      );
      assert.deepEqual(h.events[h.events.length - 1], {
        name: 'input',
        detail: { sessionId: 'prompt-1', generation: 1, value, cursor: 1 },
        options: isolated,
      });
    }
    h.invoke('onKeyboardConfirm', h.event({}, { value: 'not forwarded' }));
    assert.deepEqual(h.events[h.events.length - 1], {
      name: 'keyboardconfirm',
      detail: { sessionId: 'prompt-1', generation: 1 },
      options: isolated,
    });
    assert.equal(h.events.filter((e) => e.name === 'action').length, 0);
    h.invoke(
      'onInputFocus',
      h.event({}, { height: 280, value: 'not forwarded' }),
    );
    assert.equal(h.events[h.events.length - 1]?.detail.height, 280);
    h.invoke('onInputBlur', h.event({}, { value: 'not forwarded' }));
    assert.deepEqual(h.events[h.events.length - 1]?.detail, {
      sessionId: 'prompt-1',
      generation: 1,
    });
    h.update({ errorText: '请修改', confirmDisabled: false });
    h.invoke('onConfirm', h.event());
    assert.equal(h.events.filter((e) => e.name === 'action').length, 0);
    h.update({ errorText: '', confirmDisabled: true });
    h.invoke('onConfirm', h.event());
    h.update({ confirmDisabled: false, confirmId: 'unsafe/route' });
    h.invoke('onConfirm', h.event());
    assert.equal(h.events.filter((e) => e.name === 'action').length, 0);
    h.update({ confirmId: 'save' });
    h.invoke('onConfirm', h.event());
    assert.equal(h.instance.data.editorFocused, false);
    assert.deepEqual(h.events[h.events.length - 1]?.detail, {
      sessionId: 'prompt-1',
      generation: 1,
      attemptKey: 0,
      id: 'save',
    });
    assert.equal(h.instance.properties.value, 'owner draft');
    h.detach();
  }));

test('keyboard offset is bounded and safe-area is applied once, with no hidden or pending focus', () =>
  withClock((clock) => {
    const h = open('dialog', clock, { mode: 'prompt', focus: true });
    assert.equal(h.instance.data.useSafeArea, true);
    h.update({ keyboardHeight: 300 });
    assert.equal(h.instance.data.keyboardInset, 300);
    assert.equal(h.instance.data.useSafeArea, false);
    h.update({ keyboardHeight: 1e9 });
    assert.equal(h.instance.data.keyboardInset, 2000);
    for (const keyboardHeight of [-1, NaN, Infinity]) {
      h.update({ keyboardHeight });
      assert.equal(h.instance.data.keyboardInset, 0);
    }
    h.update({ safeAreaBottom: false });
    assert.equal(h.instance.data.useSafeArea, false);
    h.update({ loading: true });
    assert.equal(h.instance.data.editorFocused, false);
    h.update({ loading: false });
    assert.equal(h.instance.data.editorFocused, true);
    h.update({ open: false });
    assert.equal(h.instance.data.editorFocused, false);
    h.hide();
    h.update({ loading: false, focus: true });
    assert.equal(h.instance.data.editorFocused, false);
    h.detach();
  }));

test('native templates retain bounded scroll, isolated surfaces, explicit backdrop defaults and actual 48px dialog buttons', () => {
  for (const name of names) {
    assert.equal(registration(name).options.styleIsolation, 'isolated');
    const template = read(name, 'wxml');
    assert.match(template, /wx:if="\{\{rendered\}\}"/);
    assert.match(template, /<scroll-view[^>]*scroll-y="\{\{true\}\}"/);
    assert.match(template, /aria-role="dialog"/);
    assert.doesNotMatch(template, /<scroll-view[^>]*catchtouchmove/);
    assert.doesNotMatch(template, /^<view[^>]*catchtouchmove/);
    assert.doesNotMatch(
      read(name, 'ts') + template,
      /<rich-text|<web-view|open-type=|form-type=|wx\.|getApp\(|console\.|navigateTo|\.html\(/,
    );
    assert.match(
      read(name, 'wxss'),
      /@import '\.\.\/\.\.\/design\/framework7-ios\.wxss';/,
    );
    assert.match(read(name, 'wxss'), /prefers-reduced-motion/);
    assert.match(read(name, 'ts'), /Framework7 v9\.2\.0/);
  }
  assert.equal(registration('sheet').properties.backdrop!.value, true);
  assert.equal(
    registration('actions').properties.closeByBackdropClick!.value,
    true,
  );
  assert.match(
    read('dialog', 'wxml'),
    /f7-overlay-mask[^>]*catchtap="onConsumeTap"/,
  );
  assert.equal(
    (read('dialog', 'wxml').match(/size="large" round="\{\{true\}\}"/g) ?? [])
      .length,
    2,
  );
  assert.match(read('dialog', 'wxml'), /variant="tonal"/);
  assert.match(
    read('dialog', 'wxml'),
    /variant="fill" tone="\{\{destructive \? 'danger' : 'default'\}\}"/,
  );
  assert.match(
    read('dialog', 'wxml'),
    /<f7-input[^>]*adjust-position="\{\{false\}\}"/,
  );
  assert.match(read('actions', 'wxss'), /@media \(min-width: 496px\)/);
  assert.match(read('actions', 'wxss'), /width: 480px;/);
  assert.match(read('actions', 'wxss'), /white-space: normal;/);
  assert.match(
    read('sheet', 'wxss'),
    /height: var\(--f7-sheet-height, 260px\);/,
  );
  assert.match(read('dialog', 'wxss'), /transform: scale\(1\.185\);/);
});

test('closed waits for native removal acknowledgement and is cancelled by hide, detach or reopen before acknowledgement', () =>
  withClock((clock) => {
    for (const name of names) {
      for (const interruption of ['none', 'hide', 'detach', 'reopen']) {
        const h = open(name, clock);
        h.update({ open: false });
        h.deferRender(true);
        clock.advance(name === 'dialog' ? 400 : 300);
        assert.equal(h.instance.data.rendered, false);
        assert.equal(
          h.events.filter((e) => e.name === 'closed').length,
          0,
          'timer alone cannot release owner reader lease',
        );
        if (interruption === 'hide') h.hide();
        if (interruption === 'detach') h.detach();
        if (interruption === 'reopen')
          h.update({ open: true, sessionId: 'new-opening' });
        h.flushRender();
        assert.equal(
          h.events.filter((e) => e.name === 'closed').length,
          interruption === 'none' ? 1 : 0,
        );
        h.detach();
      }
    }
  }));

test('reattachment keeps monotonic generation and native keyed remounts do not occur on ordinary value edits', () =>
  withClock((clock) => {
    const h = open('dialog', clock, { mode: 'prompt' });
    const old = h.event();
    const keys = structuredClone(h.instance.data.renderKeys);
    h.update({ value: '你🙂', focus: true });
    assert.deepEqual(h.instance.data.renderKeys, keys);
    h.detach();
    h.attach();
    clock.advance(416);
    assert.equal(h.instance.data.generation, 3);
    h.invoke('onConfirm', old);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 0);
    h.invoke('onConfirm', h.event());
    assert.equal(h.events.filter((e) => e.name === 'action').length, 1);
    for (const name of names)
      assert.match(
        read(name, 'wxml'),
        /wx:for="\{\{renderKeys\}\}" wx:key="generation"/,
      );
    h.detach();
  }));

test('attempt rollback cannot re-arm an accepted action or produce stale attempt identities', () =>
  withClock((clock) => {
    const h = open('dialog', clock, { mode: 'confirm', attemptKey: 2 });
    h.invoke('onConfirm', h.event());
    h.update({ attemptKey: 1 });
    h.invoke('onConfirm', h.event());
    h.update({ attemptKey: 2 });
    h.invoke('onConfirm', h.event());
    assert.equal(h.events.filter((e) => e.name === 'action').length, 1);
    h.update({ attemptKey: 3 });
    h.invoke('onConfirm', h.event());
    assert.equal(h.events.filter((e) => e.name === 'action').length, 2);
    assert.equal(h.events[h.events.length - 1]?.detail.attemptKey, 3);
    h.detach();
  }));

test('old rendered hit is rejected after explicit re-arm, including f7-button custom press datasets', () =>
  withClock((clock) => {
    for (const name of names) {
      const h = open(name, clock, {
        mode: 'confirm',
        actions: [{ id: 'run', label: 'Run' }],
      });
      const method =
        name === 'sheet'
          ? 'onClose'
          : name === 'actions'
            ? 'onAction'
            : 'onConfirm';
      const originalHit = h.event({ id: 'run' });
      h.invoke(method, originalHit);
      h.update({ attemptKey: 1 });
      h.invoke(method, originalHit);
      h.invoke(method, h.event({ id: 'run', attemptKey: undefined }));
      assert.equal(
        h.events.filter((e) => e.name === 'action' || e.name === 'requestclose')
          .length,
        1,
        'not a fresh user intent',
      );
      h.invoke(method, h.event({ id: 'run' }));
      assert.equal(
        h.events.filter((e) => e.name === 'action' || e.name === 'requestclose')
          .length,
        2,
      );
      const template = read(name, 'wxml');
      for (const match of template.matchAll(
        /<(?:button|f7-button|f7-input|view)\b[^>]*data-generation="\{\{generation\}\}"[^>]*>/g,
      ))
        assert.match(
          match[0],
          /data-attempt-key="\{\{attemptKey\}\}"/,
          'custom component element owns captured event identity',
        );
      h.detach();
    }
  }));

function nativeChild(
  name: 'button' | 'input',
  properties: Record<string, unknown>,
  onEvent: (name: string, detail: unknown) => void,
) {
  const definition = registration(name);
  const instance: Instance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, prop]) => [
          key,
          structuredClone(prop.value),
        ]),
      ),
      ...properties,
    },
    data: structuredClone(definition.data),
    setData(data, callback) {
      Object.assign(this.data, data);
      callback?.();
    },
    triggerEvent(name, detail, options) {
      assert.deepEqual(options, isolated);
      onEvent(name, detail);
    },
  };
  for (const [key, method] of Object.entries(definition.methods))
    instance[key] = method.bind(instance);
  definition.lifetimes.attached!.call(instance);
  return {
    instance,
    invoke(method: string, event: unknown) {
      return definition.methods[method]!.call(instance, event);
    },
    detach() {
      definition.lifetimes.detached!.call(instance);
    },
  };
}

test('actual f7-button native tap capture cannot launder a stale attempt into a new Dialog press', () =>
  withClock((clock) => {
    const h = open('dialog', clock, { mode: 'confirm' });
    const child = nativeChild(
      'button',
      { interactionKey: h.instance.data.buttonInteractionKey },
      (name, detail) => {
        assert.equal(name, 'press');
        // This intentionally uses current parent-host dataset to exercise the real
        // custom-event relabeling hazard. Captured inner detail must still reject it.
        h.invoke('onConfirm', h.event({}, detail));
      },
    );
    const oldNativeTap = {
      currentTarget: {
        dataset: { interactionKey: child.instance.properties.interactionKey },
      },
    };
    child.invoke('onPress', oldNativeTap);
    h.update({ attemptKey: 1 });
    child.instance.properties.interactionKey =
      h.instance.data.buttonInteractionKey;
    child.invoke('onPress', oldNativeTap);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 1);
    // A queued custom press may also arrive after owner changed but before the
    // child's new props committed. Its captured old key is still rejected.
    child.instance.properties.interactionKey =
      oldNativeTap.currentTarget.dataset.interactionKey;
    child.invoke('onPress', oldNativeTap);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 1);
    child.instance.properties.interactionKey =
      h.instance.data.buttonInteractionKey;
    const fresh = {
      currentTarget: {
        dataset: { interactionKey: child.instance.properties.interactionKey },
      },
    };
    child.invoke('onPress', fresh);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 2);
    h.update({ attemptKey: 2 });
    child.detach();
    child.invoke('onPress', fresh);
    assert.equal(h.events.filter((e) => e.name === 'action').length, 2);
    h.detach();
  }));

test('actual button capture protects changed confirmId and mode, not only host generation/attempt', () =>
  withClock((clock) => {
    for (const change of [{ confirmId: 'delete' }, { mode: 'prompt' }]) {
      const h = open('dialog', clock, { mode: 'confirm', confirmId: 'save' });
      const child = nativeChild(
        'button',
        { interactionKey: h.instance.data.buttonInteractionKey },
        (_name, detail) => h.invoke('onConfirm', h.event({}, detail)),
      );
      const old = {
        currentTarget: {
          dataset: { interactionKey: child.instance.properties.interactionKey },
        },
      };
      h.update(change);
      // Original native tap with old child props; owner rejects its old semantic key.
      child.invoke('onPress', old);
      assert.equal(h.events.filter((e) => e.name === 'action').length, 0);
      child.instance.properties.interactionKey =
        h.instance.data.buttonInteractionKey;
      child.invoke('onPress', old);
      assert.equal(h.events.filter((e) => e.name === 'action').length, 0);
      child.invoke('onPress', {
        currentTarget: {
          dataset: { interactionKey: child.instance.properties.interactionKey },
        },
      });
      assert.equal(h.events.filter((e) => e.name === 'action').length, 1);
      assert.equal(
        h.events[h.events.length - 1]?.detail.id,
        change.confirmId ?? 'save',
      );
      child.detach();
      h.detach();
    }
  }));

test('explicit rearm replaces prompt editor only; actual detached f7-input rejects old native events', () =>
  withClock((clock) => {
    const h = open('dialog', clock, { mode: 'prompt', value: 'draft' });
    const child = nativeChild('input', { value: 'draft' }, (_name, detail) =>
      h.invoke('onInput', h.event({}, detail)),
    );
    const originalKeys = structuredClone(h.instance.data.editorKeys);
    const oldNativeInput = { detail: { value: 'old draft', cursor: 2 } };
    child.invoke('onInput', oldNativeInput);
    const queuedCustomInput = h.event(
      {},
      { value: 'old queued draft', cursor: 2 },
    );
    h.update({ value: 'new owner draft', errorText: 'Correct value' });
    assert.deepEqual(
      h.instance.data.editorKeys,
      originalKeys,
      'ordinary draft/error updates preserve cursor/editor identity',
    );
    h.update({ attemptKey: 1 });
    assert.notDeepEqual(h.instance.data.editorKeys, originalKeys);
    assert.equal(
      h.instance.data.generation,
      1,
      'owner close lease generation stays stable',
    );
    assert.match(
      read('dialog', 'wxml'),
      /wx:for="\{\{editorKeys\}\}" wx:key="key"/,
    );
    // WXML keyed removal invokes the actual previous f7-input detached lifecycle.
    child.detach();
    const count = h.events.filter((e) => e.name === 'input').length;
    child.invoke('onInput', oldNativeInput);
    h.invoke('onInput', queuedCustomInput);
    assert.equal(h.events.filter((e) => e.name === 'input').length, count);
    const replacement = nativeChild(
      'input',
      { value: h.instance.properties.value },
      (_name, detail) => h.invoke('onInput', h.event({}, detail)),
    );
    replacement.invoke('onInput', {
      detail: { value: '新的草稿🙂', cursor: 4 },
    });
    assert.equal(h.events.filter((e) => e.name === 'input').length, count + 1);
    replacement.detach();
    h.detach();
  }));

test('late native mount/closing acknowledgements cannot start new timers after hide or detach', () =>
  withClock((clock) => {
    for (const stage of ['mount', 'closing']) {
      const h = stage === 'mount' ? harness('dialog') : open('dialog', clock);
      h.deferRender(true);
      h.update(
        stage === 'mount'
          ? { open: true, sessionId: 'pending-mount' }
          : { open: false },
      );
      h.hide();
      h.flushRender();
      assert.equal(clock.active(), 0);
      h.detach();
      h.flushRender();
      clock.advance(1000);
      assert.equal(h.events.filter((e) => e.name === 'closed').length, 0);
      assert.equal(
        h.events.filter((e) => e.name === 'opened').length,
        stage === 'mount' ? 0 : 1,
      );
    }
  }));
