import assert from 'node:assert/strict';
import { normalizeFramework7ActionNode } from './framework7-action-parity';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { initialActivityView } from '../src/activities/controller';
import { initialActivityPreferenceView } from '../src/activities/preference';
import { initialActivityVisitView } from '../src/activities/visit-controller';
import { initialActivityPublicationView } from '../src/activities/publication/controller';
import {
  decodeActivityContent,
  decodeActivityDraft,
  decodeActivityOrganizer,
  decodeNativeActivity,
} from '../src/activities/publication/contract';
import {
  decodeActivityDetail,
  decodeActivitySummary,
} from '../src/activities/contract';
import {
  activityMediaSlot,
  activityMediaSlots,
} from '../src/activities/media-validation';
import {
  activityDisplayTimestamp,
  activityPublicationPresentation,
  activityTypeLabels,
  initialActivityPanels,
  toggledActivityPanels,
} from '../src/pages/activity-list/presentation';
import {
  activityHarness,
  activityId,
  regionId,
  flush,
} from './activity-helpers';
import { SessionStore } from '../src/auth/session';
import { wireCredentials } from './identity-helpers';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';

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
  'activity-list',
  'activity-detail',
  'activity-native',
  'activity-native-detail',
  'activity-publish',
];
const source = (page: string, ext = 'wxml') =>
  readFileSync(path.join(root, 'src/pages', page, `${page}.${ext}`), 'utf8');
const inventory = JSON.parse(
  readFileSync(
    path.join(__dirname, 'fixtures/activities-action-inventory.json'),
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
import {parsePreviewWxml} from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/preview-wxml.mjs')).href)};
import fixtures from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/fixtures/activities-preview.mjs')).href)};
const trees=Object.fromEntries(${JSON.stringify(pages)}.map(page=>[page,parsePreviewWxml(readFileSync(${JSON.stringify(path.join(root, 'src/pages'))}+'/'+page+'/'+page+'.wxml','utf8'))]));
console.log(JSON.stringify({trees,fixtures}));
`,
    ],
    { encoding: 'utf8', maxBuffer: 5_000_000 },
  ),
) as { trees: Record<string, Node>; fixtures: Fixture[] };
function actions(
  raw: Node,
  ancestors: Record<string, string>[] = [],
): Action[] {
  const normalized = normalizeFramework7ActionNode(raw);
  const node =
    normalized.attrs.bindtap === 'onDetail'
      ? { ...normalized, tag: 'view' }
      : normalized;
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
for (const [page, original] of Object.entries(inventory))
  test(`${page} preserves every original action, data binding, disabled state and ancestor guard`, () => {
    const current = actions(parsed.trees[page]!);
    for (const previous of original) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === previous.tag &&
          includes(candidate.attrs, previous.attrs) &&
          previous.scopes.every((scope) =>
            candidate.scopes.some((actual) => includes(actual, scope)),
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(previous));
      current.splice(index, 1);
    }
  });
function evaluate(value: string, scope: Record<string, unknown>): unknown {
  return Function(
    'scope',
    `with(scope){return (${value});}`,
  )(new Proxy(scope, { has: () => true }));
}
const resolve = (text: string, scope: Record<string, unknown>) =>
  text.replace(/{{([\s\S]*?)}}/g, (_, expression: string) =>
    String(evaluate(expression, scope) ?? ''),
  );
function visible(
  nodes: (Node | string)[],
  scope: Record<string, unknown>,
  rendered: Action[] = [],
): string {
  let result = '',
    matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      result += resolve(node, scope);
      continue;
    }
    const attrs = normalizeFramework7ActionNode(node).attrs;
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
          rendered,
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
      node.tag === 'navigator' ||
      Object.keys(attrs).some((key) => /^(bind|catch)/.test(key))
    )
      rendered.push({
        tag: node.tag,
        attrs: Object.fromEntries(
          Object.entries(attrs).map(([key, value]) => [
            key,
            resolve(value, scope),
          ]),
        ),
        scopes: [],
      });
    result += visible(node.children, scope, rendered);
  }
  return result;
}
const sample = (id: string) =>
  parsed.fixtures.find((fixture) => fixture.id === id)!;
function data(patch: Record<string, unknown> = {}) {
  return {
    ...initialActivityView(),
    ...initialActivityPublicationView(),
    ...activityPublicationPresentation(initialActivityPublicationView()),
    visit: initialActivityVisitView(),
    preference: initialActivityPreferenceView(),
    uiPanels: initialActivityPanels(),
    activityTypeLabels,
    activity: null,
    mine: false,
    more: false,
    image: { status: 'idle', src: '', message: '' },
    qr: { status: 'idle', src: '', message: '' },
    upload: { status: 'idle', message: '', progress: 0 },
    pendingImages: [],
    selectedSlot: 'cover',
    publishedAtLabel: '',
    endAtLabel: '',
    ...patch,
  };
}
function render(page: string, patch: Record<string, unknown> = {}) {
  const rendered: Action[] = [];
  return {
    text: visible(parsed.trees[page]!.children, data(patch), rendered),
    actions: rendered,
  };
}
for (const fixture of parsed.fixtures)
  test(`${fixture.id} renders populated markers without unresolved WXML or technical copy`, () => {
    assert.ok(fixture.expectedText.length > 0);
    const { text } = render(fixture.page, fixture.patch);
    for (const marker of fixture.expectedText)
      assert.ok(text.includes(marker), `${fixture.id}: ${marker}`);
    assert.doesNotMatch(
      text,
      /\{\{|undefined|NaN|ISO时间|原请求 [a-f0-9-]{36}|服务端核验|新版发布|匿名/,
    );
  });
test('synthetic preview content obeys the actual provider/native/draft/media contracts', () => {
  for (const fixture of parsed.fixtures) {
    const patch = fixture.patch;
    if (patch.activity) decodeNativeActivity(patch.activity);
    if (patch.detail) decodeActivityDetail(patch.detail);
    if (Array.isArray(patch.items))
      for (const item of patch.items)
        (fixture.page === 'activity-list'
          ? decodeActivitySummary
          : decodeNativeActivity)(item);
    if (patch.form) decodeActivityContent(patch.form);
    if (patch.draft) decodeActivityDraft(patch.draft);
    if (Array.isArray(patch.organizers))
      patch.organizers.forEach(decodeActivityOrganizer);
    if (Array.isArray(patch.slots))
      for (const slot of patch.slots) activityMediaSlot(slot.slot);
  }
});
test('page-local disclosures are bounded, prototype safe, immutable and initially closed', () => {
  const original = initialActivityPanels();
  assert.deepEqual(Object.keys(original), [
    'preferences',
    'information',
    'gallery',
    'options',
  ]);
  assert.ok(Object.values(original).every((v) => !v));
  for (const key of ['id', 'constructor', '__proto__', 'toString'])
    assert.equal(toggledActivityPanels(original, key), original);
  const next = toggledActivityPanels(original, 'gallery');
  assert.equal(next.gallery, true);
  assert.equal(original.gallery, false);
  assert.equal(toggledActivityPanels(next, 'gallery').gallery, false);
});
test('display helpers preserve content and timestamps without timezone or event-date invention', () => {
  assert.equal(
    activityDisplayTimestamp('2026-10-24T16:30:00+08:00'),
    '2026年10月24日 16:30（UTC+08:00）',
  );
  assert.equal(
    activityDisplayTimestamp('2026-10-24T08:30:00Z'),
    '2026年10月24日 08:30（UTC+00:00）',
  );
  assert.equal(activityDisplayTimestamp(null), '未指定');
  assert.equal(activityDisplayTimestamp('原样文本'), '原样文本');
  const view = initialActivityPublicationView();
  view.form = {
    ...view.form,
    title: '鲸🐋',
    description: '第一行\n第二行',
    types: ['offline', 'reward'],
  };
  const before = structuredClone(view);
  const result = activityPublicationPresentation(view);
  assert.equal(result.titleCount, 2);
  assert.equal(result.descriptionCount, 7);
  assert.deepEqual(result.typeSelected, {
    online: false,
    offline: true,
    reward: true,
  });
  assert.deepEqual(view, before);
  assert.doesNotMatch(
    source('activity-native'),
    /createdAt|Date\(|倒计时|即将开始|已结束|报名|参加人数/,
  );
  assert.doesNotMatch(source('activity-list'), /往期|已结束|报名/);
});
test('native QR remains unavailable unless the activity explicitly grants the public QR', () => {
  const patch = sample('activities-native-detail').patch;
  const activity = patch.activity as Record<string, unknown>;
  for (const status of ['disabled', 'unavailable']) {
    const rendered = render('activity-native-detail', {
      ...patch,
      activity: { ...activity, organizerQr: { status } },
      qr: {
        status: 'ready',
        src: 'PRIVATE_QR_CANARY',
        message: 'PRIVATE_MESSAGE',
      },
    });
    assert.ok(!rendered.actions.some((a) => a.attrs.bindtap === 'onQr'));
    assert.doesNotMatch(rendered.text, /PRIVATE_MESSAGE|查看主办方二维码/);
  }
  const absent = render('activity-native-detail', {
    ...patch,
    activity: null,
    qr: {
      status: 'ready',
      src: 'PRIVATE_QR_CANARY',
      message: 'PRIVATE_MESSAGE',
    },
  });
  assert.doesNotMatch(absent.text, /学生摄影社|PRIVATE_MESSAGE|把校园/);
  assert.equal(absent.actions.length, 0);
});
test('provider unavailable facts never become fake empty media, dates, locations or rewards', () => {
  const base = sample('activities-provider-detail').patch;
  const detail = base.detail as Record<string, unknown>;
  const { text } = render('activity-detail', {
    ...base,
    uiPanels: { ...initialActivityPanels(), information: true },
    detail: {
      ...detail,
      activityTime: null,
      activityLocation: null,
      reward: { status: 'unavailable', value: null },
      gallery: { status: 'unavailable', items: null },
      organizerQr: { status: 'unavailable' },
    },
  });
  for (const marker of [
    '时间待确认',
    '地点待确认',
    '奖励信息待确认',
    '尚不能确认是否有图片',
    '主办方二维码暂不可用',
  ])
    assert.ok(text.includes(marker));
  assert.doesNotMatch(text, /无奖励|未提供介绍图片|未提供主办方二维码/);
  assert.doesNotMatch(
    render('activity-detail', { ...base, loaded: false }).text,
    /周五晚上的露天电影|学生活动中心前草坪/,
  );
});
test('pending publication freezes editable fields and keeps the exact recovery actions reachable', () => {
  const patch = sample('activities-publish-recovery').patch;
  const { actions: shown, text } = render('activity-publish', {
    ...patch,
    uiPanels: { ...initialActivityPanels(), options: true, gallery: true },
  });
  for (const handler of ['onRecover', 'onRetry', 'onCancelOriginal'])
    assert.ok(
      shown.some((a) => a.attrs.bindtap === handler),
      handler,
    );
  const edits = [
    'onField',
    'onType',
    'onQr',
    'onUpload',
    'onPreview',
    'onRemove',
    'onSave',
    'onPublish',
    'onDiscardDraft',
  ];
  for (const action of shown.filter((a) =>
    edits.includes(
      a.attrs.bindtap ?? a.attrs.bindinput ?? a.attrs.bindchange ?? '',
    ),
  ))
    assert.equal(action.attrs.disabled, 'true', JSON.stringify(action));
  assert.doesNotMatch(text, /00000050|111111111111/);
});
test('publication media slots stay complete but untouched optional image controls are initially hidden', () => {
  const patch = sample('activities-publish-draft').patch;
  const collapsed = render('activity-publish', patch);
  assert.equal(
    collapsed.actions.filter((a) => a.attrs.bindtap === 'onUpload').length,
    2,
  );
  const expanded = render('activity-publish', {
    ...patch,
    uiPanels: { ...initialActivityPanels(), gallery: true, options: true },
  });
  assert.deepEqual(
    expanded.actions
      .filter((a) => a.attrs.bindtap === 'onUpload')
      .map((a) => a.attrs['data-slot']),
    [...activityMediaSlots],
  );
  assert.ok(expanded.actions.some((a) => a.attrs.bindtap === 'onDiscardDraft'));
  const published = render(
    'activity-publish',
    sample('activities-publish-success').patch,
  );
  assert.ok(published.actions.some((a) => a.attrs.bindtap === 'onPublished'));
  assert.ok(
    !published.actions.some((a) =>
      ['onField', 'onPublish', 'onSave', 'onUpload', 'onDiscardDraft'].includes(
        a.attrs.bindtap ?? a.attrs.bindinput ?? '',
      ),
    ),
  );
});
for (const page of pages)
  test(`${page} uses native local icons and scoped semantic styles, without fake content or backend additions`, () => {
    assert.match(source(page), /class="f7-ios-theme activity-page/);
    assert.doesNotMatch(
      source(page),
      /class="card"|class="notice"|class="title"|<script|https?:\/\//,
    );
    assert.match(source(page, 'wxss'), /product\.wxss/);
    assert.equal(
      JSON.parse(source(page, 'json')).usingComponents['wu-icon'],
      '../../components/icon/icon',
    );
    assert.doesNotMatch(
      source(page, 'ts'),
      /requestPayment|makePhoneCall|setClipboardData|requestSubscribeMessage/,
    );
  });

type NativePage = {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, done?: () => void): void;
  [key: string]: unknown;
};
const invoke = (page: NativePage, method: string, ...args: unknown[]) =>
  (page[method] as (...values: unknown[]) => unknown).apply(page, args);
const event = (field: string) => ({ currentTarget: { dataset: { field } } });
function pageHarness(app: unknown) {
  const require = createRequire(__filename);
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    getApp: globals.getApp,
    wx: globals.wx,
  };
  let current: NativePage | undefined;
  const pages: NativePage[] = [];
  globals.Page = (definition: NativePage) => {
    current = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch, done) {
        Object.assign(this.data, patch);
        done?.();
      },
    };
    pages.push(current);
  };
  globals.getApp = () => app;
  globals.wx = {
    getStorageSync: () => undefined,
    setStorageSync: () => undefined,
    removeStorageSync: () => undefined,
  };
  return {
    load(name: string) {
      const file = path.join(root, 'src/pages', name, `${name}.ts`);
      delete require.cache[require.resolve(file)];
      require(file);
      assert.ok(current);
      return current;
    },
    close() {
      for (const page of pages) invoke(page, 'onUnload');
      Object.assign(globals, previous);
    },
  };
}
test('provider presentation disclosures do not read, navigate or mutate and close on hide/reopen', async () => {
  const h = activityHarness('detail');
  const scope = pageHarness({ community: h.runtime });
  try {
    const page = scope.load('activity-detail');
    invoke(page, 'onLoad', { regionId, activityId });
    invoke(page, 'onShow');
    await flush();
    assert.equal(page.data.loaded, true);
    const before = h.calls.length;
    invoke(page, 'onTogglePanel', event('information'));
    invoke(page, 'onTogglePanel', event('preferences'));
    assert.equal(h.calls.length, before);
    invoke(page, 'onHide');
    assert.deepEqual(page.data.uiPanels, initialActivityPanels());
    assert.equal(page.data.publishedAtLabel, '');
    invoke(page, 'onShow');
    await flush();
    assert.deepEqual(page.data.uiPanels, initialActivityPanels());
    assert.equal(h.calls.filter((c) => c.method === 'visit').length, 0);
  } finally {
    scope.close();
    h.controller.dispose();
    h.visits.dispose();
  }
});
test('native detail retries only reads and clears media and panels on campus/account invalidation', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const changes = new PrivateViewLifecycle();
  const activity = sample('activities-native-detail').patch.activity as Record<
    string,
    unknown
  >;
  const reads: string[] = [];
  const media: unknown[] = [];
  let disposed = 0;
  const app = {
    identity: {
      sessions,
      api: {
        request: async (route: {
          path: string;
          method: string;
          decode: (value: unknown) => unknown;
        }) => {
          assert.equal(route.method, 'GET');
          reads.push(route.path);
          return route.decode(activity);
        },
      },
    },
    community: { directoryScopeChanges: changes },
    activityMedia: {
      createReader: (render: (view: unknown) => void) => ({
        load: async (target: unknown) => {
          media.push(target);
          render({ status: 'ready', src: 'local-synthetic', message: '' });
        },
        dispose: () => {
          disposed++;
        },
      }),
    },
    organizationMedia: {
      createReader: () => ({
        load: async (target: unknown) => {
          media.push(target);
        },
        dispose: () => {
          disposed++;
        },
      }),
    },
  };
  const scope = pageHarness(app);
  try {
    const page = scope.load('activity-native-detail');
    invoke(page, 'onLoad', { id: activity.id });
    await invoke(page, 'onShow');
    assert.equal(page.data.loaded, true);
    assert.equal(reads.length, 1);
    invoke(page, 'onTogglePanel', event('information'));
    invoke(page, 'onImage', {
      currentTarget: { dataset: { slot: 'gallery0' } },
    });
    assert.equal(page.data.selectedSlot, 'gallery0');
    invoke(page, 'onQr');
    assert.equal(media.length, 3);
    changes.clear();
    assert.equal(page.data.activity, null);
    assert.deepEqual(page.data.uiPanels, initialActivityPanels());
    assert.deepEqual(page.data.image, { status: 'idle', src: '', message: '' });
    assert.equal(page.data.selectedSlot, 'cover');
    assert.equal(page.data.endAtLabel, '');
    assert.ok(disposed >= 2);
    invoke(page, 'onRefresh');
    await flush();
    assert.equal(reads.length, 2);
    invoke(page, 'onTogglePanel', event('information'));
    sessions.logout();
    assert.equal(page.data.activity, null);
    assert.deepEqual(page.data.uiPanels, initialActivityPanels());
    assert.equal(page.data.publishedAtLabel, '');
  } finally {
    scope.close();
  }
});
test('publish option toggles never call commands, and teardown clears transient state and presentation counts', () => {
  const scope = pageHarness({});
  try {
    const page = scope.load('activity-publish');
    let commands = 0;
    page.controller = {
      dispose: () => undefined,
      setField: () => {
        commands++;
      },
      publish: () => {
        commands++;
      },
    };
    invoke(page, 'onTogglePanel', event('options'));
    invoke(page, 'onTogglePanel', event('gallery'));
    invoke(page, 'onTogglePanel', event('__proto__'));
    assert.equal(commands, 0);
    page.setData({
      titleCount: 40,
      descriptionCount: 200,
      typeSelected: { online: true, offline: true, reward: true },
    });
    invoke(page, 'onHide');
    assert.deepEqual(page.data.uiPanels, initialActivityPanels());
    assert.equal(page.data.titleCount, 0);
    assert.equal(page.data.descriptionCount, 0);
    assert.deepEqual(page.data.typeSelected, {
      online: false,
      offline: false,
      reward: false,
    });
  } finally {
    scope.close();
  }
});
