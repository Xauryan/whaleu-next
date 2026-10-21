import { assertReviewedNativeHarnessSuccessor } from './reviewed-native-harness-successor';
import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  activityCommandHash,
  emptyActivityContent,
  type ActivityCommand,
  type ActivityDraft,
  type ActivityReceipt,
  type NativeActivity,
} from '../src/activities/publication/contract';
import {
  activityHarness,
  activityId,
  regionId,
  page as providerPage,
  detail as providerDetail,
  deferred,
  flush,
} from './activity-helpers';
import { wireCredentials } from './identity-helpers';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const pages = [
  'activity-list',
  'activity-detail',
  'activity-native',
  'activity-native-detail',
  'activity-publish',
];
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const model = requireNative('../scripts/smoke-ratings.mjs') as {
  parse(source: string): PresentationNode;
  render(
    nodes: (PresentationNode | string)[],
    scope: unknown,
    templates: Record<string, PresentationNode>,
  ): PresentationNode[];
};
const flatten = (n: PresentationNode): PresentationNode[] => [
  n,
  ...n.children.flatMap((c) => (typeof c === 'string' ? [] : flatten(c))),
];
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const normalized = normalizeFramework7ActionNode(raw);
  // Only the pre-existing native catalog's whole-card view changes primitive.
  const n =
    normalized.attrs.bindtap === 'onDetail'
      ? { ...normalized, tag: 'view' }
      : normalized;
  const own = Object.fromEntries(
    Object.entries(n.attrs).filter(([k]) =>
      [
        'wx:if',
        'wx:elif',
        'wx:else',
        'wx:for',
        'wx:for-item',
        'wx:for-index',
        'wx:key',
        'hidden',
        'disabled',
        'loading',
      ].includes(k),
    ),
  );
  const scopes = Object.keys(own).length ? [...parents, own] : parents;
  return [
    ...(n.tag === 'navigator' ||
    Object.keys(n.attrs).some((k) => /^(bind|catch)/.test(k))
      ? [{ tag: n.tag, attrs: n.attrs, scopes }]
      : []),
    ...n.children.flatMap((c) =>
      typeof c === 'string' ? [] : actions(c, scopes),
    ),
  ];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-activities-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-activities-before-protected.json'),
) as Record<string, string>;
for (const [file, before] of Object.entries(baseline))
  test(`${file}: original handlers, datasets, constraints, disabled/loading and ancestor gates`, () => {
    const current = actions(parse(read(file)));
    assert.equal(current.length, before.actions.length);
    for (const old of before.actions) {
      const index = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(([k, v]) => next.attrs[k] === v),
      );
      assert.notEqual(index, -1, JSON.stringify(old));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
  });
test('73 protected sources remain exact; original shared-harness hash retained as separately owned evidence', () => {
  assert.equal(Object.keys(protectedFiles).length, 74);
  for (const [file, hash] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  )) {
    // Integrator granted personal worker a shared XML text-entity fix after this
    // inventory was sealed. Preserve that original hash, never silently replace it.
    if (file === 'test/native-press-emitted-harness.mjs') {
      const approved = JSON.parse(
        read('test/fixtures/framework7-activities-reviewed-shared.json'),
      ) as { beforeSha256: string; afterSha256: string };
      assert.equal(hash, approved.beforeSha256);
      if (!assertReviewedNativeHarnessSuccessor(file, approved.afterSha256))
        assert.equal(
          createHash('sha256').update(read(file)).digest('hex'),
          approved.afterSha256,
          file,
        );
      continue;
    }
    assert.equal(
      createHash('sha256').update(read(file)).digest('hex'),
      hash,
      file,
    );
  }
});
for (const page of pages)
  test(`${page}: real registered native components, no DOM or permission proxy`, () => {
    const nodes = flatten(parse(source(page)));
    const components = (
      JSON.parse(source(page, 'json')) as {
        usingComponents: Record<string, string>;
      }
    ).usingComponents;
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-button'));
    assert.ok(nodes.some((n) => n.tag === 'wu-f7-block'));
    for (const n of nodes.filter((n) => n.tag.startsWith('wu-f7-'))) {
      const kind = n.tag.slice(3);
      assert.equal(components[n.tag], `../../components/${kind}/${kind}`);
      assert.equal(n.attrs['open-type'], undefined);
      if (n.tag === 'wu-f7-list-item')
        assert.ok(
          flatten(n)
            .slice(1)
            .every(
              (child) =>
                !Object.keys(child.attrs).some((k) =>
                  /^(bind|catch)/.test(k),
                ) && !['input', 'button', 'navigator'].includes(child.tag),
            ),
        );
    }
    assert.ok(
      !nodes.some((n) =>
        /^(button|input|switch|web-view|rich-text|wu-f7-sheet|wu-f7-dialog|wu-f7-actions)$/.test(
          n.tag,
        ),
      ),
    );
    assert.match(source(page, 'wxss'), /framework7-product\.wxss/);
    assert.doesNotMatch(
      source(page),
      /https?:\/\/|data:image|报名人数|报名成功/,
    );
  });
interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>, callback?: () => void): void;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { type: unknown; value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
interface Capture {
  press(): boolean;
  detach(): void;
  lifecycle(name: string): void;
}
interface Bridge {
  capture(handler: string, dataset?: Record<string, unknown>): Capture;
  find(
    handler: string,
    dataset?: Record<string, unknown>,
  ): PresentationNode | undefined;
  lifecycle(name: string): void;
  emissions: Array<{
    type: string;
    detail: unknown;
    currentTarget: { dataset: Record<string, unknown> };
  }>;
}
const { createNativePressBridge } = requireNative(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: {
    page: Owner;
    pageFile: string;
    dist: string;
    extension: 'ts';
  }): Bridge;
};
function registration<T>(kind: 'Page' | 'Component', file: string): T {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = globals[kind];
  let value: T | undefined;
  globals[kind] = (definition: T) => {
    value = definition;
  };
  try {
    const target = requireNative.resolve(path.join(root, 'src', file));
    delete requireNative.cache[target];
    requireNative(target);
  } finally {
    globals[kind] = previous;
  }
  assert.ok(value);
  return value;
}
const invoke = (target: Owner, name: string, event?: unknown) =>
  (target[name] as (event?: unknown) => unknown).call(target, event);
async function settle() {
  for (let i = 0; i < 12; i++) await flush();
}
function mount(
  page: string,
  app: unknown,
  query: unknown = {},
  storage = new Map<string, unknown>(),
) {
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp },
    navigation: string[] = [];
  globals.wx = {
    getStorageSync: (k: string) => storage.get(k),
    setStorageSync: (k: string, v: unknown) =>
      storage.set(k, structuredClone(v)),
    removeStorageSync: (k: string) => storage.delete(k),
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigation.push(url);
      success?.();
    },
  };
  globals.getApp = () => app;
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  const target: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(patch, callback) {
      Object.assign(this.data, patch);
      callback?.();
    },
  };
  invoke(target, 'onLoad', query);
  invoke(target, 'onShow');
  const bridge = createNativePressBridge({
    page: target,
    pageFile: path.join(root, `src/pages/${page}/${page}`),
    dist: path.join(root, 'src'),
    extension: 'ts',
  });
  return {
    target,
    bridge,
    navigation,
    storage,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const c = bridge.capture(handler, dataset);
      const result = c.press();
      c.detach();
      return result;
    },
    hide() {
      bridge.lifecycle('hide');
      invoke(target, 'onHide');
    },
    close() {
      bridge.lifecycle('detach');
      invoke(target, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
function control(target: Owner, page: string, handler: string, field?: string) {
  const node = model
    .render(model.parse(source(page)).children, target.data, {})
    .flatMap(flatten)
    .find(
      (n) =>
        ['wu-f7-input', 'wu-f7-toggle'].includes(n.tag) &&
        Object.values(n.attrs).includes(handler) &&
        (field === undefined || n.attrs['data-field'] === field),
    );
  assert.ok(node);
  const kind = node.tag.slice(3),
    definition = registration<Definition>(
      'Component',
      `components/${kind}/${kind}.ts`,
    );
  const properties = Object.fromEntries(
    Object.entries(definition.properties).map(([key, p]) => {
      const raw =
        node.attrs[key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)];
      return [
        key,
        raw === undefined
          ? structuredClone(p.value)
          : p.type === Boolean
            ? raw === 'true'
            : p.type === Number
              ? Number(raw)
              : raw,
      ];
    }),
  );
  let emissions = 0;
  const instance: Instance = {
    properties,
    data: structuredClone(definition.data),
    ...definition.methods,
    setData(patch) {
      Object.assign(this.data, patch);
    },
    triggerEvent(name, detail, options) {
      assert.deepEqual(options, { bubbles: false, composed: false });
      emissions++;
      invoke(target, node.attrs[`bind:${name}`]!, {
        detail,
        currentTarget: { dataset: field ? { field } : {} },
      });
    },
  };
  definition.lifetimes!.attached!.call(instance);
  return {
    properties,
    input(value: string) {
      definition.methods.onInput!.call(instance, {
        detail: { value, cursor: value.length },
      });
    },
    change(value: boolean) {
      definition.methods.onChange!.call(instance, { detail: { value } });
    },
    hide() {
      definition.pageLifetimes!.hide!.call(instance);
    },
    detach() {
      definition.lifetimes!.detached!.call(instance);
    },
    emissions: () => emissions,
  };
}
function body(target: Owner, value: string) {
  const n = model
    .render(model.parse(source('activity-publish')).children, target.data, {})
    .flatMap(flatten)
    .find((n) => n.tag === 'textarea' && n.attrs.bindinput === 'onField');
  assert.ok(n);
  assert.equal(n.attrs.maxlength, '1000');
  assert.notEqual(n.attrs.disabled, 'true');
  invoke(target, 'onField', {
    currentTarget: { dataset: { field: 'description' } },
    detail: { value },
  });
}
function nativeHarness() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const actor = sessions.snapshot().credentials!.accountId,
    organizationId = '44444444-4444-4444-8444-444444444444',
    assetId = '55555555-5555-4555-8555-555555555555';
  const scope = new PrivateViewLifecycle(),
    privateViews = new PrivateViewLifecycle();
  let draft: ActivityDraft = {
    source: 'native',
    id: activityId,
    regionId,
    organization: { source: 'managed', organizationId },
    organizationRevision: 2,
    revision: 2,
    state: 'draft',
    content: {
      ...emptyActivityContent(),
      title: '  合成活动🐋  ',
      description: '原文\n保留',
      types: ['online'],
    },
    mediaBindings: { cover: assetId, gallery0: organizationId },
  };
  let activity: NativeActivity = {
    source: 'native',
    id: activityId,
    regionId,
    revision: 2,
    organization: draft.organization,
    organizerLabel: '合成组织',
    content: { ...draft.content, showOrganizerQr: true },
    mediaBindings: draft.mediaBindings,
    createdAt: '2026-10-20T08:30:00+08:00',
    organizerQr: {
      status: 'available',
      organizationId,
      applicationRevision: 2,
      slot: 'mainQr',
      bindingId: assetId,
    },
  };
  const commands: ActivityCommand[] = [],
    requests: Array<{
      path: string;
      method: string;
      body?: unknown;
      query?: unknown;
    }> = [],
    media: Array<{ method: string; target: unknown }> = [];
  const pendingImages = [{ activityId, revision: 2, slot: 'gallery1' }];
  const receipt = (c: ActivityCommand): ActivityReceipt => ({
    requestId: c.clientRequestId,
    requestHash: activityCommandHash(actor, activityId, c),
    activityId,
    revision:
      c.action === 'create'
        ? 1
        : c.expectedRevision + (c.action === 'save' ? 1 : 0),
    outcome:
      c.action === 'create'
        ? 'created'
        : c.action === 'save'
          ? 'saved'
          : c.action === 'cancel_draft'
            ? 'draft_cancelled'
            : 'published',
  });
  const apply = (c: ActivityCommand) => {
    if (c.action === 'save' || c.action === 'create')
      draft = { ...draft, content: c.content, revision: receipt(c).revision };
    else if (c.action === 'publish') draft = { ...draft, state: 'published' };
    return receipt(c);
  };
  const behavior = {
    command: async (c: ActivityCommand): Promise<unknown> => apply(c),
    recover: async (key: string): Promise<unknown> => ({
      state: 'not_recorded',
      requestId: key,
    }),
    cancel: async (key: string, hash: string): Promise<unknown> => ({
      state: 'cancelled',
      requestId: key,
      requestHash: hash,
    }),
    list: async (): Promise<unknown> => ({
      source: 'native',
      regionId,
      items: [activity],
      nextCursor: null,
    }),
    detail: async (): Promise<unknown> => activity,
    pick: async (): Promise<string | null> => assetId,
  };
  const api = {
    request: async (
      spec: {
        path: string;
        method: string;
        authentication: string;
        authReplay: string;
        decode: (v: unknown) => unknown;
      },
      options: { body?: unknown; query?: unknown } = {},
    ) => {
      assert.equal(spec.authentication, 'required');
      requests.push({ path: spec.path, method: spec.method, ...options });
      let result: unknown;
      if (spec.path.endsWith('/organizers'))
        result = {
          regionId,
          items: [
            {
              source: 'managed',
              organizationId,
              revision: 2,
              name: '合成组织',
              kind: 'org',
              role: 'organization_owner',
            },
          ],
          nextCursor: null,
        };
      else if (spec.path.endsWith('/commands')) {
        assert.equal(spec.authReplay, 'never');
        const c = structuredClone(options.body) as ActivityCommand;
        commands.push(c);
        result = await behavior.command(c);
      } else if (
        spec.path.includes('/requests/') &&
        spec.path.endsWith('/cancel')
      )
        result = await behavior.cancel(
          spec.path.split('/').slice(-2)[0]!,
          (options.body as { requestHash: string }).requestHash,
        );
      else if (spec.path.includes('/requests/'))
        result = await behavior.recover(spec.path.split('/').slice(-1)[0]!);
      else if (spec.path.includes('/drafts/')) result = structuredClone(draft);
      else if (spec.path.endsWith('/mine') || spec.path.endsWith('/catalog'))
        result = await behavior.list();
      else if (spec.path.includes('/activities/'))
        result = await behavior.detail();
      else throw Error(spec.path);
      return spec.decode(result);
    },
  };
  const reader = (kind: string, render: (v: unknown) => void) => ({
    load: async (target: unknown) => {
      media.push({ method: kind, target });
      render({ status: 'ready', src: 'synthetic-local-only', message: '' });
    },
    clear: () => render({ status: 'idle', src: '', message: '' }),
    dispose: () => media.push({ method: kind + '-dispose', target: null }),
  });
  const app = {
    identity: { sessions, api },
    community: {
      sessions,
      newRequestId: async () => activityId,
      privateViews,
      directoryScopeChanges: scope,
    },
    activityMedia: {
      createReader: (render: (v: unknown) => void) =>
        reader('activity-read', render),
      createUploader: () => ({
        pick: async (target: unknown) => {
          media.push({ method: 'pick', target });
          return behavior.pick();
        },
        recover: async (target: unknown) => {
          media.push({ method: 'recover', target });
          return assetId;
        },
        cancelPending: async (target: unknown) => {
          media.push({ method: 'cancel', target });
        },
        dispose: () => media.push({ method: 'uploader-dispose', target: null }),
      }),
      pendingTargets: () => pendingImages,
      reconcile: async () => undefined,
    },
    organizationMedia: {
      createReader: (render: (v: unknown) => void) => reader('qr-read', render),
    },
  };
  return {
    app,
    sessions,
    scope,
    privateViews,
    actor,
    organizationId,
    assetId,
    commands,
    requests,
    media,
    pendingImages,
    behavior,
    receipt,
    apply,
    get draft() {
      return draft;
    },
    set draft(value) {
      draft = value;
    },
    get activity() {
      return activity;
    },
    set activity(value) {
      activity = value;
    },
  };
}
test('actual provider Button → Page → controller retains routes, pagination, visit acknowledgement and cancel fence', async () => {
  const h = activityHarness();
  h.controller.dispose();
  h.visits.dispose();
  h.behavior.list = async (_region, window, cursor) =>
    providerPage({
      selection:
        window === 'all'
          ? { kind: 'all' }
          : { kind: 'historical', maximum: 10 },
      pageCursor: cursor ?? Buffer.alloc(32, 1).toString('base64url'),
      continuation:
        cursor === Buffer.alloc(32, 2).toString('base64url') ? 'end' : 'more',
      nextCursor:
        cursor === Buffer.alloc(32, 2).toString('base64url')
          ? null
          : Buffer.alloc(32, 2).toString('base64url'),
    });
  const f = mount('activity-list', { community: h.runtime });
  try {
    await settle();
    assert.equal(f.target.data.loaded, true);
    assert.equal(h.calls.filter((c) => c.method === 'visit').length, 1);
    assert.equal(f.press('onActivity', { id: activityId }), true);
    assert.match(
      f.navigation[0]!,
      new RegExp(`activity-detail.*${activityId}`),
    );
    f.press('onNext');
    await settle();
    assert.equal(f.target.data.pageNumber, 2);
    f.press('onPrevious');
    await settle();
    assert.equal(f.target.data.pageNumber, 1);
    f.press('onAll');
    await settle();
    assert.equal(f.target.data.window, 'all');
    const wait = deferred<ReturnType<typeof providerPage>>();
    h.behavior.list = () => wait.promise;
    f.press('onRefresh');
    await settle();
    assert.equal(f.target.data.busy, true);
    const before = h.calls.length;
    assert.equal(f.press('onRefresh'), false);
    assert.equal(f.bridge.find('onActivity', { id: activityId }), undefined);
    assert.equal(h.calls.length, before);
    assert.equal(f.press('onCancel'), true);
    wait.resolve(providerPage());
    await settle();
    assert.equal(f.target.data.busy, false);
    const stale = f.bridge.capture('onNative');
    f.hide();
    assert.equal(stale.press(), false);
  } finally {
    f.close();
  }
});
test('actual provider Toggle → Page → profile owner saves only a preference, preserves lost-result reload and hide suppression', async () => {
  const h = activityHarness();
  h.controller.dispose();
  h.visits.dispose();
  const f = mount('activity-list', { community: h.runtime });
  try {
    await settle();
    f.press('onTogglePanel', { field: 'preferences' });
    const before = f.target.data.preference as { checked: boolean };
    const toggle = control(f.target, 'activity-list', 'onPreference');
    toggle.change(!before.checked);
    assert.equal((f.target.data.preference as { dirty: boolean }).dirty, true);
    toggle.detach();
    assert.equal(f.press('onPreferenceSave'), true);
    await settle();
    assert.equal((f.target.data.preference as { dirty: boolean }).dirty, false);
    const hidden = control(f.target, 'activity-list', 'onPreference');
    hidden.hide();
    hidden.change(before.checked);
    assert.equal(hidden.emissions(), 0);
    hidden.detach();
    f.target.setData({
      preference: {
        ...(f.target.data.preference as object),
        needsReload: true,
        dirty: true,
      },
    });
    assert.equal(f.bridge.find('onPreferenceSave'), undefined);
    const blocked = control(f.target, 'activity-list', 'onPreference');
    blocked.change(before.checked);
    assert.equal(blocked.emissions(), 0);
    blocked.detach();
    assert.match(source('activity-list'), /目前仅保存偏好，暂不发送提醒/);
  } finally {
    f.close();
  }
});
test('actual provider detail preserves unavailable facts and source timestamps, does not acknowledge a list visit', async () => {
  const h = activityHarness('detail');
  h.controller.dispose();
  h.visits.dispose();
  h.behavior.detail = async () =>
    providerDetail({
      createdAt: { status: 'known', value: '2026-10-20T08:30:00+08:00' },
    });
  const f = mount(
    'activity-detail',
    { community: h.runtime },
    { regionId, activityId },
  );
  try {
    await settle();
    assert.equal(f.target.data.loaded, true);
    f.press('onTogglePanel', { field: 'information' });
    assert.equal(
      f.target.data.publishedAtLabel,
      '2026年10月20日 08:30（UTC+08:00）',
    );
    assert.equal(h.calls.filter((c) => c.method === 'visit').length, 0);
    assert.equal(
      (f.target.data.detail as { gallery: { status: string } }).gallery.status,
      'unavailable',
    );
    const stale = f.bridge.capture('onRefresh');
    f.hide();
    assert.equal(stale.press(), false);
    assert.equal(f.target.data.publishedAtLabel, '');
  } finally {
    f.close();
  }
});
test('actual native ListItem → Page → gateway preserves mine scope, cursor and current row identity', async () => {
  const h = nativeHarness();
  let count = 0;
  h.behavior.list = async () => ({
    source: 'native',
    regionId,
    items: [{ ...h.activity, id: count++ ? regionId : activityId }],
    nextCursor: count === 1 ? Buffer.alloc(32, 2).toString('base64url') : null,
  });
  const f = mount('activity-native', h.app, { mode: 'mine' });
  try {
    await settle();
    assert.ok(h.requests[0]!.path.endsWith('/mine'));
    assert.equal(f.press('onDetail', { id: activityId }), true);
    assert.equal(
      f.navigation[0],
      `/pages/activity-native-detail/activity-native-detail?id=${activityId}`,
    );
    assert.equal(f.press('onMore'), true);
    await settle();
    assert.deepEqual(h.requests[1]!.query, {
      cursor: Buffer.alloc(32, 2).toString('base64url'),
    });
    assert.equal((f.target.data.items as unknown[]).length, 2);
    const stale = f.bridge.capture('onDetail', { id: activityId });
    h.scope.clear();
    assert.equal(stale.press(), false);
    assert.deepEqual(f.target.data.items, []);
  } finally {
    f.close();
  }
});
test('actual media/QR Buttons keep public reader targets, original source timezone, authorization and account/hide clearing', async () => {
  const h = nativeHarness(),
    f = mount('activity-native-detail', h.app, { id: activityId });
  try {
    await settle();
    assert.deepEqual(h.media[0], {
      method: 'activity-read',
      target: { activityId, revision: 2, slot: 'cover', audience: 'public' },
    });
    f.press('onImage', { slot: 'gallery0' });
    await settle();
    assert.equal(f.target.data.selectedSlot, 'gallery0');
    assert.deepEqual(h.media[1]!.target, {
      activityId,
      revision: 2,
      slot: 'gallery0',
      audience: 'public',
    });
    f.press('onQr');
    await settle();
    assert.deepEqual(h.media[2]!.target, {
      organizationId: h.organizationId,
      applicationRevision: 2,
      slot: 'mainQr',
      audience: 'public',
    });
    assert.equal(
      f.target.data.publishedAtLabel,
      '2026年10月20日 08:30（UTC+08:00）',
    );
    assert.equal(f.target.data.endAtLabel, '未指定');
    const stale = f.bridge.capture('onQr');
    h.sessions.logout();
    assert.equal(stale.press(), false);
    assert.equal(f.target.data.activity, null);
    assert.deepEqual(f.target.data.image, {
      status: 'idle',
      src: '',
      message: '',
    });
  } finally {
    f.close();
  }
});
for (const status of ['unavailable', 'disabled'] as const)
  test(`native ${status} QR never exposes an authorization action or stale QR content`, async () => {
    const h = nativeHarness();
    h.activity = {
      ...h.activity,
      content: {
        ...h.activity.content,
        showOrganizerQr: status !== 'disabled',
      },
      organizerQr: { status },
    };
    const f = mount('activity-native-detail', h.app, { id: activityId });
    try {
      await settle();
      assert.equal(f.bridge.find('onQr'), undefined);
      invoke(f.target, 'onQr');
      assert.equal(h.media.filter((m) => m.method === 'qr-read').length, 0);
    } finally {
      f.close();
    }
  });
test('actual Input/Toggle/Button → publication Page → controller/gateway preserves raw fields, limits, organization authority and independent flags', async () => {
  const h = nativeHarness(),
    f = mount('activity-publish', h.app);
  try {
    await settle();
    assert.equal(f.press('onCreate'), false);
    assert.equal(h.commands.length, 0);
    f.press('onOrganizer', { id: h.organizationId });
    const title = control(f.target, 'activity-publish', 'onField', 'title');
    assert.equal(title.properties.maxlength, 50);
    title.input('  合成标题🐋  ');
    title.detach();
    body(f.target, '  第一行\n原文 <b>不解析</b>  ');
    for (const type of ['online', 'offline', 'reward'])
      f.press('onType', { type });
    assert.deepEqual((f.target.data.form as { types: string[] }).types, [
      'online',
      'offline',
      'reward',
    ]);
    const time = control(
      f.target,
      'activity-publish',
      'onField',
      'activityTime',
    );
    assert.equal(time.properties.maxlength, 200);
    time.input('  时间由主办方填写  ');
    time.detach();
    f.press('onTogglePanel', { field: 'options' });
    const end = control(f.target, 'activity-publish', 'onField', 'endAt');
    assert.equal(end.properties.maxlength, 140);
    end.input('2026-12-01T18:00:00+08:00');
    end.detach();
    const qr = control(f.target, 'activity-publish', 'onQr');
    qr.change(true);
    qr.detach();
    f.press('onCreate');
    await settle();
    assert.equal(h.commands.length, 1);
    const command = h.commands[0]!;
    assert.equal(command.action, 'create');
    if (command.action !== 'create') throw Error('create');
    assert.equal(command.organizationRevision, 2);
    assert.equal(command.organization.organizationId, h.organizationId);
    assert.equal(command.content.title, '  合成标题🐋  ');
    assert.equal(command.content.description, '  第一行\n原文 <b>不解析</b>  ');
    assert.equal(command.content.activityTime, '  时间由主办方填写  ');
    assert.equal(command.content.showOrganizerQr, true);
    assert.equal(command.content.endAt, '2026-12-01T18:00:00+08:00');
  } finally {
    f.close();
  }
});
test('actual publication Buttons freeze uncertain command, suppress duplicate edits and replay exactly the original through recovery', async () => {
  const h = nativeHarness();
  h.behavior.command = async () => {
    throw new ClientError('network', 'Synthetic lost response');
  };
  const f = mount('activity-publish', h.app, { id: activityId });
  try {
    await settle();
    const duplicate = f.bridge.capture('onPublish');
    assert.equal(f.press('onPublish'), true);
    assert.equal(duplicate.press(), false);
    await settle();
    assert.equal(h.commands.length, 1);
    assert.equal(f.target.data.pending, true);
    const original = structuredClone(h.commands[0]!);
    const title = control(f.target, 'activity-publish', 'onField', 'title');
    title.input('cannot replace');
    assert.equal(title.emissions(), 0);
    title.detach();
    assert.equal(f.press('onType', { type: 'offline' }), false);
    assert.equal(f.press('onSave'), false);
    assert.equal(f.press('onUpload', { slot: 'cover' }), false);
    h.behavior.recover = async (key) => ({
      state: 'pending',
      requestId: key,
      requestHash: activityCommandHash(h.actor, activityId, original),
      review: 'ready',
    });
    h.behavior.command = async (c) => h.apply(c);
    assert.equal(f.press('onRecover'), true);
    await settle();
    assert.deepEqual(h.commands, [original, original]);
    assert.equal(f.target.data.pending, false);
    assert.equal((f.target.data.draft as ActivityDraft).state, 'published');
    assert.equal(f.bridge.find('onField'), undefined);
    assert.equal(f.bridge.find('onPublish'), undefined);
    f.press('onPublished');
    assert.equal(
      f.navigation[0],
      `/pages/activity-native-detail/activity-native-detail?id=${activityId}`,
    );
  } finally {
    f.close();
  }
});
test('actual original-request cancellation retains request hash and returns only after matching cancellation', async () => {
  const h = nativeHarness();
  h.behavior.command = async () => {
    throw new ClientError('network', 'Synthetic lost response');
  };
  const f = mount('activity-publish', h.app, { id: activityId });
  try {
    await settle();
    f.press('onPublish');
    await settle();
    const original = structuredClone(h.commands[0]!);
    f.press('onCancelOriginal');
    await settle();
    const cancellation = h.requests.find((r) => r.path.endsWith('/cancel'))!;
    assert.ok(cancellation.path.includes(original.clientRequestId));
    assert.deepEqual(cancellation.body, {
      requestHash: activityCommandHash(h.actor, activityId, original),
    });
    assert.equal(h.commands.length, 1);
    assert.equal(f.target.data.pending, false);
    assert.equal((f.target.data.draft as ActivityDraft).state, 'draft');
  } finally {
    f.close();
  }
});
test('actual native media Buttons preserve draft revision/audience, pending image identity and hide discard of a late selection', async () => {
  const h = nativeHarness(),
    f = mount('activity-publish', h.app, { id: activityId });
  try {
    await settle();
    f.press('onPreview', { slot: 'cover' });
    await settle();
    assert.deepEqual(
      h.media.find((m) => m.method === 'activity-read')!.target,
      { activityId, revision: 2, slot: 'cover', audience: 'management' },
    );
    f.press('onPendingImage', {
      slot: 'gallery1',
      revision: 2,
      action: 'recover',
    });
    await settle();
    assert.deepEqual(h.media.find((m) => m.method === 'recover')!.target, {
      activityId,
      revision: 2,
      slot: 'gallery1',
    });
    assert.equal(
      typeof f.bridge.emissions.find(
        (e) => e.currentTarget.dataset.action === 'recover',
      )!.currentTarget.dataset.revision,
      'number',
    );
    assert.equal(f.target.data.dirty, true);
    assert.equal(f.press('onPublish'), false);
    f.press('onPendingImage', {
      slot: 'gallery1',
      revision: 2,
      action: 'cancel',
    });
    await settle();
    assert.deepEqual(h.media.find((m) => m.method === 'cancel')!.target, {
      activityId,
      revision: 2,
      slot: 'gallery1',
    });
    const wait = deferred<string | null>();
    h.behavior.pick = () => wait.promise;
    f.press('onUpload', { slot: 'cover' });
    await settle();
    assert.deepEqual(h.media.find((m) => m.method === 'pick')!.target, {
      activityId,
      revision: 2,
      slot: 'cover',
    });
    f.hide();
    wait.resolve(h.assetId);
    await settle();
    assert.equal(f.target.data.dirty, false);
    assert.equal(f.target.data.id, '');
    assert.equal(h.commands.length, 0);
  } finally {
    f.close();
  }
});
test('actual discard draft Button preserves destructive tone and CAS without creating an unrelated publication', async () => {
  const h = nativeHarness(),
    f = mount('activity-publish', h.app, { id: activityId });
  try {
    await settle();
    assert.equal(f.bridge.find('onDiscardDraft'), undefined);
    f.press('onTogglePanel', { field: 'options' });
    assert.equal(f.bridge.find('onDiscardDraft')!.attrs.tone, 'danger');
    f.press('onDiscardDraft');
    await settle();
    assert.equal(h.commands.length, 1);
    assert.equal(h.commands[0]!.action, 'cancel_draft');
    assert.equal(h.commands[0]!.expectedRevision, 2);
    assert.equal(f.target.data.id, '');
    assert.equal(f.target.data.pending, false);
  } finally {
    f.close();
  }
});
test('hidden or account-replaced publication cannot deliver captured save or media actions', async () => {
  const h = nativeHarness(),
    f = mount('activity-publish', h.app, { id: activityId });
  try {
    await settle();
    const stale = f.bridge.capture('onSave');
    h.sessions.logout();
    await settle();
    assert.equal(stale.press(), false);
    assert.equal(f.target.data.id, '');
    assert.equal(h.commands.length, 0);
    const input = control(f.target, 'activity-publish', 'onField', 'title');
    input.hide();
    input.input('hidden');
    assert.equal(input.emissions(), 0);
    input.detach();
  } finally {
    f.close();
  }
});

test('32 fictional activity fixtures expand actual registered component WXML and slots without invoking business actions', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-activities-preview.mjs',
  ) as {
    default: Array<{
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }>;
  };
  const { nativeComponentPreviewState } = requireNative(
    '../scripts/preview-native-component.mjs',
  ) as {
    nativeComponentPreviewState(
      definition: Definition,
      attrs: Record<string, string>,
      evaluate: (value: string) => string,
    ): Record<string, unknown>;
  };
  assert.equal(fixtures.length, 32);
  assert.equal(
    new Set(fixtures.map((fixture) => fixture.id)).size,
    fixtures.length,
  );
  const definitions = new Map<string, Definition>();
  const templates: Record<string, PresentationNode> = {};
  function text(
    nodes: (PresentationNode | string)[],
    slots: Record<string, (PresentationNode | string)[]> = {},
  ): string {
    return nodes
      .map((node) => {
        if (typeof node === 'string') return node;
        if (node.tag === 'slot')
          return text(slots[node.attrs.name ?? 'default'] ?? []);
        if (node.tag.startsWith('wu-f7-')) {
          const kind = node.tag.slice(3);
          if (!definitions.has(kind))
            definitions.set(
              kind,
              registration<Definition>(
                'Component',
                `components/${kind}/${kind}.ts`,
              ),
            );
          const data = nativeComponentPreviewState(
            definitions.get(kind)!,
            node.attrs,
            (value) => value,
          );
          const componentSlots: Record<string, (PresentationNode | string)[]> =
            {};
          for (const child of node.children) {
            const name =
              typeof child === 'string'
                ? 'default'
                : (child.attrs.slot ?? 'default');
            (componentSlots[name] ??= []).push(child);
          }
          return text(
            model.render(
              model.parse(read(`src/components/${kind}/${kind}.wxml`)).children,
              data,
              {},
            ),
            componentSlots,
          );
        }
        return text(node.children, slots);
      })
      .join(' ');
  }
  for (const fixture of fixtures) {
    assert.ok(pages.includes(fixture.page));
    const definition = registration<Owner>(
      'Page',
      `pages/${fixture.page}/${fixture.page}.ts`,
    );
    const projection = text(
      model.render(
        model.parse(source(fixture.page)).children,
        { ...definition.data, ...fixture.patch },
        templates,
      ),
    ).replace(/\s+/g, ' ');
    for (const expected of fixture.expectedText)
      assert.ok(projection.includes(expected), `${fixture.id}: ${expected}`);
    assert.doesNotMatch(projection, /undefined|\[object Object\]/, fixture.id);
  }
});

test('existing activity gateway/render/ack/preference smoke follows actual Component delivery in source mode', async () => {
  const h = activityHarness();
  h.controller.dispose();
  h.visits.dispose();
  const globals = globalThis as unknown as Record<string, unknown>,
    previous = { wx: globals.wx, getApp: globals.getApp };
  const app = { community: h.runtime, identity: { sessions: h.sessions } };
  globals.wx = {};
  globals.getApp = () => app;
  try {
    const { smokeActivities } = requireNative(
      '../scripts/smoke-activities.mjs',
    ) as {
      smokeActivities(options: {
        app: unknown;
        dist: string;
        flush: () => Promise<void>;
        extension: 'ts';
      }): Promise<void>;
    };
    await smokeActivities({
      app,
      dist: path.join(root, 'src'),
      flush: settle,
      extension: 'ts',
    });
  } finally {
    globals.wx = previous.wx;
    globals.getApp = previous.getApp;
  }
});
