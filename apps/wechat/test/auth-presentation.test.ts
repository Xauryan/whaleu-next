import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { initialStudentView } from '../src/verification/student-controller';
import { studentPage } from '../src/verification/student-page';
import {
  localDateLabel,
  presentStudentDates,
} from '../src/pages/student-verification/presentation';
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
  'login',
  'phone-binding',
  'campus',
  'identity-campus',
  'verification',
  'student-verification',
  'student-verification-notices',
  'institutional-verification',
];
const root = path.resolve(__dirname, '..');
const source = (page: string, ext: string) =>
  readFileSync(path.join(root, 'src/pages', page, `${page}.${ext}`), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/auth-action-inventory.json'),
    'utf8',
  ),
) as Record<string, Action[]>;
const parsed = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
  import { readFileSync } from 'node:fs';
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  let definition; globalThis.Page = value => { definition = value; };
  const data = Object.fromEntries(${JSON.stringify(pages)}.map(page => { require(${JSON.stringify(path.join(root, 'src/pages'))} + '/' + page + '/' + page + '.ts'); return [page, definition.data]; }));
  import { parsePreviewWxml } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/preview-wxml.mjs')).href)};
  import fixtures from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/fixtures/auth-preview.mjs')).href)};
  const trees = Object.fromEntries(${JSON.stringify(pages)}.map(page => [page, parsePreviewWxml(readFileSync(${JSON.stringify(path.join(root, 'src/pages'))} + '/' + page + '/' + page + '.wxml', 'utf8'))]));
  console.log(JSON.stringify({ trees, fixtures, data }));
`,
    ],
    { encoding: 'utf8' },
  ),
) as {
  trees: Record<string, Node>;
  fixtures: Fixture[];
  data: Record<string, Record<string, unknown>>;
};
function actions(
  raw: Node,
  ancestors: Record<string, string>[] = [],
  profileVerificationNative = true,
): Action[] {
  let node = profileVerificationNative
    ? normalizeFramework7ActionNode(raw)
    : raw;
  if (profileVerificationNative && raw.tag === 'wu-f7-input') {
    const {
      ['bind:input']: input,
      ['bind:confirm']: confirm,
      ...attrs
    } = raw.attrs;
    node = {
      ...raw,
      tag: 'input',
      attrs: {
        ...attrs,
        ...(input ? { bindinput: input } : {}),
        ...(confirm ? { bindconfirm: confirm } : {}),
      },
    };
  }
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
      typeof child === 'string'
        ? []
        : actions(child, scopes, profileVerificationNative),
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
    const current = actions(parsed.trees[page]!, [], true);
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
    assert.match(source(page, 'wxml'), /class="account-page/);
    assert.doesNotMatch(
      source(page, 'wxml'),
      /class="card"|class="hint"|account-hero|hero-title|hero-copy|你的校园，|你的认证，一目了然|让校园认识你|<script/,
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
  profileVerificationNative = true,
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
        result += visible(
          [{ ...node, attrs: rest }],
          {
            ...scope,
            [attrs['wx:for-item'] ?? 'item']: item,
            [attrs['wx:for-index'] ?? 'index']: index,
          },
          profileVerificationNative,
        );
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
    if (
      profileVerificationNative &&
      ['wu-f7-list-item', 'wu-f7-block'].includes(node.tag) &&
      attrs.title
    )
      result += resolve(attrs.title, scope);
    result += visible(node.children, scope, profileVerificationNative);
  }
  return result;
}
for (const fixture of parsed.fixtures) {
  test(`${fixture.id} renders meaningful sample content without leaking expressions or diagnostic copy`, () => {
    const data = { ...parsed.data[fixture.page], ...fixture.patch };
    const text = visible(parsed.trees[fixture.page]!.children, data, true);
    for (const expected of fixture.expectedText)
      assert.ok(text.includes(expected), `${fixture.id}: ${expected}`);
    assert.doesNotMatch(
      text,
      /\{\{|undefined|NaN|当前能力边界|社区 C1|新校园与个人资料 API/,
    );
  });
}

test('native phone and school consent keep their original authorization boundaries', () => {
  const phone = actions(parsed.trees['phone-binding']!).find(
    (action) => action.attrs['open-type'] === 'getPhoneNumber',
  );
  assert.equal(phone?.attrs.bindgetphonenumber, 'onPhone');
  assert.equal(phone?.attrs.disabled, '{{busy || !hasSession}}');
  assert.ok(
    phone?.scopes.some(
      (scope) => scope['wx:if'] === "{{phase === 'reserved'}}",
    ),
  );
  const school = actions(parsed.trees['institutional-verification']!).find(
    (action) => action.attrs.bindtap === 'onPrepare',
  );
  assert.equal(school?.attrs.disabled, '{{busy || !consentAccepted}}');
  assert.ok(
    school?.scopes.some(
      (scope) =>
        scope['wx:if'] ===
          "{{capability.state === 'eligible' &amp;&amp; nativeAvailable}}" ||
        scope['wx:if'] ===
          "{{capability.state === 'eligible' && nativeAvailable}}",
    ),
  );
});

test('unavailable school provider never presents live authorization or consent', () => {
  const fixture = parsed.fixtures.find(
    (item) => item.id === 'auth-school-unavailable',
  )!;
  const text = visible(parsed.trees[fixture.page]!.children, {
    ...parsed.data[fixture.page],
    ...fixture.patch,
  });
  assert.ok(text.includes('当前不能进行真实学校登录'));
  assert.doesNotMatch(text, /开始本次学校授权|同意并准备本次授权/);
  assert.match(
    source('institutional-verification', 'wxml'),
    /\{\{item.fullName\}\}/,
  );
});

test('dates are display-only and invalid dates remain unavailable', () => {
  const raw = '2026-11-20T10:30:00.000Z';
  const view = {
    ...initialStudentView(),
    application: {
      id: 'qa',
      revision: 1,
      state: 'pending' as const,
      campusId: 'qa-campus',
      campusName: '示例大学',
      institutionName: '示例大学',
      regionId: 'qa-region',
      profileId: null,
      submittedAt: null,
      reason: null,
      evidenceRevision: null,
      evidenceAvailable: false,
      evidenceExpiresAt: raw,
    },
  };
  const before = JSON.stringify(view);
  const display = presentStudentDates(view);
  assert.equal(JSON.stringify(view), before);
  assert.equal(view.application.evidenceExpiresAt, raw);
  assert.match(
    display.evidenceExpiresLabel,
    /^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/,
  );
  assert.equal(localDateLabel(null), '时间暂不可用');
  assert.equal(localDateLabel('not-a-date'), '时间暂不可用');
  assert.equal(
    (studentPage('own').data as Record<string, unknown>).evidenceExpiresLabel,
    undefined,
  );
  assert.equal(
    (studentPage('own', presentStudentDates).data as Record<string, unknown>)
      .evidenceExpiresLabel,
    '时间暂不可用',
  );
  assert.match(
    source('student-verification', 'wxml'),
    /材料访问截止：\{\{evidenceExpiresLabel\}\}（设备当地时间）/,
  );
  assert.doesNotMatch(
    source('student-verification-notices', 'wxml'),
    /\{\{item.createdAt\}\}/,
  );
});

test('private evidence preview stays source-bound and explicitly clearable', () => {
  const tree = parsed.trees['student-verification']!;
  const preview = actions(tree, [], true).find(
    (action) => action.attrs.bindtap === 'onClosePreview',
  );
  assert.ok(
    preview?.scopes.some((scope) => scope['wx:if'] === '{{evidenceSrc}}'),
  );
  assert.match(
    source('student-verification', 'wxml'),
    /src="\{\{evidenceSrc\}\}"/,
  );
  assert.match(
    source('student-verification', 'wxml'),
    /无需另填真实姓名、身份证号或学号/,
  );
});

test('required consent and delivery limitations remain contextual without promotional headings', () => {
  assert.match(source('phone-binding', 'wxml'), /授权码会发送至微信官方接口/);
  assert.match(source('phone-binding', 'wxml'), /不保存或展示手机号/);
  assert.match(source('phone-binding', 'wxml'), /微信账号资格、隐私声明要求/);
  assert.match(
    source('student-verification-notices', 'wxml'),
    /仅在站内展示，不通过微信或公众号外发/,
  );
  assert.match(
    source('identity-campus', 'wxml'),
    /不改浏览校园、认证、历史内容或管理范围/,
  );
});
