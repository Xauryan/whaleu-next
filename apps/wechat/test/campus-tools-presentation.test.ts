import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import {
  initialToolEntryView,
  initialToolHubView,
} from '../src/campus-tools/controller';
import { initialToolImageView } from '../src/campus-tools/media';

type Node = {
  tag: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
};
type Action = {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
};
type Fixture = {
  id: string;
  page: string;
  title: string;
  patch: Record<string, unknown>;
  expectedText: string[];
};
const pages = [
  'campus-tools',
  'campus-tools-map',
  'campus-tools-shuttle',
  'campus-tools-research',
  'campus-tools-webview',
];
const root = path.resolve(__dirname, '..');
const source = (page: string, ext: string) =>
  readFileSync(path.join(root, 'src/pages', page, `${page}.${ext}`), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/campus-tools-action-inventory.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
const parsed = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
  import { readFileSync } from 'node:fs';
  import { parsePreviewWxml } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/preview-wxml.mjs')).href)};
  import fixtures from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/fixtures/campus-tools-preview.mjs')).href)};
  const trees = Object.fromEntries(${JSON.stringify(pages)}.map(page => [page, parsePreviewWxml(readFileSync(${JSON.stringify(path.join(root, 'src/pages'))} + '/' + page + '/' + page + '.wxml', 'utf8'))]));
  console.log(JSON.stringify({ trees, fixtures }));
`,
    ],
    { encoding: 'utf8' },
  ),
) as { trees: Record<string, Node>; fixtures: Fixture[] };
function actions(
  node: Node,
  ancestors: Record<string, string>[] = [],
): Action[] {
  node = normalizeFramework7ActionNode(node);
  const ownScope = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:key',
      ].includes(key),
    ),
  );
  const scopes = Object.keys(ownScope).length
    ? [...ancestors, ownScope]
    : ancestors;
  const own =
    node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : [];
  return [
    ...own,
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scopes),
    ),
  ];
}
function includesAttrs(
  current: Record<string, string>,
  expected: Record<string, string>,
) {
  return Object.entries(expected).every(
    ([key, value]) => current[key] === value,
  );
}
for (const page of pages) {
  test(`${page} preserves every original action, data binding and ancestor safety gate`, () => {
    const current = actions(parsed.trees[page]!);
    for (const old of inventory[page]!) {
      const found = current.find(
        (candidate) =>
          candidate.tag === old.tag &&
          includesAttrs(candidate.attrs, old.attrs) &&
          old.scopes.every((scope) =>
            candidate.scopes.some((actual) => includesAttrs(actual, scope)),
          ),
      );
      assert.ok(found, `${page}: ${JSON.stringify(old)}`);
    }
  });
  test(`${page} uses semantic native surfaces and local icon registration`, () => {
    assert.match(source(page, 'wxml'), /class="tools-page/);
    assert.doesNotMatch(
      source(page, 'wxml'),
      /class="card"|class="hint"|<script/,
    );
    assert.equal(
      JSON.parse(source(page, 'json')).usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
  });
}
function evaluate(value: string, scope: Record<string, unknown>): unknown {
  return Function(
    'scope',
    `with (scope) { return (${value}); }`,
  )(new Proxy(scope, { has: () => true }));
}
function resolve(text: string, scope: Record<string, unknown>): string {
  return text.replace(/{{([\s\S]*?)}}/g, (_, expression: string) =>
    String(evaluate(expression, scope) ?? ''),
  );
}
function visible(
  nodes: (Node | string)[],
  scope: Record<string, unknown>,
): string {
  let result = '',
    matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      result += resolve(node, scope);
      continue;
    }
    const attrs = node.attrs;
    if (attrs['wx:for']) {
      const { ['wx:for']: loop, ...rest } = attrs;
      const values = evaluate(loop.slice(2, -2), scope) as unknown[];
      for (const [index, item] of values.entries())
        result += visible([{ ...node, attrs: rest }], {
          ...scope,
          [attrs['wx:for-item'] ?? 'item']: item,
          [attrs['wx:for-index'] ?? 'index']: index,
        });
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
    result += visible(node.children, scope);
  }
  return result;
}
for (const fixture of parsed.fixtures) {
  test(`${fixture.id} renders meaningful sample content without leaking expressions or diagnostic copy`, () => {
    const data = {
      ...(fixture.page === 'campus-tools'
        ? { ...initialToolHubView(), query: '' }
        : { ...initialToolEntryView(), image: initialToolImageView() }),
      authRecovery: false,
      ...fixture.patch,
    };
    const text = visible(parsed.trees[fixture.page]!.children, data);
    for (const expected of fixture.expectedText)
      assert.ok(text.includes(expected), `${fixture.id}: ${expected}`);
    assert.doesNotMatch(
      text,
      /\{\{|undefined|NaN|当前已确认的工具资料|可信的嵌入能力/,
    );
  });
}
test('unavailable, withdrawn and unauthenticated entries cannot display loaded content actions', () => {
  for (const page of pages.slice(1)) {
    for (const state of [
      'unknown',
      'expired',
      'unavailable',
      'disabled',
      'withdrawn',
    ]) {
      const text = visible(parsed.trees[page]!.children, {
        ...initialToolEntryView(),
        image: initialToolImageView(),
        authRecovery: false,
        state,
        status: `状态：${state}`,
      });
      assert.ok(text.includes(`状态：${state}`));
      assert.doesNotMatch(text, /定位到我|校园地点|复制资源链接|上一张|下一张/);
    }
  }
});
test('map and webview keep original native event identities and default-denied providers', () => {
  const map = actions(parsed.trees['campus-tools-map']!).find(
    (action) => action.tag === 'map',
  );
  assert.equal(map?.attrs['show-location'], '{{located}}');
  assert.equal(map?.attrs.bindmarkertap, 'onMarker');
  const webview = actions(parsed.trees['campus-tools-webview']!).find(
    (action) => action.tag === 'web-view',
  );
  assert.equal(webview?.attrs.src, '{{webviewSrc}}');
  assert.equal(webview?.attrs['data-source'], '{{webviewSrc}}');
  assert.equal(webview?.attrs['data-view-id'], '{{webviewViewId}}');
  assert.equal(webview?.attrs.bindmessage, 'onWebviewMessage');
  for (const page of pages.slice(1))
    assert.match(
      source(page, 'ts'),
      /^import \{ registerToolPage \} from '..\/..\/campus-tools\/page';/,
    );
});

test('native navigation titles are not repeated by permanent content headings', () => {
  assert.doesNotMatch(source('campus-tools', 'wxml'), /class="tools-title"/);
  for (const page of pages.slice(1)) {
    const title = JSON.parse(source(page, 'json'))
      .navigationBarTitleText as string;
    assert.ok(source(page, 'wxml').includes(`entry.title !== '${title}'`));
  }
});

test('external tool waiting for trusted embed admission does not report a false failure', () => {
  const text = visible(parsed.trees['campus-tools-webview']!.children, {
    ...initialToolEntryView(),
    image: initialToolImageView(),
    authRecovery: false,
    state: 'enabled',
    status: '当前已确认的工具资料',
  });
  assert.ok(text.includes('正在连接'));
  assert.doesNotMatch(text, /暂时无法打开|当前已确认的工具资料/);
});
