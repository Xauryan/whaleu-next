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
  decodeCategoryManagement,
  decodeReclassificationCommand,
  decodeReclassificationReceipt,
  decodeReclassificationRecovery,
  matchReclassificationReceipt,
  reclassificationCategories,
} from '../src/category-reclassification/contract';
import type {
  CategoryManagement,
  ReclassificationCommand,
  ReclassificationReceipt,
  ReclassificationRecovery,
} from '../src/category-reclassification/contract';
import {
  CategoryReclassificationController,
  type CategoryReclassificationView,
} from '../src/category-reclassification/controller';
import {
  HttpCategoryReclassificationGateway,
  type CategoryReclassificationGateway,
} from '../src/category-reclassification/gateway';
import { PendingCategoryReclassificationStore } from '../src/category-reclassification/pending';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  setup,
} from './community-helpers';
import { wireCredentials } from './identity-helpers';

const command = (
  patch: Partial<ReclassificationCommand> = {},
): ReclassificationCommand => ({
  clientRequestId: requestId,
  postId,
  expectedRevision: 0,
  targetCategory: 'scenery',
  ...patch,
});
const receipt = (
  c = command(),
): Extract<ReclassificationReceipt, { outcome: 'applied' }> => ({
  requestId: c.clientRequestId,
  postId: c.postId,
  expectedRevision: c.expectedRevision,
  targetCategory: c.targetCategory,
  outcome: 'applied',
  revision: c.expectedRevision + 1,
  eventId: otherId,
  recordedAt: createdAt,
});
const rejection = (
  c = command(),
  code:
    | 'POST_CATEGORY_CANCELLED'
    | 'POST_CATEGORY_STALE'
    | 'POST_CATEGORY_UNAVAILABLE' = 'POST_CATEGORY_CANCELLED',
): ReclassificationReceipt => ({
  requestId: c.clientRequestId,
  postId: c.postId,
  expectedRevision: c.expectedRevision,
  targetCategory: c.targetCategory,
  outcome: 'rejected',
  code,
});
const manage = (): CategoryManagement => ({
  postId,
  currentCategory: 'pets',
  revision: 0,
  canChange: true,
  targets: ['pets', 'scenery'],
});
function harness(storage = new MemoryStorage()) {
  const s = setup(),
    commands: { command: ReclassificationCommand; cancelling: boolean }[] = [];
  let management = manage(),
    settled = 0;
  const gateway: CategoryReclassificationGateway = {
    management: async () => management,
    submit: async (c, _cancel, cancelling = false) => {
      commands.push({ command: c, cancelling });
      if (cancelling) return rejection(c);
      management = {
        ...management,
        currentCategory: c.targetCategory,
        revision: c.expectedRevision + 1,
      };
      return receipt(c);
    },
    receipt: async () => ({ state: 'not_recorded' }),
  };
  const store = new PendingCategoryReclassificationStore(
    storage,
    'synthetic-origin',
  );
  const runtime: CommunityRuntime = {
    ...s.runtime,
    categoryReclassification: gateway,
    pendingCategoryReclassification: store,
  };
  let view!: CategoryReclassificationView;
  const make = () =>
    new CategoryReclassificationController(
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

test('strict command permits all nine vocabulary candidates without granting authority or accepting policy', () => {
  for (const targetCategory of reclassificationCategories)
    assert.deepEqual(
      decodeReclassificationCommand(command({ targetCategory })),
      command({ targetCategory }),
    );
  for (const patch of [
    { actorId: otherId },
    { scopeId: otherId },
    { originalCategory: 'pets' },
    { policyId: otherId },
    { grantId: otherId },
    { role: 'super_admin' },
    { targetCategory: 'feedback' },
    { targetCategory: 'trading' },
    { targetCategory: 'unknown' },
    { targetCategory: 10 },
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: 2147483647 },
    { expectedRevision: Number.NaN },
    { clientRequestId: 'bad' },
    { clientRequestId: requestId.replace('-4777-', '-1777-') },
    { postId: 'bad' },
  ])
    assert.throws(() =>
      decodeReclassificationCommand({ ...command(), ...patch }),
    );
  assert.equal(
    decodeReclassificationCommand(command({ expectedRevision: 2147483646 }))
      .expectedRevision,
    2147483646,
  );
});

test('management is authoritative, metadata-only and fail-closed for unsupported current categories', () => {
  assert.deepEqual(decodeCategoryManagement(manage()), manage());
  for (const currentCategory of ['feedback', 'trading'] as const)
    assert.deepEqual(
      decodeCategoryManagement({
        ...manage(),
        currentCategory,
        canChange: false,
        targets: [],
      }),
      {
        ...manage(),
        currentCategory,
        canChange: false,
        targets: [],
      },
    );
  for (const patch of [
    { currentCategory: 'unknown' },
    { targets: ['pets', 'pets'] },
    { targets: ['trading'] },
    { targets: ['feedback'] },
    { targets: [] },
    { canChange: false },
    { currentCategory: 'trading' },
    { revision: 2147483647 },
    { text: 'unwanted body' },
    { actor: { role: 'super_admin' } },
  ])
    assert.throws(() => decodeCategoryManagement({ ...manage(), ...patch }));
});

test('receipts enforce exact revision/event continuity including authenticated no-op and stale same-target', () => {
  assert.deepEqual(decodeReclassificationReceipt(receipt()), receipt());
  const unchanged = {
    ...receipt(),
    outcome: 'unchanged',
    revision: 0,
    eventId: null,
  };
  assert.equal(decodeReclassificationReceipt(unchanged).outcome, 'unchanged');
  assert.equal(
    decodeReclassificationReceipt({
      ...receipt(command({ expectedRevision: 2 })),
      outcome: 'unchanged',
      revision: 2,
    }).outcome,
    'unchanged',
  );
  assert.equal(
    decodeReclassificationReceipt(
      rejection(command({ targetCategory: 'pets' }), 'POST_CATEGORY_STALE'),
    ).outcome,
    'rejected',
  );
  for (const patch of [
    { revision: 0 },
    { revision: 2 },
    { eventId: null },
    { recordedAt: 'bad' },
    { text: 'unwanted body' },
    { author: { kind: 'named' } },
    { outcome: 'unknown' },
  ])
    assert.throws(() =>
      decodeReclassificationReceipt({ ...receipt(), ...patch }),
    );
  assert.throws(() =>
    decodeReclassificationReceipt({ ...unchanged, eventId: otherId }),
  );
  assert.throws(() =>
    decodeReclassificationReceipt({
      ...unchanged,
      expectedRevision: 1,
      revision: 1,
    }),
  );
  for (const patch of [
    { requestId: otherId },
    { postId: otherId },
    { targetCategory: 'pets' },
    { expectedRevision: 1 },
  ])
    assert.throws(() =>
      matchReclassificationReceipt(command(), {
        ...receipt(),
        ...patch,
      } as ReclassificationReceipt),
    );
  for (const state of ['not_recorded', 'unavailable'] as const)
    assert.deepEqual(decodeReclassificationRecovery({ state }), { state });
  assert.deepEqual(
    decodeReclassificationRecovery({ state: 'recorded', receipt: receipt() }),
    { state: 'recorded', receipt: receipt() },
  );
  assert.throws(() =>
    decodeReclassificationRecovery({
      state: 'not_recorded',
      receipt: receipt(),
    }),
  );
  assert.throws(() => decodeReclassificationRecovery({ state: 'recorded' }));
});

test('journal pins actor, origin, exact body and cancel phase; removal failure retains recovery', () => {
  const s = harness(),
    original = s.freeze();
  assert.deepEqual(s.store.load(s.accountId), original);
  assert.throws(() =>
    s.store.freeze({
      ...original,
      command: command({ targetCategory: 'pets' }),
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
    new PendingCategoryReclassificationStore(s.storage, 'other-origin').load(
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
    `whaleu.category-reclassification.pending.v1:${s.store.origin}:${s.accountId}`,
    { ...original, origin: 'other-origin' },
  );
  assert.throws(() => s.store.load(s.accountId));
});

test('fresh server permission and allowed targets alone control confirmation; post ownership or client vocabulary never grants it', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.management = async () => ({
    ...manage(),
    canChange: false,
    targets: [],
  });
  await controller.request(postId, 'scenery');
  await controller.submit();
  assert.equal(s.view().confirming, null);
  s.gateway.management = async () => manage();
  await controller.request(postId, 'research');
  await controller.submit();
  assert.equal(s.view().confirming, null);
  await controller.request(postId, 'trading');
  assert.equal(s.commands.length, 0);
  s.gateway.management = async () => ({ ...manage(), revision: 4 });
  await controller.request(postId, 'scenery');
  assert.equal(s.view().confirming, 'change');
  await controller.submit();
  assert.equal(s.commands[0]!.command.expectedRevision, 4);
});

test('duplicate taps dispatch one durable exact original and move-back obtains a fresh version', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<ReclassificationReceipt>();
  t.after(() => controller.dispose());
  s.gateway.submit = async (c, _cancel, cancelling = false) => {
    s.commands.push({ command: c, cancelling });
    return late.promise;
  };
  await controller.request(postId, 'scenery');
  const work = controller.submit();
  await controller.submit();
  await flush();
  assert.equal(s.commands.length, 1);
  assert.deepEqual(s.store.load(s.accountId)?.command, command());
  late.resolve(receipt());
  await work;
  assert.equal(s.view().frozen, false);
  assert.equal(s.settled(), 1);
  s.gateway.management = async () => ({
    ...manage(),
    currentCategory: 'scenery',
    revision: 1,
  });
  Object.assign(s.runtime, { newRequestId: async () => otherId });
  s.gateway.submit = async (c) => {
    assert.deepEqual(
      c,
      command({
        clientRequestId: otherId,
        expectedRevision: 1,
        targetCategory: 'pets',
      }),
    );
    return receipt(c);
  };
  await controller.request(postId, 'pets');
  await controller.submit();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.settled(), 2);
});

test('same-category confirmation still reaches authoritative no-op; stale response never silently creates a replacement', async (t) => {
  for (const outcome of ['unchanged', 'stale'] as const) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.gateway.submit = async (c) => {
      s.commands.push({ command: c, cancelling: false });
      if (outcome === 'stale') return rejection(c, 'POST_CATEGORY_STALE');
      return {
        ...receipt(c),
        outcome: 'unchanged',
        revision: c.expectedRevision,
        eventId: null,
      };
    };
    await controller.request(postId, 'pets');
    await controller.submit();
    assert.equal(s.commands.length, 1);
    assert.equal(s.store.load(s.accountId), null);
    assert.match(
      s.view().receiptStatus,
      outcome === 'unchanged' ? /无需变更/ : /未覆盖新状态/,
    );
    await controller.submit();
    assert.equal(s.commands.length, 1);
  }
});

test('lost response and cold restart recover metadata without waiting for readable content or management', async (t) => {
  const s = harness();
  let controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.submit = async (c) => {
    s.commands.push({ command: c, cancelling: false });
    throw new ClientError('timeout', 'response lost');
  };
  await controller.request(postId, 'scenery');
  await controller.submit();
  assert.equal(s.view().frozen, true);
  controller.dispose();
  controller = s.make();
  s.gateway.management = async () => {
    throw new Error('Recovery must not read content or management');
  };
  await controller.load(postId);
  assert.equal(s.view().management, null);
  assert.equal(s.view().pendingPostId, postId);
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
  await controller.request(otherId, 'pets');
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
    s.gateway.receipt = async () => response as ReclassificationRecovery;
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
    receipt: { ...receipt(), targetCategory: 'pets' },
  });
  await controller.recover();
  assert.equal(s.view().frozen, true);
  assert.equal(s.settled(), 0);
  s.gateway.submit = async () => receipt();
  controller.requestCancellation();
  await controller.confirmCancellation();
  assert.equal(s.store.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /已确认分类变更/);
});

test('write failure, silent write and readback failure prevent any category dispatch', async (t) => {
  for (const mode of ['throw', 'silent', 'readback'] as const) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    await controller.request(postId, 'scenery');
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
  await controller.request(postId, 'pets');
  await controller.submit();
  assert.equal(s.commands.length, 0);
  assert.equal(s.view().frozen, true);
});

test('account change, same-account relogin and dispose ignore late receipts and keep old actor journal', async (t) => {
  for (const mode of ['account', 'relogin', 'dispose'] as const) {
    const s = harness(),
      controller = s.make(),
      late = deferred<ReclassificationReceipt>();
    t.after(() => controller.dispose());
    s.gateway.submit = () => late.promise;
    await controller.request(postId, 'scenery');
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
    await controller.request(postId, 'scenery');
    const work = controller.submit();
    await flush();
    if (mode === 'account') s.sessions.logout();
    else
      Object.assign(s.runtime, {
        pendingCategoryReclassification:
          new PendingCategoryReclassificationStore(s.storage, 'other-origin'),
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
    late = deferred<ReclassificationReceipt>();
  t.after(() => controller.dispose());
  s.gateway.submit = () => late.promise;
  await controller.request(postId, 'scenery');
  const work = controller.submit();
  await flush();
  Object.assign(s.runtime, {
    pendingCategoryReclassification: new PendingCategoryReclassificationStore(
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

test('settlement invalidates private/media and public readers before new category reads', async (t) => {
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
  await controller.request(postId, 'scenery');
  await controller.submit();
  await flush();
  assert.deepEqual(calls, ['private', 'read']);
  assert.equal(s.store.load(s.accountId), null);
});

test('Safety invalidation resumes exact recovery GET only and drops an uncooperative old callback', async (t) => {
  const s = harness(),
    safety = new SafetyChanges(s.runtime.privateViews),
    first = deferred<ReclassificationRecovery>();
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
    receipt: { ...receipt(), postId: otherId },
  });
  await work;
  assert.equal(s.view().frozen, false);
  assert.match(s.view().receiptStatus, /已确认分类变更/);
});

test('HTTP routes use strict exact body and recovery envelope without automatic auth replay', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const api = new ApiClient('https://api.example', transport, s.sessions, {
    refresh: async () => {
      refreshes++;
      return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
    },
  });
  const gateway = new HttpCategoryReclassificationGateway(api),
    cancel = new Cancellation();
  transport.reply(manage());
  await gateway.management(postId, cancel);
  assert.match(
    transport.requests[0]!.url,
    new RegExp(`/v1/community/posts/${postId}/category-management$`),
  );
  transport.reply(receipt());
  await gateway.submit(command(), cancel);
  assert.match(
    transport.requests[1]!.url,
    /\/v1\/community\/category-commands$/,
  );
  assert.deepEqual(transport.requests[1]!.body, command());
  transport.reply(rejection());
  await gateway.submit(command(), cancel, true);
  assert.match(
    transport.requests[2]!.url,
    new RegExp(`/category-requests/${requestId}/cancel$`),
  );
  assert.deepEqual(transport.requests[2]!.body, command());
  transport.reply({ state: 'recorded', receipt: receipt() });
  await gateway.receipt(requestId, cancel);
  assert.match(
    transport.requests[3]!.url,
    new RegExp(`/category-requests/${requestId}$`),
  );
  assert.equal(transport.requests[3]!.method, 'GET');
  transport.reply({ state: 'not_recorded' });
  assert.deepEqual(await gateway.receipt(requestId, cancel), {
    state: 'not_recorded',
  });
  transport.reply({ ...manage(), postId: otherId });
  await assert.rejects(gateway.management(postId, cancel));
  transport.reply({ ...receipt(), targetCategory: 'pets' });
  await assert.rejects(gateway.submit(command(), cancel));
  transport.reply({
    state: 'recorded',
    receipt: { ...receipt(), requestId: otherId },
  });
  await assert.rejects(gateway.receipt(requestId, cancel));
  transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(gateway.submit(command(), cancel));
  assert.equal(refreshes, 0);
  assert.equal(transport.requests.length, 9);
});

test('native detail registers category management and metadata-only recovery outside readable content', () => {
  const ts = readFileSync(
    path.resolve(
      __dirname,
      '../src/pages/community-detail/community-detail.ts',
    ),
    'utf8',
  );
  const wxml = readFileSync(
    path.resolve(
      __dirname,
      '../src/pages/community-detail/community-detail.wxml',
    ),
    'utf8',
  );
  const template = readFileSync(
    path.resolve(__dirname, '../src/category-reclassification/management.wxml'),
    'utf8',
  );
  assert.match(wxml, /<template is="category-reclassification"/);
  for (const handler of [
    'Choose',
    'Submit',
    'Recover',
    'Retry',
    'Cancel',
    'ConfirmCancel',
    'Close',
  ])
    assert.match(ts, new RegExp(`onCategory${handler}\\(`));
  assert.match(ts, /categoryController\?\.dispose/);
  assert.match(ts, /!this\.data\.categoryManagement\.frozen/);
  assert.match(template, /category\.management\.canChange/);
  assert.match(template, /category\.management\.targets/);
  assert.match(template, /category\.frozen/);
  assert.doesNotMatch(
    template,
    /post\.text|post\.images|post\.author|super_admin|school_admin/,
  );
});

test('related sync unsupported category capability has no targets and cannot confirm', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  const unavailable = {
    ...manage(),
    canChange: false,
    targets: [],
    blocker: 'related_sync_unsupported' as const,
  };
  assert.deepEqual(decodeCategoryManagement(unavailable), unavailable);
  for (const patch of [
    { canChange: true },
    { targets: ['scenery'] },
    { blocker: 'other' },
    { subjectId: otherId },
  ])
    assert.throws(() => decodeCategoryManagement({ ...unavailable, ...patch }));
  s.gateway.management = async () => unavailable;
  await controller.request(postId, 'scenery');
  assert.equal(s.view().confirming, null);
  assert.match(s.view().status, /关联校区同步内容暂不支持/);
  await controller.submit();
  assert.equal(s.commands.length, 0);
});
