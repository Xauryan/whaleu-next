import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaLocalFiles } from '../src/media/local-files';
import { RatingDiscussionUploadWindow } from '../src/ratings/discussion-media-window';
import type { RatingDiscussionMember } from '../src/ratings/discussion-media-batch-contract';
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
    response = deferred<RatingDiscussionMember>();
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
  const member = (): RatingDiscussionMember => ({
    memberId: id(100 + sequence),
    clientRequestId: id(200 + sequence),
    sourceSlot: sequence - 1,
    declaration: {
      mime: 'image/png',
      bytes: 5 * 1024 * 1024,
      sha256: 'a'.repeat(64),
    },
    requestHash: 'b'.repeat(64),
    state: 'ready',
    assetId: id(300 + sequence),
    manifestDigest: 'c'.repeat(64),
  });
  const window = new RatingDiscussionUploadWindow(
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
test('nine 5 MiB images are selected and uploaded sequentially without nine leases', async () => {
  const h = harness();
  for (let count = 0; count < 9; count++) {
    await h.window.append('root', count);
    assert.equal(h.resident.size, 0);
  }
  assert.equal(h.stored(), 9);
  assert.equal(h.maximumResident(), 1);
  await assert.rejects(() => h.window.append('root', 9));
  await assert.rejects(() => h.window.append('reply', 3));
  h.window.dispose();
});
test('upload response does not free the native completion credit', async () => {
  const h = harness(true),
    pending = h.window.append('root', 0);
  await flush();
  h.response.resolve(h.member());
  await flush();
  assert.equal(h.resident.size, 1);
  assert.equal(h.stored(), 0);
  await assert.rejects(() => h.window.append('root', 1));
  h.completion.resolve();
  await pending;
  assert.equal(h.resident.size, 0);
  assert.equal(h.stored(), 1);
  h.window.dispose();
});
test('A to B to A cannot persist a late member and hiding never fabricates complete', async () => {
  const h = harness(true),
    pending = h.window.append('root', 0);
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
    pending = h.window.append('root', 0);
  const failure = assert.rejects(pending);
  await flush();
  h.response.resolve(h.member());
  h.completion.reject(new Error('synthetic unknown native completion'));
  await failure;
  assert.equal(h.resident.size, 1);
  assert.equal(h.stored(), 0);
  await assert.rejects(() => h.window.append('root', 0));
  h.window.dispose();
});
