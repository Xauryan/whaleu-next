import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

interface Instance {
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(data: Record<string, unknown>, callback?: () => void): void;
  triggerEvent(name: string, detail?: unknown, options?: unknown): void;
}
interface Definition {
  properties?: Record<string, { type?: unknown; value: unknown }>;
  data?: Record<string, unknown>;
  observers?: Record<string, (this: Instance) => void>;
  lifetimes?: {
    attached?(this: Instance): void;
    detached?(this: Instance): void;
  };
}
interface Capture {
  data: Record<string, unknown>;
  lifecycleEvents: { name: string; detail: unknown; options: unknown }[];
  scheduler: {
    callbacksExecuted: number;
    elapsedMs: number;
    pendingCallbacks: number;
  };
}
interface Fixture {
  id: string;
  title: string;
  markup: string;
  scope: Record<string, unknown>;
  expected: string[];
}
const require = createRequire(__filename);
const { nativeComponentPreviewCapture: capture } =
  require('../scripts/preview-native-component.mjs') as {
    nativeComponentPreviewCapture(
      definition: Definition,
      attributes: Record<string, string>,
      evaluate: (value: string) => unknown,
    ): Capture;
  };
const { default: fixtures } =
  require('../scripts/fixtures/framework7-overlay-components-preview.mjs') as {
    default: Fixture[];
  };
const { default: historyFixtures } =
  require('../scripts/fixtures/framework7-overlays-preview.mjs') as {
    default: { id: string; title: string; expectedText: string[] }[];
  };
const { parsePreviewWxml: parse, evaluatePreviewExpression: expression } =
  require('../scripts/preview-wxml.mjs') as {
    parsePreviewWxml(source: string): {
      children: { tag: string; attrs: Record<string, string> }[];
    };
    evaluatePreviewExpression(
      source: string,
      scope: Record<string, unknown>,
    ): unknown;
  };

function registration(name: string): Definition {
  const file = require.resolve(`../src/components/${name}/${name}.ts`);
  let definition: Definition | undefined;
  const globals = globalThis as unknown as {
    Component?: (value: Definition) => void;
  };
  const previous = Object.getOwnPropertyDescriptor(globals, 'Component');
  globals.Component = (value) => {
    definition = value;
  };
  try {
    delete require.cache[file];
    require(file);
  } finally {
    if (previous) Object.defineProperty(globals, 'Component', previous);
    else delete globals.Component;
  }
  assert.ok(definition, 'executes actual repository Component registration');
  return definition;
}
const timerNames = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'queueMicrotask',
];
const timerDescriptors = () =>
  timerNames.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
const identity = (value: string) => value;
const openAttributes = { open: 'true', 'session-id': 'fictional-preview' };

test('source capture runs real overlay lifecycle to settled open and detaches after cloning', () => {
  for (const name of ['f7-sheet', 'f7-actions', 'f7-dialog']) {
    const originalTimers = timerDescriptors();
    const definition = registration(name);
    const detached = definition.lifetimes?.detached;
    let disposed: Record<string, unknown> | undefined;
    definition.lifetimes = {
      ...definition.lifetimes,
      detached() {
        detached?.call(this);
        disposed = this.data;
      },
    };
    const result = capture(definition, openAttributes, identity);
    assert.equal(result.data['phase'], 'open');
    assert.equal(result.data['mounted'], true);
    assert.equal(result.data['visible'], true);
    assert.equal(result.data['rendered'], true);
    assert.equal(result.data['interactionDisabled'], false);
    assert.equal(result.data['activeSessionId'], 'fictional-preview');
    assert.deepEqual(result.data['renderKeys'], [{ generation: 1 }]);
    assert.deepEqual(result.lifecycleEvents, [
      {
        name: 'opened',
        detail: { sessionId: 'fictional-preview', generation: 1 },
        options: { bubbles: false, composed: false },
      },
    ]);
    assert.deepEqual(result.scheduler, {
      callbacksExecuted: 4,
      elapsedMs: name === 'f7-dialog' ? 416 : 316,
      pendingCallbacks: 0,
    });
    assert.equal(disposed?.['mounted'], false);
    assert.equal(disposed?.['phase'], 'closed');
    assert.notEqual(result.data, disposed);
    assert.deepEqual(timerDescriptors(), originalTimers);
  }
});

test('closed and invalid-session overlay source stays closed without a fabricated opening', () => {
  for (const attributes of [
    {},
    { open: 'true', 'session-id': 'invalid session' },
    { open: 'false', 'session-id': 'fictional-preview' },
  ]) {
    const result = capture(registration('f7-dialog'), attributes, identity);
    assert.equal(result.data['phase'], 'closed');
    assert.equal(result.data['rendered'], false);
    assert.deepEqual(result.lifecycleEvents, []);
    assert.equal(result.scheduler.callbacksExecuted, 0);
  }
});

test('actual owner close observer settles removal acknowledgement without invoking a close action', () => {
  const definition = registration('f7-dialog');
  const attached = definition.lifetimes!.attached!;
  definition.lifetimes!.attached = function () {
    attached.call(this);
    setTimeout(() => {
      this.properties['open'] = false;
      this.setData({ open: false });
      definition.observers!['open, sessionId']!.call(this);
    }, 500);
  };
  const result = capture(definition, openAttributes, identity);
  assert.equal(result.data['phase'], 'closed');
  assert.equal(result.data['rendered'], false);
  assert.deepEqual(result.data['renderKeys'], []);
  assert.deepEqual(
    result.lifecycleEvents.map((event) => event.name),
    ['opened', 'closed'],
  );
  assert.equal(result.scheduler.elapsedMs, 900);
  assert.equal(result.scheduler.pendingCallbacks, 0);
});

test('all fictional overlay fixtures use native source projections and current guard props', () => {
  assert.equal(fixtures.length, 12);
  assert.equal(new Set(fixtures.map((fixture) => fixture.id)).size, 12);
  for (const fixture of fixtures) {
    const node = parse(fixture.markup).children[0]!;
    const result = capture(
      registration(node.tag.replace(/^wu-/, '')),
      node.attrs,
      (raw) =>
        /^{{[\s\S]*}}$/.test(raw)
          ? expression(raw.slice(2, -2), fixture.scope)
          : raw,
    );
    assert.equal(result.data['phase'], 'open', fixture.id);
    assert.equal(result.scheduler.pendingCallbacks, 0, fixture.id);
    assert.equal(
      result.data['interactionDisabled'],
      fixture.scope['disabled'] === true || fixture.scope['loading'] === true,
      fixture.id,
    );
    assert.deepEqual(
      result.lifecycleEvents.map((event) => event.name),
      ['opened'],
      fixture.id,
    );
    if (fixture.id === 'overlay-dialog-keyboard') {
      assert.equal(result.data['keyboardInset'], 240);
      assert.equal(result.data['editorFocused'], true);
      assert.equal(result.data['useSafeArea'], false);
    }
    if (node.tag === 'wu-f7-actions') {
      assert.equal((result.data['items'] as unknown[]).length, 3);
      assert.equal(result.data['itemsRevision'], 1);
    }
  }
});

test('synthetic render acknowledgements precede frame timers and cleared timers never run', () => {
  const order: string[] = [];
  let detached = false;
  const result = capture(
    {
      lifetimes: {
        attached() {
          order.push('attached');
          setTimeout(() => order.push('timer'), 16);
          const cancelled = setTimeout(() => assert.fail('cancelled timer'), 0);
          clearTimeout(cancelled);
          this.setData({ value: 'source' }, () => {
            order.push('render');
            queueMicrotask(() => order.push('microtask'));
          });
        },
        detached() {
          detached = true;
          this.data['value'] = 'disposed';
        },
      },
    },
    {},
    identity,
  );
  assert.deepEqual(order, ['attached', 'render', 'microtask', 'timer']);
  assert.equal(result.data['value'], 'source');
  assert.equal(detached, true);
  assert.equal(result.scheduler.pendingCallbacks, 0);
});

test('only opened and closed are local observations; actions and requestclose fail even in a timer', () => {
  const observations = capture(
    {
      lifetimes: {
        attached() {
          this.triggerEvent('opened', { generation: 1 });
          this.setData({}, () =>
            this.triggerEvent('closed', { generation: 1 }),
          );
        },
      },
    },
    {},
    identity,
  );
  assert.deepEqual(
    observations.lifecycleEvents.map((event) => event.name),
    ['opened', 'closed'],
  );
  for (const name of ['action', 'requestclose', 'input', 'press']) {
    const originalTimers = timerDescriptors();
    let detached = false;
    assert.throws(
      () =>
        capture(
          {
            lifetimes: {
              attached() {
                setTimeout(() => this.triggerEvent(name, { id: 'never' }), 16);
              },
              detached() {
                detached = true;
                setTimeout(() => assert.fail('dangling detached timer'), 1);
              },
            },
          },
          {},
          identity,
        ),
      /must not dispatch actions/,
    );
    assert.equal(detached, true);
    assert.deepEqual(timerDescriptors(), originalTimers);
  }
});

test('unbounded timers/render acknowledgements and recurring work fail without global leaks', () => {
  const attachedCases = [
    function () {
      const again = () => setTimeout(again, 0);
      again();
    },
    function (this: Instance) {
      const again = () => this.setData({}, again);
      again();
    },
    function () {
      setTimeout(() => {}, 10_001);
    },
    function () {
      setInterval(() => {}, 1);
    },
  ];
  for (const attached of attachedCases) {
    const originalTimers = timerDescriptors();
    let detached = false;
    assert.throws(
      () =>
        capture(
          {
            lifetimes: {
              attached,
              detached() {
                detached = true;
              },
            },
          },
          {},
          identity,
        ),
      /synthetic (?:callback|time) limit|cannot start recurring/,
    );
    assert.equal(detached, true);
    assert.deepEqual(timerDescriptors(), originalTimers);
  }
});

test('detached exceptions restore globals and async lifecycle work is rejected before invocation', () => {
  const originalTimers = timerDescriptors();
  assert.throws(
    () =>
      capture(
        {
          lifetimes: {
            detached() {
              throw new Error('detach failed');
            },
          },
        },
        {},
        identity,
      ),
    /detach failed/,
  );
  let ran = false;
  assert.throws(
    () =>
      capture(
        {
          lifetimes: {
            async attached() {
              ran = true;
            },
          },
        },
        {},
        identity,
      ),
    /must not start asynchronous work/,
  );
  assert.equal(ran, false);
  assert.deepEqual(timerDescriptors(), originalTimers);
});

test('source catalog and history render native overlays in both themes without raw native tags', () => {
  const output = mkdtempSync(path.join(tmpdir(), 'whaleu-overlay-preview-'));
  try {
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(__dirname, '../scripts/preview-apple.mjs'),
        '--source',
        '--components=framework7',
        '--batch=framework7-overlays',
        `--output=${output}`,
      ],
      { encoding: 'utf8' },
    );
    const html = readFileSync(
      path.join(output, 'framework7-components.html'),
      'utf8',
    );
    const frames = [
      ...html.matchAll(/<iframe title="([^"]*)" srcdoc="([^"]*)"/g),
    ];
    const decode = (value: string) =>
      value
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
    for (const fixture of fixtures) {
      const cases = frames.filter(
        (frame) => decode(frame[1]!) === fixture.title,
      );
      assert.equal(cases.length, 2, `${fixture.id} has light and dark frames`);
      for (const frame of cases) {
        const content = decode(frame[2]!);
        const body = content.slice(content.indexOf('<body>'));
        assert.match(body, /f7-overlay-open/);
        assert.match(body, /f7-overlay-mask-visible/);
        assert.doesNotMatch(body, /<\/?(?:wu-)?f7-[a-z-]+\b/);
        assert.doesNotMatch(body, /<script\b|on(?:click|input|submit)=/);
        for (const text of fixture.expected)
          assert.ok(body.includes(text), text);
        if (fixture.id.includes('dialog')) assert.match(body, /<button\b/);
        if (fixture.scope['mode'] === 'prompt') assert.match(body, /<input\b/);
        if (fixture.id === 'overlay-dialog-disabled')
          assert.match(body, /<input[^>]*\sdisabled(?:\s|=|>)/);
        if (fixture.id === 'overlay-dialog-error')
          assert.match(body, /f7-input-invalid/);
        if (fixture.id === 'overlay-dialog-keyboard')
          assert.match(body, /bottom:240px/);
      }
    }
    const history = readFileSync(
      path.join(output, 'framework7-overlays-product.html'),
      'utf8',
    );
    const historyFrames = [
      ...history.matchAll(/<iframe title="([^"]*)" srcdoc="([^"]*)"/g),
    ];
    assert.equal(historyFrames.length, 6);
    for (const fixture of historyFixtures) {
      const cases = historyFrames.filter(
        (frame) => decode(frame[1]!) === fixture.title,
      );
      assert.equal(cases.length, 2, fixture.id);
      for (const frame of cases) {
        const content = decode(frame[2]!);
        const body = content.slice(content.indexOf('<body'));
        assert.doesNotMatch(body, /<\/?(?:page-meta|(?:wu-)?f7-[a-z-]+)\b/);
        for (const text of fixture.expectedText)
          assert.ok(body.includes(text), `${fixture.id}: ${text}`);
        if (fixture.id.endsWith('-normal')) {
          assert.doesNotMatch(body, /f7-overlay-open/);
        } else {
          assert.match(body, /f7-overlay-open/);
          assert.match(body, /f7-dialog-visible/);
        }
        if (fixture.id.endsWith('-confirm')) assert.match(body, /银杏慢慢变黄/); // Background stays mounted.
        if (fixture.id.endsWith('-error')) {
          const retry = [...body.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
            .map((match) => match[0])
            .find((button) => button.includes('重试清空'));
          assert.ok(retry, 'known local failure offers explicit retry');
          assert.doesNotMatch(
            retry.slice(0, retry.indexOf('>')),
            /\sdisabled(?:\s|=|$)/,
          );
        }
      }
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
