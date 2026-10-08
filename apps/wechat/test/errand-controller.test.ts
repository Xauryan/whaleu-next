import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  ErrandController,
  type ErrandMode,
  type ErrandView,
} from '../src/errands/controller';
import {
  errandRejections,
  type ErrandContactHistory,
  type ErrandDetail,
  type ErrandIntent,
  type ErrandOperation,
  type ErrandPage,
  type ErrandReceipt,
  type ErrandSummary,
} from '../src/errands/contract';
import type { ErrandsGateway } from '../src/errands/gateway';
import { PendingErrandStore } from '../src/errands/pending';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import {
  otherId,
  postId,
  requestId,
  setup,
  spaceId,
} from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';

const orderId = postId;
const regionId = spaceId;
const revision = '11111111-1111-4111-8111-111111111111';
const nextRevision = '22222222-2222-4222-8222-222222222222';
const occurredAt = '2026-10-08T12:00:00.000Z';
const privateText = 'Synthetic participant-only instructions';
const contacts = () => ({ wechat: 'synthetic-contact', phone: '12345678901' });
const noContacts = () => ({ wechat: '', phone: '' });
const noCapabilities = () => ({
  accept: false,
  cancel: false,
  complete: false,
  delete: false,
});
const summary = (patch: Partial<ErrandSummary> = {}): ErrandSummary => ({
  id: orderId,
  revision,
  title: 'Synthetic errand',
  publicText: 'Synthetic public instructions',
  expectedTimeText: 'Tomorrow',
  reward: '12.3456789',
  state: 'pending',
  createdAt: occurredAt,
  acceptedAt: null,
  completedAt: null,
  cancelledAt: null,
  targetRegion: { id: regionId, label: 'Synthetic target' },
  sourceRegion: { id: otherId, label: 'Synthetic source' },
  scope: 'home',
  ...patch,
});
const detail = (patch: Partial<ErrandDetail> = {}): ErrandDetail => ({
  ...summary(),
  relation: 'none',
  capabilities: { ...noCapabilities(), accept: true },
  ...patch,
});
const participant = (
  relation: 'publisher' | 'accepter' = 'publisher',
  patch: Partial<ErrandDetail> = {},
): ErrandDetail =>
  detail({
    state: 'accepted',
    acceptedAt: occurredAt,
    relation,
    privateText,
    oppositeContact: {
      display: { status: 'available', displayName: 'Synthetic participant' },
      contacts: contacts(),
    },
    capabilities:
      relation === 'publisher'
        ? { accept: false, cancel: true, complete: true, delete: true }
        : noCapabilities(),
    ...patch,
  });
const page = (patch: Partial<ErrandPage> = {}): ErrandPage => ({
  context: { kind: 'own', relation: 'published' },
  items: [summary()],
  continuation: 'end',
  nextCursor: null,
  ...patch,
});
const intent = (operation: ErrandOperation = 'accept'): ErrandIntent =>
  operation === 'publish'
    ? {
        operation,
        payload: {
          clientRequestId: requestId,
          targetRegionId: regionId,
          title: 'Synthetic errand',
          publicText: 'Synthetic public instructions',
          privateText,
          expectedTimeText: 'Tomorrow',
          reward: '12.3456789',
          publisherContacts: contacts(),
          publicAssetIds: [],
          privateAssetIds: [],
        },
      }
    : operation === 'accept'
      ? {
          operation,
          orderId,
          payload: {
            clientRequestId: requestId,
            expectedRevision: revision,
            contacts: contacts(),
          },
        }
      : {
          operation,
          orderId,
          payload: { clientRequestId: requestId, expectedRevision: revision },
        };
const applied = (command: ErrandIntent = intent()): ErrandReceipt => ({
  requestId: command.payload.clientRequestId,
  operation: command.operation,
  outcome: 'applied',
  orderId: command.operation === 'publish' ? orderId : command.orderId,
  revision: nextRevision,
  occurredAt,
});
const rejected = (
  command: ErrandIntent,
  code = 'ERRAND_STATE_CONFLICT',
): ErrandReceipt => ({
  requestId: command.payload.clientRequestId,
  operation: command.operation,
  outcome: 'rejected',
  code,
});

class FakeErrandsGateway implements ErrandsGateway {
  readonly calls: Array<{ method: string; args: readonly unknown[] }> = [];
  readonly commands: ErrandIntent[] = [];
  regionsImpl: ErrandsGateway['regions'] = async () => [
    { id: regionId, label: 'Synthetic target' },
  ];
  listImpl: ErrandsGateway['list'] = async (query) =>
    page({
      context: {
        kind: 'discovery',
        regionId: query.regionId,
        discoveryMode: 'home',
      },
    });
  mineImpl: ErrandsGateway['mine'] = async (relation) =>
    page({ context: { kind: 'own', relation } });
  detailImpl: ErrandsGateway['detail'] = async (id) => detail({ id });
  contactHistoryImpl: ErrandsGateway['contactHistory'] = async () => ({
    status: 'available',
    contacts: contacts(),
  });
  commandImpl: ErrandsGateway['command'] = async (command) => applied(command);
  receiptImpl: ErrandsGateway['receipt'] = async () => {
    throw new ClientError('http', 'Synthetic missing receipt', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  regions(...args: Parameters<ErrandsGateway['regions']>) {
    this.calls.push({ method: 'regions', args });
    return this.regionsImpl(...args);
  }
  list(...args: Parameters<ErrandsGateway['list']>) {
    this.calls.push({ method: 'list', args });
    return this.listImpl(...args);
  }
  mine(...args: Parameters<ErrandsGateway['mine']>) {
    this.calls.push({ method: 'mine', args });
    return this.mineImpl(...args);
  }
  detail(...args: Parameters<ErrandsGateway['detail']>) {
    this.calls.push({ method: 'detail', args });
    return this.detailImpl(...args);
  }
  contactHistory(...args: Parameters<ErrandsGateway['contactHistory']>) {
    this.calls.push({ method: 'contactHistory', args });
    return this.contactHistoryImpl(...args);
  }
  command(...args: Parameters<ErrandsGateway['command']>) {
    this.calls.push({ method: 'command', args });
    this.commands.push(args[0]);
    return this.commandImpl(...args);
  }
  receipt(...args: Parameters<ErrandsGateway['receipt']>) {
    this.calls.push({ method: 'receipt', args });
    return this.receiptImpl(...args);
  }
}
function harness(mode: ErrandMode = 'detail', noProfile = false) {
  const s = setup();
  const errands = new FakeErrandsGateway();
  const pendingErrands = new PendingErrandStore(s.storage, 'synthetic');
  const safetyChanges = new SafetyChanges(s.runtime.privateViews);
  const directoryScopeChanges = new PrivateViewLifecycle();
  const browsingScopeChanges = new PrivateViewLifecycle();
  const ids = {
    count: 0,
    next: async (): Promise<string> => requestId,
  };
  const runtime: CommunityRuntime = {
    ...s.runtime,
    ...(noProfile ? { profiles: undefined } : {}),
    errands,
    pendingErrands,
    safetyChanges,
    directoryScopeChanges,
    browsingScopeChanges,
    newRequestId: () => {
      ids.count++;
      return ids.next();
    },
  };
  const views: ErrandView[] = [];
  const controller = new ErrandController(runtime, mode, (view) =>
    views.push(view),
  );
  return {
    ...s,
    runtime,
    errands,
    pendingErrands,
    safetyChanges,
    directoryScopeChanges,
    browsingScopeChanges,
    ids,
    views,
    controller,
    view: () => views[views.length - 1]!,
  };
}
type Harness = ReturnType<typeof harness>;
function freeze(s: Harness, operation: ErrandOperation = 'accept') {
  return s.pendingErrands.freeze({
    version: 1,
    accountId: s.accountId,
    intent: intent(operation),
  });
}
function fill(c: ErrandController): void {
  const publication = intent('publish');
  assert.equal(publication.operation, 'publish');
  if (publication.operation !== 'publish') return;
  for (const [key, value] of Object.entries({
    title: publication.payload.title,
    publicText: publication.payload.publicText,
    privateText: publication.payload.privateText,
    expectedTimeText: publication.payload.expectedTimeText,
    reward: '12.3456789000',
    ...contacts(),
  }))
    c.setForm(key, value);
}
async function prepare(operation: ErrandOperation): Promise<Harness> {
  const s = harness(operation === 'publish' ? 'compose' : 'detail');
  if (operation === 'publish') {
    await s.controller.load({ regionId });
    fill(s.controller);
  } else if (operation === 'accept') {
    await s.controller.load({ orderId });
    await s.controller.openAccept();
  } else {
    s.errands.detailImpl = async () => participant();
    await s.controller.load({ orderId });
    s.controller.confirm(operation);
  }
  return s;
}
function submit(s: Harness, operation: ErrandOperation): Promise<void> {
  if (operation === 'publish') return s.controller.publish();
  if (operation === 'accept') return s.controller.accept();
  s.controller.confirm(operation);
  return s.controller.confirmCommand();
}
function assertPrivateCleared(s: Harness): void {
  assert.equal(s.view().detail, null);
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().acceptModal, false);
  assert.deepEqual(s.view().contacts, noContacts());
  assert.equal(s.view().useLast, false);
  assert.equal(s.view().historyStatus, '');
  assert.equal(s.view().confirmAction, null);
  assert.equal(s.view().form.privateText, '');
  assert.equal(s.view().form.wechat, '');
  assert.equal(s.view().form.phone, '');
}

for (const operation of [
  'publish',
  'accept',
  'cancel',
  'complete',
  'delete',
] as const) {
  test(`repeated ${operation} taps mint and dispatch one persisted request`, async () => {
    const s = await prepare(operation);
    const result = deferred<ErrandReceipt>();
    s.errands.commandImpl = async (command) => {
      assert.deepEqual(s.pendingErrands.load(s.accountId)?.intent, command);
      return result.promise;
    };
    const running = submit(s, operation);
    await Promise.all([submit(s, operation), submit(s, operation)]);
    await flush();
    assert.equal(s.ids.count, 1);
    assert.equal(s.errands.commands.length, 1);
    assert.equal(s.view().frozen, true);
    assertPrivateCleared(s);
    result.resolve(applied(s.errands.commands[0]!));
    await running;
    assert.equal(s.pendingErrands.load(s.accountId), null);
    assert.equal(s.view().frozen, false);
    assert.equal(s.view().confirmedOrderId, orderId);
    s.controller.dispose();
  });

  test(`unknown ${operation} commit retains identical key and payload across restart, missing receipt, and retry`, async () => {
    const s = await prepare(operation);
    s.errands.commandImpl = async () => {
      throw new ClientError('timeout', 'Synthetic unknown commit');
    };
    await submit(s, operation);
    const original = s.pendingErrands.load(s.accountId)!;
    const bytes = JSON.stringify(original);
    assert.deepEqual(original.intent, intent(operation));
    s.controller.setForm('privateText', 'Replacement must not be sent');
    s.controller.setContact('wechat', 'Replacement must not be sent');
    await submit(s, operation);
    assert.equal(s.errands.commands.length, 1);
    s.controller.dispose();
    const views: ErrandView[] = [];
    const reopened = new ErrandController(
      s.runtime,
      operation === 'publish' ? 'compose' : 'detail',
      (view) => views.push(view),
    );
    await reopened.load(operation === 'publish' ? { regionId } : { orderId });
    assert.equal(views[views.length - 1]!.frozen, true);
    await reopened.recover();
    assert.equal(JSON.stringify(s.pendingErrands.load(s.accountId)), bytes);
    s.errands.commandImpl = async (command) => {
      assert.equal(JSON.stringify(command), JSON.stringify(original.intent));
      return applied(command);
    };
    await reopened.recover(true);
    assert.equal(s.ids.count, 1);
    assert.equal(s.errands.commands.length, 2);
    assert.equal(s.pendingErrands.load(s.accountId), null);
    assert.equal(views[views.length - 1]!.frozen, false);
    reopened.dispose();
  });
}

for (const mode of ['list', 'compose', 'mine', 'detail'] as const) {
  test(`${mode} startup checks the persisted receipt before profile, region, or parent reads`, async () => {
    const s = harness(mode);
    freeze(s, 'publish');
    const result = deferred<ErrandReceipt>();
    s.errands.receiptImpl = async () => result.promise;
    const running = s.controller.load(mode === 'detail' ? { orderId } : {});
    await flush();
    assert.deepEqual(
      s.errands.calls.map((call) => call.method),
      ['receipt'],
    );
    assert.deepEqual(s.profiles.calls, []);
    assert.equal(s.view().frozen, true);
    result.resolve(applied(intent('publish')));
    await running;
    assert.equal(s.pendingErrands.load(s.accountId), null);
    assert.equal(s.view().loaded, true);
    assert.equal(s.view().confirmedOrderId, orderId);
    assert.deepEqual(
      s.errands.calls.map((call) => call.method),
      mode === 'detail'
        ? ['receipt', 'detail']
        : mode === 'mine'
          ? ['receipt', 'mine']
          : mode === 'list'
            ? ['receipt', 'regions', 'list']
            : ['receipt', 'regions'],
    );
    s.controller.dispose();
  });
}

for (const failure of [
  'write throws',
  'write disappears',
  'read throws',
] as const) {
  test(`storage ${failure} prevents dispatch of a new errand`, async () => {
    const s = await prepare('publish');
    if (failure === 'write throws') s.storage.failWrite = true;
    if (failure === 'write disappears') s.storage.set = () => undefined;
    if (failure === 'read throws')
      s.storage.get = () => {
        throw new Error('Synthetic unavailable storage');
      };
    await s.controller.publish();
    assert.equal(s.errands.commands.length, 0);
    assert.match(s.view().error, /保存失败/);
    assert.equal(s.view().confirmedOrderId, '');
    if (failure === 'read throws') assert.equal(s.view().frozen, true);
    s.controller.dispose();
  });
}

test('failed journal removal cannot turn an applied receipt into confirmed UI or a new command', async () => {
  const s = await prepare('accept');
  s.storage.failRemove = true;
  await s.controller.accept();
  const original = s.pendingErrands.load(s.accountId)!;
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().confirmedOrderId, '');
  assertPrivateCleared(s);
  await s.controller.accept();
  assert.equal(s.errands.commands.length, 1);
  s.storage.failRemove = false;
  s.errands.receiptImpl = async () => applied(original.intent);
  await s.controller.recover();
  assert.equal(s.pendingErrands.load(s.accountId), null);
  assert.equal(s.view().confirmedOrderId, orderId);
  s.controller.dispose();
});

for (const code of errandRejections) {
  test(`terminal ${code} receipt settles the original attempt`, async () => {
    const s = await prepare('accept');
    s.errands.commandImpl = async (command) => rejected(command, code);
    await s.controller.accept();
    assert.equal(s.pendingErrands.load(s.accountId), null);
    assert.equal(s.view().frozen, false);
    assert.equal(s.view().confirmedOrderId, '');
    assert.notEqual(s.view().receiptStatus, '');
    assert.equal(s.view().acceptModal, false);
    assert.deepEqual(s.view().contacts, noContacts());
    assert.equal(s.errands.commands.length, 1);
    s.controller.dispose();
  });
}

for (const [label, failure] of [
  ['network', new ClientError('network', 'Synthetic network interruption')],
  ['timeout', new ClientError('timeout', 'Synthetic timeout')],
  [
    'missing receipt',
    new ClientError('http', 'Synthetic missing receipt', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
  ],
  [
    'unavailable state',
    new ClientError('http', 'Synthetic unavailable state', {
      httpStatus: 503,
      serverCode: 'ERRAND_UNAVAILABLE',
    }),
  ],
  [
    'unavailable review',
    new ClientError('http', 'Synthetic unavailable review', {
      httpStatus: 503,
      serverCode: 'CONTENT_REVIEW_UNAVAILABLE',
    }),
  ],
  [
    'HTTP conflict without receipt',
    new ClientError('http', 'Synthetic conflict', {
      httpStatus: 409,
      serverCode: 'ERRAND_STATE_CONFLICT',
    }),
  ],
] as const) {
  test(`${label} does not settle or replace the frozen request`, async () => {
    const s = harness();
    const original = freeze(s);
    s.errands.receiptImpl = async () => {
      throw failure;
    };
    await s.controller.load({ orderId });
    await s.controller.recover();
    assert.equal(s.view().frozen, true);
    assert.deepEqual(s.pendingErrands.load(s.accountId), original);
    assert.equal(s.view().confirmedOrderId, '');
    assert.equal(s.errands.commands.length, 0);
    assert.equal(s.ids.count, 0);
    s.controller.dispose();
  });
}

test('a mismatched applied receipt cannot clear a pending attempt or project contacts', async () => {
  const s = harness();
  const original = freeze(s);
  s.errands.receiptImpl = async () => ({ ...applied(), operation: 'delete' });
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.pendingErrands.load(s.accountId), original);
  assertPrivateCleared(s);
  assert.equal(s.view().confirmedOrderId, '');
  s.controller.dispose();
});

test('losing a simultaneous claim clears entered contacts and never displays the winner private projection', async () => {
  const s = await prepare('accept');
  s.controller.setContact('wechat', 'Synthetic losing contact');
  const result = deferred<ErrandReceipt>();
  s.errands.commandImpl = async () => result.promise;
  const running = s.controller.accept();
  await flush();
  assertPrivateCleared(s);
  s.errands.detailImpl = async () =>
    detail({
      state: 'accepted',
      acceptedAt: occurredAt,
      revision: nextRevision,
      capabilities: noCapabilities(),
    });
  result.resolve(rejected(s.errands.commands[0]!));
  await running;
  assert.equal(s.view().detail?.relation, 'none');
  assert.equal(s.view().detail?.privateText, undefined);
  assert.equal(s.view().detail?.oppositeContact, undefined);
  assert.deepEqual(s.view().contacts, noContacts());
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().confirmedOrderId, '');
  assert.match(s.view().receiptStatus, /接走|结束/);
  s.controller.dispose();
});

for (const relation of ['publisher', 'accepter'] as const) {
  for (const state of ['completed', 'cancelled'] as const) {
    test(`${relation} refresh from accepted to ${state} clears opposite contacts and retains participant instructions`, async () => {
      const s = harness();
      s.errands.detailImpl = async () => participant(relation);
      await s.controller.load({ orderId });
      assert.deepEqual(s.view().detail?.oppositeContact?.contacts, contacts());
      const result = deferred<ErrandDetail>();
      s.errands.detailImpl = async () => result.promise;
      const running = s.controller.refresh();
      assertPrivateCleared(s);
      result.resolve(
        detail({
          state,
          acceptedAt: occurredAt,
          completedAt: state === 'completed' ? occurredAt : null,
          cancelledAt: state === 'cancelled' ? occurredAt : null,
          relation,
          revision: nextRevision,
          privateText,
          capabilities: {
            ...noCapabilities(),
            delete: relation === 'publisher',
          },
        }),
      );
      await running;
      assert.equal(s.view().detail?.privateText, privateText);
      assert.equal(s.view().detail?.oppositeContact, undefined);
      assert.deepEqual(s.view().contacts, noContacts());
      s.controller.dispose();
    });
  }
}

const interruptions = {
  'account change': (s: Harness) =>
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('b'),
      accountId: otherId,
    }),
  'same-account login epoch': (s: Harness) =>
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b')),
  logout: (s: Harness) => s.sessions.logout(),
  'app hide': (s: Harness) => s.runtime.privateViews!.clear(),
  Safety: (s: Harness) => s.safetyChanges.invalidate(s.accountId),
  'identity scope': (s: Harness) => s.directoryScopeChanges.clear(s.accountId),
  'browsing scope': (s: Harness) => s.browsingScopeChanges.clear(s.accountId),
  cancel: (s: Harness) => s.controller.cancel(),
};
for (const [label, interrupt] of Object.entries(interruptions)) {
  test(`${label} synchronously clears private state and invalidates late detail responses`, async () => {
    const s = harness();
    s.errands.detailImpl = async () => participant();
    await s.controller.load({ orderId });
    assert.equal(s.view().detail?.privateText, privateText);
    s.controller.confirm('complete');
    interrupt(s);
    assertPrivateCleared(s);
    s.controller.dispose();

    const late = harness();
    const result = deferred<ErrandDetail>();
    let cancelled = () => false;
    late.errands.detailImpl = async (_id, cancel) => {
      cancelled = () => cancel.isCancelled;
      return result.promise;
    };
    const running = late.controller.load({ orderId });
    await flush();
    interrupt(late);
    const count = late.views.length;
    assert.equal(cancelled(), true);
    assertPrivateCleared(late);
    result.resolve(participant());
    await running;
    assert.equal(late.views.length, count);
    assertPrivateCleared(late);
    late.controller.dispose();
  });

  test(`${label} invalidates late mutation receipts while preserving the original journal`, async () => {
    const s = await prepare('accept');
    const result = deferred<ErrandReceipt>();
    s.errands.commandImpl = async () => result.promise;
    const running = s.controller.accept();
    await flush();
    const original = s.pendingErrands.load(s.accountId)!;
    interrupt(s);
    assertPrivateCleared(s);
    const count = s.views.length;
    result.resolve(applied(original.intent));
    await running;
    assert.equal(s.views.length, count);
    assert.deepEqual(s.pendingErrands.load(s.accountId), original);
    assert.equal(s.view().confirmedOrderId, '');
    assert.equal(s.errands.commands.length, 1);
    s.controller.dispose();
  });

  test(`${label} before secure request ID completion prevents persistence and dispatch`, async () => {
    const s = await prepare('publish');
    const id = deferred<string>();
    s.ids.next = () => id.promise;
    const running = s.controller.publish();
    await flush();
    assert.equal(s.ids.count, 1);
    interrupt(s);
    id.resolve(requestId);
    await running;
    await flush();
    assert.equal(s.errands.commands.length, 0);
    assert.equal(s.pendingErrands.load(s.accountId), null);
    assertPrivateCleared(s);
    s.controller.dispose();
  });
}

test('unrelated account Safety and scope invalidations leave the current private projection intact', async () => {
  const s = harness();
  s.errands.detailImpl = async () => participant();
  await s.controller.load({ orderId });
  const current = s.view();
  s.safetyChanges.invalidate(otherId);
  s.directoryScopeChanges.clear(otherId);
  s.browsingScopeChanges.clear(otherId);
  assert.equal(s.view(), current);
  s.controller.dispose();
});

test('switching orders invalidates the old detail response even when returning to that order', async () => {
  const s = harness();
  const first = deferred<ErrandDetail>();
  s.errands.detailImpl = async () => first.promise;
  const running = s.controller.load({ orderId });
  await flush();
  s.errands.detailImpl = async (id) => detail({ id });
  await s.controller.load({ orderId: otherId });
  assert.equal(s.view().detail?.id, otherId);
  await s.controller.load({ orderId });
  first.resolve(participant());
  await running;
  assert.equal(s.view().detail?.id, orderId);
  assert.equal(s.view().detail?.relation, 'none');
  assert.equal(s.view().detail?.privateText, undefined);
  assert.equal(s.view().detail?.oppositeContact, undefined);
  s.controller.dispose();
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`dismissing contact modal before history ${outcome} prevents stale contacts, errors, and modal reopening`, async () => {
    const s = harness();
    await s.controller.load({ orderId });
    const result = deferred<ErrandContactHistory>();
    s.errands.contactHistoryImpl = async () => result.promise;
    const running = s.controller.openAccept();
    await flush();
    assert.equal(s.view().acceptModal, true);
    s.controller.closeAccept();
    const closed = s.view();
    if (outcome === 'resolve')
      result.resolve({ status: 'available', contacts: contacts() });
    else result.reject(new ClientError('network', 'Synthetic late failure'));
    await running;
    assert.equal(s.view(), closed);
    assert.deepEqual(s.view().contacts, noContacts());
    assert.equal(s.view().historyStatus, '');
    assert.equal(s.view().error, '');
    assert.equal(s.view().acceptModal, false);
    s.controller.dispose();
  });
}

test('reopening the contact modal cannot apply a dismissed history response to the new form', async () => {
  const s = harness();
  await s.controller.load({ orderId });
  const old = deferred<ErrandContactHistory>();
  s.errands.contactHistoryImpl = async () => old.promise;
  const running = s.controller.openAccept();
  await flush();
  s.controller.closeAccept();
  s.errands.contactHistoryImpl = async () => ({ status: 'empty' });
  await s.controller.openAccept();
  s.controller.setContact('phone', '456');
  old.resolve({ status: 'available', contacts: contacts() });
  await running;
  assert.equal(s.view().acceptModal, true);
  assert.deepEqual(s.view().contacts, { wechat: '', phone: '456' });
  assert.equal(s.view().useLast, false);
  s.controller.dispose();
});

test('own history needs neither identity nor profile and advances an empty page until explicit exhaustion', async () => {
  const s = harness('mine', true);
  const cursor = 'a'.repeat(43);
  s.errands.mineImpl = async (relation, next) =>
    next === null
      ? page({
          context: { kind: 'own', relation },
          items: [],
          continuation: 'more',
          nextCursor: cursor,
        })
      : page({
          context: { kind: 'own', relation },
          items: [
            summary({
              state: 'cancelled',
              acceptedAt: occurredAt,
              cancelledAt: occurredAt,
            }),
          ],
        });
  await s.controller.load({ relation: 'accepted' });
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().canMore, true);
  assert.deepEqual(s.view().items, []);
  assert.deepEqual(s.profiles.calls, []);
  assert.deepEqual(s.gateway.calls, []);
  await s.controller.more();
  assert.equal(s.view().items.length, 1);
  assert.equal(s.view().canMore, false);
  assert.match(s.view().status, /末尾/);
  const calls = s.errands.calls.length;
  await s.controller.more();
  assert.equal(s.errands.calls.length, calls);
  assert.deepEqual(
    s.errands.calls.map((call) => call.args.slice(0, 2)),
    [
      ['accepted', null],
      ['accepted', cursor],
    ],
  );
  s.controller.dispose();
});

test('switching own-history relation invalidates stale pages and resets the cursor', async () => {
  const s = harness('mine', true);
  const old = deferred<ErrandPage>();
  s.errands.mineImpl = async () => old.promise;
  const running = s.controller.load({ relation: 'published' });
  await flush();
  s.errands.mineImpl = async (relation) =>
    page({
      context: { kind: 'own', relation },
      items: [summary({ id: otherId })],
    });
  await s.controller.choose('relation', 'accepted');
  old.resolve(page({ nextCursor: 'b'.repeat(43), continuation: 'more' }));
  await running;
  assert.equal(s.view().relation, 'accepted');
  assert.deepEqual(
    s.view().items.map((item) => item.id),
    [otherId],
  );
  assert.equal(s.view().canMore, false);
  assert.deepEqual(
    s.errands.calls.map((call) => call.args.slice(0, 2)),
    [
      ['published', null],
      ['accepted', null],
    ],
  );
  s.controller.dispose();
});

for (const operation of ['cancel', 'complete', 'delete'] as const) {
  test(`${operation} cleanup is publisher-only and never generates an accepter command`, async () => {
    const s = harness('detail', true);
    s.errands.detailImpl = async () => participant('accepter');
    await s.controller.load({ orderId });
    s.controller.confirm(operation);
    assert.equal(s.view().confirmAction, null);
    await s.controller.confirmCommand();
    await s.controller.accept();
    assert.equal(s.errands.commands.length, 0);
    assert.equal(s.ids.count, 0);
    s.errands.detailImpl = async () => participant('publisher');
    await s.controller.refresh();
    s.controller.confirm(operation);
    assert.equal(s.view().confirmAction, operation);
    await s.controller.confirmCommand();
    assert.deepEqual(s.errands.commands, [intent(operation)]);
    assert.equal(s.pendingErrands.load(s.accountId), null);
    assert.deepEqual(s.profiles.calls, []);
    assert.deepEqual(s.gateway.calls, []);
    s.controller.dispose();
  });
}

for (const [label, interrupt] of Object.entries(interruptions)) {
  test(`${label} invalidates contact history without repopulating the dismissed modal`, async () => {
    const s = harness();
    await s.controller.load({ orderId });
    const result = deferred<ErrandContactHistory>();
    s.errands.contactHistoryImpl = async () => result.promise;
    const running = s.controller.openAccept();
    await flush();
    interrupt(s);
    assertPrivateCleared(s);
    const count = s.views.length;
    result.resolve({ status: 'available', contacts: contacts() });
    await running;
    assert.equal(s.views.length, count);
    assertPrivateCleared(s);
    s.controller.dispose();
  });

  test(`${label} invalidates startup receipt recovery before any profile or parent read`, async () => {
    const s = harness('list');
    const original = freeze(s, 'publish');
    const result = deferred<ErrandReceipt>();
    s.errands.receiptImpl = async () => result.promise;
    const running = s.controller.load();
    await flush();
    interrupt(s);
    assertPrivateCleared(s);
    const count = s.views.length;
    result.resolve(applied(original.intent));
    await running;
    assert.equal(s.views.length, count);
    assert.deepEqual(s.pendingErrands.load(s.accountId), original);
    assert.deepEqual(s.profiles.calls, []);
    assert.deepEqual(
      s.errands.calls.map((call) => call.method),
      ['receipt'],
    );
    assert.equal(s.view().confirmedOrderId, '');
    s.controller.dispose();
  });
}

test('switching orders during a claim invalidates the old commit and recovers its journal before the new detail read', async () => {
  const s = await prepare('accept');
  const command = deferred<ErrandReceipt>();
  s.errands.commandImpl = async () => command.promise;
  const running = s.controller.accept();
  await flush();
  const original = s.pendingErrands.load(s.accountId)!;
  const recovered = deferred<ErrandReceipt>();
  s.errands.receiptImpl = async () => recovered.promise;
  const switched = s.controller.load({ orderId: otherId });
  await flush();
  assertPrivateCleared(s);
  const count = s.views.length;
  command.resolve(applied(original.intent));
  await running;
  assert.equal(s.views.length, count);
  assert.deepEqual(s.pendingErrands.load(s.accountId), original);
  assert.equal(s.view().confirmedOrderId, '');
  recovered.resolve(applied(original.intent));
  await switched;
  assert.equal(s.pendingErrands.load(s.accountId), null);
  assert.equal(s.view().detail?.id, otherId);
  assert.equal(s.view().detail?.privateText, undefined);
  assert.equal(s.view().detail?.oppositeContact, undefined);
  assert.deepEqual(
    s.errands.calls.map((call) => call.method),
    ['detail', 'contactHistory', 'command', 'receipt', 'detail'],
  );
  s.controller.dispose();
});

test('unchecking previous contacts clears the form, and a subsequent successful claim uses only the new contacts', async () => {
  const s = await prepare('accept');
  assert.equal(s.view().useLast, true);
  assert.deepEqual(s.view().contacts, contacts());
  await s.controller.toggleLast();
  assert.equal(s.view().useLast, false);
  assert.deepEqual(s.view().contacts, noContacts());
  await s.controller.accept();
  assert.equal(s.errands.commands.length, 0);
  assert.equal(s.ids.count, 0);
  s.controller.setContact('phone', '456');
  await s.controller.accept();
  assert.deepEqual(s.errands.commands, [
    {
      operation: 'accept',
      orderId,
      payload: {
        clientRequestId: requestId,
        expectedRevision: revision,
        contacts: { wechat: '', phone: '456' },
      },
    },
  ]);
  assert.deepEqual(s.view().contacts, noContacts());
  s.controller.dispose();
});

test('confirmation dismissal leaves no command behind and a fresh confirmation captures the latest revision', async () => {
  const s = await prepare('complete');
  assert.equal(s.view().confirmAction, 'complete');
  s.controller.dismissConfirmation();
  await s.controller.confirmCommand();
  assert.equal(s.errands.commands.length, 0);
  assert.equal(s.ids.count, 0);
  s.errands.detailImpl = async () =>
    participant('publisher', { revision: nextRevision });
  await s.controller.refresh();
  s.controller.confirm('complete');
  await s.controller.confirmCommand();
  assert.deepEqual(s.errands.commands, [
    {
      operation: 'complete',
      orderId,
      payload: { clientRequestId: requestId, expectedRevision: nextRevision },
    },
  ]);
  s.controller.dispose();
});

for (const outcome of ['relation removed', 'not found'] as const) {
  test(`fresh ${outcome} detail clears all previous participant-only projection`, async () => {
    const s = harness();
    s.errands.detailImpl = async () => participant('accepter');
    await s.controller.load({ orderId });
    assert.equal(s.view().detail?.privateText, privateText);
    assert.deepEqual(s.view().detail?.oppositeContact?.contacts, contacts());
    s.errands.detailImpl = async () => {
      if (outcome === 'not found')
        throw new ClientError('http', 'Synthetic absent order', {
          httpStatus: 404,
          serverCode: 'ERRAND_NOT_FOUND',
        });
      return detail({
        state: 'accepted',
        acceptedAt: occurredAt,
        capabilities: noCapabilities(),
      });
    };
    await s.controller.refresh();
    assert.equal(s.view().detail?.privateText, undefined);
    assert.equal(s.view().detail?.oppositeContact, undefined);
    assert.deepEqual(s.view().contacts, noContacts());
    if (outcome === 'not found') {
      assert.equal(s.view().detail, null);
      assert.equal(s.view().loaded, false);
    } else assert.equal(s.view().detail?.relation, 'none');
    s.controller.dispose();
  });
}
