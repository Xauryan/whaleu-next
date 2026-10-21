import {
  assertReviewedNoticeReadSuccessor,
  reviewedNoticePresentation,
} from './reviewed-notice-read-successor';
import { assertReviewedSocialSuccessor } from './reviewed-social-successor';
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
  harness,
  targetId,
  categoryId,
  revision,
  requestId,
  commentId,
  receipt,
  categoryPage,
  cursor,
  target,
} from './ratings-helpers';
import {
  r2aHarness,
  route as threadRoute,
  reply,
  replyId,
  replyPage,
} from './ratings-r2a-helpers';
import {
  managementHarness,
  creationContext,
} from './ratings-management-helpers';
import {
  scopedHarness,
  scopedContext,
  scopedReceipt,
} from './rating-scoped-helpers';
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
  'rating-catalog',
  'rating-detail',
  'rating-thread',
  'rating-create',
  'rating-scoped',
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
  read('test/fixtures/framework7-ratings-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-ratings-before-protected.json'),
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
    const file =
      original === 'src/ratings/product.wxml'
        ? 'src/ratings/framework7-product.wxml'
        : original;
    const tree = parse(reviewedNoticePresentation(file, read(file))),
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
    conditionalChains(tree);
  });

test('146 protected files: controllers, gateway/contracts, originals, accepted roots, globals and native cover pipeline are byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 146);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedBusinessSuccessor(file, expected) &&
      !assertReviewedNoticeReadSuccessor(file, expected) &&
      !assertReviewedSocialSuccessor(file, expected),
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
    assert.match(source(page), /framework7-product\.wxml/);
    assert.match(source(page, 'wxss'), /framework7-product\.wxss/);
    assert.doesNotMatch(source(page), /rich-text|data:image|https?:\/\//);
  });
test('thumbnail observer anchors, reply anchors, native media controls, textareas and confirmation bodies remain intact', () => {
  const nodes = flatten(parse(source('rating-scoped')));
  assert.equal(
    nodes.find((node) => node.attrs.id === 'rating-cover-row-{{item.id}}')?.tag,
    'view',
  );
  assert.equal(
    nodes.find((node) => node.attrs.binderror === 'onCoverThumbError')?.tag,
    'image',
  );
  assert.equal(
    flatten(parse(source('rating-thread'))).find(
      (node) => node.attrs.id === 'reply-{{item.id}}',
    )?.tag,
    'view',
  );
  assert.match(
    source('rating-scoped'),
    /import src="\.\.\/\.\.\/ratings\/target-cover\.wxml"/,
  );
  for (const page of ['rating-detail', 'rating-thread', 'rating-scoped']) {
    assert.ok(
      flatten(parse(source(page))).some(
        (node) =>
          node.tag === 'textarea' &&
          node.attrs.bindinput === 'onText' &&
          node.attrs.maxlength === '-1',
      ),
    );
    assert.match(source(page), /分身/);
  }
  assert.match(source('rating-detail'), /只修改评分，不发布文字/);
  assert.match(
    source('rating-detail'),
    /这条评价及其全部回复将不再显示，评分仍保留/,
  );
  assert.match(source('rating-thread'), /后续回复和独立评分保留/);
  assert.match(
    source('rating-scoped'),
    /服务端确认取消或返回原回执后才会释放请求编号/,
  );
  assert.equal(
    flatten(parse(read('src/ratings/target-cover.wxml'))).filter(
      (node) => node.tag === 'button',
    ).length,
    6,
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
    flatten(parse(read('src/ratings/framework7-product.wxml'))),
  );
  const node = nodes.find(
    (item) =>
      (item.attrs['bind:press'] === handler ||
        item.attrs['bind:input'] === handler) &&
      pick(item),
  );
  assert.ok(node, `${page}: actual ${handler} Component binding`);
  const scope = { ...target.data, ...patch };
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
      assert.equal(name, node.attrs['bind:input'] ? 'input' : 'press');
      assert.deepEqual(options, { bubbles: false, composed: false });
      dispatched++;
      invoke(target, handler, { detail, currentTarget: { dataset } });
    },
  };
  definition.lifetimes?.attached?.call(instance);
  return {
    press: () => definition.methods.onPress!.call(instance),
    input: (value: string) =>
      definition.methods.onInput!.call(instance, {
        detail: { value, cursor: value.length },
      }),
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
function textarea(page: string, handler: string, target: Owner, value: string) {
  assert.ok(
    flatten(parse(source(page))).some(
      (node) => node.tag === 'textarea' && node.attrs.bindinput === handler,
    ),
  );
  invoke(target, handler, { detail: { value } });
}

test('real ListItem/Button → catalog Page → controller preserves route identity, pagination, unavailable subscription and owner fences', async () => {
  const s = harness('catalog');
  s.controller.dispose();
  s.ratings.categoriesImpl = async (regionId, parentId, after) =>
    categoryPage({
      context: { regionId, parentId, catalogRevision: revision },
      nextCursor: after ? null : cursor,
      continuation: after ? 'end' : 'more',
    });
  const f = mount('rating-catalog', s.runtime);
  try {
    await flush();
    assert.equal(
      f.target.data.loaded,
      true,
      JSON.stringify({
        error: f.target.data.error,
        status: f.target.data.status,
      }),
    );
    const item = (f.target.data.categories as object[])[0];
    press('rating-catalog', 'onCategory', f.target, { item });
    assert.match(f.navigation[0]!, new RegExp(categoryId));
    press('rating-catalog', 'onMoreCategories', f.target);
    await flush();
    assert.equal(
      s.ratings.calls
        .filter((call) => call.method === 'categories')
        .slice(-1)[0]!.args[2],
      cursor,
    );
    assert.equal(
      press('rating-catalog', 'onCategory', f.target, { item, busy: true }),
      0,
    );
    press('rating-catalog', 'onTogglePanel', f.target);
    assert.equal(f.target.data.uiPanel, 'more');
    const count = f.navigation.length;
    invoke(f.target, 'onHide');
    press('rating-catalog', 'onCategory', f.target, { item, busy: false });
    assert.equal(f.navigation.length, count);
    assert.deepEqual(f.target.data.categories, []);
  } finally {
    f.close();
  }
});

test('real Button → detail Page requires explicit score confirmation and keeps frozen retry identity and cancellation journal', async () => {
  const s = harness();
  s.controller.dispose();
  const f = mount('rating-detail', s.runtime, { targetId });
  try {
    await flush();
    assert.equal(
      f.target.data.loaded,
      true,
      JSON.stringify({
        error: f.target.data.error,
        status: f.target.data.status,
      }),
    );
    press('rating-detail', 'onScore', f.target, { item: 5 });
    assert.equal(f.target.data.selectedScore, 5);
    assert.equal(
      s.ratings.calls.filter((call) => call.method === 'command').length,
      0,
    );
    assert.equal(
      press('rating-detail', 'onConfirmScore', f.target, { busy: true }),
      0,
    );
    s.ratings.commandImpl = async () => {
      throw new ClientError('network', 'Synthetic uncertain result');
    };
    press('rating-detail', 'onConfirmScore', f.target);
    await flush();
    assert.equal(f.target.data.frozen, true);
    const pending = s.pendingRatings.load(s.accountId)!;
    assert.equal(pending.intent.payload.clientRequestId, requestId);
    assert.equal(press('rating-detail', 'onScore', f.target, { item: 1 }), 0);
    press('rating-detail', 'onCancel', f.target);
    assert.deepEqual(s.pendingRatings.load(s.accountId), pending);
    press('rating-detail', 'onRecover', f.target);
    await flush();
    assert.equal(
      s.ratings.calls.filter((call) => call.method === 'receipt').slice(-1)[0]!
        .args[0],
      requestId,
    );
    s.ratings.commandImpl = async (command) => receipt(command);
    press('rating-detail', 'onRetry', f.target);
    await flush();
    const commands = s.ratings.calls.filter(
      (call) => call.method === 'command',
    );
    assert.deepEqual(commands[0]!.args[0], commands[1]!.args[0]);
    assert.equal(s.pendingRatings.load(s.accountId), null);
  } finally {
    f.close();
  }
});

test('real detail controls retain explicit anonymous identity, raw native textarea draft, close clearing and deletion confirmation', async () => {
  const s = harness();
  s.controller.dispose();
  const f = mount('rating-detail', s.runtime, { targetId });
  try {
    await flush();
    press('rating-detail', 'onCompose', f.target);
    assert.equal(f.target.data.authorMode, null);
    textarea('rating-detail', 'onText', f.target, '  原始分身草稿\n  ');
    assert.equal(f.target.data.text, '  原始分身草稿\n  ');
    assert.equal(press('rating-detail', 'onPublish', f.target), 0);
    press('rating-detail', 'onAuthorMode', f.target, { item: 'anonymous' });
    assert.equal(f.target.data.authorMode, 'anonymous');
    press('rating-detail', 'onCloseComposer', f.target);
    assert.equal(f.target.data.text, '');
    press('rating-detail', 'onDelete', f.target, { item: { id: commentId } });
    assert.equal(f.target.data.deleteId, commentId);
    assert.equal(
      s.ratings.calls.filter((call) => call.method === 'command').length,
      0,
    );
    press('rating-detail', 'onDismissDelete', f.target);
    assert.equal(f.target.data.deleteId, null);
    const c = control('rating-detail', 'onCompose', f.target);
    c.hide();
    c.press();
    assert.equal(c.dispatched(), 0);
    c.detach();
  } finally {
    f.close();
  }
});

test('real thread Button → Page → controller keeps reply target, anonymous author, pagination and collapse/private clearing', async () => {
  const s = r2aHarness();
  s.controller.dispose();
  s.updatesController.dispose();
  s.ratingDiscussion.repliesImpl = async (_regionId, _rootId, after) =>
    replyPage({
      nextCursor: after ? null : cursor,
      continuation: after ? 'end' : 'more',
    });
  const f = mount('rating-thread', s.runtime, threadRoute);
  try {
    await flush();
    assert.equal(
      f.target.data.loaded,
      true,
      JSON.stringify({
        error: f.target.data.error,
        status: f.target.data.status,
      }),
    );
    press('rating-thread', 'onReply', f.target, { item: reply() });
    textarea('rating-thread', 'onText', f.target, '  原始回复\n  ');
    assert.equal(f.target.data.text, '  原始回复\n  ');
    assert.equal(press('rating-thread', 'onPublish', f.target), 0);
    press('rating-thread', 'onAuthorMode', f.target, { item: 'anonymous' });
    press('rating-thread', 'onPublish', f.target);
    await flush();
    const command = s.ratingDiscussion.commands[0]!;
    assert.ok(command.operation === 'create_reply');
    assert.equal(command.payload.authorMode, 'anonymous');
    assert.equal(command.payload.replyTo?.replyId, replyId);
    press('rating-thread', 'onMore', f.target);
    await flush();
    press('rating-thread', 'onCollapse', f.target);
    assert.equal(f.target.data.collapsed, true);
    assert.deepEqual(f.target.data.replies, []);
    press('rating-thread', 'onExpand', f.target);
    await flush();
    assert.equal(
      f.target.data.loaded,
      true,
      JSON.stringify({
        error: f.target.data.error,
        status: f.target.data.status,
      }),
    );
    invoke(f.target, 'onHide');
    assert.deepEqual(f.target.data.replies, []);
    assert.equal(f.target.data.text, '');
  } finally {
    f.close();
  }
});

test('real Input/Button → creation Page preserves raw draft constraints, uncertain create journal and explicit cancellation', async () => {
  const s = managementHarness();
  s.controller.dispose();
  const f = mount('rating-create', s.runtime, creationContext);
  try {
    await flush();
    assert.equal(f.target.data.ready, true);
    input('rating-create', 'onName', f.target, '  原始名称  ');
    assert.equal(f.target.data.name, '  原始名称  ');
    textarea('rating-create', 'onDescription', f.target, '原始说明\n  ');
    assert.equal(f.target.data.description, '原始说明\n  ');
    const hidden = control('rating-create', 'onName', f.target);
    hidden.hide();
    hidden.input('不应写入');
    assert.equal(hidden.dispatched(), 0);
    hidden.detach();
    s.gateway.command = async () => {
      s.calls.push('command');
      throw new ClientError('network', 'Synthetic uncertain create');
    };
    press('rating-create', 'onCreate', f.target);
    await flush();
    assert.equal(f.target.data.frozen, true);
    const pending = s.pendingRatings.load(s.accountId)!;
    assert.ok(pending);
    assert.equal(press('rating-create', 'onCreate', f.target), 0);
    assert.equal(
      input('rating-create', 'onName', f.target, '不能覆盖原请求'),
      0,
    );
    press('rating-create', 'onCancelCreation', f.target);
    assert.equal(f.target.data.cancelCreationConfirmation, true);
    assert.equal(s.calls.includes('cancel'), false);
    press('rating-create', 'onDismissCancelCreation', f.target);
    assert.deepEqual(s.pendingRatings.load(s.accountId), pending);
    press('rating-create', 'onCancelCreation', f.target);
    press('rating-create', 'onConfirmCancelCreation', f.target);
    await flush();
    assert.equal(s.calls.filter((call) => call === 'cancel').length, 1);
    assert.equal(s.pendingRatings.load(s.accountId), null);
  } finally {
    f.close();
  }
});

test('real scoped Button/Input → Page → controller preserves campus-bound command, no implicit author, frozen recovery and owner clearing', async () => {
  const s = scopedHarness();
  s.controller.dispose();
  s.gateway.contextWork = async (request) => scopedContext(request, Date.now());
  const f = mount('rating-scoped', s.runtime, {
    mode: 'detail',
    scope: 'global',
    targetId,
  });
  try {
    await flush();
    assert.equal(
      f.target.data.loaded,
      true,
      JSON.stringify({
        error: f.target.data.error,
        status: f.target.data.status,
      }),
    );
    press('rating-scoped', 'onScore', f.target, { item: 4 });
    assert.equal(f.target.data.selectedScore, 4);
    assert.equal(s.gateway.commands.length, 0);
    s.gateway.commandWork = async () => {
      throw new ClientError('network', 'Synthetic uncertain scoped result');
    };
    press('rating-scoped', 'onConfirmScore', f.target);
    await flush();
    assert.equal(f.target.data.frozen, true);
    const first = s.gateway.commands[0]!;
    assert.equal(first.operation, 'set_score_scoped');
    assert.equal(first.context.selector.kind, 'global');
    assert.equal(press('rating-scoped', 'onScore', f.target, { item: 1 }), 0);
    s.gateway.commandWork = async (command) => scopedReceipt(command);
    press('rating-scoped', 'onRetry', f.target);
    await flush();
    assert.deepEqual(s.gateway.commands[1], first);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    press('rating-scoped', 'onRefresh', f.target);
    await flush();
    assert.equal(f.target.data.loaded, true);
    press('rating-scoped', 'onCompose', f.target);
    assert.equal(f.target.data.authorMode, null);
    textarea('rating-scoped', 'onText', f.target, '  校园草稿\n  ');
    assert.equal(f.target.data.text, '  校园草稿\n  ');
    assert.equal(press('rating-scoped', 'onPublish', f.target), 0);
    press('rating-scoped', 'onCloseComposer', f.target);
    assert.equal(f.target.data.text, '');
    s.sessions.completeLogin(
      s.sessions.beginLogin(),
      wireCredentials('replacement'),
    );
    assert.equal(f.target.data.loaded, false);
    assert.equal(f.target.data.text, '');
  } finally {
    f.close();
  }
});

test('scoped native Input preserves raw definition and numeric buffer; content changes invalidate explicit confirmation', async () => {
  const s = scopedHarness();
  s.controller.dispose();
  s.gateway.contextWork = async (request) => scopedContext(request, Date.now());
  const f = mount('rating-scoped', s.runtime, {
    mode: 'create',
    scope: 'global',
    categoryId,
  });
  try {
    await flush();
    assert.equal(f.target.data.loaded, true);
    input('rating-scoped', 'onName', f.target, '  原始对象  ');
    assert.equal(f.target.data.name, '  原始对象  ');
    textarea('rating-scoped', 'onDescription', f.target, '原始描述\n  ');
    press('rating-scoped', 'onDefinitionConfirm', f.target);
    assert.equal(f.target.data.definitionConfirmation, true);
    assert.equal(s.gateway.commands.length, 0);
    input('rating-scoped', 'onName', f.target, '  更新对象  ');
    assert.equal(f.target.data.definitionConfirmation, false);
    press('rating-scoped', 'onDefinitionCommit', f.target);
    await flush();
    assert.equal(s.gateway.commands.length, 0);
    press('rating-scoped', 'onDefinitionConfirm', f.target);
    press('rating-scoped', 'onDefinitionCommit', f.target);
    await flush();
    const command = s.gateway.commands[0]!;
    assert.ok(command.operation === 'create_target_scoped');
    assert.equal(command.payload.name, '更新对象');
    assert.equal(command.payload.categoryId, categoryId);
    assert.equal(command.context.selector.kind, 'global');
  } finally {
    f.close();
  }
  const random = mount('rating-scoped', s.runtime, {
    mode: 'random',
    scope: 'global',
    categoryId,
  });
  try {
    await flush();
    input('rating-scoped', 'onMinimumAverage', random.target, '4.');
    assert.equal(random.target.data.minimumAverageInput, '4.');
    const c = control('rating-scoped', 'onMinimumAverage', random.target);
    c.detach();
    c.input('1');
    assert.equal(c.dispatched(), 0);
    input('rating-scoped', 'onMinimumAverage', random.target, '3');
    press('rating-scoped', 'onDraw', random.target);
    await flush();
    assert.ok(random.target.data.randomResult);
  } finally {
    random.close();
  }
});

test('fixture corpus covers all five routes and scoped submodes with unknown counts and no real/provider identifiers', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-ratings-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.ok(fixtures.length >= 50);
  assert.equal(new Set(fixtures.map((item) => item.id)).size, fixtures.length);
  assert.deepEqual(
    [...new Set(fixtures.map((item) => item.page))].sort(),
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
    'delete-confirm',
    'author-required',
    'cancel-confirm',
    'count-unavailable',
    'definition-confirm',
  ])
    assert.ok(
      fixtures.some((item) => item.id.includes(state)),
      state,
    );
  assert.equal(
    fixtures.find((item) =>
      item.id.endsWith('scoped-updates-count-unavailable'),
    )!.patch.unreadCount,
    null,
  );
});

test('late detail response and detached Button cannot restore content after account change', async () => {
  const s = harness();
  s.controller.dispose();
  const late = deferred<ReturnType<typeof target>>();
  s.ratings.detailImpl = async () => late.promise;
  const f = mount('rating-detail', s.runtime, { targetId });
  try {
    const c = control('rating-detail', 'onRefresh', f.target, { busy: false });
    c.detach();
    c.press();
    assert.equal(c.dispatched(), 0);
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('other'),
      accountId: categoryId,
    });
    late.resolve(target());
    await flush();
    assert.equal(f.target.data.detail, null);
    assert.deepEqual(f.target.data.comments, []);
    assert.equal(
      s.ratings.calls.filter((call) => call.method === 'command').length,
      0,
    );
  } finally {
    f.close();
  }
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
    '../scripts/fixtures/framework7-ratings-preview.mjs',
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
    if (fixture.id.endsWith('scoped-updates-count-unavailable'))
      assert.doesNotMatch(text, /0 条未读/);
  }
});
