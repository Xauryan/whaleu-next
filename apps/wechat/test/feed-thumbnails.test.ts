import assert from 'node:assert/strict';
import test from 'node:test';
import type { Post } from '../src/community/contract';
import {
  FeedThumbnails,
  type FeedThumbnail,
} from '../src/media/feed-thumbnails';
import { MediaGalleryController } from '../src/media/gallery-controller';
import type { MediaReadTransfer } from '../src/media/authenticated-download';
import type { LocalMediaFile } from '../src/media/contracts';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { credentials, deferred, flush, signedIn } from './helpers';
import { attachment } from './support/media-read-fixtures';
function harness() {
  const sessions = signedIn('media-reader');
  const lifecycle = new PrivateViewLifecycle();
  const observers = new Map<
    string,
    (result: { intersectionRatio: number }) => void
  >();
  const calls: Parameters<MediaReadTransfer['download']>[] = [];
  const released: string[] = [];
  const transfer: MediaReadTransfer = {
    async download(...args) {
      args[3].current();
      calls.push(args);
      return { localId: `image-${calls.length}` };
    },
    async resolve(file, _owner, ticket) {
      sessions.assertCurrent(ticket);
      return `wxfile://${file.localId}`;
    },
    async release(file) {
      released.push(file.localId);
    },
  };
  let views: Readonly<Record<string, FeedThumbnail>> = {};
  const controller = new FeedThumbnails(
    sessions,
    {
      create: () => {
        throw new Error('Feed must not load full display');
      },
      createGallery: (render) =>
        new MediaGalleryController(sessions, transfer, render, lifecycle),
    },
    {
      createIntersectionObserver: () => ({
        relativeToViewport() {
          return this;
        },
        observe(selector, callback) {
          observers.set(selector, callback);
        },
        disconnect() {},
      }),
    },
    {},
    (view) => {
      views = view;
    },
  );
  const posts = Array.from({ length: 5 }, (_, index) => ({
    id: `post-${index}`,
    images: [
      {
        ...attachment,
        assetId: `${index}1111111-1111-4111-8111-111111111111`,
        bindingId: `${index}2222222-2222-4222-8222-222222222222`,
      },
    ],
  })) as unknown as Post[];
  return {
    controller,
    sessions,
    lifecycle,
    transfer,
    calls,
    released,
    posts,
    observers,
    views: () => views,
    visible: (index: number, ratio = 1) =>
      observers.get(`#view-post-${index}`)?.({ intersectionRatio: ratio }),
  };
}
test('feed waits for committed native viewport, downloads only thumbs and caps resident readers at three', async () => {
  const h = harness();
  const commit = h.controller.render(h.posts, 'campus');
  assert.equal(h.observers.size, 0);
  assert.equal(h.calls.length, 0);
  commit();
  for (let i = 0; i < 5; i++) h.visible(i);
  // Each admitted reader awaits download, resolve and prior-reader settlement.
  for (let i = 0; i < 3; i++) await flush();
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every((call) => call[1] === 'thumb-v1'));
  assert.equal(Object.keys(h.views()).length, 3);
  h.visible(0, 0);
  await flush();
  assert.equal(h.calls.length, 4);
  assert.equal(h.views()['post-0'], undefined);
  assert.equal(h.released.length, 1);
  h.controller.dispose();
  await flush();
  assert.deepEqual(h.views(), {});
  assert.equal(h.released.length, 4);
});
test('source change and hide invalidate old callbacks and late local sources', async () => {
  const h = harness();
  const pending = deferred<LocalMediaFile>();
  h.transfer.download = (...args) => {
    h.calls.push(args);
    return pending.promise;
  };
  h.controller.render(h.posts, 'following')();
  h.visible(0);
  await flush();
  const callback = h.observers.get('#view-post-0')!;
  h.controller.render([], 'campus')();
  callback({ intersectionRatio: 1 });
  pending.resolve({ localId: 'stale' });
  await flush();
  assert.deepEqual(h.views(), {});
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.released, ['stale']);
  h.controller.dispose();
  callback({ intersectionRatio: 1 });
  assert.equal(h.calls.length, 1);
});
test('account replacement clears visible thumbnails and cannot reuse old observer authority', async () => {
  const h = harness();
  h.controller.render(h.posts, 'campus')();
  h.visible(0);
  await flush();
  assert.ok(h.views()['post-0']?.localSrc);
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('different-account'),
  );
  await flush();
  assert.deepEqual(h.views(), {});
  h.visible(1);
  await flush();
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
});
test('image failures are fenced by source and view identity; no runtime means no request', async () => {
  const h = harness();
  h.controller.render(h.posts, 'campus')();
  h.visible(0);
  await flush();
  const current = h.views()['post-0']!;
  h.controller.imageFailed('post-0', 'old-source', current.viewId);
  assert.equal(h.views()['post-0']?.localSrc, current.localSrc);
  h.controller.imageFailed('post-0', current.localSrc, current.viewId);
  await flush();
  assert.equal(h.views()['post-0']?.localSrc, '');
  h.controller.dispose();
  const absent = new FeedThumbnails(
    h.sessions,
    undefined,
    {},
    {},
    () => undefined,
  );
  absent.render(h.posts, 'campus')();
  absent.dispose();
});

test('private-view revocation clears sources; logged-out feed never downloads', async () => {
  const h = harness();
  h.controller.render(h.posts, 'campus')();
  h.visible(0);
  await flush();
  h.lifecycle.clear();
  await flush();
  assert.equal(h.views()['post-0']?.localSrc, '');
  h.sessions.logout();
  h.visible(1);
  await flush();
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
  const guest = harness();
  guest.sessions.logout();
  guest.controller.render(guest.posts, 'guest')();
  guest.visible(0);
  await flush();
  assert.equal(guest.calls.length, 0);
  guest.controller.dispose();
});

test('visible thumbnails serialize admission within the real two-transfer budget', async () => {
  const h = harness();
  const pending = [
    deferred<LocalMediaFile>(),
    deferred<LocalMediaFile>(),
    deferred<LocalMediaFile>(),
  ];
  let active = 0;
  let peak = 0;
  h.transfer.download = async (...args) => {
    active++;
    peak = Math.max(peak, active);
    assert.ok(active <= 2);
    const index = h.calls.length;
    h.calls.push(args);
    try {
      return await pending[index]!.promise;
    } finally {
      active--;
    }
  };
  h.controller.render(h.posts, 'campus')();
  h.visible(0);
  h.visible(1);
  h.visible(2);
  await flush();
  assert.equal(h.calls.length, 1);
  pending[0]!.resolve({ localId: 'one' });
  await flush();
  assert.equal(h.calls.length, 2);
  pending[1]!.resolve({ localId: 'two' });
  await flush();
  assert.equal(h.calls.length, 3);
  pending[2]!.resolve({ localId: 'three' });
  await flush();
  assert.equal(peak, 1);
  assert.equal(
    Object.values(h.views()).filter((view) => view.status === 'ready').length,
    3,
  );
  h.controller.dispose();
});

test('same-path native image errors cannot invalidate a replacement reader', async () => {
  const h = harness();
  h.transfer.resolve = async () => 'wxfile://tmp/reused-path';
  h.controller.render(h.posts, 'campus')();
  h.visible(0);
  await flush();
  const old = h.views()['post-0']!;
  h.visible(0, 0);
  h.visible(0);
  await flush();
  await flush();
  const fresh = h.views()['post-0']!;
  assert.equal(fresh.localSrc, old.localSrc);
  assert.notEqual(fresh.viewId, old.viewId);
  h.controller.imageFailed('post-0', old.localSrc, old.viewId);
  assert.equal(h.views()['post-0']?.status, 'ready');
  h.controller.imageFailed('post-0', fresh.localSrc, fresh.viewId);
  assert.equal(h.views()['post-0']?.status, 'unavailable');
  h.controller.dispose();
});
