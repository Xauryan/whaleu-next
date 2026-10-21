import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import assert from 'node:assert/strict';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import { setup } from './community-helpers';
import { flush } from './helpers';
import type { ErrandsGateway } from '../src/errands/gateway';
import type { ErrandDetail } from '../src/errands/contract';
import { PendingErrandStore } from '../src/errands/pending';
import { initialErrandPublicationView } from '../src/errands/publication-runtime';
const root = path.join(__dirname, '..'),
  requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const pages = [
  'errand-list',
  'errand-mine',
  'errand-detail',
  'errand-compose',
  'errand-notices',
];
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-errands-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-errands-before-protected.json'),
) as Record<string, string>;
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:for-index',
        'wx:key',
      ].includes(key),
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
function chains(node: PresentationNode) {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  children.forEach((child, index) => {
    if ('wx:else' in child.attrs || 'wx:elif' in child.attrs)
      assert.ok(
        children[index - 1] &&
          ('wx:if' in children[index - 1]!.attrs ||
            'wx:elif' in children[index - 1]!.attrs),
        child.tag,
      );
    chains(child);
  });
}
for (const [file, before] of Object.entries(baseline))
  test(`${file}: all original actions, exact scopes, datasets, constraints and loading guards survive`, () => {
    const target =
      file === 'src/pages/errand-list/product.wxml'
        ? 'src/errands/f7-common.wxml'
        : file;
    const tree = parse(read(target)),
      current = actions(tree);
    assert.equal(current.length, before.actions.length);
    for (const old of before.actions) {
      const index = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(
            ([key, value]) => next.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(old));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    chains(tree);
  });
test('68 protected baselines retain exact evidence; only explicitly reviewed presentation/business successors differ', () => {
  assert.equal(Object.keys(protectedFiles).length, 68);
  const successors = JSON.parse(
    read('test/fixtures/framework7-errands-reviewed-school-successor.json'),
  ) as Record<
    string,
    {
      before: string;
      beforeEvidence: string;
      after: string;
      successorEvidence: string;
    }
  >;
  assert.deepEqual(
    Object.keys(successors).sort(),
    ['errand-admin', 'errand-restrictions']
      .flatMap((page) =>
        ['json', 'wxml', 'wxss'].map(
          (extension) => `src/pages/${page}/${page}.${extension}`,
        ),
      )
      .sort(),
  );
  for (const [file, expected] of Object.entries(protectedFiles)) {
    if (
      assertReviewedBusinessSuccessor(file, expected) ||
      assertReviewedNoticeExposureSuccessor(file, expected)
    )
      continue;
    const successor = successors[file];
    if (successor) {
      assert.equal(successor.before, expected);
      assert.equal(hash(read(successor.beforeEvidence)), expected, file);
      assert.equal(hash(read(file)), successor.after, file);
      assert.match(read(successor.successorEvidence), /errand-admin/);
    } else assert.equal(hash(read(file)), expected, file);
  }
  assert.equal(
    Object.values(baseline).reduce((sum, item) => sum + item.actions.length, 0),
    71,
  );
});
test('registered native component boundaries contain no nested actionable slots, DOM, new overlays or global styling', () => {
  for (const page of pages) {
    const nodes = flatten(parse(source(page)));
    if (page !== 'errand-notices')
      nodes.push(...flatten(parse(read('src/errands/f7-common.wxml'))));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-button'));
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-block'));
    for (const node of nodes.filter((n) => n.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      if (['wu-f7-button', 'wu-f7-list-item'].includes(node.tag))
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (n) =>
                /^(button|input|textarea|navigator|switch|wu-f7-button|wu-f7-input)$/.test(
                  n.tag,
                ) || Object.keys(n.attrs).some((k) => /^(bind|catch)/.test(k)),
            ),
          node.tag,
        );
    }
    assert.ok(
      !nodes.some((n) =>
        /^(button|input|web-view|wu-f7-dialog|wu-f7-sheet|wu-f7-actions)$/.test(
          n.tag,
        ),
      ),
    );
    assert.doesNotMatch(source(page), /https?:\/\/|requestPayment|rich-text/);
    assert.match(source(page, 'wxss'), /f7-errands\.wxss/);
  }
  assert.doesNotMatch(
    read('src/errands/f7-errands.wxss'),
    /(?:^|\n)page\s*\{|@import.*product/,
  );
});
test('native multiline, navigation, controlled images and unchanged owner confirmation surfaces remain explicit exceptions', () => {
  const compose = flatten(parse(source('errand-compose')));
  assert.deepEqual(
    compose
      .filter((n) => n.tag === 'textarea')
      .map((n) => [
        n.attrs['data-field'],
        n.attrs.maxlength,
        n.attrs.bindinput,
      ]),
    [
      ['publicText', '-1', 'onForm'],
      ['privateText', '-1', 'onForm'],
    ],
  );
  const detail = flatten(parse(source('errand-detail')));
  assert.deepEqual(
    detail
      .filter((n) => n.tag === 'image')
      .map((n) => [n.attrs.src, n.attrs['wx:if']]),
    [
      ['{{orderImage.src}}', '{{orderImage.src}}'],
      ['{{targetQr.src}}', '{{targetQr.src}}'],
    ],
  );
  assert.equal(
    detail.filter((n) => n.attrs.class === 'errand-modal-mask').length,
    2,
  );
  assert.match(source('errand-detail'), /至少填写一种联系方式/);
  assert.match(source('errand-compose'), /微信和电话均需填写/);
  assert.match(source('errand-detail'), /{{detail.reward}}/);
  assert.doesNotMatch(
    source('errand-detail'),
    /toFixed|parseFloat|Math\.round/,
  );
});
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>, callback?: () => void): void;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { value: unknown; type: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = globals[kind];
  let definition: T | undefined;
  globals[kind] = (value: T) => {
    definition = value;
  };
  try {
    const target = requireNative.resolve(path.join(root, 'src', file));
    delete requireNative.cache[target];
    requireNative(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(definition);
  return definition;
}
function invoke(owner: Owner, handler: string, event?: unknown) {
  return (owner[handler] as (event?: unknown) => unknown).call(owner, event);
}
const settle = async () => {
  await flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
};
interface Handle {
  press(): boolean;
  detach(): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Handle;
  find(
    handler: string,
    dataset?: Record<string, unknown>,
  ): PresentationNode | undefined;
  sync(): void;
  lifecycle(name: string): void;
  emissions: unknown[];
}
const { createNativePressBridge } = requireNative(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: {
    page: Owner;
    pageFile: string;
    dist: string;
    extension: string;
  }): Bridge;
};
function mount(page: string, app: unknown, query: unknown = {}) {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp };
  const navigation: string[] = [];
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigation.push(url);
      success?.();
    },
  };
  globals.getApp = () => app;
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  const owner: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      bridge?.sync();
      callback?.();
    },
  };
  const bridge = createNativePressBridge({
    page: owner,
    pageFile: path.join(root, `src/pages/${page}/${page}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  if (owner.onLoad) invoke(owner, 'onLoad', query);
  invoke(owner, 'onShow');
  return {
    owner,
    bridge,
    navigation,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const capture = bridge.capture(handler, dataset);
      const result = capture.press();
      capture.detach();
      return result;
    },
    hide() {
      bridge.lifecycle('hide');
      invoke(owner, 'onHide');
    },
    close() {
      bridge.lifecycle('detach');
      invoke(owner, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
test('actual native Component→Page→controller→synthetic HTTP full original errand smoke retains immutable commands and all negative privacy/recovery probes', async () => {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp };
  const h = setup(),
    app = { identity: { sessions: h.sessions }, community: h.runtime };
  globals.wx = { navigateTo() {} };
  globals.getApp = () => app;
  const { smokeErrands } = requireNative('../scripts/smoke-errands.mjs') as {
    smokeErrands(options: unknown): Promise<void>;
  };
  try {
    await smokeErrands({
      app,
      dist: path.join(root, 'src'),
      flush: settle,
      extension: 'ts',
    });
  } finally {
    globals.wx = previous.wx;
    globals.getApp = previous.getApp;
  }
});
const orderId = '11111111-1111-4111-8111-111111111111',
  regionId = '22222222-2222-4222-8222-222222222222',
  revision = '33333333-3333-4333-8333-333333333333',
  bindingId = '44444444-4444-4444-8444-444444444444';
const time = '2026-10-20T10:00:00.000Z';
function mediaHarness() {
  const h = setup();
  const detail: ErrandDetail = {
    id: orderId,
    revision,
    title: '合成私密媒体订单',
    publicText: '合成公开内容',
    expectedTimeText: '今晚',
    reward: '12.34567890123456789',
    state: 'accepted',
    createdAt: time,
    acceptedAt: time,
    completedAt: null,
    cancelledAt: null,
    sourceRegion: { id: regionId, label: '合成地区' },
    targetRegion: { id: regionId, label: '合成地区' },
    scope: 'home',
    relation: 'publisher',
    privateText: '合成私密说明',
    capabilities: { accept: false, cancel: true, complete: true, delete: true },
    mediaRevision: 7,
    publicMedia: [
      {
        protocol: 'errand-media-v1',
        kind: 'errand-media',
        orderId,
        slot: 'public0',
        revision: 7,
        bindingId,
        width: 800,
        height: 600,
        variants: ['thumb-v1', 'display-v1'],
      },
    ],
    privateMedia: [
      {
        protocol: 'errand-media-v1',
        kind: 'errand-media',
        orderId,
        slot: 'private0',
        revision: 7,
        bindingId,
        width: 800,
        height: 600,
        variants: ['thumb-v1', 'display-v1'],
      },
    ],
  };
  const calls: { method: string; args: unknown[] }[] = [];
  const publicOrder = structuredClone(detail);
  for (const key of ['relation', 'capabilities', 'privateText', 'privateMedia'])
    delete (publicOrder as unknown as Record<string, unknown>)[key];
  const gateway: ErrandsGateway = {
    regions: async () => [{ id: regionId, label: '合成地区' }],
    list: async (query) => {
      calls.push({ method: 'list', args: [query] });
      return {
        context: {
          kind: 'discovery',
          regionId: query.regionId,
          discoveryMode: 'home',
        },
        items: [publicOrder],
        continuation: 'end',
        nextCursor: null,
      };
    },
    mine: async (relation) => {
      calls.push({ method: 'mine', args: [relation] });
      return {
        context: { kind: 'own', relation },
        items: [publicOrder],
        continuation: 'end',
        nextCursor: null,
      };
    },
    detail: async () => structuredClone(detail),
    contactHistory: async () => ({ status: 'empty' }),
    command: async () => {
      throw new Error('No command authorized by media-only test');
    },
    receipt: async () => {
      throw new Error('No receipt authorized by media-only test');
    },
  };
  const app = {
    community: {
      ...h.runtime,
      errands: gateway,
      pendingErrands: new PendingErrandStore(h.storage, 'synthetic'),
    },
    errandMedia: {
      createReader: () => ({
        load: async (...args: unknown[]) => {
          calls.push({ method: 'read', args });
        },
        clear: () => {
          calls.push({ method: 'clear', args: [] });
        },
        dispose: () => {
          calls.push({ method: 'dispose', args: [] });
        },
      }),
    },
    errandPublication: {
      createComposer: (render: (view: unknown) => void) => {
        render(initialErrandPublicationView());
        return {
          hasDraft: true,
          choose: async (...args: unknown[]) => {
            calls.push({ method: 'choose', args });
          },
          remove: async (...args: unknown[]) => {
            calls.push({ method: 'remove', args });
          },
          publish: async (...args: unknown[]) => {
            calls.push({ method: 'publish', args });
          },
          recover: async (...args: unknown[]) => {
            calls.push({ method: 'recover', args });
          },
          cancelDraft: async () => {
            calls.push({ method: 'cancelDraft', args: [] });
          },
          clear: () => {
            calls.push({ method: 'clearDraft', args: [] });
          },
          dispose: () => {
            calls.push({ method: 'disposeDraft', args: [] });
          },
        };
      },
    },
  };
  return { ...h, app, detail, calls };
}
test('real media buttons preserve current binding identity, private gate, loading suppression and hide invalidation', async () => {
  const h = mediaHarness(),
    f = mount('errand-detail', h.app, { orderId });
  try {
    await settle();
    assert.equal(f.owner.data.loaded, true);
    assert.equal(f.press('onPreviewOrderImage', { value: 'private0' }), true);
    assert.deepEqual(
      h.calls.filter((c) => c.method === 'read').map((c) => c.args),
      [[{ orderId, revision: 7, slot: 'private0' }]],
    );
    const stale = f.bridge.capture('onPreviewOrderImage', { value: 'public0' });
    f.owner.setData({
      orderImage: { status: 'loading', src: '', message: '合成图片读取中' },
    });
    assert.equal(stale.press(), false);
    assert.equal(f.press('onPreviewOrderImage', { value: 'public0' }), false);
    f.owner.setData({
      orderImage: { status: 'unavailable', src: '', message: '合成权限失效' },
    });
    assert.equal(f.press('onCloseOrderImage'), true);
    f.hide();
    assert.equal((f.owner.currentView as { detail: unknown }).detail, null);
    assert.equal(f.owner.data.loaded, false);
    assert.equal(f.owner.imageReader, undefined);
    assert.equal(stale.press(), false);
    assert.equal(h.calls.filter((c) => c.method === 'read').length, 1);
    assert.equal(h.calls.filter((c) => c.method === 'dispose').length, 1);
  } finally {
    f.close();
  }
});
test('real composer image buttons preserve slot, region, recover flag and draft recovery/cancellation guards', async () => {
  const h = mediaHarness(),
    f = mount('errand-compose', h.app, { regionId });
  try {
    await settle();
    assert.equal(f.press('onTogglePanel', { field: 'images' }), true);
    assert.equal(f.press('onChooseOrderImage', { value: 'public0' }), true);
    assert.equal(f.press('onRecoverOrderImage', { value: 'private0' }), true);
    assert.equal(f.press('onRemoveOrderImage', { value: 'public0' }), true);
    assert.deepEqual(
      h.calls.filter((c) => ['choose', 'remove'].includes(c.method)),
      [
        { method: 'choose', args: ['public0', regionId] },
        { method: 'choose', args: ['private0', regionId, true] },
        { method: 'remove', args: ['public0'] },
      ],
    );
    const old = f.bridge.capture('onChooseOrderImage', { value: 'public0' });
    const imagePublication = {
      ...initialErrandPublicationView(),
      hasDraft: true,
      frozen: true,
      busy: true,
      message: '合成原图片待确认',
    };
    f.owner.setData({ imagePublication });
    assert.equal(old.press(), false);
    assert.equal(f.press('onRecoverImagePublication'), false);
    f.owner.setData({ imagePublication: { ...imagePublication, busy: false } });
    assert.equal(f.press('onRecoverImagePublication'), true);
    assert.equal(f.press('onRetryImagePublication'), true);
    assert.equal(f.press('onCancelImageDraft'), true);
    assert.deepEqual(
      h.calls.filter((c) => c.method === 'recover').map((c) => c.args),
      [[], [true]],
    );
    assert.equal(h.calls.filter((c) => c.method === 'cancelDraft').length, 1);
    f.hide();
    assert.equal(f.owner.imageComposer, undefined);
    assert.equal(old.press(), false);
  } finally {
    f.close();
  }
});
test('all synthetic fixture markers render through actual Component slots and template scopes', () => {
  const { evaluatePreviewExpression: evaluate } = requireNative(
    '../scripts/preview-wxml.mjs',
  ) as {
    evaluatePreviewExpression(
      value: string,
      scope: Record<string, unknown>,
    ): unknown;
  };
  const { nativeComponentPreviewState } = requireNative(
    '../scripts/preview-native-component.mjs',
  ) as {
    nativeComponentPreviewState(
      definition: object,
      attrs: Record<string, string>,
      evaluate: (value: string) => unknown,
    ): Record<string, unknown>;
  };
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-errands-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  type Templates = Record<string, (PresentationNode | string)[]>;
  type Slots = Record<string, () => string>;
  const interpolation = (value: string, scope: Record<string, unknown>) =>
    value.replace(/{{([\s\S]*?)}}/g, (_match, expr: string) =>
      String(evaluate(expr, scope) ?? ''),
    );
  function templateMap(file: string, seen = new Set<string>()): Templates {
    if (seen.has(file)) return {};
    seen.add(file);
    const tree = parse(read(file));
    let templates: Templates = {};
    for (const child of tree.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'import')
        templates = {
          ...templates,
          ...templateMap(path.join(path.dirname(file), child.attrs.src!), seen),
        };
      if (child.tag === 'template' && child.attrs.name)
        templates[child.attrs.name] = child.children;
    }
    return templates;
  }
  function render(
    nodes: (PresentationNode | string)[],
    scope: Record<string, unknown>,
    templates: Templates,
    slots: Slots = {},
  ): string {
    let result = '',
      matched = false;
    for (const node of nodes) {
      if (typeof node === 'string') {
        result += interpolation(node, scope);
        continue;
      }
      const attrs = node.attrs;
      if (node.tag === 'import' || (node.tag === 'template' && attrs.name))
        continue;
      if (attrs['wx:for']) {
        const values = evaluate(attrs['wx:for'].slice(2, -2), scope) as
          unknown[] | undefined;
        const remaining = { ...attrs };
        delete remaining['wx:for'];
        result += (values ?? [])
          .map((item, index) =>
            render(
              [{ ...node, attrs: remaining }],
              {
                ...scope,
                [attrs['wx:for-item'] ?? 'item']: item,
                [attrs['wx:for-index'] ?? 'index']: index,
              },
              templates,
              slots,
            ),
          )
          .join('');
        continue;
      }
      if ('wx:if' in attrs) matched = false;
      const condition = attrs['wx:if'] ?? attrs['wx:elif'];
      if ('wx:elif' in attrs && matched) continue;
      if (condition !== undefined) {
        if (!evaluate(condition.slice(2, -2), scope)) continue;
        matched = true;
      } else if ('wx:else' in attrs) {
        if (matched) continue;
        matched = true;
      } else matched = false;
      if (node.tag === 'template' && attrs.is) {
        result += render(
          templates[attrs.is] ?? [],
          (evaluate(`({${attrs.data!.slice(2, -2)}})`, scope) as Record<
            string,
            unknown
          >) ?? {},
          templates,
          slots,
        );
        continue;
      }
      if (node.tag === 'slot') {
        result += slots[attrs.name ?? 'default']?.() ?? '';
        continue;
      }
      if (node.tag.startsWith('wu-f7-')) {
        const name = node.tag.slice(3),
          file = `src/components/${name}/${name}.wxml`;
        const definition = registration<Definition>(
          'Component',
          `components/${name}/${name}.ts`,
        );
        const state = nativeComponentPreviewState(definition, attrs, (value) =>
          value.startsWith('{{') && value.endsWith('}}')
            ? evaluate(value.slice(2, -2), scope)
            : interpolation(value, scope),
        );
        const componentSlots: Slots = {};
        for (const child of node.children) {
          const slot =
            typeof child === 'string'
              ? 'default'
              : (child.attrs.slot ?? 'default');
          const previous = componentSlots[slot];
          componentSlots[slot] = () =>
            (previous?.() ?? '') + render([child], scope, templates, slots);
        }
        result += render(
          parse(read(file)).children,
          state,
          templateMap(file),
          componentSlots,
        );
        continue;
      }
      result += render(node.children, scope, templates, slots);
    }
    return result;
  }
  for (const fixture of fixtures) {
    const definition = registration<Owner>(
      'Page',
      `pages/${fixture.page}/${fixture.page}.ts`,
    );
    const file = `src/pages/${fixture.page}/${fixture.page}.wxml`;
    const text = render(
      parse(read(file)).children,
      { ...structuredClone(definition.data), ...fixture.patch },
      templateMap(file),
    );
    for (const marker of fixture.expectedText)
      assert.ok(text.includes(marker), `${fixture.id}: missing ${marker}`);
    assert.doesNotMatch(
      text,
      /undefined|NaN|PRIVATE_CANARY|CONTACT_CANARY|SECRET_CANARY/,
      fixture.id,
    );
    if (/detail-(completed|cancelled)/.test(fixture.id))
      assert.doesNotMatch(
        text,
        /synthetic-contact|示例接单同学|接取此订单|确认完成|取消订单/,
      );
    if (fixture.id.endsWith('notices-administrative'))
      assert.ok(!text.includes('查看订单'));
  }
});
test('real list filter/sort and own relation buttons forward exact original controller datasets', async () => {
  const h = mediaHarness(),
    f = mount('errand-list', h.app, { regionId });
  try {
    await settle();
    assert.equal(f.owner.data.loaded, true);
    assert.equal(
      f.press('onChoice', { field: 'filter', value: 'pending' }),
      true,
    );
    await settle();
    assert.equal(f.owner.data.filter, 'pending');
    assert.equal(f.press('onTogglePanel', { field: 'sort' }), true);
    assert.equal(f.press('onChoice', { field: 'sort', value: 'reward' }), true);
    await settle();
    assert.equal(f.press('onTogglePanel', { field: 'sort' }), true);
    assert.equal(
      f.press('onChoice', { field: 'direction', value: 'asc' }),
      true,
    );
    await settle();
    assert.equal(f.owner.data.sort, 'reward');
    assert.equal(f.owner.data.direction, 'asc');
    const list = h.calls.filter((c) => c.method === 'list');
    assert.deepEqual(list[list.length - 1]!.args, [
      { regionId, filter: 'pending', sort: 'reward', direction: 'asc' },
    ]);
    const captured = f.bridge.capture('onChoice', {
      field: 'filter',
      value: 'all',
    });
    f.hide();
    assert.equal(captured.press(), false);
    assert.deepEqual(f.owner.data.items, []);
  } finally {
    f.close();
  }
  const mine = mount('errand-mine', h.app, { relation: 'published' });
  try {
    await settle();
    assert.equal(
      mine.press('onChoice', { field: 'relation', value: 'accepted' }),
      true,
    );
    await settle();
    assert.equal(mine.owner.data.relation, 'accepted');
    assert.equal(h.calls.filter((c) => c.method === 'mine').length, 2);
  } finally {
    mine.close();
  }
});
test('real destructive confirmation buttons require original owner action, allow dismissal and never mutate on opening', async () => {
  const h = mediaHarness(),
    f = mount('errand-detail', h.app, { orderId });
  const commands: unknown[] = [];
  h.app.community.errands.command = async (intent) => {
    commands.push(structuredClone(intent));
    return {
      requestId: intent.payload.clientRequestId,
      operation: intent.operation,
      outcome: 'rejected',
      code: 'ERRAND_STATE_CONFLICT',
    };
  };
  try {
    await settle();
    for (const action of ['cancel', 'delete']) {
      assert.equal(f.press('onConfirm', { action }), true);
      assert.equal(f.owner.data.confirmAction, action);
      assert.deepEqual(commands, []);
      const old = f.bridge.capture('onConfirmCommand');
      assert.equal(f.press('onDismiss'), true);
      assert.equal(f.owner.data.confirmAction, null);
      assert.equal(old.press(), false);
    }
    assert.equal(f.press('onConfirm', { action: 'cancel' }), true);
    assert.equal(f.press('onConfirmCommand'), true);
    await settle();
    assert.equal(commands.length, 1);
    const command = commands[0] as {
      operation: string;
      orderId: string;
      payload: { expectedRevision: string };
    };
    assert.equal(command.operation, 'cancel');
    assert.equal(command.orderId, orderId);
    assert.equal(command.payload.expectedRevision, revision);
    assert.equal(f.owner.data.confirmAction, null);
    assert.match(String(f.owner.data.receiptStatus), /已被接走|已结束/);
  } finally {
    f.close();
  }
});
test('37 synthetic fixture variants cover exactly five routes without executable media or personal data', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-errands-preview.mjs',
  ) as {
    default: {
      page: string;
      id: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(fixtures.length, 37);
  assert.deepEqual(
    [...new Set(fixtures.map((f) => f.page))].sort(),
    [...pages].sort(),
  );
  for (const f of fixtures) {
    assert.ok(f.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(f.patch),
      /https?:\/\/|accessToken|providerId|accountId/,
    );
  }
  for (const kind of [
    'own-only',
    'sort',
    'campus',
    'private-media',
    'unrelated-canary',
    'completed',
    'cancelled',
    'accept',
    'confirm-delete',
    'target-group',
    'media-unavailable',
    'recovery-busy',
    'image-recovery',
    'image-busy',
    'administrative',
  ])
    assert.ok(
      fixtures.some((f) => f.id.includes(kind)),
      kind,
    );
});
