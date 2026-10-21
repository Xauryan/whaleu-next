import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SchoolPostingPolicyController } from '../src/school-posting-policy/controller';
import { ErrandAdminCommandController } from '../src/errands/admin-command-controller';
import {
  postingHarness,
  postingRequest,
} from './school-posting-policy-helpers';
import {
  commandHarness,
  mutationOrder,
  restriction,
  globalScope,
  scope,
} from './errand-admin-command-helpers';
import { adminOrderId, authorization } from './errand-admin-helpers';
import { flush } from './helpers';
const nativeRequire = createRequire(__filename);
const root = path.join(__dirname, '../src');
interface Owner {
  data: Record<string, unknown>;
  setData(patch: Record<string, unknown>): void;
  [key: string]: unknown;
}
interface Capture {
  press(): boolean;
  detach(): void;
}
interface Bridge {
  find(handler: string, dataset?: Record<string, unknown>): unknown;
  capture(handler: string, dataset?: Record<string, unknown>): Capture;
  lifecycle(name: string): void;
  emissions: {
    detail: unknown;
    currentTarget: { dataset: Record<string, unknown> };
  }[];
}
const { createNativePressBridge } = nativeRequire(
  './native-press-emitted-harness.mjs',
) as {
  createNativePressBridge(options: {
    page: Owner;
    pageFile: string;
    dist: string;
    extension: 'ts';
  }): Bridge;
};
const { default: fixtures } = nativeRequire(
  '../scripts/fixtures/school-operations-preview.mjs',
) as {
  default: { id: string; page: string; patch: Record<string, unknown> }[];
};
const invoke = (page: Owner, name: string, event?: unknown) =>
  (page[name] as (event?: unknown) => unknown).call(page, event);
async function settle() {
  for (let i = 0; i < 12; i++) await flush();
}
function mount(fixtureId: string) {
  const fixture = fixtures.find((f) => f.id === fixtureId)!;
  assert.ok(fixture);
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Page: globals.Page,
    wx: globals.wx,
    getApp: globals.getApp,
  };
  const modals: {
    title: string;
    content: string;
    success: (v: { confirm: boolean; cancel: boolean }) => void;
  }[] = [];
  const navigation: string[] = [];
  globals.wx = {
    showModal: (v: (typeof modals)[number]) => modals.push(v),
    navigateTo: ({ url }: { url: string }) => navigation.push(url),
  };
  globals.getApp = () => ({});
  let definition: Owner | undefined;
  globals.Page = (value: Owner) => {
    definition = value;
  };
  const file = path.join(root, `pages/${fixture.page}/${fixture.page}.ts`);
  delete nativeRequire.cache[nativeRequire.resolve(file)];
  nativeRequire(file);
  globals.Page = previous.Page;
  assert.ok(definition);
  const owner: Owner = {
    ...definition,
    data: {
      ...structuredClone(definition.data),
      ...structuredClone(fixture.patch),
    },
    setData(patch) {
      Object.assign(this.data, patch);
    },
  };
  const bridge = createNativePressBridge({
    page: owner,
    pageFile: path.join(root, `pages/${fixture.page}/${fixture.page}`),
    dist: root,
    extension: 'ts',
  });
  return {
    owner,
    bridge,
    modals,
    navigation,
    press(handler: string, dataset: Record<string, unknown> = {}) {
      const c = bridge.capture(handler, dataset);
      const emitted = c.press();
      c.detach();
      return emitted;
    },
    close() {
      bridge.lifecycle('detach');
      globals.Page = previous.Page;
      globals.wx = previous.wx;
      globals.getApp = previous.getApp;
    },
  };
}
const id = '11111111-1111-4111-8111-111111111111',
  region = '22222222-2222-4222-8222-222222222222';
const cases: [string, string, Record<string, unknown>, string, unknown[]][] = [
  [
    'school-admin-ready',
    'onSelectRegion',
    { id: region },
    'selectRegion',
    [region],
  ],
  ['school-services-ready', 'onSave', {}, 'save', []],
  [
    'school-identity-ready',
    'onRequest',
    { action: 'correct_school' },
    'request',
    ['correct_school'],
  ],
  ['school-policy-ready', 'onSave', {}, 'save', []],
  ['school-uid-selected', 'onLookup', {}, 'lookup', []],
  ['school-official-ready', 'onTestPreview', {}, 'preview', ['test']],
  [
    'school-announcement-edit',
    'onCommand',
    { action: 'publish' },
    'act',
    ['publish', false],
  ],
  ['school-announcement-list', 'onEdit', { id }, 'navigate', []],
  [
    'school-errand-list',
    'onStatus',
    { value: 'accepted' },
    'chooseStatus',
    ['accepted'],
  ],
  [
    'school-restrictions-list',
    'onActionFilter',
    { value: 'accept' },
    'chooseAction',
    ['accept'],
  ],
];
for (const [fixture, handler, dataset, method, args] of cases)
  test(`${fixture}: actual frozen Component → unchanged Page → exact controller port, disabled/loading/Hide/Detach fences`, () => {
    const h = mount(fixture);
    const calls: { method: string; args: unknown[] }[] = [];
    const controller = new Proxy(
      {},
      {
        get(_target, key) {
          return (...args: unknown[]) => {
            calls.push({ method: String(key), args });
          };
        },
      },
    );
    h.owner.controller = controller;
    try {
      const pending = h.bridge.capture(handler, dataset);
      h.owner.setData({ busy: true });
      assert.equal(
        pending.press(),
        false,
        'old enabled capture cannot bypass newly busy parent',
      );
      h.owner.setData({ busy: false });
      pending.detach();
      if (handler === 'onStatus' || handler === 'onActionFilter') {
        // Original filters intentionally have no disabled prop; preserve that contract.
        assert.equal(h.press(handler, dataset), true);
      } else assert.equal(h.press(handler, dataset), true);
      if (method === 'act') {
        assert.equal(
          calls.length,
          0,
          'native press only requests original confirmation',
        );
        assert.equal(h.modals.length, 1);
        h.modals[0]!.success({ confirm: true, cancel: false });
      }
      if (method === 'navigate')
        assert.deepEqual(h.navigation, [
          `/pages/announcement-edit/announcement-edit?id=${id}`,
        ]);
      else assert.deepEqual(calls[calls.length - 1], { method, args });
      assert.deepEqual(
        h.bridge.emissions[h.bridge.emissions.length - 1]!.currentTarget
          .dataset,
        dataset,
      );
      const hidden = h.bridge.capture(handler, dataset);
      h.bridge.lifecycle('hide');
      assert.equal(hidden.press(), false);
      h.bridge.lifecycle('show');
      const detached = h.bridge.capture(handler, dataset);
      h.bridge.lifecycle('detach');
      assert.equal(detached.press(), false);
    } finally {
      h.close();
    }
  });
test('school administrator bridge executes original real controller/gateway/journal smoke with exact request and cancellation identity', async () => {
  const smokeFile = path.join(
    __dirname,
    '../scripts/smoke-school-admin-management.mjs',
  );
  const { smokeSchoolAdminManagement } = (await import(smokeFile)) as {
    smokeSchoolAdminManagement(options: {
      dist: string;
      extension: 'ts';
    }): Promise<void>;
  };
  await smokeSchoolAdminManagement({ dist: root, extension: 'ts' });
});
test('school posting policy native save keeps revision, independent topic/reply flags and original-key unknown recovery; logout clears owner', async () => {
  const h = mount('school-policy-ready'),
    p = postingHarness();
  const controller = new SchoolPostingPolicyController(
    p.sessions,
    p.gateway,
    p.schools,
    p.profiles,
    p.journal,
    async () => postingRequest,
    (v) => h.owner.setData({ ...v }),
    () => Date.parse('2026-10-11T00:00:00Z'),
  );
  h.owner.controller = controller;
  try {
    await controller.load(null);
    invoke(h.owner, 'onSwitch', {
      currentTarget: { dataset: { field: 'unverifiedPostEnabled' } },
      detail: { value: true },
    });
    invoke(h.owner, 'onSwitch', {
      currentTarget: { dataset: { field: 'unverifiedCommentEnabled' } },
      detail: { value: false },
    });
    invoke(h.owner, 'onCategories', {
      detail: { value: ['discussion', 'pets'] },
    });
    invoke(h.owner, 'onExpiryKind', { detail: { value: 'policy_exempt' } });
    p.gateway.save = async (_region, command) => {
      p.calls.saves.push(command);
      throw new ClientError('network', 'synthetic unknown result');
    };
    assert.equal(h.press('onSave'), true);
    await settle();
    assert.equal(p.calls.saves.length, 1);
    const original = p.calls.saves[0]!;
    assert.equal(original.clientRequestId, postingRequest);
    assert.equal(original.expectedRevision, 0);
    assert.equal(original.policy.unverifiedPostEnabled, true);
    assert.equal(original.policy.unverifiedCommentEnabled, false);
    assert.deepEqual(original.policy.expiry, { kind: 'policy_exempt' });
    assert.equal(h.owner.data.pending, true);
    assert.equal(h.press('onSave'), false, 'pending blocks new command');
    assert.equal(h.press('onRetry'), true);
    await settle();
    assert.equal(p.calls.saves.length, 2);
    assert.deepEqual(p.calls.saves[1], original);
    assert.equal(h.press('onCancelPending'), true);
    await settle();
    assert.equal(h.owner.data.pending, false);
    p.sessions.logout();
    assert.equal(h.owner.data.form, null);
  } finally {
    controller.dispose();
    h.close();
  }
});
for (const route of ['admin', 'restrictions'] as const)
  test(`errand ${route}: native isolated confirmation reaches real command controller, scopes exact target and retains unknown request`, async () => {
    const h = mount(
        route === 'admin' ? 'school-errand-list' : 'school-restrictions-list',
      ),
      c = commandHarness();
    const command = new ErrandAdminCommandController(
      c.runtime,
      (v) => h.owner.setData({ adminCommand: v }),
      () => {},
      () => {},
    );
    h.owner.commands = command;
    const item = route === 'admin' ? mutationOrder() : restriction();
    h.owner.controller =
      route === 'admin'
        ? {
            commandContext: (target: string) => {
              assert.equal(target, adminOrderId);
              return { order: item, authority: scope() };
            },
          }
        : {
            commandAuthority: () => globalScope(),
            commandRestriction: (target: string) => {
              assert.equal(target, restriction().restrictionId);
              return item;
            },
          };
    h.owner.setData({ items: [item] });
    c.gateway.authorizationImpl = async () =>
      authorization(route === 'admin' ? 'school_admin' : 'developer');
    c.gateway.commandImpl = async () => {
      throw new ClientError('network', 'synthetic lost response');
    };
    c.gateway.receiptImpl = async () => {
      throw new ClientError('http', 'Synthetic receipt not recorded', {
        serverCode: 'REQUEST_NOT_FOUND',
        httpStatus: 404,
      });
    };
    command.load();
    try {
      assert.equal(
        h.press(route === 'admin' ? 'onAdminDelete' : 'onRelease', {
          id: route === 'admin' ? adminOrderId : restriction().restrictionId,
        }),
        true,
      );
      const before = h.owner.data.adminCommand as {
        modal: { operation: string };
        publisherRestriction: boolean;
      };
      assert.equal(
        before.modal.operation,
        route === 'admin' ? 'admin_delete' : 'release',
      );
      assert.equal(before.publisherRestriction, false);
      invoke(h.owner, 'onAdminReason', { detail: { value: '合成操作原因' } });
      assert.equal(h.press('onAdminConfirm'), true);
      await settle();
      assert.equal(c.commands().length, 1);
      const original = c.commands()[0]!.args[0];
      assert.equal(
        (h.owner.data.adminCommand as { frozen: boolean }).frozen,
        true,
      );
      assert.equal(h.bridge.find('onAdminConfirm'), undefined);
      assert.equal(h.press('onAdminRetry'), true);
      await settle();
      assert.equal(c.commands().length, 2);
      assert.deepEqual(c.commands()[1]!.args[0], original);
      const late = h.bridge.capture('onAdminRecover');
      h.bridge.lifecycle('hide');
      command.dispose();
      assert.equal(late.press(), false);
    } finally {
      command.dispose();
      c.controller.dispose();
      h.close();
    }
  });
test('announcement native publish preserves original modal cancellation and stale controller rejection; boolean data is not invented', () => {
  const h = mount('school-announcement-edit'),
    calls: unknown[][] = [];
  const first = { act: (...args: unknown[]) => calls.push(args) };
  h.owner.controller = first;
  try {
    h.press('onCommand', { action: 'publish' });
    assert.equal(h.modals.length, 1);
    h.modals[0]!.success({ confirm: false, cancel: true });
    assert.deepEqual(calls.slice(), []);
    h.press('onCommand', { action: 'publish' });
    h.owner.controller = { act: (...args: unknown[]) => calls.push(args) };
    h.modals[1]!.success({ confirm: true, cancel: false });
    assert.deepEqual(calls.slice(), []);
    h.owner.controller = first;
    h.owner.setData({ state: 'inactive' });
    h.press('onCommand', { action: 'set_enabled', enabled: 'true' });
    h.modals[2]!.success({ confirm: true, cancel: false });
    assert.deepEqual(calls, [['set_enabled', true]]);
  } finally {
    h.close();
  }
});
test('official account native recovery preserves all four original control modes and never publishes', () => {
  const h = mount('school-official-recovery'),
    calls: unknown[][] = [];
  h.owner.controller = { recover: (...args: unknown[]) => calls.push(args) };
  try {
    for (const name of ['onRecover', 'onRetry', 'onCancel', 'onResume'])
      assert.equal(h.press(name), true);
    assert.deepEqual(calls, [[], ['retry'], ['cancel'], ['resume']]);
    assert.equal(h.bridge.find('onPublish'), undefined);
  } finally {
    h.close();
  }
});

test('school identity native correction keeps both CAS versions, exact public target and immutable cancellation request', async () => {
  const { setup, postId, otherId } = await import('./community-helpers.js');
  const { SchoolIdentityController } =
    await import('../src/school-identity/controller.js');
  const { PendingSchoolIdentityStore } =
    await import('../src/school-identity/pending.js');
  type Command =
    import('../src/school-identity/contract').SchoolIdentityCommand;
  type Gateway = import('../src/school-identity/gateway').SchoolIdentityGateway;
  const h = mount('school-identity-ready'),
    s = setup(),
    sent: Command[] = [];
  const management = (selected: boolean) => ({
    target: { profileId: postId, displayName: '合成目标' },
    stateVersion: 'a'.repeat(64),
    current: {
      school: { code: '12345', name: '原学校' },
      schoolUid: {
        status: 'assigned' as const,
        school: { code: '12345', name: '原学校' },
        uid: '9007199254740993',
        formattedUid: '9007199254740993',
      },
    },
    destination: selected
      ? {
          campusId: otherId,
          campusName: '目标校区',
          school: { code: '54321', name: '目标学校' },
          destinationVersion: 'b'.repeat(64),
        }
      : null,
    actions: { correctSchool: true, completeUid: false },
  });
  const gateway: Gateway = {
    capabilities: async () => ({
      role: 'super_admin',
      schoolAdminManagement: true,
      schoolIdentityManagement: true,
      management: { global: true, operatingRegionIds: [] },
      identityView: { allowed: false, maxBatchSize: 20 },
    }),
    management: async (_target, _cancel, destination) =>
      management(!!destination),
    submit: async (command, _cancel, cancelling = false) => {
      sent.push(command);
      if (!cancelling) throw new ClientError('network', 'synthetic unknown');
      const { clientRequestId, ...intent } = command;
      return {
        ...intent,
        requestId: clientRequestId,
        outcome: 'rejected',
        code: 'SCHOOL_IDENTITY_CANCELLED',
      };
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const runtime = {
    ...s.runtime,
    schoolIdentity: gateway,
    pendingSchoolIdentity: new PendingSchoolIdentityStore(
      s.storage,
      'https://synthetic.invalid',
    ),
  };
  assert.ok(runtime.profiles);
  runtime.profiles.campuses = async () => ({
    page: 1,
    pageSize: 20,
    total: 1,
    items: [
      {
        id: otherId,
        institutionId: '54321',
        institutionName: '目标学校',
        fullName: '目标校区',
        shortName: null,
        district: '合成',
        isActive: true,
      },
    ],
  });
  const controller = new SchoolIdentityController(runtime, (v) =>
    h.owner.setData({ ...v }),
  );
  h.owner.controller = controller;
  try {
    await controller.load(postId);
    h.press('onSearchCampuses');
    await settle();
    h.press('onSelectCampus', { id: otherId });
    await settle();
    h.press('onRequest', { action: 'correct_school' });
    assert.equal(h.owner.data.confirming, 'correct_school');
    h.press('onSubmit');
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.targetProfileId, postId);
    assert.equal(sent[0]!.expectedStateVersion, 'a'.repeat(64));
    assert.equal(sent[0]!.action, 'correct_school');
    assert.equal(
      (sent[0] as Command & { expectedDestinationVersion: string })
        .expectedDestinationVersion,
      'b'.repeat(64),
    );
    assert.equal(h.owner.data.frozen, true);
    assert.equal(h.bridge.find('onSubmit'), undefined);
    h.press('onCancelRequest');
    assert.equal(h.owner.data.confirming, 'cancel');
    h.press('onConfirmCancel');
    await settle();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0]);
    assert.equal(h.owner.data.frozen, false);
    assert.match(String(h.owner.data.receiptStatus), /取消/);
  } finally {
    controller.dispose();
    h.close();
  }
});

test('school UID native choose/search preserves school code and bigint UID without inferring historical identity', async () => {
  const { setup, postId, otherId } = await import('./community-helpers.js');
  const { SchoolUidLookupController } =
    await import('../src/school-uid/controller.js');
  type Gateway = import('../src/school-uid/gateway').SchoolUidGateway;
  const h = mount('school-uid-selected'),
    s = setup(),
    calls: unknown[][] = [];
  const gateway: Gateway = {
    capabilities: async () => ({
      role: 'super_admin',
      schoolAdminManagement: true,
      schoolIdentityManagement: true,
      management: { global: true, operatingRegionIds: [] },
      identityView: { allowed: false, maxBatchSize: 20 },
    }),
    own: async () => ({ status: 'unavailable' }),
    lookup: async (code, uid) => {
      calls.push([code, uid]);
      return {
        status: 'found',
        target: { profileId: postId, displayName: '合成目标' },
      };
    },
  };
  const runtime = { ...s.runtime, schoolUid: gateway };
  assert.ok(runtime.profiles);
  runtime.profiles.campuses = async () => ({
    page: 1,
    pageSize: 20,
    total: 1,
    items: [
      {
        id: otherId,
        institutionId: '12345',
        institutionName: '合成学校',
        fullName: '合成校区',
        shortName: null,
        district: '合成',
        isActive: true,
      },
    ],
  });
  const controller = new SchoolUidLookupController(runtime, (v) =>
    h.owner.setData({ ...v }),
  );
  h.owner.controller = controller;
  try {
    await controller.load();
    h.press('onSearch');
    await settle();
    h.press('onChoose', { id: otherId });
    invoke(h.owner, 'onUid', { detail: { value: '9007199254740993' } });
    h.press('onLookup');
    await settle();
    assert.deepEqual(calls, [['12345', '9007199254740993']]);
    assert.equal((h.owner.data.result as { status: string }).status, 'found');
    s.sessions.logout();
    assert.equal(h.owner.data.result, null);
    assert.equal(h.bridge.find('onLookup'), undefined);
  } finally {
    controller.dispose();
    h.close();
  }
});
