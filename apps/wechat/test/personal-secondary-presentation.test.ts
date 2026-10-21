import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { decodePublicProfile } from '../src/profile/discovery-contract';
import { decodePublicProfileDetails } from '../src/profile/details-contract';
import { decodePost } from '../src/community/contract';
import { decodeBlocksList } from '../src/community/block-contract';
import {
  decodeExperienceSummary,
  decodeExperienceAppearance,
} from '../src/experience/contract';
import { decodeExperienceRanking } from '../src/experience/ranking-contract';

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
  'public-profile',
  'community-blocks',
  'browsing-history',
  'experience',
  'experience-ranking',
  'wallet',
];
const root = path.resolve(__dirname, '..');
const source = (page: string, ext = 'wxml') =>
  readFileSync(path.join(root, 'src/pages', page, `${page}.${ext}`), 'utf8');
const before = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/personal-secondary-action-inventory.json'),
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
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {parsePreviewWxml} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/preview-wxml.mjs')).href)};
import fixtures from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/fixtures/personal-secondary-preview.mjs')).href)};
const root=${JSON.stringify(path.join(root, 'src/pages'))};
function load(file, templates={}) {
  const tree=parsePreviewWxml(readFileSync(file,'utf8'));
  for (const node of tree.children) {
    if(typeof node==='string') continue;
    if(node.tag==='import') load(path.resolve(path.dirname(file),node.attrs.src), templates);
    if(node.tag==='template' && node.attrs.name) templates[node.attrs.name]=node;
  }
  return {tree,templates};
}
console.log(JSON.stringify({pages:Object.fromEntries(${JSON.stringify(pages)}.map(page=>[page,load(root+'/'+page+'/'+page+'.wxml')])),fixtures}));
`,
    ],
    { encoding: 'utf8', maxBuffer: 5_000_000 },
  ),
) as {
  pages: Record<string, { tree: Node; templates: Record<string, Node> }>;
  fixtures: Fixture[];
};
function actions(
  node: Node,
  ancestors: Record<string, string>[] = [],
): Action[] {
  node = normalizeFramework7ActionNode(node);
  if (
    node.tag === 'button' &&
    ['onTab', 'onTradingSubtype'].includes(node.attrs.bindtap ?? '')
  )
    node = { ...node, tag: 'view' };
  const own = Object.fromEntries(
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
  const scopes = Object.keys(own).length ? [...ancestors, own] : ancestors;
  const here =
    node.tag === 'navigator' ||
    Object.keys(node.attrs).some((key) => /^(bind|catch)/.test(key))
      ? [{ tag: node.tag, attrs: node.attrs, scopes }]
      : [];
  return [
    ...here,
    ...node.children.flatMap((child) =>
      typeof child === 'string' ? [] : actions(child, scopes),
    ),
  ];
}
const includes = (
  actual: Record<string, string>,
  expected: Record<string, string>,
) => Object.entries(expected).every(([key, value]) => actual[key] === value);
for (const page of pages)
  test(`${page} keeps every original action, dataset, disabled state and ancestor guard`, () => {
    const current = actions(parsed.pages[page]!.tree);
    for (let action of before[page]!) {
      if (page === 'browsing-history') {
        const handler = action.attrs.bindtap;
        if (handler === 'onDismissClear' || handler === 'onConfirmClear') {
          const dialog = current.find(
            (candidate) => candidate.tag === 'wu-f7-dialog',
          );
          assert.ok(dialog);
          assert.deepEqual(action.scopes, [{ 'wx:if': '{{confirmClear}}' }]);
          assert.equal(
            dialog.attrs[
              handler === 'onConfirmClear' ? 'bind:action' : 'bind:requestclose'
            ],
            handler,
          );
          assert.equal(dialog.attrs.open, '{{clearDialogOpen}}');
          assert.equal(dialog.attrs['session-id'], '{{clearDialogSessionId}}');
          assert.equal(dialog.attrs['wx:if'], undefined);
          continue;
        }
        if (action.tag === 'navigator') {
          assert.equal(action.attrs.url, '/pages/login/login');
          assert.match(source(page, 'ts'), /url: '\/pages\/login\/login'/);
          action = {
            ...action,
            tag: 'button',
            attrs: { bindtap: 'onLogin', disabled: '{{historyOverlayLocked}}' },
          };
        } else if (action.attrs.disabled) {
          assert.ok(
            ['{{busy}}', '{{busy || !hasSession}}'].includes(
              action.attrs.disabled,
            ),
          );
          action = {
            ...action,
            attrs: {
              ...action.attrs,
              disabled: action.attrs.disabled.replace(
                '}}',
                ' || historyOverlayLocked}}',
              ),
            },
          };
        }
      }
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === action.tag &&
          includes(candidate.attrs, action.attrs) &&
          action.scopes.every((scope) =>
            candidate.scopes.some((actual) => includes(actual, scope)),
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(action));
      current.splice(index, 1);
    }
  });
const require = createRequire(__filename);
const definitions = Object.fromEntries(
  pages.map((page) => {
    let definition: Record<string, unknown> | undefined;
    const previous = globalThis.Page;
    globalThis.Page = ((value: Record<string, unknown>) => {
      definition = value;
    }) as typeof Page;
    try {
      const file = path.join(root, 'src/pages', page, `${page}.ts`);
      delete require.cache[require.resolve(file)];
      require(file);
      assert.ok(definition);
      return [page, definition];
    } finally {
      globalThis.Page = previous;
    }
  }),
);
const historyDialogDefinition = (() => {
  let captured:
    | {
        data: Record<string, unknown>;
        properties: Record<string, { value: unknown }>;
      }
    | undefined;
  const previous = globalThis.Component;
  globalThis.Component = ((definition: unknown) => {
    captured = definition as typeof captured;
  }) as typeof Component;
  try {
    const file = path.join(root, 'src/components/f7-dialog/f7-dialog.ts');
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    globalThis.Component = previous;
  }
  assert.ok(captured);
  return captured;
})();
const historyDialogTree = (
  require('../scripts/preview-wxml.mjs') as {
    parsePreviewWxml(source: string): Node;
  }
).parsePreviewWxml(
  readFileSync(
    path.join(root, 'src/components/f7-dialog/f7-dialog.wxml'),
    'utf8',
  ),
);
const expression = (value: string, scope: Record<string, unknown>): unknown =>
  Function(
    'scope',
    `with(scope){return (${value});}`,
  )(new Proxy(scope, { has: () => true }));
const interpolate = (text: string, scope: Record<string, unknown>) =>
  text.replace(/{{([\s\S]*?)}}/g, (_, value: string) =>
    String(expression(value, scope) ?? ''),
  );
function renderNodes(
  nodes: (Node | string)[],
  scope: Record<string, unknown>,
  templates: Record<string, Node>,
): (Node | string)[] {
  const rendered: (Node | string)[] = [];
  let matched = false;
  for (let node of nodes) {
    if (typeof node === 'string') {
      rendered.push(interpolate(node, scope));
      continue;
    }
    node = normalizeFramework7ActionNode(node);
    if (
      node.tag === 'button' &&
      ['onTab', 'onTradingSubtype'].includes(node.attrs.bindtap ?? '')
    )
      node = { ...node, tag: 'view' };
    if (node.tag === 'wu-f7-dialog') {
      const properties = Object.fromEntries(
        Object.entries(historyDialogDefinition.properties).map(
          ([key, schema]) => {
            const name = key.replace(
              /[A-Z]/g,
              (letter) => `-${letter.toLowerCase()}`,
            );
            const attribute = node.attrs[name];
            return [
              key,
              attribute === undefined
                ? schema.value
                : /^{{[\s\S]*}}$/.test(attribute)
                  ? expression(attribute.slice(2, -2), scope)
                  : attribute,
            ];
          },
        ),
      );
      if (properties.open)
        rendered.push(
          ...renderNodes(
            historyDialogTree.children,
            {
              ...historyDialogDefinition.data,
              ...properties,
              rendered: true,
              renderKeys: [{ generation: 1 }],
              visible: true,
              phase: 'open',
              activeSessionId: properties.sessionId,
              generation: 1,
              interactionDisabled: false,
            },
            templates,
          ),
        );
      continue;
    }
    if (node.tag === 'import' || (node.tag === 'template' && node.attrs.name))
      continue;
    if ('wx:for' in node.attrs) {
      const { ['wx:for']: loop, ...attrs } = node.attrs;
      for (const [index, item] of (
        expression(loop!.slice(2, -2), scope) as unknown[]
      ).entries())
        rendered.push(
          ...renderNodes(
            [{ ...node, attrs }],
            {
              ...scope,
              [attrs['wx:for-item'] ?? 'item']: item,
              [attrs['wx:for-index'] ?? 'index']: index,
            },
            templates,
          ),
        );
      continue;
    }
    if ('wx:if' in node.attrs) matched = false;
    const condition = node.attrs['wx:if'] ?? node.attrs['wx:elif'];
    if ('wx:elif' in node.attrs && matched) continue;
    if (condition !== undefined) {
      if (!expression(condition.slice(2, -2), scope)) continue;
      matched = true;
    } else if ('wx:else' in node.attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    if (node.tag === 'template' && node.attrs.is) {
      rendered.push(
        ...renderNodes(
          templates[node.attrs.is]!.children,
          expression(`({${node.attrs.data!.slice(2, -2)}})`, scope) as Record<
            string,
            unknown
          >,
          templates,
        ),
      );
      continue;
    }
    rendered.push({
      ...node,
      attrs: Object.fromEntries(
        Object.entries(node.attrs)
          .filter(([key]) => !key.startsWith('wx:'))
          .map(([key, value]) => [key, interpolate(value, scope)]),
      ),
      children: renderNodes(node.children, scope, templates),
    });
  }
  return rendered;
}
const flatten = (nodes: (Node | string)[]): Node[] =>
  nodes.flatMap((node) =>
    typeof node === 'string' ? [] : [node, ...flatten(node.children)],
  );
const text = (nodes: (Node | string)[]): string =>
  nodes
    .map((node) => (typeof node === 'string' ? node : text(node.children)))
    .join(' ');
const sample = (id: string) =>
  parsed.fixtures.find((fixture) => fixture.id === id)!;
function render(page: string, patch: Record<string, unknown> = {}) {
  const model = parsed.pages[page]!;
  const nodes = renderNodes(
    model.tree.children,
    { ...(definitions[page]!.data as object), ...patch },
    model.templates,
  );
  return { nodes: flatten(nodes), text: text(nodes) };
}
for (const fixture of parsed.fixtures)
  test(`${fixture.id} renders real source markup and all populated/gated markers`, () => {
    assert.ok(fixture.expectedText.length);
    const result = render(fixture.page, fixture.patch);
    for (const marker of fixture.expectedText)
      assert.ok(result.text.includes(marker), `${fixture.id}: ${marker}`);
    assert.doesNotMatch(
      result.text,
      /\{\{|undefined|NaN|\[object Object\]|https?:\/\/|wxfile:|PRIVATE_CANARY/,
    );
  });
test('synthetic public profiles, posts, public capsules, blocked relationships, growth and ranking obey real contracts', () => {
  for (const fixture of parsed.fixtures) {
    const patch = fixture.patch;
    if (patch.profile) decodePublicProfile(patch.profile);
    if (fixture.page === 'public-profile') {
      for (const item of (patch.items ?? []) as unknown[]) decodePost(item);
      if (patch.publicDetails)
        decodePublicProfileDetails(
          (patch.publicDetails as { details: unknown }).details,
        );
    }
    if (fixture.page === 'community-blocks')
      decodeBlocksList({ items: patch.items, nextCursor: null });
    if (patch.summary) decodeExperienceSummary(patch.summary);
    if (patch.appearance) decodeExperienceAppearance(patch.appearance);
    if (fixture.page === 'experience-ranking' && patch.loaded)
      decodeExperienceRanking({
        scope: patch.scope,
        population: patch.population,
        populationCompleteness: patch.populationCompleteness,
        selectionStatus: patch.selectionStatus,
        items: patch.items,
      });
  }
});
test('public capsules are opt-in, current-profile-bound and suppressed during loading or unresolved blocking', () => {
  const patch = sample('personal-public-profile').patch;
  const details = (patch.publicDetails as { details: Record<string, unknown> })
    .details;
  const current = render('public-profile', patch);
  assert.equal(
    current.nodes.filter((node) => node.attrs.class === 'profile-metadata-chip')
      .length,
    3,
  );
  assert.ok(
    current.nodes.some(
      (node) =>
        node.tag === 'wu-icon' &&
        node.attrs.name === 'female' &&
        node.attrs.tone === 'pink',
    ),
  );
  const male = render('public-profile', sample('personal-public-male').patch);
  assert.ok(
    male.nodes.some(
      (node) =>
        node.tag === 'wu-icon' &&
        node.attrs.name === 'male' &&
        node.attrs.tone === 'blue',
    ),
  );
  for (const amendment of [
    {
      publicDetails: {
        details: { ...details, region: null, gender: null, age: null },
      },
    },
    {
      publicDetails: {
        details: {
          ...details,
          profileId: 'other-profile',
          region: 'PRIVATE_CANARY',
        },
      },
    },
    { busy: true },
    { loaded: false },
    { block: { ...(patch.block as object), busy: true } },
    { block: { ...(patch.block as object), frozen: true } },
    { profile: { status: 'unavailable', profileId: details.profileId } },
  ]) {
    const result = render('public-profile', { ...patch, ...amendment });
    assert.equal(
      result.nodes.filter(
        (node) => node.attrs.class === 'profile-metadata-chip',
      ).length,
      0,
    );
    assert.doesNotMatch(result.text, /PRIVATE_CANARY/);
  }
  const zero = render('public-profile', {
    ...patch,
    publicDetails: {
      details: { ...details, region: null, gender: null, age: 0 },
    },
  });
  assert.match(zero.text, /0岁/);
  assert.doesNotMatch(
    source('public-profile'),
    /birthDate|latitude|longitude|details\.own|personaId/,
  );
});
test('hidden public posts, unknown totals and unavailable profiles do not fabricate missing content', () => {
  const patch = sample('personal-public-profile').patch;
  const hidden = render(
    'public-profile',
    sample('personal-public-hidden').patch,
  );
  assert.doesNotMatch(hidden.text, /银杏慢慢变黄|周末沿着/);
  assert.ok(!hidden.nodes.some((node) => node.attrs.bindtap === 'onTab'));
  const unknown = render('public-profile', {
    ...patch,
    profile: {
      ...(patch.profile as object),
      postCount: null,
      postCountStatus: 'unavailable',
      tradeCount: null,
      tradeCountStatus: 'unavailable',
    },
    total: null,
    totalStatus: 'unavailable',
  });
  assert.match(unknown.text, /总数暂不可用/);
  assert.equal(
    unknown.nodes
      .filter((node) => node.attrs.class === 'profile-stat-value')
      .map((node) => text(node.children))
      .join(''),
    '——',
  );
  assert.doesNotMatch(
    render('public-profile', sample('personal-public-unavailable').patch).text,
    /山禾|浙江杭州|21岁/,
  );
});
test('uncertain mutations preserve explicit recovery actions and frozen guard conditions', () => {
  const profile = render(
    'public-profile',
    sample('personal-public-follow-recovery').patch,
  );
  assert.equal(
    profile.nodes.find((node) => node.attrs.bindtap === 'onFollow')!.attrs
      .disabled,
    'true',
  );
  assert.ok(
    profile.nodes.some((node) => node.attrs.bindtap === 'onFollowRetry'),
  );
  const blocks = render(
    'community-blocks',
    sample('personal-blocks-recovery').patch,
  );
  assert.ok(
    blocks.nodes
      .filter((node) => node.attrs.bindtap === 'onUnblock')
      .every((node) => node.attrs.disabled === 'true'),
  );
  assert.ok(blocks.nodes.some((node) => node.attrs.bindtap === 'onBlockRetry'));
  const growth = render(
    'experience',
    sample('personal-experience-recovery').patch,
  );
  assert.equal(
    growth.nodes.find((node) => node.attrs.bindtap === 'onSignIn')!.attrs
      .disabled,
    'true',
  );
  assert.deepEqual(
    growth.nodes
      .filter((node) => node.attrs.bindtap === 'onRecover')
      .map((node) => node.attrs['data-operation']),
    ['sign_in', 'sign_in', 'appearance', 'appearance'],
  );
  const redeem = render(
    'experience',
    sample('personal-experience-redemption').patch,
  );
  assert.ok(
    redeem.nodes.some((node) => node.attrs.bindtap === 'onRecoverRedemption'),
  );
  assert.equal(
    redeem.nodes.find((node) => node.attrs.bindtap === 'onRetryRedemption')!
      .attrs.disabled,
    'true',
  );
  assert.ok(
    !redeem.nodes.some((node) => node.attrs.bindtap === 'onRedeemTitle'),
  );
});
test('growth disclosures are page-local, bounded, initially closed and do not call controllers', () => {
  const definition = definitions.experience!;
  const page = {
    ...definition,
    data: structuredClone(definition.data) as Record<string, unknown>,
    setData(patch: Record<string, unknown>) {
      Object.assign(this.data, patch);
    },
  };
  const toggle = definition.onToggleSection as (
    this: typeof page,
    event: unknown,
  ) => void;
  const panels = () => page.data.experiencePanels as Record<string, boolean>;
  assert.ok(Object.values(panels()).every((value) => !value));
  for (const field of ['appearance', 'records', 'redemption']) {
    toggle.call(page, { currentTarget: { dataset: { field } } });
    assert.equal(panels()[field], true);
  }
  const original = structuredClone(panels());
  for (const field of ['constructor', '__proto__', 'toString', 'profile'])
    toggle.call(page, { currentTarget: { dataset: { field } } });
  assert.deepEqual(panels(), original);
  (definition.onHide as (this: typeof page) => void).call(page);
  assert.ok(Object.values(panels()).every((value) => !value));
  const normal = render('experience', sample('personal-experience').patch);
  assert.ok(
    !normal.nodes.some((node) =>
      ['onSave', 'onTitle', 'onColor', 'onRedemptionInput'].includes(
        node.attrs.bindtap ?? node.attrs.bindinput ?? '',
      ),
    ),
  );
  const open = render(
    'experience',
    sample('personal-experience-appearance').patch,
  );
  assert.ok(open.nodes.some((node) => node.attrs.bindtap === 'onSave'));
});
test('wallet remains a true unavailable state, history stays local, and ranking never invents positions', () => {
  const wallet = render('wallet').text;
  assert.match(wallet, /钱包服务暂未接入/);
  assert.doesNotMatch(wallet, /余额|充值|提现|¥|￥|经验/);
  assert.equal(actions(parsed.pages.wallet!.tree).length, 0);
  assert.match(
    render('browsing-history', sample('personal-history').patch).text,
    /最多保留 200 条已打开的帖子.*退出登录会清除，不会跨设备同步/s,
  );
  const failed = render(
    'browsing-history',
    sample('personal-history-error').patch,
  );
  assert.doesNotMatch(failed.text, /银杏慢慢变黄|校园里适合散步/);
  assert.equal(
    failed.nodes.filter((node) => node.attrs.bindtap === 'onOpen').length,
    0,
  );
  const confirm = render(
    'browsing-history',
    sample('personal-history-clear').patch,
  );
  assert.ok(
    confirm.nodes.some((node) => node.attrs['bind:press'] === 'onCancel'),
  );
  assert.ok(
    confirm.nodes.some((node) => node.attrs['bind:press'] === 'onConfirm'),
  );
  assert.doesNotMatch(
    source('experience-ranking'),
    /\{\{index|wx:for-index|accountId|balance|total_exp/,
  );
});
for (const page of pages)
  test(`${page} uses semantic local theme styles and original local icons`, () => {
    assert.equal(
      JSON.parse(source(page, 'json')).usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
    assert.match(source(page, 'wxss'), /var\(--wu-surface\)/);
    assert.match(source(page, 'wxss'), /var\(--wu-secondary\)/);
    assert.doesNotMatch(source(page, 'wxss'), /page\s*\{[^}]*background:\s*#/);
    assert.doesNotMatch(source(page), /WHALEU|<script|https?:\/\//);
  });

test('native page titles are not repeated as body banners', () => {
  for (const page of pages)
    assert.doesNotMatch(
      source(page),
      /class="(?:profile-page-title|blocks-title|history-heading|experience-title|ranking-title|wallet-heading)"|profile-hero/,
    );
});
