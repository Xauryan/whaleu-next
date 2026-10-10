import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaLocalFiles } from '../src/media/local-files';
import { isNativeTemporaryPath } from '../src/platform/wechat-media';
import { credentials, deferred, flush, signedIn } from './helpers';
import { ReadFiles, failure } from './support/media-read-fixtures';

function fixture() {
  const files = new ReadFiles();
  const registry = new MediaLocalFiles(files);
  const sessions = signedIn('reader');
  const owner = {};
  const path = 'wxfile://tmp/local-owned.png';
  files.put(path);
  const handle = registry.adopt(path, 100, owner, sessions.snapshot());
  return { files, registry, sessions, owner, path, handle };
}

test('capability is identity-bound, owner-bound, account-bound, and epoch-bound', async () => {
  const h = fixture();
  const ticket = h.sessions.snapshot();
  assert.equal(await h.registry.resolve(h.handle, h.owner, ticket), h.path);
  await assert.rejects(
    h.registry.resolve({ ...h.handle }, h.owner, ticket),
    failure('stale-session'),
  );
  await assert.rejects(
    h.registry.resolve(JSON.parse(JSON.stringify(h.handle)), h.owner, ticket),
    failure('stale-session'),
  );
  await assert.rejects(
    h.registry.resolve(h.handle, {}, ticket),
    failure('stale-session'),
  );
  h.sessions.rotate(ticket, credentials('reader', 'refreshed'));
  assert.equal(
    await h.registry.resolve(h.handle, h.owner, h.sessions.snapshot()),
    h.path,
  );
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('reader', 'relogin'),
  );
  await assert.rejects(
    h.registry.resolve(h.handle, h.owner, h.sessions.snapshot()),
    failure('stale-session'),
  );
  const anotherBoot = new MediaLocalFiles(h.files);
  await assert.rejects(
    anotherBoot.resolve(h.handle, h.owner, ticket),
    failure('stale-session'),
  );
  assert.deepEqual(h.files.deleted, []);
});

test('revocation precedes unlink and resolving a revoked handle never reclaims authority', async () => {
  const h = fixture();
  const unlink = deferred<void>();
  h.files.unlink = () => unlink.promise;
  const released = h.registry.release(h.handle);
  await assert.rejects(
    h.registry.resolve(h.handle, h.owner, h.sessions.snapshot()),
    failure('stale-session'),
  );
  unlink.resolve();
  await released;
  await h.registry.release(h.handle);
  assert.equal(h.registry.capacityAvailable, true);
});

test('release during a pending stat cannot return a now-revoked path', async () => {
  const h = fixture();
  const stat = deferred<number>();
  h.files.stat = () => stat.promise;
  const rejected = assert.rejects(
    h.registry.resolve(h.handle, h.owner, h.sessions.snapshot()),
    failure('storage'),
  );
  await h.registry.release(h.handle);
  stat.resolve(100);
  await rejected;
});

test('failed cleanup stays revoked, consumes capacity, and succeeds only after an explicit retry', async () => {
  const h = fixture();
  h.files.failUnlink = true;
  await h.registry.release(h.handle);
  await assert.rejects(
    h.registry.resolve(h.handle, h.owner, h.sessions.snapshot()),
    failure('stale-session'),
  );
  for (let i = 0; i < 3; i++) {
    const path = `wxfile://tmp/failed-${i}.png`;
    h.files.put(path);
    const handle = h.registry.adopt(path, 100, h.owner, h.sessions.snapshot());
    await h.registry.release(handle);
  }
  assert.equal(h.registry.capacityAvailable, false);
  assert.throws(
    () =>
      h.registry.adopt(
        'wxfile://tmp/fifth.png',
        100,
        h.owner,
        h.sessions.snapshot(),
      ),
    failure('storage'),
  );
  h.files.failUnlink = false;
  await h.registry.retryCleanup();
  assert.equal(h.registry.capacityAvailable, true);
  assert.equal(h.files.values.size, 0);
});

test('parallel discard shares one unlink and cannot delete an active lease', async () => {
  const h = fixture();
  await h.registry.discard(h.path);
  assert.deepEqual(h.files.deleted, []);
  const pending = deferred<void>();
  let deletions = 0;
  h.files.unlink = async () => {
    deletions++;
    await pending.promise;
  };
  const path = 'wxfile://tmp/unadopted.png';
  const first = h.registry.discard(path);
  assert.equal(h.registry.discard(path), first);
  pending.resolve();
  await first;
  assert.equal(deletions, 1);
});

test('four file and ten MiB budgets apply before adoption; duplicate paths are refused', async () => {
  const h = fixture();
  assert.throws(
    () => h.registry.adopt(h.path, 100, {}, h.sessions.snapshot()),
    failure('storage'),
  );
  for (let i = 0; i < 3; i++)
    h.registry.adopt(`wxfile://tmp/item-${i}`, 1, {}, h.sessions.snapshot());
  assert.equal(h.registry.capacityAvailable, false);
  assert.throws(
    () => h.registry.adopt('wxfile://tmp/fifth', 1, {}, h.sessions.snapshot()),
    failure('storage'),
  );
  const registry = new MediaLocalFiles(h.files);
  registry.adopt(
    'wxfile://tmp/large-one',
    5 * 1024 * 1024,
    {},
    h.sessions.snapshot(),
  );
  registry.adopt(
    'wxfile://tmp/large-two',
    5 * 1024 * 1024,
    {},
    h.sessions.snapshot(),
  );
  assert.throws(
    () => registry.adopt('wxfile://tmp/extra', 1, {}, h.sessions.snapshot()),
    failure('storage'),
  );
});

for (const path of [
  'https://cdn.invalid/image.png',
  'http://other.invalid/image.png',
  '/tmp/private',
  'wxfile://usr/saved.png',
  'wxfile://tmp/../private',
  'wxfile://tmp/%2e%2e/private',
  'wxfile://tmp/a?token=secret',
  'wxfile://tmp/a#fragment',
  'wxfile://tmp/a\\b',
  'wxfile://tmp/',
  'wxfile://tmp_' + 'x'.repeat(1024),
]) {
  test(`non-temporary or traversing path is never adopted or unlinked: ${path.slice(0, 60)}`, async () => {
    const h = fixture();
    assert.equal(isNativeTemporaryPath(path), false);
    assert.throws(
      () => h.registry.adopt(path, 1, h.owner, h.sessions.snapshot()),
      failure('storage'),
    );
    await h.registry.discard(path);
    assert.deepEqual(h.files.deleted, []);
  });
}

test('changed or missing bytes invalidate resolving but never substitute another file', async () => {
  const h = fixture();
  h.files.values.get(h.path)!.size++;
  await assert.rejects(
    h.registry.resolve(h.handle, h.owner, h.sessions.snapshot()),
    failure('storage'),
  );
  h.files.values.delete(h.path);
  await assert.rejects(
    h.registry.resolve(h.handle, h.owner, h.sessions.snapshot()),
    failure('storage'),
  );
  await h.registry.release(h.handle);
  await flush();
});
