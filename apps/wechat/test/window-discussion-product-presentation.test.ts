import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { registerWindowDiscussionPage } from '../src/window-discussion/page';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  discussionHarness,
  item,
  page as discussionPage,
  id,
  rootId,
  replyId,
} from './window-discussion-helpers';
import { flush } from './helpers';

type Element = {
  tag: string;
  attrs: Record<string, string>;
  children: (Element | string)[];
};
type Action = {
  tag: string;
  attrs: Record<string, string>;
  ancestors: Record<string, string>[];
};
const nativeRequire = createRequire(__filename);
const { parsePreviewWxml } = nativeRequire('../scripts/preview-wxml.mjs') as {
  parsePreviewWxml(source: string): Element;
};
const sourceRoot = path.resolve(__dirname, '../src');
const read = (file: string) =>
  readFileSync(path.join(sourceRoot, file), 'utf8');
const frozen = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      'fixtures/window-discussion-product-action-inventory.json',
    ),
    'utf8',
  ),
) as Record<string, Action[]>;
const omit = new Set([
  'class',
  'style',
  'placeholder',
  'aria-label',
  'aria-role',
]);
const inherited = new Set([
  'wx:if',
  'wx:elif',
  'wx:else',
  'wx:for',
  'wx:for-item',
  'wx:for-index',
  'wx:key',
]);
function actions(source: string): Action[] {
  const result: Action[] = [];
  function walk(
    nodes: (Element | string)[],
    ancestors: Record<string, string>[] = [],
  ) {
    for (const raw of nodes) {
      const node =
        typeof raw === 'string' ? raw : normalizeFramework7ActionNode(raw);
      if (typeof node === 'string') continue;
      const attrs = Object.fromEntries(
        Object.entries(node.attrs).filter(([key]) => !omit.has(key)),
      );
      if (
        node.tag === 'navigator' ||
        Object.keys(attrs).some((key) => /^(bind|catch)/.test(key))
      )
        result.push({ tag: node.tag, attrs, ancestors });
      const conditions = Object.fromEntries(
        Object.entries(node.attrs).filter(([key]) => inherited.has(key)),
      );
      walk(
        node.children,
        Object.keys(conditions).length ? [...ancestors, conditions] : ancestors,
      );
    }
  }
  walk(parsePreviewWxml(source).children);
  return result;
}
for (const [file, original] of Object.entries(frozen)) {
  test(`${file} retains original actions and all ancestor permission, nullability and loop guards`, () => {
    const current = actions(
      read(file.replace('/common.wxml', '/framework7-product.wxml')),
    );
    for (const expected of original) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === expected.tag &&
          Object.entries(expected.attrs).every(
            ([key, value]) => candidate.attrs[key] === value,
          ) &&
          expected.ancestors.every((ancestor) =>
            candidate.ancestors.some((actual) =>
              Object.entries(ancestor).every(
                ([key, value]) => actual[key] === value,
              ),
            ),
          ),
      );
      assert.notEqual(
        index,
        -1,
        `Missing or weakened action: ${JSON.stringify(expected)}`,
      );
      current.splice(index, 1);
    }
  });
}

test('public discussion presentation is flat, isolated, icon based and has no fabricated identity or duplicated native title', () => {
  assert.equal(
    Object.values(frozen).reduce((count, list) => count + list.length, 0),
    37,
  );
  for (const page of ['window-discussion', 'window-discussion-thread']) {
    const template = read(`pages/${page}/${page}.wxml`);
    parsePreviewWxml(template);
    assert.match(
      template,
      /class="screen discussion-product has-dock f7-ios-theme f7-discussions"/,
    );
    assert.doesNotMatch(
      template,
      /WHALEU|class="title"|class="card"|→|✓|•••|实名/,
    );
    assert.match(
      read(`pages/${page}/${page}.wxss`),
      /window-discussion\/product\.wxss/,
    );
    const config = JSON.parse(read(`pages/${page}/${page}.json`)) as {
      usingComponents: Record<string, string>;
    };
    assert.equal(
      config.usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
  }
  const product = read('window-discussion/framework7-product.wxml');
  assert.match(product, /item.author.displayName/);
  assert.doesNotMatch(
    product,
    /avatar|实名|窗口创建者身份未确认|本版本的新策略|item.createdAt/,
  );
  assert.match(product, /timeLabels\[item.id\]/);
  assert.match(product, /uiPanel === 'compose' &amp;&amp; !confirming/);
  assert.match(
    read('window-discussion/product.wxss'),
    /env\(safe-area-inset-bottom\)/,
  );
  assert.doesNotMatch(
    read('window-discussion/window-discussion.wxss'),
    /discussion-product/,
  );
  assert.doesNotMatch(
    read('window-discussion/common.wxml'),
    /product-discussion/,
  );
  assert.doesNotMatch(
    read('window-discussion/page.ts').split(
      'export function registerWindowDiscussionNoticesPage',
    )[1]!,
    /uiPanel|timeLabels/,
  );
});

type NativePage = {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  onLoad(query: unknown): void;
  onShow(): void;
  onHide(): void;
  onUnload(): void;
  onOpenComposer(): void;
  onClosePanel(): void;
  onToggleTools(): void;
  onReply(event: { currentTarget: { dataset: { id: string } } }): void;
  onBody(event: { detail: { value: string } }): void;
};

test('actual adapter opens a row reply, preserves its draft on disclosure close, and clears overlays on hide/session/safety invalidation', async () => {
  const h = discussionHarness('thread');
  h.impl.list = async () =>
    discussionPage({
      root: item(),
      items: [item({ id: replyId, rootId })],
    });
  const safetyChanges = new SafetyChanges(h.runtime.privateViews);
  const runtime = { ...h.runtime, safetyChanges };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  let definition: NativePage | undefined;
  globals.Page = (value: NativePage) => {
    definition = value;
  };
  globals.getApp = () => ({ community: runtime });
  globals.wx = {};
  try {
    registerWindowDiscussionPage('thread');
    const page = definition!;
    page.setData = function (patch) {
      this.data = { ...this.data, ...patch };
    };
    page.onLoad({ windowId: id, rootId });
    page.onShow();
    await flush();
    assert.equal(page.data.loaded, true);
    page.onReply({ currentTarget: { dataset: { id: replyId } } });
    assert.equal(page.data.uiPanel, 'compose');
    assert.equal((page.data.replyTarget as { id: string }).id, replyId);
    page.onBody({ detail: { value: '保留我的回复原文' } });
    page.onClosePanel();
    assert.equal(page.data.uiPanel, '');
    assert.equal(page.data.body, '保留我的回复原文');
    page.onOpenComposer();
    page.onHide();
    assert.equal(page.data.uiPanel, '');
    assert.deepEqual(page.data.timeLabels, {});
    page.onShow();
    await flush();
    page.onOpenComposer();
    runtime.privateViews?.clear();
    assert.equal(page.data.uiPanel, '');
    page.onShow();
    await flush();
    page.onToggleTools();
    assert.equal(page.data.uiPanel, 'tools');
    safetyChanges.invalidate(h.sessions.snapshot().credentials!.accountId);
    assert.equal(page.data.uiPanel, '');
    page.onShow();
    await flush();
    page.onOpenComposer();
    h.sessions.logout();
    assert.equal(page.data.uiPanel, '');
    assert.equal(page.data.loaded, false);
    page.onOpenComposer();
    assert.equal(page.data.uiPanel, '');
    page.onUnload();
  } finally {
    Object.assign(globals, previous);
    h.controller.dispose();
  }
});
