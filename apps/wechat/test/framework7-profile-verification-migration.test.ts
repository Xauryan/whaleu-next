import { assertReviewedBusinessSuccessor } from './reviewed-business-successor';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  ProfileController,
  initialProfileView,
} from '../src/pages/profile/controller';
import {
  ProfileDetailsController,
  initialProfileDetailsView,
} from '../src/profile/details-controller';
import {
  profileDetailDefaults,
  type OwnProfileDetails,
  type ProfileDetailsPatch,
} from '../src/profile/details-contract';
import type { ProfileDetailsGateway } from '../src/profile/details-gateway';
import { evidenceUploadDescriptor } from '../src/verification/evidence-contract';
import type { VerificationEvidenceReadView } from '../src/verification/evidence-runtime';
import {
  initialStudentView,
  StudentVerificationController,
  type StudentEvidenceRuntime,
} from '../src/verification/student-controller';
import type {
  StudentApplication,
  StudentNotice,
} from '../src/verification/student-contract';
import type { HttpStudentVerificationGateway } from '../src/verification/student-gateway';
import { StudentCommandJournal } from '../src/verification/student-pending';
import {
  normalizeFramework7ActionNode,
  type PresentationNode,
} from './framework7-action-parity';
import { setup as communitySetup } from './community-helpers';
import { deferred, flush, MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { campus, campusId, FakeProfileGateway } from './profile-helpers';

const root = path.join(__dirname, '..');
const requireNative = createRequire(__filename);
const { parsePreviewWxml: parse } = requireNative(
  '../scripts/preview-wxml.mjs',
) as { parsePreviewWxml(source: string): PresentationNode };
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const source = (page: string, ext = 'wxml') =>
  read(`src/pages/${page}/${page}.${ext}`);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const flatten = (node: PresentationNode): PresentationNode[] => [
  node,
  ...node.children.flatMap((child) =>
    typeof child === 'string' ? [] : flatten(child),
  ),
];
interface Action {
  tag: string;
  attrs: Record<string, string>;
  scopes: Record<string, string>[];
}
const before = JSON.parse(
  read('test/fixtures/framework7-profile-verification-before-actions.json'),
) as Record<
  string,
  { sourceSha256: string; typescriptSha256: string; actions: Action[] }
>;
const protectedFiles = JSON.parse(
  read('test/fixtures/framework7-profile-verification-before-protected.json'),
) as Record<string, string>;
function normalize(raw: PresentationNode): PresentationNode {
  if (raw.tag !== 'wu-f7-input') return normalizeFramework7ActionNode(raw);
  const { ['bind:input']: input, ...attrs } = raw.attrs;
  return {
    ...raw,
    tag: 'input',
    attrs: { ...attrs, ...(input ? { bindinput: input } : {}) },
  };
}
function actions(
  raw: PresentationNode,
  parents: Record<string, string>[] = [],
): Action[] {
  const node = normalize(raw);
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
function conditionalChains(node: PresentationNode): void {
  const children = node.children.filter(
    (child): child is PresentationNode => typeof child !== 'string',
  );
  for (const [index, child] of children.entries()) {
    if ('wx:elif' in child.attrs || 'wx:else' in child.attrs) {
      const previous = children[index - 1];
      assert.ok(
        previous && ('wx:if' in previous.attrs || 'wx:elif' in previous.attrs),
        `${child.tag} conditional chain`,
      );
    }
    conditionalChains(child);
  }
}
for (const [name, baseline] of Object.entries(before)) {
  test(`${name}: all original actions, exact guard ancestry, datasets and native constraints survive`, () => {
    const tree = parse(source(name));
    const current = actions(tree);
    assert.equal(current.length, baseline.actions.length);
    for (const original of baseline.actions) {
      const index = current.findIndex(
        (candidate) =>
          candidate.tag === original.tag &&
          JSON.stringify(candidate.scopes) ===
            JSON.stringify(original.scopes) &&
          Object.entries(original.attrs).every(
            ([key, value]) => candidate.attrs[key] === value,
          ),
      );
      assert.notEqual(index, -1, JSON.stringify(original));
      current.splice(index, 1);
    }
    assert.equal(current.length, 0);
    assert.equal(hash(source(name, 'ts')), baseline.typescriptSha256);
    conditionalChains(tree);
  });
  test(`${name}: registered source-native components do not nest action controls or add overlays`, () => {
    const nodes = flatten(parse(source(name)));
    const config = JSON.parse(source(name, 'json')) as {
      usingComponents: Record<string, string>;
    };
    for (const kind of ['block', 'button', 'list', 'list-item'])
      assert.ok(
        nodes.some((node) => node.tag === `wu-f7-${kind}`),
        kind,
      );
    for (const node of nodes.filter((item) => item.tag.startsWith('wu-f7-'))) {
      const component = node.tag.slice(3);
      assert.equal(
        config.usingComponents[node.tag],
        `../../components/${component}/${component}`,
      );
      assert.equal(node.attrs['open-type'], undefined);
      if (node.tag === 'wu-f7-list-item') {
        assert.ok(
          !flatten(node)
            .slice(1)
            .some((child) =>
              /^(button|input|textarea|switch|navigator|wu-f7-button|wu-f7-input|wu-f7-toggle)$/.test(
                child.tag,
              ),
            ),
        );
        if (node.attrs['bind:press']) assert.equal(node.attrs.link, '{{true}}');
      }
      if (node.tag === 'wu-f7-list')
        assert.ok(
          !flatten(node)
            .slice(1)
            .some((child) => child.tag === 'wu-f7-list'),
        );
    }
    assert.ok(
      !nodes.some((node) =>
        /^(input|switch|wu-f7-sheet|wu-f7-dialog|wu-f7-actions)$/.test(
          node.tag,
        ),
      ),
    );
    assert.match(source(name, 'wxss'), /framework7-profile-verification\.wxss/);
    assert.doesNotMatch(
      source(name),
      /<web-view|<script|https?:\/\/|data:image|rich-text/,
    );
  });
}
test('accepted pages, all profile/student/private-media controllers, native files and owner fences remain byte-identical except explicit reviewed business successors', () => {
  assert.equal(Object.keys(protectedFiles).length, 90);
  for (const [file, expected] of Object.entries(protectedFiles).filter(
    ([file, expected]) => !assertReviewedBusinessSuccessor(file, expected),
  ))
    assert.equal(hash(read(file)), expected, file);
});
test('gender picker, multiline bio and circular avatar controls remain genuine native elements', () => {
  const nodes = flatten(parse(source('profile')));
  const picker = nodes.find((node) => node.tag === 'picker')!;
  assert.equal(picker.attrs.bindchange, 'onDetailsGender');
  assert.equal(picker.attrs.range, '{{detailGenderLabels}}');
  assert.equal(
    picker.attrs.value,
    "{{details.gender === 'female' ? 1 : details.gender === 'male' ? 2 : 0}}",
  );
  assert.deepEqual(
    nodes
      .filter((node) => node.tag === 'button')
      .map((node) => node.attrs.class),
    ['editor-avatar-button', 'editor-avatar-badge'],
  );
  const bio = nodes.find((node) => node.tag === 'textarea')!;
  assert.equal(bio.attrs.bindinput, 'onBio');
  assert.equal(bio.attrs['auto-height'], '{{true}}');
  assert.equal(bio.attrs.maxlength, '-1');
  assert.match(source('profile'), /不收集生日/);
  assert.doesNotMatch(source('profile'), /type="date"|gender === 'other'/);
  for (const page of ['profile', 'student-verification'])
    for (const node of flatten(parse(source(page))).filter(
      (item) => item.tag === 'wu-f7-input',
    )) {
      assert.equal(node.attrs.clearable, '{{false}}');
      assert.equal(
        node.attrs['bind:confirm'],
        undefined,
        'no new keyboard submit path',
      );
    }
});

interface Instance {
  [name: string]: unknown;
  properties: Record<string, unknown>;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
  triggerEvent(name: string, detail: unknown, options: unknown): void;
}
type Method = (this: Instance, event?: unknown) => unknown;
interface Definition {
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
  emit: (name: string, detail: unknown) => void,
) {
  const definition = registration<Definition>(
    'Component',
    `components/${name}/${name}.ts`,
  );
  const instance: Instance = {
    properties: {
      ...Object.fromEntries(
        Object.entries(definition.properties).map(([key, value]) => [
          key,
          structuredClone(value.value),
        ]),
      ),
      ...properties,
    },
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
    triggerEvent(name, detail, options) {
      assert.deepEqual(options, { bubbles: false, composed: false });
      emit(name, detail);
    },
  };
  for (const [key, method] of Object.entries(definition.methods))
    instance[key] = method.bind(instance);
  definition.lifetimes?.attached?.call(instance);
  return {
    instance,
    call: (method: string, event?: unknown) =>
      definition.methods[method]!.call(instance, event),
    hide: () => definition.pageLifetimes?.hide?.call(instance),
    detach: () => definition.lifetimes?.detached?.call(instance),
  };
}
type Owner = {
  [key: string]: unknown;
  data: Record<string, unknown>;
  setData(value: Record<string, unknown>): void;
};
type PageEvent = {
  detail: unknown;
  currentTarget: { dataset: Record<string, unknown> };
};
function owner(page: string, patch: Record<string, unknown> = {}): Owner {
  const definition = registration<Owner>('Page', `pages/${page}/${page}.ts`);
  return {
    ...definition,
    data: structuredClone(definition.data),
    setData(value) {
      Object.assign(this.data, value);
    },
    ...patch,
  };
}
function invoke(page: Owner, method: string, event?: PageEvent) {
  return (page[method] as (event?: PageEvent) => unknown).call(page, event);
}
function binding(
  page: string,
  handler: string,
  scope: object,
  event = 'press',
  datasetKey?: string,
) {
  const node = flatten(parse(source(page))).find(
    (item) =>
      item.attrs[`bind:${event}`] === handler &&
      (!datasetKey || item.attrs['data-key'] === datasetKey),
  )!;
  assert.ok(node, `${page}: ${handler}`);
  const evaluate = (raw: string): unknown =>
    raw.startsWith('{{') && raw.endsWith('}}')
      ? Function('scope', `with(scope){return (${raw.slice(2, -2)});}`)(scope)
      : /^-?\d+$/.test(raw)
        ? Number(raw)
        : raw;
  return {
    node,
    dataset: Object.fromEntries(
      Object.entries(node.attrs)
        .filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5), evaluate(value)]),
    ),
    properties: Object.fromEntries(
      Object.entries(node.attrs)
        .filter(([key]) =>
          [
            'disabled',
            'loading',
            'link',
            'value',
            'checked',
            'maxlength',
            'clearable',
            'type',
            'confirm-type',
          ].includes(key),
        )
        .map(([key, value]) => [
          key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          evaluate(value),
        ]),
    ),
  };
}
function connect(
  page: string,
  handler: string,
  scope: object,
  target: Owner,
  event = 'press',
  datasetKey?: string,
) {
  const bound = binding(page, handler, scope, event);
  const specific = datasetKey
    ? binding(page, handler, scope, event, datasetKey)
    : bound;
  const emitted: { name: string; detail: unknown }[] = [];
  const native = component(
    specific.node.tag.slice(3),
    specific.properties,
    (name, detail) => {
      emitted.push({ name, detail });
      if (name === event)
        void invoke(target, handler, {
          detail,
          currentTarget: { dataset: specific.dataset },
        });
    },
  );
  return { ...native, emitted };
}
function press(page: string, handler: string, scope: object, target: Owner) {
  const native = connect(page, handler, scope, target);
  native.call('onPress');
  return native;
}

test('real Input→profile Page keeps IME drafts and only explicit Save writes; avatar locks and hide fence later input', async () => {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new FakeProfileGateway();
  const target = owner('profile');
  let view = initialProfileView();
  const controller = new ProfileController(sessions, gateway, (next) => {
    view = next;
    target.setData(next as unknown as Record<string, unknown>);
  });
  target.controller = controller;
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.getApp;
  globals.getApp = () => ({});
  await controller.load();
  const field = connect('profile', 'onNickname', target.data, target, 'input');
  try {
    field.call('onFocus', { detail: { height: 280 } });
    for (const value of ['x', '中文候选', '  示例用户  '])
      assert.equal(
        field.call('onInput', {
          detail: { value, cursor: value.length, keyCode: 229 },
        }),
        undefined,
      );
    assert.equal(view.nickname, '  示例用户  ');
    field.call('onBlur', { detail: { value: '  示例用户  ' } });
    field.call('onConfirm', { detail: { value: '  示例用户  ' } });
    assert.equal(
      gateway.calls.filter((call) => call.method === 'updateProfile').length,
      0,
    );
    invoke(target, 'onBio', {
      detail: { value: '第一行\n第二行' },
      currentTarget: { dataset: {} },
    });
    press('profile', 'onSaveProfile', target.data, target);
    await flush();
    assert.deepEqual(
      gateway.calls.find((call) => call.method === 'updateProfile')?.body,
      { expectedRevision: 0, nickname: '示例用户', bio: '第一行\n第二行' },
    );
    target.data.avatar = {
      ...(target.data.avatar as object),
      needsRecovery: true,
    };
    const locked = connect(
      'profile',
      'onNickname',
      target.data,
      target,
      'input',
    );
    locked.call('onInput', { detail: { value: 'cannot edit' } });
    assert.equal(locked.emitted.length, 0);
    field.call('onInput', { detail: { value: 'stale component' } });
    assert.equal(
      view.nickname,
      '示例用户',
      'Page also rejects stale input during avatar recovery',
    );
    invoke(target, 'onHide');
    assert.equal(target.controller, undefined);
    field.hide();
    field.call('onInput', { detail: { value: 'late IME' } });
    assert.equal(field.instance.data.focused, false);
    assert.equal(target.data.nickname, '');
    assert.equal(
      gateway.calls.filter((call) => call.method === 'updateProfile').length,
      1,
    );
    locked.detach();
  } finally {
    field.detach();
    controller.dispose();
    globals.getApp = previous;
  }
});

test('real Input/Toggle→profile Page preserves independent private defaults, raw region/age, exact gender mapping and revisioned save', async () => {
  const setup = communitySetup();
  const sent: ProfileDetailsPatch[] = [];
  let current: OwnProfileDetails = {
    accountId: wireCredentials().accountId,
    revision: 0,
    ...profileDetailDefaults(),
  };
  const gateway: ProfileDetailsGateway = {
    public: async () => {
      throw new Error('Own-profile editing must not fetch public details');
    },
    own: async () => current,
    update: async (patch: ProfileDetailsPatch) => {
      sent.push(patch);
      const { expectedRevision, ...fields } = patch;
      current = {
        accountId: current.accountId,
        revision: expectedRevision + 1,
        ...fields,
      };
      return current;
    },
  };
  const target = owner('profile');
  let view = initialProfileDetailsView();
  const controller = new ProfileDetailsController(
    setup.runtime,
    gateway,
    (next) => {
      view = next;
      target.setData({ details: next });
    },
  );
  target.detailsController = controller;
  await controller.load();
  const region = connect(
    'profile',
    'onDetailsRegion',
    target.data,
    target,
    'input',
  );
  const age = connect('profile', 'onDetailsAge', target.data, target, 'input');
  try {
    region.call('onInput', {
      detail: { value: '  示例地区  ', cursor: 8, keyCode: 229 },
    });
    age.call('onInput', { detail: { value: '21' } });
    assert.equal(view.regionInput, '  示例地区  ');
    for (const [value, gender] of [
      ['1', 'female'],
      ['2', 'male'],
      ['0', null],
      ['1', 'female'],
    ] as const) {
      invoke(target, 'onDetailsGender', {
        detail: { value },
        currentTarget: { dataset: {} },
      });
      assert.equal(view.gender, gender);
    }
    invoke(target, 'onDetailsGender', {
      detail: { value: '999' },
      currentTarget: { dataset: {} },
    });
    assert.equal(view.gender, 'female');
    assert.deepEqual(
      [view.showRegion, view.showGender, view.showAge],
      [false, false, false],
    );
    const toggle = connect(
      'profile',
      'onDetailsVisibility',
      target.data,
      target,
      'change',
      'showRegion',
    );
    toggle.call('onChange', { detail: { value: true } });
    assert.deepEqual(toggle.emitted, [
      { name: 'change', detail: { value: true } },
    ]);
    assert.deepEqual(
      [view.showRegion, view.showGender, view.showAge],
      [true, false, false],
    );
    assert.equal(sent.length, 0);
    press('profile', 'onSaveDetails', target.data, target);
    await flush();
    assert.deepEqual(sent, [
      {
        expectedRevision: 0,
        region: '示例地区',
        gender: 'female',
        age: 21,
        showRegion: true,
        showGender: false,
        showAge: false,
      },
    ]);
    age.call('onInput', { detail: { value: '200' } });
    press('profile', 'onSaveDetails', target.data, target);
    await flush();
    assert.match(view.validationError, /0–120/);
    assert.equal(sent.length, 1);
    press('profile', 'onCancelDetails', target.data, target);
    assert.equal(view.ageInput, '21');
    setup.sessions.logout();
    assert.equal(view.regionInput, '');
    assert.equal(view.gender, null);
    assert.equal(view.showRegion, false);
    region.hide();
    age.hide();
    toggle.hide();
    region.call('onInput', { detail: { value: 'late private draft' } });
    toggle.call('onChange', { detail: { value: true } });
    assert.equal(view.regionInput, '');
    assert.equal(view.showRegion, false);
    toggle.detach();
  } finally {
    region.detach();
    age.detach();
    controller.dispose();
  }
});

test('real media action components→profile Page delegate exact original avatar/cover recovery and native-picker teardown paths', async () => {
  const target = owner('profile');
  const calls: string[] = [];
  const mock = (prefix: string) =>
    Object.fromEntries(
      [
        'chooseCustomAvatar',
        'chooseCustomCover',
        'selectClear',
        'save',
        'recover',
        'cancelPendingCommand',
        'cancelPendingEdit',
        'cancelOperation',
        'load',
        'dispose',
        'hide',
      ].map((method) => [
        method,
        (...args: unknown[]) => {
          calls.push(`${prefix}.${method}:${JSON.stringify(args)}`);
        },
      ]),
    );
  target.avatarController = {
    ...mock('avatar'),
    selectCatalog: (item: string) => {
      calls.push(`catalog:${item}`);
    },
  };
  target.coverController = {
    ...mock('cover'),
    isNativePickerPending: () => true,
  };
  target.coverReader = { dispose: () => calls.push('cover.reader.dispose') };
  target.controller = {
    load: () => calls.push('profile.load'),
    dispose: () => calls.push('profile.dispose'),
  };
  const scope = {
    ...target.data,
    loading: false,
    saving: false,
    profileDirty: false,
    preferencesDirty: false,
    avatar: { loaded: true, canChoose: true, busy: false },
    cover: { loaded: true, canChoose: true, busy: false },
    item: { itemId: 'catalog-owned' },
  };
  target.setData(scope);
  const routes: Record<string, string> = {
    onChooseCustomAvatar: 'avatar.chooseCustomAvatar:[]',
    onAvatarCatalog: 'catalog:catalog-owned',
    onClearAvatar: 'avatar.selectClear:[]',
    onSaveAvatar: 'avatar.save:[]',
    onRecoverAvatar: 'avatar.recover:[]',
    onRetryAvatar: 'avatar.recover:[true]',
    onCancelAvatarCommand: 'avatar.cancelPendingCommand:[]',
    onCancelAvatarEdit: 'avatar.cancelPendingEdit:[]',
    onStopAvatar: 'avatar.cancelOperation:[]',
    onReloadAvatar: 'profile.load',
    onChooseCover: 'cover.chooseCustomCover:[]',
    onClearCover: 'cover.selectClear:[]',
    onSaveCover: 'cover.save:[]',
    onRecoverCover: 'cover.recover:[]',
    onRetryCover: 'cover.recover:[true]',
    onCancelCoverCommand: 'cover.cancelPendingCommand:[]',
    onCancelCoverEdit: 'cover.cancelPendingEdit:[]',
    onStopCover: 'cover.cancelOperation:[]',
  };
  for (const [handler, expected] of Object.entries(routes)) {
    const component = press('profile', handler, scope, target);
    await flush();
    assert.ok(calls.includes(expected), handler);
    component.detach();
  }
  const count = calls.length;
  press(
    'profile',
    'onChooseCustomAvatar',
    { ...scope, profileDirty: true },
    target,
  );
  press(
    'profile',
    'onChooseCover',
    { ...scope, cover: { ...scope.cover, busy: true } },
    target,
  );
  assert.equal(calls.length, count);
  invoke(target, 'onHide');
  assert.ok(calls.includes('cover.hide:[]'));
  assert.ok(
    !calls.includes('cover.dispose:[]'),
    'pending native picker is hidden rather than prematurely destroyed',
  );
  assert.ok(calls.includes('avatar.dispose:[]'));
  invoke(target, 'onUnload');
  assert.ok(calls.includes('cover.dispose:[]'));
  assert.equal(target.coverController, undefined);
});

function studentHarness(mode: 'own' | 'notices' = 'own') {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const storage = new MemoryStorage();
  const journal = new StudentCommandJournal(storage, 'https://example.invalid');
  const privateViews = new PrivateViewLifecycle();
  const profiles = new FakeProfileGateway();
  const target = owner(
    mode === 'own' ? 'student-verification' : 'student-verification-notices',
  );
  const applicationId = randomUUID(),
    regionId = randomUUID(),
    noticeId = randomUUID();
  let application: StudentApplication | null = null;
  let view = initialStudentView();
  const calls: { method: string; input?: unknown }[] = [];
  const evidence = evidenceUploadDescriptor(randomUUID());
  let readerRender!: (value: VerificationEvidenceReadView) => void;
  const media = {
    reconcile: async (cleanup?: boolean) => {
      calls.push({ method: 'reconcile', input: cleanup });
    },
    createUploader: () => ({
      clear() {
        calls.push({ method: 'uploader.clear' });
      },
      dispose() {
        calls.push({ method: 'uploader.dispose' });
      },
      pick: async (input: unknown) => {
        calls.push({ method: 'pick', input });
        return evidence;
      },
      recover: async (input: unknown) => {
        calls.push({ method: 'recoverEvidence', input });
        return evidence;
      },
    }),
    createReader: (render: (value: VerificationEvidenceReadView) => void) => {
      readerRender = render;
      return {
        clear() {
          calls.push({ method: 'reader.clear' });
          render({ status: 'idle', src: '', message: '' });
        },
        dispose() {
          calls.push({ method: 'reader.dispose' });
        },
        load: async (input: unknown) => {
          calls.push({ method: 'preview', input });
          render({
            status: 'ready',
            src: 'wxfile://tmp/synthetic-evidence',
            message: '',
          });
        },
      };
    },
  } as unknown as StudentEvidenceRuntime;
  const notice: StudentNotice = {
    id: noticeId,
    kind: 'auth_result',
    outcome: 'approved',
    createdAt: '2026-10-20T10:00:00.000Z',
    read: false,
    available: true,
  };
  const gateway = {
    own: async () => ({ application, canApply: application === null }),
    reserve: async (input: { clientRequestId: string; campusId: string }) => {
      calls.push({ method: 'reserve', input });
      application = {
        id: applicationId,
        revision: 1,
        state: 'draft',
        campusId: input.campusId,
        campusName: '示例校区',
        institutionName: '示例大学',
        regionId,
        profileId: null,
        submittedAt: null,
        reason: null,
        evidenceRevision: null,
        evidenceAvailable: false,
        evidenceExpiresAt: null,
      };
      return {
        requestId: input.clientRequestId,
        applicationId,
        revision: 1,
        state: 'draft',
      };
    },
    submit: async (
      id: string,
      input: {
        clientRequestId: string;
        expectedRevision: number;
        evidence: unknown;
      },
    ) => {
      calls.push({ method: 'submit', input: { id, ...input } });
      application = {
        ...application!,
        revision: input.expectedRevision + 1,
        state: 'pending',
        evidenceRevision: 1,
        evidenceAvailable: true,
        evidenceExpiresAt: '2026-11-20T10:00:00.000Z',
      };
      return {
        requestId: input.clientRequestId,
        applicationId,
        revision: application.revision,
        state: application.state,
      };
    },
    withdraw: async (
      id: string,
      input: { clientRequestId: string; expectedRevision: number },
    ) => {
      calls.push({ method: 'withdraw', input: { id, ...input } });
      application = {
        ...application!,
        revision: input.expectedRevision + 1,
        state: 'withdrawn',
        evidenceAvailable: false,
      };
      return {
        requestId: input.clientRequestId,
        applicationId,
        revision: application.revision,
        state: application.state,
      };
    },
    notices: async (page: number) => {
      calls.push({ method: 'notices', input: page });
      return { items: [notice], page, hasNext: page === 1 };
    },
    noticeRead: async (id: string) => {
      calls.push({ method: 'noticeRead', input: id });
      return { status: 'unavailable', target: null };
    },
    noticeTarget: async (id: string) => {
      calls.push({ method: 'noticeTarget', input: id });
      return { status: 'available', target: { applicationId, regionId: null } };
    },
    recover: async (requestId: string) => {
      calls.push({ method: 'recover', input: requestId });
      return { requestId, state: 'not_recorded', receipt: null };
    },
    cancelRequest: async (requestId: string, requestHash: string) => {
      calls.push({
        method: 'cancelRequest',
        input: { requestId, requestHash },
      });
      return { requestId, state: 'cancelled', receipt: null };
    },
  } as unknown as HttpStudentVerificationGateway;
  const controller = new StudentVerificationController(
    {
      sessions,
      gateway,
      profiles,
      journal,
      media,
      privateViews,
      newRequestId: async () => randomUUID(),
      render: (next) => {
        view = next;
        target.setData(next as unknown as Record<string, unknown>);
      },
    },
    mode,
  );
  target.controller = controller;
  return {
    sessions,
    storage,
    journal,
    privateViews,
    profiles,
    target,
    controller,
    gateway,
    calls,
    evidence,
    notice,
    applicationId,
    regionId,
    view: () => view,
    expire: () => {
      application = {
        ...application!,
        state: 'expired',
        evidenceAvailable: false,
      };
    },
    late: () =>
      readerRender({
        status: 'ready',
        src: 'wxfile://tmp/stale-evidence',
        message: '',
      }),
  };
}
async function prepare(f: ReturnType<typeof studentHarness>) {
  await f.controller.load();
  press('student-verification', 'onSearch', f.view(), f.target);
  await flush();
  press(
    'student-verification',
    'onChooseCampus',
    { ...f.view(), item: campus() },
    f.target,
  );
  press('student-verification', 'onPrepare', f.view(), f.target);
  await flush();
  assert.equal(f.view().application?.state, 'draft');
}
test('real Input/ListItem/Button→student Page completes choose/reserve/upload/confirm/preview/withdraw without accidental submit', async () => {
  const f = studentHarness();
  await f.controller.load();
  const editor = connect(
    'student-verification',
    'onSearchInput',
    f.view(),
    f.target,
    'input',
  );
  try {
    editor.call('onFocus', { detail: { height: 240 } });
    editor.call('onInput', {
      detail: { value: '  示例校区  ', cursor: 8, keyCode: 229 },
    });
    editor.call('onConfirm', { detail: { value: '  示例校区  ' } });
    assert.equal(f.view().campusQuery, '  示例校区  ');
    assert.equal(
      f.profiles.calls.length,
      0,
      'typing and keyboard confirm do not submit an explicit search',
    );
    press('student-verification', 'onSearch', f.view(), f.target);
    await flush();
    assert.deepEqual(f.profiles.calls[0]!.body, {
      q: '  示例校区  ',
      district: '',
      page: 1,
      pageSize: 20,
    });
    press(
      'student-verification',
      'onChooseCampus',
      { ...f.view(), item: campus() },
      f.target,
    );
    assert.equal(f.view().selectedCampusId, campusId);
    assert.ok(!f.calls.some((call) => call.method === 'reserve'));
    press('student-verification', 'onPrepare', f.view(), f.target);
    await flush();
    assert.equal(f.view().application?.state, 'draft');
    press('student-verification', 'onSubmit', f.view(), f.target);
    assert.equal(f.view().confirmation, '', 'no upload means no confirmation');
    press('student-verification', 'onChooseEvidence', f.view(), f.target);
    await flush();
    assert.deepEqual(f.calls.find((call) => call.method === 'pick')?.input, {
      applicationId: f.applicationId,
      revision: 1,
    });
    assert.equal(f.view().evidenceReady, true);
    press('student-verification', 'onSubmit', f.view(), f.target);
    assert.equal(f.view().confirmation, 'submit');
    assert.ok(!f.calls.some((call) => call.method === 'submit'));
    press('student-verification', 'onDismiss', f.view(), f.target);
    assert.equal(f.view().confirmation, '');
    press('student-verification', 'onSubmit', f.view(), f.target);
    press('student-verification', 'onConfirm', f.view(), f.target);
    await flush();
    assert.equal(f.view().application?.state, 'pending');
    const submission = f.calls.find((call) => call.method === 'submit')!
      .input as Record<string, unknown>;
    assert.equal(submission.id, f.applicationId);
    assert.equal(submission.expectedRevision, 1);
    assert.deepEqual(submission.evidence, f.evidence);
    assert.equal(JSON.stringify(submission).includes('wxfile'), false);
    press('student-verification', 'onPreview', f.view(), f.target);
    await flush();
    assert.equal(f.view().evidenceSrc, 'wxfile://tmp/synthetic-evidence');
    assert.deepEqual(f.calls.find((call) => call.method === 'preview')?.input, {
      applicationId: f.applicationId,
      revision: 1,
      reviewRegionId: null,
    });
    press('student-verification', 'onClosePreview', f.view(), f.target);
    assert.equal(f.view().evidenceSrc, '');
    press('student-verification', 'onWithdraw', f.view(), f.target);
    assert.equal(f.view().confirmation, 'withdraw');
    assert.ok(!f.calls.some((call) => call.method === 'withdraw'));
    press('student-verification', 'onConfirm', f.view(), f.target);
    await flush();
    assert.equal(f.view().application?.state, 'withdrawn');
    assert.ok(
      f.calls.some(
        (call) => call.method === 'reconcile' && call.input === true,
      ),
    );
    assert.equal(f.storage.data.size, 0);
    editor.hide();
    editor.call('onInput', { detail: { value: 'hidden draft' } });
    assert.equal(f.view().campusQuery, '  示例校区  ');
  } finally {
    editor.detach();
    f.controller.dispose();
  }
});
test('real student recovery controls reuse one journaled request, fence busy/pending actions and never reupload unknown evidence', async () => {
  const f = studentHarness();
  try {
    await prepare(f);
    press('student-verification', 'onRecoverEvidence', f.view(), f.target);
    await flush();
    assert.equal(
      f.calls.filter((call) => call.method === 'recoverEvidence').length,
      1,
    );
    f.gateway.submit = async (_id, input) => {
      f.calls.push({ method: 'failedSubmit', input });
      throw new ClientError('network', 'Lost response');
    };
    press('student-verification', 'onSubmit', f.view(), f.target);
    press('student-verification', 'onConfirm', f.view(), f.target);
    await flush();
    assert.equal(f.view().pending, true);
    const original = f.journal.read(wireCredentials().accountId)!;
    assert.equal(original.operation, 'submit');
    const count = f.calls.length;
    press('student-verification', 'onChooseEvidence', f.view(), f.target);
    press('student-verification', 'onSubmit', f.view(), f.target);
    press('student-verification', 'onCleanup', f.view(), f.target);
    assert.equal(f.calls.length, count);
    press('student-verification', 'onRecover', f.view(), f.target);
    await flush();
    assert.deepEqual(
      f.calls.find((call) => call.method === 'recover')?.input,
      original.requestId,
    );
    assert.ok(f.journal.read(wireCredentials().accountId));
    press('student-verification', 'onCancelRequest', f.view(), f.target);
    await flush();
    assert.deepEqual(
      f.calls.find((call) => call.method === 'cancelRequest')?.input,
      { requestId: original.requestId, requestHash: original.requestHash },
    );
    assert.equal(f.journal.read(wireCredentials().accountId), null);
    assert.equal(
      f.calls.filter((call) => call.method === 'failedSubmit').length,
      1,
    );
    assert.equal(f.calls.filter((call) => call.method === 'pick').length, 0);
    assert.doesNotMatch(
      JSON.stringify([...f.storage.data.values()]),
      /wxfile|evidence|realName|studentNumber/,
    );
  } finally {
    f.controller.dispose();
  }
});
test('student private material closes on expiry, app hide, account replacement and late reader callbacks', async () => {
  for (const fence of ['hide', 'logout', 'privacy'] as const) {
    const f = studentHarness();
    await prepare(f);
    press('student-verification', 'onChooseEvidence', f.view(), f.target);
    await flush();
    press('student-verification', 'onSubmit', f.view(), f.target);
    press('student-verification', 'onConfirm', f.view(), f.target);
    await flush();
    press('student-verification', 'onPreview', f.view(), f.target);
    await flush();
    assert.ok(f.view().evidenceSrc);
    if (fence === 'hide') invoke(f.target, 'onHide');
    else if (fence === 'logout') f.sessions.logout();
    else f.privateViews.clear();
    f.late();
    assert.equal(f.view().evidenceSrc, '');
    assert.equal(f.view().application, null);
    assert.equal(f.view().evidenceReady, false);
    if (fence === 'hide') assert.equal(f.target.controller, undefined);
    f.controller.dispose();
  }
  const expired = studentHarness();
  await prepare(expired);
  expired.expire();
  await expired.controller.load();
  const count = expired.calls.length;
  // Even a stale host dispatch cannot revive expiry-disabled private access.
  press('student-verification', 'onPreview', expired.view(), expired.target);
  assert.equal(expired.calls.length, count);
  assert.equal(expired.view().evidenceSrc, '');
  expired.controller.dispose();
});
test('real notice buttons→Page use exact IDs, authoritative read state, page bounds and current-owner navigation', async () => {
  const f = studentHarness('notices');
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.wx;
  const navigations: string[] = [];
  globals.wx = {
    navigateTo: ({ url }: { url: string }) => {
      navigations.push(url);
    },
  };
  try {
    await f.controller.load();
    press(
      'student-verification-notices',
      'onReadNotice',
      { ...f.view(), item: f.notice },
      f.target,
    );
    await flush();
    assert.equal(
      f.calls.find((call) => call.method === 'noticeRead')?.input,
      f.notice.id,
    );
    assert.equal(
      f.view().notices[0]!.read,
      false,
      'unavailable read result must not become optimistic read success',
    );
    const count = f.calls.length;
    press(
      'student-verification-notices',
      'onReadNotice',
      { ...f.view(), item: { ...f.notice, read: true } },
      f.target,
    );
    press(
      'student-verification-notices',
      'onNotice',
      { ...f.view(), item: { ...f.notice, available: false } },
      f.target,
    );
    press('student-verification-notices', 'onPrevious', f.view(), f.target);
    assert.equal(f.calls.length, count);
    press('student-verification-notices', 'onNext', f.view(), f.target);
    await flush();
    assert.equal(f.view().page, 2);
    const pageCount = f.calls.length;
    press('student-verification-notices', 'onNext', f.view(), f.target);
    assert.equal(f.calls.length, pageCount);
    press('student-verification-notices', 'onPrevious', f.view(), f.target);
    await flush();
    assert.equal(f.view().page, 1);
    press(
      'student-verification-notices',
      'onNotice',
      { ...f.view(), item: f.notice },
      f.target,
    );
    await flush();
    assert.deepEqual(navigations, [
      `/pages/student-verification/student-verification?applicationId=${f.applicationId}`,
    ]);
    const pending =
      deferred<
        Awaited<ReturnType<HttpStudentVerificationGateway['noticeTarget']>>
      >();
    f.gateway.noticeTarget = async () => pending.promise;
    press(
      'student-verification-notices',
      'onNotice',
      { ...f.view(), item: f.notice },
      f.target,
    );
    await flush();
    f.sessions.logout();
    pending.resolve({
      status: 'available',
      target: { applicationId: f.applicationId, regionId: f.regionId },
    });
    await flush();
    assert.equal(navigations.length, 1);
    assert.deepEqual(f.view().notices, []);
    invoke(f.target, 'onHide');
    assert.equal(f.target.controller, undefined);
  } finally {
    f.controller.dispose();
    globals.wx = previous;
  }
});

test('24 synthetic fixtures cover all three pages and sensitive failure states without provider data', () => {
  const { default: fixtures } = requireNative(
    '../scripts/fixtures/framework7-profile-verification-preview.mjs',
  ) as {
    default: {
      id: string;
      page: string;
      patch: Record<string, unknown>;
      expectedText: string[];
    }[];
  };
  assert.equal(fixtures.length, 24);
  assert.deepEqual(
    [...new Set(fixtures.map((item) => item.page))].sort(),
    Object.keys(before).sort(),
  );
  for (const fixture of fixtures) {
    assert.match(fixture.id, /^framework7-profile-verification-/);
    assert.ok(fixture.expectedText.length >= 2);
    assert.doesNotMatch(
      JSON.stringify(fixture.patch),
      /https?:\/\/|accessToken|refreshToken|accountId|providerId|wxfile:\/\/|phoneNumber|studentNumberValue/,
    );
  }
  for (const kind of [
    'recovery',
    'picker-waiting',
    'unavailable',
    'expired',
    'denied',
    'error',
    'busy',
    'confirm-submit',
    'confirm-withdraw',
  ])
    assert.ok(
      fixtures.some((item) => item.id.includes(kind)),
      kind,
    );
  assert.ok(
    fixtures
      .filter((item) => item.page === 'profile')
      .every(
        (item) =>
          (item.patch.cover as { uploadAvailable: boolean }).uploadAvailable ===
          false,
      ),
  );
});
