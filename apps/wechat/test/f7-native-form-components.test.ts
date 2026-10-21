import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  editorPresentation,
  inputDetail,
  inputPresentation,
  type NativeEditorProperties,
} from '../src/components/f7-input/model';

type Name = 'input' | 'searchbar' | 'toggle';
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
  setData(data: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
const root = path.join(__dirname, '../src');
const read = (name: Name, extension: string) =>
  readFileSync(
    path.join(root, `components/f7-${name}/f7-${name}.${extension}`),
    'utf8',
  );
function registration(name: Name): Definition {
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
function harness(name: Name, initial: Record<string, unknown> = {}) {
  const definition = registration(name);
  const events: { name: string; detail: unknown; options: unknown }[] = [];
  const writes: Record<string, unknown>[] = [];
  let onEvent: (() => void) | undefined;
  const instance: Instance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, value]) => [
          key,
          value.value,
        ]),
      ),
      ...initial,
    },
    data: structuredClone(definition.data),
    setData(data) {
      writes.push(structuredClone(data));
      Object.assign(this.data, data);
    },
    triggerEvent(name, detail, options) {
      events.push({
        name,
        detail: structuredClone(detail),
        options: structuredClone(options),
      });
      onEvent?.();
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
    onEvent(callback: () => void) {
      onEvent = callback;
    },
    hide: () => definition.pageLifetimes.hide!.call(instance),
    show: () => definition.pageLifetimes.show!.call(instance),
    detach: () => definition.lifetimes.detached!.call(instance),
  };
}
function attribute(template: string, attribute: string, context: object) {
  const raw = new RegExp(`\\b${attribute}="([^"]*)"`).exec(template)?.[1];
  assert.notEqual(raw, undefined, attribute);
  return raw!.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression: string) =>
    String(vm.runInNewContext(expression, context)),
  );
}
const isolated = { bubbles: false, composed: false };
const values: NativeEditorProperties = {
  value: '',
  disabled: false,
  readOnly: false,
  clearable: false,
  maxlength: 140,
  cursorSpacing: 0,
  selectionStart: -1,
  selectionEnd: -1,
};

test('native input type, password and confirm capabilities are bounded without unmasking unsupported password types', () => {
  for (const type of ['text', 'number', 'digit', 'idcard']) {
    assert.equal(inputPresentation(type, false, 'done').nativeType, type);
    assert.equal(
      inputPresentation(type, true, 'done').nativeType,
      type === 'number' ? 'number' : 'text',
    );
  }
  for (const type of [
    'email',
    'tel',
    'password',
    'safe-password',
    'nickname',
    '',
    '<unsafe>',
    null,
  ])
    assert.equal(inputPresentation(type, false, 'unknown').nativeType, 'text');
  for (const confirm of ['done', 'send', 'search', 'next', 'go'])
    assert.equal(
      inputPresentation('text', false, confirm).nativeConfirmType,
      confirm,
    );
  assert.equal(
    inputPresentation('text', false, 'submit').nativeConfirmType,
    'done',
  );
  const h = harness('input', {
    type: 'digit',
    password: true,
    confirmType: 'search',
  });
  assert.equal(h.instance.data.nativeType, 'text');
  assert.equal(h.instance.data.nativeConfirmType, 'search');
  h.update({ type: 'number', confirmType: 'next' });
  assert.equal(h.instance.data.nativeType, 'number');
  h.update({ password: false, type: 'idcard', confirmType: 'unsafe' });
  assert.equal(h.instance.data.nativeType, 'idcard');
  assert.equal(h.instance.data.nativeConfirmType, 'done');
  assert.equal(h.events.length, 0);
});

test('maxlength, cursor spacing and selection use native sentinels, no falsy coercion or JavaScript truncation', () => {
  for (const maxlength of [-1, 0, 1, 140, 200])
    assert.equal(
      editorPresentation({ ...values, maxlength }).nativeMaxlength,
      maxlength,
    );
  for (const maxlength of [-2, 2.5, Infinity, NaN])
    assert.equal(
      editorPresentation({ ...values, maxlength }).nativeMaxlength,
      140,
    );
  assert.deepEqual(
    editorPresentation({
      ...values,
      cursorSpacing: -1,
      selectionStart: -5,
      selectionEnd: Infinity,
    }),
    {
      nativeMaxlength: 140,
      nativeCursorSpacing: 0,
      nativeSelectionStart: -1,
      nativeSelectionEnd: -1,
    },
  );
  for (const name of ['input', 'searchbar'] as const) {
    const h = harness(name);
    h.update({
      maxlength: -1,
      cursorSpacing: 12.5,
      selectionStart: 0,
      selectionEnd: 4,
    });
    assert.equal(h.instance.data.nativeMaxlength, -1);
    assert.equal(h.instance.data.nativeCursorSpacing, 12.5);
    assert.equal(h.instance.data.nativeSelectionStart, 0);
    assert.equal(h.instance.data.nativeSelectionEnd, 4);
    assert.equal(h.events.length, 0);
  }
});

test('actual input/searchbar methods preserve native Chinese, emoji and in-progress editing without IME inference', () => {
  for (const name of ['input', 'searchbar'] as const) {
    const h = harness(name, { maxlength: 1 });
    const initial = structuredClone(h.instance.properties);
    const writes = h.writes.length;
    const drafts = ['n', 'ni', '你', ' 你🙂 ', ''];
    for (const [cursor, value] of drafts.entries()) {
      assert.equal(
        h.invoke('onInput', {
          detail: {
            value,
            cursor,
            keyCode: 229,
            isComposing: true,
            unrelated: 'not forwarded',
          },
        }),
        undefined,
      );
      assert.deepEqual(h.events[h.events.length - 1], {
        name: 'input',
        detail: { value, cursor },
        options: isolated,
      });
    }
    assert.deepEqual(h.instance.properties, initial);
    assert.equal(
      h.writes.length,
      writes,
      'no setData on native editor value or cursor during input',
    );
    assert.equal(
      h.events.length,
      drafts.length,
      'input cannot implicitly confirm',
    );
    h.invoke('onConfirm', { detail: { value: ' 你🙂 ' } });
    assert.deepEqual(h.events[h.events.length - 1], {
      name: 'confirm',
      detail: { value: ' 你🙂 ' },
      options: isolated,
    });
    assert.equal(h.instance.properties.value, '');
  }
});

test('native event projection rejects malformed detail and does not leak extra native event fields', () => {
  for (const event of [
    undefined,
    null,
    true,
    {},
    { detail: null },
    { detail: { value: 1 } },
  ]) {
    assert.equal(inputDetail(event), null);
    for (const name of ['input', 'searchbar'] as const) {
      const h = harness(name);
      for (const method of ['onInput', 'onBlur', 'onConfirm'])
        h.invoke(method, event);
      assert.equal(h.events.length, 0);
    }
  }
  assert.deepEqual(
    inputDetail({ detail: { value: '原文', cursor: -1, keyCode: 229 } }),
    { value: '原文' },
  );
  assert.deepEqual(inputDetail({ detail: { value: '原文', cursor: NaN } }), {
    value: '原文',
  });
  assert.deepEqual(inputDetail({ detail: { value: '原文', cursor: 0 } }), {
    value: '原文',
    cursor: 0,
  });
});

test('focus and blur are isolated observations and never change owner focus or value', () => {
  for (const name of ['input', 'searchbar'] as const) {
    const h = harness(name, { focus: true, value: '原文' });
    h.invoke('onFocus', {
      detail: { value: '原文', height: 280, unrelated: 'omit' },
    });
    assert.equal(h.instance.data.focused, true);
    assert.deepEqual(h.events[h.events.length - 1], {
      name: 'focus',
      detail: { height: 280 },
      options: isolated,
    });
    h.invoke('onBlur', { detail: { value: '新文', cursor: 1 } });
    assert.equal(h.instance.data.focused, false);
    assert.deepEqual(h.events[h.events.length - 1], {
      name: 'blur',
      detail: { value: '新文' },
      options: isolated,
    });
    assert.equal(h.instance.properties.focus, true);
    assert.equal(h.instance.properties.value, '原文');
    h.invoke('onFocus', { detail: { height: -100 } });
    assert.deepEqual(h.events[h.events.length - 1]?.detail, {});
  }
});

test('clear is one controlled proposal, never a second input/submit or implicit focus request', () => {
  for (const name of ['input', 'searchbar'] as const) {
    const h = harness(name, { value: '旧查询', clearable: true });
    const writes = h.writes.length;
    h.invoke('onClear');
    assert.deepEqual(h.events, [
      { name: 'clear', detail: { value: '' }, options: isolated },
    ]);
    assert.equal(h.instance.properties.value, '旧查询');
    assert.equal(h.instance.properties.focus, false);
    assert.equal(h.writes.length, writes);
    h.update({ value: '' });
    h.invoke('onClear');
    assert.equal(h.events.length, 1);
    h.invoke('onInput', { detail: { value: '新查询', cursor: 3 } });
    h.update({ value: '新查询' });
    h.invoke('onConfirm', { detail: { value: '新查询' } });
    assert.deepEqual(
      h.events.map((event) => event.name),
      ['clear', 'input', 'confirm'],
    );
    h.update({ clearable: false });
    h.invoke('onClear');
    assert.equal(h.events.length, 3);
  }
});

test('live disabled/readOnly properties block forged input/focus/blur/confirm/clear/cancel and clear focus presentation', () => {
  for (const name of ['input', 'searchbar'] as const)
    for (const guard of ['disabled', 'readOnly']) {
      const h = harness(name, {
        value: '内容',
        clearable: true,
        showCancel: true,
      });
      h.invoke('onFocus', { detail: { height: 200 } });
      h.update({ [guard]: true });
      assert.equal(h.instance.data.focused, false);
      const count = h.events.length;
      for (let i = 0; i < 2; i++) {
        for (const method of [
          'onInput',
          'onFocus',
          'onBlur',
          'onConfirm',
          'onClear',
        ])
          h.invoke(method, { detail: { value: '新内容', height: 200 } });
        if (name === 'searchbar') h.invoke('onCancel');
      }
      assert.equal(h.events.length, count);
      h.update({ [guard]: false });
      h.invoke('onInput', { detail: { value: '恢复' } });
      assert.equal(h.events.length, count + 1);
    }
});

test('hidden/detached editors ignore late events and resume only on show; detached events make no view writes', () => {
  for (const name of ['input', 'searchbar'] as const) {
    const h = harness(name, {
      value: '内容',
      clearable: true,
      showCancel: true,
    });
    h.hide();
    for (const method of [
      'onInput',
      'onFocus',
      'onBlur',
      'onConfirm',
      'onClear',
    ])
      h.invoke(method, { detail: { value: '迟到内容' } });
    if (name === 'searchbar') h.invoke('onCancel');
    assert.equal(h.events.length, 0);
    assert.equal(h.instance.data.focused, false);
    h.show();
    h.invoke('onInput', { detail: { value: '恢复内容' } });
    assert.equal(h.events.length, 1);
    h.detach();
    const writes = h.writes.length;
    for (const method of [
      'onInput',
      'onFocus',
      'onBlur',
      'onConfirm',
      'onClear',
    ])
      h.invoke(method, { detail: { value: '卸载后' } });
    h.show();
    h.hide();
    assert.equal(h.events.length, 1);
    assert.equal(h.writes.length, writes);
  }
});

test('searchbar cancellation is distinct from query clear, submit and navigation', () => {
  const h = harness('searchbar', { value: '查询', focus: true });
  h.invoke('onCancel');
  assert.equal(h.events.length, 0);
  h.update({ showCancel: true });
  h.invoke('onCancel');
  assert.deepEqual(h.events, [
    { name: 'cancel', detail: {}, options: isolated },
  ]);
  assert.equal(h.instance.properties.value, '查询');
  assert.equal(h.instance.properties.focus, true);
  assert.equal(h.instance.data.focused, false);
  assert.match(read('searchbar', 'wxml'), /type="text"/);
  assert.match(read('searchbar', 'wxml'), /confirm-type="search"/);
});

test('native toggle proposes a boolean change, resets native projection first and never changes owner visual state', () => {
  const h = harness('toggle');
  h.invoke('onChange', { detail: { value: true } });
  assert.deepEqual(h.events, [
    { name: 'change', detail: { value: true }, options: isolated },
  ]);
  assert.equal(h.instance.properties.checked, false);
  assert.equal(h.instance.data.nativeChecked, false);
  h.update({ checked: true });
  assert.equal(h.instance.data.nativeChecked, true);
  assert.equal(h.events.length, 1, 'owner property changes do not emit');
  h.invoke('onChange', { detail: { value: true } });
  assert.equal(h.events.length, 1, 'same-as-owner native events do not emit');
  h.invoke('onChange', { detail: { value: false } });
  assert.equal(h.events.length, 2);
  assert.equal(h.instance.properties.checked, true);
  assert.equal(h.instance.data.nativeChecked, true);
  for (const value of [null, undefined, 1, 0, 'true', {}, []])
    h.invoke('onChange', { detail: { value } });
  h.invoke('onChange', null);
  assert.equal(h.events.length, 2);
});

test('toggle synchronous owner acceptance wins; no stale callback or detached reset can override it', () => {
  const h = harness('toggle');
  h.onEvent(() => h.update({ checked: true }));
  h.invoke('onChange', { detail: { value: true } });
  assert.equal(h.instance.properties.checked, true);
  assert.equal(h.instance.data.nativeChecked, true);
  h.onEvent(() => h.detach());
  h.invoke('onChange', { detail: { value: false } });
  assert.equal(h.instance.data.mounted, false);
  const writes = h.writes.length;
  h.invoke('onChange', { detail: { value: false } });
  h.show();
  h.hide();
  assert.equal(h.writes.length, writes);
  assert.equal(h.events.length, 2);
});

test('toggle live guards suppress repeated forged changes and reconcile on page hide/show', () => {
  for (const guard of ['disabled', 'readOnly']) {
    const h = harness('toggle');
    h.update({ [guard]: true });
    h.invoke('onChange', { detail: { value: true } });
    h.invoke('onChange', { detail: { value: true } });
    assert.equal(h.events.length, 0);
    assert.equal(h.instance.data.nativeChecked, false);
    h.update({ [guard]: false });
    h.hide();
    h.invoke('onChange', { detail: { value: true } });
    assert.equal(h.events.length, 0);
    h.update({ checked: true });
    h.show();
    assert.equal(h.instance.data.nativeChecked, true);
    h.invoke('onChange', { detail: { value: false } });
    assert.equal(h.events.length, 1);
  }
});

test('native form templates isolate events, preserve real controls and cannot acquire DOM/authorization/network capabilities', () => {
  for (const name of ['input', 'searchbar', 'toggle'] as const) {
    assert.equal(registration(name).options.styleIsolation, 'isolated');
    assert.deepEqual(JSON.parse(read(name, 'json')), { component: true });
    const source = read(name, 'ts') + read(name, 'wxml');
    assert.doesNotMatch(
      source,
      /<web-view|<rich-text|<html|<div|\bopen-type=|\bform-type=|\burl=|wx\.|getApp\(|navigateTo|console\.|setTimeout|storage|request\(/,
    );
    assert.match(
      read(name, 'wxss'),
      /@import '\.\.\/\.\.\/design\/framework7-ios\.wxss';/,
    );
    assert.match(read(name, 'ts'), /Framework7 v9\.2\.0/);
    assert.match(read(name, 'wxss'), /Copyright \(c\) 2014 Vladimir/);
    assert.match(
      read(name, 'wxss'),
      /docs\/vendor\/framework7-v9\.2\.0\/LICENSE/,
    );
  }
  for (const name of ['input', 'searchbar'] as const) {
    const h = harness(name, { value: '原文', focus: true });
    const template = read(name, 'wxml');
    assert.match(template, /<view[^>]*catchtap="onConsumeTap"/);
    const writesBeforeTap = h.writes.length;
    h.invoke('onConsumeTap');
    assert.equal(h.writes.length, writesBeforeTap);
    assert.deepEqual(h.events, []);
    for (const event of ['input', 'focus', 'blur', 'confirm'])
      assert.match(template, new RegExp(`catch${event}="on`));
    assert.match(template, /<input\b/);
    assert.match(template, /value="\{\{value\}\}"/);
    assert.doesNotMatch(template, /composition|bindinput|readonly=/);
    assert.equal(
      attribute(template, 'focus', {
        ...h.instance.properties,
        ...h.instance.data,
      }),
      'true',
    );
    h.hide();
    assert.equal(
      attribute(template, 'focus', {
        ...h.instance.properties,
        ...h.instance.data,
      }),
      'false',
    );
    h.show();
    h.update({ readOnly: true });
    assert.equal(
      attribute(template, 'disabled', {
        ...h.instance.properties,
        ...h.instance.data,
      }),
      'true',
    );
    assert.equal(
      attribute(template, 'focus', {
        ...h.instance.properties,
        ...h.instance.data,
      }),
      'false',
    );
  }
  const toggle = read('toggle', 'wxml');
  assert.match(toggle, /<label\b/);
  assert.equal((toggle.match(/<switch\b/g) ?? []).length, 1);
  assert.match(toggle, /checked="\{\{nativeChecked\}\}"/);
  assert.match(toggle, /\{\{checked \? 'f7-toggle-checked'/);
  assert.match(toggle, /aria-hidden="true"/);
  assert.match(toggle, /catchchange="onChange"/);
  assert.match(
    toggle,
    /<label[^>]*catchtap="onConsumeTap"/,
    'native tap is consumed independently of the isolated change event',
  );
});

test('toggle consumes row taps without creating duplicate setting changes', () => {
  const h = harness('toggle');
  const before = h.writes.length;
  h.invoke('onConsumeTap', { detail: { value: true } });
  assert.equal(h.writes.length, before);
  assert.deepEqual(h.events, []);
  h.invoke('onChange', { detail: { value: true } });
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0], {
    name: 'change',
    detail: { value: true },
    options: { bubbles: false, composed: false },
  });
  h.hide();
  h.invoke('onConsumeTap');
  assert.equal(h.events.length, 1);
});

test('source-specific native toggle/searchbar geometry, 44px hit areas and reduced motion remain explicit', () => {
  const toggle = read('toggle', 'wxss');
  assert.match(toggle, /width: 38px;/);
  assert.match(toggle, /height: calc\(var\(--f7-toggle-height\) - 4px\);/);
  assert.match(
    toggle,
    /translateX\(calc\(var\(--f7-toggle-width\) - 38px - 4px\)\)/,
  );
  assert.match(toggle, /transition: transform 300ms;/);
  assert.match(toggle, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(toggle, /opacity: 0;/);
  assert.doesNotMatch(
    toggle,
    /display: none|visibility: hidden|:has\([^)]*\)\s*\{/,
  );
  assert.match(toggle, /min-height: 44px;/);
  const search = read('searchbar', 'wxss');
  assert.match(search, /width: 13px;/);
  assert.match(search, /left: 16px;/);
  assert.match(search, /margin: 0 0 0 16px;/);
  assert.match(search, /padding: 0 12px;/);
  assert.equal(
    (
      search.match(/background: var\(--wu-f7-searchbar-native-surface\);/g) ??
      []
    ).length,
    2,
    'input and cancel use the explicit opaque native fallback',
  );
  assert.match(read('input', 'wxss'), /height: var\(--f7-input-height\);/);
  assert.match(read('input', 'wxss'), /min-height: 44px;/);
});
