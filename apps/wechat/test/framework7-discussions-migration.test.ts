import { assertReviewedNativeHarnessSuccessor } from './reviewed-native-harness-successor';
import { assertReviewedNoticeExposureSuccessor } from './reviewed-notice-exposure-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import * as major from './major-discussion-helpers';
import * as window from './window-discussion-helpers';
import { deferred, flush as tick } from './helpers';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(__filename);
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const { parsePreviewWxml: parse } = nativeRequire(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const pages = [
  'major-directory',
  'major-detail',
  'major-discussion',
  'major-discussion-thread',
  'window-discussion',
  'window-discussion-thread',
];
const sha = (source: string) =>
  createHash('sha256').update(source).digest('hex');
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-discussions-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-discussions-before-protected.json'),
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
for (const [file, before] of Object.entries(baseline))
  test(`${file}: all original handlers, native datasets, disabled/loading and ancestor constraints survive`, () => {
    const target = file.replace('/product.wxml', '/framework7-product.wxml');
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
      const added = Object.keys(current[index]!.attrs).filter(
        (key) => !(key in old.attrs),
      );
      assert.ok(
        added.every((key) =>
          [
            'variant',
            'size',
            'tone',
            'link',
            'title',
            'subtitle',
            'aria-label',
          ].includes(key),
        ),
        added.join(','),
      );
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    conditionalChains(tree);
  });
const reviewedTests = [
  'major-product-presentation',
  'window-discussion-product-presentation',
  'major-discussion-image-native',
  'window-discussion-image-native',
];
test('immutable pre-edit action/hash records and reviewed-test original bytes are never re-recorded', () => {
  assert.equal(
    sha(read('test/fixtures/framework7-discussions-before-actions.json')),
    '75315012d59d1edf832158d4b1a30bb99cd7bb663414099fa0b7653beec145dc',
  );
  assert.equal(
    sha(read('test/fixtures/framework7-discussions-before-protected.json')),
    '3bc0b16593d7d2e2daeebe9fd4bb7ccd51f737de7fe9a531f1b327e8f6616ab8',
  );
  assert.equal(
    Object.values(baseline).reduce(
      (sum, entry) => sum + entry.actions.length,
      0,
    ),
    103,
  );
  assert.equal(Object.keys(protectedFiles).length, 162);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) =>
      !assertReviewedNoticeExposureSuccessor(file, expected) &&
      !assertReviewedBusinessSuccessor(file, expected) &&
      !assertReviewedNativeHarnessSuccessor(file, expected),
  )) {
    const testName = /^test\/(.+)\.test\.ts$/.exec(file)?.[1];
    // These four narrowly allocated test adapters change the event boundary.
    // Their captured originals remain immutable evidence. Apart from the exact
    // reviewed successors above, no runtime/source exception is allowed;
    // the adapted assertions run in the focused gate.
    // Six recovery presentation files were subsequently allocated to another
    // family worker; preserve their captured originals, never their later hash.
    // Recovery Page/controller/media TS remain directly immutable here.
    const external =
      /^src\/pages\/(major-discussion-recovery|window-discussion-recovery)\/[^/]+\.(wxml|wxss|json)$/.exec(
        file,
      );
    const externalTest =
      testName &&
      ['major-discussion-template', 'window-discussion-template'].includes(
        testName,
      );
    const target = externalTest
      ? `test/fixtures/framework7-discussions-external-original-${testName}.test.ts.txt`
      : external
        ? `test/fixtures/framework7-discussions-external-original-${external[1]}.${external[2]}.txt`
        : testName && reviewedTests.includes(testName)
          ? `test/fixtures/framework7-discussions-original-${testName}.test.ts.txt`
          : file;
    assert.equal(sha(read(target)), expected, file);
  }
});
for (const page of pages)
  test(`${page}: registered native components, no nested activation, native exception ownership`, () => {
    const file = `src/pages/${page}/${page}`;
    const tree = parse(read(file + '.wxml'));
    const family =
      page === 'major-directory' || page === 'major-detail'
        ? 'majors'
        : page.startsWith('major')
          ? 'major-discussion'
          : 'window-discussion';
    const nodes = flatten(tree).concat(
      flatten(parse(read(`src/${family}/framework7-product.wxml`))),
    );
    const config = JSON.parse(read(file + '.json')) as {
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
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-button' || node.tag === 'wu-f7-list-item')
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (n) =>
                /^(button|input|textarea|switch|navigator|wu-f7-button|wu-f7-input)$/.test(
                  n.tag,
                ) || Object.keys(n.attrs).some((k) => /^(bind|catch)/.test(k)),
            ),
        );
    }
    assert.ok(
      !nodes.some((n) =>
        /^(button|input|web-view|wu-f7-sheet|wu-f7-dialog|wu-f7-actions)$/.test(
          n.tag,
        ),
      ),
    );
    assert.match(read(file + '.wxss'), /framework7-product\.wxss/);
    assert.doesNotMatch(
      read(file + '.wxml'),
      /rich-text|data:image|https?:\/\//,
    );
    if (page === 'major-directory')
      assert.ok(
        nodes.some(
          (n) => n.tag === 'picker' && n.attrs.bindchange === 'onDepartment',
        ),
      );
    if (page.includes('discussion')) {
      assert.equal(
        nodes.filter(
          (n) =>
            n.tag === 'textarea' &&
            n.attrs.bindinput === 'onBody' &&
            n.attrs.maxlength === '-1',
        ).length,
        1,
      );
      assert.equal(
        nodes.filter(
          (n) =>
            n.tag === 'image' &&
            n.attrs.src === '{{gallerySrc}}' &&
            n.attrs['wx:if'] === '{{gallerySrc}}',
        ).length,
        1,
      );
    }
  });
test('factual major directory and current public-nickname discussions do not invent ratings or creator identities', () => {
  assert.doesNotMatch(
    read('src/majors/framework7-product.wxml'),
    /creator|score|rating|profileId|实名/,
  );
  for (const family of ['major', 'window']) {
    const source = read(`src/${family}-discussion/framework7-product.wxml`);
    assert.match(source, /item.author.displayName/);
    assert.doesNotMatch(source, /url=.*profile|avatarUrl|creatorId|实名/);
  }
  assert.match(
    read('src/major-discussion/framework7-product.wxml'),
    /此操作不提供恢复入口/,
  );
  assert.match(
    read('src/pages/major-detail/major-detail.wxml'),
    /未提供培养方案、学位或就业说明/,
  );
});
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
}
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
  lifecycle(name: string): void;
  sync(): void;
  emissions: unknown[];
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
function invoke(owner: Owner, name: string, event?: unknown) {
  return (owner[name] as (event?: unknown) => unknown).call(owner, event);
}
async function flush() {
  for (let i = 0; i < 20; i++) await tick();
}
function mount(page: string, runtime: CommunityRuntime, query: unknown = {}) {
  const globals = globalThis as unknown as Record<string, unknown>,
    prior = { wx: globals.wx, getApp: globals.getApp, Page: globals.Page };
  let definition: Owner | undefined;
  const navigated: string[] = [];
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigated.push(url);
      success?.();
    },
  };
  globals.getApp = () => ({ community: runtime });
  globals.Page = (value: Owner) => {
    definition = value;
  };
  const source = path.join(root, `src/pages/${page}/${page}.ts`);
  delete nativeRequire.cache[nativeRequire.resolve(source)];
  nativeRequire(source);
  assert.ok(definition);
  const owner: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  const bridge = createNativePressBridge({
    page: owner,
    pageFile: path.join(root, `src/pages/${page}/${page}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  invoke(owner, 'onLoad', query);
  invoke(owner, 'onShow');
  return {
    owner,
    bridge,
    navigated,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const handle = bridge.capture(handler, dataset);
      const emitted = handle.press();
      handle.detach();
      return emitted;
    },
    close() {
      bridge.lifecycle('detach');
      invoke(owner, 'onUnload');
      Object.assign(globals, prior);
    },
  };
}
interface ComponentInstance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
interface ComponentDefinition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<
    string,
    (this: ComponentInstance, event?: unknown) => unknown
  >;
  lifetimes: Record<string, (this: ComponentInstance) => void>;
  pageLifetimes: Record<string, (this: ComponentInstance) => void>;
}
function searchInput(owner: Owner) {
  const globals = globalThis as unknown as Record<string, unknown>,
    prior = globals.Component;
  let definition: ComponentDefinition | undefined;
  globals.Component = (value: ComponentDefinition) => {
    definition = value;
  };
  const file = path.join(root, 'src/components/f7-input/f7-input.ts');
  delete nativeRequire.cache[nativeRequire.resolve(file)];
  nativeRequire(file);
  globals.Component = prior;
  assert.ok(definition);
  const registered = definition;
  const node = flatten(
    parse(read('src/pages/major-directory/major-directory.wxml')),
  ).find(
    (n) => n.tag === 'wu-f7-input' && n.attrs['bind:input'] === 'onSearchInput',
  )!;
  assert.ok(node);
  assert.match(
    read('src/components/f7-input/f7-input.wxml'),
    /catchinput="onInput"/,
  );
  const properties = Object.fromEntries(
    Object.entries(registered.properties).map(([key, value]) => [
      key,
      structuredClone(value.value),
    ]),
  );
  Object.assign(properties, {
    value: owner.data.searchDraft,
    disabled: owner.data.busy,
    maxlength: Number(node.attrs.maxlength),
  });
  let emissions = 0;
  const instance: ComponentInstance = {
    properties,
    data: structuredClone(registered.data),
    ...registered.methods,
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail, options) {
      assert.equal(name, 'input');
      assert.deepEqual(options, { bubbles: false, composed: false });
      emissions++;
      invoke(owner, node.attrs['bind:input']!, { detail });
    },
  };
  registered.lifetimes.attached!.call(instance);
  return {
    input(value: string) {
      registered.methods.onInput!.call(instance, {
        detail: { value, cursor: value.length },
      });
    },
    hide() {
      registered.pageLifetimes.hide!.call(instance);
    },
    detach() {
      registered.lifetimes.detached!.call(instance);
    },
    emissions: () => emissions,
  };
}
const majorRecord = (id = major.id, departmentId = 110) => ({
  id,
  majorRevision: major.revision,
  catalogRevision: major.catalogRevision,
  campusId: major.rootId,
  departmentId,
  collegeName: '合成学院',
  majorName: '合成专业',
  summary: { kind: 'unavailable' as const },
});
test('actual Input→Page and ListItem→Page preserve raw search, explicit filters, accepted IDs, pagination and related navigation', async () => {
  const h = major.discussionHarness();
  h.controller.dispose();
  const queries: unknown[] = [];
  let next = false;
  const runtime: CommunityRuntime = {
    ...h.runtime,
    majors: {
      departments: async () => ({
        catalogRevision: major.catalogRevision,
        items: [{ departmentId: 110, name: '110系' }],
      }),
      list: async (query, cursor) => {
        queries.push({ query, cursor });
        return {
          catalogRevision: major.catalogRevision,
          items: [majorRecord()],
          totalCount: next ? 2 : 1,
          nextCursor: next && !cursor ? 'next' : null,
          continuation: next && !cursor ? 'more' : 'end',
        };
      },
      detail: async () => ({
        catalogRevision: major.catalogRevision,
        item: majorRecord(),
      }),
      related: async () => ({
        catalogRevision: major.catalogRevision,
        items: [majorRecord(major.otherId)],
        totalCount: 1,
        nextCursor: null,
        continuation: 'end',
      }),
    },
  };
  const f = mount('major-directory', runtime);
  try {
    await flush();
    assert.equal(f.owner.data.loaded, true);
    const input = searchInput(f.owner);
    input.input(' 合成😀 ');
    assert.equal(f.owner.data.searchDraft, ' 合成😀 ');
    assert.equal(queries.length, 1);
    invoke(f.owner, 'onDepartment', { detail: { value: '1' } });
    next = true;
    f.press('onSearch');
    await flush();
    assert.deepEqual(queries[1], {
      query: { departmentId: 110, keyword: '合成😀' },
      cursor: null,
    });
    assert.equal(f.owner.data.canNext, true);
    assert.equal(f.press('onNext'), true);
    await flush();
    assert.equal(f.owner.data.pageNumber, 2);
    assert.equal(f.bridge.find('onNext'), undefined);
    f.press('onDetail', { id: major.id });
    assert.equal(
      f.navigated[0],
      `/pages/major-detail/major-detail?majorId=${major.id}`,
    );
    const old = f.bridge.capture('onDetail', { id: major.id });
    f.owner.setData({ busy: true });
    assert.equal(old.press(), false);
    input.hide();
    input.input('discard');
    assert.equal(f.owner.data.searchDraft, ' 合成😀 ');
    input.detach();
    f.bridge.lifecycle('hide');
    invoke(f.owner, 'onHide');
    assert.equal(old.press(), false);
  } finally {
    f.close();
  }
  const d = mount('major-detail', runtime, { majorId: major.id });
  try {
    await flush();
    assert.equal(d.owner.data.relatedLoaded, true);
    d.press('onDetail', { id: major.otherId });
    assert.equal(
      d.navigated[0],
      `/pages/major-detail/major-detail?majorId=${major.otherId}`,
    );
    d.press('onOpenDiscussion');
    assert.equal(
      d.navigated[1],
      `/pages/major-discussion/major-discussion?majorId=${major.id}`,
    );
    d.press('onRelatedRefresh');
    await flush();
    assert.equal(d.owner.data.relatedLoaded, true);
  } finally {
    d.close();
  }
});
for (const family of ['major', 'window'] as const) {
  const fixture = family === 'major' ? major : window;
  test(`${family}: actual Button→Page→controller keeps original publish/retry/cancel identity after unknown response`, async () => {
    const h = fixture.discussionHarness();
    h.controller.dispose();
    h.impl.submit = async () => {
      throw new ClientError('network', 'Synthetic unknown publication');
    };
    let ids = 0;
    h.ids.next = async () => {
      ids++;
      return fixture.requestId;
    };
    const f = mount(`${family}-discussion`, h.runtime, {
      [family + 'Id']: fixture.id,
    });
    try {
      await flush();
      assert.equal(f.owner.data.loaded, true);
      if (family === 'major') f.press('onTogglePanel', { panel: 'compose' });
      else f.press('onOpenComposer');
      invoke(f.owner, 'onBody', { detail: { value: '  原文 😀 不重写  ' } });
      f.press('onConfirmPublish');
      assert.equal(f.owner.data.confirming, 'publish');
      assert.equal(h.commands.length, 0);
      f.press('onCloseConfirmation');
      assert.equal(f.owner.data.body, '  原文 😀 不重写  ');
      f.press('onConfirmPublish');
      const submit = f.bridge.capture('onSubmit');
      assert.equal(submit.press(), true);
      assert.equal(submit.press(), false);
      await flush();
      assert.equal(h.commands.length, 1);
      const original = h.store.load(h.accountId);
      assert.ok(original);
      assert.equal(original.intent.command.clientRequestId, fixture.requestId);
      assert.equal(
        'body' in original.intent.command && original.intent.command.body,
        '  原文 😀 不重写  ',
      );
      assert.equal(f.owner.data.frozen, true);
      assert.equal(f.bridge.find('onConfirmPublish'), undefined);
      f.press('onRecover');
      await flush();
      assert.deepEqual(h.store.load(h.accountId), original);
      f.press('onRetry');
      await flush();
      assert.deepEqual(h.commands[1], h.commands[0]);
      assert.equal(ids, 1);
      f.press('onRequestCancellation');
      await flush();
      assert.equal(f.owner.data.confirming, 'cancel');
      const cancel = h.impl.cancel;
      h.impl.cancel = async () => {
        throw new ClientError('network', 'Synthetic unknown cancellation');
      };
      f.press('onConfirmCancellation');
      await flush();
      assert.deepEqual(h.store.load(h.accountId), {
        ...original,
        phase: 'cancel',
      });
      assert.equal(f.bridge.find('onRequestCancellation'), undefined);
      h.impl.cancel = cancel;
      f.press('onRetry');
      await flush();
      assert.equal(h.store.load(h.accountId), null);
      assert.equal(ids, 1);
    } finally {
      f.close();
    }
  });
  test(`${family}: actual thread reply addressing, explicit like review, current targets and notice navigation never mark reads implicitly`, async () => {
    const h = fixture.discussionHarness('thread');
    h.controller.dispose();
    if (family === 'major')
      (h as ReturnType<typeof major.discussionHarness>).impl.list = async () =>
        major.page({
          root: major.item(),
          items: [major.item({ id: major.replyId, rootId: major.rootId })],
        });
    else
      (h as ReturnType<typeof window.discussionHarness>).impl.list = async () =>
        window.page({
          root: window.item(),
          items: [window.item({ id: window.replyId, rootId: window.rootId })],
        });
    const f = mount(`${family}-discussion-thread`, h.runtime, {
      [family + 'Id']: fixture.id,
      rootId: fixture.rootId,
      commentId: fixture.replyId,
      noticeId: fixture.requestId,
    });
    try {
      await flush();
      assert.equal(f.owner.data.loaded, true);
      assert.ok(h.calls.includes('target'));
      assert.equal(h.calls.includes('read'), false);
      f.press('onReply', { id: fixture.replyId });
      assert.equal(
        (f.owner.data.replyTarget as { id: string }).id,
        fixture.replyId,
      );
      invoke(f.owner, 'onBody', { detail: { value: '回复原文' } });
      f.press('onClosePanel');
      assert.equal(f.owner.data.body, '回复原文');
      f.press('onReply', { id: fixture.replyId });
      f.press('onReplyRoot');
      assert.equal(f.owner.data.replyTarget, null);
      f.press('onClosePanel');
      f.press('onReply', { id: fixture.replyId });
      f.press('onConfirmPublish');
      f.press('onSubmit');
      await flush();
      assert.equal(h.commands.length, 1);
      const sent = h.commands[0]!;
      assert.equal(sent.operation, `${family}.discussion.reply.v1`);
      assert.equal('rootId' in sent && sent.rootId, fixture.rootId);
      assert.equal(
        'replyToReplyId' in sent.command && sent.command.replyToReplyId,
        fixture.replyId,
      );
      f.press('onLike', { id: fixture.replyId });
      assert.equal(f.owner.data.confirming, 'like');
      assert.equal(h.commands.length, 1);
      const old = f.bridge.capture('onSubmit');
      f.press('onCloseConfirmation');
      assert.equal(old.press(), false);
      f.press('onLike', { id: fixture.replyId });
      f.press('onSubmit');
      await flush();
      assert.equal(h.commands.length, 2);
      assert.equal(h.commands[1]!.operation, `${family}.discussion.like.v1`);
      assert.equal(
        'expectedMembershipRevision' in h.commands[1]!.command &&
          h.commands[1]!.command.expectedMembershipRevision,
        null,
      );
      assert.equal(h.calls.includes('read'), false);
    } finally {
      f.close();
    }
  });
  test(`${family}: actual visible controls fence busy, hide, safety invalidation and session replacement`, async () => {
    const h = fixture.discussionHarness();
    h.controller.dispose();
    const safetyChanges = new SafetyChanges(h.runtime.privateViews);
    const runtime = { ...h.runtime, safetyChanges };
    const f = mount(`${family}-discussion`, runtime, {
      [family + 'Id']: fixture.id,
    });
    try {
      await flush();
      const old = f.bridge.capture('onLike', { id: fixture.rootId });
      f.owner.setData({ busy: true });
      assert.equal(old.press(), false);
      f.owner.setData({ busy: false });
      safetyChanges.invalidate(h.accountId);
      assert.equal(f.owner.data.loaded, false);
      assert.equal(old.press(), false);
      assert.equal(h.commands.length, 0);
      f.press('onRefresh');
      await flush();
      const beforeHide = f.bridge.capture('onLike', { id: fixture.rootId });
      f.bridge.lifecycle('hide');
      invoke(f.owner, 'onHide');
      assert.equal(beforeHide.press(), false);
      f.bridge.lifecycle('show');
      invoke(f.owner, 'onShow');
      await flush();
      const beforeLogout = f.bridge.capture('onLike', { id: fixture.rootId });
      h.sessions.logout();
      assert.equal(beforeLogout.press(), false);
      assert.equal(f.owner.data.loaded, false);
      assert.equal(h.commands.length, 0);
    } finally {
      f.close();
    }
  });
}
test('actual Major menu→capability→delete review never confuses denied, unconfirmed or lost-response deletion with success', async () => {
  const h = major.discussionHarness();
  h.controller.dispose();
  let allowed = false;
  h.impl.deleteCapability = async (locator) => ({ ...locator, allowed });
  const f = mount('major-discussion', h.runtime, { majorId: major.id });
  try {
    await flush();
    f.press('onDeleteMenu', { id: major.rootId });
    await flush();
    assert.equal(f.bridge.find('onDelete', { id: major.rootId }), undefined);
    assert.equal(h.commands.length, 0);
    allowed = true;
    f.press('onDeleteMenu', { id: major.rootId });
    await flush();
    f.press('onDelete', { id: major.rootId });
    assert.equal(f.owner.data.confirming, 'delete');
    assert.equal(h.commands.length, 0);
    f.press('onCloseConfirmation');
    assert.equal(h.commands.length, 0);
    f.press('onDeleteMenu', { id: major.rootId });
    await flush();
    f.press('onDelete', { id: major.rootId });
    h.impl.submit = async () => {
      throw new ClientError('network', 'Synthetic uncertain deletion');
    };
    f.press('onSubmit');
    await flush();
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0]!.operation, 'major.discussion.delete.v1');
    assert.equal(f.owner.data.frozen, true);
    const pending = h.store.load(h.accountId);
    assert.ok(pending);
    assert.equal(pending.intent.operation, 'major.discussion.delete.v1');
    f.press('onRecover');
    await flush();
    assert.deepEqual(h.store.load(h.accountId), pending);
  } finally {
    f.close();
  }
});
test('actual Major menu rejects delayed capability after page hide without rendering a delete action', async () => {
  const h = major.discussionHarness();
  h.controller.dispose();
  const held = deferred<{
    majorId: string;
    commentId: string;
    rootId: null;
    allowed: boolean;
  }>();
  h.impl.deleteCapability = async () => held.promise;
  const f = mount('major-discussion', h.runtime, { majorId: major.id });
  try {
    await flush();
    f.press('onDeleteMenu', { id: major.rootId });
    await flush();
    f.bridge.lifecycle('hide');
    invoke(f.owner, 'onHide');
    held.resolve({
      majorId: major.id,
      commentId: major.rootId,
      rootId: null,
      allowed: true,
    });
    await flush();
    assert.equal(f.owner.data.deleteTarget, null);
    assert.equal(f.bridge.find('onDelete', { id: major.rootId }), undefined);
    assert.equal(h.commands.length, 0);
  } finally {
    f.close();
  }
});

test('isolated emitted-smoke entrypoint executes the same six real source Pages and native components before central emitted gate', async () => {
  const h = major.discussionHarness();
  h.controller.dispose();
  const { smokeFramework7Discussions } = nativeRequire(
    '../scripts/smoke-framework7-discussions.mjs',
  ) as {
    smokeFramework7Discussions(options: {
      app: { community: CommunityRuntime };
      dist: string;
      extension: 'ts';
      flush: () => Promise<void>;
    }): Promise<{
      routes: number;
      submitted: number;
      sourceModelOnly: boolean;
    }>;
  };
  const result = await smokeFramework7Discussions({
    app: { community: h.runtime },
    dist: path.join(root, 'src'),
    extension: 'ts',
    flush,
  });
  assert.equal(result.routes, 6);
  assert.ok(result.submitted > 0);
  assert.equal(result.sourceModelOnly, true);
});

test('81 fictional preview projections retain all intended reading, editor, recovery and confirmation branches without external images', () => {
  const fixtures = (
    nativeRequire('../scripts/fixtures/framework7-discussions-preview.mjs') as {
      default: {
        id: string;
        page: string;
        patch: Record<string, unknown>;
        expectedText: string[];
      }[];
    }
  ).default;
  const { render } = nativeRequire('../scripts/smoke-ratings.mjs') as {
    render(
      nodes: (PresentationNode | string)[],
      scope: unknown,
      templates: Record<string, PresentationNode>,
    ): (PresentationNode | string)[];
  };
  assert.equal(fixtures.length, 81);
  assert.equal(new Set(fixtures.map((f) => f.id)).size, 81);
  const globals = globalThis as unknown as Record<string, unknown>,
    old = globals.Page;
  const states: Record<string, Record<string, unknown>> = {};
  try {
    for (const page of pages) {
      globals.Page = (definition: Owner) => {
        states[page] = structuredClone(definition.data);
      };
      const file = path.join(root, `src/pages/${page}/${page}.ts`);
      delete nativeRequire.cache[nativeRequire.resolve(file)];
      nativeRequire(file);
    }
  } finally {
    globals.Page = old;
  }
  for (const fixture of fixtures) {
    const family =
      fixture.page === 'major-directory' || fixture.page === 'major-detail'
        ? 'majors'
        : fixture.page.startsWith('major')
          ? 'major-discussion'
          : 'window-discussion';
    const templates = Object.fromEntries(
      parse(read(`src/${family}/framework7-product.wxml`))
        .children.filter(
          (n): n is PresentationNode => typeof n !== 'string' && !!n.attrs.name,
        )
        .map((n) => [n.attrs.name, n]),
    );
    const nodes = render(
      parse(read(`src/pages/${fixture.page}/${fixture.page}.wxml`)).children,
      { ...states[fixture.page], ...fixture.patch },
      templates,
    );
    const text = (children: (PresentationNode | string)[]): string =>
      children
        .map((n) =>
          typeof n === 'string'
            ? n
            : (n.tag === 'wu-f7-list-item' || n.tag === 'wu-f7-block'
                ? [n.attrs.title, n.attrs.subtitle].filter(Boolean).join(' ')
                : '') +
              ' ' +
              text(n.children),
        )
        .join(' ');
    const visible = text(nodes).replace(/\s+/g, ' ');
    for (const expected of fixture.expectedText)
      assert.ok(visible.includes(expected), `${fixture.id}: ${expected}`);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|wxfile:\/\//,
    );
  }
});
