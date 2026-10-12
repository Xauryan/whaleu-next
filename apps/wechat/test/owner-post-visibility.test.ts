import path from 'node:path';
import { PinDetailController } from '../src/post-pins/controller';
import { DetailController } from '../src/pages/community-detail/controller';
import { PendingPostPinStore } from '../src/post-pins/pending';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { decodeOwnPublications } from '../src/community/contract';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeOwnerVisibilityCommand,
  decodeOwnerVisibilityManagement,
  decodeOwnerVisibilityReceipt,
  matchOwnerVisibilityReceipt,
} from '../src/owner-post-visibility/contract';
import type {
  OwnerVisibilityCommand,
  OwnerVisibilityManagement,
  OwnerVisibilityReceipt,
} from '../src/owner-post-visibility/contract';
import { OwnerPostVisibilityController } from '../src/owner-post-visibility/controller';
import type { OwnerVisibilityView } from '../src/owner-post-visibility/controller';
import { HttpOwnerPostVisibilityGateway } from '../src/owner-post-visibility/gateway';
import type { OwnerPostVisibilityGateway } from '../src/owner-post-visibility/gateway';
import { PendingOwnerPostVisibilityStore } from '../src/owner-post-visibility/pending';
import { MemoryStorage, ScriptedTransport, deferred, flush } from './helpers';
import {
  createdAt,
  otherId,
  postId,
  requestId,
  setup,
  spaceId,
} from './community-helpers';
import { wireCredentials } from './identity-helpers';
const command = (): OwnerVisibilityCommand => ({
  clientRequestId: requestId,
  postId,
  ownerHidden: true,
  expectedVersion: 0,
});
const receipt = (c = command()): OwnerVisibilityReceipt => ({
  requestId: c.clientRequestId,
  postId: c.postId,
  ownerHidden: c.ownerHidden,
  expectedVersion: c.expectedVersion,
  outcome: 'applied',
  version: c.expectedVersion + 1,
  changed: true,
  recordedAt: createdAt,
});
const absent = () =>
  new ClientError('http', 'Missing', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  });
const manage = (): OwnerVisibilityManagement => ({
  postId,
  ownerHidden: false,
  version: 0,
  canChange: true,
});
function harness(storage = new MemoryStorage()) {
  const s = setup(),
    commands: { command: OwnerVisibilityCommand; cancelling: boolean }[] = [];
  let management = manage(),
    settled = 0;
  const gateway: OwnerPostVisibilityGateway = {
    management: async () => management,
    submit: async (c, _cancel, cancelling = false) => {
      commands.push({ command: c, cancelling });
      if (cancelling)
        return {
          requestId: c.clientRequestId,
          postId: c.postId,
          ownerHidden: c.ownerHidden,
          expectedVersion: c.expectedVersion,
          outcome: 'rejected',
          code: 'POST_OWNER_VISIBILITY_CANCELLED',
        };
      management = {
        ...management,
        ownerHidden: c.ownerHidden,
        version: c.expectedVersion + 1,
      };
      return receipt(c);
    },
    receipt: async () => {
      throw absent();
    },
  };
  const store = new PendingOwnerPostVisibilityStore(
    storage,
    'synthetic-origin',
  );
  const runtime: CommunityRuntime = {
    ...s.runtime,
    pendingOwnerPostVisibility: store,
    ownerPostVisibility: gateway,
  };
  let view!: OwnerVisibilityView;
  const make = () =>
    new OwnerPostVisibilityController(
      runtime,
      (v) => {
        view = v;
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
  };
}

test('strict visibility DTOs allow only minimal owner state and exact CAS/desired identity', () => {
  assert.deepEqual(decodeOwnerVisibilityManagement(manage()), manage());
  assert.deepEqual(decodeOwnerVisibilityCommand(command()), command());
  assert.deepEqual(decodeOwnerVisibilityReceipt(receipt()), receipt());
  for (const patch of [
    { expectedVersion: -1 },
    { expectedVersion: 2147483647 },
    { expectedVersion: 0.5 },
    { ownerHidden: 1 },
    { actorId: otherId },
    { postId: 'invalid' },
  ])
    assert.throws(() =>
      decodeOwnerVisibilityCommand({ ...command(), ...patch }),
    );
  for (const patch of [
    { text: 'private' },
    { authorId: otherId },
    { images: [] },
    { canChange: 'true' },
  ])
    assert.throws(() =>
      decodeOwnerVisibilityManagement({ ...manage(), ...patch }),
    );
  for (const patch of [
    { version: 0 },
    { version: 2 },
    { changed: 'false' },
    { recordedAt: 'invalid' },
    { author: {} },
  ])
    assert.throws(() =>
      decodeOwnerVisibilityReceipt({ ...receipt(), ...patch }),
    );
  for (const patch of [
    { postId: otherId },
    { ownerHidden: false },
    { expectedVersion: 1 },
    { clientRequestId: otherId },
  ])
    assert.throws(() =>
      matchOwnerVisibilityReceipt({ ...command(), ...patch }, receipt()),
    );
  const item = {
    id: postId,
    spaceId,
    category: 'discussion',
    status: 'hidden',
    publishedAt: createdAt,
    ownerVisibility: { ownerHidden: true, version: 3, canChange: true },
  };
  assert.deepEqual(
    decodeOwnPublications({ items: [item], nextCursor: null }).items[0],
    item,
  );
  assert.throws(() =>
    decodeOwnPublications({
      items: [
        {
          ...item,
          ownerVisibility: { ...item.ownerVisibility, authorId: otherId },
        },
      ],
      nextCursor: null,
    }),
  );
});

test('journal never replaces original key and scopes exact actor/origin/phase including cancel race', () => {
  const s = harness();
  const original = s.store.freeze({
    version: 1,
    accountId: s.accountId,
    origin: s.store.origin,
    phase: 'submit',
    command: command(),
  });
  assert.throws(() =>
    s.store.freeze({
      ...original,
      command: { ...command(), clientRequestId: otherId },
    }),
  );
  assert.equal(
    new PendingOwnerPostVisibilityStore(s.storage, 'other-origin').load(
      s.accountId,
    ),
    null,
  );
  assert.equal(s.store.load(otherId), null);
  const cancelled = s.store.cancel(original);
  assert.equal(cancelled.phase, 'cancel');
  assert.throws(() => s.store.settle(original, receipt()));
  s.storage.failRemove = true;
  assert.throws(() => s.store.settle(cancelled, receipt()));
  assert.deepEqual(s.store.load(s.accountId), cancelled);
  s.storage.failRemove = false;
  // A cancel which lost to the original write returns and settles its applied receipt.
  s.store.settle(cancelled, receipt());
  assert.equal(s.store.load(s.accountId), null);
  s.storage.data.set(
    `whaleu.owner-post-visibility.pending.v1:${s.store.origin}:${s.accountId}`,
    { ...original, origin: 'other-origin' },
  );
  assert.throws(() => s.store.load(s.accountId));
});

test('native desired state confirmation uses fresh CAS, hides/unhides without toggles and prevents double taps', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  await controller.request(postId, true);
  assert.equal(s.view().confirming, 'change');
  const late = deferred<OwnerVisibilityReceipt>();
  s.gateway.submit = async (c, _cancel, cancelling = false) => {
    s.commands.push({ command: c, cancelling });
    return late.promise;
  };
  const work = controller.submit();
  await controller.submit();
  await flush();
  assert.equal(s.commands.length, 1);
  assert.deepEqual(s.store.load(s.accountId)?.command, command());
  assert.equal(s.view().frozen, true);
  late.resolve(receipt());
  await work;
  assert.equal(s.view().frozen, false);
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.settled(), 1);
  s.gateway.management = async () => ({
    ...manage(),
    ownerHidden: true,
    version: 1,
  });
  await controller.request(postId, false);
  assert.equal(s.view().desired, false);
  s.gateway.submit = async (c) => {
    assert.equal(c.expectedVersion, 1);
    assert.equal(c.ownerHidden, false);
    return receipt(c);
  };
  await controller.submit();
  assert.match(s.view().receiptStatus, /取消个人隐藏/);
});

test('response loss cold restart recovers original receipt while private content and management are unavailable', async (t) => {
  const s = harness();
  let controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.submit = async (c) => {
    s.commands.push({ command: c, cancelling: false });
    throw new ClientError('timeout', 'response lost');
  };
  await controller.request(postId, true);
  await controller.submit();
  assert.equal(s.view().frozen, true);
  controller.dispose();
  controller = s.make();
  s.gateway.management = async () => {
    throw new ClientError('http', 'Gone', {
      httpStatus: 404,
      serverCode: 'POST_NOT_FOUND',
    });
  };
  await controller.load(postId);
  assert.equal(s.view().management, null);
  assert.equal(s.view().pendingPostId, postId);
  s.gateway.receipt = async (id) => {
    assert.equal(id, requestId);
    return receipt();
  };
  await controller.recover();
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.commands.length, 1);
  assert.equal(s.view().frozen, false);
});

test('unknown receipt remains frozen; explicit retry reuses exact original and durable cancel prevents resubmit', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.store.freeze({
    version: 1,
    accountId: s.accountId,
    origin: s.store.origin,
    phase: 'submit',
    command: command(),
  });
  await controller.load();
  await controller.recover();
  assert.equal(s.view().frozen, true);
  assert.equal(s.commands.length, 0);
  await controller.request(otherId, false);
  assert.equal(s.commands.length, 0);
  s.gateway.submit = async (c, _cancel, cancelling = false) => {
    s.commands.push({ command: c, cancelling });
    throw new ClientError('timeout', 'lost');
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
  assert.equal(s.view().frozen, true);
});

test('forged terminal receipt cannot clear original journal', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.submit = async () => ({ ...receipt(), postId: otherId });
  await controller.request(postId, true);
  await controller.submit();
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.store.load(s.accountId)?.command, command());
  assert.equal(s.settled(), 0);
});

test('failed durable write and silent write/readback failure prevent dispatch', async (t) => {
  for (const mode of ['throw', 'silent', 'readback'] as const) {
    const storage = new MemoryStorage(),
      s = harness(storage),
      controller = s.make();
    t.after(() => controller.dispose());
    await controller.request(postId, true);
    if (mode === 'throw') storage.failWrite = true;
    if (mode === 'silent') storage.set = () => undefined;
    if (mode === 'readback') {
      const set = storage.set.bind(storage);
      let written = false;
      storage.set = (k, v) => {
        set(k, v);
        written = true;
      };
      const get = storage.get.bind(storage);
      storage.get = (k) => {
        if (written) throw new Error('readback unavailable');
        return get(k);
      };
    }
    await controller.submit();
    assert.equal(s.commands.length, 0, mode);
    assert.match(s.view().error, /本地保存失败/, mode);
  }
});

test('failed cancellation persistence sends neither cancel nor fresh replacement command', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.store.freeze({
    version: 1,
    accountId: s.accountId,
    origin: s.store.origin,
    phase: 'submit',
    command: command(),
  });
  await controller.load();
  controller.requestCancellation();
  s.storage.failWrite = true;
  await controller.confirmCancellation();
  assert.equal(s.commands.length, 0);
  assert.equal(s.store.load(s.accountId)?.phase, 'submit');
  assert.equal(s.view().frozen, true);
});

test('account switch, same-account relogin and dispose drop late callbacks without clearing original journal', async (t) => {
  for (const mode of ['account', 'relogin', 'dispose'] as const) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    const late = deferred<OwnerVisibilityReceipt>();
    s.gateway.submit = () => late.promise;
    await controller.request(postId, true);
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

test('account or origin change while allocating ID cannot persist or send into new environment', async (t) => {
  for (const mode of ['account', 'origin'] as const) {
    const s = harness(),
      random = deferred<string>();
    const runtime: CommunityRuntime = {
      ...s.runtime,
      newRequestId: () => random.promise,
    };
    let view!: OwnerVisibilityView;
    const controller = new OwnerPostVisibilityController(runtime, (v) => {
      view = v;
    });
    t.after(() => controller.dispose());
    await controller.request(postId, true);
    const work = controller.submit();
    await flush();
    if (mode === 'account') s.sessions.logout();
    else
      Object.assign(runtime, {
        pendingOwnerPostVisibility: new PendingOwnerPostVisibilityStore(
          s.storage,
          'new-origin',
        ),
      });
    random.resolve(requestId);
    await work;
    assert.equal(s.commands.length, 0, mode);
    assert.equal(s.store.load(s.accountId), null, mode);
    assert.equal(view.receiptStatus, '', mode);
  }
});

test('origin replacement during response cannot settle journal or update new view', async (t) => {
  const s = harness(),
    controller = s.make(),
    late = deferred<OwnerVisibilityReceipt>();
  t.after(() => controller.dispose());
  s.gateway.submit = () => late.promise;
  await controller.request(postId, true);
  const work = controller.submit();
  await flush();
  Object.assign(s.runtime, {
    pendingOwnerPostVisibility: new PendingOwnerPostVisibilityStore(
      s.storage,
      'other-origin',
    ),
  });
  late.resolve(receipt());
  await work;
  assert.ok(s.store.load(s.accountId));
  assert.equal(s.view().frozen, true);
  assert.equal(s.settled(), 0);
});

test('settled owner visibility invalidates private/media views before refreshed management', async (t) => {
  const s = harness(),
    safety = new SafetyChanges(s.runtime.privateViews),
    calls: string[] = [];
  const runtime = { ...s.runtime, safetyChanges: safety };
  runtime.privateViews!.subscribe((account) => {
    if (account) calls.push('private');
  });
  safety.subscribe(() => {
    calls.push('read');
  });
  const controller = new OwnerPostVisibilityController(
    runtime,
    () => undefined,
  );
  t.after(() => controller.dispose());
  await controller.request(postId, true);
  await controller.submit();
  await flush();
  assert.deepEqual(calls, ['private', 'read']);
  assert.equal(s.store.load(s.accountId), null);
});

test('HTTP owner commands pin exact routes/body, reject crossed responses and never silently auth-replay', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const api = new ApiClient('https://api.example', transport, s.sessions, {
    refresh: async () => {
      refreshes++;
      return s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
    },
  });
  const gateway = new HttpOwnerPostVisibilityGateway(api),
    cancel = new Cancellation();
  transport.reply(manage());
  await gateway.management(postId, cancel);
  assert.match(
    transport.requests[0]!.url,
    new RegExp(`/v1/me/community/posts/${postId}/owner-visibility$`),
  );
  transport.reply(receipt());
  await gateway.submit(command(), cancel);
  assert.deepEqual(transport.requests[1]!.body, command());
  assert.match(transport.requests[1]!.url, /owner-visibility-commands$/);
  transport.reply(receipt());
  await gateway.submit(command(), cancel, true);
  assert.deepEqual(transport.requests[2]!.body, command());
  assert.match(
    transport.requests[2]!.url,
    new RegExp(`/owner-visibility-requests/${requestId}/cancel$`),
  );
  transport.reply(receipt());
  await gateway.receipt(requestId, cancel);
  assert.equal(transport.requests[3]!.method, 'GET');
  transport.reply({ ...manage(), postId: otherId });
  await assert.rejects(gateway.management(postId, cancel));
  transport.reply({ ...receipt(), ownerHidden: false });
  await assert.rejects(gateway.submit(command(), cancel));
  transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(gateway.submit(command(), cancel));
  assert.equal(refreshes, 0);
  assert.equal(transport.requests.length, 7);
});

test('both registered native pages expose owner controls/recovery outside content readability', () => {
  for (const page of ['community-mine', 'community-detail']) {
    const ts = readFileSync(
      path.resolve(__dirname, `../src/pages/${page}/${page}.ts`),
      'utf8',
    );
    const wxml = readFileSync(
      path.resolve(__dirname, `../src/pages/${page}/${page}.wxml`),
      'utf8',
    );
    assert.match(wxml, /<template is="owner-post-visibility"/);
    for (const handler of [
      'Hide',
      'Unhide',
      'Submit',
      'Recover',
      'Retry',
      'Cancel',
      'ConfirmCancel',
      'Close',
    ])
      assert.match(ts, new RegExp(`onOwnerVisibility${handler}\\(`));
    assert.match(ts, /ownerVisibilityController\?\.dispose/);
  }
  const template = readFileSync(
    path.resolve(__dirname, '../src/owner-post-visibility/management.wxml'),
    'utf8',
  );
  assert.match(template, /visibility\.frozen/);
  assert.doesNotMatch(template, /post\.text|post\.images|post\.author/);
});

test('stale CAS is terminal without silent replacement, while Safety denial keeps original request uncertain', async (t) => {
  for (const mode of ['stale', 'safety'] as const) {
    const s = harness(),
      controller = s.make();
    t.after(() => controller.dispose());
    s.gateway.management = async () => ({
      ...manage(),
      ownerHidden: true,
      version: 4,
    });
    s.gateway.submit = async (c) => {
      s.commands.push({ command: c, cancelling: false });
      if (mode === 'safety')
        throw new ClientError('forbidden', 'Restricted', {
          httpStatus: 403,
          serverCode: 'COMMUNITY_ACTION_RESTRICTED',
        });
      return {
        requestId: c.clientRequestId,
        postId: c.postId,
        ownerHidden: c.ownerHidden,
        expectedVersion: c.expectedVersion,
        outcome: 'rejected',
        code: 'POST_OWNER_VISIBILITY_STALE',
      };
    };
    await controller.request(postId, false);
    await controller.submit();
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0]!.command.expectedVersion, 4);
    if (mode === 'stale') {
      assert.equal(s.store.load(s.accountId), null);
      assert.match(s.view().receiptStatus, /未覆盖新状态/);
    } else {
      assert.equal(s.view().frozen, true);
      assert.equal(s.store.load(s.accountId)?.command.ownerHidden, false);
      await controller.request(postId, true);
      await controller.submit();
      assert.equal(s.commands.length, 1);
    }
  }
});

test('management of deleted posts and unchanged desired state cannot create new requests', async (t) => {
  const s = harness(),
    controller = s.make();
  t.after(() => controller.dispose());
  s.gateway.management = async () => ({ ...manage(), canChange: false });
  await controller.request(postId, true);
  await controller.submit();
  assert.equal(s.view().confirming, null);
  assert.equal(s.commands.length, 0);
  s.gateway.management = async () => manage();
  await controller.request(postId, false);
  await controller.submit();
  assert.equal(s.commands.length, 0);
  assert.equal(s.store.load(s.accountId), null);
});

test('private author detail survives an unavailable public pin projection and keeps pin recovery independent', async (t) => {
  const s = harness();
  const runtime: CommunityRuntime = {
    ...s.runtime,
    pendingPostPins: new PendingPostPinStore(s.storage, 'synthetic-origin'),
    postPins: {
      list: async () => ({ spaceId, status: 'available', items: [] }),
      slot: async () => ({
        spaceId,
        status: 'available',
        canUnpin: false,
        pin: null,
      }),
      detail: async () => {
        throw new ClientError('http', 'Not publicly visible', {
          httpStatus: 404,
          serverCode: 'POST_NOT_FOUND',
        });
      },
      submit: async () => {
        throw new Error('Hidden pin must not acknowledge public read');
      },
      receipt: async () => {
        throw absent();
      },
    },
  };
  let pinLoaded = false,
    pinError = '',
    detailLoaded = false;
  const pins = new PinDetailController(runtime, (v) => {
    pinLoaded = v.loaded;
    pinError = v.error;
  });
  const detail = new DetailController(
    runtime,
    postId,
    (v) => {
      detailLoaded = v.loaded;
    },
    (post) => {
      if (post) void pins.load(post.id);
    },
  );
  t.after(() => {
    pins.dispose();
    detail.dispose();
  });
  await detail.load();
  await flush();
  assert.equal(detailLoaded, true);
  assert.equal(pinLoaded, false);
  assert.equal(pinError, '');
});

test('late Safety target-loss resumes exact receipt GET without waiting for unreadable management or replaying writes', async (t) => {
  const s = harness(),
    safety = new SafetyChanges(s.runtime.privateViews);
  const original = s.store.freeze({
    version: 1,
    accountId: s.accountId,
    origin: s.store.origin,
    phase: 'submit',
    command: command(),
  });
  const first = deferred<OwnerVisibilityReceipt>(),
    management = deferred<OwnerVisibilityManagement>();
  let reads = 0,
    managementReads = 0,
    view!: OwnerVisibilityView;
  s.gateway.receipt = async (id) => {
    assert.equal(id, original.command.clientRequestId);
    reads++;
    return reads === 1 ? first.promise : receipt(original.command);
  };
  s.gateway.management = async () => {
    managementReads++;
    return management.promise;
  };
  const controller = new OwnerPostVisibilityController(
    { ...s.runtime, safetyChanges: safety },
    (v) => {
      view = v;
    },
  );
  t.after(() => controller.dispose());
  await controller.load();
  const work = controller.recover();
  await flush();
  assert.equal(view.recovering, true);
  assert.equal(reads, 1);
  // Exact ordering from delayed REPORT_TARGET_UNAVAILABLE after cold boot.
  safety.invalidate(s.accountId);
  await flush();
  assert.equal(reads, 2);
  assert.equal(
    managementReads,
    0,
    'Receipt recovery is independent of content and management GETs',
  );
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(view.frozen, false);
  assert.match(view.receiptStatus, /已确认作者隐藏/);
  assert.equal(s.commands.length, 0);
  // An uncooperative original callback can neither clear a new journal nor reset the settled UI.
  first.resolve({ ...receipt(), postId: otherId });
  await work;
  await flush();
  assert.equal(view.frozen, false);
  assert.match(view.receiptStatus, /已确认作者隐藏/);
  assert.equal(s.commands.length, 0);
});

test('Safety-interrupted original retry resumes lookup only; unknown remains frozen and never retries mutation automatically', async (t) => {
  const s = harness(),
    safety = new SafetyChanges(s.runtime.privateViews);
  s.store.freeze({
    version: 1,
    accountId: s.accountId,
    origin: s.store.origin,
    phase: 'cancel',
    command: command(),
  });
  const first = deferred<OwnerVisibilityReceipt>();
  let reads = 0,
    view!: OwnerVisibilityView;
  s.gateway.receipt = async () => {
    reads++;
    if (reads === 1) return first.promise;
    throw absent();
  };
  const controller = new OwnerPostVisibilityController(
    { ...s.runtime, safetyChanges: safety },
    (v) => {
      view = v;
    },
  );
  t.after(() => controller.dispose());
  await controller.load();
  const work = controller.recover(true);
  await flush();
  safety.invalidate(s.accountId);
  await flush();
  assert.equal(reads, 2);
  assert.equal(view.frozen, true);
  assert.equal(view.pendingPhase, 'cancel');
  assert.equal(s.commands.length, 0);
  first.reject(absent());
  await work;
  await flush();
  assert.equal(s.commands.length, 0);
  assert.equal(view.frozen, true);
});
