import { ClientError } from '../src/api/errors';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MediaGalleryController,
  type GalleryView,
} from '../src/media/gallery-controller';
import type { MediaReadTransfer } from '../src/media/authenticated-download';
import type { LocalMediaFile } from '../src/media/contracts';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { credentials, deferred, flush, signedIn } from './helpers';
import { attachment } from './support/media-read-fixtures';
import { ids, uuid } from './support/media-batch-fixtures';
function gallery() {
  const sessions = signedIn(ids.actor),
    views: GalleryView[] = [],
    calls: string[] = [],
    files = new Set<LocalMediaFile>(),
    privateViews = new PrivateViewLifecycle();
  let sequence = 0;
  const transfer: MediaReadTransfer = {
    async download(item, variant, _owner, session) {
      session.current();
      calls.push(`${variant}:${item.assetId}`);
      const file = { localId: String(++sequence) };
      files.add(file);
      return file;
    },
    async resolve(file) {
      return `wxfile://tmp/${file.localId}.png`;
    },
    async release(file) {
      calls.push(`release:${file.localId}`);
      files.delete(file);
    },
  };
  const controller = new MediaGalleryController(
    sessions,
    transfer,
    (view) => views.push(view),
    privateViews,
  );
  const descriptors = Array.from({ length: 9 }, (_, n) => ({
    ...attachment,
    assetId: uuid(400 + n),
    bindingId: uuid(700 + n),
  }));
  return {
    sessions,
    views,
    calls,
    files,
    privateViews,
    transfer,
    controller,
    descriptors,
  };
}
test('gallery displays three thumb variants, releases them before one freshly authorized display, then reloads thumbs', async () => {
  const h = gallery();
  await h.controller.load(h.descriptors);
  assert.equal(h.files.size, 3);
  assert.equal(
    h.calls.filter((call) => call.startsWith('thumb-v1:')).length,
    3,
  );
  await h.controller.open(4);
  assert.equal(h.files.size, 1);
  assert.equal(h.controller.snapshot().expanded, true);
  const display = h.calls.findIndex((call) => call.startsWith('display-v1:'));
  assert.equal(
    h.calls.slice(0, display).filter((call) => call.startsWith('release:'))
      .length,
    3,
  );
  await h.controller.open(5);
  assert.equal(
    h.calls.filter((call) => call.startsWith('display-v1:')).length,
    2,
  );
  await h.controller.close();
  assert.deepEqual(
    h.controller.snapshot().slots.map((slot) => slot.index),
    [3, 4, 5],
  );
  assert.equal(h.files.size, 3);
  h.controller.dispose();
  await flush();
  assert.equal(h.files.size, 0);
});
test('rapid gallery switch clears visible source synchronously and deletes ignored-cancellation late file', async () => {
  const h = gallery();
  await h.controller.load(h.descriptors);
  const late = deferred<LocalMediaFile>(),
    original = h.transfer.download;
  h.transfer.download = async () => late.promise;
  const opening = h.controller.open(4);
  await flush();
  h.transfer.download = original;
  await h.controller.open(5);
  late.resolve({ localId: 'late' });
  await opening;
  assert.equal(h.calls.includes('release:late'), true);
  assert.equal(h.controller.snapshot().selected, 5);
  assert.equal(
    h.controller
      .snapshot()
      .slots.some((slot) => slot.localSrc.includes('late')),
    false,
  );
  h.controller.dispose();
});
test('account epoch and private parent revocation clear all sources and release capabilities', async () => {
  const h = gallery();
  await h.controller.load(h.descriptors);
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials(ids.actor, 'replacement'),
  );
  assert.equal(h.controller.snapshot().slots.length, 0);
  await flush();
  assert.equal(h.files.size, 0);
  await h.controller.load(h.descriptors);
  h.privateViews.clear(ids.actor);
  assert.equal(h.controller.snapshot().slots.length, 0);
  await flush();
  assert.equal(h.files.size, 0);
  h.controller.dispose();
});
test('malformed/duplicate full gallery is unavailable without partial download or public preview', async () => {
  const h = gallery();
  await h.controller.load([h.descriptors[0]!, h.descriptors[0]!]);
  assert.equal(h.controller.snapshot().status, 'unavailable');
  assert.equal(h.calls.length, 0);
  await h.controller.load(h.descriptors.slice(0, 1));
  assert.equal(h.calls.length, 0);
  h.controller.dispose();
});

test('one local failure preserves other thumb sources and manual retry obtains fresh authorization', async () => {
  const h = gallery(),
    download = h.transfer.download;
  let fail = true;
  h.transfer.download = async (...args) => {
    if (fail && args[0].assetId === h.descriptors[1]!.assetId)
      throw new ClientError('network', 'Single image failed');
    return download(...args);
  };
  await h.controller.load(h.descriptors);
  assert.deepEqual(
    h.controller.snapshot().slots.map((slot) => slot.status),
    ['ready', 'unavailable', 'ready'],
  );
  const first = h.controller.snapshot().slots[0]!.localSrc;
  fail = false;
  await h.controller.retry(1);
  assert.equal(h.controller.snapshot().slots[0]!.localSrc, first);
  assert.equal(h.controller.snapshot().slots[1]!.status, 'ready');
  h.controller.dispose();
});
test('identical in-flight expanded tap coalesces while permission denial revokes every slot', async () => {
  const h = gallery();
  await h.controller.load(h.descriptors);
  const late = deferred<LocalMediaFile>();
  h.transfer.download = async () => late.promise;
  const one = h.controller.open(4),
    two = h.controller.open(4);
  assert.equal(one, two);
  late.reject(
    new ClientError('forbidden', 'Parent denied', {
      serverCode: 'POST_NOT_FOUND',
    }),
  );
  await one;
  assert.equal(h.controller.snapshot().slots.length, 0);
  assert.equal(h.controller.snapshot().total, 0);
  h.controller.dispose();
});

test('stale image error cannot revoke a new generation that reused the same native path', async () => {
  const h = gallery();
  h.transfer.resolve = async () => 'wxfile://tmp/reused.png';
  await h.controller.load(h.descriptors);
  const stale = h.controller.snapshot().slots[0]!;
  await h.controller.open(0);
  const current = h.controller.snapshot().slots[0]!;
  assert.equal(stale.localSrc, current.localSrc);
  assert.notEqual(stale.viewId, current.viewId);
  h.controller.imageFailed(0, stale.localSrc, stale.viewId);
  assert.equal(h.controller.snapshot().slots[0]!.status, 'ready');
  h.controller.imageFailed(0, current.localSrc, current.viewId);
  assert.equal(h.controller.snapshot().slots[0]!.status, 'unavailable');
  h.controller.dispose();
});
