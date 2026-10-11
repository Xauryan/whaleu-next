import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpActivityMediaGateway } from '../src/activities/media-gateway';
import { ActivityMediaReader } from '../src/activities/media-runtime';
import type { LocalMediaFile } from '../src/media/contracts';
import { SessionStore } from '../src/auth/session';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import {
  ActivityMediaDownload,
  ActivityMediaPrincipalOwner,
} from '../src/activities/media-download';
import {
  ACTIVITY_MEDIA_PROTOCOL,
  decodeActivityMediaPrepare,
  decodeActivityMediaGrant,
  decodeActivityMediaDescriptor,
} from '../src/activities/media-contract';
import type { ActivityMediaDescriptor } from '../src/activities/media-contract';
import { FakeClock, flush, credentials, ScriptedTransport } from './helpers';
import {
  ReadFiles,
  DownloadCall,
  imageHeaders,
} from './support/media-read-fixtures';
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const descriptor: ActivityMediaDescriptor = {
  protocol: ACTIVITY_MEDIA_PROTOCOL,
  kind: 'activity-media',
  activityId: id(1),
  slot: 'cover',
  revision: 7,
  bindingId: id(2),
  width: 80,
  height: 60,
  variants: ['thumb-v1', 'display-v1'],
};
function harness() {
  const sessions = new SessionStore(),
    principals = new ActivityMediaPrincipalOwner(sessions),
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
  const transfer = new ActivityMediaDownload(
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
test('Activity image native decoder never accepts another owner, URLs or client approval', () => {
  const input = {
    protocol: ACTIVITY_MEDIA_PROTOCOL,
    clientRequestId: id(3),
    activityId: id(1),
    slot: 'cover',
    revision: 1,
    declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
  };
  assert.deepEqual(decodeActivityMediaPrepare(input), input);
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { slot: 'foreign' },
    { ownerKind: 'community' },
    { approved: true },
    { uploadUrl: 'https://other.invalid' },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => decodeActivityMediaPrepare({ ...input, ...patch }));
  assert.throws(() => decodeActivityMediaGrant({ ...input, version: 1 }));
  assert.throws(() =>
    decodeActivityMediaDescriptor({
      ...descriptor,
      url: 'https://other.invalid',
    }),
  );
});
test('Activity image uses authenticated exact activity/revision/slot route; switching account revokes the file', async () => {
  const h = harness(),
    owner = {},
    principal = h.principals.snapshot(),
    cancel = new Cancellation();
  try {
    const promise = h.transfer.download(
      { descriptor, target: { activityId: id(1), audience: 'public' } },
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
      `https://school.invalid/v3/media/activities/public/activities/${id(1)}/slots/cover/bindings/${id(2)}/display-v1?revision=7`,
    );
    const path = 'wxfile://tmp/activity.png';
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
test('Foreign owner slots and foreign activity descriptors are rejected before native effects; cancelled download never yields a retained activity image', async () => {
  const h = harness(),
    owner = {},
    session = { current: () => h.principals.snapshot() };
  try {
    await assert.rejects(
      h.transfer.download(
        {
          descriptor: {
            ...descriptor,
            slot: 'managerContact' as ActivityMediaDescriptor['slot'],
          },
          target: { activityId: id(1), audience: 'public' },
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
          target: { activityId: id(9), audience: 'management' },
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
        { descriptor, target: { activityId: id(1), audience: 'public' } },
        'display-v1',
        owner,
        session,
        cancel,
      );
    await flush();
    cancel.cancel();
    await assert.rejects(pending);
    const call = h.calls[0]!,
      path = 'wxfile://tmp/cancelled-activity.png';
    h.files.put(path);
    call.success(path);
    call.complete();
    await flush();
    assert.ok(h.files.deleted.includes(path));
  } finally {
    h.principals.dispose();
  }
});

test('Activity image renderer failure cannot retain a file or revive a disposed reader', async () => {
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
  const reader = new ActivityMediaReader(
    h.sessions,
    h.principals,
    new HttpActivityMediaGateway(api),
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
      activityId: id(1),
      audience: 'public',
      slot: 'cover',
      revision: 7,
    });
    for (let i = 0; i < 4; i++) await flush();
    const call = h.calls[0]!,
      path = 'wxfile://tmp/activity-renderer.png';
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
      activityId: id(1),
      audience: 'public',
      slot: 'cover',
      revision: 7,
    });
    assert.equal(rendered, afterDispose);
    assert.equal(h.calls.length, 1);
  } finally {
    reader.dispose();
    h.principals.dispose();
  }
});
test('Activity image rejects a response missing the controlled nosniff header and removes its bytes', async () => {
  const h = harness();
  try {
    const pending = h.transfer.download(
      { descriptor, target: { activityId: id(1), audience: 'public' } },
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

test('Activity native download refuses guest before native byte effects', async () => {
  const h = harness();
  h.sessions.logout();
  try {
    await assert.rejects(
      h.transfer.download(
        { descriptor, target: { activityId: id(1), audience: 'public' } },
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

test('Activity journals keep independent revision/slot keys and reconcile only exact server-confirmed history', async () => {
  const { sha256 } = await import('js-sha256');
  const { createActivityMediaRuntime } =
    await import('../src/activities/media-runtime.js');
  const { activityMediaPrepareHash } =
    await import('../src/activities/media-contract.js');
  const { MemoryStorage } = await import('./helpers.js');
  const h = harness(),
    storage = new MemoryStorage(),
    transport = new ScriptedTransport(),
    origin = 'https://school.invalid';
  const api = new ApiClient(origin, transport, h.sessions, {
    refresh: async () => h.sessions.snapshot(),
  });
  const records = (['cover', 'gallery0', 'gallery8'] as const).map(
    (slot, index) => {
      const input = {
        protocol: ACTIVITY_MEDIA_PROTOCOL,
        clientRequestId: id(30 + index),
        activityId: id(1),
        slot,
        revision: index === 2 ? 8 : 7,
        declaration: {
          mime: 'image/png' as const,
          bytes: 100,
          sha256: 'a'.repeat(64),
        },
      };
      return {
        actor: id(7),
        input,
        hash: activityMediaPrepareHash(id(7), input),
      };
    },
  );
  const key = `whaleu.activity-media.v1.${sha256(origin)}.${id(7)}`;
  storage.set(key, records);
  const runtime = createActivityMediaRuntime({
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
        protocol: ACTIVITY_MEDIA_PROTOCOL,
        requestId: record.input.clientRequestId,
        requestHash: record.hash,
        serverNow: 1000,
        state: 'recorded',
        status: {
          protocol: ACTIVITY_MEDIA_PROTOCOL,
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
                assetId: id(50 + index),
                bindBefore: 60000,
                mediaProof: 'current',
              }),
        },
      });
    await runtime.reconcile(id(1));
    assert.deepEqual(
      runtime.pendingTargets(id(1)).map((v) => [v.slot, v.revision]),
      [
        ['gallery0', 7],
        ['gallery8', 8],
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
