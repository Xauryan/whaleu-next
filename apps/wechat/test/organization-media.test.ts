import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpOrganizationMediaGateway } from '../src/organizations/media-gateway';
import { OrganizationMediaReader } from '../src/organizations/media-runtime';
import type { LocalMediaFile } from '../src/media/contracts';
import { SessionStore } from '../src/auth/session';
import { MediaLocalFiles } from '../src/media/local-files';
import { Cancellation } from '../src/platform/contracts';
import type { WxMediaApi } from '../src/platform/wechat-media';
import {
  OrganizationMediaDownload,
  OrganizationMediaPrincipalOwner,
} from '../src/organizations/media-download';
import {
  ORGANIZATION_MEDIA_PROTOCOL,
  decodeOrganizationMediaPrepare,
  decodeOrganizationMediaGrant,
  decodeOrganizationMediaDescriptor,
} from '../src/organizations/media-contract';
import type { OrganizationMediaDescriptor } from '../src/organizations/media-contract';
import { FakeClock, flush, credentials, ScriptedTransport } from './helpers';
import {
  ReadFiles,
  DownloadCall,
  imageHeaders,
} from './support/media-read-fixtures';
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const descriptor: OrganizationMediaDescriptor = {
  protocol: ORGANIZATION_MEDIA_PROTOCOL,
  kind: 'organization-media',
  organizationId: id(1),
  slot: 'avatar',
  applicationRevision: 7,
  bindingId: id(2),
  width: 80,
  height: 60,
  variants: ['thumb-v1', 'display-v1'],
};
function harness() {
  const sessions = new SessionStore(),
    principals = new OrganizationMediaPrincipalOwner(sessions),
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
  const transfer = new OrganizationMediaDownload(
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
test('Organization image native decoder never accepts another owner, URLs or client approval', () => {
  const input = {
    protocol: ORGANIZATION_MEDIA_PROTOCOL,
    clientRequestId: id(3),
    organizationId: id(1),
    slot: 'avatar',
    applicationRevision: 1,
    declaration: { mime: 'image/png', bytes: 20, sha256: 'a'.repeat(64) },
  };
  assert.deepEqual(decodeOrganizationMediaPrepare(input), input);
  for (const patch of [
    { protocol: 'profile-media-v1' },
    { slot: 'foreign' },
    { ownerKind: 'community' },
    { approved: true },
    { uploadUrl: 'https://other.invalid' },
    { applicationRevision: -1 },
    { applicationRevision: Number.MAX_SAFE_INTEGER },
  ])
    assert.throws(() => decodeOrganizationMediaPrepare({ ...input, ...patch }));
  assert.throws(() => decodeOrganizationMediaGrant({ ...input, version: 1 }));
  assert.throws(() =>
    decodeOrganizationMediaDescriptor({
      ...descriptor,
      url: 'https://other.invalid',
    }),
  );
});
test('Organization image uses authenticated exact organization/revision/slot route; switching account revokes the file', async () => {
  const h = harness(),
    owner = {},
    principal = h.principals.snapshot(),
    cancel = new Cancellation();
  try {
    const promise = h.transfer.download(
      { descriptor, target: { organizationId: id(1), audience: 'public' } },
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
      `https://school.invalid/v3/media/organizations/public/organizations/${id(1)}/slots/avatar/bindings/${id(2)}/display-v1?applicationRevision=7`,
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
test('Private managerContact and foreign organization descriptors are rejected before native effects; cancelled download never yields a retained QR', async () => {
  const h = harness(),
    owner = {},
    session = { current: () => h.principals.snapshot() };
  try {
    await assert.rejects(
      h.transfer.download(
        {
          descriptor: { ...descriptor, slot: 'managerContact' },
          target: { organizationId: id(1), audience: 'public' },
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
          target: { organizationId: id(9), audience: 'management' },
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
        { descriptor, target: { organizationId: id(1), audience: 'public' } },
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

test('Organization image renderer failure cannot retain a file or revive a disposed reader', async () => {
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
  const reader = new OrganizationMediaReader(
    h.sessions,
    h.principals,
    new HttpOrganizationMediaGateway(api),
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
      organizationId: id(1),
      audience: 'public',
      slot: 'avatar',
      applicationRevision: 7,
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
      organizationId: id(1),
      audience: 'public',
      slot: 'avatar',
      applicationRevision: 7,
    });
    assert.equal(rendered, afterDispose);
    assert.equal(h.calls.length, 1);
  } finally {
    reader.dispose();
    h.principals.dispose();
  }
});
test('Organization image rejects a response missing the controlled nosniff header and removes its bytes', async () => {
  const h = harness();
  try {
    const pending = h.transfer.download(
      { descriptor, target: { organizationId: id(1), audience: 'public' } },
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

test('Organization native download refuses guest before native byte effects', async () => {
  const h = harness();
  h.sessions.logout();
  try {
    await assert.rejects(
      h.transfer.download(
        { descriptor, target: { organizationId: id(1), audience: 'public' } },
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

test('Organization journals keep independent revision/slot keys and reconcile only exact server-confirmed history', async () => {
  const { sha256 } = await import('js-sha256');
  const { createOrganizationMediaRuntime } =
    await import('../src/organizations/media-runtime.js');
  const { organizationMediaPrepareHash } =
    await import('../src/organizations/media-contract.js');
  const { MemoryStorage } = await import('./helpers.js');
  const h = harness(),
    storage = new MemoryStorage(),
    transport = new ScriptedTransport(),
    origin = 'https://school.invalid';
  const api = new ApiClient(origin, transport, h.sessions, {
    refresh: async () => h.sessions.snapshot(),
  });
  const records = (['avatar', 'mainQr', 'introImage8'] as const).map(
    (slot, index) => {
      const input = {
        protocol: ORGANIZATION_MEDIA_PROTOCOL,
        clientRequestId: id(30 + index),
        organizationId: id(1),
        slot,
        applicationRevision: index === 2 ? 8 : 7,
        declaration: {
          mime: 'image/png' as const,
          bytes: 100,
          sha256: 'a'.repeat(64),
        },
      };
      return {
        actor: id(7),
        input,
        hash: organizationMediaPrepareHash(id(7), input),
      };
    },
  );
  const key = `whaleu.organization-media.v1.${sha256(origin)}.${id(7)}`;
  storage.set(key, records);
  const runtime = createOrganizationMediaRuntime({
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
        protocol: ORGANIZATION_MEDIA_PROTOCOL,
        requestId: record.input.clientRequestId,
        requestHash: record.hash,
        serverNow: 1000,
        state: 'recorded',
        status: {
          protocol: ORGANIZATION_MEDIA_PROTOCOL,
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
      runtime.pendingTargets(id(1)).map((v) => [v.slot, v.applicationRevision]),
      [
        ['mainQr', 7],
        ['introImage8', 8],
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
