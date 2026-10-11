import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaLocalFiles } from '../src/media/local-files';
import { CategoryIconUploadWindow } from '../src/ratings/category-icon-window';
import type { CategoryIconMediaStatus } from '../src/ratings/category-icon-media-contract';
type CategoryIconReady = Extract<
  CategoryIconMediaStatus,
  { status: 'ready_unbound' }
>;
import { deferred, flush, signedIn } from './helpers';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function harness(manual = false) {
  const sessions = signedIn(id(1)),
    resident = new Map<string, number>(),
    owner = {};
  let sequence = 0,
    stored = 0,
    maximumResident = 0;
  const registry = new MediaLocalFiles({
    stat: async (path) => resident.get(path) ?? 0,
    image: async () => ({ width: 2, height: 2, type: 'png' }),
    readError: async () => null,
    unlink: async (path) => {
      resident.delete(path);
    },
  });
  const completion = deferred<void>(),
    response = deferred<CategoryIconReady>();
  const transfer = {
    localFiles: registry,
    async pick(session: {
      current: () => ReturnType<typeof sessions.snapshot>;
    }) {
      const reservation = registry.reserve();
      const path = `wxfile://tmp/discussion-${++sequence}.png`;
      resident.set(path, 5 * 1024 * 1024);
      maximumResident = Math.max(maximumResident, resident.size);
      return registry.adopt(
        path,
        5 * 1024 * 1024,
        owner,
        session.current(),
        reservation,
      );
    },
    inspect: async () => ({
      mime: 'image/png' as const,
      bytes: 5 * 1024 * 1024,
      sha256: 'a'.repeat(64),
    }),
    remove: (file: Parameters<MediaLocalFiles['release']>[0]) =>
      registry.release(file),
  };
  const member = (): CategoryIconReady => ({
    protocol: 'ratings-category-icon-media-v1',
    editScopeId: id(100 + sequence),
    intentId: id(200 + sequence),
    requestId: id(300 + sequence),
    requestHash: 'b'.repeat(64),
    serverNow: 1000,
    status: 'ready_unbound',
    assetId: id(400 + sequence),
    readyRetentionUntil: 2000,
    editExpiresAt: 2000,
    bindBefore: 2000,
    mediaProof: 'current',
  });
  const window = new CategoryIconUploadWindow(
    sessions,
    registry,
    transfer,
    {
      async start() {
        const release = registry.acquireTransfer(id(1));
        const complete = manual ? completion.promise : Promise.resolve();
        void complete.then(release, () => undefined);
        return {
          result: manual ? response.promise : Promise.resolve(member()),
          complete,
        };
      },
      ready() {
        stored++;
      },
    },
    () => undefined,
  );
  return {
    window,
    registry,
    resident,
    sessions,
    completion,
    response,
    member,
    stored: () => stored,
    maximumResident: () => maximumResident,
  };
}
test('thirty-two 5 MiB node icons are selected and uploaded sequentially without pinning thirty-two leases', async () => {
  const h = harness();
  for (let count = 0; count < 32; count++) {
    await h.window.append(count);
    assert.equal(h.resident.size, 0);
  }
  assert.equal(h.stored(), 32);
  assert.equal(h.maximumResident(), 1);
  await assert.rejects(() => h.window.append(32));
  await assert.rejects(() => h.window.append(33));
  h.window.dispose();
});
test('upload response does not free the native completion credit', async () => {
  const h = harness(true),
    pending = h.window.append(0);
  await flush();
  h.response.resolve(h.member());
  await flush();
  assert.equal(h.resident.size, 1);
  assert.equal(h.stored(), 0);
  await assert.rejects(() => h.window.append(1));
  h.completion.resolve();
  await pending;
  assert.equal(h.resident.size, 0);
  assert.equal(h.stored(), 1);
  h.window.dispose();
});
test('A to B to A cannot persist a late member and hiding never fabricates complete', async () => {
  const h = harness(true),
    pending = h.window.append(0);
  const failure = assert.rejects(pending);
  await flush();
  h.sessions.logout();
  h.sessions.completeLogin(h.sessions.beginLogin(), {
    accountId: id(1),
    sessionId: 'new-session',
    expiresAt: 900000,
    refreshExpiresAt: 1800000,
    accessToken: 'synthetic-new-access',
    refreshToken: 'synthetic-new-refresh',
  });
  h.response.resolve(h.member());
  await flush();
  assert.equal(h.resident.size, 1);
  assert.equal(h.stored(), 0);
  h.completion.resolve();
  await failure;
  assert.equal(h.resident.size, 0);
  assert.equal(h.stored(), 0);
  h.window.dispose();
});
test('unknown complete retains the lease and blocks another selection', async () => {
  const h = harness(true),
    pending = h.window.append(0);
  const failure = assert.rejects(pending);
  await flush();
  h.response.resolve(h.member());
  h.completion.reject(new Error('synthetic unknown native completion'));
  await failure;
  assert.equal(h.resident.size, 1);
  assert.equal(h.stored(), 0);
  await assert.rejects(() => h.window.append(0));
  h.window.dispose();
});

test('Category admission respects other owners global native IO and byte credits', async () => {
  const h = harness();
  const a = h.registry.acquireTransfer(),
    b = h.registry.acquireTransfer();
  await assert.rejects(() => h.window.append(0));
  assert.equal(h.resident.size, 0);
  a();
  b();
  await h.window.append(0);
  assert.equal(h.maximumResident(), 1);
  h.window.dispose();
});
