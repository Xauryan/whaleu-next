import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpErrandMediaGateway } from '../src/errands/media-gateway';
import { ErrandMediaReader } from '../src/errands/media-runtime';
import type { LocalMediaFile } from '../src/media/contracts';
import { SessionStore } from '../src/auth/session';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import {
  ErrandMediaDownload,
  ErrandMediaPrincipalOwner,
} from '../src/errands/media-download';
import {
  ERRAND_MEDIA_PROTOCOL,
  decodeErrandMediaPrepare,
  decodeErrandMediaGrant,
  decodeErrandMediaDescriptor,
} from '../src/errands/media-contract';
import type { ErrandMediaDescriptor } from '../src/errands/media-contract';
import { FakeClock, flush, credentials, ScriptedTransport } from './helpers';
import {
  ReadFiles,
  DownloadCall,
  imageHeaders,
} from './support/media-read-fixtures';
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const descriptor: ErrandMediaDescriptor = {
  protocol: ERRAND_MEDIA_PROTOCOL,
  kind: 'errand-media',
  orderId: id(1),
  slot: 'public0',
  revision: 7,
  bindingId: id(2),
  width: 80,
  height: 60,
  variants: ['thumb-v1', 'display-v1'],
};
function harness() {
  const sessions = new SessionStore(),
    principals = new ErrandMediaPrincipalOwner(sessions),
    clock = new FakeClock(),
    files = new ReadFiles(),
    registry = new MediaLocalFiles(files),
    calls: DownloadCall[] = [];
  const wx: WxMediaApi = {
    downloadFile: (options) => {
      const call = new DownloadCall(options);
      calls.push(call);
      return call;
    },
  };
  const transfer = new ErrandMediaDownload(
    'https://school.invalid',
    wx,
    files,
    registry,
    principals,
    { refresh: async () => sessions.snapshot() },
    clock,
  );
  sessions.completeLogin(sessions.beginLogin(), credentials(id(7)));
  return { sessions, principals, clock, files, registry, calls, transfer };
}
test('Errand image native decoder never accepts another owner, URLs or client approval', () => {
  const input = {
    protocol: ERRAND_MEDIA_PROTOCOL,
    clientRequestId: id(3),
    draftId: id(1),
    targetRegionId: id(20),
    slot: 'public0',
    draftRevision: 1,
    declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
  };
  assert.deepEqual(decodeErrandMediaPrepare(input), input);
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { slot: 'foreign' },
    { ownerKind: 'community' },
    { approved: true },
    { uploadUrl: 'https://other.invalid' },
    { draftRevision: -1 },
    { draftRevision: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => decodeErrandMediaPrepare({ ...input, ...patch }));
  assert.throws(() => decodeErrandMediaGrant({ ...input, version: 1 }));
  assert.throws(() =>
    decodeErrandMediaDescriptor({
      ...descriptor,
      url: 'https://other.invalid',
    }),
  );
});
test('Errand image uses authenticated exact errand/revision/slot route; switching account revokes the file', async () => {
  const h = harness(),
    owner = {},
    principal = h.principals.snapshot(),
    cancel = new Cancellation();
  try {
    const promise = h.transfer.download(
      { descriptor, target: { orderId: id(1) } },
      'display-v1',
      owner,
      { current: () => h.principals.snapshot() },
      cancel,
    );
    await flush();
    assert.equal(h.calls.length, 1);
    const call = h.calls[0]!;
    assert.equal(
      call.options.header.Authorization,
      `Bearer ${h.sessions.snapshot().credentials!.accessToken}`,
    );
    assert.equal(
      call.options.url,
      `https://school.invalid/v3/media/errands/orders/${id(1)}/public0/bindings/${id(2)}/display-v1?revision=7`,
    );
    const path = 'wxfile://tmp/errand.png';
    h.files.put(path);
    call.headers({ ...imageHeaders(), 'x-content-type-options': 'nosniff' });
    call.success(path);
    call.complete();
    const file = await promise;
    assert.equal(await h.transfer.resolve(file, owner, principal), path);
    h.sessions.completeLogin(h.sessions.beginLogin(), credentials(id(8)));
    await assert.rejects(h.transfer.resolve(file, owner, principal));
    await h.transfer.release(file);
    assert.ok(h.files.deleted.includes(path));
  } finally {
    h.principals.dispose();
  }
});
test('Foreign owner slots and foreign errand descriptors are rejected before native effects; cancelled download never yields a retained errand image', async () => {
  const h = harness(),
    owner = {},
    session = { current: () => h.principals.snapshot() };
  try {
    await assert.rejects(
      h.transfer.download(
        {
          descriptor: {
            ...descriptor,
            slot: 'managerContact' as ErrandMediaDescriptor['slot'],
          },
          target: { orderId: id(1) },
        },
        'display-v1',
        owner,
        session,
        new Cancellation(),
      ),
    );
    await assert.rejects(
      h.transfer.download(
        {
          descriptor,
          target: { orderId: id(9) },
        },
        'display-v1',
        owner,
        session,
        new Cancellation(),
      ),
    );
    assert.equal(h.calls.length, 0);
    const cancel = new Cancellation(),
      pending = h.transfer.download(
        { descriptor, target: { orderId: id(1) } },
        'display-v1',
        owner,
        session,
        cancel,
      );
    await flush();
    cancel.cancel();
    await assert.rejects(pending);
    const call = h.calls[0]!,
      path = 'wxfile://tmp/cancelled-errand.png';
    h.files.put(path);
    call.success(path);
    call.complete();
    await flush();
    assert.ok(h.files.deleted.includes(path));
  } finally {
    h.principals.dispose();
  }
});

test('Errand image renderer failure cannot retain a file or revive a disposed reader', async () => {
  const h = harness(),
    transport = new ScriptedTransport(),
    api = new ApiClient('https://school.invalid', transport, h.sessions, {
      refresh: async () => h.sessions.snapshot(),
    });
  let throwRender = false,
    rendered = 0,
    captured: {
      file: LocalMediaFile;
      owner: object;
      ticket: import('../src/auth/session').SessionTicket;
    } | null = null;
  const adopt = h.registry.adopt.bind(h.registry);
  h.registry.adopt = (...args) => {
    const file = adopt(...args);
    captured = { file, owner: args[2], ticket: args[3] };
    return file;
  };
  const reader = new ErrandMediaReader(
    h.sessions,
    h.principals,
    new HttpErrandMediaGateway(api),
    h.transfer,
    h.clock,
    () => {
      rendered++;
      if (throwRender) throw new Error('synthetic renderer failure');
    },
  );
  try {
    transport.reply(descriptor);
    const loading = reader.load({
      orderId: id(1),
      slot: 'public0',
      revision: 7,
    });
    for (let i = 0; i < 4; i++) await flush();
    const call = h.calls[0]!,
      path = 'wxfile://tmp/errand-renderer.png';
    h.files.put(path);
    call.headers({ ...imageHeaders(), 'x-content-type-options': 'nosniff' });
    call.success(path);
    call.complete();
    await loading;
    const lease = captured as {
      file: LocalMediaFile;
      owner: object;
      ticket: import('../src/auth/session').SessionTicket;
    } | null;
    assert.ok(lease);
    assert.equal(
      await h.registry.resolve(lease.file, lease.owner, lease.ticket),
      path,
    );
    throwRender = true;
    reader.dispose();
    await assert.rejects(
      h.registry.resolve(lease.file, lease.owner, lease.ticket),
    );
    await flush();
    assert.ok(h.files.deleted.includes(path));
    assert.equal(h.clock.timers, 0);
    const afterDispose = rendered;
    h.sessions.completeLogin(h.sessions.beginLogin(), credentials(id(8)));
    await reader.load({
      orderId: id(1),
      slot: 'public0',
      revision: 7,
    });
    assert.equal(rendered, afterDispose);
    assert.equal(h.calls.length, 1);
  } finally {
    reader.dispose();
    h.principals.dispose();
  }
});
test('Errand image rejects a response missing the controlled nosniff header and removes its bytes', async () => {
  const h = harness();
  try {
    const pending = h.transfer.download(
      { descriptor, target: { orderId: id(1) } },
      'display-v1',
      {},
      { current: () => h.principals.snapshot() },
      new Cancellation(),
    );
    await flush();
    const call = h.calls[0]!,
      path = 'wxfile://tmp/school-unsafe-header.png';
    h.files.put(path);
    call.headers(imageHeaders());
    call.success(path);
    call.complete();
    await assert.rejects(pending, /Invalid controlled avatar response/);
    assert.ok(h.files.deleted.includes(path));
  } finally {
    h.principals.dispose();
  }
});

test('Errand native download refuses guest before native byte effects', async () => {
  const h = harness();
  h.sessions.logout();
  try {
    await assert.rejects(
      h.transfer.download(
        { descriptor, target: { orderId: id(1) } },
        'display-v1',
        {},
        { current: () => h.principals.snapshot() },
        new Cancellation(),
      ),
    );
    assert.equal(h.calls.length, 0);
  } finally {
    h.principals.dispose();
  }
});

test('Errand journals keep independent revision/slot keys and reconcile only exact server-confirmed history', async () => {
  const { sha256 } = await import('js-sha256');
  const { createErrandMediaRuntime } =
    await import('../src/errands/media-runtime.js');
  const { errandMediaPrepareHash } =
    await import('../src/errands/media-contract.js');
  const { MemoryStorage } = await import('./helpers.js');
  const h = harness(),
    storage = new MemoryStorage(),
    transport = new ScriptedTransport(),
    origin = 'https://school.invalid';
  const api = new ApiClient(origin, transport, h.sessions, {
    refresh: async () => h.sessions.snapshot(),
  });
  const records = (['public0', 'private0', 'private2'] as const).map(
    (slot, index) => {
      const input = {
        protocol: ERRAND_MEDIA_PROTOCOL,
        clientRequestId: id(30 + index),
        draftId: id(1),
        targetRegionId: id(20),
        slot,
        draftRevision: index === 2 ? 8 : 7,
        declaration: {
          mime: 'image/png' as const,
          bytes: 100,
          sha256: 'a'.repeat(64),
        },
      };
      return {
        actor: id(7),
        input,
        hash: errandMediaPrepareHash(id(7), input),
      };
    },
  );
  const key = `whaleu.errand-media.v1.${sha256(origin)}.${id(7)}`;
  storage.set(key, records);
  const runtime = createErrandMediaRuntime({
    api,
    sessions: h.sessions,
    storage,
    origin,
    clock: h.clock,
    newRequestId: async () => id(99),
    wx: {},
    files: Object.assign(h.files, { digest: async () => 'a'.repeat(64) }),
    registry: h.registry,
    auth: { refresh: async () => h.sessions.snapshot() },
  });
  try {
    assert.equal(runtime.pendingTargets(id(1)).length, 3);
    for (const [index, record] of records.entries())
      transport.reply({
        protocol: ERRAND_MEDIA_PROTOCOL,
        requestId: record.input.clientRequestId,
        requestHash: record.hash,
        serverNow: 1000,
        state: 'recorded',
        status: {
          protocol: ERRAND_MEDIA_PROTOCOL,
          intentId: id(40 + index),
          requestId: record.input.clientRequestId,
          requestHash: record.hash,
          serverNow: 1000,
          ...(index === 0
            ? {
                status: 'bound_history',
                assetId: id(50 + index),
                bindingId: id(60 + index),
                attachmentState: 'active',
              }
            : {
                status: 'ready_unbound',
                manifestDigest: 'c'.repeat(64),
                assetId: id(50 + index),
                bindBefore: 60000,
                mediaProof: 'current',
              }),
        },
      });
    await runtime.reconcile(id(1));
    assert.deepEqual(
      runtime.pendingTargets(id(1)).map((v) => [v.slot, v.draftRevision]),
      [
        ['private0', 7],
        ['private2', 8],
      ],
    );
    h.sessions.completeLogin(h.sessions.beginLogin(), credentials(id(8)));
    assert.equal(runtime.pendingTargets().length, 0);
    assert.equal((storage.get(key) as unknown[]).length, 2);
  } finally {
    runtime.hide();
    h.principals.dispose();
  }
});
