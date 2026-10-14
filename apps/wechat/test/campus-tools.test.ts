import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { AuthService } from '../src/auth/auth-service';
import { ToolAuthRecovery } from '../src/campus-tools/auth-recovery';
import {
  canonicalToolLink,
  decodeToolPolicy,
  compareToolInstants,
  decodeToolDetail,
  decodeToolHub,
  decodeToolLink,
  type ToolHub,
} from '../src/campus-tools/contract';
import {
  ToolEntryController,
  ToolHubController,
  initialToolEntryView,
  initialToolHubView,
} from '../src/campus-tools/controller';
import {
  disabledToolLocation,
  nativeToolLocation,
  type ToolLocationResult,
} from '../src/campus-tools/location';
import {
  ToolImageReader,
  decodeToolMedia,
  initialToolImageView,
  type ToolMediaDescriptor,
} from '../src/campus-tools/media';
import { toolEntryPath, toolRoute } from '../src/campus-tools/navigation';
import { ToolBrowseScope } from '../src/campus-tools/scope';
import { OptionalMediaPrincipalOwner } from '../src/media/optional-principal';
import { Cancellation } from '../src/platform/contracts';
import type { ProfileGateway } from '../src/profile/gateway';
import { deferred, FakeClock, flush, MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  campusId,
  detail,
  digest,
  entry,
  entryId,
  gateway,
  hub,
  link,
  policy,
  revision,
  route,
  slot,
} from './campus-tools-fixtures';

test('campus tools strict states do not turn missing evidence into known empty or leak disabled payloads', () => {
  assert.deepEqual(decodeToolHub(hub()), hub());
  assert.deepEqual(decodeToolDetail(detail()), detail());
  for (const state of ['unknown', 'expired', 'unavailable']) {
    assert.equal(
      decodeToolHub({ state, campusId, reason: 'synthetic' }).state,
      state,
    );
    assert.throws(() =>
      decodeToolHub({ state, campusId, reason: 'synthetic', entries: [] }),
    );
  }
  const ready = hub();
  assert.ok('entries' in ready);
  for (const state of ['known_empty', 'not_applicable'])
    assert.equal(decodeToolHub({ ...ready, state, entries: [] }).state, state);
  assert.throws(() => decodeToolHub({ ...ready, entries: [] }));
  assert.throws(() => decodeToolHub({ ...ready, state: 'known_empty' }));
  const enabled = entry();
  assert.throws(() =>
    decodeToolDetail({ ...detail(), entry: { ...enabled, state: 'disabled' } }),
  );
  const inert = {
    id: entryId,
    sourceId: 'synthetic',
    ordinal: 0,
    revision,
    title: '合成',
    state: 'disabled',
    kind: 'map',
  };
  assert.equal(decodeToolDetail({ ...detail(), entry: inert }).state, 'ready');
  if (enabled.kind === 'map') {
    assert.throws(() =>
      decodeToolDetail({
        ...detail(),
        entry: { ...enabled, coordinateSystem: 'unknown' },
      }),
    );
    assert.throws(() =>
      decodeToolDetail({
        ...detail(),
        entry: {
          ...enabled,
          markers: [enabled.markers[0], enabled.markers[0]],
        },
      }),
    );
    assert.throws(() =>
      decodeToolDetail({
        ...detail(),
        entry: { ...enabled, center: { latitude: NaN, longitude: 116 } },
      }),
    );
  }
  assert.throws(() =>
    decodeToolDetail({
      ...detail(entry('research')),
      url: 'https://untrusted.example/resource',
    }),
  );
});

test('exact ASCII action policies reject ambiguity without requiring a URL global', () => {
  assert.equal(
    canonicalToolLink('https://tools.example.com/resource', 'copy', policy),
    'https://tools.example.com/resource',
  );
  assert.deepEqual(decodeToolLink(link()), link());
  for (const value of [
    'http://tools.example.com/resource',
    '//tools.example.com/resource',
    'javascript:alert(1)',
    'data:text/plain,hello',
    'https://tools.example.com.attacker.com/resource',
    'https://a.tools.example.com/resource',
    'https://evil@tools.example.com/resource',
    'https://tools.example.com:443/resource',
    'https://tools.example.com./resource',
    'https://TOOLS.example.com/resource',
    'https://tools.example.com/resource#fragment',
    'https://tools.example.com/resource?next=x',
    'https://tools.example.com/../resource',
    'https://tools.example.com/%2e%2e/resource',
    'https://tools.example.com/%252fresource',
    'https://tools.example.com/%0a',
    'https://tools.example.com/%',
    'https://tools.example.com/\\resource',
    'https://127.0.0.1/resource',
    'https://localhost/resource',
    'https://xn--e1afmkfd.com/resource',
    'https://tools.example.com/资源',
  ])
    assert.throws(() => canonicalToolLink(value, 'copy', policy), value);
  assert.throws(() =>
    canonicalToolLink('https://tools.example.com/resource', 'webview', policy),
  );
  assert.throws(() =>
    decodeToolLink({ ...link(), policy: { ...policy, version: 2 } }),
  );
  assert.throws(() =>
    toolRoute({ ...route, url: 'https://tools.example.com/resource' }),
  );
  assert.throws(() => toolRoute({ campusId, entryId }));
  assert.ok(toolEntryPath(route, entry())?.includes('campus-tools-map'));
});

function controller(kind: 'map' | 'research' | 'web-link' | 'shuttle' = 'map') {
  const sessions = new SessionStore(),
    scope = new ToolBrowseScope(),
    clock = new FakeClock(),
    remote = gateway(entry(kind));
  let view = initialToolEntryView();
  let imageClears = 0;
  const copies: string[] = [];
  const create = (
    location = disabledToolLocation,
    embed = { authorize: async () => false },
    clipboard = {
      set: async (url: string) => {
        copies.push(url);
      },
    },
  ) =>
    new ToolEntryController(
      route,
      kind,
      sessions,
      remote,
      scope,
      clock,
      clipboard,
      (v) => {
        view = v;
      },
      () => {
        imageClears++;
      },
      location,
      embed,
    );
  return {
    sessions,
    scope,
    clock,
    remote,
    create,
    copies,
    view: () => view,
    imageClears: () => imageClears,
  };
}
test('map browses without permission; marker IDs, reset and cancelled/late local location are fenced', async () => {
  const f = controller(),
    pending = deferred<ToolLocationResult>();
  let calls = 0;
  const c = f.create({
    enabled: true,
    locate: () => {
      calls++;
      return pending.promise;
    },
  });
  await c.load();
  assert.equal(calls, 0);
  assert.equal(f.view().located, false);
  c.marker(999);
  assert.equal(f.view().marker, null);
  c.marker(6);
  assert.equal(f.view().marker?.id, 6);
  const running = c.locate();
  await flush();
  void c.locate();
  assert.equal(calls, 1);
  c.reset();
  pending.resolve({
    state: 'ready',
    coordinateSystem: 'gcj02',
    position: { latitude: 41, longitude: 117 },
  });
  await running;
  assert.deepEqual(f.view().center, { latitude: 40, longitude: 116 });
  assert.equal(f.view().located, false);
  c.dispose();
  assert.equal(f.view().entry, null);
  assert.ok(f.imageClears() >= 2);
});
test('location outcomes do not block map browsing; session and campus switches clear local position', async () => {
  for (const state of ['denied', 'cancelled', 'unavailable'] as const) {
    const f = controller(),
      c = f.create({ enabled: true, locate: async () => ({ state }) });
    await c.load();
    await c.locate();
    assert.equal(f.view().entry?.kind, 'map');
    assert.equal(f.view().located, false);
    c.dispose();
  }
  const f = controller(),
    c = f.create({
      enabled: true,
      locate: async () => ({
        state: 'ready',
        coordinateSystem: 'gcj02',
        position: { latitude: 41, longitude: 117 },
      }),
    });
  await c.load();
  await c.locate();
  assert.equal(f.view().located, true);
  f.scope.select('99999999-9999-4999-8999-999999999999');
  assert.equal(f.view().center, null);
  c.dispose();
  const native = nativeToolLocation({
    getLocation(options) {
      options.fail({ errMsg: 'getLocation:fail auth deny' });
    },
  });
  assert.deepEqual(await native.locate(new Cancellation()), {
    state: 'denied',
  });
});
test('clipboard success waits for callback, double tap coalesces and stale callbacks do not update another session', async () => {
  const f = controller('research'),
    pending = deferred<void>();
  let calls = 0;
  const c = f.create(undefined, undefined, {
    set: () => {
      calls++;
      return pending.promise;
    },
  });
  await c.load();
  const action = c.copy();
  await flush();
  void c.copy();
  assert.equal(calls, 1);
  assert.notEqual(f.view().status, '已复制外部链接');
  assert.equal(f.view().externalHost, 'tools.example.com');
  f.sessions.completeLogin(f.sessions.beginLogin(), wireCredentials());
  pending.resolve();
  await action;
  assert.equal(f.view().entry, null);
  assert.notEqual(f.view().status, '已复制外部链接');
  c.dispose();
  const other = controller('research'),
    ok = other.create();
  await ok.load();
  await ok.copy();
  assert.equal(other.view().status, '已复制外部链接');
  ok.dispose();
  const failed = controller('research'),
    fail = failed.create(undefined, undefined, {
      set: async () => {
        throw new ClientError('network', 'synthetic');
      },
    });
  await fail.load();
  await fail.copy();
  assert.equal(failed.view().status, '');
  assert.match(failed.view().error, /复制失败/);
  fail.dispose();
});
test('webview stays empty until both accepted action and trusted injected platform port; stale events ignored', async () => {
  const f = controller('web-link'),
    disabled = f.create();
  await disabled.load();
  assert.equal(f.view().webviewSrc, '');
  assert.equal(f.view().state, 'webview_unconfigured');
  disabled.dispose();
  const enabled = f.create(undefined, { authorize: async () => true });
  await enabled.load();
  const first = f.view();
  assert.equal(first.webviewSrc, 'https://tools.example.com/controlled');
  await enabled.load();
  enabled.webviewFailed(first.webviewSrc, first.webviewViewId);
  assert.ok(f.view().webviewSrc);
  enabled.webviewFailed(f.view().webviewSrc, f.view().webviewViewId);
  assert.equal(f.view().webviewSrc, '');
  enabled.dispose();
});
test('refresh failure removes prior controls; visibility authority expires and late initial reads are ignored', async () => {
  const f = controller(),
    c = f.create();
  await c.load();
  f.remote.detail = async () => {
    throw new ClientError('network', 'synthetic');
  };
  await c.load();
  assert.equal(f.view().entry, null);
  c.dispose();
  const later = controller(),
    slow = deferred<ReturnType<typeof detail>>();
  later.remote.detail = () => slow.promise;
  const page = later.create(),
    pending = page.load();
  page.dispose();
  slow.resolve(detail());
  await pending;
  assert.equal(later.view().entry, null);
  const timed = controller(),
    expired = timed.create();
  await expired.load();
  timed.clock.advance(30000);
  assert.equal(timed.view().entry, null);
  assert.equal(timed.view().state, 'expired');
  expired.dispose();
});
test('hub has guest selection state, scoped ready controls and separate known-empty/unknown states', async () => {
  const sessions = new SessionStore(),
    scope = new ToolBrowseScope(),
    remote = gateway(),
    clock = new FakeClock();
  let view = initialToolHubView();
  const profile = {
    profile: async () => {
      throw new Error('Guest must not need profile');
    },
    campuses: async () => ({ items: [], page: 1, pageSize: 20, total: 0 }),
  } as unknown as ProfileGateway;
  const c = new ToolHubController(
    sessions,
    remote,
    profile,
    scope,
    clock,
    (v) => {
      view = v;
    },
  );
  await c.load();
  assert.equal(view.needsCampus, true);
  await c.load(campusId);
  assert.ok(c.route(entryId));
  remote.hub = async () => ({
    state: 'unknown',
    campusId,
    reason: 'NO_ACCEPTED_HEAD',
  });
  await c.refresh();
  assert.equal(view.state, 'unknown');
  assert.equal(c.route(entryId), null);
  const ready = hub();
  assert.ok('entries' in ready);
  remote.hub = async () =>
    ({ ...ready, state: 'known_empty', entries: [] }) as ToolHub;
  await c.refresh();
  assert.equal(view.state, 'known_empty');
  c.dispose();
});
test('guest media reauthorizes detail/descriptor for every selection and releases all late/failed temporary files', async () => {
  const sessions = new SessionStore(),
    principals = new OptionalMediaPrincipalOwner(sessions),
    scope = new ToolBrowseScope(),
    clock = new FakeClock(),
    remote = gateway(entry('research'));
  const descriptor: ToolMediaDescriptor = {
    protocol: 'campus-tools-media-v1',
    kind: 'campus-tool',
    ...route,
    entryRevision: revision,
    ...slot,
    width: 20,
    height: 20,
    variants: ['thumb-v1', 'display-v1'],
  };
  delete (descriptor as unknown as Record<string, unknown>).id;
  delete (descriptor as unknown as Record<string, unknown>).alt;
  assert.deepEqual(decodeToolMedia(descriptor), descriptor);
  assert.throws(() =>
    decodeToolMedia({ ...descriptor, url: 'https://external.example/image' }),
  );
  const releases: string[] = [];
  let reads = 0,
    downloads = 0;
  let view = initialToolImageView();
  const reader = new ToolImageReader(
    principals,
    remote,
    {
      descriptor: async () => {
        reads++;
        return descriptor;
      },
    },
    {
      download: async () => ({ localId: String(++downloads) }),
      resolve: async (file) => `wxfile://tmp/${file.localId}.png`,
      release: async (file) => {
        releases.push(file.localId);
      },
    },
    scope,
    clock,
    (v) => {
      view = v;
    },
  );
  const context = { route, digest, entry: entry('research') };
  await reader.open(context, 0);
  const first = view;
  assert.equal(view.status, 'ready');
  assert.equal(reads, 1);
  await reader.open(context, 0);
  reader.imageFailed(first.src, first.viewId);
  assert.equal(view.status, 'ready');
  assert.equal(reads, 2);
  assert.deepEqual(releases, ['1']);
  reader.imageFailed(view.src, view.viewId);
  assert.equal(view.status, 'unavailable');
  await reader.retry();
  assert.equal(reads, 3);
  remote.detail = async () => ({
    ...detail(entry('research')),
    digest: 'c'.repeat(64),
  });
  await reader.retry();
  assert.equal(view.src, '');
  assert.equal(view.status, 'unavailable');
  assert.equal(reads, 3);
  reader.dispose();
  principals.dispose();
  await flush();
  assert.deepEqual(releases, ['1', '2', '3']);
});

test('source replacement after image bytes but before display denies src and revokes the owning view', async () => {
  const sessions = new SessionStore(),
    principals = new OptionalMediaPrincipalOwner(sessions),
    scope = new ToolBrowseScope(),
    clock = new FakeClock(),
    remote = gateway(entry('research'));
  let detailReads = 0,
    invalidations = 0,
    view = initialToolImageView();
  remote.detail = async () => {
    detailReads++;
    return {
      ...detail(entry('research')),
      digest: detailReads > 1 ? 'c'.repeat(64) : digest,
    };
  };
  const descriptor: ToolMediaDescriptor = {
    protocol: 'campus-tools-media-v1',
    kind: 'campus-tool',
    ...route,
    entryRevision: revision,
    bindingId: slot.bindingId,
    assetId: slot.assetId,
    manifestDigest: slot.manifestDigest,
    width: 20,
    height: 20,
    variants: ['thumb-v1', 'display-v1'],
  };
  const released: string[] = [];
  const reader = new ToolImageReader(
    principals,
    remote,
    { descriptor: async () => descriptor },
    {
      download: async () => ({ localId: 'late' }),
      resolve: async () => 'wxfile://tmp/late.png',
      release: async (file) => {
        released.push(file.localId);
      },
    },
    scope,
    clock,
    (v) => {
      view = v;
    },
    () => {
      invalidations++;
    },
  );
  await reader.open({ route, digest, entry: entry('research') }, 0);
  assert.equal(detailReads, 2);
  assert.equal(view.src, '');
  assert.equal(invalidations, 1);
  await flush();
  assert.deepEqual(released, ['late']);
  reader.dispose();
  principals.dispose();
});

test('native validity comparison preserves exact fractional seconds and rejects impossible calendar dates', () => {
  assert.ok(
    compareToolInstants('2026-10-14T00:00:00.000001Z', '2026-10-14T00:00:00Z') >
      0,
  );
  assert.equal(
    compareToolInstants(
      '2026-10-14T00:00:00.100Z',
      '2026-10-14T00:00:00.100000Z',
    ),
    0,
  );
  assert.throws(() =>
    compareToolInstants('2026-02-30T00:00:00Z', '2026-03-01T00:00:00Z'),
  );
  const value = detail();
  assert.equal(
    decodeToolDetail({
      ...value,
      provenance: {
        ...value.provenance,
        validity: {
          kind: 'finite',
          effectiveAt: '2026-10-14T00:00:00Z',
          expiresAt: '2026-10-14T00:00:00.000001Z',
        },
      },
    }).state,
    'ready',
  );
});
test('a throwing injected location adapter leaves current map and marker browsing usable', async () => {
  const f = controller(),
    c = f.create({
      enabled: true,
      locate: async () => {
        throw new Error('Synthetic device failure');
      },
    });
  await c.load();
  await c.locate();
  assert.equal(f.view().entry?.kind, 'map');
  assert.equal(f.view().locating, false);
  c.marker(6);
  assert.equal(f.view().marker?.id, 6);
  c.dispose();
});

test('tools-only recovery latch survives refresh credential loss/restart, never clears signed restrictions and needs explicit guest action', async () => {
  const sessions = new SessionStore(),
    storage = new MemoryStorage(),
    clock = new FakeClock();
  const gate = new ToolAuthRecovery(
    sessions,
    storage,
    'https://tools.example.com',
  );
  gate.assertAllowed();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  assert.equal(gate.continueGuest(), false);
  assert.ok(sessions.snapshot().credentials);
  const auth = new AuthService(
    sessions,
    {
      login: async () => wireCredentials(),
      logout: async () => undefined,
      refresh: async () => {
        throw new ClientError('auth-required', 'Synthetic revoked refresh');
      },
    },
    { login: async () => 'synthetic' },
    clock,
  );
  await assert.rejects(auth.refresh(sessions.snapshot()));
  assert.equal(sessions.snapshot().credentials, null);
  assert.equal(gate.needsRecovery(), true);
  assert.throws(() => gate.assertAllowed());
  const restarted = new ToolAuthRecovery(
    new SessionStore(),
    storage,
    'https://tools.example.com',
  );
  assert.equal(restarted.needsRecovery(), true);
  assert.equal(restarted.continueGuest(), true);
  restarted.assertAllowed();
  restarted.dispose();
  gate.dispose();
  const corrupt = new ToolAuthRecovery(
    sessions,
    storage,
    'https://tools.example.com',
    true,
  );
  assert.throws(() => corrupt.assertAllowed());
  storage.failRemove = true;
  assert.equal(corrupt.continueGuest(), false);
  assert.equal(corrupt.needsRecovery(), true);
  storage.failRemove = false;
  sessions.completeLogin(sessions.beginLogin(), wireCredentials('b'));
  assert.equal(corrupt.needsRecovery(), false);
  corrupt.dispose();
});

test('delayed synthetic embed attestation cannot activate a catalog link withdrawn during its wait', async () => {
  const f = controller('web-link'),
    attestation = deferred<boolean>(),
    c = f.create(undefined, { authorize: () => attestation.promise });
  const loading = c.load();
  await flush();
  assert.equal(f.view().webviewSrc, '');
  f.remote.link = async () => ({
    state: 'unavailable',
    campusId,
    reason: 'CATALOG_WITHDRAWN',
  });
  attestation.resolve(true);
  await loading;
  assert.equal(f.view().webviewSrc, '');
  assert.equal(f.view().state, 'unavailable');
  c.dispose();
});

test('image lifecycle identity prevents hide/show ABA when the device reuses a temporary path', async () => {
  const sessions = new SessionStore(),
    principals = new OptionalMediaPrincipalOwner(sessions),
    scope = new ToolBrowseScope(),
    clock = new FakeClock(),
    remote = gateway(entry('research'));
  const descriptor: ToolMediaDescriptor = {
    protocol: 'campus-tools-media-v1',
    kind: 'campus-tool',
    ...route,
    entryRevision: revision,
    bindingId: slot.bindingId,
    assetId: slot.assetId,
    manifestDigest: slot.manifestDigest,
    width: 20,
    height: 20,
    variants: ['thumb-v1', 'display-v1'],
  };
  let view = initialToolImageView(),
    released = 0;
  const make = () =>
    new ToolImageReader(
      principals,
      remote,
      { descriptor: async () => descriptor },
      {
        download: async () => ({ localId: 'same-path' }),
        resolve: async () => 'wxfile://tmp/reused.png',
        release: async () => {
          released++;
        },
      },
      scope,
      clock,
      (next) => {
        view = next;
      },
    );
  const first = make();
  await first.open({ route, digest, entry: entry('research') }, 0);
  const old = view;
  first.dispose();
  await flush();
  const second = make();
  await second.open({ route, digest, entry: entry('research') }, 0);
  assert.equal(view.src, old.src);
  assert.notEqual(view.viewId, old.viewId);
  second.imageFailed(old.src, old.viewId);
  assert.equal(view.status, 'ready');
  assert.equal(released, 1);
  second.imageFailed(view.src, view.viewId);
  assert.equal(view.status, 'unavailable');
  second.dispose();
  principals.dispose();
  await flush();
  assert.equal(released, 2);
});

test('shared campus-tools semantic URL corpus matches the server action contract', () => {
  const corpus = JSON.parse(
    readFileSync(
      path.resolve(
        __dirname,
        '../../../packages/fixtures/campus-tools-links-v1.json',
      ),
      'utf8',
    ),
  ) as {
    policy: unknown;
    accepted: { url: string; action: 'copy' | 'webview' }[];
    rejected: { url: string; action: 'copy' | 'webview' }[];
  };
  const policy = decodeToolPolicy(corpus.policy);
  for (const item of corpus.accepted)
    assert.equal(canonicalToolLink(item.url, item.action, policy), item.url);
  for (const item of corpus.rejected)
    assert.throws(
      () => canonicalToolLink(item.url, item.action, policy),
      item.url,
    );
});

test('collapsing a shuttle group revokes its preview and fences stale image callbacks and download completion', async () => {
  const sessions = new SessionStore(),
    principals = new OptionalMediaPrincipalOwner(sessions),
    scope = new ToolBrowseScope(),
    clock = new FakeClock(),
    remote = gateway(entry('shuttle'));
  const descriptor: ToolMediaDescriptor = {
    protocol: 'campus-tools-media-v1',
    kind: 'campus-tool',
    ...route,
    entryRevision: revision,
    bindingId: slot.bindingId,
    assetId: slot.assetId,
    manifestDigest: slot.manifestDigest,
    width: 20,
    height: 20,
    variants: ['thumb-v1', 'display-v1'],
  };
  let image = initialToolImageView(),
    view = initialToolEntryView(),
    sequence = 0;
  let download = async () => ({ localId: String(++sequence) });
  const releases: string[] = [];
  const reader = new ToolImageReader(
    principals,
    remote,
    { descriptor: async () => descriptor },
    {
      download: () => download(),
      resolve: async () => 'wxfile://tmp/reused-shuttle.png',
      release: async (file) => {
        releases.push(file.localId);
      },
    },
    scope,
    clock,
    (next) => {
      image = next;
    },
  );
  const controller = new ToolEntryController(
    route,
    'shuttle',
    sessions,
    remote,
    scope,
    clock,
    { set: async () => undefined },
    (next) => {
      view = next;
    },
    () => reader.clear(),
  );
  await controller.load();
  controller.toggleGroup('shuttle');
  const context = controller.mediaContext();
  assert.ok(context);
  await reader.open(context, 0);
  const old = image;
  assert.equal(image.status, 'ready');
  controller.toggleGroup('shuttle');
  assert.equal(view.expandedGroups.shuttle, false);
  assert.equal(image.expanded, false);
  assert.equal(image.src, '');
  await flush();
  assert.deepEqual(releases, ['1']);

  controller.toggleGroup('shuttle');
  await reader.open(context, 0);
  assert.equal(image.src, old.src);
  assert.notEqual(image.viewId, old.viewId);
  reader.imageFailed(old.src, old.viewId);
  assert.equal(image.status, 'ready');
  controller.toggleGroup('shuttle');
  await flush();
  assert.deepEqual(releases, ['1', '2']);

  const pending = deferred<{ localId: string }>();
  download = () => pending.promise;
  controller.toggleGroup('shuttle');
  const loading = reader.open(context, 0);
  await flush();
  assert.equal(image.status, 'loading');
  controller.toggleGroup('shuttle');
  pending.resolve({ localId: 'late' });
  await loading;
  await flush();
  assert.equal(image.src, '');
  assert.equal(image.expanded, false);
  assert.deepEqual(releases, ['1', '2', 'late']);
  controller.dispose();
  reader.dispose();
  principals.dispose();
});
