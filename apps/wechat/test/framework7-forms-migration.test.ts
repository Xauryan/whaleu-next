import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import { assertReviewedHomeReadableSuccessor } from './reviewed-home-readable-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { ClientError } from '../src/api/errors';
import {
  ProfileController,
  initialProfileView,
  type ProfileView,
} from '../src/pages/profile/controller';
import type { PreferenceKey } from '../src/profile/contract';
import type { SearchController } from '../src/pages/community-search/controller';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import { searchHarness, searchPage } from './search-helpers';
import { FakeProfileGateway } from './profile-helpers';
import { wireCredentials } from './identity-helpers';
import { deferred, flush } from './helpers';

const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as {
  parsePreviewWxml(source: string): PresentationNode;
};
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, extension = 'wxml') =>
  read(`src/pages/${page}/${page}.${extension}`);
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const guards = [
  'wx:if',
  'wx:elif',
  'wx:else',
  'wx:for',
  'wx:for-item',
  'wx:for-index',
  'wx:key',
];
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
const before = JSON.parse(
  read('test/fixtures/framework7-forms-before-actions.json'),
) as Record<string, Baseline>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-forms-before-protected.json'),
) as Record<string, string>;
const subset = (
  actual: Record<string, string>,
  expected: Record<string, string>,
) => Object.entries(expected).every(([key, value]) => actual[key] === value);
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
  const own = Object.fromEntries(
    Object.entries(node.attrs).filter(([key]) => guards.includes(key)),
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
for (const [page, baseline] of Object.entries(before)) {
  test(`${page}: all original actions preserve datasets, native constraints and exact ordered guard ancestry`, () => {
    const current = actions(parse(source(page)));
    assert.equal(current.length, baseline.actions.length);
    for (const original of baseline.actions) {
      // The native switch color becomes the pinned F7 theme token; no logical
      // attribute is discarded. Source classes stay in this exact inventory.
      const attrs = { ...original.attrs };
      if (original.tag === 'switch') delete attrs.color;
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === original.tag &&
          subset(candidate.attrs, attrs) &&
          JSON.stringify(candidate.scopes) === JSON.stringify(original.scopes),
      );
      assert.notEqual(index, -1, `${page}: ${JSON.stringify(original)}`);
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    if (
      !assertReviewedHomeReadableSuccessor(
        `src/pages/${page}/${page}.ts`,
        baseline.typescriptSha256,
      )
    )
      assert.equal(
        hash(source(page, 'ts')),
        baseline.typescriptSha256,
        'Page handlers and lifecycle are byte-identical',
      );
  });
  test(`${page}: registered native F7 components contain no provider data, DOM or nested actionable slots`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-block'));
    assert.ok(nodes.some((node) => node.tag === 'wu-f7-button'));
    assert.ok(
      !nodes.some((node) => ['button', 'input', 'switch'].includes(node.tag)),
      'all in-scope plain controls use the native component boundary',
    );
    for (const node of nodes.filter((item) => item.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
    }
    for (const item of nodes.filter((node) => node.tag === 'wu-f7-list-item')) {
      assert.ok(
        !flatten(item)
          .slice(1)
          .some((node) =>
            [
              'button',
              'input',
              'switch',
              'navigator',
              'wu-f7-button',
              'wu-f7-toggle',
              'wu-f7-input',
              'wu-f7-searchbar',
            ].includes(node.tag),
          ),
      );
      if (item.attrs['bind:press']) assert.equal(item.attrs.link, '{{true}}');
    }
    assert.doesNotMatch(
      source(page),
      /<web-view|<script|https?:\/\/|data:image|rich-text/,
    );
    assert.match(source(page, 'wxss'), /framework7-forms\.wxss/);
  });
}
test('accepted pages, global styling, controllers, gateways and media readers remain byte-identical except explicit reviewed business successors', () => {
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
test('search submission and settings owner state retain their deliberate native boundaries', () => {
  const search = flatten(parse(source('community-search')));
  const input = search.find((node) => node.tag === 'wu-f7-searchbar')!;
  assert.deepEqual(input.attrs, {
    value: '{{inputDraft}}',
    placeholder: '搜索主题、回复',
    maxlength: '400',
    'bind:input': 'onInput',
    'bind:confirm': 'onSubmit',
    clearable: '{{false}}',
    'aria-label': '搜索主题、回复',
  });
  assert.match(
    read('src/components/f7-searchbar/f7-searchbar.wxml'),
    /confirm-type="search"/,
  );
  assert.equal(
    search.find((node) => node.tag === 'scroll-view')!.attrs['scroll-x'],
    '{{true}}',
  );
  assert.match(source('community-search'), /inputDraft !== submittedQuery/);
  assert.match(source('community-search'), /每次翻页重新核验可查看内容/);
  const settings = flatten(parse(source('settings')));
  const toggle = settings.find((node) => node.tag === 'wu-f7-toggle')!;
  assert.equal(toggle.attrs.checked, '{{item.checked}}');
  assert.equal(toggle.attrs.disabled, '{{loading || saving || needsReload}}');
  assert.equal(toggle.attrs['data-key'], '{{item.key}}');
  assert.equal(toggle.attrs['bind:change'], 'onPreference');
  assert.equal(toggle.attrs.label, '{{item.label}}');
  assert.ok(
    !settings.some((node) => node.tag === 'label'),
    'the real switch label lives inside the native component, not across its boundary',
  );
});

interface ComponentInstance {
  [name: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(update: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type ComponentMethod = (this: ComponentInstance, event?: unknown) => unknown;
interface ComponentDefinition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, ComponentMethod>;
  lifetimes?: Record<string, ComponentMethod>;
  pageLifetimes?: Record<string, ComponentMethod>;
}
function registration<T>(kind: 'Component' | 'Page', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[kind];
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
function component(
  name: string,
  properties: Record<string, unknown>,
  onEvent: (name: string, detail: unknown) => void,
) {
  const definition = registration<ComponentDefinition>(
    'Component',
    `components/${name}/${name}.ts`,
  );
  const instance: ComponentInstance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, schema]) => [
          key,
          structuredClone(schema.value),
        ]),
      ),
      ...properties,
    },
    data: structuredClone(definition.data),
    setData(update) {
      Object.assign(this.data, update);
    },
    triggerEvent(name, detail, options) {
      assert.deepEqual(options, { bubbles: false, composed: false });
      onEvent(name, detail);
    },
  };
  for (const [name, method] of Object.entries(definition.methods))
    instance[name] = method.bind(instance);
  definition.lifetimes?.attached?.call(instance);
  return {
    instance,
    call: (name: string, event?: unknown) =>
      definition.methods[name]!.call(instance, event),
    hide: () => definition.pageLifetimes?.hide?.call(instance),
    detach: () => definition.lifetimes?.detached?.call(instance),
  };
}
interface SearchOwner {
  controller: SearchController;
  onInput(event: { detail: { value: string } }): void;
  onSubmit(): void;
  onAggregateScope(event: {
    currentTarget: { dataset: { scope: string } };
  }): void;
}
test('actual Searchbar input and confirm payloads feed original handlers without implicit search, IME rewriting, stale-owner results or exposure', async () => {
  const harness = searchHarness();
  const owner = {
    ...registration<SearchOwner>(
      'Page',
      'pages/community-search/community-search.ts',
    ),
    controller: harness.controller,
  };
  const editor = component(
    'f7-searchbar',
    { maxlength: 400, clearable: false },
    (name, detail) => {
      if (name === 'input')
        owner.onInput({ detail: detail as { value: string } });
      else if (name === 'confirm') owner.onSubmit();
      else assert.fail(`Unexpected page event ${name}`);
    },
  );
  try {
    await harness.controller.load({ scope: 'all' });
    for (const value of ['z', '中文', '  中文检索  ']) {
      assert.equal(
        editor.call('onInput', {
          detail: { value, cursor: value.length, keyCode: 229 },
        }),
        undefined,
      );
      assert.equal(harness.view().inputDraft, value);
      assert.equal(harness.calls.length, 0);
      assert.equal(harness.view().submittedQuery, '');
    }
    editor.call('onConfirm', { detail: { value: '  中文检索  ' } });
    await flush();
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.view().submittedQuery, '中文检索');
    editor.call('onInput', { detail: { value: '未提交候选', keyCode: 229 } });
    owner.onAggregateScope({
      currentTarget: { dataset: { scope: 'regional' } },
    });
    await flush();
    assert.equal(harness.calls[harness.calls.length - 1]![0].q, '中文检索');
    assert.equal(harness.view().inputDraft, '未提交候选');
    const pending = deferred<ReturnType<typeof searchPage>>();
    harness.behavior.search = async () => pending.promise;
    editor.call('onConfirm', { detail: { value: '未提交候选' } });
    await flush();
    harness.sessions.completeLogin(harness.sessions.beginLogin(), {
      ...wireCredentials('z'),
      accountId: '99999999-9999-4999-8999-999999999999',
    });
    pending.resolve(searchPage());
    await flush();
    assert.equal(harness.view().inputDraft, '');
    assert.equal(harness.view().submittedQuery, '');
    assert.deepEqual(harness.view().hits, []);
    const count = harness.calls.length;
    editor.hide();
    editor.call('onInput', { detail: { value: 'late hidden input' } });
    editor.call('onConfirm', { detail: { value: 'late hidden input' } });
    await flush();
    assert.equal(harness.calls.length, count);
    assert.equal(harness.storage.data.size, 0);
  } finally {
    editor.detach();
    harness.controller.dispose();
  }
});
interface SettingsOwner {
  controller: ProfileController;
  onPreference(event: {
    detail: { value: boolean };
    currentTarget: { dataset: { key: PreferenceKey } };
  }): void;
  onCancelEdits(): void;
}
test('actual Toggle change payload updates only the current owner draft, retains conflict locking and cannot write across accounts', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeProfileGateway();
  let view: ProfileView = initialProfileView();
  const controller = new ProfileController(sessions, gateway, (next) => {
    view = next;
  });
  const owner = {
    ...registration<SettingsOwner>('Page', 'pages/settings/settings.ts'),
    controller,
  };
  let events = 0;
  const toggle = component('f7-toggle', { checked: true }, (name, detail) => {
    assert.equal(name, 'change');
    events++;
    owner.onPreference({
      detail: detail as { value: boolean },
      currentTarget: { dataset: { key: 'showHotTopic' } },
    });
  });
  try {
    await controller.load();
    toggle.call('onChange', { detail: { value: false } });
    assert.equal(events, 1);
    assert.equal(
      view.preferences.find((item) => item.key === 'showHotTopic')!.checked,
      false,
    );
    assert.equal(view.preferencesDirty, true);
    assert.equal(
      gateway.current.preferences.showHotTopic,
      true,
      'proposal is not a server save',
    );
    assert.equal(
      toggle.instance.properties.checked,
      true,
      'component does not commit owner state',
    );
    assert.equal(toggle.instance.data.nativeChecked, true);
    assert.equal(
      gateway.calls.filter((call) => call.method === 'preferences').length,
      0,
    );
    owner.onCancelEdits();
    assert.equal(view.preferencesDirty, false);
    toggle.call('onChange', { detail: { value: false } });
    gateway.preferencesImpl = async () => {
      throw new ClientError('business', 'safe', {
        httpStatus: 409,
        serverCode: 'PROFILE_REVISION_CONFLICT',
      });
    };
    await controller.savePreferences();
    assert.equal(view.needsReload, true);
    toggle.instance.properties.disabled = true;
    const priorEvents = events;
    toggle.call('onChange', { detail: { value: false } });
    assert.equal(events, priorEvents);
    assert.equal(view.preferencesDirty, true);
    sessions.completeLogin(sessions.beginLogin(), {
      ...wireCredentials('z'),
      accountId: '99999999-9999-4999-8999-999999999999',
    });
    assert.deepEqual(view.preferences, []);
    assert.equal(view.preferencesDirty, false);
    toggle.instance.properties.disabled = false;
    toggle.call('onChange', { detail: { value: false } });
    assert.deepEqual(
      view.preferences,
      [],
      'stale UI proposal is rejected until current owner reloads',
    );
    toggle.hide();
    const beforeHidden = events;
    toggle.call('onChange', { detail: { value: false } });
    assert.equal(events, beforeHidden);
  } finally {
    toggle.detach();
    controller.dispose();
  }
});

test('synthetic source-preview fixtures cover exactly four pages and all critical pending/recovery boundaries', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-forms-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(fixtures.length, 21);
  assert.deepEqual(
    [...new Set(fixtures.map((fixture) => fixture.page))].sort(),
    Object.keys(before).sort(),
  );
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^framework7-forms-/);
    assert.ok(fixture.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accessToken|refreshToken|accountId|providerId|wxfile:\/\//,
    );
  }
  for (const condition of [
    'needsReload',
    'saving',
    'preferencesDirty',
    'copyBusy',
  ])
    assert.ok(fixtures.some((fixture) => fixture.patch[condition] === true));
  assert.ok(
    fixtures.some((fixture) => fixture.patch.continuation === 'scan_pending'),
  );
  assert.ok(fixtures.some((fixture) => fixture.patch.hasSession === false));
});

function binding(
  page: string,
  handler: string,
  scope: Record<string, unknown>,
  field?: string,
) {
  const node = flatten(parse(source(page))).find(
    (item) =>
      item.attrs['bind:press'] === handler &&
      (!field || item.attrs['data-field'] === field),
  )!;
  assert.ok(node, `${page}: ${handler}`);
  const evaluate = (raw: string) =>
    raw.startsWith('{{') && raw.endsWith('}}')
      ? (Function(
          'scope',
          `with(scope){return (${raw.slice(2, -2)});}`,
        )(scope) as unknown)
      : raw;
  const dataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [
        key
          .slice(5)
          .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        evaluate(value),
      ]),
  );
  return {
    node,
    dataset,
    properties: Object.fromEntries(
      ['disabled', 'loading', 'link']
        .filter((key) => key in node.attrs)
        .map((key) => [key, evaluate(node.attrs[key]!)]),
    ),
  };
}

test('school-service native buttons preserve actual datasets, revalidate copy revision and keep QR targets inside current controller scope', async () => {
  const { SchoolServicesController, initialSchoolServicesView } =
    await import('../src/school-configuration/public-controller.js');
  const { publicSchoolEntryKeys } =
    await import('../src/school-configuration/contract.js');
  type Gateway =
    import('../src/school-configuration/gateway').SchoolConfigurationGateway;
  type PublicView =
    import('../src/school-configuration/contract').SchoolPublicView;
  type QrTarget = NonNullable<
    ReturnType<InstanceType<typeof SchoolServicesController>['previewContext']>
  >;
  const campus = '33333333-3333-4333-8333-333333333333';
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let revision = 1;
  const result = (): PublicView => ({
    context: {
      campusId: campus,
      campusName: '合成校园',
      region: { id: '55555555-5555-4555-8555-555555555555', name: '合成地区' },
    },
    entries: publicSchoolEntryKeys.map((entryKey) => ({
      entryKey,
      revision: entryKey === 'admin' ? revision : 0,
      state: entryKey === 'admin' ? 'configured' : 'unconfigured',
      data:
        entryKey === 'admin'
          ? { kind: 'admin', enabled: true, wechatId: 'synthetic_admin' }
          : null,
      qrcode: { status: entryKey === 'admin' ? 'configured' : 'none' },
    })),
  });
  const forbidden = async (): Promise<never> => {
    throw new Error('No mutation/provider permitted');
  };
  const gateway: Gateway = {
    public: async () => result(),
    capabilities: forbidden,
    management: forbidden,
    save: forbidden,
    recover: forbidden,
    cancel: forbidden,
  };
  const copied: string[] = [],
    previews: QrTarget[] = [];
  let current = initialSchoolServicesView();
  const controller = new SchoolServicesController(
    sessions,
    gateway,
    undefined,
    {
      set: async (value) => {
        copied.push(value);
      },
    },
    (view) => {
      current = view;
    },
  );
  interface Owner {
    controller: InstanceType<typeof SchoolServicesController>;
    reader: { load(target: QrTarget): Promise<void>; clear(): void };
    setData(update: object): void;
    onCopy(event: {
      detail: unknown;
      currentTarget: { dataset: Record<string, unknown> };
    }): void;
    onPreview(event: {
      detail: unknown;
      currentTarget: { dataset: Record<string, unknown> };
    }): void;
    onCloseQr(): void;
  }
  let clears = 0;
  const owner = {
    ...registration<Owner>('Page', 'pages/school-services/school-services.ts'),
    controller,
    reader: {
      load: async (target: QrTarget) => {
        previews.push(target);
      },
      clear: () => {
        clears++;
      },
    },
    setData() {},
  };
  const press = (handler: 'onCopy' | 'onPreview', field?: string) => {
    const bound = binding(
      'school-services',
      handler,
      {
        ...current,
        item: current.entries.find((entry) => entry.entryKey === 'admin'),
      },
      field,
    );
    const button = component(
      bound.node.tag.slice(3),
      bound.properties,
      (name, detail) => {
        assert.equal(name, 'press');
        assert.deepEqual(detail, {});
        owner[handler]({ detail, currentTarget: { dataset: bound.dataset } });
      },
    );
    button.call('onPress');
  };
  try {
    await controller.load(campus);
    press('onCopy', 'wechatId');
    await flush();
    assert.deepEqual(copied, ['synthetic_admin']);
    press('onPreview');
    await flush();
    assert.deepEqual(previews, [
      { campusId: campus, entryKey: 'admin', entryRevision: 1 },
    ]);
    owner.onCloseQr();
    assert.equal(clears, 1);
    revision = 2;
    press('onCopy', 'wechatId');
    await flush();
    assert.deepEqual(
      copied,
      ['synthetic_admin'],
      'changed revision cannot silently copy stale contact',
    );
    sessions.logout();
    assert.deepEqual(current.entries, []);
    owner.onPreview({
      detail: {},
      currentTarget: { dataset: { key: 'admin' } },
    });
    assert.equal(
      previews.length,
      1,
      'old QR cannot be reopened after owner invalidation',
    );
  } finally {
    controller.dispose();
  }
});

test('directory native copy keeps its current-owner clipboard fence and managed image action forwards slot rather than display data', async () => {
  const { directoryHarness, directoryDetailRoute } =
    await import('./directory-helpers.js');
  const harness = directoryHarness('detail');
  interface Owner {
    controller: typeof harness.controller;
    onCopyQq(): void;
    onNativePreview(event: {
      detail: unknown;
      currentTarget: { dataset: Record<string, unknown> };
    }): void;
    managedController: { previewTarget(slot: unknown): unknown };
    managedReader: { load(target: unknown): Promise<void> };
  }
  const original = registration<Owner>(
    'Page',
    'pages/directory-detail/directory-detail.ts',
  );
  const copied: string[] = [];
  const globals = globalThis as unknown as { wx?: unknown };
  const priorWx = globals.wx;
  globals.wx = {
    setClipboardData: ({
      data,
      success,
    }: {
      data: string;
      success(): void;
    }) => {
      copied.push(data);
      success();
    },
  };
  const owner = { ...original, controller: harness.controller };
  try {
    await harness.controller.load(directoryDetailRoute);
    const bound = binding('directory-detail', 'onCopyQq', {
      ...harness.view(),
    });
    const button = component('f7-button', bound.properties, (name, detail) => {
      assert.equal(name, 'press');
      assert.deepEqual(detail, {});
      owner.onCopyQq();
    });
    button.call('onPress');
    await flush();
    assert.deepEqual(copied, ['0012345678901234']);
    button.call('onPress');
    harness.sessions.logout();
    await flush();
    assert.equal(
      copied.length,
      1,
      'same-turn logout fences pending clipboard dispatch',
    );
    assert.equal(harness.view().canCopy, false);
    const slots: unknown[] = [],
      loaded: unknown[] = [];
    owner.managedController = {
      previewTarget(slot) {
        slots.push(slot);
        return { syntheticTarget: true, slot };
      },
    };
    owner.managedReader = {
      load: async (target) => {
        loaded.push(target);
      },
    };
    const media = binding('directory-detail', 'onNativePreview', {
      item: { slot: 'mainQr', label: '入群二维码' },
    });
    const row = component('f7-list-item', media.properties, (name, detail) => {
      assert.equal(name, 'press');
      owner.onNativePreview({
        detail,
        currentTarget: { dataset: media.dataset },
      });
    });
    row.call('onPress');
    assert.deepEqual(slots, ['mainQr']);
    assert.deepEqual(loaded, [{ syntheticTarget: true, slot: 'mainQr' }]);
    assert.throws(() =>
      owner.onNativePreview({
        detail: {},
        currentTarget: { dataset: { slot: 'unreviewed-image-url' } },
      }),
    );
    assert.equal(loaded.length, 1);
  } finally {
    globals.wx = priorWx;
    harness.controller.dispose();
  }
});
