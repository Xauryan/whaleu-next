import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  ThreadController,
  type ThreadView,
} from '../src/pages/community-thread/controller';
import { ReportProgressController } from '../src/community/report-controller';
import type { ReportGateway } from '../src/community/report-gateway';
import type { ReportProgress } from '../src/community/report-contract';
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
  decodeAdminDiscussionRemovalTarget,
  decodeAdminDiscussionRemovalManagement,
  decodeAdminDiscussionRemovalCommand,
  decodeAdminDiscussionRemovalReceipt,
  decodeAdminDiscussionRemovalRecovery,
  matchAdminDiscussionRemovalReceipt,
  adminDiscussionRemovalCommandHash,
} from '../src/admin-discussion-removal/contract';
import type {
  AdminDiscussionRemovalTarget,
  AdminDiscussionRemovalManagement,
  AdminDiscussionRemovalCommand,
  AdminDiscussionRemovalReceipt,
  AdminDiscussionRemovalRecovery,
} from '../src/admin-discussion-removal/contract';
import {
  AdminDiscussionRemovalController,
  type AdminDiscussionRemovalView,
} from '../src/admin-discussion-removal/controller';
import {
  HttpAdminDiscussionRemovalGateway,
  type AdminDiscussionRemovalGateway,
} from '../src/admin-discussion-removal/gateway';
import { PendingAdminDiscussionRemovalStore } from '../src/admin-discussion-removal/pending';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  setup,
  commentId,
  replyId,
  post,
  comment,
  reply,
} from './community-helpers';
import { wireCredentials } from './identity-helpers';

for (const kind of ['comment', 'reply'] as const) {
  const target: AdminDiscussionRemovalTarget = { kind, id: postId };
  const command = (
    patch: Partial<AdminDiscussionRemovalCommand> = {},
  ): AdminDiscussionRemovalCommand => ({
    clientRequestId: requestId,
    target,
    expectedTargetVersion: 'a'.repeat(64),
    action: 'remove_discussion',
    ...patch,
  });
  const receipt = (
    c = command(),
  ): Extract<AdminDiscussionRemovalReceipt, { outcome: 'applied' }> => ({
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
      | 'ADMIN_DISCUSSION_REMOVAL_CANCELLED'
      | 'ADMIN_DISCUSSION_REMOVAL_STALE' = 'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
  ): AdminDiscussionRemovalReceipt => ({
    requestId: c.clientRequestId,
    target: c.target,
    expectedTargetVersion: c.expectedTargetVersion,
    action: c.action,
    outcome: 'rejected',
    code,
  });
  const manage = (): AdminDiscussionRemovalManagement => ({
    target,
    targetVersion: 'a'.repeat(64),
    canRemove: true,
  });
  function harness(storage = new MemoryStorage()) {
    const s = setup(),
      commands: {
        command: AdminDiscussionRemovalCommand;
        cancelling: boolean;
      }[] = [];
    let settled = 0;
    const gateway: AdminDiscussionRemovalGateway = {
      management: async () => manage(),
      submit: async (c, _cancel, cancelling = false) => {
        commands.push({ command: c, cancelling });
        return cancelling ? rejection(c) : receipt(c);
      },
      receipt: async () => ({ state: 'not_recorded' }),
    };
    const store = new PendingAdminDiscussionRemovalStore(
      storage,
      'synthetic-origin',
    );
    const runtime: CommunityRuntime = {
      ...s.runtime,
      adminDiscussionRemoval: gateway,
      pendingAdminDiscussionRemoval: store,
    };
    let view!: AdminDiscussionRemovalView;
    const make = () =>
      new AdminDiscussionRemovalController(
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

  test(`${kind}: strict child-only commands reject private identities, arbitrary reasons, punishment, author mode and authority fields`, () => {
    assert.deepEqual(decodeAdminDiscussionRemovalTarget(target), target);
    assert.deepEqual(decodeAdminDiscussionRemovalCommand(command()), command());
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
      { target: { kind: 'post', id: postId } },
      { target: { kind: 'account', id: postId } },
      { target: { ...target, accountId: otherId } },
      { target: { kind, id: 'bad' } },
    ])
      assert.throws(() =>
        decodeAdminDiscussionRemovalCommand({ ...command(), ...patch }),
      );
  });

  test(`${kind}: management and receipts contain exact visible target and version only, including anonymous content`, () => {
    assert.deepEqual(
      decodeAdminDiscussionRemovalManagement(manage()),
      manage(),
    );
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
        decodeAdminDiscussionRemovalManagement({ ...manage(), ...patch }),
      );
    assert.deepEqual(decodeAdminDiscussionRemovalReceipt(receipt()), receipt());
    assert.deepEqual(
      decodeAdminDiscussionRemovalReceipt(rejection()),
      rejection(),
    );
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
        decodeAdminDiscussionRemovalReceipt({ ...receipt(), ...patch }),
      );
    for (const patch of [
      { requestId: otherId },
      { target: { kind, id: otherId } },
      { expectedTargetVersion: 'b'.repeat(64) },
    ])
      assert.throws(() =>
        matchAdminDiscussionRemovalReceipt(command(), {
          ...receipt(),
          ...patch,
        } as AdminDiscussionRemovalReceipt),
      );
    assert.deepEqual(
      decodeAdminDiscussionRemovalRecovery({ state: 'not_recorded' }),
      {
        state: 'not_recorded',
      },
    );
    assert.deepEqual(
      decodeAdminDiscussionRemovalRecovery({
        state: 'recorded',
        receipt: receipt(),
      }),
      { state: 'recorded', receipt: receipt() },
    );
    for (const value of [
      { state: 'unavailable' },
      { state: 'not_recorded', receipt: receipt() },
      { state: 'recorded' },
    ])
      assert.throws(() => decodeAdminDiscussionRemovalRecovery(value));
  });

  test(`${kind}: fresh target management alone controls confirmation; malformed permission or another target cannot authorize`, async (t) => {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    for (const result of [
      { ...manage(), canRemove: false },
      { ...manage(), target: { kind, id: otherId } },
    ]) {
      s.gateway.management = async () =>
        result as AdminDiscussionRemovalManagement;
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

  test(`${kind}: double submit freezes one exact command; stale receipt clears confirmation without silently replacing key`, async (t) => {
    const s = harness(),
      controller = s.make(),
      late = deferred<AdminDiscussionRemovalReceipt>();
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
    late.resolve(rejection(command(), 'ADMIN_DISCUSSION_REMOVAL_STALE'));
    await work;
    assert.equal(s.store.load(s.accountId), null);
    assert.match(s.view().receiptStatus, /未删除新状态/);
    await controller.submit();
    assert.equal(s.commands.length, 1);
  });

  test(`${kind}: journal pins actor, origin, exact body and cancel phase; removal failure retains recovery`, () => {
    const s = harness(),
      original = s.freeze();
    assert.deepEqual(s.store.load(s.accountId), original);
    assert.throws(() =>
      s.store.freeze({
        ...original,
        command: command({ target: { kind, id: otherId } }),
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
      new PendingAdminDiscussionRemovalStore(s.storage, 'other-origin').load(
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
      `whaleu.admin-discussion-removal.pending.v1:${s.store.origin}:${s.accountId}`,
      { ...original, origin: 'other-origin' },
    );
    assert.throws(() => s.store.load(s.accountId));
  });

  test(`${kind}: lost response and cold restart recover metadata without waiting for readable content or management`, async (t) => {
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

  test(`${kind}: not-recorded never replaces key; explicit retry uses original and cancellation persists before dispatch`, async (t) => {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.freeze();
    await controller.load();
    await controller.recover();
    assert.equal(s.view().frozen, true);
    await controller.request({ kind, id: otherId });
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
    s.gateway.receipt = async () => ({
      state: 'recorded',
      receipt: rejection(),
    });
    await restarted.recover();
    assert.equal(s.store.load(s.accountId), null);
    assert.equal(s.view().frozen, false);
  });

  test(`${kind}: unavailable or malformed recovery does not replay or release original key`, async (t) => {
    for (const response of [
      { state: 'unavailable' },
      { state: 'not_recorded', receipt: receipt() },
    ]) {
      const s = harness(),
        controller = s.make();
      t.after(() => controller.dispose());
      s.freeze();
      await controller.load();
      s.gateway.receipt = async () =>
        response as AdminDiscussionRemovalRecovery;
      await controller.recover(true);
      assert.equal(s.commands.length, 0);
      assert.equal(s.view().frozen, true);
      assert.ok(s.store.load(s.accountId));
    }
  });

  test(`${kind}: forged receipt and cancel-lost-to-apply race preserve exact original binding`, async (t) => {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.freeze();
    await controller.load();
    s.gateway.receipt = async () => ({
      state: 'recorded',
      receipt: { ...receipt(), target: { kind, id: otherId } },
    });
    await controller.recover();
    assert.equal(s.view().frozen, true);
    assert.equal(s.settled(), 0);
    s.gateway.submit = async () => receipt();
    controller.requestCancellation();
    await controller.confirmCancellation();
    assert.equal(s.store.load(s.accountId), null);
    assert.match(s.view().receiptStatus, /已确认删除评论\/回复/);
  });

  test(`${kind}: write failure, silent write and readback failure prevent any admin removal dispatch`, async (t) => {
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

  test(`${kind}: failed cancel-phase persistence and silent journal loss cannot dispatch new requests`, async (t) => {
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

  test(`${kind}: account change, same-account relogin and dispose ignore late receipts and keep old actor journal`, async (t) => {
    for (const mode of ['account', 'relogin', 'dispose'] as const) {
      const s = harness(),
        controller = s.make(),
        late = deferred<AdminDiscussionRemovalReceipt>();
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

  test(`${kind}: account or origin replacement while allocating secure ID cannot persist or dispatch`, async (t) => {
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
          pendingAdminDiscussionRemoval: new PendingAdminDiscussionRemovalStore(
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

  test(`${kind}: origin replacement while response is pending cannot settle old journal into new environment`, async (t) => {
    const s = harness(),
      controller = s.make(),
      late = deferred<AdminDiscussionRemovalReceipt>();
    t.after(() => controller.dispose());
    s.gateway.submit = () => late.promise;
    await controller.request(target);
    const work = controller.submit();
    await flush();
    Object.assign(s.runtime, {
      pendingAdminDiscussionRemoval: new PendingAdminDiscussionRemovalStore(
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

  test(`${kind}: settlement invalidates private/media and public readers before fresh public reads`, async (t) => {
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

  test(`${kind}: Safety invalidation resumes exact recovery GET only and drops an uncooperative old callback`, async (t) => {
    const s = harness(),
      safety = new SafetyChanges(s.runtime.privateViews),
      first = deferred<AdminDiscussionRemovalRecovery>();
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
      receipt: { ...receipt(), target: { kind, id: otherId } },
    });
    await work;
    assert.equal(s.view().frozen, false);
    assert.match(s.view().receiptStatus, /已确认删除评论\/回复/);
  });

  test(`${kind}: late management and close/hide never restore confirmation or persist a command`, async (t) => {
    const s = harness(),
      controller = s.make(),
      late = deferred<AdminDiscussionRemovalManagement>();
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

  test(`${kind}: HTTP family uses target-only management query and original command body for cancel without automatic auth replay`, async () => {
    const s = setup(),
      transport = new ScriptedTransport();
    let refreshes = 0;
    const api = new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => {
        refreshes++;
        return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
      },
    });
    const gateway = new HttpAdminDiscussionRemovalGateway(api),
      cancel = new Cancellation();
    transport.reply(manage());
    await gateway.management(target, cancel);
    const url = new URL(transport.requests[0]!.url);
    assert.equal(
      url.pathname,
      '/v1/community/admin-discussion-removal/management',
    );
    assert.deepEqual(Object.fromEntries(url.searchParams), target);
    transport.reply(receipt());
    await gateway.submit(command(), cancel);
    assert.match(
      transport.requests[1]!.url,
      /\/admin-discussion-removal\/commands$/,
    );
    assert.deepEqual(transport.requests[1]!.body, command());
    transport.reply(rejection());
    await gateway.submit(command(), cancel, true);
    assert.match(
      transport.requests[2]!.url,
      /\/admin-discussion-removal\/commands\/cancel$/,
    );
    assert.deepEqual(transport.requests[2]!.body, command());
    transport.reply({ state: 'recorded', receipt: receipt() });
    await gateway.receipt(requestId, cancel);
    assert.match(
      transport.requests[3]!.url,
      new RegExp(`/admin-discussion-removal/requests/${requestId}$`),
    );
    assert.equal(transport.requests[3]!.method, 'GET');
    transport.reply({ state: 'not_recorded' });
    assert.deepEqual(await gateway.receipt(requestId, cancel), {
      state: 'not_recorded',
    });
    transport.reply({ ...manage(), target: { kind, id: otherId } });
    await assert.rejects(gateway.management(target, cancel));
    transport.reply({ ...receipt(), target: { kind, id: otherId } });
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

  test(`${kind}: native page has explicit irreversible root/reply confirmation and anonymous entry without role-derived authority`, () => {
    const source = (name: string) =>
      readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
    const page = source(
      'pages/admin-discussion-removal/admin-discussion-removal.ts',
    );
    const wxml = source(
      'pages/admin-discussion-removal/admin-discussion-removal.wxml',
    );
    assert.match(
      source('app.json'),
      /pages\/admin-discussion-removal\/admin-discussion-removal/,
    );
    for (const handler of [
      'Reload',
      'RemoveDiscussion',
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
    assert.match(wxml, /该根评论及其全部回复将不可访问/);
    assert.match(wxml, /仅删除选中的这条回复/);
    assert.match(wxml, /不会通知作者/);
    assert.doesNotMatch(wxml, /作者已收到|并通知作者|私有系统通知/);
    assert.match(wxml, /没有恢复此内容的管理入口/);
    assert.match(wxml, /停止等待不会取消服务器处理/);
    assert.match(wxml, /management\.canRemove/);
    assert.doesNotMatch(
      wxml,
      /super_admin|school_admin|accountId|publicId|displayName/,
    );
    const detail = source('pages/community-detail/community-detail.wxml');
    const entry = detail.match(
      /<button[^>]*bindtap="onAdminDiscussionRemoval"[^>]*>[^<]*<\/button>/,
    )?.[0];
    assert.ok(entry);
    assert.match(entry, /!item.viewer.isSelf/);
    assert.doesNotMatch(entry, /author.kind|role|canManage/);
    assert.match(detail, /删除我的评论/);
    assert.match(
      source('pages/community-mine/community-mine.wxml'),
      /恢复本账号原管理员评论\/回复删除请求/,
    );
  });

  test(`${kind}: standalone moderation page state starts unloaded and recovery-only load never invents management readiness`, async (t) => {
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

  test(`${kind}: own-content management failure directs to established owner deletion without creating a new intent`, async (t) => {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.gateway.management = async () => {
      throw new ClientError('http', 'Own post', {
        httpStatus: 403,
        serverCode: 'ADMIN_DISCUSSION_REMOVAL_OWN_CONTENT',
      });
    };
    await controller.request(target);
    await controller.submit();
    assert.equal(s.view().ownContent, true);
    assert.match(s.view().error, /删除我的评论/);
    assert.equal(s.view().confirming, null);
    assert.equal(s.commands.length, 0);
  });

  test(`${kind}: post removal journal preserves nickname and avatar journals and detects hash tampering`, () => {
    const s = harness();
    const keys = [
      'admin-post-removal',
      'profile-moderation',
      'profile-avatar-moderation',
      'owner-post-visibility',
      'category-reclassification',
      'post-pins',
      'discussion',
      'report',
    ].map(
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
      `whaleu.admin-discussion-removal.pending.v1:${s.store.origin}:${s.accountId}`,
      { ...again, requestHash: '0'.repeat(64) },
    );
    assert.throws(() => s.store.load(s.accountId));
  });

  test(`${kind}: known applied receipt clears content/media readers even if journal removal fails, keeping original recovery blocked`, async (t) => {
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
    assert.match(s.view().receiptStatus, /已确认评论\/回复删除/);
    s.storage.failRemove = false;
    s.gateway.receipt = async () => ({ state: 'recorded', receipt: receipt() });
    await controller.recover();
    assert.equal(s.store.load(s.accountId), null);
    assert.equal(s.commands.length, 1);
  });

  test(`${kind}: kind is part of the hash, durable intent and receipt match even when UUIDs coincide`, () => {
    const s = harness(),
      alternate = command({
        target: {
          kind: kind === 'comment' ? 'reply' : 'comment',
          id: target.id,
        },
      });
    assert.notEqual(
      adminDiscussionRemovalCommandHash(s.accountId, command()),
      adminDiscussionRemovalCommandHash(s.accountId, alternate),
    );
    assert.throws(() =>
      matchAdminDiscussionRemovalReceipt(command(), receipt(alternate)),
    );
    const original = s.freeze();
    assert.throws(() => s.store.freeze({ ...original, command: alternate }));
    assert.deepEqual(s.store.load(s.accountId), original);
  });

  test(`${kind}: current same-account relogin and A to B to A never admit late management or secure-ID completion`, async (t) => {
    for (const phase of ['management', 'id'] as const) {
      const s = harness(),
        controller = s.make();
      t.after(() => controller.dispose());
      const management = deferred<AdminDiscussionRemovalManagement>(),
        random = deferred<string>();
      let work: Promise<void>;
      if (phase === 'management') {
        s.gateway.management = () => management.promise;
        work = controller.request(target);
      } else {
        await controller.request(target);
        Object.assign(s.runtime, { newRequestId: () => random.promise });
        work = controller.submit();
      }
      await flush();
      for (const accountId of [otherId, s.accountId]) {
        s.sessions.logout();
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials(),
          accountId,
        });
      }
      management.resolve(manage());
      random.resolve(requestId);
      await work;
      assert.equal(s.commands.length, 0);
      assert.equal(s.store.load(s.accountId), null);
      assert.equal(s.view().management, null);
      assert.equal(s.view().confirming, null);
    }
  });

  test(`${kind}: replaced valid durable intent and corruption cannot redirect original recovery`, async (t) => {
    for (const replacement of ['valid-other-kind', 'invalid-hash'] as const) {
      const s = harness(),
        controller = s.make();
      t.after(() => controller.dispose());
      const original = s.freeze();
      await controller.load();
      const other = command({
        target: {
          kind: kind === 'comment' ? 'reply' : 'comment',
          id: target.id,
        },
      });
      s.storage.set(
        `whaleu.admin-discussion-removal.pending.v1:${s.store.origin}:${s.accountId}`,
        {
          ...original,
          command: other,
          requestHash:
            replacement === 'valid-other-kind'
              ? adminDiscussionRemovalCommandHash(s.accountId, other)
              : '0'.repeat(64),
        },
      );
      let reads = 0;
      s.gateway.receipt = async () => {
        reads++;
        return { state: 'not_recorded' };
      };
      await controller.recover(true);
      controller.requestCancellation();
      await controller.confirmCancellation();
      assert.equal(reads, 0);
      assert.equal(s.commands.length, 0);
      assert.equal(s.view().frozen, true);
      assert.match(s.view().error, /本地保存失败/);
    }
  });

  test(`${kind}: initial storage read and silent removal failures fail closed`, async (t) => {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    const get = s.storage.get.bind(s.storage);
    s.storage.get = () => {
      throw Error('read failure');
    };
    await controller.request(target);
    await controller.submit();
    assert.equal(s.commands.length, 0);
    assert.equal(s.view().management, null);
    assert.equal(s.view().frozen, true);
    s.storage.get = get;
    await controller.request(target);
    s.storage.remove = () => undefined;
    await controller.submit();
    assert.equal(s.view().applied, true);
    assert.equal(s.view().frozen, true);
    assert.ok(s.store.load(s.accountId));
  });

  test(`${kind}: every business denial keeps target unconfirmed and never creates an intent`, async (t) => {
    for (const code of [
      'UNAVAILABLE',
      'TARGET_NOT_ALLOWED',
      'OWN_CONTENT',
      'STALE',
      'CANCELLED',
    ]) {
      const s = harness(),
        controller = s.make();
      t.after(() => controller.dispose());
      s.gateway.management = async () => {
        throw new ClientError('http', 'Denied', {
          httpStatus: 403,
          serverCode: `ADMIN_DISCUSSION_REMOVAL_${code}`,
        });
      };
      await controller.request(target);
      await controller.submit();
      assert.equal(s.view().management, null);
      assert.equal(s.view().confirming, null);
      assert.equal(s.commands.length, 0);
      assert.equal(s.store.load(s.accountId), null);
      assert.equal(s.view().ownContent, code === 'OWN_CONTENT');
      assert.ok(s.view().error);
    }
  });

  test(`${kind}: source-independent recovery accepts an invalid fresh target and stopped retry remains the original key`, async (t) => {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    const original = s.freeze(),
      late = deferred<AdminDiscussionRemovalRecovery>();
    s.gateway.management = async () => {
      throw Error('No target reads during recovery');
    };
    await controller.load({
      kind: 'post',
      id: 'invalid',
    } as unknown as AdminDiscussionRemovalTarget);
    assert.equal(s.view().pendingRequestId, original.command.clientRequestId);
    s.gateway.receipt = () => late.promise;
    const work = controller.recover(true);
    await flush();
    controller.cancel();
    late.resolve({ state: 'not_recorded' });
    await work;
    assert.equal(s.commands.length, 0);
    assert.deepEqual(s.store.load(s.accountId), original);
    s.gateway.receipt = async () => ({ state: 'recorded', receipt: receipt() });
    await controller.recover();
    assert.equal(s.store.load(s.accountId), null);
  });

  test(`${kind}: applied recovery with persistent storage failure invalidates once without recursive receipt reads`, async (t) => {
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
      management = 0;
    s.gateway.management = async () => {
      management++;
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
    assert.equal(management, 0);
    assert.equal(s.view().applied, true);
    assert.equal(s.view().frozen, true);
    assert.equal(s.view().recovering, false);
    assert.ok(s.store.load(s.accountId));
  });

  test(`${kind}: linked report-progress late visibility denial resumes only same-key GET and cannot restore stale Detail or Thread DTOs`, async (t) => {
    const s = harness(),
      safety = new SafetyChanges(s.runtime.privateViews);
    Object.assign(s.runtime, { safetyChanges: safety });
    const progress = deferred<ReportProgress>();
    const reports: ReportGateway = {
      progress: () => progress.promise,
      apply: async () => {
        throw Error('Unexpected report');
      },
      receipt: async () => {
        throw Error('Unexpected report receipt');
      },
    };
    Object.assign(s.runtime, { reports });
    let detail!: DetailView, thread!: ThreadView;
    const source = s.runtime.gateway!;
    source.post = async () => post();
    source.comment = async () => comment();
    source.comments = async () => ({ items: [comment()], nextCursor: null });
    source.replies = async () => ({ items: [reply()], nextCursor: null });
    source.discussionContext = async () => ({
      comment: comment(),
      reply: reply(),
      replies: { items: [reply()], nextCursor: null },
    });
    const detailController = new DetailController(
      s.runtime,
      postId,
      (view) => {
        detail = view;
      },
      undefined,
      { replyId },
    );
    const threadController = new ThreadController(
      s.runtime,
      postId,
      commentId,
      replyId,
      (view) => {
        thread = view;
      },
    );
    const reportController = new ReportProgressController(
      s.runtime,
      target,
      () => undefined,
    );
    const controller = s.make();
    t.after(() => {
      controller.dispose();
      detailController.dispose();
      threadController.dispose();
      reportController.dispose();
    });
    await detailController.load();
    await threadController.load();
    assert.ok(detail.locatedReply);
    assert.ok(thread.root);
    s.freeze('cancel');
    await controller.load();
    const staleDetail = deferred<ReturnType<typeof post>>(),
      oldReceipt = deferred<AdminDiscussionRemovalRecovery>();
    source.post = () => staleDetail.promise;
    const detailWork = detailController.load(),
      threadWork = threadController.load(),
      reportWork = reportController.load();
    let reads = 0;
    s.gateway.receipt = async (id) => {
      assert.equal(id, requestId);
      reads++;
      return reads === 1
        ? oldReceipt.promise
        : { state: 'recorded', receipt: receipt() };
    };
    const recovery = controller.recover(true);
    await flush();
    source.post = async () => {
      throw new ClientError('http', 'Source unavailable', {
        httpStatus: 404,
        serverCode: 'POST_NOT_FOUND',
      });
    };
    progress.reject(
      new ClientError('http', 'Target disappeared', {
        httpStatus: 404,
        serverCode: 'REPORT_TARGET_UNAVAILABLE',
      }),
    );
    await reportWork;
    await flush();
    assert.equal(s.commands.length, 0);
    assert.equal(reads, 2);
    assert.equal(s.store.load(s.accountId), null);
    staleDetail.resolve(post());
    oldReceipt.resolve({ state: 'not_recorded' });
    await Promise.all([detailWork, threadWork, recovery]);
    await flush();
    assert.equal(detail.post, null);
    assert.equal(detail.locatedComment, null);
    assert.equal(detail.locatedReply, null);
    assert.deepEqual(detail.comments, []);
    assert.equal(thread.post, null);
    assert.equal(thread.root, null);
    assert.deepEqual(thread.replies, []);
    assert.equal(thread.locatedReply, null);
    assert.equal(s.view().applied, true);
    assert.equal(s.commands.length, 0);
  });

  test(`${kind}: same-owner Safety reset preserves the unresolved original across missing or replaced journal storage`, async (t) => {
    for (const mode of ['missing', 'replaced', 'new-key', 'corrupt'] as const) {
      const s = harness();
      const safety = new SafetyChanges(s.runtime.privateViews);
      Object.assign(s.runtime, { safetyChanges: safety });
      const controller = s.make();
      t.after(() => controller.dispose());
      const original = s.freeze('cancel');
      await controller.load();
      let reads = 0,
        managementReads = 0;
      const first = deferred<AdminDiscussionRemovalRecovery>();
      s.gateway.receipt = (id) => {
        assert.equal(id, original.command.clientRequestId);
        reads++;
        return first.promise;
      };
      s.gateway.management = async () => {
        managementReads++;
        return manage();
      };
      const work = controller.recover(true);
      await flush();
      assert.equal(reads, 1);
      const key = `whaleu.admin-discussion-removal.pending.v1:${s.store.origin}:${s.accountId}`;
      if (mode === 'missing') s.storage.remove(key);
      else {
        const replacement = command({
          clientRequestId: mode === 'new-key' ? otherId : requestId,
          expectedTargetVersion: 'b'.repeat(64),
          target: {
            kind: kind === 'comment' ? 'reply' : 'comment',
            id: target.id,
          },
        });
        s.storage.set(key, {
          ...original,
          command: replacement,
          requestHash:
            mode === 'corrupt'
              ? '0'.repeat(64)
              : adminDiscussionRemovalCommandHash(s.accountId, replacement),
        });
      }
      safety.invalidate(s.accountId);
      await flush();
      assert.equal(s.view().frozen, true, mode);
      assert.equal(s.view().management, null, mode);
      assert.equal(s.view().confirming, null, mode);
      assert.match(s.view().error, /本地保存失败/, mode);
      // Every explicit path must remain blocked too; never adopt the replacement.
      await controller.load(target);
      await controller.request(target);
      await controller.submit();
      await controller.recover(true);
      controller.requestCancellation();
      await controller.confirmCancellation();
      first.resolve({ state: 'not_recorded' });
      await work;
      assert.equal(reads, 1, mode);
      assert.equal(managementReads, 0, mode);
      assert.equal(s.commands.length, 0, mode);
      assert.equal(s.view().frozen, true, mode);
      // Restoring the exact original allows recovery; it does not mint a new key.
      s.storage.set(key, original);
      s.gateway.receipt = async (id) => {
        assert.equal(id, original.command.clientRequestId);
        reads++;
        return { state: 'recorded', receipt: rejection() };
      };
      await controller.recover();
      assert.equal(reads, 2, mode);
      assert.equal(s.store.load(s.accountId), null, mode);
      assert.equal(s.view().frozen, false, mode);
      assert.equal(s.commands.length, 0, mode);
    }
  });
}
