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
  courseHarness,
  id,
  otherId,
  page as coursePage,
  receipt as courseReceipt,
  requestId,
  detail,
} from './course-ratings-helpers';
import {
  commentsHarness,
  body,
  commentId,
  publish,
  like,
  receipt as commentReceipt,
  page as commentsPage,
} from './course-comments-helpers';
import { deferred, flush as shortFlush } from './helpers';
import { wireCredentials } from './identity-helpers';
const root = path.join(__dirname, '..');
const nativeRequire = createRequire(__filename);
const { parsePreviewWxml: parse } = nativeRequire(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const pages = ['course-ratings', 'course-rating-detail', 'course-comments'];
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
  read('test/fixtures/framework7-courses-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-courses-before-protected.json'),
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
        'disabled',
        'loading',
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
        'conditional adjacency',
      );
    conditionalChains(child);
  });
}
for (const [file, before] of Object.entries(baseline))
  test(`${file}: exact original actions, datasets, disabled/loading, editor constraints and ancestor gates`, () => {
    const tree = parse(
      read(
        file.replace(
          '/course-ratings/product.wxml',
          '/course-ratings/framework7-product.wxml',
        ),
      ),
    );
    const current = actions(tree);
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
    conditionalChains(tree);
  });
test('65 protected files keep course business/controllers/gateways, accepted roots, global tokens and shipped components byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 65);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
for (const page of pages)
  test(`${page}: isolated existing native registration and no framework/browser/overlay runtime`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-button'));
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-block'));
    for (const node of nodes.filter((node) => node.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-list-item') {
        assert.equal(node.attrs.link, '{{true}}');
        assert.equal(flatten(node).length, 1, 'no nested independent actions');
      }
    }
    assert.ok(
      !nodes.some((node) =>
        /^(button|input|web-view|wu-f7-sheet|wu-f7-dialog|wu-f7-actions)$/.test(
          node.tag,
        ),
      ),
    );
    assert.match(
      source(page, 'wxss'),
      /course-ratings\/framework7-product\.wxss/,
    );
    assert.doesNotMatch(source(page), /rich-text|data:image|https?:\/\//);
  });
test('native picker/textarea boundaries, irreversible scoring/likes and anonymous-only comment surface remain explicit', () => {
  const catalog = flatten(parse(source('course-ratings')));
  assert.equal(
    catalog.find((node) => node.attrs.bindchange === 'onDepartment')?.tag,
    'picker',
  );
  const comments = flatten(parse(source('course-comments')));
  const textarea = comments.find((node) => node.attrs.bindinput === 'onBody')!;
  assert.equal(textarea.tag, 'textarea');
  assert.equal(textarea.attrs.maxlength, '8000');
  assert.equal(textarea.attrs.disabled, '{{busy || confirming}}');
  assert.doesNotMatch(
    source('course-comments'),
    /item\.(author|avatar|persona|isMine|viewer|isLiked)|onUnlike|onDelete|onReply|authorMode/,
  );
  assert.match(source('course-comments'), /点赞后不能取消，每条回复仅可赞一次/);
  assert.match(source('course-rating-detail'), /提交后不能修改或删除/);
  assert.match(source('course-comments'), /暂未查到结果，不代表已取消/);
});
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { type: unknown; value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
interface Capture {
  press(): boolean;
  detach(): void;
  lifecycle(name: string): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Capture;
  find(
    handler: string,
    dataset?: Record<string, unknown>,
  ): PresentationNode | undefined;
  lifecycle(name: string): void;
  emissions: Array<{
    type: string;
    detail: unknown;
    currentTarget: { dataset: Record<string, unknown> };
  }>;
}
const { createNativePressBridge } = nativeRequire(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: {
    page: Owner;
    pageFile: string;
    dist: string;
    extension: 'ts';
  }): Bridge;
};
const model = nativeRequire('../scripts/smoke-ratings.mjs') as {
  parse(source: string): PresentationNode;
  render(
    nodes: (PresentationNode | string)[],
    scope: unknown,
    templates: Record<string, PresentationNode>,
  ): PresentationNode[];
};
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = globals[kind];
  let value: T | undefined;
  globals[kind] = (definition: T) => {
    value = definition;
  };
  try {
    const target = nativeRequire.resolve(path.join(root, 'src', file));
    delete nativeRequire.cache[target];
    nativeRequire(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(value);
  return value;
}
function invoke(target: Owner, name: string, event?: unknown) {
  return (target[name] as (event?: unknown) => unknown).call(target, event);
}
async function flush() {
  for (let i = 0; i < 20; i++) await shortFlush();
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
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  invoke(target, 'onLoad', query);
  invoke(target, 'onShow');
  const bridge = createNativePressBridge({
    page: target,
    pageFile: path.join(root, `src/pages/${page}/${page}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  return {
    target,
    bridge,
    navigation,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const c = bridge.capture(handler, dataset);
      const result = c.press();
      c.detach();
      return result;
    },
    hide() {
      bridge.lifecycle('hide');
      invoke(target, 'onHide');
    },
    close() {
      bridge.lifecycle('detach');
      invoke(target, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
function editor(target: Owner, handler: string) {
  const templates = Object.fromEntries(
    model
      .parse(read('src/course-ratings/framework7-product.wxml'))
      .children.filter(
        (node): node is PresentationNode =>
          typeof node !== 'string' && node.tag === 'template',
      )
      .map((node) => [node.attrs.name!, node]),
  );
  const rendered = model.render(
    model.parse(source('course-ratings')).children,
    target.data,
    templates,
  );
  const node = rendered
    .flatMap(flatten)
    .find(
      (node) =>
        node.tag === 'wu-f7-input' && node.attrs['bind:input'] === handler,
    );
  assert.ok(node, `visible actual input ${handler}`);
  const definition = registration<Definition>(
    'Component',
    'components/f7-input/f7-input.ts',
  );
  const properties = Object.fromEntries(
    Object.entries(definition.properties).map(([key, property]) => {
      const raw =
        node.attrs[
          key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
        ];
      return [
        key,
        raw === undefined
          ? structuredClone(property.value)
          : property.type === Boolean
            ? raw === 'true'
            : property.type === Number
              ? Number(raw)
              : raw,
      ];
    }),
  );
  let emitted = 0;
  const instance: Instance = {
    properties,
    data: structuredClone(definition.data),
    ...definition.methods,
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail, options) {
      assert.deepEqual(options, { bubbles: false, composed: false });
      emitted++;
      invoke(target, node.attrs[`bind:${name}`]!, { detail });
    },
  };
  definition.lifetimes!.attached!.call(instance);
  const inner = flatten(
    parse(read('src/components/f7-input/f7-input.wxml')),
  ).find((node) => node.tag === 'input')!;
  assert.equal(inner.attrs.catchinput, 'onInput');
  assert.equal(inner.attrs.catchconfirm, 'onConfirm');
  return {
    input(value: string) {
      return definition.methods.onInput!.call(instance, {
        detail: { value, cursor: value.length },
      });
    },
    confirm(value: string) {
      return definition.methods.onConfirm!.call(instance, {
        detail: { value },
      });
    },
    hide() {
      definition.pageLifetimes!.hide!.call(instance);
    },
    detach() {
      definition.lifetimes!.detached!.call(instance);
    },
    emitted: () => emitted,
    properties,
    data: instance.data,
  };
}
function nativeBody(target: Owner, value: string) {
  const tree = model.render(
    model.parse(source('course-comments')).children,
    target.data,
    {},
  );
  assert.ok(
    tree
      .flatMap(flatten)
      .some(
        (node) =>
          node.tag === 'textarea' &&
          node.attrs.bindinput === 'onBody' &&
          node.attrs.disabled !== 'true',
      ),
  );
  invoke(target, 'onBody', { detail: { value } });
}
function scores(f: ReturnType<typeof mount>) {
  f.press('onTogglePanel', { panel: 'score' });
  assert.equal(f.bridge.find('onSubmit'), undefined);
  f.press('onScore', { axis: 'gradeScore', score: 0.5 });
  assert.equal(f.press('onConfirm'), false);
  f.press('onScore', { axis: 'abilityScore', score: 4.5 });
  f.press('onScore', { axis: 'overallScore', score: 1.5 });
  f.press('onConfirm');
  assert.equal(f.target.data.confirming, true);
}
test('actual Input/ListItem/Button → catalog Page → controller preserves raw draft, exclusive filters, sorting and route identity', async () => {
  const s = courseHarness('catalog');
  s.controller.dispose();
  const f = mount('course-ratings', s.runtime);
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    const input = editor(f.target, 'onSearchInput');
    assert.equal(input.properties.maxlength, 80);
    assert.equal(input.data.nativeMaxlength, 80);
    assert.equal(input.input('  原文查询  '), undefined);
    assert.equal(f.target.data.searchDraft, '  原文查询  ');
    input.confirm('  原文查询  ');
    input.detach();
    await flush();
    assert.equal(
      (
        s.calls.filter((call) => call.method === 'list').slice(-1)[0]!
          .args[0] as { search: string }
      ).search,
      '原文查询',
    );
    f.press('onTogglePanel', { panel: 'filters' });
    const category = editor(f.target, 'onCategoryInput');
    category.input('合成类别');
    category.detach();
    assert.equal(f.target.data.categoryDraft, '合成类别');
    invoke(f.target, 'onDepartment', { detail: { value: '2' } });
    assert.equal(f.target.data.departmentDraft, 2);
    assert.equal(f.target.data.categoryDraft, '');
    f.press('onSort', { sort: 'time' });
    f.press('onSearch');
    await flush();
    assert.equal(
      (
        s.calls.filter((call) => call.method === 'list').slice(-1)[0]!
          .args[0] as { sort: string }
      ).sort,
      'time',
    );
    assert.equal(f.press('onCourse', { id }), true);
    assert.equal(
      f.navigation[0],
      `/pages/course-rating-detail/course-rating-detail?courseId=${id}`,
    );
    assert.equal(f.bridge.emissions.slice(-1)[0]!.currentTarget.dataset.id, id);
    const stale = f.bridge.capture('onCourse', { id });
    f.hide();
    assert.equal(stale.press(), false);
    assert.equal(f.navigation.length, 1);
  } finally {
    f.close();
  }
});
test('actual catalog controls enforce busy/hidden and native editor lifecycle fences without replacing raw values', async () => {
  const s = courseHarness('catalog');
  s.controller.dispose();
  const f = mount('course-ratings', s.runtime);
  try {
    await flush();
    const input = editor(f.target, 'onSearchInput');
    input.hide();
    input.input('hidden');
    assert.equal(input.emitted(), 0);
    input.detach();
    const wait = deferred<ReturnType<typeof coursePage>>();
    s.impl.list = () => wait.promise;
    f.press('onSearch');
    await flush();
    assert.equal(f.target.data.busy, true);
    const before = s.calls.length;
    assert.equal(f.press('onSearch'), false);
    assert.equal(f.press('onSort', { sort: 'time' }), false);
    const busy = editor(f.target, 'onSearchInput');
    busy.input('busy');
    busy.confirm('busy');
    assert.equal(busy.emitted(), 0);
    busy.detach();
    assert.equal(s.calls.length, before);
    assert.equal(f.press('onCancel'), true);
    wait.resolve(coursePage());
    await flush();
    assert.equal(f.target.data.busy, false);
  } finally {
    f.close();
  }
});
test('actual score Buttons → detail Page require independent selections, final confirmation and read-only success', async () => {
  const s = courseHarness();
  s.controller.dispose();
  const f = mount('course-rating-detail', s.runtime, { courseId: id });
  try {
    await flush();
    assert.equal(f.target.data.canScore, true);
    scores(f);
    assert.equal(s.commands.length, 0);
    f.press('onCloseConfirmation');
    assert.equal(f.target.data.confirming, false);
    assert.equal(s.commands.length, 0);
    f.press('onConfirm');
    f.press('onSubmit');
    await flush();
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0]!.gradeScore, 0.5);
    assert.equal(s.commands[0]!.abilityScore, 4.5);
    assert.equal(s.commands[0]!.overallScore, 1.5);
    assert.equal(f.target.data.canScore, false);
    assert.equal(f.bridge.find('onSubmit'), undefined);
    assert.equal(f.bridge.find('onScore'), undefined);
    assert.equal(s.pendingCourseRatings.load(s.accountId), null);
  } finally {
    f.close();
  }
});
test('actual frozen score recovery queries before retry and retains original id, versions and three independent scores', async () => {
  const s = courseHarness();
  s.controller.dispose();
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic lost response');
  };
  const f = mount('course-rating-detail', s.runtime, { courseId: id });
  try {
    await flush();
    scores(f);
    f.press('onSubmit');
    await flush();
    assert.equal(f.target.data.frozen, true);
    assert.equal(f.bridge.find('onScore'), undefined);
    const pending = s.pendingCourseRatings.load(s.accountId)!;
    assert.equal(pending.payload.clientRequestId, requestId);
    f.press('onRecover');
    await flush();
    assert.deepEqual(s.pendingCourseRatings.load(s.accountId), pending);
    s.impl.submit = async (courseId, input) => courseReceipt(input, courseId);
    f.press('onRetry');
    await flush();
    assert.equal(s.commands.length, 2);
    assert.deepEqual(s.commands[0], s.commands[1]);
    assert.equal(s.ids.count, 1);
    assert.deepEqual(
      s.calls
        .filter((call) => ['receipt', 'submit'].includes(call.method))
        .slice(-2)
        .map((call) => call.method),
      ['receipt', 'submit'],
    );
  } finally {
    f.close();
  }
});
test('actual comments Buttons → Page → controller preserve native raw text, separate preview and frozen receipt-first retry', async () => {
  const s = commentsHarness();
  s.controller.dispose();
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic lost response');
  };
  const f = mount('course-comments', s.runtime, { courseId: id });
  try {
    await flush();
    f.press('onTogglePanel', { panel: 'compose' });
    nativeBody(f.target, body);
    assert.equal(f.target.data.body, body);
    assert.equal(f.bridge.find('onSubmit'), undefined);
    f.press('onConfirmPublish');
    assert.equal(s.commands.length, 0);
    f.press('onCloseConfirmation');
    assert.equal(f.target.data.body, body);
    f.press('onConfirmPublish');
    const duplicate = f.bridge.capture('onSubmit');
    f.press('onSubmit');
    assert.equal(duplicate.press(), false);
    await flush();
    assert.deepEqual(s.commands, [publish()]);
    assert.equal(f.target.data.frozen, true);
    assert.equal(f.target.data.body, '');
    assert.equal(f.target.data.recoveryBody, body);
    assert.equal(f.bridge.find('onConfirmPublish'), undefined);
    assert.equal(f.bridge.find('onConfirmLike'), undefined);
    const original = s.pendingCourseComments.load(s.accountId);
    f.press('onRecover');
    await flush();
    assert.deepEqual(s.pendingCourseComments.load(s.accountId), original);
    s.impl.submit = async (intent) => commentReceipt(intent);
    f.press('onRetry');
    await flush();
    assert.deepEqual(s.commands[0], s.commands[1]);
    assert.equal(s.ids.count, 1);
    assert.equal(s.pendingCourseComments.load(s.accountId), null);
  } finally {
    f.close();
  }
});
test('actual anonymous course like has separate irreversible confirmation and exact comment tuple, never unlike or author controls', async () => {
  const s = commentsHarness();
  s.controller.dispose();
  const f = mount('course-comments', s.runtime, { courseId: id });
  try {
    await flush();
    assert.equal(f.bridge.find('onSubmit'), undefined);
    f.press('onConfirmLike', { id: commentId });
    assert.equal(f.target.data.confirming, 'like');
    assert.equal(s.commands.length, 0);
    f.press('onCloseConfirmation');
    assert.equal(s.commands.length, 0);
    f.press('onConfirmLike', { id: commentId });
    f.press('onSubmit');
    await flush();
    assert.deepEqual(s.commands, [like()]);
    assert.match(String(f.target.data.receiptStatus), /不能取消/);
    assert.equal(f.bridge.find('onUnlike'), undefined);
    assert.equal(f.bridge.find('onAuthor'), undefined);
  } finally {
    f.close();
  }
});
test('actual recovery cancel first queries, separately confirms, preserves unknown journal and cannot cancel an applied like', async () => {
  const s = commentsHarness();
  s.controller.dispose();
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic lost response');
  };
  const f = mount('course-comments', s.runtime, { courseId: id });
  try {
    await flush();
    f.press('onConfirmLike', { id: commentId });
    f.press('onSubmit');
    await flush();
    const pending = s.pendingCourseComments.load(s.accountId)!;
    assert.equal(f.bridge.find('onConfirmCancellation'), undefined);
    f.press('onRequestCancellation');
    await flush();
    assert.equal(f.target.data.confirming, 'cancel');
    assert.equal(s.calls.filter((call) => call.method === 'cancel').length, 0);
    assert.equal(f.press('onRetry'), false);
    f.press('onCloseConfirmation');
    assert.deepEqual(s.pendingCourseComments.load(s.accountId), pending);
    f.press('onRequestCancellation');
    await flush();
    s.impl.cancel = async (intent) => commentReceipt(intent);
    f.press('onConfirmCancellation');
    await flush();
    assert.equal(s.calls.filter((call) => call.method === 'cancel').length, 1);
    assert.equal(s.pendingCourseComments.load(s.accountId), null);
    assert.match(String(f.target.data.receiptStatus), /不能取消/);
  } finally {
    f.close();
  }
});
test('actual comments pagination/sort and captured row events respect replacement, page-hide and account clearing', async () => {
  const s = commentsHarness();
  s.controller.dispose();
  s.impl.list = async (_id, _sort, cursor) =>
    commentsPage({
      nextCursor: cursor ? null : 'synthetic-cursor',
      continuation: cursor ? 'end' : 'more',
    });
  const f = mount('course-comments', s.runtime, { courseId: id });
  try {
    await flush();
    const old = f.bridge.capture('onConfirmLike', { id: commentId });
    f.press('onNext');
    assert.equal(old.press(), false);
    await flush();
    assert.equal(f.target.data.pageNumber, 2);
    f.press('onSort', { sort: 'time' });
    await flush();
    assert.equal(f.target.data.sort, 'time');
    assert.equal(f.target.data.pageNumber, 1);
    const accountStale = f.bridge.capture('onConfirmLike', { id: commentId });
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('b'),
      accountId: otherId,
    });
    await flush();
    assert.equal(accountStale.press(), false);
    assert.deepEqual(f.target.data.items, []);
    const before = s.commands.length;
    f.hide();
    assert.equal(accountStale.press(), false);
    assert.equal(s.commands.length, before);
  } finally {
    f.close();
  }
});
test('unavailable first-score history never presents mutation controls or a zero/empty success', async () => {
  const s = courseHarness();
  s.controller.dispose();
  s.impl.detail = async () => detail({ myScore: { kind: 'unavailable' } });
  const f = mount('course-rating-detail', s.runtime, { courseId: id });
  try {
    await flush();
    assert.equal(f.target.data.canScore, false);
    assert.equal(f.bridge.find('onScore'), undefined);
    assert.equal(f.bridge.find('onSubmit'), undefined);
  } finally {
    f.close();
  }
});

test('34 fictional course fixtures expand actual registered component WXML and slots without invoking business actions', () => {
  const { default: fixtures } = nativeRequire(
    '../scripts/fixtures/framework7-courses-preview.mjs',
  ) as {
    default: Array<{
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }>;
  };
  const { nativeComponentPreviewState } = nativeRequire(
    '../scripts/preview-native-component.mjs',
  ) as {
    nativeComponentPreviewState(
      definition: Definition,
      attrs: Record<string, string>,
      evaluate: (value: string) => string,
    ): Record<string, unknown>;
  };
  assert.equal(fixtures.length, 34);
  assert.equal(
    new Set(fixtures.map((fixture) => fixture.id)).size,
    fixtures.length,
  );
  const definitions = new Map<string, Definition>();
  const templates = Object.fromEntries(
    model
      .parse(read('src/course-ratings/framework7-product.wxml'))
      .children.filter(
        (node): node is PresentationNode =>
          typeof node !== 'string' && node.tag === 'template',
      )
      .map((node) => [node.attrs.name!, node]),
  );
  function text(
    nodes: (PresentationNode | string)[],
    slots: Record<string, (PresentationNode | string)[]> = {},
  ): string {
    return nodes
      .map((node) => {
        if (typeof node === 'string') return node;
        if (node.tag === 'slot')
          return text(slots[node.attrs.name ?? 'default'] ?? []);
        if (node.tag.startsWith('wu-f7-')) {
          const kind = node.tag.slice(3);
          if (!definitions.has(kind))
            definitions.set(
              kind,
              registration<Definition>(
                'Component',
                `components/${kind}/${kind}.ts`,
              ),
            );
          const data = nativeComponentPreviewState(
            definitions.get(kind)!,
            node.attrs,
            (value) => value,
          );
          const componentSlots: Record<string, (PresentationNode | string)[]> =
            {};
          for (const child of node.children) {
            const name =
              typeof child === 'string'
                ? 'default'
                : (child.attrs.slot ?? 'default');
            (componentSlots[name] ??= []).push(child);
          }
          return text(
            model.render(
              model.parse(read(`src/components/${kind}/${kind}.wxml`)).children,
              data,
              {},
            ),
            componentSlots,
          );
        }
        return text(node.children, slots);
      })
      .join(' ');
  }
  for (const fixture of fixtures) {
    assert.ok(pages.includes(fixture.page));
    const definition = registration<Owner>(
      'Page',
      `pages/${fixture.page}/${fixture.page}.ts`,
    );
    const projection = text(
      model.render(
        model.parse(source(fixture.page)).children,
        { ...definition.data, ...fixture.patch },
        templates,
      ),
    ).replace(/\s+/g, ' ');
    for (const expected of fixture.expectedText)
      assert.ok(projection.includes(expected), `${fixture.id}: ${expected}`);
    assert.doesNotMatch(projection, /undefined|\[object Object\]/, fixture.id);
  }
});

test('actual course catalog pagination replaces rows and revision drift requires a fresh read', async () => {
  const s = courseHarness('catalog');
  s.controller.dispose();
  s.impl.list = async () =>
    coursePage({ nextCursor: 'synthetic-next', continuation: 'more' });
  const f = mount('course-ratings', s.runtime);
  try {
    await flush();
    assert.equal(f.target.data.canNext, true);
    s.impl.list = async () => coursePage({ scoreRevision: '2' });
    f.press('onNext');
    await flush();
    assert.equal(f.target.data.restartRequired, true);
    assert.equal(f.target.data.loaded, false);
    assert.deepEqual(f.target.data.items, []);
    assert.equal(f.bridge.find('onCourse', { id }), undefined);
    s.impl.list = async () => coursePage();
    f.press('onRefresh');
    await flush();
    assert.equal(f.target.data.loaded, true);
    assert.equal(f.target.data.pageNumber, 1);
    assert.equal(f.target.data.restartRequired, false);
  } finally {
    f.close();
  }
});
test('all thirty rendered half-step controls dispatch numeric datasets and never derive one score from another', async () => {
  const s = courseHarness();
  s.controller.dispose();
  const f = mount('course-rating-detail', s.runtime, { courseId: id });
  try {
    await flush();
    f.press('onTogglePanel', { panel: 'score' });
    for (const axis of ['gradeScore', 'abilityScore', 'overallScore']) {
      for (let half = 1; half <= 10; half++) {
        assert.equal(f.press('onScore', { axis, score: half / 2 }), true);
        assert.equal(f.target.data[axis], half / 2);
        const dataset = f.bridge.emissions.slice(-1)[0]!.currentTarget.dataset;
        assert.equal(dataset.axis, axis);
        assert.equal(typeof dataset.score, 'number');
        if (axis === 'gradeScore') {
          assert.equal(f.target.data.abilityScore, null);
          assert.equal(f.target.data.overallScore, null);
        }
        if (axis === 'abilityScore') {
          assert.equal(f.target.data.gradeScore, 5);
          assert.equal(f.target.data.overallScore, null);
        }
      }
    }
    assert.equal(s.commands.length, 0);
    assert.equal(f.target.data.confirming, false);
    assert.equal(f.bridge.find('onSubmit'), undefined);
  } finally {
    f.close();
  }
});
