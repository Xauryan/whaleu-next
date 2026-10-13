import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  decodeAuthorization,
  type Authorization,
} from '../src/identity-privacy/overlay';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeExperienceCatalog,
  decodeExperienceAppearance,
} from '../src/experience/contract';
import { catalog, appearance, at } from './experience-helpers';
import {
  SchoolAdminManagementController,
  type SchoolAdminManagementView,
} from '../src/school-admin-management/controller';
import {
  HttpSchoolAdminManagementGateway,
  type SchoolAdminManagementGateway,
} from '../src/school-admin-management/gateway';
import { PendingSchoolAdminManagementStore } from '../src/school-admin-management/pending';
import {
  decodeSchoolAdminManagement,
  decodeSchoolAdminManagementCommand,
  decodeSchoolAdminManagementReceipt,
  decodeSchoolAdminManagementRecovery,
  matchSchoolAdminManagementReceipt,
  schoolAdminManagementCommandHash,
  type SchoolAdminManagement,
  type SchoolAdminManagementCommand,
  type SchoolAdminManagementReceipt,
} from '../src/school-admin-management/contract';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { wireCredentials } from './identity-helpers';
const regionId = otherId;
const capability = (
  allowed = true,
  role: Authorization['role'] = 'super_admin',
): Authorization => ({
  role,
  schoolAdminManagement: allowed,
  management: {
    global: role === 'super_admin' || role === 'developer',
    operatingRegionIds: [],
  },
  identityView: { allowed: role === 'developer', maxBatchSize: 20 },
});
const command = (
  patch: Record<string, unknown> = {},
): SchoolAdminManagementCommand =>
  decodeSchoolAdminManagementCommand({
    clientRequestId: requestId,
    targetProfileId: postId,
    expectedStateVersion: 'a'.repeat(64),
    action: 'appoint',
    regionId,
    ...patch,
  });
const receipt = (
  c = command(),
  unchanged = false,
): SchoolAdminManagementReceipt => {
  const { clientRequestId, ...intent } = c;
  return {
    ...intent,
    requestId: clientRequestId,
    outcome: unchanged ? 'unchanged' : 'applied',
    eventId: otherId,
    recordedAt: createdAt,
    titleGranted: c.action !== 'revoke',
  };
};
const rejection = (
  c = command(),
  code:
    | 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED'
    | 'SCHOOL_ADMIN_MANAGEMENT_STALE' = 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED',
): SchoolAdminManagementReceipt => {
  const { clientRequestId, ...intent } = c;
  return { ...intent, requestId: clientRequestId, outcome: 'rejected', code };
};
const manage = (
  patch: Partial<SchoolAdminManagement> = {},
): SchoolAdminManagement => ({
  target: { profileId: postId, displayName: '合成公开昵称' },
  stateVersion: 'a'.repeat(64),
  currentAssignment: null,
  eligibility: {
    status: 'known',
    reason: null,
    regions: [{ id: regionId, name: '合成地区' }],
    defaultRegionId: regionId,
  },
  actions: { appoint: true, reassign: false, revoke: false },
  ...patch,
});
function harness(storage = new MemoryStorage()) {
  const s = setup(),
    commands: { command: SchoolAdminManagementCommand; cancelling: boolean }[] =
      [];
  let settled = 0,
    capabilityReads = 0,
    managementReads = 0;
  const gateway: SchoolAdminManagementGateway = {
    capabilities: async () => {
      capabilityReads++;
      return capability();
    },
    management: async () => {
      managementReads++;
      return manage();
    },
    submit: async (c, _cancel, cancelling = false) => {
      commands.push({ command: c, cancelling });
      return cancelling ? rejection(c) : receipt(c);
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const store = new PendingSchoolAdminManagementStore(
    storage,
    'synthetic-origin',
  );
  const runtime: CommunityRuntime = {
    ...s.runtime,
    schoolAdminManagement: gateway,
    pendingSchoolAdminManagement: store,
  };
  let view!: SchoolAdminManagementView;
  const make = () =>
    new SchoolAdminManagementController(
      runtime,
      (next) => {
        view = next;
      },
      () => {
        settled++;
      },
    );
  return {
    ...s,
    storage,
    runtime,
    gateway,
    store,
    commands,
    make,
    view: () => view,
    settled: () => settled,
    reads: () => ({ capabilityReads, managementReads }),
    freeze: (phase: 'submit' | 'cancel' = 'submit') =>
      store.freeze({
        version: 1,
        accountId: s.accountId,
        origin: store.origin,
        phase,
        command: command(),
      }),
  };
}
async function confirm(controller: SchoolAdminManagementController) {
  await controller.load(postId);
  controller.selectRegion(regionId);
  controller.request('appoint');
}

test('strict public-profile intent rejects private identifiers, arbitrary role/source and revoke region', () => {
  for (const c of [
    command(),
    command({ action: 'reassign' }),
    {
      clientRequestId: requestId,
      targetProfileId: postId,
      expectedStateVersion: 'a'.repeat(64),
      action: 'revoke',
    },
  ])
    assert.deepEqual(decodeSchoolAdminManagementCommand(c), c);
  for (const patch of [
    { accountId: otherId },
    { openid: 'hidden' },
    { studentNumber: 'hidden' },
    { phone: 'hidden' },
    { grantId: otherId },
    { target: { kind: 'anonymous', id: postId } },
    { titleKey: 'role_admin' },
    { role: 'school_admin' },
    { validFrom: createdAt },
    { expiresAt: createdAt },
    { approvedBy: otherId },
    { newStatus: 'verified' },
    { action: 'revoke' },
    { action: 'developer' },
    { targetProfileId: 'bad' },
    { expectedStateVersion: 'A'.repeat(64) },
    { clientRequestId: 'bad' },
  ])
    assert.throws(() =>
      decodeSchoolAdminManagementCommand({ ...command(), ...patch }),
    );
  assert.notEqual(
    schoolAdminManagementCommandHash(wireCredentials().accountId, command()),
    schoolAdminManagementCommandHash(
      wireCredentials().accountId,
      command({ action: 'reassign' }),
    ),
  );
});
test('strict management distinguishes known empty, unavailable, unverified, protected and noncurrent assignment', () => {
  assert.deepEqual(decodeSchoolAdminManagement(manage()), manage());
  for (const status of [
    'known',
    'unavailable',
    'unverified',
    'protected',
  ] as const)
    decodeSchoolAdminManagement(
      manage({
        eligibility: {
          status,
          reason: status === 'known' ? null : 'SOURCE_UNAVAILABLE',
          regions: [],
          defaultRegionId: null,
        },
        actions: {
          appoint: false,
          reassign: false,
          revoke: status !== 'protected',
        },
      }),
    );
  for (const status of ['active', 'future', 'expired', 'unavailable'] as const)
    decodeSchoolAdminManagement(
      manage({
        currentAssignment: { regionId, name: '地区', status },
        actions: { appoint: false, reassign: true, revoke: true },
      }),
    );
  for (const patch of [
    { accountId: otherId },
    { stateVersion: 0 },
    { target: { ...manage().target, accountId: otherId } },
    {
      currentAssignment: {
        regionId,
        name: '地区',
        status: 'active',
        grantId: otherId,
      },
    },
    { eligibility: { ...manage().eligibility, assertionId: otherId } },
    { eligibility: { ...manage().eligibility, defaultRegionId: postId } },
    {
      eligibility: {
        ...manage().eligibility,
        regions: [
          ...manage().eligibility.regions,
          ...manage().eligibility.regions,
        ],
      },
    },
    { eligibility: { ...manage().eligibility, status: 'unavailable' } },
    { actions: { ...manage().actions, appoint: 'yes' } },
  ])
    assert.throws(() => decodeSchoolAdminManagement({ ...manage(), ...patch }));
});
test('receipts match every immutable intent component; malformed or private results cannot settle', () => {
  for (const r of [receipt(), receipt(command(), true), rejection()])
    assert.deepEqual(decodeSchoolAdminManagementReceipt(r), r);
  for (const patch of [
    { accountId: otherId },
    { eventId: null },
    { titleGranted: 'true' },
    { recordedAt: 'bad' },
    { outcome: 'queued' },
    { grantId: otherId },
  ])
    assert.throws(() =>
      decodeSchoolAdminManagementReceipt({ ...receipt(), ...patch }),
    );
  for (const patch of [
    { requestId: otherId },
    { targetProfileId: otherId },
    { expectedStateVersion: 'b'.repeat(64) },
    { regionId: postId },
    { action: 'reassign' },
  ])
    assert.throws(() =>
      matchSchoolAdminManagementReceipt(command(), {
        ...receipt(),
        ...patch,
      } as SchoolAdminManagementReceipt),
    );
  assert.deepEqual(
    decodeSchoolAdminManagementRecovery({ state: 'not_recorded' }),
    { state: 'not_recorded' },
  );
  assert.throws(() =>
    decodeSchoolAdminManagementRecovery({
      state: 'not_recorded',
      receipt: receipt(),
    }),
  );
});
test('capability is independent of highest developer label and cannot be inferred from a title', async (t) => {
  for (const allowed of [false, true]) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.gateway.capabilities = async () => capability(allowed, 'developer');
    await controller.load(postId);
    assert.equal(s.view().canManage, allowed);
    assert.equal(s.view().loaded, allowed);
  }
  assert.throws(() =>
    decodeAuthorization({
      ...capability(false, 'member'),
      schoolAdminManagement: true,
    }),
  );
  assert.throws(() =>
    decodeAuthorization({ ...capability(), schoolAdminManagement: undefined }),
  );
});
test('default/singleton never selects or submits; closing confirmation never dispatches', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  await controller.load(postId);
  assert.equal(s.view().selectedRegionId, '');
  controller.request('appoint');
  await controller.submit();
  assert.equal(s.commands.length, 0);
  controller.selectRegion(postId);
  assert.equal(s.view().selectedRegionId, '');
  controller.selectRegion(regionId);
  controller.request('appoint');
  assert.equal(s.view().confirming, 'appoint');
  controller.closeConfirmation();
  await controller.submit();
  assert.equal(s.commands.length, 0);
});
test('double click freezes one exact command before network and refreshes current authority after terminal', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<SchoolAdminManagementReceipt>();
  t.after(() => controller.dispose());
  s.gateway.submit = async (c, _cancel, cancelling = false) => {
    assert.deepEqual(s.store.load(s.accountId)?.command, c);
    s.commands.push({ command: c, cancelling });
    return late.promise;
  };
  await confirm(controller);
  const work = controller.submit();
  await controller.submit();
  await flush();
  assert.equal(s.commands.length, 1);
  assert.equal(s.view().management, null);
  assert.equal(s.view().frozen, true);
  controller.setTarget(otherId);
  controller.selectRegion(postId);
  assert.equal(s.store.load(s.accountId)?.command.targetProfileId, postId);
  late.resolve(receipt());
  await work;
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.reads().managementReads, 2);
  assert.equal(s.reads().capabilityReads, 2);
  assert.match(s.view().receiptStatus, /历史结果/);
  assert.equal(s.view().confirming, null);
});
test('lost response cold restart restores before capability/target reads and recovers after loss of super', async (t) => {
  const s = harness();
  let controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.submit = async () => {
    throw new ClientError('timeout', 'lost');
  };
  await confirm(controller);
  await controller.submit();
  controller.dispose();
  controller = s.make();
  s.gateway.capabilities = async () => capability(false, 'member');
  s.gateway.management = async () => {
    throw Error('must not read target');
  };
  await controller.load('invalid');
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().pendingTargetProfileId, postId);
  s.gateway.receipt = async () => ({ state: 'recorded', receipt: receipt() });
  await controller.recover();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.view().canManage, false);
  assert.match(s.view().receiptStatus, /已确认任命/);
});
test('not_recorded and 403 keep original key; explicit retry preserves exact phase and body', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  const pending = s.freeze();
  await controller.load();
  await controller.recover();
  assert.deepEqual(s.store.load(s.accountId), pending);
  s.gateway.receipt = async () => {
    throw new ClientError('forbidden', 'lost authority', {
      httpStatus: 403,
      serverCode: 'AUTHORIZATION_REQUIRED',
    });
  };
  await controller.recover();
  assert.deepEqual(s.store.load(s.accountId), pending);
  s.gateway.receipt = async () => ({ state: 'not_recorded' });
  await controller.recover(true);
  assert.deepEqual(s.commands[0]?.command, pending.command);
  assert.equal(s.commands.length, 1);
});
test('cancel wins or observes apply winner; its durable phase survives another lost reply and cold restart', async (t) => {
  for (const alreadyApplied of [false, true]) {
    const s = harness();
    let controller = s.make();
    t.after(() => controller.dispose());
    s.freeze();
    await controller.load();
    s.gateway.submit = async (c, _cancel, cancelling = false) => {
      s.commands.push({ command: c, cancelling });
      throw new ClientError('timeout', 'lost cancel response');
    };
    controller.requestCancellation();
    await controller.confirmCancellation();
    assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
    controller.dispose();
    controller = s.make();
    await controller.load();
    s.gateway.submit = async (c, _cancel, cancelling = false) => {
      s.commands.push({ command: c, cancelling });
      return alreadyApplied ? receipt(c) : rejection(c);
    };
    await controller.recover(true);
    assert.equal(s.commands.length, 2);
    assert.ok(s.commands.every((c) => c.cancelling));
    assert.deepEqual(s.commands[0]?.command, s.commands[1]?.command);
    assert.equal(s.store.load(s.accountId), null);
    assert.match(
      s.view().receiptStatus,
      alreadyApplied ? /已确认任命/ : /原请求已取消/,
    );
  }
});
test('storage failures prevent first dispatch; failed cleanup preserves blocked historical receipt recovery', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  await confirm(controller);
  s.storage.failWrite = true;
  await controller.submit();
  assert.equal(s.commands.length, 0);
  s.storage.failWrite = false;
  await confirm(controller);
  s.storage.failRemove = true;
  await controller.submit();
  assert.equal(s.view().frozen, true);
  assert.ok(s.store.load(s.accountId));
  assert.match(s.view().receiptStatus, /清理失败/);
  s.storage.failRemove = false;
  s.gateway.receipt = async () => ({ state: 'recorded', receipt: receipt() });
  await controller.recover();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.commands.length, 1);
});
test('persisted journal readback, hash, origin/account and phase are mandatory', () => {
  const s = harness(),
    original = s.freeze();
  assert.equal(
    new PendingSchoolAdminManagementStore(s.storage, 'other-origin').load(
      s.accountId,
    ),
    null,
  );
  assert.equal(s.store.load(otherId), null);
  assert.throws(() =>
    s.store.freeze({
      ...original,
      command: command({ targetProfileId: otherId }),
    }),
  );
  const key = `whaleu.school-admin-management.pending.v1:${s.store.origin}:${s.accountId}`;
  for (const patch of [
    { origin: 'other' },
    { accountId: otherId },
    { requestHash: '0'.repeat(64) },
    { phase: 'unknown' },
    { command: { ...command(), accountId: otherId } },
  ]) {
    s.storage.set(key, { ...original, ...patch });
    assert.throws(() => s.store.load(s.accountId));
  }
  s.storage.set(key, original);
  const cancel = s.store.cancel(original);
  assert.throws(() => s.store.settle(original, receipt()));
  assert.equal(cancel.phase, 'cancel');
});
test('same-owner safety invalidation refuses missing or substituted pending storage without generating a key', async (t) => {
  for (const mode of ['missing', 'phase', 'target', 'version', 'key', 'hash']) {
    const s = harness(),
      safety = new SafetyChanges(s.runtime.privateViews);
    Object.assign(s.runtime, { safetyChanges: safety });
    const controller = s.make();
    t.after(() => controller.dispose());
    const original = s.freeze('cancel');
    await controller.load();
    const key = `whaleu.school-admin-management.pending.v1:${s.store.origin}:${s.accountId}`;
    const replacement = command({
      ...(mode === 'target' ? { targetProfileId: otherId } : {}),
      ...(mode === 'version' ? { expectedStateVersion: 'b'.repeat(64) } : {}),
      ...(mode === 'key' ? { clientRequestId: otherId } : {}),
    });
    if (mode === 'missing') s.storage.remove(key);
    else
      s.storage.set(key, {
        ...original,
        command: replacement,
        phase: mode === 'phase' ? 'submit' : original.phase,
        requestHash:
          mode === 'hash'
            ? '0'.repeat(64)
            : schoolAdminManagementCommandHash(s.accountId, replacement),
      });
    safety.invalidate(s.accountId);
    await controller.load(postId);
    await controller.recover(true);
    controller.requestCancellation();
    await controller.confirmCancellation();
    assert.equal(s.commands.length, 0, mode);
    assert.equal(s.view().frozen, true, mode);
    assert.equal(s.reads().managementReads, 0, mode);
    s.storage.set(key, original);
    s.gateway.receipt = async () => ({
      state: 'recorded',
      receipt: rejection(),
    });
    await controller.recover();
    assert.equal(s.store.load(s.accountId), null, mode);
  }
});
test('account replacement, same-account relogin and navigation disposal reject late callbacks', async (t) => {
  for (const mode of ['account', 'login', 'navigation']) {
    const s = harness(),
      controller = s.make(),
      late = deferred<SchoolAdminManagementReceipt>();
    t.after(() => controller.dispose());
    s.gateway.submit = async () => late.promise;
    await confirm(controller);
    const work = controller.submit();
    await flush();
    const original = s.store.load(s.accountId);
    if (mode === 'navigation') controller.dispose();
    else
      s.runtime.sessions.completeLogin(s.runtime.sessions.beginLogin(), {
        ...wireCredentials(),
        ...(mode === 'account' ? { accountId: otherId } : {}),
      });
    late.resolve(receipt());
    await work;
    assert.deepEqual(s.store.load(s.accountId), original, mode);
    assert.equal(s.view().management, null, mode);
    assert.equal(s.view().receiptStatus, '', mode);
  }
});
test('same-tick cancellation before UUID completion cannot persist or send', async (t) => {
  const s = harness(),
    controller = s.make(),
    random = deferred<string>();
  t.after(() => controller.dispose());
  Object.assign(s.runtime, { newRequestId: () => random.promise });
  await confirm(controller);
  const work = controller.submit();
  controller.cancel();
  random.resolve(requestId);
  await work;
  assert.equal(s.commands.length, 0);
  assert.equal(s.store.load(s.accountId), null);
});
test('reassign and revoke freeze explicit intent; expired/unavailable sources do not gate allowed revoke', async (t) => {
  for (const action of ['reassign', 'revoke'] as const) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.gateway.management = async () =>
      manage({
        currentAssignment: { regionId, name: '旧地区', status: 'expired' },
        ...(action === 'revoke'
          ? {
              eligibility: {
                status: 'unverified',
                reason: 'AFFILIATION_VERIFICATION_REQUIRED',
                regions: [],
                defaultRegionId: null,
              },
            }
          : {}),
        actions: {
          appoint: false,
          reassign: action === 'reassign',
          revoke: true,
        },
      });
    await controller.load(postId);
    if (action === 'reassign') controller.selectRegion(regionId);
    controller.request(action);
    await controller.submit();
    assert.equal(s.commands[0]?.command.action, action);
    assert.equal('regionId' in s.commands[0]!.command, action === 'reassign');
  }
});
test('strict real gateway uses exact public query, cancel route and no automatic mutation auth replay', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const gateway = new HttpSchoolAdminManagementGateway(
    new ApiClient(
      'https://school-admin.example',
      transport,
      s.runtime.sessions,
      {
        refresh: async () => {
          throw Error('no replay');
        },
      },
    ),
  );
  transport.reply(capability());
  await gateway.capabilities(new Cancellation());
  transport.reply(manage());
  await gateway.management(postId, new Cancellation());
  assert.equal(
    new URL(transport.requests[1]!.url).search,
    `?targetProfileId=${postId}`,
  );
  transport.reply(receipt());
  await gateway.submit(command(), new Cancellation());
  assert.deepEqual(transport.requests[2]!.body, command());
  transport.reply(rejection());
  await gateway.submit(command(), new Cancellation(), true);
  assert.ok(transport.requests[3]!.url.endsWith('/commands/cancel'));
  transport.reply({ state: 'recorded', receipt: receipt() });
  await gateway.receipt(requestId, new Cancellation());
  transport.reply({
    ...manage(),
    target: { ...manage().target, profileId: otherId },
  });
  await assert.rejects(gateway.management(postId, new Cancellation()));
});
test('role_admin is strict special ownership and does not imply auto-equipped appearance', () => {
  const c = decodeExperienceCatalog(catalog()),
    title = c.titles.find((t) => t.key === 'role_admin')!;
  assert.equal(title.name, '管理员');
  assert.equal(title.kind, 'special');
  const value = decodeExperienceAppearance(
    appearance({
      titles: [{ ...title, earnedAt: at, recordedAt: at }],
      titleKey: null,
    }),
  );
  assert.equal(value.titleKey, null);
  assert.equal(value.titles[0]?.key, 'role_admin');
  assert.throws(() =>
    decodeExperienceCatalog({
      ...c,
      titles: c.titles.map((t) =>
        t.key === 'role_admin' ? { ...t, kind: 'level' } : t,
      ),
    }),
  );
});
test('registered native UI and entries only locate known public profile and expose durable recovery', () => {
  const root = path.resolve(__dirname, '../src'),
    app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')) as {
      pages: string[];
    };
  assert.equal(
    app.pages.filter(
      (p) => p === 'pages/school-admin-management/school-admin-management',
    ).length,
    1,
  );
  const wxml = readFileSync(
    path.join(
      root,
      'pages/school-admin-management/school-admin-management.wxml',
    ),
    'utf8',
  );
  for (const text of [
    '公开主页 ID',
    '固定',
    '不会自动佩戴',
    '头衔不代表当前权限',
    '不发送通知',
    '查询原请求回执',
    '取消原请求',
  ])
    assert.ok(wxml.includes(text), text);
  assert.doesNotMatch(
    wxml,
    /accountId|openid|studentNumber|identityView|capabilities\.role/,
  );
  assert.match(
    readFileSync(
      path.join(root, 'pages/public-profile/public-profile.wxml'),
      'utf8',
    ),
    /targetProfileId=\{\{profile.profileId\}\}/,
  );
});
