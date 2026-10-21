import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { initialErrandView } from '../src/errands/controller';
import {
  errandDisplayTime,
  errandFormCounts,
  errandPresentation,
  errandNoticeTimeLabels,
} from '../src/pages/errand-list/presentation';
import { errandStateLabels } from '../src/errands/contract';
import { initialErrandNoticesView } from '../src/errands/notices';
import { initialErrandPanels, toggledErrandPanels } from '../src/errands/page';
import { initialErrandPublicationView } from '../src/errands/publication-runtime';
import { initialErrandTargetServicesView } from '../src/errands/target-services';
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
const root = path.resolve(__dirname, '..');
const pages = [
  'errand-list',
  'errand-detail',
  'errand-mine',
  'errand-compose',
  'errand-notices',
];
const source = (page: string, ext = 'wxml') =>
  readFileSync(path.join(root, 'src/pages', page, `${page}.${ext}`), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/errands-action-inventory.json'),
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
  import fixtures from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/fixtures/errands-preview.mjs')).href)};
  const trees = Object.fromEntries(${JSON.stringify(pages)}.map(page => [page, parsePreviewWxml(readFileSync(${JSON.stringify(path.join(root, 'src/pages'))} + '/' + page + '/' + page + '.wxml', 'utf8'))]));
  trees.common = parsePreviewWxml(readFileSync(${JSON.stringify(path.join(root, 'src/errands/f7-common.wxml'))}, 'utf8'));
  console.log(JSON.stringify({ trees, fixtures }));
`,
    ],
    { encoding: 'utf8' },
  ),
) as { trees: Record<string, Node>; fixtures: Fixture[] };
function actions(
  raw: Node,
  ancestors: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
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
const includes = (
  current: Record<string, string>,
  expected: Record<string, string>,
) => Object.entries(expected).every(([key, value]) => current[key] === value);
for (const [page, original] of Object.entries(inventory)) {
  test(`${page} retains each original event, route, input binding and ancestor safety gate`, () => {
    const current = actions(parsed.trees[page]!);
    for (const previous of original) {
      const found = current.findIndex(
        (candidate) =>
          candidate.tag === previous.tag &&
          includes(candidate.attrs, previous.attrs) &&
          previous.scopes.every((scope) =>
            candidate.scopes.some((actual) => includes(actual, scope)),
          ),
      );
      assert.notEqual(
        found,
        -1,
        `Missing or weakened action: ${JSON.stringify(previous)}`,
      );
      current.splice(found, 1);
    }
  });
}
const templates = Object.fromEntries(
  parsed.trees
    .common!.children.filter(
      (node): node is Node =>
        typeof node !== 'string' && node.tag === 'template',
    )
    .map((node) => [node.attrs.name, node.children]),
);
function evaluate(value: string, scope: Record<string, unknown>): unknown {
  return Function(
    'scope',
    `with (scope) { return (${value}); }`,
  )(new Proxy(scope, { has: () => true }));
}
const resolve = (text: string, scope: Record<string, unknown>) =>
  text.replace(/{{([\s\S]*?)}}/g, (_, expression: string) =>
    String(evaluate(expression, scope) ?? ''),
  );
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
    if (node.tag === 'import' || (node.tag === 'template' && attrs.name))
      continue;
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
    if (node.tag === 'template' && attrs.is) {
      result += visible(
        templates[attrs.is]!,
        evaluate(`({${attrs.data!.slice(2, -2)}})`, scope) as Record<
          string,
          unknown
        >,
      );
    } else result += visible(node.children, scope);
  }
  return result;
}
function data(page: string, patch: Record<string, unknown> = {}) {
  return {
    ...(page === 'errand-notices'
      ? initialErrandNoticesView()
      : initialErrandView()),
    ...errandPresentation(initialErrandView()),
    timeLabels: errandNoticeTimeLabels([]),
    uiPanels: initialErrandPanels(),
    imagePublication: initialErrandPublicationView(),
    targetServices: initialErrandTargetServicesView(),
    orderImage: { status: 'idle', src: '', message: '' },
    targetQr: { status: 'idle', src: '', message: '' },
    errandStateLabels,
    adminAvailable: false,
    ...patch,
  };
}
const render = (page: string, patch: Record<string, unknown>) =>
  visible(parsed.trees[page]!.children, data(page, patch));
for (const fixture of parsed.fixtures) {
  test(`${fixture.id} renders its real fixture markers, not an empty fallback`, () => {
    const text = render(fixture.page, fixture.patch);
    for (const marker of fixture.expectedText)
      assert.ok(text.includes(marker), `${fixture.id}: ${marker}`);
    assert.doesNotMatch(
      text,
      /\{\{|undefined|NaN|服务端核验|独立处理和审核|真实设备验收|原编号与原内容/,
    );
  });
}
for (const page of pages) {
  test(`${page} is isolated from legacy admin styles and uses local native icons`, () => {
    assert.match(source(page), /class="errand-page/);
    assert.doesNotMatch(
      source(page),
      /class="card"|class="notice"|class="title"|<script|https?:\/\//,
    );
    assert.match(source(page, 'wxss'), /f7-errands\.wxss/);
    assert.equal(
      JSON.parse(source(page, 'json')).usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
  });
}
test('disclosures have a bounded key set and do not carry order or contact data', () => {
  const initial = initialErrandPanels();
  assert.deepEqual(Object.keys(initial), [
    'campus',
    'sort',
    'private',
    'images',
    'details',
  ]);
  assert.ok(Object.values(initial).every((value) => value === false));
  assert.equal(toggledErrandPanels(initial, 'orderId'), initial);
  assert.equal(toggledErrandPanels(initial, '__proto__'), initial);
  const changed = toggledErrandPanels(initial, 'private');
  assert.equal(changed.private, true);
  assert.equal(initial.private, false);
  assert.equal(toggledErrandPanels(changed, 'private').private, false);
});
test('unrelated viewers cannot see injected private text, contacts or private image actions', () => {
  const sample = parsed.fixtures.find(
    (fixture) => fixture.id === 'errand-participant-sample',
  )!;
  const original = sample.patch.detail as Record<string, unknown>;
  const text = render('errand-detail', {
    ...sample.patch,
    detail: {
      ...original,
      relation: 'none',
      capabilities: {
        accept: false,
        cancel: false,
        complete: false,
        delete: false,
      },
      privateText: 'PRIVATE_CANARY',
      oppositeContact: {
        display: { status: 'available', displayName: 'CONTACT_CANARY' },
        contacts: { wechat: 'SECRET_CANARY', phone: '00000000000' },
      },
      privateMedia: [{ slot: 'private-0', bindingId: 'secret' }],
    },
  });
  assert.doesNotMatch(
    text,
    /PRIVATE_CANARY|CONTACT_CANARY|SECRET_CANARY|双方私密图片|取消订单|确认完成|删除订单/,
  );
});
test('terminal participant order keeps private notes but hides stale contacts and capability actions', () => {
  const sample = parsed.fixtures.find(
    (fixture) => fixture.id === 'errand-participant-sample',
  )!;
  const original = sample.patch.detail as Record<string, unknown>;
  for (const state of ['completed', 'cancelled']) {
    const text = render('errand-detail', {
      ...sample.patch,
      detail: {
        ...original,
        state,
        capabilities: {
          accept: false,
          cancel: false,
          complete: false,
          delete: true,
        },
      },
    });
    assert.match(text, /取件后请放在一层门厅/);
    assert.doesNotMatch(
      text,
      /synthetic-contact|示例接单同学|确认完成|取消订单|接取此订单/,
    );
    assert.match(text, /删除订单/);
  }
});
test('unloaded detail hides all stale order contents, and frozen state retains identical recovery actions', () => {
  const sample = parsed.fixtures.find(
    (fixture) => fixture.id === 'errand-participant-sample',
  )!;
  const text = render('errand-detail', {
    ...sample.patch,
    loaded: false,
    frozen: true,
    recoveryOperation: '接单',
  });
  assert.doesNotMatch(
    text,
    /取件后请放在一层门厅|synthetic-contact|帮取一件快递|确认完成/,
  );
  assert.match(text, /查询原回执/);
  assert.match(text, /重试完全相同的请求/);
});
test('reward display remains exact string data and never assumes two decimal places', () => {
  const sample = parsed.fixtures.find(
    (fixture) => fixture.id === 'errand-detail-sample',
  )!;
  const amount = '12.34567890123456789';
  assert.ok(
    render('errand-detail', {
      ...sample.patch,
      detail: { ...(sample.patch.detail as object), reward: amount },
    }).includes(amount),
  );
  assert.doesNotMatch(
    source('errand-detail'),
    /toFixed|Math\.round|parseFloat|requestPayment/,
  );
  assert.match(source('errand-compose'), /不产生线上付款/);
});
test('optional composer sections are closed by default while all required fields remain mounted', () => {
  const sample = parsed.fixtures.find(
    (fixture) => fixture.id === 'errand-compose-sample',
  )!;
  const text = render('errand-compose', sample.patch);
  assert.doesNotMatch(text, /公开图片1|私密图片3|恢复上传/);
  assert.match(text, /期望时间/);
  assert.match(text, /跑腿报酬/);
  assert.match(text, /微信和电话均需填写/);
  assert.match(
    source('errand-compose'),
    /wx:if="{{loaded &amp;&amp; !frozen}}"/,
  );
});
test('light and dark presentation uses semantic materials and fixed action space reserves the safe area', () => {
  const css = readFileSync(
    path.join(root, 'src/errands/f7-errands.wxss'),
    'utf8',
  );
  assert.match(css, /var\(--f7-block-strong-bg-color\)/);
  assert.match(css, /var\(--f7-text-color\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(css, /#fffaf0|#e2c588|background:\s*#fff\b/);
});

test('composer counters match Unicode code points and canonical whitespace rather than UTF-16', () => {
  assert.deepEqual(
    errandFormCounts({ title: '  📦帮取快递  ', publicText: 'A\r\n𠮷' }),
    { title: 5, publicText: 3 },
  );
  assert.doesNotMatch(
    source('errand-compose'),
    /form\.(title|publicText)\.length/,
  );
});
test('timestamps use supplied instants in local readable form and missing or invalid dates stay unknown', () => {
  assert.equal(errandDisplayTime(''), '');
  assert.equal(errandDisplayTime(null), '');
  assert.equal(errandDisplayTime('not-a-time'), '时间未知');
  const instant = '2026-10-20T09:30:00.000Z';
  const date = new Date(instant);
  assert.equal(
    errandDisplayTime(instant),
    `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`,
  );
  assert.doesNotMatch(
    source('errand-notices'),
    /{{item\.(createdAt|startsAt|endsAt|releasedAt)}}/,
  );
});
