import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { HttpProfileGateway } from '../src/profile/gateway';
import { HttpSchoolConfigurationGateway } from '../src/school-configuration/gateway';
import { HttpOrganizationGateway } from '../src/organizations/gateway';
import type { OrganizationGateway } from '../src/organizations/gateway';
import { HttpDirectoryGateway } from '../src/directory/gateway';
import type { DirectoryGateway } from '../src/directory/gateway';
import { organizationCommandHash } from '../src/organizations/contract';
import type {
  OrganizationCommand,
  OrganizationDetail,
  OrganizationReceipt,
} from '../src/organizations/contract';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import {
  announcementHarness,
  announcementId,
  campusId,
  detail as announcementDetail,
  summary,
  token,
} from './announcement-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const baseline = JSON.parse(
  read('test/fixtures/framework7-information-before-actions.json'),
) as Record<string, { sourceSha256: string; actions: Action[] }>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-information-before-protected.json'),
) as Record<string, string>;
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalizeFramework7ActionNode(raw);
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
function conditionalChains(node: PresentationNode) {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  children.forEach((child, index) => {
    if ('wx:else' in child.attrs || 'wx:elif' in child.attrs)
      assert.ok(
        children[index - 1] &&
          ('wx:if' in children[index - 1]!.attrs ||
            'wx:elif' in children[index - 1]!.attrs),
        `${child.tag}: intact conditional chain`,
      );
    conditionalChains(child);
  });
}
for (const [file, before] of Object.entries(baseline))
  test(`${file}: exact original actions, ancestor guards, datasets, loading and disabled constraints survive`, () => {
    const tree = parse(read(file));
    const current = actions(tree);
    assert.equal(current.length, before.actions.length);
    for (const old of before.actions) {
      const index = current.findIndex(
        (next) =>
          next.tag === old.tag &&
          JSON.stringify(next.scopes) === JSON.stringify(old.scopes) &&
          Object.entries(old.attrs).every(
            ([key, value]) => next.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(old));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    conditionalChains(tree);
  });
const pages = [
  'organizations',
  'organization-editor',
  'announcements',
  'announcement-detail',
];
for (const page of pages)
  test(`${page}: real native components and intentional platform boundaries have no nested actions or overlays`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    for (const kind of ['button', 'block', 'list', 'list-item'])
      assert.ok(nodes.some((n) => n.tag === `wu-f7-${kind}`));
    for (const node of nodes.filter((n) => n.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-list-item') {
        if (node.attrs['bind:press']) assert.equal(node.attrs.link, '{{true}}');
        assert.ok(
          !flatten(node)
            .slice(1)
            .some(
              (n) =>
                /^(button|input|textarea|switch|navigator|wu-f7-button|wu-f7-input)$/.test(
                  n.tag,
                ) || Object.keys(n.attrs).some((k) => /^(bind|catch)/.test(k)),
            ),
        );
      }
    }
    assert.ok(
      !nodes.some((n) =>
        /^(button|input|wu-f7-sheet|wu-f7-actions|wu-f7-dialog|web-view)$/.test(
          n.tag,
        ),
      ),
    );
    assert.match(source(page, 'wxss'), /framework7-information\.wxss/);
    assert.doesNotMatch(source(page), /rich-text|data:image|https?:\/\//);
  });
test('all four Page TS, domain contracts/controllers/gateways/media, accepted roots and global tokens stay byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 54);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
test('native multiline editors, native navigation and public/private image identity remain explicit exceptions', () => {
  const nodes = flatten(parse(source('organization-editor')));
  assert.deepEqual(
    nodes
      .filter((n) => n.tag === 'textarea')
      .map((n) => [n.attrs.bindinput, n.attrs.maxlength]),
    [
      ['onField', '2000'],
      ['onReason', '500'],
    ],
  );
  assert.equal(nodes.filter((n) => n.tag === 'navigator').length, 2);
  assert.match(
    source('organization-editor'),
    /data-revision="{{item.applicationRevision}}"/,
  );
  assert.match(
    source('organization-editor'),
    /detail.permissions.edit &amp;&amp; !publicRead/,
  );
  assert.match(source('organization-editor'), /旧所有者降为管理员/);
  assert.match(
    source('announcement-detail'),
    /wx:if="{{detail.media.status === 'available'}}"/,
  );
  assert.match(
    source('announcement-detail'),
    /wx:if="{{detail.media.status === 'unavailable'}}"/,
  );
  assert.match(source('announcements'), /查看公告不会记录弹窗确认/);
});

interface Owner {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>, callback?: () => void): void;
}
interface Instance {
  [key: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
  properties: Record<string, { value: unknown; type: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
}
function registration<T>(kind: 'Page' | 'Component', file: string): T {
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
function invoke(target: Owner, name: string, event?: unknown) {
  return (target[name] as (event?: unknown) => unknown).call(target, event);
}
function mount(
  page: string,
  app: Record<string, unknown>,
  query: unknown = {},
) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = { wx: globals.wx, getApp: globals.getApp };
  const navigation: string[] = [],
    storage = new Map<string, unknown>();
  globals.wx = {
    navigateTo: ({ url, success }: { url: string; success?: () => void }) => {
      navigation.push(url);
      success?.();
    },
    getStorageSync: (key: string) => storage.get(key),
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    removeStorageSync: (key: string) => storage.delete(key),
  };
  globals.getApp = () => app;
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  const target: Owner = {
    ...definition,
    data: structuredClone(definition.data),
    setData(value, callback) {
      Object.assign(this.data, value);
      callback?.();
    },
  };
  if (target.onLoad) invoke(target, 'onLoad', query);
  invoke(target, 'onShow');
  return {
    target,
    navigation,
    storage,
    close() {
      invoke(target, 'onUnload');
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
const evaluate = (raw: string, scope: Record<string, unknown>): unknown => {
  if (raw.startsWith('{{') && raw.endsWith('}}'))
    return Function(
      'scope',
      `with(scope){return (${raw.slice(2, -2)});}`,
    )(scope);
  return raw.replace(/{{([\s\S]*?)}}/g, (_all, expression: string) =>
    String(
      Function('scope', `with(scope){return (${expression});}`)(scope) ?? '',
    ),
  );
};
interface Resolved {
  node: PresentationNode;
  scope: Record<string, unknown>;
}
function visible(
  nodes: (PresentationNode | string)[],
  scope: Record<string, unknown>,
): Resolved[] {
  const result: Resolved[] = [];
  let matched = false;
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    if (node.attrs['wx:for']) {
      const items = evaluate(node.attrs['wx:for'], scope) as unknown[];
      (items ?? []).forEach((item, index) => {
        const attrs = { ...node.attrs };
        delete attrs['wx:for'];
        result.push(
          ...visible([{ ...node, attrs }], {
            ...scope,
            [node.attrs['wx:for-item'] ?? 'item']: item,
            [node.attrs['wx:for-index'] ?? 'index']: index,
          }),
        );
      });
      continue;
    }
    if ('wx:if' in node.attrs) matched = false;
    const condition = node.attrs['wx:if'] ?? node.attrs['wx:elif'];
    if ('wx:elif' in node.attrs && matched) continue;
    if (condition !== undefined) {
      if (!evaluate(condition, scope)) continue;
      matched = true;
    } else if ('wx:else' in node.attrs) {
      if (matched) continue;
      matched = true;
    } else matched = false;
    result.push({ node, scope }, ...visible(node.children, scope));
  }
  return result;
}
function control(
  page: string,
  owner: Owner,
  handler: string,
  selector: Record<string, unknown> = {},
  event = 'press',
) {
  const found = visible(parse(source(page)).children, owner.data).find(
    ({ node, scope }) =>
      node.attrs[`bind:${event}`] === handler &&
      Object.entries(selector).every(
        ([key, value]) =>
          evaluate(node.attrs[`data-${key}`] ?? '', scope) === value,
      ),
  );
  assert.ok(
    found,
    `${page}: currently rendered ${handler} ${JSON.stringify(selector)}`,
  );
  const { node, scope } = found;
  const config = JSON.parse(source(page, 'json')) as {
    usingComponents: Record<string, string>;
  };
  assert.equal(
    config.usingComponents[node.tag],
    `../../components/${node.tag.slice(3)}/${node.tag.slice(3)}`,
  );
  const definition = registration<Definition>(
    'Component',
    `components/${node.tag.slice(3)}/${node.tag.slice(3)}.ts`,
  );
  const dataset = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) => key.startsWith('data-'))
      .map(([key, value]) => [
        key
          .slice(5)
          .replace(/-([a-z])/g, (_s, letter: string) => letter.toUpperCase()),
        evaluate(value, scope),
      ]),
  );
  const native = flatten(
    parse(
      read(`src/components/${node.tag.slice(3)}/${node.tag.slice(3)}.wxml`),
    ),
  ).find((n) =>
    event === 'input'
      ? n.tag === 'input' && n.attrs.catchinput === 'onInput'
      : n.tag === 'button' && n.attrs.catchtap === 'onPress',
  );
  assert.ok(native, 'actual Component WXML owns the inner native event');
  let dispatched = 0,
    result: unknown;
  const instance: Instance = {
    properties: Object.fromEntries(
      Object.entries(definition.properties).map(([key, property]) => {
        const attr = key.replace(
            /[A-Z]/g,
            (letter) => `-${letter.toLowerCase()}`,
          ),
          raw = node.attrs[attr];
        const value =
          raw === undefined
            ? structuredClone(property.value)
            : evaluate(raw, scope);
        return [key, property.type === Number ? Number(value) : value];
      }),
    ),
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
    triggerEvent(name, detail, options) {
      assert.equal(name, event);
      assert.deepEqual(options, { bubbles: false, composed: false });
      dispatched++;
      result = invoke(owner, handler, { detail, currentTarget: { dataset } });
    },
  };
  for (const [name, method] of Object.entries(definition.methods))
    instance[name] = method.bind(instance);
  definition.lifetimes?.attached?.call(instance);
  return {
    fire(value?: unknown) {
      definition.methods[event === 'input' ? 'onInput' : 'onPress']!.call(
        instance,
        event === 'input'
          ? {
              detail: {
                value,
                cursor: typeof value === 'string' ? value.length : 0,
                keyCode: 229,
              },
            }
          : undefined,
      );
      return result;
    },
    hide() {
      definition.pageLifetimes?.hide?.call(instance);
    },
    detach() {
      definition.lifetimes?.detached?.call(instance);
    },
    dispatched: () => dispatched,
  };
}
function press(
  page: string,
  owner: Owner,
  handler: string,
  selector: Record<string, unknown> = {},
) {
  const c = control(page, owner, handler, selector);
  c.fire();
  c.detach();
  return c.dispatched();
}
function input(
  page: string,
  owner: Owner,
  handler: string,
  value: string,
  selector: Record<string, unknown> = {},
) {
  const c = control(page, owner, handler, selector, 'input');
  c.fire(value);
  c.detach();
  return c.dispatched();
}
function patch<T extends object>(prototype: T, values: Partial<T>) {
  const old = Object.fromEntries(
    Object.keys(values).map((key) => [key, prototype[key as keyof T]]),
  );
  Object.assign(prototype, values);
  return () => Object.assign(prototype, old);
}
const organizationId = '55555555-5555-4555-8555-555555555555',
  regionId = '66666666-6666-4666-8666-666666666666',
  categoryId = '77777777-7777-4777-8777-777777777777',
  memberId = '88888888-8888-4888-8888-888888888888';
function organizationsHarness() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const calls: { method: string; args: unknown[] }[] = [];
  const data: OrganizationDetail = {
    source: 'managed',
    id: organizationId,
    regionId,
    revision: 3,
    authorityVersion: 2,
    state: 'approved',
    data: {
      kind: 'org',
      platform: 'wechat',
      categoryId,
      name: '校园组织',
      introText: '合成组织说明',
      qqGroupNumber: null,
    },
    role: 'organization_owner',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    mediaBindings: { avatar: memberId, managerContact: categoryId },
    reviewReason: null,
    members: [
      {
        grantId: categoryId,
        role: 'organization_admin',
        profile: { profileId: memberId, displayName: '合成成员' },
        validFrom: '2026-10-20T00:00:00.000Z',
        validUntil: null,
      },
    ],
    permissions: {
      edit: true,
      submit: true,
      review: true,
      manageMembers: true,
      transferOwner: true,
    },
  };
  const receipt = (command: OrganizationCommand): OrganizationReceipt => ({
    requestId: command.clientRequestId,
    requestHash: organizationCommandHash(
      sessions.snapshot().credentials!.accountId,
      organizationId,
      command,
    ),
    organizationId,
    revision:
      command.expectedRevision +
      (['create', 'save', 'submit'].includes(command.action) ? 1 : 0),
    authorityVersion:
      command.expectedAuthorityVersion +
      ([
        'create',
        'approve',
        'reject',
        'add_admin',
        'remove_admin',
        'transfer_owner',
      ].includes(command.action)
        ? 1
        : 0),
    outcome: 'saved',
    changed: true,
  });
  const behavior: OrganizationGateway = {
    context: async () => ({ regionId }),
    capabilities: async () => ({
      management: 'fixed',
      region: { id: regionId, name: '合成大学' },
    }),
    list: async () => ({
      items: [structuredClone(data)],
      continuation: 'end',
      nextCursor: null,
    }),
    detail: async () => structuredClone(data),
    publicDetail: async () => ({
      ...structuredClone(data),
      state: 'approved',
      role: 'reader',
      management: { available: false },
    }),
    lookup: async (_id, profileId) => ({
      profileId,
      displayName: '合成目标成员',
    }),
    command: async (_id, _region, command) => receipt(command),
    recover: async (requestId) => ({ state: 'not_recorded', requestId }),
    cancel: async (requestId, requestHash) => ({
      state: 'cancelled',
      requestId,
      requestHash,
    }),
  };
  const gateway: Partial<HttpOrganizationGateway> = {};
  for (const key of Object.keys(behavior) as (keyof OrganizationGateway)[])
    Object.assign(gateway, {
      [key]: (...args: unknown[]) => {
        calls.push({ method: key, args });
        return (behavior[key] as (...args: unknown[]) => unknown)(...args);
      },
    });
  const restoreGateway = patch(HttpOrganizationGateway.prototype, gateway);
  const directory: Partial<DirectoryGateway> = {
    categories: async () => ({
      items: [
        {
          id: categoryId,
          kind: 'org',
          name: '合成分类',
          description: '',
          accent: 'green',
        },
      ],
      continuation: 'end',
      nextCursor: null,
    }),
  };
  const restoreDirectory = patch(HttpDirectoryGateway.prototype, directory);
  const mediaCalls: { method: string; target?: unknown }[] = [];
  const privateViews = new PrivateViewLifecycle(),
    directoryScopeChanges = new PrivateViewLifecycle();
  let pendingTargets: {
    organizationId: string;
    applicationRevision: number;
    slot: string;
  }[] = [];
  const app = {
    identity: { sessions, api: {} },
    community: {
      sessions,
      privateViews,
      directoryScopeChanges,
      newRequestId: async () => randomUUID(),
    },
    organizationMedia: {
      createReader: () => ({
        load: async (target: unknown) => {
          mediaCalls.push({ method: 'read', target });
        },
        clear: () => mediaCalls.push({ method: 'clear' }),
        dispose: () => mediaCalls.push({ method: 'disposeReader' }),
      }),
      createUploader: () => ({
        pick: async (target: unknown) => {
          mediaCalls.push({ method: 'pick', target });
          return memberId;
        },
        recover: async (target: unknown) => {
          mediaCalls.push({ method: 'recover', target });
          return memberId;
        },
        cancelPending: async (target: unknown) => {
          mediaCalls.push({ method: 'cancel', target });
        },
        dispose: () => mediaCalls.push({ method: 'disposeUploader' }),
      }),
      pendingTargets: () => pendingTargets,
      reconcile: async () => undefined,
    },
  };
  return {
    sessions,
    data,
    behavior,
    calls,
    app,
    mediaCalls,
    privateViews,
    directoryScopeChanges,
    setPending(value: typeof pendingTargets) {
      pendingTargets = value;
    },
    close() {
      restoreGateway();
      restoreDirectory();
    },
  };
}

test('real Button→organizations Page→list controller retains review scope, opaque pagination, busy and owner fences', async () => {
  const h = organizationsHarness();
  h.behavior.list = async (_mode, _region, query) => ({
    items: query.cursor ? [] : [structuredClone(h.data)],
    continuation: query.cursor ? 'end' : 'more',
    nextCursor: query.cursor ? null : 'organization-cursor',
  });
  const f = mount('organizations', h.app);
  try {
    await flush();
    press('organizations', f.target, 'onMore');
    await flush();
    assert.deepEqual(
      h.calls.filter((c) => c.method === 'list')[1]!.args.slice(0, 3),
      ['mine', null, { cursor: 'organization-cursor' }],
    );
    press('organizations', f.target, 'onReviews');
    await flush();
    assert.deepEqual(
      h.calls
        .filter((c) => c.method === 'list')
        .slice(-1)[0]!
        .args.slice(0, 3),
      ['review', regionId, {}],
    );
    const late = deferred<Awaited<ReturnType<OrganizationGateway['list']>>>();
    h.behavior.list = async () => late.promise;
    press('organizations', f.target, 'onRefresh');
    assert.equal(f.target.data.busy, true);
    assert.equal(press('organizations', f.target, 'onRefresh'), 0);
    h.sessions.completeLogin(h.sessions.beginLogin(), {
      ...wireCredentials('replacement'),
      accountId: memberId,
    });
    late.resolve({
      items: [structuredClone(h.data)],
      continuation: 'end',
      nextCursor: null,
    });
    await flush();
    assert.deepEqual(f.target.data.items, []);
    assert.equal(f.target.controller, undefined);
    assert.equal(f.target.data.management, 'none');
  } finally {
    f.close();
    h.close();
  }
});
test('real Input→editor Page→controller preserves complete IME draft and disabled pending state; exact original request survives retry and cancellation', async () => {
  const h = organizationsHarness();
  h.behavior.command = async () => {
    throw new ClientError('network', 'lost response');
  };
  const f = mount('organization-editor', h.app, { id: organizationId });
  try {
    await flush();
    const raw = '  中文候选  ';
    assert.equal(
      input('organization-editor', f.target, 'onField', raw, { field: 'name' }),
      1,
    );
    assert.equal((f.target.data.form as { name: string }).name, raw);
    assert.equal(h.calls.filter((c) => c.method === 'command').length, 0);
    press('organization-editor', f.target, 'onSave');
    await flush();
    assert.equal(
      f.target.data.pending,
      false,
      'domain rejects surrounding whitespace, Input never silently trims it',
    );
    assert.equal(h.calls.filter((c) => c.method === 'command').length, 0);
    input('organization-editor', f.target, 'onField', '中文候选', {
      field: 'name',
    });
    press('organization-editor', f.target, 'onSave');
    await flush();
    assert.equal(f.target.data.pending, true);
    const first = h.calls.find((c) => c.method === 'command')!.args[2];
    const stored = structuredClone([...f.storage.values()]);
    assert.equal(
      input('organization-editor', f.target, 'onField', '不能覆盖', {
        field: 'name',
      }),
      0,
    );
    assert.equal(press('organization-editor', f.target, 'onSave'), 0);
    press('organization-editor', f.target, 'onRecover');
    await flush();
    assert.equal(h.calls.filter((c) => c.method === 'command').length, 1);
    press('organization-editor', f.target, 'onRetry');
    await flush();
    assert.deepEqual(
      h.calls.filter((c) => c.method === 'command')[1]!.args[2],
      first,
    );
    assert.deepEqual([...f.storage.values()], stored);
    press('organization-editor', f.target, 'onCancelPending');
    await flush();
    const cancel = h.calls.find((c) => c.method === 'cancel')!;
    const record = stored[0] as {
      requestHash: string;
      command: { clientRequestId: string };
    };
    assert.equal(cancel.args[0], record.command.clientRequestId);
    assert.equal(cancel.args[1], record.requestHash);
    assert.equal(f.target.data.pending, false);
    assert.equal(f.storage.size, 0);
    const stale = control(
      'organization-editor',
      f.target,
      'onField',
      { field: 'name' },
      'input',
    );
    stale.hide();
    stale.fire('隐藏后事件');
    assert.equal(stale.dispatched(), 0);
    stale.detach();
    invoke(f.target, 'onHide');
    assert.equal(f.target.data.form, null);
  } finally {
    f.close();
    h.close();
  }
});
test('real editor native controls route category/platform/create and preserve controller-side kind rules', async () => {
  const h = organizationsHarness();
  h.behavior.command = async () => {
    throw new ClientError('network', 'unknown create');
  };
  const f = mount('organization-editor', h.app);
  try {
    await flush();
    press('organization-editor', f.target, 'onKind', { kind: 'school' });
    await flush();
    assert.equal((f.target.data.form as { kind: string }).kind, 'school');
    press('organization-editor', f.target, 'onPlatform', { platform: 'qq' });
    press('organization-editor', f.target, 'onCategory', { id: categoryId });
    input('organization-editor', f.target, 'onField', '合成校园群', {
      field: 'name',
    });
    input('organization-editor', f.target, 'onField', '12345678', {
      field: 'qqGroupNumber',
    });
    press('organization-editor', f.target, 'onSave');
    await flush();
    const command = h.calls.find((c) => c.method === 'command')!
      .args[2] as OrganizationCommand;
    assert.equal(command.action, 'create');
    if (command.action !== 'create') assert.fail('create');
    assert.equal(command.expectedRevision, 0);
    assert.equal(command.expectedAuthorityVersion, 0);
    assert.deepEqual(command.data, {
      kind: 'school',
      platform: 'qq',
      categoryId,
      name: '合成校园群',
      introText: '',
      qqGroupNumber: '12345678',
    });
    press('organization-editor', f.target, 'onKind', { kind: 'official' });
    await flush();
    assert.equal(
      (f.target.data.form as { kind: string }).kind,
      'school',
      'controller rejects pending-kind changes even without a disabled prop',
    );
    assert.equal(h.calls.filter((c) => c.method === 'command').length, 1);
  } finally {
    f.close();
    h.close();
  }
});
test('real editor member/review controls retain current CAS authority and exact profile target, never just handler aliases', async () => {
  const h = organizationsHarness();
  const f = mount('organization-editor', h.app, { id: organizationId });
  try {
    await flush();
    press('organization-editor', f.target, 'onToggleMembers');
    input('organization-editor', f.target, 'onLookupInput', `  ${memberId}  `);
    press('organization-editor', f.target, 'onLookup');
    await flush();
    assert.equal(h.calls.find((c) => c.method === 'lookup')!.args[1], memberId);
    for (const handler of ['onAddAdmin', 'onTransfer']) {
      if (!f.target.data.person) {
        input('organization-editor', f.target, 'onLookupInput', memberId);
        press('organization-editor', f.target, 'onLookup');
        await flush();
      }
      press('organization-editor', f.target, handler);
      await flush();
    }
    press('organization-editor', f.target, 'onRemoveAdmin', { id: memberId });
    await flush();
    press('organization-editor', f.target, 'onApprove');
    await flush();
    const commands = h.calls
      .filter((c) => c.method === 'command')
      .map((c) => c.args[2] as OrganizationCommand);
    assert.deepEqual(
      commands.map((c) => c.action),
      ['add_admin', 'transfer_owner', 'remove_admin', 'approve'],
    );
    for (const c of commands) {
      assert.equal(c.expectedRevision, 3);
      assert.equal(c.expectedAuthorityVersion, 2);
      if ('targetProfileId' in c) assert.equal(c.targetProfileId, memberId);
    }
    h.data.permissions = {
      edit: false,
      submit: false,
      review: false,
      manageMembers: false,
      transferOwner: false,
    };
    press('organization-editor', f.target, 'onRefresh');
    await flush();
    const handlers = visible(
      parse(source('organization-editor')).children,
      f.target.data,
    ).map((n) => n.node.attrs['bind:press']);
    for (const handler of [
      'onSave',
      'onSubmit',
      'onApprove',
      'onReject',
      'onLookup',
      'onAddAdmin',
      'onTransfer',
      'onRemoveAdmin',
    ])
      assert.ok(
        !handlers.includes(handler),
        `${handler}: authority ancestor hides action`,
      );
    assert.equal(
      input('organization-editor', f.target, 'onField', '不得编辑', {
        field: 'name',
      }),
      0,
    );
  } finally {
    f.close();
    h.close();
  }
});
test('real editor media actions retain original revision identity, public audience privacy and reader disposal', async () => {
  const h = organizationsHarness();
  h.setPending([{ organizationId, slot: 'avatar', applicationRevision: 1 }]);
  const f = mount('organization-editor', h.app, { id: organizationId });
  try {
    await flush();
    const pending = control('organization-editor', f.target, 'onPendingImage', {
      slot: 'avatar',
      revision: 1,
      action: 'recover',
    });
    await pending.fire();
    pending.detach();
    assert.deepEqual(h.mediaCalls.find((c) => c.method === 'recover')!.target, {
      organizationId,
      slot: 'avatar',
      applicationRevision: 1,
      key: 'avatar:1',
      label: '头像（必填）',
    });
    assert.equal(
      (f.target.data.slots as { slot: string; change: string }[]).find(
        (s) => s.slot === 'avatar',
      )!.change,
      'keep',
      'old revision asset cannot attach to revision 3',
    );
    press('organization-editor', f.target, 'onToggleMediaSection');
    press('organization-editor', f.target, 'onToggleMedia', { slot: 'avatar' });
    const pick = control('organization-editor', f.target, 'onPickImage', {
      slot: 'avatar',
    });
    await pick.fire();
    pick.detach();
    assert.deepEqual(h.mediaCalls.find((c) => c.method === 'pick')!.target, {
      organizationId,
      applicationRevision: 3,
      slot: 'avatar',
    });
    assert.equal(
      (f.target.data.slots as { slot: string; change: string }[]).find(
        (s) => s.slot === 'avatar',
      )!.change,
      'replace',
    );
    press('organization-editor', f.target, 'onRemoveImage', { slot: 'avatar' });
    assert.equal(
      (f.target.data.slots as { slot: string; change: string }[]).find(
        (s) => s.slot === 'avatar',
      )!.change,
      'remove',
    );
    press('organization-editor', f.target, 'onKeepImage', { slot: 'avatar' });
    press('organization-editor', f.target, 'onPreviewImage', {
      slot: 'avatar',
    });
    assert.deepEqual(h.mediaCalls.find((c) => c.method === 'read')!.target, {
      organizationId,
      applicationRevision: 3,
      slot: 'avatar',
      audience: 'management',
    });
    h.directoryScopeChanges.clear();
    assert.equal(f.target.controller, undefined);
    assert.deepEqual(f.target.data.pendingImages, []);
    assert.ok(h.mediaCalls.some((c) => c.method === 'disposeReader'));
  } finally {
    f.close();
    h.close();
  }
  const publicHarness = organizationsHarness();
  const publicPage = mount('organization-editor', publicHarness.app, {
    id: organizationId,
    mode: 'public',
    regionId,
  });
  try {
    await flush();
    assert.equal(publicPage.target.data.form, null);
    assert.ok(
      !(publicPage.target.data.slots as { slot: string }[]).some(
        (s) => s.slot === 'managerContact',
      ),
    );
    press('organization-editor', publicPage.target, 'onPreviewImage', {
      slot: 'avatar',
    });
    assert.deepEqual(
      publicHarness.mediaCalls.find((c) => c.method === 'read')!.target,
      {
        organizationId,
        applicationRevision: 3,
        slot: 'avatar',
        audience: 'public',
      },
    );
    const handlers = visible(
      parse(source('organization-editor')).children,
      publicPage.target.data,
    ).map((n) => n.node.attrs['bind:press']);
    assert.ok(!handlers.includes('onPickImage'));
    assert.ok(!handlers.includes('onSave'));
  } finally {
    publicPage.close();
    publicHarness.close();
  }
});
test('real announcement source/row/pagination controls preserve native versus accepted gateways, cancellation and no read acknowledgement', async () => {
  const h = announcementHarness();
  const nativeCalls: unknown[][] = [];
  const runtime = {
    ...h.runtime,
    nativeAnnouncements: {
      ...h.runtime.announcements,
      list: async (campus: string | null, cursor: string | null) => {
        nativeCalls.push([campus, cursor]);
        return {
          context: { campusId: campus },
          items: [summary()],
          continuation: cursor ? ('end' as const) : ('more' as const),
          nextCursor: cursor ? null : token(),
        };
      },
    },
  };
  const f = mount('announcements', { community: runtime }, { campusId });
  try {
    await flush();
    assert.equal(f.target.data.source, 'native');
    press('announcements', f.target, 'onNext');
    await flush();
    assert.deepEqual(nativeCalls[1], [campusId, token()]);
    press('announcements', f.target, 'onPrevious');
    await flush();
    assert.deepEqual(nativeCalls[2], [campusId, null]);
    press('announcements', f.target, 'onAnnouncement', { id: announcementId });
    assert.equal(f.navigation.length, 1);
    assert.match(f.navigation[0]!, /source=native/);
    press('announcements', f.target, 'onSource', { source: 'accepted' });
    await flush();
    assert.equal(f.target.data.source, 'accepted');
    assert.equal(h.calls.filter((c) => c.method === 'list').length, 1);
    const pending = deferred<Awaited<ReturnType<typeof h.behavior.list>>>();
    h.behavior.list = async () => pending.promise;
    press('announcements', f.target, 'onRefresh');
    assert.equal(
      press('announcements', f.target, 'onSource', { source: 'native' }),
      0,
    );
    press('announcements', f.target, 'onCancel');
    pending.resolve({
      context: { campusId },
      items: [summary()],
      continuation: 'end',
      nextCursor: null,
    });
    await flush();
    assert.deepEqual(f.target.data.items, []);
    assert.equal(
      h.calls.filter(
        (c) =>
          c.method === 'acknowledge' ||
          c.method === 'ownerPopup' ||
          c.method === 'popup',
      ).length,
      0,
    );
    h.runtime.browsingScopeChanges.clear();
    assert.deepEqual(f.target.route, { campusId: null });
  } finally {
    f.close();
    h.controller.dispose();
    h.popupController.dispose();
  }
});
test('real announcement detail image row resolves current controlled media and keeps revision/read-only lifecycle', async () => {
  const h = announcementHarness(true, 'detail');
  h.behavior.detail = async () => ({
    ...announcementDetail(),
    media: {
      status: 'available',
      items: [
        { announcementId, revision: 3, slot: 'gallery0', bindingId: memberId },
      ],
    },
  });
  const reads: unknown[] = [];
  let clears = 0,
    disposals = 0;
  const f = mount(
    'announcement-detail',
    {
      community: h.runtime,
      announcementMedia: {
        createReader: () => ({
          load: async (target: unknown) => {
            reads.push(target);
          },
          clear: () => {
            clears++;
          },
          dispose: () => {
            disposals++;
          },
        }),
      },
    },
    { campusId, announcementId, source: 'accepted' },
  );
  try {
    await flush();
    press('announcement-detail', f.target, 'onImage', { slot: 'gallery0' });
    assert.deepEqual(reads, [
      {
        announcementId,
        revision: 3,
        slot: 'gallery0',
        bindingId: memberId,
        audience: 'public',
        campusId,
      },
    ]);
    press('announcement-detail', f.target, 'onToggleInfo');
    assert.equal(f.target.data.showInfo, true);
    assert.ok(clears > 0);
    invoke(f.target, 'onHide');
    assert.equal(f.target.reader, undefined);
    assert.equal(f.target.controller, undefined);
    assert.equal(f.target.data.showInfo, false);
    assert.equal(disposals, 1);
    assert.equal(h.calls.filter((c) => c.method === 'acknowledge').length, 0);
  } finally {
    f.close();
    h.controller.dispose();
    h.popupController.dispose();
  }
});

test('all synthetic fixture markers render through actual Component slots and template scopes', () => {
  const { evaluatePreviewExpression: evaluate } = requireNative(
    '../scripts/preview-wxml.mjs',
  ) as {
    evaluatePreviewExpression(
      value: string,
      scope: Record<string, unknown>,
    ): unknown;
  };
  const { nativeComponentPreviewState } = requireNative(
    '../scripts/preview-native-component.mjs',
  ) as {
    nativeComponentPreviewState(
      definition: object,
      attrs: Record<string, string>,
      evaluate: (value: string) => unknown,
    ): Record<string, unknown>;
  };
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-information-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  type Templates = Record<string, (PresentationNode | string)[]>;
  type Slots = Record<string, () => string>;
  const interpolation = (value: string, scope: Record<string, unknown>) =>
    value.replace(/{{([\s\S]*?)}}/g, (_match, expr: string) =>
      String(evaluate(expr, scope) ?? ''),
    );
  function templateMap(file: string, seen = new Set<string>()): Templates {
    if (seen.has(file)) return {};
    seen.add(file);
    const tree = parse(read(file));
    let templates: Templates = {};
    for (const child of tree.children) {
      if (typeof child === 'string') continue;
      if (child.tag === 'import')
        templates = {
          ...templates,
          ...templateMap(path.join(path.dirname(file), child.attrs.src!), seen),
        };
      if (child.tag === 'template' && child.attrs.name)
        templates[child.attrs.name] = child.children;
    }
    return templates;
  }
  function render(
    nodes: (PresentationNode | string)[],
    scope: Record<string, unknown>,
    templates: Templates,
    slots: Slots = {},
  ): string {
    let result = '',
      matched = false;
    for (const node of nodes) {
      if (typeof node === 'string') {
        result += interpolation(node, scope);
        continue;
      }
      const attrs = node.attrs;
      if (node.tag === 'import' || (node.tag === 'template' && attrs.name))
        continue;
      if (attrs['wx:for']) {
        const values = evaluate(attrs['wx:for'].slice(2, -2), scope) as
          unknown[] | undefined;
        const remaining = { ...attrs };
        delete remaining['wx:for'];
        result += (values ?? [])
          .map((item, index) =>
            render(
              [{ ...node, attrs: remaining }],
              {
                ...scope,
                [attrs['wx:for-item'] ?? 'item']: item,
                [attrs['wx:for-index'] ?? 'index']: index,
              },
              templates,
              slots,
            ),
          )
          .join('');
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
        result += render(
          templates[attrs.is] ?? [],
          (evaluate(`({${attrs.data!.slice(2, -2)}})`, scope) as Record<
            string,
            unknown
          >) ?? {},
          templates,
          slots,
        );
        continue;
      }
      if (node.tag === 'slot') {
        result += slots[attrs.name ?? 'default']?.() ?? '';
        continue;
      }
      if (node.tag.startsWith('wu-f7-')) {
        const name = node.tag.slice(3),
          file = `src/components/${name}/${name}.wxml`;
        const definition = registration<Definition>(
          'Component',
          `components/${name}/${name}.ts`,
        );
        const state = nativeComponentPreviewState(definition, attrs, (value) =>
          value.startsWith('{{') && value.endsWith('}}')
            ? evaluate(value.slice(2, -2), scope)
            : interpolation(value, scope),
        );
        const componentSlots: Slots = {};
        for (const child of node.children) {
          const slot =
            typeof child === 'string'
              ? 'default'
              : (child.attrs.slot ?? 'default');
          const previous = componentSlots[slot];
          componentSlots[slot] = () =>
            (previous?.() ?? '') + render([child], scope, templates, slots);
        }
        result += render(
          parse(read(file)).children,
          state,
          templateMap(file),
          componentSlots,
        );
        continue;
      }
      result += render(node.children, scope, templates, slots);
    }
    return result;
  }
  for (const fixture of fixtures) {
    const definition = registration<Owner>(
      'Page',
      `pages/${fixture.page}/${fixture.page}.ts`,
    );
    const file = `src/pages/${fixture.page}/${fixture.page}.wxml`;
    const text = render(
      parse(read(file)).children,
      { ...structuredClone(definition.data), ...fixture.patch },
      templateMap(file),
    );
    for (const marker of fixture.expectedText)
      assert.ok(text.includes(marker), `${fixture.id}: missing ${marker}`);
  }
});
test('synthetic information fixtures cover exactly the four assigned routes and bounded busy/private/recovery/empty cases', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-information-preview.mjs',
  ) as {
    default: {
      page: string;
      id: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.deepEqual(
    [...new Set(fixtures.map((f) => f.page))].sort(),
    [...pages].sort(),
  );
  assert.equal(fixtures.length, 30);
  for (const fixture of fixtures) {
    assert.ok(fixture.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accessToken|providerId|privateAuthor|accountId/,
    );
  }
  for (const marker of [
    'recovery-busy',
    'upload-busy',
    'transfer-authority',
    'readonly',
    'known-empty',
    'unavailable',
    'previous',
  ])
    assert.ok(fixtures.some((f) => f.id.includes(marker)));
});

test('real Input/Search button/ListItem→organizations Page keeps global campus search intent and validates selected review region', async () => {
  const h = organizationsHarness();
  h.behavior.capabilities = async () => ({
    management: 'global',
    region: null,
  });
  const queries: unknown[] = [],
    selected: string[] = [];
  const campus = {
    id: campusId,
    institutionId: null,
    institutionName: '合成大学',
    fullName: '合成大学校区',
    shortName: null,
    district: '',
    isActive: true,
  };
  const restoreProfile = patch(HttpProfileGateway.prototype, {
    campuses: async (query) => {
      queries.push(query);
      return { items: [campus], page: 1, pageSize: 20, total: 1 };
    },
  });
  const restoreSchool = patch(HttpSchoolConfigurationGateway.prototype, {
    public: async (id) => {
      selected.push(id);
      return {
        context: {
          campusId: id,
          campusName: campus.fullName,
          region: { id: regionId, name: '合成审核学校' },
        },
        entries: [],
      };
    },
  });
  const f = mount('organizations', h.app);
  try {
    await flush();
    press('organizations', f.target, 'onReviews');
    assert.equal(f.target.data.status, '请选择要审核的学校');
    input('organizations', f.target, 'onCampusInput', '  合成  ');
    assert.equal(f.target.data.campusQuery, '  合成  ');
    assert.deepEqual(queries, []);
    press('organizations', f.target, 'onFindCampus');
    assert.equal(f.target.data.selecting, true);
    input('organizations', f.target, 'onCampusInput', '读取中不得改范围');
    assert.equal(
      f.target.data.campusQuery,
      '  合成  ',
      'original Page guard rejects proposals while selecting',
    );
    assert.equal(press('organizations', f.target, 'onFindCampus'), 0);
    await flush();
    assert.deepEqual(queries, [
      { q: '合成', district: '', page: 1, pageSize: 20 },
    ]);
    const choose = control('organizations', f.target, 'onChooseCampus', {
      id: campusId,
    });
    await choose.fire();
    choose.detach();
    await flush();
    assert.deepEqual(selected, [campusId]);
    assert.equal(f.target.data.regionId, regionId);
    assert.equal(f.target.data.regionName, '合成审核学校');
    assert.deepEqual(f.target.data.campuses, []);
    assert.deepEqual(
      h.calls
        .filter((c) => c.method === 'list')
        .slice(-1)[0]!
        .args.slice(0, 3),
      ['review', regionId, {}],
    );
    invoke(f.target, 'onHide');
    assert.equal(f.target.controller, undefined);
  } finally {
    f.close();
    restoreSchool();
    restoreProfile();
    h.close();
  }
});
