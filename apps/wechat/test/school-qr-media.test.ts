import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpSchoolQrMediaGateway } from '../src/school-configuration/qr-gateway';
import { SchoolQrReader } from '../src/school-configuration/qr-runtime';
import type { LocalMediaFile } from '../src/media/contracts';
import { SessionStore } from '../src/auth/session';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import {
  SchoolQrDownload,
  SchoolQrPrincipalOwner,
} from '../src/school-configuration/qr-download';
import {
  SCHOOL_QR_MEDIA_PROTOCOL,
  decodeSchoolQrPrepare,
  decodeSchoolQrGrant,
  decodeSchoolQrDescriptor,
} from '../src/school-configuration/qr-contract';
import type { SchoolQrDescriptor } from '../src/school-configuration/qr-contract';
import { FakeClock, flush, credentials, ScriptedTransport } from './helpers';
import {
  ReadFiles,
  DownloadCall,
  imageHeaders,
} from './support/media-read-fixtures';
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const descriptor: SchoolQrDescriptor = {
  protocol: SCHOOL_QR_MEDIA_PROTOCOL,
  kind: 'school-configuration-qr',
  regionId: id(1),
  entryKey: 'treehole',
  entryRevision: 7,
  bindingId: id(2),
  width: 80,
  height: 60,
  variants: ['thumb-v1', 'display-v1'],
};
function harness() {
  const sessions = new SessionStore(),
    principals = new SchoolQrPrincipalOwner(sessions),
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
  const transfer = new SchoolQrDownload(
    'https://school.invalid',
    wx,
    files,
    registry,
    principals,
    { refresh: async () => sessions.snapshot() },
    clock,
  );
  return { sessions, principals, clock, files, registry, calls, transfer };
}
test('School QR native decoder never accepts another owner, URLs or client approval', () => {
  const input = {
    protocol: SCHOOL_QR_MEDIA_PROTOCOL,
    clientRequestId: id(3),
    regionId: id(1),
    entryKey: 'treehole',
    expectedRevision: 0,
    declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
  };
  assert.deepEqual(decodeSchoolQrPrepare(input), input);
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { slot: 'avatar' },
    { ownerKind: 'community' },
    { approved: true },
    { uploadUrl: 'https://other.invalid' },
    { expectedRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => decodeSchoolQrPrepare({ ...input, ...patch }));
  assert.throws(() => decodeSchoolQrGrant({ ...input, version: 1 }));
  assert.throws(() =>
    decodeSchoolQrDescriptor({ ...descriptor, url: 'https://other.invalid' }),
  );
});
test('School public QR download uses its own campus/revision route and a guest generation lease; login revokes the file', async () => {
  const h = harness(),
    owner = {},
    principal = h.principals.snapshot(),
    cancel = new Cancellation();
  try {
    const promise = h.transfer.download(
      { descriptor, target: { campusId: id(5) } },
      'display-v1',
      owner,
      { current: () => h.principals.snapshot() },
      cancel,
    );
    await flush();
    assert.equal(h.calls.length, 1);
    const call = h.calls[0]!;
    assert.deepEqual(call.options.header, {});
    assert.equal(
      call.options.url,
      `https://school.invalid/v3/media/school-configuration/entries/treehole/bindings/${id(2)}/display-v1?entryRevision=7&campusId=${id(5)}`,
    );
    const path = 'wxfile://tmp/school-qr.png';
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
test('Public review and foreign region descriptors are rejected before native effects; cancelled download never yields a retained QR', async () => {
  const h = harness(),
    owner = {},
    session = { current: () => h.principals.snapshot() };
  try {
    await assert.rejects(
      h.transfer.download(
        {
          descriptor: { ...descriptor, entryKey: 'review' },
          target: { campusId: id(5) },
        },
        'display-v1',
        owner,
        session,
        new Cancellation(),
      ),
    );
    await assert.rejects(
      h.transfer.download(
        { descriptor, target: { regionId: id(9) } },
        'display-v1',
        owner,
        session,
        new Cancellation(),
      ),
    );
    assert.equal(h.calls.length, 0);
    const cancel = new Cancellation(),
      pending = h.transfer.download(
        { descriptor, target: { campusId: id(5) } },
        'display-v1',
        owner,
        session,
        cancel,
      );
    await flush();
    cancel.cancel();
    await assert.rejects(pending);
    const call = h.calls[0]!,
      path = 'wxfile://tmp/cancelled-school-qr.png';
    h.files.put(path);
    call.success(path);
    call.complete();
    await flush();
    assert.ok(h.files.deleted.includes(path));
  } finally {
    h.principals.dispose();
  }
});

test('School QR renderer failure cannot retain a file or revive a disposed reader', async () => {
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
      generation: object;
    } | null = null;
  const adopt = h.registry.adoptGuest.bind(h.registry);
  h.registry.adoptGuest = (...args) => {
    const file = adopt(...args);
    captured = { file, owner: args[2], generation: args[3] };
    return file;
  };
  const reader = new SchoolQrReader(
    h.sessions,
    h.principals,
    new HttpSchoolQrMediaGateway(api),
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
      campusId: id(5),
      entryKey: 'treehole',
      entryRevision: 7,
    });
    for (let i = 0; i < 4; i++) await flush();
    const call = h.calls[0]!,
      path = 'wxfile://tmp/school-renderer-qr.png';
    h.files.put(path);
    call.headers({ ...imageHeaders(), 'x-content-type-options': 'nosniff' });
    call.success(path);
    call.complete();
    await loading;
    const lease = captured as {
      file: LocalMediaFile;
      owner: object;
      generation: object;
    } | null;
    assert.ok(lease);
    assert.equal(
      await h.registry.resolveGuest(lease.file, lease.owner, lease.generation),
      path,
    );
    throwRender = true;
    reader.dispose();
    await assert.rejects(
      h.registry.resolveGuest(lease.file, lease.owner, lease.generation),
    );
    await flush();
    assert.ok(h.files.deleted.includes(path));
    assert.equal(h.clock.timers, 0);
    const afterDispose = rendered;
    h.sessions.completeLogin(h.sessions.beginLogin(), credentials(id(8)));
    await reader.load({
      campusId: id(5),
      entryKey: 'treehole',
      entryRevision: 7,
    });
    assert.equal(rendered, afterDispose);
    assert.equal(h.calls.length, 1);
  } finally {
    reader.dispose();
    h.principals.dispose();
  }
});
test('School QR rejects a response missing the controlled nosniff header and removes its bytes', async () => {
  const h = harness();
  try {
    const pending = h.transfer.download(
      { descriptor, target: { campusId: id(5) } },
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

test('Errand target QR uses authenticated order path, rejects foreign region, and expires its inline lease after 30 seconds', async () => {
  const h = harness(),
    transport = new ScriptedTransport();
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials(id(8)));
  const api = new ApiClient('https://school.invalid', transport, h.sessions, {
    refresh: async () => h.sessions.snapshot(),
  });
  let view = { status: '', src: '', message: '' };
  const reader = new SchoolQrReader(
    h.sessions,
    h.principals,
    new HttpSchoolQrMediaGateway(api),
    h.transfer,
    h.clock,
    (next) => {
      view = next;
    },
  );
  const target = {
    orderId: id(9),
    targetRegionId: id(1),
    entryKey: 'errand' as const,
    entryRevision: 7,
  };
  try {
    transport.reply({ ...descriptor, entryKey: 'errand' });
    const loading = reader.load(target);
    for (let i = 0; i < 4; i++) await flush();
    const call = h.calls[0]!,
      path = 'wxfile://tmp/errand-target-qr.png';
    assert.equal(
      transport.requests[0]!.url,
      `https://school.invalid/v3/media/school-configuration/errands/${id(9)}/descriptor?entryRevision=7`,
    );
    assert.equal(
      call.options.url,
      `https://school.invalid/v3/media/school-configuration/errands/${id(9)}/bindings/${id(2)}/display-v1?entryRevision=7`,
    );
    assert.ok(call.options.header.Authorization);
    h.files.put(path);
    call.headers({ ...imageHeaders(), 'x-content-type-options': 'nosniff' });
    call.success(path);
    call.complete();
    await loading;
    assert.equal(view.src, path);
    h.clock.advance(29999);
    assert.equal(view.src, path);
    h.clock.advance(1);
    await flush();
    assert.equal(view.src, '');
    assert.ok(h.files.deleted.includes(path));
    transport.reply({ ...descriptor, entryKey: 'errand', regionId: id(20) });
    await reader.load(target);
    assert.equal(view.status, 'unavailable');
    assert.equal(h.calls.length, 1);
  } finally {
    reader.dispose();
    h.principals.dispose();
  }
});
