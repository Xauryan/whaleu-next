import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';

type Node =
  string | { tag: string; attrs: Record<string, string>; children: Node[] };
type Action = {
  tag: string;
  attrs: Record<string, string>;
  ancestors: Record<string, string>[];
};
const requireNative = createRequire(__filename);
const { parsePreviewWxml } = requireNative('../scripts/preview-wxml.mjs') as {
  parsePreviewWxml(source: string): Exclude<Node, string>;
};
const root = path.join(__dirname, '../src');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/dining-product-action-inventory.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
function actions(source: string): Action[] {
  const result: Action[] = [];
  function walk(node: Node, ancestors: Record<string, string>[] = []): void {
    if (typeof node === 'string') return;
    node = normalizeFramework7ActionNode(node);
    if (
      node.tag === 'navigator' ||
      Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
    )
      result.push({ tag: node.tag, attrs: node.attrs, ancestors });
    const gate = Object.fromEntries(
      Object.entries(node.attrs).filter(([key]) => key.startsWith('wx:')),
    );
    for (const child of node.children)
      walk(child, Object.keys(gate).length ? [...ancestors, gate] : ancestors);
  }
  walk(parsePreviewWxml(source));
  return result;
}
const contains = (
  actual: Record<string, string>,
  expected: Record<string, string>,
) => Object.entries(expected).every(([key, value]) => actual[key] === value);
for (const [file, baseline] of Object.entries(inventory)) {
  test(`${file} preserves original actions and every ancestor data/permission gate`, () => {
    const current = actions(
      read(file.replace('/common.wxml', '/framework7-product.wxml')),
    );
    for (const prior of baseline) {
      const index = current.findIndex(
        (action) =>
          action.tag === prior.tag &&
          contains(action.attrs, prior.attrs) &&
          prior.ancestors.every((gate) =>
            action.ancestors.some((ancestor) => contains(ancestor, gate)),
          ),
      );
      assert.notEqual(
        index,
        -1,
        `Missing action or ancestor guard: ${JSON.stringify(prior)}`,
      );
      current.splice(index, 1);
    }
  });
}
const pages = Object.keys(inventory).filter((file) =>
  file.startsWith('pages/'),
);
test('dining pages are flat, scoped and use supported native icon assets', () => {
  for (const file of pages) {
    const source = read(file);
    parsePreviewWxml(source);
    assert.match(source, /class="screen dining-product/);
    assert.doesNotMatch(source, /WHALEU ·|•••|›|▾|<view class="eyebrow"/);
    assert.match(read(file.replace('.wxml', '.wxss')), /dining\/product.wxss/);
    const config = JSON.parse(read(file.replace('.wxml', '.json'))) as {
      usingComponents?: Record<string, string>;
    };
    assert.equal(
      config.usingComponents?.['wu-icon'],
      '../../components/icon/icon',
    );
    for (const match of source.matchAll(/<wu-icon name="([a-z-]+)"/g))
      assert.ok(
        existsSync(path.join(root, 'assets/icons/light', `${match[1]}.png`)),
        `Missing icon ${match[1]}`,
      );
  }
  assert.doesNotMatch(
    read('window-ratings/window-ratings.wxss'),
    /dp-|dining-product/,
  );
  assert.doesNotMatch(
    read('canteen-floor-scores/canteen-floor-scores.wxss'),
    /dp-|dining-product/,
  );
  assert.match(read('dining/product.wxss'), /min-height: 88rpx/);
  assert.match(read('dining/product.wxss'), /env\(safe-area-inset-bottom\)/);
  assert.match(read('dining/product.wxss'), /var\(--wu-elevated\)/);
});
test('score and filter disclosures retain first-score safety and all signed score choices', () => {
  const floor = read(
    'pages/canteen-floor-score-detail/canteen-floor-score-detail.wxml',
  );
  const window = read('pages/window-rating-detail/window-rating-detail.wxml');
  assert.match(floor, /uiPanel === 'score' (?:&amp;&amp;|&&) !confirming/);
  assert.match(window, /uiPanel === 'score' (?:&amp;&amp;|&&) !confirming/);
  assert.match(floor, /已有有效评分后不能重复提交/);
  assert.match(floor, /当前没有编辑或删除入口/);
  assert.match(window, /selectedScore === null/);
  assert.match(window, /wx:for="{{scores}}"/);
  for (const family of ['canteen-floor-scores', 'window-ratings']) {
    const template = read(`${family}/framework7-product.wxml`);
    assert.match(template, /summary.kind === 'unavailable'/);
    assert.match(template, /summary.ratingCount === 0/);
    assert.match(template, /summary.mean/);
    assert.match(template, /recoveryScore !== null/);
  }
});
test('own dish recovery remains independent from list visibility and pending work cannot be hidden by composition', () => {
  const source = read('pages/window-dishes/window-dishes.wxml');
  const original = actions(source);
  for (const handler of ['onLookup', 'onRetract', 'onRecover', 'onRetry']) {
    const action = original.find((action) => action.attrs.bindtap === handler)!;
    assert.ok(action);
    assert.ok(!action.ancestors.some((gate) => gate['wx:if'] === '{{loaded}}'));
  }
  for (const handler of ['onRecover', 'onRetry', 'onRequestCancellation']) {
    const action = original.find((action) => action.attrs.bindtap === handler)!;
    assert.ok(
      !action.ancestors.some((gate) =>
        (gate['wx:if'] ?? '').includes('uiPanel'),
      ),
    );
  }
  assert.match(
    source,
    /uiPanel === 'dish' (?:&amp;&amp;|&&) !confirming (?:&amp;&amp;|&&) !frozen/,
  );
  assert.match(source, /不能当作尚未推荐/);
  assert.match(source, /maxlength="-1"/);
});
test('transient dining panels clear on page and account lifecycle without editing controller state', () => {
  for (const family of [
    'canteen-floor-scores',
    'window-ratings',
    'dish-recommendations',
  ]) {
    const source = read(`${family}/page.ts`);
    assert.match(source, /onShow\(\) \{\s*this.setData\(\{ uiPanel: '' \}\)/);
    assert.match(source, /onHide\(\) \{\s*this.setData\(\{ uiPanel: '' \}\)/);
    assert.match(source, /this.data.uiPanel === panel \? '' : panel/);
    assert.match(source, /!view.hasSession/);
  }
  const dishes = read('dish-recommendations/page.ts');
  assert.match(dishes, /runtime.sessions.subscribe\(close\)/);
  assert.match(dishes, /runtime.privateViews\?\.subscribe\(close\)/);
  assert.match(dishes, /runtime.safetyChanges\?\.subscribe\(close\)/);
  assert.doesNotMatch(dishes, /!view.loaded \? \{ uiPanel/);
});
