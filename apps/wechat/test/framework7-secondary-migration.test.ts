import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  directoryKinds,
  directoryKindLabels,
  directoryPlatformLabels,
} from '../src/directory/contract';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';

interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
interface Baseline {
  sourceSha256: string;
  typescriptSha256: string;
  actions: Action[];
}
const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml } = requireNative('../scripts/preview-wxml.mjs') as {
  parsePreviewWxml(source: string): PresentationNode;
};
const baselines = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/framework7-secondary-v26-actions.json'),
    'utf8',
  ),
) as Record<string, Baseline>;
const protectedFiles = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/framework7-secondary-v26-protected.json'),
    'utf8',
  ),
) as Record<string, string>;
const source = (page: string, extension = 'wxml') =>
  readFileSync(
    path.join(root, 'src/pages', page, `${page}.${extension}`),
    'utf8',
  );
const tree = (page: string) => parsePreviewWxml(source(page));
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const includes = (
  actual: Record<string, string>,
  expected: Record<string, string>,
) => Object.entries(expected).every(([key, value]) => actual[key] === value);
function actions(
  node: PresentationNode,
  ancestors: Record<string, string>[] = [],
): Action[] {
  node = normalizeFramework7ActionNode(node);
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
  const scopes = Object.keys(own).length ? [...ancestors, own] : ancestors;
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

for (const [page, baseline] of Object.entries(baselines)) {
  test(`${page}: every v26 action keeps its own attributes, dataset and full ancestor scope`, () => {
    const current = actions(tree(page));
    const historyDialog =
      page === 'browsing-history'
        ? current.find((candidate) => candidate.tag === 'wu-f7-dialog')
        : undefined;
    if (historyDialog) current.splice(current.indexOf(historyDialog), 1);
    assert.equal(
      current.length,
      baseline.actions.length - (historyDialog ? 2 : 0),
    );
    for (let original of baseline.actions) {
      if (page === 'browsing-history') {
        const handler = original.attrs.bindtap;
        if (handler === 'onDismissClear' || handler === 'onConfirmClear') {
          assert.ok(historyDialog);
          assert.deepEqual(original.scopes, [{ 'wx:if': '{{confirmClear}}' }]);
          assert.equal(
            historyDialog.attrs[
              handler === 'onConfirmClear' ? 'bind:action' : 'bind:requestclose'
            ],
            handler,
          );
          assert.equal(historyDialog.attrs.open, '{{clearDialogOpen}}');
          assert.equal(
            historyDialog.attrs['session-id'],
            '{{clearDialogSessionId}}',
          );
          assert.equal(
            historyDialog.attrs['attempt-key'],
            '{{clearDialogAttempt}}',
          );
          assert.equal(historyDialog.attrs['wx:if'], undefined);
          continue;
        }
        if (original.tag === 'navigator') {
          assert.equal(original.attrs.url, '/pages/login/login');
          original = {
            ...original,
            tag: 'button',
            attrs: {
              'wx:if': '{{!hasSession}}',
              bindtap: 'onLogin',
              disabled: '{{historyOverlayLocked}}',
            },
          };
        } else if (original.attrs.disabled) {
          assert.ok(
            ['{{busy}}', '{{busy || !hasSession}}'].includes(
              original.attrs.disabled,
            ),
          );
          original = {
            ...original,
            attrs: {
              ...original.attrs,
              disabled: original.attrs.disabled.replace(
                '}}',
                ' || historyOverlayLocked}}',
              ),
            },
          };
        }
      }
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === original.tag &&
          includes(candidate.attrs, original.attrs) &&
          original.scopes.every((scope) =>
            candidate.scopes.some((actual) => includes(actual, scope)),
          ),
      );
      assert.notEqual(index, -1, `${page}: ${JSON.stringify(original)}`);
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
  });
  test(`${page}: source uses registered native F7 components without H5, dynamic providers or duplicate body titles`, () => {
    const config = JSON.parse(source(page, 'json')) as {
      navigationBarTitleText: string;
      usingComponents: Record<string, string>;
    };
    const nodes = flatten(tree(page));
    for (const tag of ['button', 'block', 'list', 'list-item']) {
      const name = `wu-f7-${tag}`;
      assert.ok(
        nodes.some((node) => node.tag === name),
        name,
      );
      assert.equal(
        config.usingComponents[name],
        `../../components/f7-${tag}/f7-${tag}`,
      );
      for (const extension of ['json', 'ts', 'wxml', 'wxss'])
        assert.ok(
          existsSync(
            path.join(
              root,
              'src/components',
              `f7-${tag}`,
              `f7-${tag}.${extension}`,
            ),
          ),
        );
    }
    for (const item of nodes.filter((node) => node.tag === 'wu-f7-list-item')) {
      assert.ok(
        !flatten(item)
          .slice(1)
          .some((node) =>
            ['button', 'navigator', 'input', 'switch', 'wu-f7-button'].includes(
              node.tag,
            ),
          ),
        'ListItem slots must be presentational, never nested controls',
      );
      if (item.attrs['bind:press']) assert.equal(item.attrs.link, '{{true}}');
      assert.equal(item.attrs.bindtap, undefined);
    }
    for (const navigator of nodes.filter((node) => node.tag === 'navigator'))
      for (const item of flatten(navigator).filter(
        (node) => node.tag === 'wu-f7-list-item',
      ))
        assert.notEqual(
          item.attrs.link,
          '{{true}}',
          'Native navigators wrap static presentation, never a second control',
        );
    assert.doesNotMatch(
      source(page),
      /<web-view|<script|https?:\/\/|webviewSrc|hero|marketing/,
    );
    assert.ok(!source(page).includes(`>${config.navigationBarTitleText}</`));
    if (!['directory-hub', 'browsing-history'].includes(page))
      assert.equal(hash(source(page, 'ts')), baseline.typescriptSha256);
  });
}

test('the migration preserves controller/gateway/private history and shared directory-detail styles byte for byte', () => {
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(
      hash(readFileSync(path.join(root, file), 'utf8')),
      expected,
      file,
    );
});

test('the Framework7 preview batch is restricted to these four pages and retains recovery and clear-confirm states', () => {
  const fixtureUrl = pathToFileURL(
    path.join(root, 'scripts/fixtures/framework7-preview.mjs'),
  ).href;
  const fixtures = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import fixtures from ${JSON.stringify(fixtureUrl)}; console.log(JSON.stringify(fixtures));`,
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    id: string;
    page: string;
    patch: Record<string, unknown>;
    expectedText: string[];
  }[];
  assert.equal(fixtures.length, 9);
  assert.deepEqual(
    [...new Set(fixtures.map((fixture) => fixture.page))].sort(),
    Object.keys(baselines).sort(),
  );
  assert.ok(fixtures.some((fixture) => fixture.patch.authRecovery === true));
  assert.ok(fixtures.some((fixture) => fixture.patch.confirmClear === true));
  assert.ok(fixtures.some((fixture) => fixture.patch.hasSession === false));
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^framework7-/);
    assert.ok(fixture.expectedText.length > 0);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accessToken|refreshToken|accountId|providerId/,
    );
  }
});

test('directory segmented values are bounded, delegated to the original handler and not locally committed', () => {
  type Definition = {
    data: {
      kind: string;
      busy: boolean;
      directorySegmentOptions: { value: string; label: string }[];
    };
    onKind(event: { currentTarget: { dataset: { kind: string } } }): void;
    onKindSegment(event: { detail: { value: string } }): void;
  };
  let definition: Definition | undefined;
  const previous = globalThis.Page;
  globalThis.Page = ((value: unknown) => {
    definition = value as Definition;
  }) as typeof Page;
  try {
    const file = path.join(root, 'src/pages/directory-hub/directory-hub.ts');
    delete requireNative.cache[requireNative.resolve(file)];
    requireNative(file);
  } finally {
    globalThis.Page = previous;
  }
  assert.ok(definition);
  assert.deepEqual(
    definition.data.directorySegmentOptions,
    directoryKinds.map((value) => ({
      value,
      label: directoryKindLabels[value],
    })),
  );
  const chosen: string[] = [];
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    controller: {
      chooseKind(kind: string) {
        chosen.push(kind);
      },
    },
  };
  const before = structuredClone(page.data);
  for (const value of directoryKinds) page.onKindSegment({ detail: { value } });
  for (const value of ['', 'other', '__proto__', 'constructor'])
    page.onKindSegment({ detail: { value } });
  assert.deepEqual(chosen, [...directoryKinds]);
  assert.deepEqual(page.data, before);
  page.data.busy = true;
  page.onKindSegment({ detail: { value: 'official' } });
  assert.deepEqual(chosen, [...directoryKinds, 'official']);
  const segmented = flatten(tree('directory-hub')).find(
    (node) => node.tag === 'wu-f7-segmented',
  )!;
  assert.equal(segmented.attrs.options, '{{directorySegmentOptions}}');
  assert.equal(segmented.attrs.value, '{{kind}}');
  assert.equal(segmented.attrs.disabled, undefined);
  assert.equal(segmented.attrs['bind:change'], 'onKindSegment');
});

test('history clearing retains explicit confirmation through the controlled destructive Dialog', () => {
  const nodes = flatten(tree('browsing-history'));
  const dialog = nodes.find((node) => node.tag === 'wu-f7-dialog')!;
  assert.equal(dialog.attrs.mode, 'confirm');
  assert.equal(dialog.attrs.destructive, '{{true}}');
  assert.equal(dialog.attrs['confirm-id'], 'clear-history');
  assert.equal(dialog.attrs['bind:action'], 'onConfirmClear');
  assert.equal(dialog.attrs['bind:requestclose'], 'onDismissClear');
  assert.equal(dialog.attrs.open, '{{clearDialogOpen}}');
  assert.equal(dialog.attrs['bind:closed'], 'onClearDialogClosed');
  assert.equal(
    dialog.attrs['wx:if'],
    undefined,
    'mounted through closing acknowledgement',
  );
  const request = nodes.find(
    (node) => node.attrs['bind:press'] === 'onRequestClear',
  )!;
  assert.equal(
    request.attrs.disabled,
    '{{busy || !hasSession || historyOverlayLocked}}',
  );
  assert.match(source('browsing-history'), /本机 · 最近 30 天/);
  assert.match(
    source('browsing-history'),
    /最多保留 200 条已打开的帖子；退出登录会清除，不会跨设备同步/,
  );
  assert.match(source('browsing-history'), /不会删除帖子，也不会影响收藏/);
  assert.match(
    source('browsing-history', 'ts'),
    /url: '\/pages\/login\/login'/,
  );
});

test('each source keeps separate rows, pagination guards, and accessible metadata', () => {
  const list = flatten(tree('directory-list'));
  const published = list.find(
    (node) => node.attrs['bind:press'] === 'onEntry',
  )!;
  const managed = list.find(
    (node) => node.attrs['bind:press'] === 'onNativeEntry',
  )!;
  assert.equal(published.attrs['wx:for'], '{{entries}}');
  assert.equal(managed.attrs['wx:for'], '{{nativeDirectory.items}}');
  assert.match(
    published.attrs['aria-label']!,
    /directoryPlatformLabels\[item.platform\].*badge.status/,
  );
  assert.match(
    managed.attrs['aria-label']!,
    /directoryPlatformLabels\[item.data.platform\]/,
  );
  assert.equal(
    list.find((node) => node.attrs['bind:press'] === 'onNativeMore')!.attrs
      .disabled,
    '{{nativeDirectory.busy}}',
  );
  assert.equal(
    list.find((node) => node.attrs['bind:press'] === 'onNext')!.attrs.disabled,
    '{{busy || !canNext}}',
  );
  const history = flatten(tree('browsing-history')).find(
    (node) => node.attrs['bind:press'] === 'onOpen',
  )!;
  assert.match(history.attrs['aria-label']!, /item.summary.*item.viewedAt/);
  assert.match(source('directory-list'), /两个来源分别展示与翻页，不合并计数/);
  const resolveLabel = (
    node: PresentationNode,
    item: Record<string, unknown>,
  ) =>
    Function(
      'item',
      'directoryPlatformLabels',
      `return (${node.attrs['aria-label']!.slice(2, -2)});`,
    )(item, directoryPlatformLabels) as string;
  const publishedItem = {
    name: '示例阅读群',
    introPreview: '校园阅读交流',
    platform: 'wechat',
  };
  for (const [badge, suffix] of [
    [{ status: 'known', value: 'official' }, '，官方推广'],
    [{ status: 'known', value: 'partner' }, '，合作推广'],
    [{ status: 'known', value: 'normal' }, ''],
    [{ status: 'unavailable', value: null }, '，推广标记待确认'],
    [{ status: 'invalid', value: 'official' }, ''],
  ] as const)
    assert.equal(
      resolveLabel(published, { ...publishedItem, badge }),
      `示例阅读群，校园阅读交流，微信群${suffix}`,
    );
  assert.equal(
    resolveLabel(managed, {
      data: { name: '示例社团', introText: '合成简介', platform: 'qq' },
    }),
    '示例社团，合成简介，QQ 群',
  );
  assert.equal(
    resolveLabel(history, {
      summary: '已获授权的帖子摘要',
      viewedAt: '2026年10月20日',
    }),
    '已获授权的帖子摘要，2026年10月20日',
  );
  const campusEntry = flatten(tree('campus-tools')).find(
    (node) => node.attrs['bind:press'] === 'onOpen',
  )!;
  for (const [state, suffix] of [
    ['enabled', ''],
    ['disabled', '，已停用'],
    ['withdrawn', '，已撤回'],
  ])
    assert.equal(
      resolveLabel(campusEntry, {
        title: '示例校园地图',
        kind: 'map',
        state,
      }),
      `示例校园地图，浏览校园地点${suffix}`,
    );
});
