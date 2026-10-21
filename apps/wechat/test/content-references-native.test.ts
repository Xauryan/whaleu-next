import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { SafetyChanges } from '../src/community/safety-changes';
import { Cancellation, type HttpRequest } from '../src/platform/contracts';
import type { WxApi } from '../src/platform/wechat';
import {
  ContentReferenceController,
  initialReferenceView,
  type ReferencePress,
  type ReferenceRow,
} from '../src/content-references/controller';
import {
  decodeReferenceCapability,
  decodeReferenceDestination,
  decodeReferenceLookup,
  referenceDestinationPath,
  type ReferenceDestination,
} from '../src/content-references/contract';
import {
  HttpContentReferencesGateway,
  type ContentReferencesGateway,
} from '../src/content-references/gateway';
import { detailReferenceRows } from '../src/content-references/detail-rows';
import { initialDetailView } from '../src/pages/community-detail/controller';
import { post, comment } from './community-helpers';
import { credentials, deferred, flush, response, signedIn } from './helpers';
const postId = '11111111-1111-4111-8111-111111111111';
const rootId = '22222222-2222-4222-8222-222222222222';
const replyId = '33333333-3333-4333-8333-333333333333';
const scopeId = '44444444-4444-4444-8444-444444444444';
const row: ReferenceRow = {
  kind: 'post',
  targetId: postId,
  text: '甲 #1234567\n乙',
};
const destination: ReferenceDestination = {
  kind: 'reply',
  postId,
  rootCommentId: rootId,
  replyId,
};
function setup(
  overrides: Partial<ContentReferencesGateway> = {},
  scope?: string,
  allowedToNavigate?: () => boolean,
) {
  const sessions = signedIn();
  const privateViews = new PrivateViewLifecycle(),
    browsingScopeChanges = new PrivateViewLifecycle();
  const safetyChanges = new SafetyChanges(privateViews);
  const calls: Parameters<NonNullable<WxApi['navigateTo']>>[0][] = [];
  const lookups: unknown[] = [],
    resolves: unknown[] = [];
  const gateway: ContentReferencesGateway = {
    capability: async () => ({ available: true }),
    lookup: async (targets, _cancel, scope) => {
      lookups.push({ targets, scope });
      return { items: [{ kind: 'post', targetId: postId, code: '10000000' }] };
    },
    resolve: async (code, _cancel, scope) => {
      resolves.push({ code, scope });
      return { ...destination, ...(scope ? { viewSpaceId: scope } : {}) };
    },
    ...overrides,
  };
  let view = initialReferenceView();
  const controller = new ContentReferenceController(
    { sessions, privateViews, browsingScopeChanges, safetyChanges },
    gateway,
    { navigateTo: (options) => calls.push(options) },
    (value) => {
      view = value;
    },
    scope,
    allowedToNavigate,
  );
  return {
    sessions,
    privateViews,
    browsingScopeChanges,
    safetyChanges,
    calls,
    lookups,
    resolves,
    controller,
    view: () => view,
    event: (): ReferencePress => ({
      rowKey: `post:${postId}`,
      generation: view.generation,
      code: '1234567',
      start: 2,
    }),
  };
}
test('strict capability/destination/lookup decoders reject unknown private fields and malformed identities', () => {
  assert.deepEqual(decodeReferenceCapability({ available: false }), {
    available: false,
  });
  for (const value of [
    { available: 'true' },
    { available: 1 },
    {},
    { available: true, enabled: true },
  ])
    assert.throws(() => decodeReferenceCapability(value));
  for (const value of [
    { ...destination, body: 'private' },
    { kind: 'post', postId, replyId },
    { ...destination, rootCommentId: '' },
    { ...destination, viewSpaceId: null },
    { kind: 'reply', postId, replyId },
  ])
    assert.throws(() => decodeReferenceDestination(value));
  for (const items of [
    [{ kind: 'post', targetId: postId, code: '01234567' }],
    [{ kind: 'post', targetId: postId, code: '1234567', authorId: rootId }],
    Array(31).fill({ kind: 'post', targetId: postId, code: '1234567' }),
    [
      { kind: 'post', targetId: postId, code: '1234567' },
      { kind: 'reply', targetId: replyId, code: '1234567' },
    ],
  ])
    assert.throws(() => decodeReferenceLookup({ items }));
});
test('route preserves exact post/root/reply/scope UUIDs, never chooses kind by numeric width or a cursor', () => {
  assert.equal(
    referenceDestinationPath({ ...destination, viewSpaceId: scopeId }),
    `/pages/community-detail/community-detail?postId=${postId}&rootCommentId=${rootId}&replyId=${replyId}&viewSpaceId=${scopeId}`,
  );
  assert.equal(
    referenceDestinationPath({
      kind: 'comment',
      postId,
      rootCommentId: rootId,
    }),
    `/pages/community-detail/community-detail?postId=${postId}&rootCommentId=${rootId}`,
  );
  assert.equal(
    referenceDestinationPath({ kind: 'post', postId }),
    `/pages/community-detail/community-detail?postId=${postId}`,
  );
});
test('real API gateway uses authenticated exact read contracts and rejects scope/unrequested lookup mismatch', async () => {
  const sessions = signedIn();
  const requests: HttpRequest[] = [];
  let body: unknown = { available: true },
    status = 200;
  const api = new ApiClient(
    'https://api.example.test',
    {
      send: async (request) => {
        requests.push(request);
        return response(body, status);
      },
    },
    sessions,
    { refresh: async () => sessions.snapshot() },
  );
  const gateway = new HttpContentReferencesGateway(api),
    cancel = new Cancellation();
  await gateway.capability(cancel);
  assert.equal(requests[0]!.method, 'GET');
  assert.match(requests[0]!.url, /content-references\/capability$/);
  assert.ok(requests[0]!.headers.Authorization);
  body = { ...destination, viewSpaceId: scopeId };
  await gateway.resolve('1234567', cancel, scopeId);
  assert.deepEqual(requests[1]!.body, {
    code: '1234567',
    viewSpaceId: scopeId,
  });
  assert.equal(requests[1]!.method, 'POST');
  body = { items: [{ kind: 'post', targetId: postId, code: '10000000' }] };
  await gateway.lookup([{ kind: 'post', targetId: postId }], cancel, scopeId);
  assert.deepEqual(requests[2]!.body, {
    targets: [{ kind: 'post', targetId: postId }],
    viewSpaceId: scopeId,
  });
  await assert.rejects(
    gateway.lookup([{ kind: 'reply', targetId: replyId }], cancel),
  );
  body = destination;
  await assert.rejects(gateway.resolve('1234567', cancel, scopeId));
  body = { available: true };
  status = 201;
  await assert.rejects(gateway.capability(cancel));
  const count = requests.length;
  await assert.rejects(gateway.lookup([], cancel));
  await assert.rejects(
    gateway.lookup(Array(31).fill({ kind: 'post', targetId: postId }), cancel),
  );
  await assert.rejects(gateway.resolve('1234567890', cancel));
  assert.equal(requests.length, count);
});
test('default/offline/invalid capability remains plain with no lookup, code or resolve', async () => {
  for (const capability of [
    async () => ({ available: false }),
    async () => {
      throw new Error('offline');
    },
    async () => ({ available: 'true' }) as never,
  ]) {
    const s = setup({ capability });
    s.controller.reconcile([row], 1);
    await flush();
    assert.equal(s.view().available, false);
    assert.deepEqual(s.view().codes, {});
    await s.controller.open(s.event());
    assert.equal(s.lookups.length, 0);
    assert.equal(s.resolves.length, 0);
    s.controller.dispose();
  }
});
test('canonical lookup is optional and bounded to one parent, never offscreen cumulative children', async () => {
  const s = setup();
  s.controller.reconcile(
    [
      row,
      ...Array.from({ length: 100 }, (_, index) => ({
        kind: 'reply' as const,
        targetId: replyId,
        text: String(index),
      })),
    ],
    1,
  );
  await flush();
  assert.deepEqual(s.lookups, [
    { targets: [{ kind: 'post', targetId: postId }], scope: undefined },
  ]);
  assert.deepEqual(s.view().codes, { [`post:${postId}`]: '10000000' });
  s.controller.dispose();
  const failed = setup({
    lookup: async () => {
      throw new Error('offline');
    },
  });
  failed.controller.reconcile([row], 1);
  await flush();
  assert.equal(failed.view().available, true);
  assert.deepEqual(failed.view().codes, {});
  failed.controller.dispose();
});
test('each completed tap freshly resolves; pending duplicates and forged/recycled segments cannot dispatch', async () => {
  const s = setup({}, scopeId);
  s.controller.reconcile([row], 1);
  await flush();
  const event = s.event();
  await s.controller.open({ ...event, code: '7654321' });
  await s.controller.open({ ...event, start: 3 });
  await s.controller.open({ ...event, rowKey: `reply:${replyId}` });
  assert.equal(s.resolves.length, 0);
  const first = s.controller.open(event);
  void s.controller.open(event);
  await first;
  assert.equal(s.resolves.length, 1);
  assert.equal(s.calls.length, 1);
  assert.match(
    s.calls[0]!.url,
    new RegExp(`replyId=${replyId}&viewSpaceId=${scopeId}$`),
  );
  s.calls[0]!.success?.();
  await s.controller.open(event);
  assert.equal(s.resolves.length, 2);
  s.calls[1]!.success?.();
  s.controller.reconcile([{ ...row, text: '#7654321' }], 2);
  await flush();
  await s.controller.open(event);
  assert.equal(s.resolves.length, 2);
  s.controller.dispose();
});
for (const boundary of [
  'dispose',
  'root-hide',
  'scope',
  'account',
  'same-login',
  'safety',
] as const)
  test(`${boundary} suppresses delayed capability, lookup, resolve and native failures`, async () => {
    for (const stage of ['capability', 'lookup', 'resolve'] as const) {
      const pending = deferred<never>();
      const s = setup({ [stage]: () => pending.promise });
      s.controller.reconcile([row], 1);
      await flush();
      const opened =
        stage === 'resolve' ? s.controller.open(s.event()) : Promise.resolve();
      await flush();
      if (boundary === 'dispose') s.controller.dispose();
      if (boundary === 'root-hide') s.privateViews.clear();
      if (boundary === 'scope') s.browsingScopeChanges.clear('12');
      if (boundary === 'account')
        s.sessions.completeLogin(s.sessions.beginLogin(), credentials('13'));
      if (boundary === 'same-login')
        s.sessions.completeLogin(s.sessions.beginLogin(), credentials());
      if (boundary === 'safety') s.safetyChanges.invalidate('12');
      pending.resolve(
        (stage === 'capability'
          ? { available: true }
          : stage === 'lookup'
            ? { items: [{ kind: 'post', targetId: postId, code: '10000000' }] }
            : destination) as never,
      );
      await opened;
      await flush();
      assert.equal(s.calls.length, 0);
      assert.equal(s.view().available, false);
      assert.deepEqual(s.view().codes, {});
      s.controller.reconcile([row], 1);
      await flush();
      assert.equal(s.view().available, false);
      s.controller.dispose();
    }
  });
test('row reuse cancels stale lookup and safety resumes only after a fresh detail generation', async () => {
  const pending = deferred<{ items: [] }>();
  const s = setup({ lookup: () => pending.promise });
  s.controller.reconcile([row], 1);
  await flush();
  s.controller.reconcile([{ ...row, targetId: rootId }], 2);
  await flush();
  pending.resolve({ items: [] });
  await flush();
  assert.deepEqual(s.view().codes, {});
  s.safetyChanges.invalidate('12');
  s.controller.reconcile([row], 2);
  await flush();
  assert.equal(s.view().available, false);
  s.controller.reconcile([row], 3);
  await flush();
  assert.equal(s.view().available, true);
  s.controller.dispose();
});
test('unreadable and response loss do not navigate or mutate; retry uses fresh read', async () => {
  let count = 0;
  const s = setup({
    resolve: async () => {
      count++;
      throw new ClientError(
        'network',
        'untrusted-body',
        count === 1 ? { serverCode: 'REFERENCE_NOT_FOUND' } : {},
      );
    },
  });
  s.controller.reconcile([row], 1);
  await flush();
  await s.controller.open(s.event());
  assert.equal(s.view().error, '引用不存在或当前不可查看');
  await s.controller.open(s.event());
  assert.equal(count, 2);
  assert.equal(s.calls.length, 0);
  assert.ok(!s.view().error.includes('untrusted-body'));
  s.controller.dispose();
});
test('old preview navigation has explicit current-ancestor successor; no cursor or read acknowledgement', async () => {
  const s = setup({}, scopeId);
  const preview: ReferenceRow = {
    kind: 'reply',
    targetId: replyId,
    text: 'plain #1234567',
    thread: { postId, rootCommentId: rootId, replyId },
  };
  s.controller.reconcile([row, preview], 1);
  await flush();
  s.controller.openThread({
    rowKey: `reply:${replyId}`,
    generation: s.view().generation,
  });
  assert.equal(
    s.calls[0]!.url,
    `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${rootId}&replyId=${replyId}&viewSpaceId=${scopeId}`,
  );
  assert.equal(s.resolves.length, 0);
  s.controller.dispose();
  s.calls[0]!.fail({ errMsg: 'late-private-error' });
  assert.equal(s.view().error, '');
});
test('detail row collector requires committed visible parent and preserves bodies without altering cursors', () => {
  const detail = {
    ...initialDetailView(),
    loaded: true,
    post: post(),
    comments: [comment()],
  };
  const before = JSON.stringify(detail);
  assert.ok(detailReferenceRows(detail).length >= 2);
  assert.equal(JSON.stringify(detail), before);
  for (const patch of [
    { busy: true },
    { needsReload: true },
    { loaded: false },
    { post: null },
  ])
    assert.deepEqual(detailReferenceRows({ ...detail, ...patch }), []);
});

type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes: Record<string, Method>;
  pageLifetimes: Record<string, Method>;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
function component() {
  const require = createRequire(__filename);
  const path =
    require.resolve('../src/components/reference-text/reference-text');
  const globals = globalThis as unknown as {
    Component?: (definition: Definition) => void;
  };
  const previous = globals.Component;
  let definition!: Definition;
  globals.Component = (value) => {
    definition = value;
  };
  try {
    delete require.cache[path];
    require(path);
  } finally {
    if (previous) globals.Component = previous;
    else delete globals.Component;
  }
  const events: { name: string; detail: unknown; options: unknown }[] = [];
  const instance: Instance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, value]) => [
          key,
          value.value,
        ]),
      ),
      source: row.text,
      rowKey: `post:${postId}`,
      generation: 5,
      available: true,
      fallback: true,
    },
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
    triggerEvent(name, detail, options) {
      events.push({ name, detail, options });
    },
  };
  for (const [key, method] of Object.entries(definition.methods))
    instance[key] = method.bind(instance);
  const invoke = (key: string, event?: unknown) =>
    definition.methods[key]!.call(instance, event);
  const event = (index: number) => ({
    currentTarget: { dataset: { index, revision: instance.data.revision } },
  });
  definition.lifetimes.attached!.call(instance);
  return { definition, instance, events, invoke, event };
}
test('actual native component preserves source and uses nonbubbling distinct reference/plain events', () => {
  const c = component();
  assert.equal(
    (c.instance.data.segments as { text: string }[])
      .map((segment) => segment.text)
      .join(''),
    row.text,
  );
  c.invoke('onStart', c.event(1));
  c.invoke('onTap', c.event(1));
  assert.deepEqual(c.events, [
    {
      name: 'referencepress',
      detail: {
        rowKey: `post:${postId}`,
        generation: 5,
        code: '1234567',
        start: 2,
      },
      options: { bubbles: false, composed: false },
    },
  ]);
  c.invoke('onStart', c.event(0));
  c.invoke('onTap', c.event(0));
  assert.equal(c.events[1]!.name, 'plaintextpress');
  c.instance.properties.available = false;
  c.invoke('sync');
  assert.deepEqual(c.instance.data.segments, [
    { kind: 'text', start: 0, end: row.text.length, text: row.text },
  ]);
});
test('actual native longpress, copy gesture, disabled, row reuse, hide and detach never emit navigation', () => {
  for (const boundary of [
    'longpress',
    'cancel',
    'disabled',
    'reuse',
    'hide',
    'detach',
  ]) {
    const c = component(),
      event = c.event(1);
    c.invoke('onStart', event);
    if (boundary === 'longpress') c.invoke('onLongPress');
    if (boundary === 'cancel') c.invoke('onCancel');
    if (boundary === 'disabled') c.instance.properties.disabled = true;
    if (boundary === 'reuse') {
      c.instance.properties.source = '#7654321';
      c.invoke('sync');
    }
    if (boundary === 'hide') c.definition.pageLifetimes.hide!.call(c.instance);
    if (boundary === 'detach')
      c.definition.lifetimes.detached!.call(c.instance);
    c.invoke('onTap', event);
    assert.deepEqual(c.events, [], boundary);
  }
});
test('native markup action inventory proves original preview successor and selection without nested navigator bubbling', () => {
  const page = readFileSync(
    `${__dirname}/../src/pages/community-detail/community-detail.wxml`,
    'utf8',
  );
  const renderer = readFileSync(
    `${__dirname}/../src/components/reference-text/reference-text.wxml`,
    'utf8',
  );
  assert.match(renderer, /selectable="\{\{true\}\}"/);
  assert.match(renderer, /catchtap="onTap"/);
  assert.match(renderer, /bindlongpress="onLongPress"/);
  assert.equal(
    (page.match(/bind:plaintextpress="onReferenceThread"/g) ?? []).length,
    2,
    'reply preview and located root each have their original thread-route successor',
  );
  assert.ok(
    !/<navigator[^>]*>[^<]*<wu-reference-text/.test(page),
    'no native parent navigator bypasses the reference gesture owner',
  );
  assert.match(
    page,
    /replyId=\{\{locatedReplyId\}\}/,
    'explicit located reply route remains',
  );
  assert.match(
    page,
    /<template is="root-comment"[^>]*references/,
    'template passes current reference generation',
  );
});

test('current synthesized accessibility taps need no touchstart, but stale/blocked taps stay suppressed', () => {
  const c = component();
  c.invoke('onTap', c.event(1));
  assert.equal(c.events[0]!.name, 'referencepress');
  const stale = c.event(1);
  c.instance.properties.rowKey = `reply:${replyId}`;
  c.invoke('sync');
  c.invoke('onTap', stale);
  assert.equal(c.events.length, 1);
  c.invoke('onLongPress');
  c.invoke('onTap', c.event(1));
  assert.equal(c.events.length, 1);
  c.invoke('onStart', c.event(1));
  c.invoke('onTap', c.event(1));
  assert.equal(c.events.length, 2);
});

test('located-root plain fallback preserves original route and view scope exactly', async () => {
  const s = setup({}, scopeId);
  s.controller.reconcile(
    [
      row,
      {
        kind: 'comment',
        targetId: rootId,
        text: '',
        thread: { postId, rootCommentId: rootId },
      },
    ],
    1,
  );
  await flush();
  s.controller.openThread({
    rowKey: `comment:${rootId}`,
    generation: s.view().generation,
  });
  assert.equal(
    s.calls[0]!.url,
    `/pages/community-thread/community-thread?postId=${postId}&rootCommentId=${rootId}&viewSpaceId=${scopeId}`,
  );
  s.controller.dispose();
});

test('pending privacy-changing operation cancels an already dispatched reference read until fresh detail', async () => {
  const pending = deferred<ReferenceDestination>();
  const s = setup({ resolve: () => pending.promise });
  s.controller.reconcile([row], 1);
  await flush();
  const open = s.controller.open(s.event());
  s.controller.suspend();
  pending.resolve(destination);
  await open;
  await flush();
  assert.equal(s.calls.length, 0);
  s.controller.reconcile([row], 1);
  await flush();
  assert.equal(s.view().available, false);
  s.controller.reconcile([row], 2);
  await flush();
  assert.equal(s.view().available, true);
  s.controller.dispose();
});

test('new overlay/menu/confirmation wins over delayed resolve; closing cannot resume the old intent', async () => {
  let allowed = true;
  const pending = deferred<ReferenceDestination>();
  const s = setup({ resolve: () => pending.promise }, undefined, () => allowed);
  s.controller.reconcile([row], 1);
  await flush();
  const open = s.controller.open(s.event());
  allowed = false;
  pending.resolve(destination);
  await open;
  await flush();
  assert.equal(s.calls.length, 0);
  assert.equal(s.view().busy, false);
  allowed = true;
  await flush();
  assert.equal(s.calls.length, 0);
  await s.controller.open(s.event());
  assert.equal(s.calls.length, 1);
  s.controller.dispose();
});
