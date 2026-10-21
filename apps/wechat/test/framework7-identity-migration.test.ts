import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  CampusController,
  initialCampusView,
} from '../src/pages/campus/controller';
import {
  LoginController,
  initialLoginView,
} from '../src/pages/login/controller';
import {
  VerificationController,
  initialVerificationView,
} from '../src/pages/verification/controller';
import {
  InstitutionalController,
  initialInstitutionalView,
} from '../src/verification/institutional-controller';
import {
  institutionalConsent,
  institutionalPurpose,
} from '../src/verification/institutional-contract';
import type { InstitutionalGateway } from '../src/verification/institutional-gateway';
import { PendingInstitutionalStore } from '../src/verification/institutional-pending';
import { UnavailableInstitutionalNativePort } from '../src/verification/institutional-port';
import {
  PhoneBindingController,
  type PhoneGateway,
  type PhoneView,
} from '../src/verification/phone-binding';
import type { CampusPage } from '../src/profile/contract';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import { deferred, flush, MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { campus, campusId, FakeProfileGateway } from './profile-helpers';
import { setup as identitySetup } from './identity-campus-helpers';
import { FakeVerificationGateway, summary } from './verification-helpers';

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
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const before = JSON.parse(
  read('test/fixtures/framework7-identity-before-actions.json'),
) as Record<
  string,
  {
    sourceSha256: string;
    typescriptSha256: string;
    actions: Action[];
  }
>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-identity-before-protected.json'),
) as Record<string, string>;
function normalized(raw: PresentationNode): PresentationNode {
  if (raw.tag !== 'wu-f7-input') return normalizeFramework7ActionNode(raw);
  const {
    ['bind:input']: input,
    ['bind:confirm']: confirm,
    ...attrs
  } = raw.attrs;
  return {
    ...raw,
    tag: 'input',
    attrs: {
      ...attrs,
      ...(input ? { bindinput: input } : {}),
      ...(confirm ? { bindconfirm: confirm } : {}),
    },
  };
}
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalized(raw);
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
function assertConditionalChains(node: PresentationNode): void {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  for (const [index, child] of children.entries()) {
    if ('wx:elif' in child.attrs || 'wx:else' in child.attrs) {
      const prior = children[index - 1];
      assert.ok(
        prior && ('wx:if' in prior.attrs || 'wx:elif' in prior.attrs),
        `${child.tag}: condition chain cannot cross a presentation wrapper`,
      );
    }
    assertConditionalChains(child);
  }
}
for (const [page, baseline] of Object.entries(before)) {
  test(`${page}: original actions retain exact ordered guard ancestry, native constraints and datasets`, () => {
    const tree = parse(source(page));
    const current = actions(tree);
    assert.equal(current.length, baseline.actions.length);
    for (const original of baseline.actions) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === original.tag &&
          Object.entries(original.attrs).every(
            ([key, value]) => candidate.attrs[key] === value,
          ) &&
          JSON.stringify(candidate.scopes) === JSON.stringify(original.scopes),
      );
      assert.notEqual(index, -1, JSON.stringify(original));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    assert.equal(
      hash(source(page, 'ts')),
      baseline.typescriptSha256,
      'Page registration, native events and lifecycle remain byte-identical',
    );
    assertConditionalChains(tree);
  });
  test(`${page}: native Framework7 structure uses registered components without nested action surfaces`, () => {
    const nodes = flatten(parse(source(page)));
    const config = JSON.parse(source(page, 'json')) as {
      usingComponents: Record<string, string>;
    };
    for (const kind of ['block', 'button', 'list', 'list-item'])
      assert.ok(
        nodes.some((node) => node.tag === `wu-f7-${kind}`),
        kind,
      );
    for (const node of nodes.filter((item) => item.tag.startsWith('wu-f7-'))) {
      const name = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${name}/${name}`,
      );
      assert.equal(
        node.attrs['open-type'],
        undefined,
        'no component can proxy a native permission API',
      );
      if (node.tag === 'wu-f7-list')
        assert.ok(
          !flatten(node)
            .slice(1)
            .some((item) => item.tag === 'wu-f7-list'),
          'no accidental nested inset lists',
        );
      if (node.tag === 'wu-f7-list-item') {
        assert.ok(
          !flatten(node)
            .slice(1)
            .some((item) =>
              /^(button|input|switch|navigator|wu-f7-button|wu-f7-input|wu-f7-toggle)$/.test(
                item.tag,
              ),
            ),
        );
        if (node.attrs['bind:press']) assert.equal(node.attrs.link, '{{true}}');
      }
    }
    assert.ok(!nodes.some((node) => node.tag === 'input'));
    assert.match(source(page, 'wxss'), /framework7-identity\.wxss/);
    assert.doesNotMatch(
      source(page),
      /<web-view|<script|https?:\/\/|data:image|rich-text/,
    );
  });
}
test('identity source migration leaves accepted pages, all controllers and privacy/runtime boundaries byte-identical except explicit reviewed business successors', () => {
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
test('native phone authorization and institutional consent remain unwrapped real native controls', () => {
  const phone = flatten(parse(source('phone-binding'))).filter(
    (node) => node.tag === 'button',
  );
  assert.equal(phone.length, 1);
  const original = before['phone-binding']!.actions.find(
    (node) => node.attrs['open-type'] === 'getPhoneNumber',
  )!;
  assert.deepEqual(phone[0]!.attrs, original.attrs);
  assert.equal(phone[0]!.attrs.bindgetphonenumber, 'onPhone');
  const institution = flatten(parse(source('institutional-verification')));
  const consent = institution.find((node) => node.tag === 'checkbox-group')!;
  assert.equal(consent.attrs.bindchange, 'onConsent');
  assert.deepEqual(
    flatten(consent).find((node) => node.tag === 'checkbox')!.attrs,
    { value: 'consent', checked: '{{consentAccepted}}', disabled: '{{busy}}' },
  );
  const editor = institution.find((node) => node.tag === 'wu-f7-input')!;
  assert.equal(
    editor.attrs['bind:confirm'],
    undefined,
    'institutional search remains explicit, not an added keyboard submit',
  );
  assert.equal(editor.attrs.clearable, '{{false}}');
  assert.match(
    source('institutional-verification'),
    /当前不能进行真实学校登录/,
  );
  for (const page of ['verification', 'institutional-verification']) {
    assert.match(
      source(page),
      /\{\{item\.detail\}\}/,
      'full fact qualifications are visible in untruncated footer slots',
    );
  }
});

interface ComponentInstance {
  [name: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(update: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: ComponentInstance, event?: unknown) => unknown;
interface ComponentDefinition {
  properties: Record<string, { value: unknown }>;
  data: Record<string, unknown>;
  methods: Record<string, Method>;
  lifetimes?: Record<string, Method>;
  pageLifetimes?: Record<string, Method>;
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
type PageEvent = {
  detail: unknown;
  currentTarget: { dataset: Record<string, unknown> };
};
type PageOwner = { [name: string]: unknown };
function page(name: string): PageOwner {
  return registration<PageOwner>('Page', `pages/${name}/${name}.ts`);
}
function invoke(owner: PageOwner, handler: string, event?: PageEvent): unknown {
  return (owner[handler] as (event?: PageEvent) => unknown).call(owner, event);
}
function binding(
  pageName: string,
  handler: string,
  scope: object,
  event = 'press',
) {
  const node = flatten(parse(source(pageName))).find(
    (item) => item.attrs[`bind:${event}`] === handler,
  )!;
  assert.ok(node, `${pageName}: ${handler}`);
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
      .map(([key, value]) => [key.slice(5), evaluate(value)]),
  );
  const properties = Object.fromEntries(
    Object.entries(node.attrs)
      .filter(([key]) =>
        [
          'disabled',
          'loading',
          'link',
          'value',
          'maxlength',
          'clearable',
          'confirm-type',
        ].includes(key),
      )
      .map(([key, value]) => [
        key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        evaluate(value),
      ]),
  );
  return { node, dataset, properties };
}
function press(
  pageName: string,
  handler: string,
  scope: object,
  owner: PageOwner,
) {
  const bound = binding(pageName, handler, scope);
  const button = component(
    bound.node.tag.slice(3),
    bound.properties,
    (name, detail) => {
      assert.equal(name, 'press');
      assert.deepEqual(detail, {});
      void invoke(owner, handler, {
        detail,
        currentTarget: { dataset: bound.dataset },
      });
    },
  );
  button.call('onPress');
  return button;
}

test('real Input→campus Page keeps raw drafts, explicit searches, selection datasets and account fencing', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeProfileGateway();
  let view = initialCampusView();
  const controller = new CampusController(sessions, gateway, (next) => {
    view = next;
  });
  const owner = { ...page('campus'), controller };
  await controller.load();
  const count = gateway.calls.length;
  const editors = ['onQuery', 'onDistrict'].map((handler) => {
    const bound = binding('campus', handler, view, 'input');
    return component('f7-input', bound.properties, (name, detail) => {
      void invoke(owner, name === 'input' ? handler : 'onSearch', {
        detail,
        currentTarget: { dataset: {} },
      });
    });
  });
  try {
    for (const value of ['z', '中文候选', '  示例校园  '])
      editors[0]!.call('onInput', {
        detail: { value, cursor: value.length, keyCode: 229 },
      });
    editors[1]!.call('onInput', {
      detail: { value: '  示例地区  ', keyCode: 229 },
    });
    assert.equal(view.q, '  示例校园  ');
    assert.equal(view.district, '  示例地区  ');
    assert.equal(view.searchDirty, true);
    assert.equal(
      gateway.calls.length,
      count,
      'input must not dispatch a search',
    );
    press('campus', 'onChoose', { ...view, item: campus() }, owner);
    assert.equal(
      view.candidateId,
      '',
      'unsubmitted filter disables old result choice',
    );
    editors[0]!.call('onConfirm', { detail: { value: '  示例校园  ' } });
    await flush();
    assert.deepEqual(
      gateway.calls.filter((call) => call.method === 'campuses').slice(-1)[0]!
        .body,
      { q: '示例校园', district: '示例地区', page: 1, pageSize: 20 },
    );
    press('campus', 'onChoose', { ...view, item: campus() }, owner);
    assert.equal(view.candidateId, campusId);
    assert.equal(
      gateway.calls.filter((call) => call.method === 'select').length,
      0,
    );
    const pending = deferred<CampusPage>();
    gateway.campusesImpl = async () => pending.promise;
    press('campus', 'onSearch', view, owner);
    await flush();
    sessions.logout();
    pending.resolve({ items: [campus()], page: 1, pageSize: 20, total: 1 });
    await flush();
    assert.deepEqual(view.items, []);
    assert.equal(view.candidateId, '');
    const events = gateway.calls.length;
    for (const editor of editors) editor.hide();
    editors[0]!.call('onInput', { detail: { value: 'hidden' } });
    editors[0]!.call('onConfirm', { detail: { value: 'hidden' } });
    assert.equal(gateway.calls.length, events);
    invoke(owner, 'onHide');
    assert.equal(owner.controller, undefined);
  } finally {
    editors.forEach((editor) => editor.detach());
    controller.dispose();
  }
});

test('real choice-row→identity Page preserves two-step confirmation and does not change browsing campus', async () => {
  const f = identitySetup();
  const owner = { ...page('identity-campus'), controller: f.controller };
  try {
    await f.controller.load();
    const option = f.view().state!.options.items[0]!;
    press('identity-campus', 'onChoose', { ...f.view(), item: option }, owner);
    assert.equal(f.view().selectedId, option.id);
    assert.equal(f.view().confirmation, null);
    assert.equal(
      f.gateway.calls.filter((call) => call.method === 'select').length,
      0,
    );
    press('identity-campus', 'onRequestConfirmation', f.view(), owner);
    assert.equal(f.view().confirmation!.id, option.id);
    assert.equal(
      f.gateway.calls.filter((call) => call.method === 'select').length,
      0,
    );
    press('identity-campus', 'onDismissConfirmation', f.view(), owner);
    assert.equal(f.view().confirmation, null);
    assert.ok(
      f.gateway.calls.every((call) => call.method === 'state'),
      'choosing/confirming a draft never invokes browsing profile or authorization',
    );
    f.sessions.logout();
    press(
      'identity-campus',
      'onChoose',
      { ...f.view(), state: { canSelect: true }, item: option },
      owner,
    );
    assert.equal(
      f.view().selectedId,
      '',
      'stale row cannot revive identity after logout',
    );
    invoke(owner, 'onHide');
    assert.equal(owner.controller, undefined);
  } finally {
    f.controller.dispose();
  }
});

test('real login buttons respect configuration/busy guards; hide and teardown do not initiate auth', async () => {
  const sessions = new SessionStore();
  let view = initialLoginView();
  const controller = new LoginController({ sessions }, (next) => {
    view = next;
  });
  let routing = 0;
  const owner = {
    ...page('login'),
    controller,
    routeRestriction: async () => {
      routing++;
    },
  };
  const button = press('login', 'onLogin', view, owner);
  await flush();
  assert.equal(routing, 0, 'unconfigured button dispatches no Page event');
  button.instance.properties.disabled = false;
  button.call('onPress');
  await flush();
  assert.equal(routing, 1);
  assert.equal(view.verified, false);
  assert.match(view.error, /尚未配置/);
  button.instance.properties.loading = true;
  button.call('onPress');
  button.instance.properties.loading = false;
  button.hide();
  button.call('onPress');
  await flush();
  assert.equal(routing, 1);
  invoke(owner, 'onUnload');
  assert.equal(owner.controller, undefined);
  button.detach();
});

test('phone preparation/recovery use actual F7 events while native denial sends no code or verification success', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage();
  let view!: PhoneView;
  const calls: string[] = [];
  const requestId = '77777777-7777-4777-8777-777777777777';
  const gateway: PhoneGateway = {
    reserve: async () => {
      calls.push('reserve');
      return { requestId, state: 'reserved' };
    },
    read: async () => {
      calls.push('read');
      return { requestId, state: 'reserved' };
    },
    authorize: async () => {
      assert.fail('denied native permission cannot dispatch an authorization');
    },
    close: async () => {
      calls.push('close');
      return { requestId, state: 'closed' };
    },
  };
  const controller = new PhoneBindingController(
    sessions,
    gateway,
    storage,
    'https://api.synthetic.invalid',
    async () => requestId,
    (next) => {
      view = next;
    },
  );
  const owner = { ...page('phone-binding'), phone: controller };
  try {
    await controller.restore();
    press('phone-binding', 'onPrepare', view, owner);
    await flush();
    assert.deepEqual(calls, ['reserve']);
    assert.equal(view.phase, 'reserved');
    invoke(owner, 'onPhone', {
      detail: { errMsg: 'getPhoneNumber:fail user deny' },
      currentTarget: { dataset: {} },
    });
    await flush();
    assert.deepEqual(calls, ['reserve']);
    assert.notEqual(view.phase, 'verified');
    press('phone-binding', 'onRecover', view, owner);
    await flush();
    assert.deepEqual(calls, ['reserve', 'read']);
    invoke(owner, 'onHide');
    invoke(owner, 'onPhone', {
      detail: { errMsg: 'getPhoneNumber:ok', code: 'synthetic-late-code' },
      currentTarget: { dataset: {} },
    });
    await flush();
    assert.deepEqual(calls, ['reserve', 'read']);
    assert.doesNotMatch(
      JSON.stringify([...storage.data.values()]),
      /synthetic-late-code/,
    );
  } finally {
    controller.dispose();
  }
});

test('verification F7 refresh/cancel routes to independent reads, retains unknown context and scrubs stale results', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeVerificationGateway();
  let view = initialVerificationView(),
    uidLoads = 0;
  const controller = new VerificationController(
    sessions,
    gateway,
    (next) => {
      view = next;
    },
    new PrivateViewLifecycle(),
  );
  const owner = {
    ...page('verification'),
    controller,
    schoolUidController: {
      load: async () => {
        uidLoads++;
      },
      dispose() {},
    },
  };
  try {
    press('verification', 'onReload', view, owner);
    await flush();
    assert.equal(uidLoads, 1);
    assert.equal(gateway.calls.length, 1);
    assert.ok(view.rows.some((row) => row.detail.includes('不等于未验证')));
    const pending = deferred<ReturnType<typeof summary>>();
    gateway.implementation = async () => pending.promise;
    press('verification', 'onReload', view, owner);
    await flush();
    assert.equal(view.loading, true);
    press('verification', 'onCancel', view, owner);
    assert.equal(gateway.calls[gateway.calls.length - 1]!.isCancelled, true);
    pending.resolve(summary());
    await flush();
    assert.equal(view.loaded, false);
    assert.deepEqual(view.rows, []);
    sessions.logout();
    const count = gateway.calls.length;
    press('verification', 'onReload', view, owner);
    assert.equal(gateway.calls.length, count);
    invoke(owner, 'onHide');
    assert.equal(owner.controller, undefined);
  } finally {
    controller.dispose();
  }
});

test('institutional Input→Page keeps explicit query and current-campus fences; unavailable native port cannot authorize', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage(),
    profiles = new FakeProfileGateway();
  const calls: string[] = [];
  const forbidden = async (): Promise<never> => {
    assert.fail(
      'unavailable native authorization cannot dispatch mutation/provider actions',
    );
  };
  const gateway: InstitutionalGateway = {
    capability: async (id) => {
      calls.push(id);
      return {
        campusId: id,
        state: 'eligible',
        schoolName: '合成学校',
        capabilityVersion: 'a'.repeat(64),
        consent: institutionalConsent,
        purpose: institutionalPurpose,
        supportedFacts: ['affiliation', 'student_number'],
      };
    },
    prepare: forbidden,
    authorize: forbidden,
    read: forbidden,
    recover: forbidden,
    close: forbidden,
  };
  let view = initialInstitutionalView();
  const controller = new InstitutionalController(
    {
      sessions,
      profiles,
      gateway,
      journal: new PendingInstitutionalStore(
        storage,
        'https://api.synthetic.invalid',
      ),
      origin: 'https://api.synthetic.invalid',
      port: new UnavailableInstitutionalNativePort(),
      privateViews: new PrivateViewLifecycle(),
      newRequestId: forbidden,
    },
    (next) => {
      view = next;
    },
  );
  const owner = { ...page('institutional-verification'), controller };
  const bound = binding(
    'institutional-verification',
    'onSearchInput',
    view,
    'input',
  );
  const editor = component('f7-input', bound.properties, (name, detail) => {
    assert.equal(name, 'input');
    void invoke(owner, 'onSearchInput', {
      detail,
      currentTarget: { dataset: {} },
    });
  });
  try {
    editor.call('onInput', { detail: { value: '  合成学校  ', keyCode: 229 } });
    assert.equal(view.campusQuery, '  合成学校  ');
    assert.equal(profiles.calls.length, 0);
    press('institutional-verification', 'onSearch', view, owner);
    await flush();
    assert.equal(profiles.calls.length, 1);
    assert.equal(view.campuses[0]!.id, campusId);
    press(
      'institutional-verification',
      'onChooseCampus',
      { ...view, item: view.campuses[0] },
      owner,
    );
    await flush();
    assert.deepEqual(calls, [campusId]);
    assert.equal(view.nativeAvailable, false);
    assert.match(view.message, /没有可用的安全原生学校授权入口/);
    invoke(owner, 'onConsent', {
      detail: { value: ['consent'] },
      currentTarget: { dataset: {} },
    });
    press('institutional-verification', 'onPrepare', view, owner);
    await flush();
    assert.equal(view.frozen, false);
    assert.equal(storage.data.size, 0);
    const pending = deferred<CampusPage>();
    profiles.campusesImpl = async () => pending.promise;
    press('institutional-verification', 'onSearch', view, owner);
    await flush();
    invoke(owner, 'onHide');
    pending.resolve({ items: [campus()], page: 1, pageSize: 20, total: 1 });
    await flush();
    assert.deepEqual(view.campuses, []);
    assert.equal(view.capability, null);
    assert.equal(owner.controller, undefined);
    editor.hide();
    editor.call('onInput', { detail: { value: 'late draft' } });
    assert.notEqual(view.campusQuery, 'late draft');
  } finally {
    editor.detach();
    controller.dispose();
  }
});

test('synthetic identity fixtures cover all six routes without provider activation or private values', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-identity-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      title: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(fixtures.length, 32);
  assert.deepEqual(
    [...new Set(fixtures.map((item) => item.page))].sort(),
    Object.keys(before).sort(),
  );
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^framework7-identity-/);
    assert.ok(fixture.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accessToken|refreshToken|accountId|providerId|wxfile:\/\/|phoneNumber|studentNumberValue/,
    );
    if (fixture.page === 'institutional-verification')
      assert.equal(fixture.patch.nativeAvailable, false);
  }
  for (const condition of ['denied', 'unavailable', 'error'])
    assert.ok(fixtures.some((item) => item.id.includes(condition)));
  assert.ok(fixtures.some((item) => item.patch.phase === 'reserved'));
  assert.ok(fixtures.some((item) => item.patch.phase === 'processing'));
  assert.ok(fixtures.some((item) => item.patch.frozen === true));
});
