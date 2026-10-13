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
  decodeAdminPostRemovalTarget,
  decodeAdminPostRemovalManagement,
  decodeAdminPostRemovalCommand,
  decodeAdminPostRemovalReceipt,
  decodeAdminPostRemovalRecovery,
  matchAdminPostRemovalReceipt,
  adminPostRemovalCommandHash,
} from '../src/admin-post-removal/contract';
import type {
  AdminPostRemovalTarget,
  AdminPostRemovalManagement,
  AdminPostRemovalCommand,
  AdminPostRemovalReceipt,
  AdminPostRemovalRecovery,
} from '../src/admin-post-removal/contract';
import {
  AdminPostRemovalController,
  type AdminPostRemovalView,
} from '../src/admin-post-removal/controller';
import {
  HttpAdminPostRemovalGateway,
  type AdminPostRemovalGateway,
} from '../src/admin-post-removal/gateway';
import { PendingAdminPostRemovalStore } from '../src/admin-post-removal/pending';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import {
  createdAt,
  spaceId,
  otherId,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { wireCredentials } from './identity-helpers';

const target: AdminPostRemovalTarget = { kind: 'post', id: postId };
const command = (
  patch: Partial<AdminPostRemovalCommand> = {},
): AdminPostRemovalCommand =>
  decodeAdminPostRemovalCommand({
    clientRequestId: requestId,
    target,
    expectedTargetVersion: 'a'.repeat(64),
    action: 'remove_post',
    ...patch,
  });
const receipt = (
  c = command(),
): Extract<AdminPostRemovalReceipt, { outcome: 'applied' }> => ({
  requestId: c.clientRequestId,
  target: c.target,
  expectedTargetVersion: c.expectedTargetVersion,
  action: c.action,
  outcome: 'applied',
  eventId: otherId,
  recordedAt: createdAt,
});
const rejection = (
  c = command(),
  code:
    | 'ADMIN_POST_REMOVAL_CANCELLED'
    | 'ADMIN_POST_REMOVAL_STALE' = 'ADMIN_POST_REMOVAL_CANCELLED',
): AdminPostRemovalReceipt => ({
  requestId: c.clientRequestId,
  target: c.target,
  expectedTargetVersion: c.expectedTargetVersion,
  action: c.action,
  outcome: 'rejected',
  code,
});
const manage = (): AdminPostRemovalManagement => ({
  target,
  targetVersion: 'a'.repeat(64),
  canRemove: true,
});
function harness(storage = new MemoryStorage()) {
  const s = setup(),
    commands: {
      command: AdminPostRemovalCommand;
      cancelling: boolean;
    }[] = [];
  let settled = 0;
  const gateway: AdminPostRemovalGateway = {
    management: async () => manage(),
    submit: async (c, _cancel, cancelling = false) => {
      commands.push({ command: c, cancelling });
      return cancelling ? rejection(c) : receipt(c);
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const store = new PendingAdminPostRemovalStore(storage, 'synthetic-origin');
  const runtime: CommunityRuntime = {
    ...s.runtime,
    adminPostRemoval: gateway,
    pendingAdminPostRemoval: store,
  };
  let view!: AdminPostRemovalView;
  const make = () =>
    new AdminPostRemovalController(
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

test('strict post-only commands reject private identities, arbitrary reasons, punishment, author mode and authority fields', () => {
  assert.deepEqual(decodeAdminPostRemovalTarget(target), target);
  assert.deepEqual(decodeAdminPostRemovalCommand(command()), command());
  for (const patch of [
    { accountId: otherId },
    { profileId: otherId },
    { actorId: otherId },
    { reason: 'arbitrary' },
    { ban: true },
    { authorMode: 'named' },
    { role: 'super_admin' },
    { grantId: otherId },
    { scopeId: otherId },
    { action: 'delete_post' },
    { expectedTargetVersion: 0 },
    { expectedTargetVersion: 'A'.repeat(64) },
    { expectedTargetVersion: 'a'.repeat(63) },
    { clientRequestId: requestId.replace('-4777-', '-1777-') },
    { target: { kind: 'comment', id: postId } },
    { target: { kind: 'reply', id: postId } },
    { target: { kind: 'account', id: postId } },
    { target: { ...target, accountId: otherId } },
    { target: { kind: 'post', id: 'bad' } },
  ])
    assert.throws(() =>
      decodeAdminPostRemovalCommand({ ...command(), ...patch }),
    );
});

test('management and receipts contain exact visible target and version only, including anonymous content', () => {
  assert.deepEqual(decodeAdminPostRemovalManagement(manage()), manage());
  for (const patch of [
    { canRemove: false },
    { targetVersion: 0 },
    { targetVersion: 'bad' },
    { accountId: otherId },
    { publicId: otherId },
    { displayName: 'Private author' },
    { author: { kind: 'anonymous' } },
    { avatar: null },
  ])
    assert.throws(() =>
      decodeAdminPostRemovalManagement({ ...manage(), ...patch }),
    );
  assert.deepEqual(decodeAdminPostRemovalReceipt(receipt()), receipt());
  assert.deepEqual(decodeAdminPostRemovalReceipt(rejection()), rejection());
  for (const patch of [
    { revision: 1 },
    { eventId: null },
    { recordedAt: 'bad' },
    { subjectId: otherId },
    { accountId: otherId },
    { publicId: otherId },
    { text: 'Source preview' },
    { adminId: otherId },
    { outcome: 'unchanged' },
  ])
    assert.throws(() =>
      decodeAdminPostRemovalReceipt({ ...receipt(), ...patch }),
    );
  for (const patch of [
    { requestId: otherId },
    { target: { kind: 'post', id: otherId } },
    { expectedTargetVersion: 'b'.repeat(64) },
  ])
    assert.throws(() =>
      matchAdminPostRemovalReceipt(command(), {
        ...receipt(),
        ...patch,
      } as AdminPostRemovalReceipt),
    );
  assert.deepEqual(decodeAdminPostRemovalRecovery({ state: 'not_recorded' }), {
    state: 'not_recorded',
  });
  assert.deepEqual(
    decodeAdminPostRemovalRecovery({ state: 'recorded', receipt: receipt() }),
    { state: 'recorded', receipt: receipt() },
  );
  for (const value of [
    { state: 'unavailable' },
    { state: 'not_recorded', receipt: receipt() },
    { state: 'recorded' },
  ])
    assert.throws(() => decodeAdminPostRemovalRecovery(value));
});

test('fresh target management alone controls confirmation; malformed permission or another target cannot authorize', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  for (const result of [
    { ...manage(), canRemove: false },
    { ...manage(), target: { kind: 'post', id: otherId } },
  ]) {
    s.gateway.management = async () => result as AdminPostRemovalManagement;
    await controller.request(target);
    await controller.submit();
    assert.equal(s.view().confirming, null);
    assert.equal(s.commands.length, 0);
  }
  s.gateway.management = async () => ({
    ...manage(),
    targetVersion: 'b'.repeat(64),
  });
  await controller.request(target);
  assert.equal(s.view().confirming, 'remove');
  assert.equal(s.view().loaded, true);
  await controller.submit();
  assert.equal(s.commands[0]!.command.expectedTargetVersion, 'b'.repeat(64));
});

test('double submit freezes one exact command; stale receipt clears confirmation without silently replacing key', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<AdminPostRemovalReceipt>();
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
    'Pending journal recovery does not retain a display name',
  );
  late.resolve(rejection(command(), 'ADMIN_POST_REMOVAL_STALE'));
  await work;
  assert.equal(s.store.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /未删除新状态/);
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
      command: command({ target: { kind: 'post', id: otherId } }),
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
    new PendingAdminPostRemovalStore(s.storage, 'other-origin').load(
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
    `whaleu.admin-post-removal.pending.v1:${s.store.origin}:${s.accountId}`,
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
    s.gateway.receipt = async () => response as AdminPostRemovalRecovery;
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
    receipt: { ...receipt(), target: { kind: 'post', id: otherId } },
  });
  await controller.recover();
  assert.equal(s.view().frozen, true);
  assert.equal(s.settled(), 0);
  s.gateway.submit = async () => receipt();
  controller.requestCancellation();
  await controller.confirmCancellation();
  assert.equal(s.store.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /已确认删除帖子/);
});

test('write failure, silent write and readback failure prevent any admin removal dispatch', async (t) => {
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
      late = deferred<AdminPostRemovalReceipt>();
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
        pendingAdminPostRemoval: new PendingAdminPostRemovalStore(
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
    late = deferred<AdminPostRemovalReceipt>();
  t.after(() => controller.dispose());
  s.gateway.submit = () => late.promise;
  await controller.request(target);
  const work = controller.submit();
  await flush();
  Object.assign(s.runtime, {
    pendingAdminPostRemoval: new PendingAdminPostRemovalStore(
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
    first = deferred<AdminPostRemovalRecovery>();
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
  assert.match(s.view().receiptStatus, /已确认删除帖子/);
});

test('late management and close/hide never restore confirmation or persist a command', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<AdminPostRemovalManagement>();
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

test('HTTP family uses exact v2 source management query and original command body for cancel without automatic auth replay', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const api = new ApiClient('https://api.example', transport, s.sessions, {
    refresh: async () => {
      refreshes++;
      return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
    },
  });
  const gateway = new HttpAdminPostRemovalGateway(api),
    cancel = new Cancellation();
  transport.reply(manage());
  await gateway.management(target, cancel);
  const url = new URL(transport.requests[0]!.url);
  assert.equal(url.pathname, '/v1/community/admin-post-removal/management');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    ...target,
    version: '2',
  });
  transport.reply(receipt());
  await gateway.submit(command(), cancel);
  assert.match(transport.requests[1]!.url, /\/admin-post-removal\/commands$/);
  assert.deepEqual(transport.requests[1]!.body, command());
  transport.reply(rejection());
  await gateway.submit(command(), cancel, true);
  assert.match(
    transport.requests[2]!.url,
    /\/admin-post-removal\/commands\/cancel$/,
  );
  assert.deepEqual(transport.requests[2]!.body, command());
  transport.reply({ state: 'recorded', receipt: receipt() });
  await gateway.receipt(requestId, cancel);
  assert.match(
    transport.requests[3]!.url,
    new RegExp(`/admin-post-removal/requests/${requestId}$`),
  );
  assert.equal(transport.requests[3]!.method, 'GET');
  transport.reply({ state: 'not_recorded' });
  assert.deepEqual(await gateway.receipt(requestId, cancel), {
    state: 'not_recorded',
  });
  transport.reply({ ...manage(), target: { kind: 'post', id: otherId } });
  await assert.rejects(gateway.management(target, cancel));
  transport.reply({ ...receipt(), target: { kind: 'post', id: otherId } });
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

test('native page has explicit irreversible post/discussion confirmation and anonymous entry without role-derived authority', () => {
  const source = (name: string) =>
    readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
  const page = source('pages/admin-post-removal/admin-post-removal.ts');
  const wxml = source('pages/admin-post-removal/admin-post-removal.wxml');
  assert.match(
    source('app.json'),
    /pages\/admin-post-removal\/admin-post-removal/,
  );
  for (const handler of [
    'Reload',
    'RemovePost',
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
  assert.match(wxml, /评论、回复将不可访问/);
  assert.match(wxml, /私有系统通知/);
  assert.match(wxml, /没有恢复此帖的管理入口/);
  assert.match(wxml, /停止等待不会取消服务器处理/);
  assert.match(wxml, /management\.canRemove/);
  assert.doesNotMatch(
    wxml,
    /super_admin|school_admin|accountId|publicId|displayName/,
  );
  const detail = source('pages/community-detail/community-detail.wxml');
  const entry = detail.match(
    /<button[^>]*bindtap="onAdminPostRemoval"[^>]*>[^<]*<\/button>/,
  )?.[0];
  assert.ok(entry);
  assert.match(entry, /!post.viewer.isSelf/);
  assert.doesNotMatch(entry, /author.kind|role|canManage/);
  assert.match(detail, /删除我的帖子/);
  assert.match(
    source('pages/community-mine/community-mine.wxml'),
    /恢复本账号原管理员删帖请求/,
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

test('own-post management failure directs to established owner deletion without creating a new intent', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.management = async () => {
    throw new ClientError('http', 'Own post', {
      httpStatus: 403,
      serverCode: 'ADMIN_POST_REMOVAL_OWN_POST',
    });
  };
  await controller.request(target);
  await controller.submit();
  assert.equal(s.view().ownPost, true);
  assert.match(s.view().error, /删除我的帖子/);
  assert.equal(s.view().confirming, null);
  assert.equal(s.commands.length, 0);
});

test('post removal journal preserves nickname and avatar journals and detects hash tampering', () => {
  const s = harness();
  const keys = ['profile-moderation', 'profile-avatar-moderation'].map(
    (name) => `whaleu.${name}.pending.v1:${s.store.origin}:${s.accountId}`,
  );
  const untouched = { synthetic: 'Unmodified older journal' };
  for (const key of keys) s.storage.set(key, untouched);
  const frozen = s.freeze();
  assert.match(frozen.requestHash, /^[a-f0-9]{64}$/);
  s.store.settle(frozen, receipt());
  for (const key of keys) assert.deepEqual(s.storage.get(key), untouched);
  const again = s.freeze();
  s.storage.set(
    `whaleu.admin-post-removal.pending.v1:${s.store.origin}:${s.accountId}`,
    { ...again, requestHash: '0'.repeat(64) },
  );
  assert.throws(() => s.store.load(s.accountId));
});

test('known applied receipt clears content/media readers even if journal removal fails, keeping original recovery blocked', async (t) => {
  const s = harness();
  const safety = new SafetyChanges(s.runtime.privateViews),
    calls: string[] = [];
  Object.assign(s.runtime, { safetyChanges: safety });
  safety.subscribe(() => calls.push('invalidated'));
  const controller = s.make();
  t.after(() => controller.dispose());
  await controller.request(target);
  s.storage.failRemove = true;
  await controller.submit();
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().management, null);
  assert.ok(s.store.load(s.accountId));
  assert.deepEqual(calls, ['invalidated']);
  assert.match(s.view().receiptStatus, /已确认帖子删除/);
  s.storage.failRemove = false;
  s.gateway.receipt = async () => ({ state: 'recorded', receipt: receipt() });
  await controller.recover();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.commands.length, 1);
});

test('post original pending anchor survives restore or same-owner Safety reset with missing, corrupt or replaced durable intent', async (t) => {
  for (const boundary of ['restore', 'safety'] as const)
    for (const mode of [
      'missing',
      'target',
      'version',
      'phase',
      'new-key',
      'corrupt',
    ] as const) {
      const s = harness();
      const safety = new SafetyChanges(s.runtime.privateViews);
      Object.assign(s.runtime, { safetyChanges: safety });
      const controller = s.make();
      t.after(() => controller.dispose());
      const original = s.freeze('cancel');
      await controller.load();
      let reads = 0,
        managementReads = 0;
      const first = deferred<AdminPostRemovalRecovery>();
      s.gateway.receipt = (id) => {
        assert.equal(id, original.command.clientRequestId);
        reads++;
        return first.promise;
      };
      s.gateway.management = async () => {
        managementReads++;
        return manage();
      };
      const work =
        boundary === 'safety' ? controller.recover(true) : Promise.resolve();
      await flush();
      const expectedReads = boundary === 'safety' ? 1 : 0;
      assert.equal(reads, expectedReads);
      const key = `whaleu.admin-post-removal.pending.v1:${s.store.origin}:${s.accountId}`;
      if (mode === 'missing') s.storage.remove(key);
      else {
        const replacement = command({
          ...(mode === 'target'
            ? { target: { kind: 'post', id: otherId } }
            : {}),
          ...(mode === 'version'
            ? { expectedTargetVersion: 'b'.repeat(64) }
            : {}),
          ...(mode === 'new-key' ? { clientRequestId: otherId } : {}),
        });
        s.storage.set(key, {
          ...original,
          phase: mode === 'phase' ? 'submit' : original.phase,
          command: replacement,
          requestHash:
            mode === 'corrupt'
              ? '0'.repeat(64)
              : adminPostRemovalCommandHash(s.accountId, replacement),
        });
      }
      if (boundary === 'safety') safety.invalidate(s.accountId);
      await controller.load(target);
      await controller.request(target);
      await controller.submit();
      await controller.recover(true);
      controller.requestCancellation();
      await controller.confirmCancellation();
      first.resolve({ state: 'not_recorded' });
      await work;
      assert.equal(reads, expectedReads, `${boundary}/${mode}`);
      assert.equal(managementReads, 0, `${boundary}/${mode}`);
      assert.equal(s.commands.length, 0, `${boundary}/${mode}`);
      assert.equal(s.view().frozen, true, `${boundary}/${mode}`);
      assert.equal(s.view().management, null, `${boundary}/${mode}`);
      assert.equal(s.view().confirming, null, `${boundary}/${mode}`);
      assert.match(s.view().error, /本地保存失败/, `${boundary}/${mode}`);
      s.storage.set(key, original);
      s.gateway.receipt = async (id) => {
        assert.equal(id, original.command.clientRequestId);
        reads++;
        return { state: 'recorded', receipt: rejection() };
      };
      await controller.recover();
      assert.equal(reads, expectedReads + 1);
      assert.equal(s.store.load(s.accountId), null);
      assert.equal(s.view().frozen, false);
      assert.equal(s.commands.length, 0);
    }
});

test('post known applied recovery with persistent storage removal failure invalidates once without automatic GET recursion', async (t) => {
  const s = harness();
  Object.assign(s.runtime, {
    safetyChanges: new SafetyChanges(s.runtime.privateViews),
  });
  const controller = s.make();
  t.after(() => controller.dispose());
  s.freeze();
  await controller.load();
  let reads = 0,
    invalidations = 0,
    managementReads = 0;
  s.gateway.management = async () => {
    managementReads++;
    return manage();
  };
  s.runtime.safetyChanges!.subscribe(() => invalidations++);
  s.gateway.receipt = async () => {
    reads++;
    return { state: 'recorded', receipt: receipt() };
  };
  s.storage.failRemove = true;
  await controller.recover();
  await flush();
  assert.equal(reads, 1);
  assert.equal(invalidations, 1);
  assert.equal(managementReads, 0);
  assert.equal(s.view().applied, true);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().recovering, false);
  assert.ok(s.store.load(s.accountId));
});

test('pure v3 removal binds destination in strict management, intent, receipt and original recovery journal', () => {
  const scoped = decodeAdminPostRemovalCommand({
    ...command(),
    version: 3,
    viewSpaceId: spaceId,
  });
  const management = {
    target,
    targetVersion: 'a'.repeat(64),
    canRemove: true,
    version: 3,
    viewSpaceId: spaceId,
  };
  assert.deepEqual(decodeAdminPostRemovalManagement(management), management);
  for (const patch of [
    { punishmentOptions: {} },
    { viewSpaceId: 'bad' },
    { version: 2 },
  ])
    assert.throws(() =>
      decodeAdminPostRemovalManagement({ ...management, ...patch }),
    );
  for (const patch of [
    { punishment: null },
    { punishment: { kind: 'interaction_mute' } },
    { viewSpaceId: 'bad' },
    { spaceId },
    { version: 2 },
  ])
    assert.throws(() => decodeAdminPostRemovalCommand({ ...scoped, ...patch }));
  const outcome = decodeAdminPostRemovalReceipt({
    ...receipt(scoped),
    version: 3,
    viewSpaceId: spaceId,
  });
  matchAdminPostRemovalReceipt(scoped, outcome);
  assert.throws(() =>
    matchAdminPostRemovalReceipt(
      scoped,
      decodeAdminPostRemovalReceipt({ ...outcome, viewSpaceId: otherId }),
    ),
  );
  assert.throws(() =>
    decodeAdminPostRemovalReceipt({ ...outcome, punishment: null }),
  );
  assert.notEqual(
    adminPostRemovalCommandHash(wireCredentials().accountId, scoped),
    adminPostRemovalCommandHash(wireCredentials().accountId, command()),
  );
  assert.notEqual(
    adminPostRemovalCommandHash(wireCredentials().accountId, scoped),
    adminPostRemovalCommandHash(
      wireCredentials().accountId,
      decodeAdminPostRemovalCommand({ ...scoped, viewSpaceId: otherId }),
    ),
  );
  const s = harness();
  const saved = s.store.freeze({
    version: 1,
    accountId: s.accountId,
    origin: s.store.origin,
    phase: 'submit',
    command: scoped,
  });
  assert.throws(() =>
    s.store.freeze({
      ...saved,
      command: decodeAdminPostRemovalCommand({
        ...scoped,
        viewSpaceId: otherId,
      }),
    }),
  );
  const cancelling = s.store.cancel(saved);
  assert.equal(cancelling.command.viewSpaceId, spaceId);
  assert.deepEqual(s.store.load(s.accountId), cancelling);
  s.store.settle(cancelling, outcome);
  assert.equal(s.store.load(s.accountId), null);
});

test('v3 native confirmation offers pure deletion and retries frozen destination after navigation and authority withdrawal', async (t) => {
  const s = harness();
  let controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.management = async (readTarget, _cancel, destination) => {
    assert.equal(destination, spaceId);
    return {
      target: readTarget,
      targetVersion: 'a'.repeat(64),
      canRemove: true,
      version: 3,
      viewSpaceId: spaceId,
    };
  };
  await controller.request(target, spaceId);
  assert.equal(s.view().confirming, 'remove');
  assert.equal(s.view().management?.punishmentOptions, undefined);
  assert.equal(
    controller.selectPunishment({
      kind: 'interaction_mute',
      expectedRevision: '0',
      reason: 'forged',
      duration: { kind: 'finite', unit: 'days', value: 1 },
    }),
    false,
  );
  s.gateway.submit = async (c, _cancel, cancelling = false) => {
    s.commands.push({ command: c, cancelling });
    throw new ClientError('network', 'Response lost');
  };
  await controller.submit();
  assert.equal(s.commands.length, 1);
  const original = s.commands[0]!.command;
  assert.equal(original.version, 3);
  assert.equal(original.viewSpaceId, spaceId);
  assert.equal('punishment' in original, false);
  controller.dispose();
  controller = s.make();
  s.gateway.management = async () => {
    throw new Error('Recovery must not reacquire withdrawn destination');
  };
  await controller.load(target, otherId);
  await controller.recover(true);
  assert.deepEqual(s.commands[1]!.command, original);
  controller.requestCancellation();
  await controller.confirmCancellation();
  assert.deepEqual(s.commands[2], { command: original, cancelling: true });
  s.gateway.receipt = async () => ({
    state: 'recorded',
    receipt: decodeAdminPostRemovalReceipt({
      ...rejection(original),
      version: 3,
      viewSpaceId: spaceId,
    }),
  });
  await controller.recover();
  assert.equal(s.store.load(s.accountId), null);
});

test('v3 HTTP management and submit preserve explicit view scope and reject response substitution', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example', transport, s.sessions, {
    refresh: async () => s.sessions.snapshot(),
  });
  const gateway = new HttpAdminPostRemovalGateway(api),
    cancel = new Cancellation();
  const management = {
    target,
    targetVersion: 'a'.repeat(64),
    canRemove: true,
    version: 3,
    viewSpaceId: spaceId,
  };
  transport.reply(management);
  await gateway.management(target, cancel, spaceId);
  assert.deepEqual(
    Object.fromEntries(new URL(transport.requests[0]!.url).searchParams),
    { ...target, version: '3', viewSpaceId: spaceId },
  );
  const scoped = decodeAdminPostRemovalCommand({
    ...command(),
    version: 3,
    viewSpaceId: spaceId,
  });
  transport.reply({ ...receipt(scoped), version: 3, viewSpaceId: spaceId });
  await gateway.submit(scoped, cancel);
  assert.deepEqual(transport.requests[1]!.body, scoped);
  transport.reply({ ...rejection(scoped), version: 3, viewSpaceId: spaceId });
  await gateway.submit(scoped, cancel, true);
  assert.deepEqual(transport.requests[2]!.body, scoped);
  transport.reply({ ...management, viewSpaceId: otherId });
  await assert.rejects(gateway.management(target, cancel, spaceId));
  transport.reply(manage());
  await assert.rejects(gateway.management(target, cancel, spaceId));
});

test('legacy v1/v2 hashes remain fixed and pure v3 has its own exact destination domain', () => {
  const selection = {
    kind: 'interaction_mute',
    duration: { kind: 'finite', unit: 'days', value: 7 },
    reason: 'Golden reason',
    expectedRevision: '0',
  };
  const vectors = {
    post: [
      '4d87bfbbb6e5713fccd4d86634171bc1cc97b45dc70b3eed45a3a950495aeb3c',
      'c057bfa34f5e0d58c157aeb72b2c5351765a78a9a7ed34d79151e91b4e2f444e',
      '459c5a540e68f39467503b00f76cf6ee61e449e6a95c00c1934fe00bc9cbf292',
    ],
  };
  const expected = vectors[target.kind];
  const commands = [
    command(),
    decodeAdminPostRemovalCommand({
      ...command(),
      version: 2,
      punishment: selection,
    }),
    decodeAdminPostRemovalCommand({
      ...command(),
      version: 3,
      viewSpaceId: spaceId,
    }),
  ];
  assert.deepEqual(
    commands.map((value) =>
      adminPostRemovalCommandHash(wireCredentials().accountId, value),
    ),
    expected,
  );
});
