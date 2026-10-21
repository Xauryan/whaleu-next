import assert from 'node:assert/strict';
import test, { afterEach, type TestContext } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { decodeWindowSummary } from '../src/window-ratings/contract';

const previousGlobals = {
  Page: globalThis.Page,
  getApp: globalThis.getApp,
  wx: (globalThis as typeof globalThis & { wx?: unknown }).wx,
};
afterEach(() => {
  Object.assign(globalThis, previousGlobals);
});

// Source-only regression: no dist, compiler, HTTP, PG, or provider prerequisite.
// Production Page registrations and F7 native models execute; only their initial
// view projections are seeded. No controller/gateway is substituted or called.
type Dataset = Record<string, string | number>;
interface WxmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: RenderNode[];
}
type RenderNode = string | WxmlNode;
interface NativeEvent {
  currentTarget: { dataset: Dataset };
  detail: { value?: string };
}
interface PageModel {
  data: Record<string, unknown>;
  setData(patch: object): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  [key: string]: unknown;
}
interface NativeControl {
  node: WxmlNode;
  instance: {
    properties: Record<string, unknown>;
    data: Record<string, unknown>;
  };
  press(): boolean;
  input(event: { detail: { value: string; cursor?: number } }): boolean;
  detach(): void;
}
interface NativeBridge {
  capture(handler: string, dataset?: Dataset): NativeControl;
  find(handler: string, dataset?: Dataset): WxmlNode | undefined;
  emissions: NativeEvent[];
}
interface PgControls {
  dispatch(handler: string, dataset?: Dataset, value?: string): void;
  press: NativeBridge;
  input: NativeBridge;
  projection?: object;
}
const nativeRequire = createRequire(__filename);
const dist = path.resolve(__dirname, '../src'); // Parameter name mirrors bridge API; these are source files.
const { parse, render } = nativeRequire('../scripts/smoke-ratings.mjs') as {
  parse(source: string): WxmlNode;
  render(
    nodes: RenderNode[],
    data: object,
    templates: Record<string, WxmlNode>,
  ): RenderNode[];
};
const { createNativePgControls } = nativeRequire(
  '../../api/test/support/native-pg-control-adapter.mjs',
) as {
  createNativePgControls(options: {
    page: PageModel;
    pageFile: string;
    dist: string;
    renderNodes(): RenderNode[];
    extension: 'ts';
  }): PgControls;
};
const flatten = (nodes: RenderNode[]): WxmlNode[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [] : [node, ...flatten(node.children)],
  );
function sourcePage(name: string) {
  let registered: PageModel | undefined;
  Object.assign(globalThis, {
    Page: (value: PageModel) => {
      registered = value;
    },
    getApp: () => ({}),
    wx: {},
  });
  const pageFile = path.join(dist, `pages/${name}/${name}`);
  delete nativeRequire.cache[nativeRequire.resolve(`${pageFile}.ts`)];
  nativeRequire(`${pageFile}.ts`);
  assert.ok(registered, 'Actual source entrypoint registers Page');
  const page = registered;
  page.setData = function (patch: object) {
    Object.assign(this.data, patch);
  };
  const templates: Record<string, WxmlNode> = {},
    visited = new Set<string>();
  function readTree(file: string): WxmlNode {
    assert.ok(file.startsWith(`${dist}${path.sep}`));
    assert.ok(!visited.has(file), 'No cyclic template dependency');
    visited.add(file);
    const source = readFileSync(file, 'utf8').replace(
      /<include\s+src="([^"]+)"\s*\/>/g,
      (_all: string, include: string) => {
        assert.ok(
          ['rating-category-editor', 'rating-category-manage'].includes(name),
        );
        assert.equal(
          include,
          '../../ratings/framework7-recovery-category.wxml',
        );
        const target = path.resolve(path.dirname(file), include);
        assert.equal(
          target,
          path.join(dist, 'ratings/framework7-recovery-category.wxml'),
        );
        return readFileSync(target, 'utf8');
      },
    );
    const tree = parse(source);
    for (const node of flatten(tree.children)) {
      if (node.tag === 'import')
        readTree(path.resolve(path.dirname(file), node.attrs.src!));
      if (node.tag === 'template' && node.attrs.name)
        templates[node.attrs.name] = node;
    }
    return tree;
  }
  const tree = readTree(`${pageFile}.wxml`);
  const renderNodes = () =>
    render(
      tree.children.filter(
        (node) =>
          typeof node === 'string' ||
          node.tag !== 'template' ||
          !node.attrs.name,
      ),
      page.data,
      templates,
    );
  const native = createNativePgControls({
    page,
    pageFile,
    dist,
    renderNodes,
    extension: 'ts',
  });
  return {
    page,
    native,
    nodes: () => flatten(renderNodes()),
    rendered: renderNodes,
    capturePress: native.press.capture,
    captureInput: native.input.capture,
    button: (_binding: string, handler: string) => native.press.find(handler),
    tap: (handler: string, dataset: Dataset = {}) =>
      native.dispatch(handler, dataset),
  };
}
type Mounted = ReturnType<typeof sourcePage>;
const dataSet = (h: Mounted, value: object) => h.page.setData(value);
const wrap = (page: PageModel, name: string) => {
  const calls: NativeEvent[] = [],
    original = page[name] as ((event: NativeEvent) => unknown) | undefined;
  page[name] = function (this: PageModel, event: NativeEvent) {
    calls.push(structuredClone(event));
    return original?.call(this, event);
  };
  return calls;
};
const mount = (name: string) => {
  const h = sourcePage(name);
  h.page.onShow();
  return h;
};
const windowSeed = {
  loaded: true,
  hasSession: true,
  canScore: true,
  busy: false,
  frozen: false,
  confirming: null,
  detail: {
    window: {
      name: 'Native &amp; <score>',
      canteenName: 'A',
      floor: { label: 'B' },
      summary: { kind: 'known', ratingCount: 0, mean: null },
    },
    myScore: { kind: 'not_submitted' },
  },
};
const child = (id: string, self = false) => ({
  id,
  text: 'reply',
  images: [],
  author: { kind: 'anonymous', displayName: 'Anon' },
  viewer: { isSelf: self, canDelete: self },
  replyPreview: { items: [], total: 0 },
});
const post = {
  id: 'post',
  text: 'post',
  images: [],
  likeCount: 0,
  author: { kind: 'anonymous', displayName: 'Anon' },
  viewer: {},
  space: { id: 'space' },
  component: { kind: 'none' },
};

test('window score sheet and filter require real F7 disclosure; all 21 scores remain ordered; closed/disabled/stale/hidden/detached presses cannot fire', () => {
  const h = mount('window-rating-detail');
  dataSet(h, windowSeed);
  const scores = wrap(h.page, 'onScore');
  assert.throws(() => h.capturePress('onScore', { score: 0 }), /Actual WXML/);
  h.tap('onTogglePanel', { panel: 'score' });
  assert.equal(h.page.data.uiPanel, 'score');
  const nodes = h
    .nodes()
    .filter(
      (n) =>
        typeof n !== 'string' &&
        n.tag === 'wu-f7-button' &&
        n.attrs['bind:press'] === 'onScore',
    );
  assert.equal(nodes.length, 21);
  assert.deepEqual(
    nodes.map((n) => Number(n.attrs['data-score'])),
    Array.from({ length: 21 }, (_, i) => i - 10),
  );
  h.tap('onScore', { score: 0 });
  assert.equal(scores.length, 1);
  assert.equal(scores[0]!.currentTarget.dataset.score, 0);
  const stale = h.capturePress('onScore', { score: 1 });
  h.tap('onClosePanel');
  assert.equal(stale.press(), false);
  assert.throws(() => h.tap('onScore', { score: 1 }), /Actual WXML/);
  h.tap('onTogglePanel', { panel: 'score' });
  dataSet(h, { busy: true });
  const disabled = h.capturePress('onScore', { score: 1 });
  assert.equal(disabled.press(), false);
  disabled.detach();
  dataSet(h, { busy: false });
  const hidden = h.capturePress('onScore', { score: 1 });
  h.page.onHide();
  assert.equal(hidden.press(), false);
  h.page.onUnload();
  assert.equal(hidden.press(), false);
  assert.equal(scores.length, 1);
  const catalog = mount('window-ratings');
  dataSet(catalog, {
    loaded: true,
    hasSession: true,
    catalog: {},
    canteenOptions: [{ id: 'canteen', label: 'A' }],
    floorOptions: [],
    items: [],
  });
  assert.throws(() => catalog.captureInput('onMinimum'), /Actual WXML/);
  catalog.tap('onTogglePanel', { panel: 'filter' });
  const minimum = catalog.captureInput('onMinimum');
  assert.equal(minimum.input({ detail: { value: '-10', cursor: 3 } }), true);
  minimum.detach();
  catalog.page.onUnload();
});

test('dish native input is absent before actual disclosure, has unlimited native maxlength, preserves raw names, and rejects stale/disabled/hidden/detached delivery', () => {
  const h = mount('window-dishes'),
    names = wrap(h.page, 'onName');
  assert.throws(() => h.captureInput('onName'), /Actual WXML/);
  h.tap('onTogglePanel', { panel: 'dish' });
  assert.equal(h.page.data.uiPanel, 'dish');
  const control = h.captureInput('onName');
  assert.equal(control.node.tag, 'wu-f7-input');
  assert.equal(control.instance.properties.maxlength, -1);
  assert.equal(control.instance.data.nativeMaxlength, -1);
  for (const value of [
    ' ',
    'a\n',
    '\ud800',
    '😀'.repeat(10),
    '😀'.repeat(11),
    '&amp; <raw>',
  ]) {
    assert.equal(
      control.input({ detail: { value, cursor: value.length } }),
      true,
    );
    assert.equal(names[names.length - 1]!.detail.value, value);
  }
  const before = names.length;
  h.tap('onClosePanel');
  assert.equal(control.input({ detail: { value: 'stale' } }), false);
  h.tap('onTogglePanel', { panel: 'dish' });
  dataSet(h, { busy: true });
  const disabled = h.captureInput('onName');
  assert.equal(disabled.input({ detail: { value: 'disabled' } }), false);
  disabled.detach();
  dataSet(h, { busy: false });
  const hidden = h.captureInput('onName');
  h.page.onHide();
  assert.equal(hidden.input({ detail: { value: 'hidden' } }), false);
  h.page.onUnload();
  assert.equal(hidden.input({ detail: { value: 'unmounted' } }), false);
  assert.equal(names.length, before);
});

test('admin detail/thread menus open via actual handlers, preserve exact selected datasets, and own-content absence is non-vacuous', () => {
  for (const [name, kind] of [
    ['community-detail', 'comment'],
    ['community-detail', 'reply'],
    ['community-thread', 'comment'],
    ['community-thread', 'reply'],
  ] as const) {
    for (const own of [false, true]) {
      // Own replies are tested in their existing Thread owner, as in the worker.
      if (
        own &&
        ((name === 'community-detail' && kind === 'reply') ||
          (name === 'community-thread' && kind === 'comment'))
      )
        continue;
      const h = mount(name),
        id = 'selected',
        root = child(
          kind === 'comment' ? id : 'root',
          kind === 'comment' && own,
        );
      const reply = {
        ...child(id, own),
        rootCommentId: root.id,
        target: {
          status: 'available',
          kind: 'comment',
          author: { kind: 'anonymous', displayName: 'Anon' },
        },
      };
      dataSet(h, {
        post,
        loaded: true,
        hasSession: true,
        busy: false,
        needsReload: false,
        ...(name === 'community-detail'
          ? {
              locatedComment: root,
              locatedReply: kind === 'reply' ? reply : null,
              comments: [],
            }
          : {
              root,
              locatedReply: kind === 'reply' ? reply : null,
              replies: [],
              contextReplies: [],
            }),
      });
      assert.throws(
        () => h.capturePress('onAdminDiscussionRemoval', { id, kind }),
        /Actual WXML/,
      );
      const menu =
        name === 'community-detail'
          ? 'located'
          : kind === 'comment'
            ? 'root'
            : `reply:${id}`;
      const toggle =
        name === 'community-detail' ? 'onToggleMenu' : 'onToggleThreadMenu';
      h.tap(toggle, { menu });
      assert.equal(h.page.data.uiExpandedMenu, menu);
      const controls = h
        .nodes()
        .filter(
          (n) =>
            typeof n !== 'string' &&
            n.attrs['bind:press'] === 'onAdminDiscussionRemoval' &&
            n.attrs['data-id'] === id,
        );
      if (own) {
        assert.equal(controls.length, 0);
        assert.ok(
          h.button(
            'bind:press',
            kind === 'comment' ? 'onDeleteComment' : 'onDeleteReply',
          ),
        );
      } else {
        assert.equal(controls.length, 1);
        assert.equal(controls[0]!.attrs['data-kind'], kind);
        if (name === 'community-detail')
          assert.equal(controls[0]!.attrs['data-surface'], `located-${kind}`);
        const captured = h.capturePress('onAdminDiscussionRemoval', {
          id,
          kind,
        });
        h.tap(toggle, { menu });
        assert.equal(
          captured.press(),
          false,
          'closing source menu retires selection',
        );
        h.tap(toggle, { menu });
        dataSet(h, { busy: true });
        const disabled = h.capturePress('onAdminDiscussionRemoval', {
          id,
          kind,
        });
        assert.equal(disabled.press(), false);
        disabled.detach();
      }
      h.page.onUnload();
    }
  }
});

function fixture(
  t: TestContext,
  {
    name = 'rating-category-editor',
    wrapper,
    body,
    data = {},
  }: { name?: string; wrapper?: string; body?: string; data?: object } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'whaleu-pg-focused-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pageFile = path.join(root, `pages/${name}/${name}`);
  mkdirSync(path.dirname(pageFile), { recursive: true });
  mkdirSync(path.join(root, 'ratings'), { recursive: true });
  cpSync(path.join(dist, 'components'), path.join(root, 'components'), {
    recursive: true,
  });
  cpSync(
    path.join(dist, 'pages/rating-category-editor/rating-category-editor.json'),
    `${pageFile}.json`,
  );
  writeFileSync(
    `${pageFile}.wxml`,
    wrapper ??
      '<include src="../../ratings/framework7-recovery-category.wxml" />',
  );
  const source =
    body ??
    '<wu-f7-block><wu-f7-button data-key="{{key}}" data-record-id="{{number}}" disabled="{{disabled}}" bind:press="onAction">&lt;literal&gt; &amp;lt; {{text}}</wu-f7-button><wu-f7-input data-key="{{key}}" disabled="{{disabled}}" bind:input="onName" maxlength="-1" /><textarea data-field="description" bindinput="onText" /></wu-f7-block>';
  writeFileSync(
    path.join(root, 'ratings/framework7-recovery-category.wxml'),
    source,
  );
  const parsed = parse(source),
    calls: [string, NativeEvent][] = [];
  const page: PageModel = {
    data: {
      key: 'n0',
      number: 17,
      text: '&amp; <runtime>',
      disabled: false,
      ...data,
    },
    setData(patch: object) {
      Object.assign(this.data, patch);
    },
    onAction(event: NativeEvent) {
      calls.push(['press', event]);
    },
    onName(event: NativeEvent) {
      calls.push(['input', event]);
    },
    onText(event: NativeEvent) {
      calls.push(['raw', event]);
    },
    onShow() {
      this.onHide();
    },
    onHide() {},
    onUnload() {},
  };
  const renderNodes = () => render(parsed.children, page.data, {});
  const native = () =>
    createNativePgControls({
      page,
      pageFile,
      dist: root,
      renderNodes,
      extension: 'ts',
    });
  return { root, pageFile, page, native, calls, renderNodes, source };
}

test('assistance exact category include executes real press/input, retains native textarea and datasets, and decodes text only once', (t) => {
  const f = fixture(t),
    native = f.native();
  t.after(() => f.page.onUnload());
  f.page.onShow();
  native.dispatch('onAction');
  native.dispatch('onName', { key: 'n0' }, '&amp; <buffer> 😀');
  native.dispatch('onText', { field: 'description' }, '原始简介');
  assert.deepEqual(
    f.calls.map(([type]) => type),
    ['press', 'input', 'raw'],
  );
  assert.deepEqual(f.calls[0]![1].currentTarget.dataset, {
    key: 'n0',
    recordId: 17,
  });
  assert.equal(f.calls[1]![1].detail.value, '&amp; <buffer> 😀');
  assert.deepEqual(f.calls[2]![1].currentTarget.dataset, {
    field: 'description',
  });
  const block = f.renderNodes()[0];
  assert.ok(block && typeof block !== 'string');
  const button = block.children[0];
  assert.ok(button && typeof button !== 'string');
  assert.equal(button.children.join(''), '<literal> &lt; &amp; <runtime>');
  assert.ok(native.projection);
  assert.equal(native.press.emissions.length, 1);
  assert.equal(native.input.emissions.length, 1);
  const captured = native.input.capture('onName');
  f.page.setData({ disabled: true });
  assert.equal(captured.input({ detail: { value: 'late' } }), false);
  assert.throws(() => native.dispatch('onAction'), /visible and enabled/);
  f.page.setData({ disabled: false });
  f.page.onHide();
  assert.throws(
    () => native.dispatch('onName', {}, 'hidden'),
    /visible and mounted/,
  );
  f.page.onShow();
  native.dispatch('onAction');
  f.page.onUnload();
  f.page.onShow();
  assert.throws(() => native.dispatch('onAction'), /visible and mounted/);
});

test('assistance rejects unexpected/dynamic/nested/escaping includes and unknown wrapper pages', (t) => {
  for (const wrapper of [
    '<include src="../../ratings/legacy.wxml" />',
    '<include src="{{dynamic}}" />',
    '<include src="../../../../escape.wxml" />',
    '<view /><include src="../../ratings/framework7-recovery-category.wxml" />',
  ]) {
    const f = fixture(t, { wrapper });
    assert.throws(f.native, /Only one complete|Expected values/);
  }
  const nested = fixture(t, { body: '<include src="other.wxml" />' });
  assert.throws(nested.native, /Nested includes/);
  const unknown = fixture(t, { name: 'unknown' });
  assert.throws(unknown.native, /Only the two/);
});

test('assistance rejects unknown custom components/events and hidden/disabled raw controls without dispatch', (t) => {
  for (const body of [
    '<wu-f7-input bind:press="onAction" />',
    '<wu-unregistered bind:press="onAction" />',
    '<wu-unregistered bindtap="onAction" />',
    '<wu-unregistered><textarea bindinput="onText" /></wu-unregistered>',
    '<view hidden="{{true}}"><wu-f7-input bind:input="onName" /></view>',
    '<wu-f7-button loading="{{true}}" bind:press="onAction" />',
    '<wu-f7-button bind:other="onAction" />',
    '<wu-f7-input bindinput="onName" />',
    '<view hidden="{{true}}"><textarea bindinput="onText" /></view>',
    '<textarea disabled="{{true}}" bindinput="onText" />',
    '<wu-f7-button><textarea bindinput="onText" /></wu-f7-button>',
  ]) {
    const f = fixture(t, { body }),
      native = f.native();
    t.after(() => f.page.onUnload());
    const handler = body.includes('onAction')
      ? 'onAction'
      : body.includes('onName')
        ? 'onName'
        : 'onText';
    assert.throws(() => native.dispatch(handler, {}, 'never'));
    assert.deepEqual(f.calls, []);
  }
});

test('assistance actual category Page/include uses native Operation and name Input while description stays raw textarea', (t) => {
  const h = mount('rating-category-editor'),
    page = h.page,
    native = h.native;
  t.after(() => page.onUnload());
  page.setData({
    loaded: true,
    hasSession: true,
    busy: false,
    frozen: false,
    management: {},
    operations: [
      { operation: 'create_categories_scoped', allowed: true, label: 'Create' },
    ],
    operation: 'create_categories_scoped',
    nodes: [{ key: 'n0', name: '', description: '', parentKey: null }],
  });
  const operations = wrap(page, 'onOperation'),
    edits = wrap(page, 'onNodeText');
  native.dispatch('onOperation', { operation: 'create_categories_scoped' });
  native.dispatch('onNodeText', { key: 'n0', field: 'name' }, '原生建议分类');
  native.dispatch(
    'onNodeText',
    { key: 'n0', field: 'description' },
    '原始简介 &amp;',
  );
  assert.equal(operations.length, 1);
  assert.equal(edits.length, 2);
  assert.equal(edits[0]!.detail.value, '原生建议分类');
  assert.deepEqual(edits[0]!.currentTarget.dataset, {
    key: 'n0',
    field: 'name',
  });
  assert.equal(edits[1]!.detail.value, '原始简介 &amp;');
  assert.equal(native.press.emissions.length, 1);
  assert.equal(native.input.emissions.length, 1);
});

test('all native events reject unknown ancestors before dispatch while registered F7 block/list ancestors remain supported', (t) => {
  for (const [tag, binding, handler, eventType] of [
    ['wu-f7-button', 'bind:press', 'onAction', 'press'],
    ['wu-f7-input', 'bind:input', 'onName', 'input'],
  ] as const) {
    const unknown = fixture(t, {
      body: `<wu-unregistered><${tag} ${binding}="${handler}" /></wu-unregistered>`,
    });
    const blocked = unknown.native();
    t.after(() => unknown.page.onUnload());
    assert.throws(
      () => blocked.dispatch(handler, {}, 'never'),
      /unknown custom component ancestor/,
    );
    assert.deepEqual(unknown.calls, []);
    assert.equal(blocked.press.emissions.length, 0);
    assert.equal(blocked.input.emissions.length, 0);
    for (const ancestor of ['wu-f7-block', 'wu-f7-list']) {
      const supported = fixture(t, {
        body: `<${ancestor}><${tag} ${binding}="${handler}" /></${ancestor}>`,
      });
      // The category wrapper itself needs only Block; this isolated positive
      // fixture explicitly registers the real List at its canonical source path.
      const configFile = `${supported.pageFile}.json`;
      const config = JSON.parse(readFileSync(configFile, 'utf8')) as {
        usingComponents: Record<string, string>;
      };
      config.usingComponents['wu-f7-list'] = '../../components/f7-list/f7-list';
      writeFileSync(configFile, JSON.stringify(config));
      const native = supported.native();
      t.after(() => supported.page.onUnload());
      native.dispatch(handler, {}, 'supported');
      assert.equal(supported.calls.length, 1);
      assert.equal(supported.calls[0]![0], eventType);
      assert.equal(native[eventType].emissions.length, 1);
    }
  }
});

// Text comes only from the actual source WXML parser/template renderer above.
const renderedText = (nodes: RenderNode[]): string =>
  nodes
    .map((node) =>
      typeof node === 'string' ? node : renderedText(node.children),
    )
    .join('');
const classNodes = (h: Mounted, className: string) =>
  h
    .nodes()
    .filter((node) =>
      (node.attrs.class ?? '').split(/\s+/).includes(className),
    );

test('actual window summary template distinguishes empty, recorded zero, and unavailable without inventing a zero mean', () => {
  const h = mount('window-rating-detail');
  const show = (summary: unknown, myScore: object) => {
    dataSet(h, {
      ...windowSeed,
      detail: {
        ...windowSeed.detail,
        window: {
          ...windowSeed.detail.window,
          summary: decodeWindowSummary(summary),
        },
        myScore,
      },
    });
    return renderedText(h.rendered());
  };
  const empty = show(
    { kind: 'known', ratingCount: 0, mean: null },
    { kind: 'not_submitted' },
  );
  assert.match(empty, /暂无评分/);
  assert.match(empty, /还没有评分记录/);
  assert.match(empty, /还未评分/);
  assert.equal(classNodes(h, 'dp-score-value').length, 0);
  assert.equal(classNodes(h, 'dp-own-value').length, 0);
  const zero = show(
    { kind: 'known', ratingCount: 1, mean: 0 },
    { kind: 'recorded', score: 0 },
  );
  assert.doesNotMatch(
    zero,
    /暂无评分|还没有评分记录|还未评分|历史评分暂不能确认/,
  );
  assert.match(zero, /1 条评分/);
  assert.equal(classNodes(h, 'dp-score-value').length, 1);
  assert.equal(
    renderedText(classNodes(h, 'dp-score-value')[0]!.children).trim(),
    '0',
  );
  assert.equal(
    renderedText(classNodes(h, 'dp-own-value')[0]!.children).trim(),
    '0',
  );
  const unavailable = show({ kind: 'unavailable' }, { kind: 'unavailable' });
  assert.match(unavailable, /历史评分暂不能确认/);
  assert.match(unavailable, /我的历史评分暂不能确认/);
  assert.doesNotMatch(unavailable, /暂无评分|还没有评分记录|还未评分/);
  assert.equal(classNodes(h, 'dp-score-value').length, 0);
  assert.equal(classNodes(h, 'dp-own-value').length, 0);
  assert.throws(
    () => decodeWindowSummary({ kind: 'known', ratingCount: 0, mean: 0 }),
    /Invalid window rating data/,
  );
  assert.throws(
    () => decodeWindowSummary({ kind: 'known', ratingCount: 1, mean: null }),
    /Invalid window rating data/,
  );
  h.page.onUnload();
});

test('actual admin confirmation template preserves distinct root and child removal scopes and hides confirmation when frozen', () => {
  const h = mount('admin-discussion-removal');
  const show = (kind: 'comment' | 'reply', frozen = false) => {
    dataSet(h, {
      hasSession: true,
      busy: false,
      frozen,
      confirming: 'remove',
      management: { canRemove: true, target: { kind, id: 'target' } },
      punishmentKind: 'none',
    });
    return renderedText(h.rendered());
  };
  const root = show('comment');
  assert.match(
    root,
    /该根回复及其全部回复将不可访问。同帖的其他根回复及其回复仍保留。/,
  );
  assert.doesNotMatch(root, /仅删除选中的这条回复/);
  const submit = h.capturePress('onSubmit');
  assert.equal(submit.node.attrs['bind:press'], 'onSubmit');
  submit.detach();
  const reply = show('reply');
  assert.match(
    reply,
    /仅删除选中的这条回复；根回复、其他回复以及回复它的后续回复仍保留/,
  );
  assert.doesNotMatch(reply, /该根回复及其全部回复将不可访问/);
  for (const words of [root, reply]) {
    assert.match(words, /仅删除时不会通知作者，不禁言，不扣除作者经验/);
    assert.match(words, /当前没有恢复此内容的管理入口/);
    assert.doesNotMatch(
      words,
      /私有系统通知|已通知作者|school_admin|super_admin|作者账号/,
    );
  }
  const frozen = show('comment', true);
  assert.doesNotMatch(
    frozen,
    /该根回复及其全部回复将不可访问|仅删除选中的这条回复/,
  );
  assert.throws(() => h.capturePress('onSubmit'), /Actual WXML/);
  h.page.onUnload();
});
