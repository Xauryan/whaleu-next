import assert from 'node:assert/strict';
import test from 'node:test';
import { MediaLocalFiles } from '../src/media/local-files';
import { ReadFiles } from './support/media-read-fixtures';
import { signedIn } from './helpers';
test('shared native transfer budget is two across both directions and only one upload writer per actor', () => {
  const registry = new MediaLocalFiles(new ReadFiles());
  const upload = registry.acquireTransfer('actor');
  assert.throws(() => registry.acquireTransfer('actor'));
  const download = registry.acquireTransfer();
  assert.throws(() => registry.acquireTransfer());
  download();
  upload();
  upload();
  const next = registry.acquireTransfer('actor');
  next();
});
test('reservation is charged before bytes, holds through incomplete abort, and converts to one lease', async () => {
  const files = new ReadFiles(),
    registry = new MediaLocalFiles(files),
    sessions = signedIn('actor');
  const first = registry.reserve(),
    stopNative = registry.holdReservation(first),
    second = registry.reserve();
  assert.throws(() => registry.reserve());
  registry.releaseReservation(first);
  assert.throws(() => registry.reserve(1));
  registry.releaseReservation(second);
  const path = 'wxfile://tmp/reserved.png';
  files.put(path);
  const handle = registry.adopt(path, 100, {}, sessions.snapshot(), first);
  stopNative();
  assert.ok(registry.reserve());
  await registry.release(handle);
});
test('failed unlink retains revoked bytes and capacity; four leases/tombstones bound all handles', async () => {
  const files = new ReadFiles(),
    registry = new MediaLocalFiles(files),
    sessions = signedIn('actor');
  files.failUnlink = true;
  for (let n = 0; n < 4; n++) {
    const path = `wxfile://tmp/tombstone-${n}.png`;
    files.put(path);
    await registry.release(registry.adopt(path, 100, {}, sessions.snapshot()));
  }
  assert.equal(registry.capacityAvailable, false);
  assert.throws(() => registry.reserve(1));
  files.failUnlink = false;
  await registry.retryCleanup();
  assert.equal(registry.capacityAvailable, true);
});

test('observed writer release preserves native credits and cannot release a newer actor writer', () => {
  const registry = new MediaLocalFiles(new ReadFiles());
  const first = registry.acquireTransfer('actor');
  first.releaseWriter();
  const second = registry.acquireTransfer('actor');
  assert.throws(() => registry.acquireTransfer());
  first();
  assert.throws(() => registry.acquireTransfer('actor'));
  const read = registry.acquireTransfer();
  assert.throws(() => registry.acquireTransfer());
  read();
  second();
});
