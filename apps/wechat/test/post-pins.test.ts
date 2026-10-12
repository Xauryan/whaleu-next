import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  decodePin,
  decodePinCommand,
  decodePinReceipt,
  decodePinPage,
  decodePinSlot,
  matchPinReceipt,
} from '../src/post-pins/contract';
import type {
  Pin,
  PinCommand,
  PinDetail,
  PinReceipt,
} from '../src/post-pins/contract';
import { PendingPostPinStore } from '../src/post-pins/pending';
import {
  PinFeedController,
  PinDetailController,
} from '../src/post-pins/controller';
import type { PinFeedView, PinDetailView } from '../src/post-pins/controller';
import type { PostPinsGateway } from '../src/post-pins/gateway';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  post,
  postId,
  spaceId,
  requestId,
  otherId,
  setup,
} from './community-helpers';
import { MemoryStorage, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
const pin = (): Pin => ({
  pinId: otherId,
  postId,
  level: 2,
  pinnedAt: new Date(Date.now() - 1000).toISOString(),
  pinnedUntil: new Date(Date.now() + 3600000).toISOString(),
  readState: 'unread',
  readAt: null,
});
const command = (): PinCommand => ({
  clientRequestId: requestId,
  operation: 'pin',
  postId,
  durationHours: 24,
  level: 2,
});
const receipt = (c = command()): PinReceipt => ({
  requestId: c.clientRequestId,
  operation: c.operation,
  postId: c.postId,
  outcome: 'applied',
  pinId: otherId,
  recordedAt: new Date().toISOString(),
});
test('privacy-strict pin codecs reject scope forgery, malformed histories and cross-pin read receipts', () => {
  assert.deepEqual(decodePinCommand(command()), command());
  for (const patch of [
    { durationHours: 0 },
    { durationHours: 169 },
    { durationHours: 1.1 },
    { level: 3 },
    { scopeId: spaceId },
  ])
    assert.throws(() => decodePinCommand({ ...command(), ...patch }));
  assert.throws(() => decodePin({ ...pin(), readState: 'read' }));
  assert.throws(() => decodePin({ ...pin(), accountId: otherId }));
  assert.throws(() =>
    decodePinPage({
      spaceId,
      status: 'unavailable',
      items: [{ pin: pin(), post: post() }],
    }),
  );
  assert.throws(() =>
    matchPinReceipt(
      { clientRequestId: requestId, postId, operation: 'read', pinId: spaceId },
      receipt({
        clientRequestId: requestId,
        postId,
        operation: 'read',
        pinId: spaceId,
      }),
    ),
  );
  assert.throws(() => decodePinReceipt({ ...receipt(), scopeId: spaceId }));
  for (const extra of [
    { text: 'hidden' },
    { author: { id: otherId } },
    { readState: 'unread' },
  ])
    assert.throws(() =>
      decodePinSlot({
        spaceId,
        status: 'available',
        canUnpin: true,
        pin: {
          pinId: otherId,
          postId,
          level: 2,
          pinnedUntil: pin().pinnedUntil,
          ...extra,
        },
      }),
    );
  assert.throws(() =>
    decodePinSlot({
      spaceId,
      status: 'unavailable',
      canUnpin: true,
      pin: null,
    }),
  );
});
test('one durable original pin command per account/origin; cancellation and malformed storage never clear by inference', () => {
  const storage = new MemoryStorage(),
    store = new PendingPostPinStore(storage, 'origin');
  const account = wireCredentials().accountId;
  const value = store.freeze({
    version: 1,
    origin: 'origin',
    accountId: account,
    phase: 'submit',
    command: command(),
  });
  assert.throws(() =>
    store.freeze({
      ...value,
      command: { ...command(), clientRequestId: otherId },
    }),
  );
  const cancelling = store.cancel(value);
  assert.equal(cancelling.phase, 'cancel');
  assert.throws(() => store.settle(value, receipt()));
  assert.equal(store.load(account)?.phase, 'cancel');
  storage.failRemove = true;
  assert.throws(() => store.settle(cancelling, receipt()));
  assert.ok(store.load(account));
  storage.failRemove = false;
  store.settle(cancelling, receipt());
  assert.equal(store.load(account), null);
  store.dismiss(account, otherId);
  assert.equal(store.dismissed(account, otherId), true);
  assert.equal(store.dismissed(null, otherId), false);
  assert.equal(
    new PendingPostPinStore(storage, 'other-origin').dismissed(
      account,
      otherId,
    ),
    false,
  );
  storage.data.set(`whaleu.post-pins.pending.v1:origin:${account}`, {
    garbage: true,
  });
  assert.throws(() => store.load(account));
});
function harness() {
  const s = setup(),
    commands: PinCommand[] = [];
  let detail: PinDetail = {
    postId,
    status: 'available',
    pin: null,
    canPin: true,
    canUnpin: false,
  };
  const gateway: PostPinsGateway = {
    slot: async () => ({
      spaceId,
      status: 'available',
      pin: null,
      canUnpin: false,
    }),
    list: async () => ({
      spaceId,
      status: 'available',
      items: [{ pin: pin(), post: post() }],
    }),
    detail: async () => detail,
    submit: async (c, _cancel, cancelling) => {
      commands.push(c);
      if (cancelling)
        return {
          requestId: c.clientRequestId,
          operation: c.operation,
          postId: c.postId,
          outcome: 'rejected',
          code: 'POST_PIN_CANCELLED',
        };
      detail = {
        ...detail,
        pin: { ...pin(), readState: 'read', readAt: new Date().toISOString() },
        canUnpin: true,
      };
      return receipt(c);
    },
    receipt: async () => {
      throw new ClientError('http', 'Missing', {
        httpStatus: 404,
        serverCode: 'REQUEST_NOT_FOUND',
      });
    },
  };
  const store = new PendingPostPinStore(s.storage, 'origin');
  const runtime: CommunityRuntime = {
    ...s.runtime,
    postPins: gateway,
    pendingPostPins: store,
  };
  return { ...s, runtime, gateway, store, commands };
}
test('native first-page pin collapse and device-local dismissal never issue read commands; stale callbacks clear on account/root hide', async (t) => {
  const s = harness();
  let view!: PinFeedView;
  const controller = new PinFeedController(s.runtime, (v) => {
    view = v;
  });
  t.after(() => controller.dispose());
  await controller.load({ spaceId });
  assert.ok(view.item);
  assert.equal(view.collapsed, false);
  controller.dismiss();
  assert.equal(view.confirmDismiss, true);
  controller.confirmDismiss();
  assert.equal(view.item, null);
  assert.equal(s.commands.length, 0);
  await controller.load({ spaceId });
  assert.equal(view.item, null);
  const late = deferred<Awaited<ReturnType<PostPinsGateway['list']>>>();
  s.gateway.list = () => late.promise;
  const work = controller.load({ spaceId });
  await flush();
  s.sessions.logout();
  late.resolve({
    spaceId,
    status: 'available',
    items: [{ pin: pin(), post: post() }],
  });
  await work;
  assert.equal(view.item, null);
});
test('detail freezes before dispatch, prevents repeated submit, recovers original identity, blocks forged receipt and survives restart', async (t) => {
  const s = harness();
  let view!: PinDetailView;
  let controller = new PinDetailController(s.runtime, (v) => {
    view = v;
  });
  t.after(() => controller.dispose());
  await controller.load(postId, false);
  controller.confirm('pin');
  const sent = deferred<PinReceipt>();
  s.gateway.submit = async (c) => {
    s.commands.push(c);
    return sent.promise;
  };
  const work = controller.submit();
  await flush();
  await controller.submit();
  assert.equal(s.commands.length, 1);
  assert.ok(s.store.load(s.accountId));
  sent.reject(new ClientError('network', 'Lost'));
  await work;
  assert.equal(view.frozen, true);
  controller.dispose();
  controller = new PinDetailController(s.runtime, (v) => {
    view = v;
  });
  await controller.load(postId, false);
  assert.equal(view.frozen, true);
  s.gateway.receipt = async () => ({ ...receipt(), postId: otherId });
  await controller.recover();
  assert.equal(view.frozen, true);
  assert.ok(s.store.load(s.accountId));
  s.gateway.receipt = async () => receipt();
  await controller.recover();
  assert.equal(view.frozen, false);
  assert.equal(s.commands.length, 1);
});
test('detail automatic exact-pin read does not bypass malformed persistence; root lifecycle invalidates pin controls', async (t) => {
  const s = harness();
  s.gateway.detail = async () => ({
    postId,
    status: 'available',
    pin: pin(),
    canPin: false,
    canUnpin: false,
  });
  let view!: PinDetailView;
  const controller = new PinDetailController(s.runtime, (v) => {
    view = v;
  });
  t.after(() => controller.dispose());
  s.storage.failWrite = true;
  await controller.load(postId);
  assert.equal(s.commands.length, 0);
  assert.match(view.error, /本地/);
  s.runtime.privateViews?.clear();
  assert.equal(view.detail, null);
});

test('Safety invalidation and content 404 preserve independent original-key receipt recovery', async (t) => {
  const s = harness();
  s.store.freeze({
    version: 1,
    origin: 'origin',
    accountId: s.accountId,
    phase: 'submit',
    command: command(),
  });
  let view!: PinDetailView;
  const controller = new PinDetailController(s.runtime, (v) => {
    view = v;
  });
  t.after(() => controller.dispose());
  controller.loadRecovery();
  s.runtime.safetyChanges?.invalidate(s.accountId);
  assert.equal(view.frozen, true);
  const reply = deferred<PinReceipt>();
  s.gateway.receipt = () => reply.promise;
  const recovery = controller.recover();
  await flush();
  controller.clear();
  assert.equal(view.busy, true);
  assert.equal(view.detail, null);
  reply.resolve(receipt());
  await recovery;
  assert.equal(view.frozen, false);
  assert.match(view.receiptStatus, /确认/);
  s.runtime.safetyChanges?.invalidate(s.accountId);
  assert.match(view.receiptStatus, /确认/);
  assert.equal(s.store.load(s.accountId), null);
});

test('authority-only slot closes an exact hidden pin using the same journal and never reads content', async (t) => {
  const s = harness();
  let reads = 0;
  const summary = {
    pinId: otherId,
    postId,
    level: 2 as const,
    pinnedUntil: new Date(Date.now() + 3600000).toISOString(),
  };
  s.gateway.slot = async () => ({
    spaceId,
    status: 'available',
    canUnpin: true,
    pin: summary,
  });
  s.gateway.detail = async () => {
    reads++;
    throw new Error('No hidden content detail');
  };
  s.gateway.submit = async (c) => {
    s.commands.push(c);
    s.gateway.slot = async () => ({
      spaceId,
      status: 'available',
      canUnpin: false,
      pin: null,
    });
    return receipt(c);
  };
  let view!: PinDetailView;
  const controller = new PinDetailController(s.runtime, (v) => {
    view = v;
  });
  t.after(() => controller.dispose());
  await controller.loadSlot(spaceId);
  assert.equal(view.detail, null);
  assert.equal(view.slot?.pin?.pinId, otherId);
  controller.confirm('pin');
  assert.equal(view.confirming, null);
  controller.confirm('unpin');
  await controller.submit();
  assert.equal(s.commands.length, 1);
  assert.deepEqual(s.commands[0], {
    clientRequestId: requestId,
    operation: 'unpin',
    postId,
    pinId: otherId,
  });
  assert.equal(view.slot?.pin, null);
  assert.equal(reads, 0);
  assert.equal(s.store.load(s.accountId), null);
});

test('slot management is authority-only and drops private identities on account replacement and late responses', async (t) => {
  const s = harness();
  let view!: PinDetailView;
  const controller = new PinDetailController(s.runtime, (v) => {
    view = v;
  });
  t.after(() => controller.dispose());
  s.gateway.slot = async () => {
    throw new ClientError('http', 'Denied', {
      httpStatus: 403,
      serverCode: 'AUTHORIZATION_REQUIRED',
    });
  };
  await controller.loadSlot(spaceId);
  assert.equal(view.slot, null);
  assert.equal(view.error, '');
  const late = deferred<Awaited<ReturnType<PostPinsGateway['slot']>>>();
  s.gateway.slot = () => late.promise;
  const work = controller.loadSlot(spaceId);
  await flush();
  s.sessions.logout();
  late.resolve({
    spaceId,
    status: 'available',
    canUnpin: true,
    pin: { pinId: otherId, postId, level: 2, pinnedUntil: pin().pinnedUntil },
  });
  await work;
  assert.equal(view.slot, null);
  controller.confirm('unpin');
  await controller.submit();
  assert.equal(s.commands.length, 0);
});
