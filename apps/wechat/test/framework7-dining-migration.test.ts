import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import {
  floorHarness,
  floorId,
  canteenId,
  detail as floorDetail,
} from './canteen-floor-scores-helpers';
import {
  windowHarness,
  id as windowId,
  otherId,
  requestId,
  detail as windowDetail,
  page as windowPage,
  scoreRevision,
  recordedAt,
} from './window-ratings-helpers';
import {
  dishHarness,
  own as dishOwn,
  page as dishPage,
  recommend,
  retract,
} from './dish-recommendations-helpers';
import { dishIdentity } from '../src/dish-recommendations/contract';
import { deferred, flush as shortFlush } from './helpers';
import { wireCredentials } from './identity-helpers';
async function flush() {
  for (let i = 0; i < 20; i++) await shortFlush();
}

const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const pages = [
  'canteen-floor-scores',
  'canteen-floor-score-detail',
  'window-ratings',
  'window-rating-detail',
  'window-dishes',
];
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
  read('test/fixtures/framework7-dining-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-dining-before-protected.json'),
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
        'hidden',
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
function conditionalChains(node: PresentationNode) {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  children.forEach((child, index) => {
    if ('wx:else' in child.attrs || 'wx:elif' in child.attrs)
      assert.ok(
        children[index - 1] &&
          ('wx:if' in children[index - 1]!.attrs ||
            'wx:elif' in children[index - 1]!.attrs),
        `${child.tag}: conditional adjacency`,
      );
    conditionalChains(child);
  });
}
for (const [original, before] of Object.entries(baseline))
  test(`${original}: exact original event, dataset, ancestor, disabled, loading and editor constraints`, () => {
    const file = original.endsWith('/product.wxml')
      ? original.replace('/product.wxml', '/framework7-product.wxml')
      : original;
    const tree = parse(read(file)),
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
      const next = current[index]!;
      const added = Object.keys(next.attrs).filter(
        (key) => !(key in old.attrs),
      );
      assert.ok(
        added.every((key) =>
          [
            'variant',
            'size',
            'link',
            'title',
            'subtitle',
            'last',
            'aria-label',
          ].includes(key),
        ),
        `unexpected action attribute: ${added.join(', ')}`,
      );
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    conditionalChains(tree);
  });

test('pre-edit inventories remain the original captured bytes rather than a re-recorded expectation', () => {
  assert.equal(
    hash(read('test/fixtures/framework7-dining-before-actions.json')),
    '80381739efc084ee4b263ebe538fa3b8502d575f4af77ec1be0b6d2a62c84485',
  );
  assert.equal(
    hash(read('test/fixtures/framework7-dining-before-protected.json')),
    '68539e52c85883d2fdf1fa5625bbd7ce5ee0ebda1dfe7f8d858c16f8ad5eed4b',
  );
});

test('92 protected files: dining business sources, originals, accepted roots, globals and shipped native components remain byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 92);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
for (const page of pages)
  test(`${page}: isolated native registration, no nested action rows, no new overlays/browser runtime`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-button'));
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-block'));
    for (const node of nodes.filter((item) => item.tag.startsWith('wu-f7-'))) {
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
                child.tag === 'navigator' ||
                Object.keys(child.attrs).some((key) =>
                  /^(bind|catch)/.test(key),
                ) ||
                /^(button|input|textarea|switch|wu-f7-button)$/.test(child.tag),
            ),
        );
      }
    }
    assert.ok(
      !nodes.some((node) =>
        /^(button|input|web-view|wu-f7-sheet|wu-f7-dialog|wu-f7-actions)$/.test(
          node.tag,
        ),
      ),
    );
    if (page !== 'window-dishes')
      assert.match(source(page), /framework7-product\.wxml/);
    assert.match(source(page, 'wxss'), /framework7-product\.wxss/);
    assert.doesNotMatch(source(page), /rich-text|data:image|https?:\/\//);
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
  setData(value: Record<string, unknown>, callback?: () => void): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { value: unknown }>;
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
function invoke(target: Owner, name: string, event?: unknown) {
  return (target[name] as (event?: unknown) => unknown).call(target, event);
}
function mount(page: string, runtime: CommunityRuntime, query: unknown = {}) {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp },
    navigation: string[] = [];
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigation.push(url);
      success?.();
    },
  };
  globals.getApp = () => ({ community: runtime });
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  const target: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value, callback) {
      Object.assign(this.data, value);
      callback?.();
    },
  };
  invoke(target, 'onLoad', query);
  invoke(target, 'onShow');
  return {
    target,
    navigation,
    close() {
      invoke(target, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
function control(
  page: string,
  handler: string,
  target: Owner,
  patch: Record<string, unknown> = {},
  pick: (node: PresentationNode) => boolean = () => true,
) {
  const nodes = flatten(parse(source(page))).concat(
    flatten(parse(read('src/canteen-floor-scores/framework7-product.wxml'))),
    flatten(parse(read('src/window-ratings/framework7-product.wxml'))),
  );
  const node = nodes.find(
    (item) =>
      (item.attrs['bind:press'] === handler ||
        item.attrs['bind:input'] === handler ||
        item.attrs['bind:confirm'] === handler) &&
      pick(item),
  );
  assert.ok(node, `${page}: actual ${handler} Component binding`);
  const scope = { index: 0, ...target.data, ...patch };
  const evaluate = (raw: string) =>
    raw.startsWith('{{')
      ? (Function(
          'scope',
          `with(scope){return (${raw.slice(2, -2)});}`,
        )(scope) as unknown)
      : raw;
  const dataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [key.slice(5), evaluate(value)]),
  );
  const definition = registration<Definition>(
    'Component',
    `components/${node.tag.slice(3)}/${node.tag.slice(3)}.ts`,
  );
  const properties = Object.fromEntries(
    Object.entries(definition.properties).map(([key, value]) => [
      key,
      structuredClone(value.value),
    ]),
  );
  for (const [key, value] of Object.entries(node.attrs)) {
    const prop = key.replace(/-([a-z])/g, (_match, letter: string) =>
      letter.toUpperCase(),
    );
    if (!(prop in definition.properties)) continue;
    let resolved = evaluate(value);
    if (typeof properties[prop] === 'number' && typeof resolved === 'string')
      resolved = Number(resolved);
    properties[prop] = resolved;
  }
  let dispatched = 0;
  const instance: Instance = {
    properties,
    data: structuredClone(definition.data),
    ...definition.methods,
    setData(value, callback) {
      Object.assign(this.data, value);
      callback?.();
    },
    triggerEvent(name, detail, options) {
      const eventHandler = node.attrs[`bind:${name}`];
      assert.equal(typeof eventHandler, 'string');
      assert.deepEqual(options, { bubbles: false, composed: false });
      dispatched++;
      invoke(target, eventHandler!, { detail, currentTarget: { dataset } });
    },
  };
  definition.lifetimes?.attached?.call(instance);
  return {
    press: () => definition.methods.onPress!.call(instance),
    input: (value: string) =>
      definition.methods.onInput!.call(instance, {
        detail: { value, cursor: value.length },
      }),
    confirm: (value: string) =>
      definition.methods.onConfirm!.call(instance, { detail: { value } }),
    hide: () => definition.pageLifetimes?.hide?.call(instance),
    detach: () => definition.lifetimes?.detached?.call(instance),
    dispatched: () => dispatched,
  };
}
function press(
  page: string,
  handler: string,
  target: Owner,
  patch: Record<string, unknown> = {},
  pick?: (node: PresentationNode) => boolean,
) {
  const c = control(page, handler, target, patch, pick);
  c.press();
  c.detach();
  return c.dispatched();
}
function input(
  page: string,
  handler: string,
  target: Owner,
  value: string,
  pick?: (node: PresentationNode) => boolean,
) {
  const c = control(page, handler, target, {}, pick);
  c.input(value);
  c.detach();
  return c.dispatched();
}

test('native picker/navigation exceptions and all confirmation/anonymous aggregate disclosures remain explicit', () => {
  for (const page of ['canteen-floor-scores', 'window-ratings'])
    assert.ok(
      flatten(parse(source(page))).some(
        (node) => node.tag === 'picker' && node.attrs.bindchange === 'onFloor',
      ),
    );
  assert.match(source('canteen-floor-score-detail'), /当前没有编辑或删除入口/);
  assert.match(source('canteen-floor-score-detail'), /评分只计入这个楼层/);
  assert.match(source('window-rating-detail'), /0 分同样计入/);
  assert.match(source('window-rating-detail'), /若评分已在别处变化/);
  assert.match(source('window-dishes'), /不展示推荐者身份/);
  assert.match(source('window-dishes'), /不代表不同自然人的数量/);
  assert.ok(
    flatten(parse(source('window-dishes'))).some(
      (node) => node.tag === 'wu-f7-input' && node.attrs.maxlength === '-1',
    ),
  );
});

test('real ListItem/Button → floor catalog Page preserves accepted floor identity and native picker, busy and hidden navigation fences', async () => {
  const s = floorHarness('catalog');
  s.controller.dispose();
  const f = mount('canteen-floor-scores', s.runtime);
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    press('canteen-floor-scores', 'onCanteen', f.target, {
      item: { id: canteenId },
    });
    invoke(f.target, 'onFloor', { detail: { value: '1' } });
    assert.equal(f.target.data.floorDraft, floorId);
    press(
      'canteen-floor-scores',
      'onOpenFloor',
      f.target,
      { item: { id: floorId, label: '合成夹层' } },
      (n) => n.tag === 'wu-f7-list-item',
    );
    assert.equal(
      f.navigation[0],
      `/pages/canteen-floor-score-detail/canteen-floor-score-detail?floorId=${floorId}`,
    );
    assert.equal(
      press(
        'canteen-floor-scores',
        'onOpenFloor',
        f.target,
        { item: { id: floorId, label: '合成夹层' }, busy: true },
        (n) => n.tag === 'wu-f7-list-item',
      ),
      0,
    );
    const count = f.navigation.length;
    invoke(f.target, 'onHide');
    press(
      'canteen-floor-scores',
      'onOpenFloor',
      f.target,
      { item: { id: floorId, label: '合成夹层' }, busy: false },
      (n) => n.tag === 'wu-f7-list-item',
    );
    assert.equal(f.navigation.length, count);
  } finally {
    f.close();
  }
});

test('real Input/Button → floor Page requires valid decimal and explicit first-score confirmation; repeats cannot create a second score', async () => {
  const s = floorHarness();
  s.controller.dispose();
  const f = mount('canteen-floor-score-detail', s.runtime, { floorId });
  try {
    await flush();
    assert.equal(f.target.data.canScore, true);
    for (const value of ['0', '5.1', ' 4.75 ', '-1', 'bad']) {
      input('canteen-floor-score-detail', 'onScore', f.target, value);
      assert.equal(f.target.data.selectedScore, null);
    }
    input('canteen-floor-score-detail', 'onScore', f.target, '4.75');
    assert.equal(f.target.data.selectedScore, 4.75);
    assert.equal(s.commands.length, 0);
    press('canteen-floor-score-detail', 'onConfirm', f.target);
    assert.equal(f.target.data.confirming, 'score');
    press('canteen-floor-score-detail', 'onCloseConfirmation', f.target);
    assert.equal(f.target.data.confirming, null);
    assert.equal(s.commands.length, 0);
    press('canteen-floor-score-detail', 'onConfirm', f.target);
    press('canteen-floor-score-detail', 'onSubmit', f.target);
    assert.equal(press('canteen-floor-score-detail', 'onSubmit', f.target), 0);
    await flush();
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0]!.score, 4.75);
    assert.equal(f.target.data.canScore, false);
    assert.equal(s.pendingFloorRatings.load(s.accountId), null);
    press('canteen-floor-score-detail', 'onSubmit', f.target);
    await flush();
    assert.equal(s.commands.length, 1);
  } finally {
    f.close();
  }
});

test('real floor recovery controls preserve frozen original decimal request and durable cancellation intent', async () => {
  const s = floorHarness();
  s.controller.dispose();
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic lost response');
  };
  const f = mount('canteen-floor-score-detail', s.runtime, { floorId });
  try {
    await flush();
    input('canteen-floor-score-detail', 'onScore', f.target, '4.75');
    press('canteen-floor-score-detail', 'onConfirm', f.target);
    press('canteen-floor-score-detail', 'onSubmit', f.target);
    await flush();
    const original = s.pendingFloorRatings.load(s.accountId)!;
    assert.equal(original.command.clientRequestId, requestId);
    assert.equal(original.command.score, 4.75);
    assert.equal(
      input('canteen-floor-score-detail', 'onScore', f.target, '1'),
      0,
    );
    press('canteen-floor-score-detail', 'onRecover', f.target);
    await flush();
    assert.deepEqual(s.pendingFloorRatings.load(s.accountId), original);
    press('canteen-floor-score-detail', 'onRetry', f.target);
    await flush();
    assert.deepEqual(s.commands[1], s.commands[0]);
    assert.equal(s.ids.count, 1);
    press('canteen-floor-score-detail', 'onRequestCancellation', f.target);
    await flush();
    assert.equal(f.target.data.confirming, 'cancel');
    const cancel = s.impl.cancel;
    s.impl.cancel = async () => {
      throw new ClientError('network', 'Synthetic lost cancel');
    };
    press('canteen-floor-score-detail', 'onConfirmCancellation', f.target);
    await flush();
    assert.deepEqual(s.pendingFloorRatings.load(s.accountId), {
      ...original,
      phase: 'cancel',
    });
    s.impl.cancel = cancel;
    press('canteen-floor-score-detail', 'onRetry', f.target);
    await flush();
    assert.equal(s.pendingFloorRatings.load(s.accountId), null);
    assert.equal(s.commands.length, 2);
  } finally {
    f.close();
  }
});

test('real Input confirm/ListItem → window catalog Page preserves raw minimum, filter/picker identity and target navigation', async () => {
  const s = windowHarness('catalog');
  s.controller.dispose();
  const f = mount('window-ratings', s.runtime);
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    press('window-ratings', 'onCanteen', f.target, {
      item: { id: canteenId, selected: false },
    });
    invoke(f.target, 'onFloor', { detail: { value: '1' } });
    assert.equal(f.target.data.floorDraft, floorId);
    input('window-ratings', 'onMinimum', f.target, '4.75');
    assert.equal(f.target.data.minRatingDraft, '4.75');
    const c = control('window-ratings', 'onMinimum', f.target);
    c.confirm('4.75');
    c.detach();
    await flush();
    const query = s.calls.filter((call) => call.method === 'list').slice(-1)[0]!
      .args[0];
    assert.deepEqual(query, {
      canteenIds: [canteenId],
      floorId,
      minRating: 4.75,
    });
    const item = (f.target.data.items as object[])[0];
    press('window-ratings', 'onWindow', f.target, { item });
    assert.equal(
      f.navigation[0],
      `/pages/window-rating-detail/window-rating-detail?windowId=${windowId}`,
    );
    assert.equal(
      press('window-ratings', 'onWindow', f.target, { item, busy: true }),
      0,
    );
    input('window-ratings', 'onMinimum', f.target, ' raw ');
    assert.equal(f.target.data.minRatingDraft, ' raw ');
  } finally {
    f.close();
  }
});

test('real signed score Buttons → window Page preserve zero, version-fenced edits, explicit confirmation and destination routes', async () => {
  const s = windowHarness();
  s.controller.dispose();
  s.impl.detail = async () =>
    windowDetail({
      myScore: {
        kind: 'recorded',
        score: -10,
        revision: scoreRevision,
        recordedAt,
      },
    });
  const f = mount('window-rating-detail', s.runtime, { windowId });
  try {
    await flush();
    for (let value = -10; value <= 10; value++) {
      press('window-rating-detail', 'onScore', f.target, {
        item: { value, label: String(value) },
      });
      assert.equal(f.target.data.selectedScore, value);
    }
    press('window-rating-detail', 'onScore', f.target, {
      item: { value: 0, label: '0' },
    });
    assert.equal(s.commands.length, 0);
    press('window-rating-detail', 'onConfirm', f.target);
    assert.equal(f.target.data.confirming, 'score');
    press('window-rating-detail', 'onCloseConfirmation', f.target);
    assert.equal(s.commands.length, 0);
    press('window-rating-detail', 'onConfirm', f.target);
    press('window-rating-detail', 'onSubmit', f.target);
    await flush();
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0]!.score, 0);
    assert.equal(s.commands[0]!.expectedOwnScoreRevision, scoreRevision);
    press('window-rating-detail', 'onOpenDiscussion', f.target);
    press('window-rating-detail', 'onOpenRecommendations', f.target);
    assert.deepEqual(f.navigation, [
      `/pages/window-discussion/window-discussion?windowId=${windowId}`,
      `/pages/window-dishes/window-dishes?windowId=${windowId}`,
    ]);
  } finally {
    f.close();
  }
});

test('real window recovery controls query before retry, retain zero intent and never resubmit after durable cancel', async () => {
  const s = windowHarness();
  s.controller.dispose();
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic lost');
  };
  const f = mount('window-rating-detail', s.runtime, { windowId });
  try {
    await flush();
    press('window-rating-detail', 'onScore', f.target, {
      item: { value: 0, label: '0' },
    });
    press('window-rating-detail', 'onConfirm', f.target);
    press('window-rating-detail', 'onSubmit', f.target);
    await flush();
    const original = s.pendingWindowRatings.load(s.accountId)!;
    press('window-rating-detail', 'onRetry', f.target);
    await flush();
    assert.deepEqual(s.commands[1], original.command);
    assert.equal(s.ids.count, 1);
    assert.deepEqual(
      s.calls
        .filter((c) => ['submit', 'receipt'].includes(c.method))
        .map((c) => c.method),
      ['submit', 'receipt', 'submit'],
    );
    press('window-rating-detail', 'onRequestCancellation', f.target);
    await flush();
    assert.equal(f.target.data.confirming, 'cancel');
    const cancel = s.impl.cancel;
    s.impl.cancel = async () => {
      throw new ClientError('network', 'Synthetic lost cancel');
    };
    press('window-rating-detail', 'onConfirmCancellation', f.target);
    await flush();
    assert.deepEqual(s.pendingWindowRatings.load(s.accountId), {
      ...original,
      phase: 'cancel',
    });
    s.impl.cancel = cancel;
    press('window-rating-detail', 'onRetry', f.target);
    await flush();
    assert.equal(s.pendingWindowRatings.load(s.accountId), null);
    assert.equal(s.commands.length, 2);
  } finally {
    f.close();
  }
});

test('real dish ListItem/Input/Button → Page preserves dish identity and raw names; recommendation/retraction require independent own lookup and confirmation', async () => {
  const s = dishHarness();
  s.controller.dispose();
  const item = {
    dishIdentity: dishIdentity('合成菜品'),
    dishName: '合成菜品',
    recommendationCount: 1,
    isRecommended: false,
    myMembershipRevision: null,
  };
  s.impl.list = async () => dishPage({ items: [item] });
  const f = mount('window-dishes', s.runtime, { windowId });
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    press('window-dishes', 'onDish', f.target, { item });
    await flush();
    assert.equal(f.target.data.nameDraft, item.dishName);
    assert.equal(f.target.data.canRecommend, true);
    assert.equal(s.commands.length, 0);
    input('window-dishes', 'onName', f.target, ' raw ');
    assert.equal(f.target.data.nameDraft, ' raw ');
    input('window-dishes', 'onName', f.target, item.dishName);
    press('window-dishes', 'onLookup', f.target);
    await flush();
    press('window-dishes', 'onRecommend', f.target);
    assert.equal(f.target.data.confirming, 'recommend');
    assert.equal(s.commands.length, 0);
    press('window-dishes', 'onCloseConfirmation', f.target);
    assert.equal(s.commands.length, 0);
    press('window-dishes', 'onRecommend', f.target);
    press('window-dishes', 'onSubmit', f.target);
    assert.equal(press('window-dishes', 'onSubmit', f.target), 0);
    await flush();
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0]!.dishName, item.dishName);
    assert.equal(
      s.calls.find((c) => c.method === 'submit')!.args[1],
      recommend,
    );
    s.ids.next = async () => otherId;
    press('window-dishes', 'onRetract', f.target);
    assert.equal(f.target.data.confirming, 'retract');
    press('window-dishes', 'onSubmit', f.target);
    await flush();
    assert.equal(s.commands[1]!.expectedMembershipRevision, scoreRevision);
    assert.equal(
      s.calls.filter((c) => c.method === 'submit')[1]!.args[1],
      retract,
    );
  } finally {
    f.close();
  }
});

test('real dish controls retain historical retraction when public source is unavailable; unknown own state cannot mutate', async () => {
  const s = dishHarness();
  s.controller.dispose();
  s.impl.list = async () => {
    throw new ClientError('http', 'Synthetic unavailable', {
      httpStatus: 503,
      serverCode: 'WINDOW_CATALOG_UNAVAILABLE',
    });
  };
  s.impl.own = async () => dishOwn();
  const f = mount('window-dishes', s.runtime, { windowId });
  try {
    await flush();
    assert.equal(f.target.data.loaded, false);
    input('window-dishes', 'onName', f.target, '合成菜品');
    press('window-dishes', 'onLookup', f.target);
    await flush();
    assert.equal(f.target.data.canRetract, true);
    press('window-dishes', 'onRetract', f.target);
    press('window-dishes', 'onSubmit', f.target);
    await flush();
    assert.equal(s.commands.length, 1);
    s.impl.own = async () => ({ kind: 'unavailable' });
    press('window-dishes', 'onLookup', f.target);
    await flush();
    assert.equal(f.target.data.canRetract, false);
    assert.equal(f.target.data.canRecommend, false);
    press('window-dishes', 'onRecommend', f.target);
    press('window-dishes', 'onSubmit', f.target);
    await flush();
    assert.equal(s.commands.length, 1);
  } finally {
    f.close();
  }
});

test('real dish cancellation controls retain exact raw original name, operation and request identity while public list is unavailable', async () => {
  const s = dishHarness();
  s.controller.dispose();
  const original = s.pending({ operation: retract });
  s.pendingDishRecommendations.freeze(original);
  s.impl.list = async () => {
    throw new ClientError('network', 'Synthetic unavailable');
  };
  const f = mount('window-dishes', s.runtime);
  try {
    await flush();
    assert.equal(f.target.data.frozen, true);
    assert.equal(f.target.data.loaded, false);
    assert.equal(input('window-dishes', 'onName', f.target, '替代菜名'), 0);
    press('window-dishes', 'onRequestCancellation', f.target);
    await flush();
    assert.equal(f.target.data.confirming, 'cancel');
    assert.equal(
      press('window-dishes', 'onConfirmCancellation', f.target, {
        receiptMissing: false,
      }),
      0,
    );
    const cancel = s.impl.cancel;
    s.impl.cancel = async () => {
      throw new ClientError('network', 'Synthetic lost cancel');
    };
    press('window-dishes', 'onConfirmCancellation', f.target);
    await flush();
    assert.deepEqual(s.pendingDishRecommendations.load(s.accountId), {
      ...original,
      phase: 'cancel',
    });
    s.impl.cancel = cancel;
    press('window-dishes', 'onRetry', f.target);
    await flush();
    assert.equal(s.pendingDishRecommendations.load(s.accountId), null);
    assert.equal(s.commands.length, 0);
    assert.equal(s.ids.count, 0);
    for (const call of s.calls.filter((c) => c.method === 'cancel'))
      assert.deepEqual(call.args.slice(0, 3), [
        original.windowId,
        original.operation,
        original.command,
      ]);
  } finally {
    f.close();
  }
});

for (const page of [
  'canteen-floor-score-detail',
  'window-rating-detail',
  'window-dishes',
])
  test(`${page}: hidden/detached Components and late read after account replacement cannot dispatch mutations or restore prior content`, async () => {
    const s = page.startsWith('canteen')
      ? floorHarness()
      : page === 'window-rating-detail'
        ? windowHarness()
        : dishHarness();
    s.controller.dispose();
    const late = deferred<
      | ReturnType<typeof floorDetail>
      | ReturnType<typeof windowDetail>
      | ReturnType<typeof dishPage>
    >();
    if ('detail' in s.impl)
      s.impl.detail = (() => late.promise) as typeof s.impl.detail;
    else s.impl.list = (() => late.promise) as typeof s.impl.list;
    const f = mount(
      page,
      s.runtime,
      page.startsWith('canteen') ? { floorId } : { windowId },
    );
    try {
      const c = control(page, 'onRefresh', f.target, { busy: false });
      c.hide();
      c.press();
      assert.equal(c.dispatched(), 0);
      c.detach();
      c.press();
      assert.equal(c.dispatched(), 0);
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('replacement'),
        accountId: otherId,
      });
      late.resolve(
        page.startsWith('canteen')
          ? floorDetail()
          : page === 'window-rating-detail'
            ? windowDetail()
            : dishPage(),
      );
      await flush();
      assert.equal(f.target.data.loaded, false);
      assert.equal(f.target.data.detail ?? null, null);
      assert.deepEqual(f.target.data.items ?? [], []);
      assert.equal(s.commands.length, 0);
    } finally {
      f.close();
    }
  });

test('fixture corpus covers all five routes, unknown history, confirmation, recovery, guest and interrupted states without private/provider data', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-dining-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.ok(fixtures.length >= 50);
  assert.equal(new Set(fixtures.map((f) => f.id)).size, fixtures.length);
  assert.deepEqual(
    [...new Set(fixtures.map((f) => f.page))].sort(),
    [...pages].sort(),
  );
  for (const fixture of fixtures) {
    assert.ok(fixture.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|wxfile:\/\/|accessToken|refreshToken|accountId|privateAuthor|providerId/,
    );
  }
  for (const state of [
    'guest',
    'busy',
    'recovery',
    'error',
    'score-confirm',
    'cancel-confirm',
    'unknown',
    'recommend-confirm',
    'retract-confirm',
  ])
    assert.ok(
      fixtures.some((f) => f.id.includes(state)),
      state,
    );
});

// Source-only text projection: expand the actual local templates and real
// component slots/controlled properties, not screenshots or device evidence.
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
    '../scripts/fixtures/framework7-dining-preview.mjs',
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
  }
});

test('real next-page Buttons retain continuation identities and clear stale window/dish snapshots', async () => {
  const w = windowHarness('catalog');
  w.controller.dispose();
  w.impl.list = async () =>
    windowPage({ nextCursor: 'next', continuation: 'more' });
  const wf = mount('window-ratings', w.runtime);
  try {
    await flush();
    assert.equal(wf.target.data.canNext, true);
    w.impl.list = async () => windowPage({ scoreRevision: '2' });
    press('window-ratings', 'onNext', wf.target);
    await flush();
    assert.equal(
      w.calls.filter((c) => c.method === 'list').slice(-1)[0]!.args[1],
      'next',
    );
    assert.equal(wf.target.data.restartRequired, true);
    assert.deepEqual(wf.target.data.items, []);
    assert.equal(wf.target.data.loaded, false);
  } finally {
    wf.close();
  }
  const d = dishHarness();
  d.controller.dispose();
  d.impl.list = async () =>
    dishPage({
      nextCursor: 'next',
      continuation: 'more',
      items: [
        {
          dishIdentity: dishIdentity('菜'),
          dishName: '菜',
          recommendationCount: 1,
          isRecommended: false,
          myMembershipRevision: null,
        },
      ],
    });
  const df = mount('window-dishes', d.runtime, { windowId });
  try {
    await flush();
    assert.equal(df.target.data.canNext, true);
    d.impl.list = async () => dishPage({ membershipRevision: '2' });
    press('window-dishes', 'onNext', df.target);
    await flush();
    assert.equal(
      d.calls.filter((c) => c.method === 'list').slice(-1)[0]!.args[1],
      'next',
    );
    assert.equal(df.target.data.restartRequired, true);
    assert.deepEqual(df.target.data.items, []);
    assert.equal(df.target.data.loaded, false);
  } finally {
    df.close();
  }
});

test('real editor lifecycle suppresses hidden/detached and disabled inputs without normalizing raw values', async () => {
  const s = dishHarness();
  s.controller.dispose();
  const f = mount('window-dishes', s.runtime, { windowId });
  try {
    await flush();
    input('window-dishes', 'onName', f.target, '  菜  ');
    assert.equal(f.target.data.nameDraft, '  菜  ');
    const hidden = control('window-dishes', 'onName', f.target);
    hidden.hide();
    hidden.input('变更');
    assert.equal(hidden.dispatched(), 0);
    hidden.detach();
    hidden.input('再变更');
    assert.equal(hidden.dispatched(), 0);
    const disabled = control('window-dishes', 'onName', f.target, {
      busy: true,
    });
    disabled.input('被禁用');
    assert.equal(disabled.dispatched(), 0);
    disabled.detach();
    assert.equal(f.target.data.nameDraft, '  菜  ');
  } finally {
    f.close();
  }
});
