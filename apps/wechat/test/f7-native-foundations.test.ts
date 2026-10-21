import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

type ComponentName = 'button' | 'block' | 'list' | 'list-item';
interface NativeDefinition {
  options: { multipleSlots: boolean; styleIsolation: string };
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, (this: NativeInstance, event?: unknown) => void>;
  lifetimes?: Record<string, (this: NativeInstance) => void>;
  pageLifetimes?: Record<string, (this: NativeInstance) => void>;
}
interface NativeInstance {
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  triggerEvent(
    name: string,
    detail?: unknown,
    options?: { bubbles?: boolean; composed?: boolean },
  ): void;
}
const sourceRoot = path.join(__dirname, '../src');
const source = (name: ComponentName, extension: string) =>
  readFileSync(
    path.join(sourceRoot, `components/f7-${name}/f7-${name}.${extension}`),
    'utf8',
  );
const theme = readFileSync(
  path.join(sourceRoot, 'design/framework7-ios.wxss'),
  'utf8',
);
const lightTheme = theme.split('@media (prefers-color-scheme: dark)')[0]!;

function definition(name: ComponentName): NativeDefinition {
  let captured: NativeDefinition | undefined;
  const output = ts.transpileModule(source(name, 'ts'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  // Execute actual registration/method code, without wx, network, navigation,
  // HTML, a renderer, build outputs, or business-controller substitutes.
  vm.runInNewContext(output, {
    Component: (value: NativeDefinition) => {
      assert.equal(captured, undefined);
      captured = value;
    },
  });
  assert.ok(captured);
  return captured;
}

function harness(name: ComponentName) {
  const config = definition(name);
  const events: {
    name: string;
    detail?: unknown;
    options?: { bubbles?: boolean; composed?: boolean };
  }[] = [];
  const instance: NativeInstance = {
    properties: Object.fromEntries(
      Object.entries(config.properties).map(([key, value]) => [
        key,
        value.value,
      ]),
    ),
    data: structuredClone(config.data),
    triggerEvent(name, detail, options) {
      events.push({
        name,
        detail: structuredClone(detail),
        ...(options ? { options: structuredClone(options) } : {}),
      });
    },
  };
  return {
    config,
    instance,
    events,
    press: () => config.methods.onPress?.call(instance),
  };
}

function renderedAttribute(
  template: string,
  attribute: string,
  values: Record<string, unknown>,
) {
  const raw = new RegExp(`\\b${attribute}="([^"]*)"`).exec(template)?.[1];
  assert.notEqual(raw, undefined, attribute);
  return raw!.replace(/\{\{([\s\S]*?)\}\}/g, (_, expression: string) =>
    String(vm.runInNewContext(expression, values)),
  );
}

test('F7 button emits only a bounded non-bubbling press and rechecks live disabled/loading properties', () => {
  const h = harness('button');
  const initial = structuredClone(h.instance.data);
  h.press();
  assert.deepEqual(h.events, [
    {
      name: 'press',
      detail: {},
      options: { bubbles: false, composed: false },
    },
  ]);
  for (const [disabled, loading] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    h.instance.properties.disabled = disabled;
    h.instance.properties.loading = loading;
    h.press();
    h.press();
    assert.equal(h.events.length, 1);
  }
  h.instance.properties.disabled = false;
  h.instance.properties.loading = false;
  h.press();
  assert.equal(h.events.length, 2);
  assert.deepEqual(h.instance.data, initial);
  assert.match(source('button', 'wxml'), /<button\b/);
  assert.match(
    source('button', 'wxml'),
    /disabled="\{\{disabled \|\| loading\}\}"/,
  );
  assert.match(source('button', 'wxml'), /catchtap="onPress"/);
  assert.match(source('button', 'wxml'), /aria-busy="\{\{loading\}\}"/);
  assert.doesNotMatch(source('button', 'wxml'), /\bbind(?::?tap|:press)=/);
});

test('F7 list-item emits no event when static, disabled or loading and resumes only for a live enabled link', () => {
  const h = harness('list-item');
  h.press();
  assert.deepEqual(h.events, []);
  h.instance.properties.link = true;
  h.press();
  assert.deepEqual(h.events, [
    {
      name: 'press',
      detail: {},
      options: { bubbles: false, composed: false },
    },
  ]);
  for (const [link, disabled, loading] of [
    [false, false, false],
    [true, true, false],
    [true, false, true],
    [true, true, true],
  ]) {
    Object.assign(h.instance.properties, { link, disabled, loading });
    h.press();
    h.press();
    assert.equal(h.events.length, 1);
  }
  Object.assign(h.instance.properties, {
    link: true,
    disabled: false,
    loading: false,
  });
  h.press();
  assert.equal(h.events.length, 2);
  const template = source('list-item', 'wxml');
  const root = /<view\b[^>]*>/.exec(template)?.[0];
  assert.ok(root);
  assert.doesNotMatch(root, /\b(?:catch|bind)(?::?tap)=/);
  assert.equal((template.match(/catchtap=/g) ?? []).length, 1);
  assert.match(template, /<button\s+wx:if="\{\{link\}\}"/);
  assert.match(template, /disabled="\{\{disabled \|\| loading\}\}"/);
  assert.match(source('list-item', 'ts'), /PRESENTATIONAL/);
});

test('guarded button forwards original native interaction identity and rejects stale or inactive taps', () => {
  const h = harness('button');
  assert.match(
    source('button', 'wxml'),
    /data-interaction-key="\{\{interactionKey\}\}"/,
  );
  const hit = (interactionKey: unknown) => ({
    currentTarget: { dataset: { interactionKey } },
  });
  const press = (event?: unknown) =>
    h.config.methods.onPress!.call(h.instance, event);
  h.instance.properties.interactionKey = '6:dialog:1:0';
  press();
  press(hit('old'));
  assert.equal(h.events.length, 0);
  press(hit('6:dialog:1:0'));
  assert.deepEqual(h.events[0]!.detail, {
    interactionKey: '6:dialog:1:0',
  });
  h.instance.properties.interactionKey = '6:dialog:1:1';
  press(hit('6:dialog:1:0'));
  assert.equal(h.events.length, 1);
  h.config.pageLifetimes!.hide!.call(h.instance);
  press(hit('6:dialog:1:1'));
  assert.equal(h.events.length, 1);
  h.config.pageLifetimes!.show!.call(h.instance);
  press(hit('6:dialog:1:1'));
  assert.equal(h.events.length, 2);
  h.config.lifetimes!.detached!.call(h.instance);
  h.config.pageLifetimes!.show!.call(h.instance);
  press(hit('6:dialog:1:1'));
  assert.equal(h.events.length, 2);
  for (const invalid of ['x'.repeat(513), 'bad key', '<script>']) {
    const invalidButton = harness('button');
    invalidButton.instance.properties.interactionKey = invalid;
    invalidButton.config.methods.onPress!.call(
      invalidButton.instance,
      hit(invalid),
    );
    assert.equal(invalidButton.events.length, 0);
  }
});

test('F7 danger tone is bounded presentation and retains press authorization guards', () => {
  const h = harness('button');
  for (const tone of ['danger', 'default', '', 'danger arbitrary-class']) {
    h.instance.properties.tone = tone;
    const classes = renderedAttribute(source('button', 'wxml'), 'class', {
      ...h.instance.properties,
    });
    assert.equal(classes.includes('f7-button-danger'), tone === 'danger');
    assert.doesNotMatch(classes, /arbitrary-class/);
  }
  h.instance.properties.tone = 'danger';
  h.instance.properties.disabled = true;
  h.press();
  h.instance.properties.disabled = false;
  h.instance.properties.loading = true;
  h.press();
  assert.equal(h.events.length, 0);
  h.instance.properties.loading = false;
  h.press();
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.events[0]!.detail, {});
  const css = source('button', 'wxss');
  assert.match(css, /--f7-theme-color: #ff3b30;/);
  assert.match(css, /--f7-theme-color-shade: #ff1407;/);
  assert.match(css, /--f7-theme-color-tint: #ff6259;/);
});

test('F7 button variants and sizes whitelist exact supported classes; unknown strings are inert defaults', () => {
  const h = harness('button');
  const template = source('button', 'wxml');
  for (const variant of ['plain', 'fill', 'outline', 'tonal'])
    for (const size of ['normal', 'small', 'large']) {
      const classes = renderedAttribute(template, 'class', {
        ...h.instance.properties,
        variant,
        size,
      });
      assert.ok(classes.includes(`f7-button-${variant}`));
      assert.ok(classes.includes(`f7-button-${size}`));
    }
  for (const unknown of [
    '',
    'danger',
    'large" open-type="getPhoneNumber',
    '<b>x</b>',
  ]) {
    const classes = renderedAttribute(template, 'class', {
      ...h.instance.properties,
      variant: unknown,
      size: unknown,
    });
    assert.ok(classes.includes('f7-button-plain'));
    assert.ok(classes.includes('f7-button-normal'));
    assert.doesNotMatch(classes, /danger|open-type|<b>/);
  }
});

test('F7 isolated components compose named/default slots and cannot acquire login, routes or HTML capabilities', () => {
  for (const name of ['button', 'block', 'list', 'list-item'] as const) {
    const config = definition(name);
    assert.equal(config.options.multipleSlots, true);
    assert.equal(config.options.styleIsolation, 'isolated');
    assert.deepEqual(JSON.parse(source(name, 'json')), { component: true });
    assert.match(source(name, 'wxml'), /<slot\s*\/>/);
    assert.match(
      source(name, 'wxss'),
      /@import '\.\.\/\.\.\/design\/framework7-ios\.wxss';/,
    );
    assert.match(source(name, 'wxml'), /class="f7-ios-theme\b/);
    assert.doesNotMatch(
      source(name, 'ts') + source(name, 'wxml'),
      /<web-view|<rich-text|<html|<div|\bopen-type=|\bform-type=|\burl=|wx\.|getApp\(|navigateTo|login\(|request\(/,
    );
  }
  for (const name of ['block', 'list'] as const) {
    const h = harness(name);
    assert.equal(h.instance.properties.strong, false);
    assert.equal(h.instance.properties.inset, false);
    assert.equal(h.instance.properties.outline, false);
    assert.equal(h.instance.properties.titleSlot, false);
    assert.equal(h.instance.properties.footerSlot, false);
    assert.equal(h.instance.properties.spacing, 'default');
    assert.match(source(name, 'wxml'), /wx:if="\{\{title \|\| titleSlot\}\}"/);
    assert.match(
      source(name, 'wxml'),
      /wx:if="\{\{footer \|\| footerSlot\}\}"/,
    );
    for (const slot of ['title', 'footer'])
      assert.ok(source(name, 'wxml').includes(`name="${slot}"`));
    assert.deepEqual(Object.keys(h.config.methods), []);
    for (const spacing of ['default', 'compact', '<unsafe>', 'tiny']) {
      const className = renderedAttribute(source(name, 'wxml'), 'class', {
        ...h.instance.properties,
        spacing,
      });
      assert.equal(
        className.includes(`f7-${name}-spacing-compact`),
        spacing === 'compact',
      );
      assert.doesNotMatch(className, /unsafe|tiny/);
    }
  }
  for (const slot of ['media', 'title', 'after', 'footer'])
    assert.ok(source('list-item', 'wxml').includes(`name="${slot}"`));
});

test('F7 list links expose full fallback labels or explicit slot descriptions, without hidden-text HTML', () => {
  const h = harness('list-item');
  const template = source('list-item', 'wxml');
  const values = {
    ...h.instance.properties,
    title: '校园目录',
    subtitle: '学生组织',
    after: '12',
    text: '查看可访问的条目',
  };
  assert.equal(
    renderedAttribute(template, 'aria-label', values),
    '校园目录，学生组织，12，查看可访问的条目',
  );
  assert.equal(
    renderedAttribute(template, 'aria-label', {
      ...values,
      ariaLabel: '打开校园目录，12 条',
    }),
    '打开校园目录，12 条',
  );
  assert.match(template, /aria-hidden="\{\{link\}\}"/);
});

test('F7 native loader uses the exact eight iOS spokes and does not gray a merely loading button', () => {
  for (const name of ['button', 'list-item'] as const) {
    const h = harness(name);
    assert.deepEqual(
      h.instance.data.spokes,
      Array.from({ length: 8 }, (_, index) => ({
        angle: index * 45,
        opacity: 0.27 + ((0.85 - 0.27) * index) / 7,
      })),
    );
    const css = source(name, 'wxss');
    assert.match(css, /1s steps\(8, end\) infinite/);
    assert.match(css, /width: 11\.6%;/);
    assert.match(css, /height: 33\.33%;/);
    assert.match(css, /transform-origin: center 150%;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  }
  const h = harness('button');
  const className = renderedAttribute(source('button', 'wxml'), 'class', {
    ...h.instance.properties,
    loading: true,
  });
  assert.ok(className.includes('f7-button-loading'));
  assert.ok(!className.includes('f7-button-disabled'));
  const css = source('button', 'wxss');
  assert.match(
    css,
    /--f7-preloader-size: calc\(var\(--f7-button-height\) - 6px\)/,
  );
  assert.match(
    css,
    /\.f7-button-large \.f7-button-surface\s*\{\s*--f7-preloader-size: 20px;/,
  );
  assert.match(
    css,
    /\.f7-button-loading \.f7-button-label\s*\{\s*opacity: 0;\s*transform: scale\(0\);/,
  );
});

test('F7 source geometry remains pinned while the native button hit target is explicitly enlarged', () => {
  const expected: Record<string, string> = {
    'button-height': '34px',
    'button-font-size': '15px',
    'button-large-height': '48px',
    'button-large-font-size': '17px',
    'button-small-height': '28px',
    'button-small-font-size': '14px',
    'button-border-radius': '4px',
    'button-outline-border-width': '2px',
    'list-item-min-height': '52px',
    'list-font-size': '17px',
    'list-item-padding-vertical': '12px',
    'list-item-padding-horizontal': '16px',
    'list-inset-side-margin': '16px',
    'list-inset-border-radius': '24px',
    'list-item-media-margin': '16px',
    'list-chevron-icon-area': '20px',
    'block-margin-vertical': '35px',
    'block-padding-horizontal': '16px',
    'block-padding-vertical': '16px',
    'block-inset-border-radius': '24px',
    'block-title-font-size': '17px',
    'block-title-font-weight': '600',
    'block-title-line-height': '20px',
    'block-title-margin-bottom': '10px',
  };
  for (const [token, value] of Object.entries(expected))
    assert.equal(
      new RegExp(`--f7-${token}:\\s*([^;]+);`).exec(lightTheme)?.[1]?.trim(),
      value,
      token,
    );
  const button = source('button', 'wxss');
  assert.match(button, /min-height: 44px;/);
  assert.match(button, /height: var\(--f7-button-height\);/);
  assert.match(button, /--f7-button-border-radius: var\(--f7-button-height\);/);
  assert.match(
    button,
    /\.f7-button-small\.f7-button-fill\s*\{[^}]*--f7-button-pressed-bg-color: transparent;/,
  );
  const item = source('list-item', 'wxss');
  assert.match(item, /min-height: var\(--f7-list-item-min-height\);/);
  assert.doesNotMatch(
    item,
    /(?:^|\n)\s*height: (?:52px|var\(--f7-list-item-min-height\))/,
  );
  assert.match(
    item,
    /\.f7-list-item-inner::after\s*\{[^}]*left: 0;[^}]*height: 1px;[^}]*scaleY\(calc\(1 \/ var\(--f7-device-pixel-ratio\)\)\)/,
  );
  assert.match(
    item,
    /\.f7-list-item-last \.f7-list-item-inner::after\s*\{\s*display: none;/,
  );
  assert.match(
    item,
    /\.f7-list-item-control\.f7-list-item-control-pressed\s*\{[^}]*transition-duration: 0ms;/,
  );
  assert.match(item, /transition: background-color 300ms;/);
  assert.match(
    source('block', 'wxss'),
    /padding: 0 var\(--f7-block-padding-horizontal\);/,
  );
  assert.match(
    source('block', 'wxss'),
    /\.f7-block-strong\s*\{[^}]*padding-top: var\(--f7-block-padding-vertical\);/,
  );
});

test('F7 foundations retain MIT attribution and depend only on scoped, resolved shared variables', () => {
  const defined = new Set(
    [...theme.matchAll(/(--f7-[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
  );
  const allCss = (['button', 'block', 'list', 'list-item'] as const)
    .map((name) => source(name, 'wxss'))
    .join('\n');
  for (const match of allCss.matchAll(/(--f7-[a-z0-9-]+)\s*:/g))
    defined.add(match[1]);
  for (const match of allCss.matchAll(/var\((--f7-[a-z0-9-]+)([,)])/g))
    if (match[2] !== ',') assert.ok(defined.has(match[1]), match[1]);
  for (const name of ['button', 'block', 'list', 'list-item'] as const) {
    for (const extension of ['ts', 'wxss']) {
      assert.match(source(name, extension), /Framework7 v9\.2\.0/);
      assert.match(source(name, extension), /Copyright \(c\) 2014 Vladimir/);
      assert.match(
        source(name, extension),
        /docs\/vendor\/framework7-v9\.2\.0\/LICENSE/,
      );
    }
  }
  const license = readFileSync(
    path.join(__dirname, '../../../docs/vendor/framework7-v9.2.0/LICENSE'),
    'utf8',
  );
  assert.match(license, /The MIT License \(MIT\)/);
  assert.match(license, /Copyright \(c\) 2014 Vladimir Kharlampidi/);
  assert.match(theme, /@media \(min-resolution: 2dppx\)/);
  assert.match(theme, /@media \(min-resolution: 3dppx\)/);
});
