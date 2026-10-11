import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpAnnouncementMediaGateway } from '../src/media/announcement-gateway';
import { AnnouncementMediaReader } from '../src/media/announcement-runtime';
import type { LocalMediaFile } from '../src/media/contracts';
import { SessionStore } from '../src/auth/session';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import {
  AnnouncementMediaDownload,
  AnnouncementMediaPrincipalOwner,
} from '../src/media/announcement-download';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  decodeAnnouncementMediaPrepare,
  decodeAnnouncementMediaGrant,
  decodeAnnouncementMediaDescriptor,
} from '../src/media/announcement-contract';
import type { AnnouncementMediaDescriptor } from '../src/media/announcement-contract';
import { FakeClock, flush, credentials, ScriptedTransport } from './helpers';
import {
  ReadFiles,
  DownloadCall,
  imageHeaders,
} from './support/media-read-fixtures';
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const descriptor: AnnouncementMediaDescriptor = {
  protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
  kind: 'announcement-media',
  announcementId: id(1),
  slot: 'gallery0',
  revision: 7,
  bindingId: id(2),
  width: 80,
  height: 60,
  variants: ['thumb-v1', 'display-v1'],
};
function harness() {
  const sessions = new SessionStore(),
    principals = new AnnouncementMediaPrincipalOwner(sessions),
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
  const transfer = new AnnouncementMediaDownload(
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
test('Announcement image native decoder never accepts another owner, URLs or client approval', () => {
  const input = {
    protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
    clientRequestId: id(3),
    announcementId: id(1),
    slot: 'gallery0',
    revision: 1,
    declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
  };
  assert.deepEqual(decodeAnnouncementMediaPrepare(input), input);
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { slot: 'foreign' },
    { ownerKind: 'community' },
    { approved: true },
    { uploadUrl: 'https://other.invalid' },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => decodeAnnouncementMediaPrepare({ ...input, ...patch }));
  assert.throws(() => decodeAnnouncementMediaGrant({ ...input, version: 1 }));
  assert.throws(() =>
    decodeAnnouncementMediaDescriptor({
      ...descriptor,
      url: 'https://other.invalid',
    }),
  );
});
test('Announcement image uses authenticated exact announcement/revision/slot route; switching account revokes the file', async () => {
  const h = harness(),
    owner = {},
    principal = h.principals.snapshot(),
    cancel = new Cancellation();
  try {
    const promise = h.transfer.download(
      {
        descriptor,
        target: { announcementId: id(1), audience: 'public', campusId: null },
      },
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
      `https://school.invalid/v3/media/announcements/public/announcements/${id(1)}/slots/gallery0/bindings/${id(2)}/display-v1?revision=7`,
    );
    const path = 'wxfile://tmp/announcement.png';
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
test('Foreign owner slots and foreign announcement descriptors are rejected before native effects; cancelled download never yields a retained announcement image', async () => {
  const h = harness(),
    owner = {},
    session = { current: () => h.principals.snapshot() };
  try {
    await assert.rejects(
      h.transfer.download(
        {
          descriptor: {
            ...descriptor,
            slot: 'managerContact' as AnnouncementMediaDescriptor['slot'],
          },
          target: { announcementId: id(1), audience: 'public', campusId: null },
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
          target: {
            announcementId: id(9),
            audience: 'management',
            campusId: null,
          },
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
        {
          descriptor,
          target: { announcementId: id(1), audience: 'public', campusId: null },
        },
        'display-v1',
        owner,
        session,
        cancel,
      );
    await flush();
    cancel.cancel();
    await assert.rejects(pending);
    const call = h.calls[0]!,
      path = 'wxfile://tmp/cancelled-announcement.png';
    h.files.put(path);
    call.success(path);
    call.complete();
    await flush();
    assert.ok(h.files.deleted.includes(path));
  } finally {
    h.principals.dispose();
  }
});

test('Announcement image renderer failure cannot retain a file or revive a disposed reader', async () => {
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
  const reader = new AnnouncementMediaReader(
    h.sessions,
    h.principals,
    new HttpAnnouncementMediaGateway(api),
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
      announcementId: id(1),
      audience: 'public',
      campusId: null,
      slot: 'gallery0',
      revision: 7,
    });
    for (let i = 0; i < 4; i++) await flush();
    const call = h.calls[0]!,
      path = 'wxfile://tmp/announcement-renderer.png';
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
      announcementId: id(1),
      audience: 'public',
      campusId: null,
      slot: 'gallery0',
      revision: 7,
    });
    assert.equal(rendered, afterDispose);
    assert.equal(h.calls.length, 1);
  } finally {
    reader.dispose();
    h.principals.dispose();
  }
});
test('Announcement image rejects a response missing the controlled nosniff header and removes its bytes', async () => {
  const h = harness();
  try {
    const pending = h.transfer.download(
      {
        descriptor,
        target: { announcementId: id(1), audience: 'public', campusId: null },
      },
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

test('Announcement management download refuses guest before native byte effects', async () => {
  const h = harness();
  h.sessions.logout();
  try {
    await assert.rejects(
      h.transfer.download(
        {
          descriptor,
          target: {
            announcementId: id(1),
            audience: 'management',
            campusId: null,
          },
        },
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

test('Announcement journals keep independent revision/slot keys and reconcile only exact server-confirmed history', async () => {
  const { sha256 } = await import('js-sha256');
  const { createAnnouncementMediaRuntime } =
    await import('../src/media/announcement-runtime.js');
  const { announcementMediaPrepareHash } =
    await import('../src/media/announcement-contract.js');
  const { MemoryStorage } = await import('./helpers.js');
  const h = harness(),
    storage = new MemoryStorage(),
    transport = new ScriptedTransport(),
    origin = 'https://school.invalid';
  const api = new ApiClient(origin, transport, h.sessions, {
    refresh: async () => h.sessions.snapshot(),
  });
  const records = (['gallery0', 'gallery1', 'gallery8'] as const).map(
    (slot, index) => {
      const input = {
        protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
        clientRequestId: id(30 + index),
        announcementId: id(1),
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
        hash: announcementMediaPrepareHash(id(7), input),
      };
    },
  );
  const key = `whaleu.announcement-media.v1.${sha256(origin)}.${id(7)}`;
  storage.set(key, records);
  const runtime = createAnnouncementMediaRuntime({
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
        protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
        requestId: record.input.clientRequestId,
        requestHash: record.hash,
        serverNow: 1000,
        state: 'recorded',
        status: {
          protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
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
        ['gallery1', 7],
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

test('Announcement public guest download is isolated and invalidated on login, with exact campus query', async () => {
  const h = harness();
  h.sessions.logout();
  const owner = {},
    principal = h.principals.snapshot();
  try {
    const pending = h.transfer.download(
      {
        descriptor,
        target: { announcementId: id(1), audience: 'public', campusId: id(99) },
      },
      'display-v1',
      owner,
      { current: () => h.principals.snapshot() },
      new Cancellation(),
    );
    await flush();
    assert.equal(h.calls.length, 1);
    const call = h.calls[0]!;
    assert.equal(call.options.header.Authorization, undefined);
    assert.match(call.options.url, new RegExp('campusId=' + id(99)));
    const path = 'wxfile://tmp/announcement-guest.png';
    h.files.put(path);
    call.headers({ ...imageHeaders(), 'x-content-type-options': 'nosniff' });
    call.success(path);
    call.complete();
    const file = await pending;
    assert.equal(await h.transfer.resolve(file, owner, principal), path);
    h.sessions.completeLogin(h.sessions.beginLogin(), credentials(id(7)));
    await assert.rejects(h.transfer.resolve(file, owner, principal));
    await h.transfer.release(file);
    assert.ok(h.files.deleted.includes(path));
  } finally {
    h.principals.dispose();
  }
});
