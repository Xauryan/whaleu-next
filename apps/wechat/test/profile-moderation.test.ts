import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeProfileModerationTarget,
  decodeProfileModerationManagement,
  decodeProfileModerationCommand,
  decodeProfileModerationReceipt,
  decodeProfileModerationRecovery,
  matchProfileModerationReceipt,
} from '../src/profile-moderation/contract';
import type {
  ProfileModerationTarget,
  ProfileModerationManagement,
  ProfileModerationCommand,
  ProfileModerationReceipt,
  ProfileModerationRecovery,
} from '../src/profile-moderation/contract';
import {
  ProfileModerationController,
  type ProfileModerationView,
} from '../src/profile-moderation/controller';
import {
  HttpProfileModerationGateway,
  type ProfileModerationGateway,
} from '../src/profile-moderation/gateway';
import { PendingProfileModerationStore } from '../src/profile-moderation/pending';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { wireCredentials } from './identity-helpers';

const target: ProfileModerationTarget = { kind: 'post', id: postId };
const command = (
  patch: Partial<ProfileModerationCommand> = {},
): ProfileModerationCommand => ({
  clientRequestId: requestId,
  target,
  expectedProfileRevision: 0,
  action: 'reset_nickname',
  ...patch,
});
const receipt = (
  c = command(),
): Extract<ProfileModerationReceipt, { outcome: 'applied' }> => ({
  requestId: c.clientRequestId,
  target: c.target,
  expectedProfileRevision: c.expectedProfileRevision,
  action: c.action,
  outcome: 'applied',
  revision: c.expectedProfileRevision + 1,
  eventId: otherId,
  recordedAt: createdAt,
});
const rejection = (
  c = command(),
  code:
    | 'PROFILE_MODERATION_CANCELLED'
    | 'PROFILE_MODERATION_STALE' = 'PROFILE_MODERATION_CANCELLED',
): ProfileModerationReceipt => ({
  requestId: c.clientRequestId,
  target: c.target,
  expectedProfileRevision: c.expectedProfileRevision,
  action: c.action,
  outcome: 'rejected',
  code,
});
const manage = (): Extract<
  ProfileModerationManagement,
  { displayName: string }
> => ({
  target,
  displayName: '合成公开昵称',
  revision: 0,
  canReset: true,
});
function harness(storage = new MemoryStorage()) {
  const s = setup(),
    commands: { command: ProfileModerationCommand; cancelling: boolean }[] = [];
  let settled = 0;
  const gateway: ProfileModerationGateway = {
    management: async () => manage(),
    submit: async (c, _cancel, cancelling = false) => {
      commands.push({ command: c, cancelling });
      return cancelling ? rejection(c) : receipt(c);
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const store = new PendingProfileModerationStore(storage, 'synthetic-origin');
  const runtime: CommunityRuntime = {
    ...s.runtime,
    profileModeration: gateway,
    pendingProfileModeration: store,
  };
  let view!: ProfileModerationView;
  const make = () =>
    new ProfileModerationController(
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

test('strict target-only nickname commands reject private identifiers, arbitrary text, avatar and authority fields', () => {
  for (const kind of ['post', 'comment', 'reply'] as const) {
    assert.deepEqual(decodeProfileModerationTarget({ kind, id: postId }), {
      kind,
      id: postId,
    });
    assert.deepEqual(
      decodeProfileModerationCommand(command({ target: { kind, id: postId } })),
      command({ target: { kind, id: postId } }),
    );
  }
  for (const patch of [
    { accountId: otherId },
    { profileId: otherId },
    { actorId: otherId },
    { nickname: '任意昵称' },
    { role: 'super_admin' },
    { grantId: otherId },
    { scopeId: otherId },
    { action: 'reset_avatar' },
    { expectedProfileRevision: -1 },
    { expectedProfileRevision: 0.5 },
    { expectedProfileRevision: 2147483647 },
    { clientRequestId: requestId.replace('-4777-', '-1777-') },
    { target: { kind: 'account', id: postId } },
    { target: { ...target, accountId: otherId } },
    { target: { kind: 'post', id: 'bad' } },
  ])
    assert.throws(() =>
      decodeProfileModerationCommand({ ...command(), ...patch }),
    );
  assert.equal(
    decodeProfileModerationCommand(
      command({ expectedProfileRevision: 2147483646 }),
    ).expectedProfileRevision,
    2147483646,
  );
});

test('management is exact server authority; reset receipts disclose no subject or old/new nickname', () => {
  assert.deepEqual(decodeProfileModerationManagement(manage()), manage());
  for (const patch of [
    { canReset: false },
    { revision: 2147483647 },
    { displayName: '' },
    { displayName: 'a'.repeat(21) },
    { accountId: otherId },
    { publicId: otherId },
    { author: { kind: 'named' } },
    { avatar: null },
  ])
    assert.throws(() =>
      decodeProfileModerationManagement({ ...manage(), ...patch }),
    );
  assert.deepEqual(decodeProfileModerationReceipt(receipt()), receipt());
  assert.deepEqual(decodeProfileModerationReceipt(rejection()), rejection());
  for (const patch of [
    { revision: 0 },
    { revision: 2 },
    { eventId: null },
    { recordedAt: 'bad' },
    { subjectId: otherId },
    { accountId: otherId },
    { publicId: otherId },
    { nickname: '违规昵称Ab1234' },
    { oldNickname: '合成旧昵称' },
    { outcome: 'unchanged' },
  ])
    assert.throws(() =>
      decodeProfileModerationReceipt({ ...receipt(), ...patch }),
    );
  for (const patch of [
    { requestId: otherId },
    { target: { kind: 'comment', id: postId } },
    { target: { kind: 'post', id: otherId } },
    { expectedProfileRevision: 1 },
  ])
    assert.throws(() =>
      matchProfileModerationReceipt(command(), {
        ...receipt(),
        ...patch,
      } as ProfileModerationReceipt),
    );
  assert.deepEqual(decodeProfileModerationRecovery({ state: 'not_recorded' }), {
    state: 'not_recorded',
  });
  assert.deepEqual(
    decodeProfileModerationRecovery({ state: 'recorded', receipt: receipt() }),
    { state: 'recorded', receipt: receipt() },
  );
  for (const value of [
    { state: 'unavailable' },
    { state: 'not_recorded', receipt: receipt() },
    { state: 'recorded' },
  ])
    assert.throws(() => decodeProfileModerationRecovery(value));
});

test('fresh target management alone controls confirmation; malformed permission or another target cannot authorize', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  for (const result of [
    { ...manage(), canReset: false },
    { ...manage(), target: { kind: 'reply', id: postId } },
  ]) {
    s.gateway.management = async () => result as ProfileModerationManagement;
    await controller.request(target);
    await controller.submit();
    assert.equal(s.view().confirming, null);
    assert.equal(s.commands.length, 0);
  }
  s.gateway.management = async () => ({ ...manage(), revision: 4 });
  await controller.request(target);
  assert.equal(s.view().confirming, 'reset');
  assert.equal(s.view().loaded, true);
  await controller.submit();
  assert.equal(s.commands[0]!.command.expectedProfileRevision, 4);
});

test('double submit freezes one exact command; stale receipt clears confirmation without silently replacing key', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<ProfileModerationReceipt>();
  t.after(() => controller.dispose());
  s.gateway.submit = async (c, _cancel, cancelling = false) => {
    s.commands.push({ command: c, cancelling });
    return late.promise;
  };
  await controller.request(target);
  const work = controller.submit();
  await controller.submit();
  await flush();
  assert.equal(s.commands.length, 1);
  assert.deepEqual(s.store.load(s.accountId)?.command, command());
  assert.equal(
    s.view().management,
    null,
    'Pending journal recovery does not retain a nickname',
  );
  late.resolve(rejection(command(), 'PROFILE_MODERATION_STALE'));
  await work;
  assert.equal(s.store.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /未覆盖新状态/);
  await controller.submit();
  assert.equal(s.commands.length, 1);
});

test('journal pins actor, origin, exact body and cancel phase; removal failure retains recovery', () => {
  const s = harness(),
    original = s.freeze();
  assert.deepEqual(s.store.load(s.accountId), original);
  assert.throws(() =>
    s.store.freeze({
      ...original,
      command: command({ target: { kind: 'reply', id: otherId } }),
    }),
  );
  assert.throws(() =>
    s.store.freeze({
      ...original,
      command: command({ clientRequestId: otherId }),
    }),
  );
  assert.equal(s.store.load(otherId), null);
  assert.equal(
    new PendingProfileModerationStore(s.storage, 'other-origin').load(
      s.accountId,
    ),
    null,
  );
  const cancelled = s.store.cancel(original);
  assert.equal(cancelled.phase, 'cancel');
  assert.throws(() => s.store.settle(original, receipt()));
  s.storage.failRemove = true;
  assert.throws(() => s.store.settle(cancelled, receipt()));
  assert.deepEqual(s.store.load(s.accountId), cancelled);
  s.storage.failRemove = false;
  s.store.settle(cancelled, receipt());
  assert.equal(s.store.load(s.accountId), null);
  s.storage.data.set(
    `whaleu.profile-moderation.pending.v1:${s.store.origin}:${s.accountId}`,
    { ...original, origin: 'other-origin' },
  );
  assert.throws(() => s.store.load(s.accountId));
});

test('lost response and cold restart recover metadata without waiting for readable content or management', async (t) => {
  const s = harness();
  let controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.submit = async (c) => {
    s.commands.push({ command: c, cancelling: false });
    throw new ClientError('timeout', 'response lost');
  };
  await controller.request(target);
  await controller.submit();
  assert.equal(s.view().frozen, true);
  controller.dispose();
  controller = s.make();
  s.gateway.management = async () => {
    throw new Error('Recovery must not read content or management');
  };
  await controller.load(target);
  assert.equal(s.view().management, null);
  assert.deepEqual(s.view().pendingTarget, target);
  s.gateway.receipt = async (id) => {
    assert.equal(id, requestId);
    return { state: 'recorded', receipt: receipt() };
  };
  await controller.recover();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.commands.length, 1);
});

test('not-recorded never replaces key; explicit retry uses original and cancellation persists before dispatch', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.freeze();
  await controller.load();
  await controller.recover();
  assert.equal(s.view().frozen, true);
  await controller.request({ kind: 'post', id: otherId });
  assert.equal(s.commands.length, 0);
  s.gateway.submit = async (c, _cancel, cancelling = false) => {
    assert.equal(
      s.store.load(s.accountId)?.phase,
      cancelling ? 'cancel' : 'submit',
    );
    s.commands.push({ command: c, cancelling });
    throw new ClientError('timeout', 'response lost');
  };
  await controller.recover(true);
  assert.deepEqual(s.commands[0], { command: command(), cancelling: false });
  controller.requestCancellation();
  await controller.confirmCancellation();
  assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
  controller.dispose();
  const restarted = s.make();
  t.after(() => restarted.dispose());
  await restarted.load();
  await restarted.recover(true);
  assert.deepEqual(s.commands[2], { command: command(), cancelling: true });
  s.gateway.receipt = async () => ({ state: 'recorded', receipt: rejection() });
  await restarted.recover();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
});

test('unavailable or malformed recovery does not replay or release original key', async (t) => {
  for (const response of [
    { state: 'unavailable' },
    { state: 'not_recorded', receipt: receipt() },
  ]) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.freeze();
    await controller.load();
    s.gateway.receipt = async () => response as ProfileModerationRecovery;
    await controller.recover(true);
    assert.equal(s.commands.length, 0);
    assert.equal(s.view().frozen, true);
    assert.ok(s.store.load(s.accountId));
  }
});

test('forged receipt and cancel-lost-to-apply race preserve exact original binding', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.freeze();
  await controller.load();
  s.gateway.receipt = async () => ({
    state: 'recorded',
    receipt: { ...receipt(), target: { kind: 'reply', id: postId } },
  });
  await controller.recover();
  assert.equal(s.view().frozen, true);
  assert.equal(s.settled(), 0);
  s.gateway.submit = async () => receipt();
  controller.requestCancellation();
  await controller.confirmCancellation();
  assert.equal(s.store.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /已确认公开昵称重置/);
});

test('write failure, silent write and readback failure prevent any nickname dispatch', async (t) => {
  for (const mode of ['throw', 'silent', 'readback'] as const) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    await controller.request(target);
    if (mode === 'throw') s.storage.failWrite = true;
    if (mode === 'silent') s.storage.set = () => undefined;
    if (mode === 'readback') {
      const set = s.storage.set.bind(s.storage),
        get = s.storage.get.bind(s.storage);
      let written = false;
      s.storage.set = (k, v) => {
        set(k, v);
        written = true;
      };
      s.storage.get = (k) => {
        if (written) throw new Error('Readback failed');
        return get(k);
      };
    }
    await controller.submit();
    assert.equal(s.commands.length, 0, mode);
    assert.match(s.view().error, /本地保存失败/, mode);
  }
});

test('failed cancel-phase persistence and silent journal loss cannot dispatch new requests', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.freeze();
  await controller.load();
  controller.requestCancellation();
  s.storage.failWrite = true;
  await controller.confirmCancellation();
  assert.equal(s.commands.length, 0);
  assert.equal(s.store.load(s.accountId)?.phase, 'submit');
  s.storage.failWrite = false;
  s.storage.data.clear();
  await controller.request(target);
  await controller.submit();
  assert.equal(s.commands.length, 0);
  assert.equal(s.view().frozen, true);
});

test('account change, same-account relogin and dispose ignore late receipts and keep old actor journal', async (t) => {
  for (const mode of ['account', 'relogin', 'dispose'] as const) {
    const s = harness(),
      controller = s.make(),
      late = deferred<ProfileModerationReceipt>();
    t.after(() => controller.dispose());
    s.gateway.submit = () => late.promise;
    await controller.request(target);
    const work = controller.submit();
    await flush();
    if (mode === 'dispose') controller.dispose();
    else {
      s.sessions.logout();
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: mode === 'account' ? otherId : s.accountId,
      });
    }
    late.resolve(receipt());
    await work;
    assert.ok(s.store.load(s.accountId), mode);
    assert.equal(s.view().management, null, mode);
    assert.equal(s.view().receiptStatus, '', mode);
    assert.equal(s.settled(), 0, mode);
  }
});

test('account or origin replacement while allocating secure ID cannot persist or dispatch', async (t) => {
  for (const mode of ['account', 'origin'] as const) {
    const s = harness(),
      random = deferred<string>();
    Object.assign(s.runtime, { newRequestId: () => random.promise });
    const controller = s.make();
    t.after(() => controller.dispose());
    await controller.request(target);
    const work = controller.submit();
    await flush();
    if (mode === 'account') s.sessions.logout();
    else
      Object.assign(s.runtime, {
        pendingProfileModeration: new PendingProfileModerationStore(
          s.storage,
          'other-origin',
        ),
      });
    random.resolve(requestId);
    await work;
    assert.equal(s.commands.length, 0, mode);
    assert.equal(s.store.load(s.accountId), null, mode);
  }
});

test('origin replacement while response is pending cannot settle old journal into new environment', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<ProfileModerationReceipt>();
  t.after(() => controller.dispose());
  s.gateway.submit = () => late.promise;
  await controller.request(target);
  const work = controller.submit();
  await flush();
  Object.assign(s.runtime, {
    pendingProfileModeration: new PendingProfileModerationStore(
      s.storage,
      'new-origin',
    ),
  });
  late.resolve(receipt());
  await work;
  assert.ok(s.store.load(s.accountId));
  assert.equal(s.view().frozen, true);
  assert.equal(s.settled(), 0);
});

test('settlement invalidates private/media and public readers before fresh public reads', async (t) => {
  const s = harness(),
    safety = new SafetyChanges(s.runtime.privateViews),
    calls: string[] = [];
  Object.assign(s.runtime, { safetyChanges: safety });
  s.runtime.privateViews!.subscribe((account) => {
    if (account) calls.push('private');
  });
  safety.subscribe(() => {
    calls.push('read');
  });
  const controller = s.make();
  t.after(() => controller.dispose());
  await controller.request(target);
  await controller.submit();
  await flush();
  assert.deepEqual(calls, ['private', 'read']);
  assert.equal(s.store.load(s.accountId), null);
});

test('Safety invalidation resumes exact recovery GET only and drops an uncooperative old callback', async (t) => {
  const s = harness(),
    safety = new SafetyChanges(s.runtime.privateViews),
    first = deferred<ProfileModerationRecovery>();
  Object.assign(s.runtime, { safetyChanges: safety });
  s.freeze('cancel');
  let reads = 0;
  s.gateway.receipt = async () => {
    reads++;
    return reads === 1
      ? first.promise
      : { state: 'recorded', receipt: receipt() };
  };
  const controller = s.make();
  t.after(() => controller.dispose());
  await controller.load();
  const work = controller.recover(true);
  await flush();
  safety.invalidate(s.accountId);
  await flush();
  assert.equal(reads, 2);
  assert.equal(s.commands.length, 0);
  assert.equal(s.store.load(s.accountId), null);
  first.resolve({
    state: 'recorded',
    receipt: { ...receipt(), target: { kind: 'post', id: otherId } },
  });
  await work;
  assert.equal(s.view().frozen, false);
  assert.match(s.view().receiptStatus, /已确认公开昵称重置/);
});

test('late management and close/hide never restore confirmation or persist a command', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<ProfileModerationManagement>();
  t.after(() => controller.dispose());
  s.gateway.management = () => late.promise;
  const work = controller.request(target);
  await flush();
  controller.dispose();
  late.resolve(manage());
  await work;
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().management, null);
  assert.equal(s.view().confirming, null);
  assert.equal(s.store.load(s.accountId), null);
  const reopened = s.make();
  t.after(() => reopened.dispose());
  s.gateway.management = async () => manage();
  await reopened.request(target);
  reopened.closeConfirmation();
  await reopened.submit();
  assert.equal(s.commands.length, 0);
});

test('HTTP family uses target-only management query and original command body for cancel without automatic auth replay', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const api = new ApiClient('https://api.example', transport, s.sessions, {
    refresh: async () => {
      refreshes++;
      return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
    },
  });
  const gateway = new HttpProfileModerationGateway(api),
    cancel = new Cancellation();
  transport.reply(manage());
  await gateway.management(target, cancel);
  const url = new URL(transport.requests[0]!.url);
  assert.equal(url.pathname, '/v1/community/profile-moderation/management');
  assert.deepEqual(Object.fromEntries(url.searchParams), target);
  transport.reply(receipt());
  await gateway.submit(command(), cancel);
  assert.match(transport.requests[1]!.url, /\/profile-moderation\/commands$/);
  assert.deepEqual(transport.requests[1]!.body, command());
  transport.reply(rejection());
  await gateway.submit(command(), cancel, true);
  assert.match(
    transport.requests[2]!.url,
    /\/profile-moderation\/commands\/cancel$/,
  );
  assert.deepEqual(transport.requests[2]!.body, command());
  transport.reply({ state: 'recorded', receipt: receipt() });
  await gateway.receipt(requestId, cancel);
  assert.match(
    transport.requests[3]!.url,
    new RegExp(`/profile-moderation/requests/${requestId}$`),
  );
  assert.equal(transport.requests[3]!.method, 'GET');
  transport.reply({ state: 'not_recorded' });
  assert.deepEqual(await gateway.receipt(requestId, cancel), {
    state: 'not_recorded',
  });
  transport.reply({ ...manage(), target: { kind: 'reply', id: postId } });
  await assert.rejects(gateway.management(target, cancel));
  transport.reply({ ...receipt(), target: { kind: 'reply', id: postId } });
  await assert.rejects(gateway.submit(command(), cancel));
  transport.reply({
    state: 'recorded',
    receipt: { ...receipt(), requestId: otherId },
  });
  await assert.rejects(gateway.receipt(requestId, cancel));
  transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(gateway.submit(command(), cancel));
  assert.equal(refreshes, 0);
});

test('native page exposes account-wide confirmation and named content entries without role-derived authority', () => {
  const source = (name: string) =>
    readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
  const page = source('pages/profile-moderation/profile-moderation.ts');
  const wxml = source('pages/profile-moderation/profile-moderation.wxml');
  assert.match(
    source('app.json'),
    /pages\/profile-moderation\/profile-moderation/,
  );
  for (const handler of [
    'Reload',
    'ResetNickname',
    'Submit',
    'Close',
    'Recover',
    'Retry',
    'CancelRequest',
    'ConfirmCancel',
    'StopWaiting',
  ])
    assert.match(page, new RegExp(`on${handler}\\(`));
  assert.match(page, /controller\?\.dispose/);
  assert.match(wxml, /包括其他地区的公开署名/);
  assert.match(wxml, /私有系统通知/);
  assert.match(wxml, /匿名分身保持不变/);
  assert.match(wxml, /management\.canReset/);
  assert.doesNotMatch(
    wxml,
    /super_admin|school_admin|accountId|publicId|oldNickname/,
  );
  for (const name of ['community-detail', 'community-thread']) {
    const view = source(`pages/${name}/${name}.wxml`);
    for (const kind of ['post', 'comment', 'reply'])
      assert.match(
        view,
        new RegExp(`profile-moderation\\?kind=${kind}&amp;id=`),
      );
  }
  assert.match(
    source('pages/community-mine/community-mine.wxml'),
    /恢复本账号原昵称管理请求/,
  );
});

test('standalone moderation page state starts unloaded and recovery-only load never invents management readiness', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  assert.equal(s.view().loaded, false);
  await controller.load();
  assert.equal(s.view().loaded, false);
  await controller.load(target);
  assert.equal(s.view().loaded, true);
  await controller.load();
  assert.equal(s.view().loaded, false);
  controller.dispose();
  assert.equal(s.view().loaded, false);
});

test('management display name bound matches API Unicode code points, not UTF-16 units', () => {
  const displayName = '🐋'.repeat(20);
  const decoded = decodeProfileModerationManagement({
    ...manage(),
    displayName,
  });
  assert.ok('displayName' in decoded);
  assert.equal(decoded.displayName, displayName);
  assert.throws(() =>
    decodeProfileModerationManagement({
      ...manage(),
      displayName: '🐋'.repeat(21),
    }),
  );
});

test('related sync unsupported management is an exact redacted capability and never opens confirmation', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  for (const kind of ['post', 'comment', 'reply'] as const) {
    const scopedTarget = { kind, id: postId };
    const unavailable = {
      target: scopedTarget,
      canReset: false as const,
      availability: 'unavailable' as const,
      blocker: 'related_sync_unsupported' as const,
    };
    assert.deepEqual(
      decodeProfileModerationManagement(unavailable),
      unavailable,
    );
    for (const extra of [
      { displayName: 'private' },
      { revision: 0 },
      { expectedAppearanceId: otherId },
      { subjectId: otherId },
      { accountId: otherId },
      { canReset: true },
      { blocker: 'other' },
    ])
      assert.throws(() =>
        decodeProfileModerationManagement({ ...unavailable, ...extra }),
      );
    s.gateway.management = async () => unavailable;
    await controller.request(scopedTarget);
    assert.equal(s.view().loaded, true);
    assert.equal(s.view().confirming, null);
    assert.match(s.view().status, /关联校区同步内容暂不支持/);
    await controller.submit();
    assert.equal(s.commands.length, 0);
  }
});
