import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import type { MediaReadTransfer } from '../src/media/authenticated-download';
import {
  DiscussionGalleryController,
  discussionImageGroups,
  initialDiscussionGalleryView,
  type DiscussionImageGroup,
} from '../src/media/discussion-gallery';
import { MediaGalleryController } from '../src/media/gallery-controller';
import { MediaLocalFiles } from '../src/media/local-files';
import {
  initialMediaReadView,
  MediaReadController,
} from '../src/media/read-controller';
import { comment, post, reply } from './community-helpers';
import { credentials, deferred, flush, signedIn } from './helpers';
import { attachment, ReadFiles } from './support/media-read-fixtures';

const uuid = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const group = (
  kind: DiscussionImageGroup['kind'],
  id: number,
  count = 3,
): DiscussionImageGroup => ({
  kind,
  id: uuid(id),
  images: Array.from({ length: count }, (_, index) => ({
    ...attachment,
    assetId: uuid(id * 10 + index),
    bindingId: uuid(1000 + id * 10 + index),
  })),
});

function harness(withPostReader = false) {
  const sessions = signedIn('reader');
  const privateViews = new PrivateViewLifecycle();
  const files = new ReadFiles();
  const registry = new MediaLocalFiles(files);
  const calls: string[] = [];
  let view = initialDiscussionGalleryView();
  let readView = initialMediaReadView();
  let readers = 0;
  let sequence = 0;
  let peakFiles = 0;
  const transfer: MediaReadTransfer = {
    async download(image, variant, owner, session) {
      const credit = registry.acquireTransfer();
      try {
        const reservation = registry.reserve();
        const path = `wxfile://tmp/discussion-${++sequence}.png`;
        files.put(path);
        const handle = registry.adopt(
          path,
          100,
          owner,
          session.current(),
          reservation,
        );
        peakFiles = Math.max(peakFiles, files.values.size);
        calls.push(`${variant}:${image.bindingId}`);
        return handle;
      } finally {
        credit();
      }
    },
    resolve: (file, owner, ticket) => registry.resolve(file, owner, ticket),
    release: (file) => registry.release(file),
  };
  const postReader = withPostReader
    ? new MediaReadController(
        sessions,
        transfer,
        (value) => {
          readView = value;
        },
        privateViews,
      )
    : undefined;
  const controller = new DiscussionGalleryController(
    {
      create: () =>
        assert.fail('Rows must never allocate single-image readers'),
      createGallery: (render) => {
        readers++;
        return new MediaGalleryController(
          sessions,
          transfer,
          render,
          privateViews,
        );
      },
    },
    (value) => {
      view = value;
    },
    postReader,
  );
  return {
    controller,
    postReader,
    transfer,
    readView: () => readView,
    sessions,
    privateViews,
    files,
    registry,
    calls,
    view: () => view,
    readers: () => readers,
    peakFiles: () => peakFiles,
  };
}

test('many root/preview rows retain only metadata and use one selected three-file gallery', async () => {
  const h = harness();
  const roots = Array.from({ length: 10 }, (_, index) => {
    const images = group('comment', index + 10);
    return comment({
      ...images,
      replyPreview: {
        items: [
          reply({ ...group('reply', index + 30) }),
          reply({ ...group('reply', index + 50) }),
        ],
        nextCursor: null,
      },
    });
  });
  const groups = discussionImageGroups(post({ ...group('post', 1, 9) }), roots);
  assert.equal(groups.length, 31);
  assert.equal(h.readers(), 1);
  assert.equal(h.calls.length, 0);
  h.controller.reconcile(groups);
  assert.equal(h.calls.length, 0);
  await h.controller.select(groups[1]!);
  assert.equal(h.view().groupKind, 'comment');
  assert.equal(h.view().slots.length, 3);
  assert.equal(h.files.values.size, 3);
  await h.controller.select(groups[groups.length - 1]!);
  assert.equal(h.view().groupKind, 'reply');
  assert.equal(h.readers(), 1);
  assert.equal(h.files.values.size, 3);
  assert.equal(h.peakFiles(), 3);
  h.controller.dispose();
  assert.equal(h.view().groupId, '');
  assert.equal(h.view().slots.length, 0);
  await flush();
  assert.equal(h.files.values.size, 0);
});

test('kind plus ID selects pure-image content without collapsing colliding post/comment/reply IDs', async () => {
  const h = harness();
  const sameId = uuid(7);
  const groups = discussionImageGroups(
    post({ id: sameId, images: group('post', 1, 1).images }),
    [comment({ id: sameId, text: '', images: group('comment', 2, 1).images })],
    [reply({ id: sameId, text: '', images: group('reply', 3, 1).images })],
  );
  assert.deepEqual(
    groups.map((item) => item.kind),
    ['post', 'comment', 'reply'],
  );
  await h.controller.select(groups[1]!);
  assert.equal(h.view().status, 'ready');
  assert.equal(h.view().groupKind, 'comment');
  h.controller.reconcile(groups.filter((item) => item.kind === 'reply'));
  assert.equal(h.view().groupId, '');
  assert.equal(h.view().slots.length, 0);
  await h.controller.select(groups[2]!);
  assert.equal(h.view().groupKind, 'reply');
  assert.equal(h.view().total, 1);
  assert.equal(
    h.calls[h.calls.length - 1],
    `thumb-v1:${groups[2]!.images[0]!.bindingId}`,
  );
  h.controller.dispose();
});

test('switch clears sources immediately and waits for old file cleanup before any new allocation', async () => {
  const h = harness();
  await h.controller.select(group('comment', 1));
  const firstSources = h.view().slots.map((slot) => slot.localSrc);
  const release = deferred<void>();
  const unlink = h.files.unlink.bind(h.files);
  h.files.unlink = async (path) => {
    await release.promise;
    await unlink(path);
  };
  const switching = h.controller.select(group('reply', 2));
  assert.equal(h.view().groupKind, 'reply');
  assert.ok(h.view().slots.every((slot) => slot.localSrc === ''));
  await flush();
  assert.equal(h.calls.length, 3);
  release.resolve();
  await switching;
  assert.equal(h.calls.length, 6);
  assert.ok(
    h.view().slots.every((slot) => !firstSources.includes(slot.localSrc)),
  );
  assert.equal(h.peakFiles(), 3);
  h.controller.dispose();
});

test('reconcile clears changed full descriptor groups, refreshes, and same-account login epochs', async () => {
  const h = harness();
  const selected = group('comment', 1);
  await h.controller.select(selected);
  h.controller.reconcile([
    { ...selected, images: [...selected.images].reverse() },
  ]);
  assert.equal(h.view().groupId, '');
  await h.controller.select(selected);
  h.controller.reconcile(null);
  assert.equal(h.view().slots.length, 0);
  await h.controller.select(selected);
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('reader', 'new'),
  );
  assert.equal(h.view().slots.length, 0);
  await h.controller.select(selected);
  h.privateViews.clear();
  assert.equal(h.view().slots.length, 0);
  h.controller.dispose();
  await flush();
  assert.equal(h.files.values.size, 0);
});

test('discussion is capped at three; post retains nine-image windows on the same reader', async () => {
  const h = harness();
  for (const invalid of [
    group('comment', 1, 4),
    group('reply', 2, 4),
    group('post', 3, 10),
  ])
    await h.controller.select(invalid);
  assert.equal(h.calls.length, 0);
  assert.equal(h.view().groupId, '');
  await h.controller.select(group('post', 4, 9));
  assert.equal(h.view().total, 9);
  assert.deepEqual(
    h.view().slots.map((slot) => slot.index),
    [0, 1, 2],
  );
  await h.controller.window(6);
  assert.deepEqual(
    h.view().slots.map((slot) => slot.index),
    [6, 7, 8],
  );
  assert.equal(h.files.values.size, 3);
  h.controller.dispose();
});

test('selected groups share the existing two IO, four lease and ten MiB limits', async () => {
  const h = harness();
  const writer = h.registry.acquireTransfer('reader');
  const download = h.registry.acquireTransfer();
  assert.throws(() => h.registry.acquireTransfer());
  download();
  await h.controller.select(group('comment', 1));
  assert.equal(
    h.view().slots.filter((slot) => slot.status === 'ready').length,
    3,
  );
  writer();
  const extra = h.registry.reserve(1);
  assert.equal(h.registry.capacityAvailable, false);
  assert.throws(() => h.registry.reserve(1));
  h.registry.releaseReservation(extra);
  const fiveMiB = h.registry.reserve(5 * 1024 * 1024);
  assert.throws(() => h.registry.reserve(5 * 1024 * 1024));
  h.registry.releaseReservation(fiveMiB);
  h.controller.dispose();
  await flush();
  const first = h.registry.reserve(5 * 1024 * 1024);
  const second = h.registry.reserve(5 * 1024 * 1024);
  assert.throws(() => h.registry.reserve(1));
  h.registry.releaseReservation(first);
  h.registry.releaseReservation(second);
});

test('legacy single post reader and selected discussion gallery revoke and drain before switching either way', async () => {
  const h = harness(true);
  const originalPost = group('post', 1, 1);
  await h.controller.select(originalPost);
  assert.equal(h.readView().status, 'ready');
  assert.equal(h.readView().expanded, false);
  assert.deepEqual(h.calls, [
    `display-v1:${originalPost.images[0]!.bindingId}`,
  ]);
  assert.equal(h.view().groupKind, 'post');
  assert.equal(h.view().slots.length, 0);
  const firstSource = h.readView().localSrc;
  const release = deferred<void>();
  const unlink = h.files.unlink.bind(h.files);
  h.files.unlink = async (path) => {
    assert.notEqual(h.readView().localSrc, path);
    assert.ok(h.view().slots.every((slot) => slot.localSrc !== path));
    await release.promise;
    await unlink(path);
  };
  const selected = h.controller.select(group('comment', 2));
  assert.equal(h.readView().localSrc, '');
  assert.equal(h.view().groupKind, 'comment');
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.files.values.has(firstSource), true);
  release.resolve();
  await selected;
  assert.equal(h.calls.length, 4);
  assert.equal(h.files.values.size, 3);
  const returnRelease = deferred<void>();
  h.files.unlink = async (path) => {
    assert.notEqual(h.readView().localSrc, path);
    assert.ok(h.view().slots.every((slot) => slot.localSrc !== path));
    await returnRelease.promise;
    await unlink(path);
  };
  const returning = h.controller.select(originalPost);
  assert.equal(h.view().groupKind, 'post');
  assert.equal(h.view().slots.length, 0);
  assert.equal(h.readView().localSrc, '');
  await flush();
  assert.equal(h.calls.length, 4);
  returnRelease.resolve();
  await returning;
  assert.equal(h.readView().status, 'ready');
  assert.equal(h.calls[4], `display-v1:${originalPost.images[0]!.bindingId}`);
  assert.equal(h.files.values.size, 1);
  assert.equal(h.peakFiles(), 3);
  assert.equal(h.readers(), 1);

  const writer = h.registry.acquireTransfer('reader');
  const downloader = h.registry.acquireTransfer();
  assert.throws(() => h.registry.acquireTransfer());
  downloader();
  writer();
  const leases = Array.from({ length: 3 }, () => h.registry.reserve(1));
  assert.throws(() => h.registry.reserve(1));
  for (const lease of leases) h.registry.releaseReservation(lease);
  const fiveMiB = h.registry.reserve(5 * 1024 * 1024);
  assert.throws(() => h.registry.reserve(5 * 1024 * 1024));
  h.registry.releaseReservation(fiveMiB);
  h.controller.dispose();
  await flush();
  assert.equal(h.files.values.size, 0);
});

test('switching from a late single-post output waits for its release and never paints it', async () => {
  const h = harness(true);
  const deliver = deferred<void>();
  const download = h.transfer.download;
  h.transfer.download = async (...args) => {
    const file = await download(...args);
    await deliver.promise;
    return file;
  };
  const loading = h.controller.select(group('post', 1, 1));
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.files.values.size, 1);
  h.transfer.download = download;
  const switching = h.controller.select(group('reply', 2));
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.readView().localSrc, '');
  deliver.resolve();
  await Promise.all([loading, switching]);
  assert.equal(h.calls.length, 4);
  assert.equal(h.readView().localSrc, '');
  assert.equal(h.view().groupKind, 'reply');
  assert.equal(h.files.values.size, 3);
  assert.equal(h.peakFiles(), 3);
  h.controller.dispose();
});

test('login epoch changes while switching cannot authorize stale parent descriptors after cleanup', async () => {
  const h = harness(true);
  await h.controller.select(group('post', 1, 1));
  const release = deferred<void>();
  const unlink = h.files.unlink.bind(h.files);
  h.files.unlink = async (path) => {
    await release.promise;
    await unlink(path);
  };
  const switching = h.controller.select(group('comment', 2));
  h.sessions.completeLogin(
    h.sessions.beginLogin(),
    credentials('reader', 'new'),
  );
  release.resolve();
  await switching;
  assert.equal(h.calls.length, 1);
  assert.equal(h.readView().localSrc, '');
  assert.equal(h.view().slots.length, 0);
  assert.equal(h.files.values.size, 0);
  h.controller.dispose();
});

test('detail/thread templates expose pure-image actions and bind only the shared temporary gallery sources', () => {
  for (const page of ['community-detail', 'community-thread']) {
    const source = readFileSync(
      join(__dirname, `../src/pages/${page}/${page}.ts`),
      'utf8',
    );
    const template = readFileSync(
      join(__dirname, `../src/pages/${page}/${page}.wxml`),
      'utf8',
    );
    assert.equal(source.match(/new DiscussionGalleryController\(/g)?.length, 1);
    if (page === 'community-detail') {
      assert.match(source, /mediaRead: initialMediaReadView\(\)/);
      assert.equal(source.match(/\.mediaRead\?\.create\(/g)?.length, 1);
      assert.match(
        source,
        /if \(post\)[\s\S]*?mediaGalleryController\?\.select\(\{[\s\S]*?kind: 'post'/,
      );
      assert.match(template, /src="\{\{mediaRead\.localSrc\}\}"/);
      assert.match(template, /bindtap="onOpenMedia"/);
      assert.match(template, /bindtap="onCloseMedia"/);
      assert.match(template, /binderror="onMediaError"/);
    } else
      assert.doesNotMatch(
        source,
        /MediaReadController|\.mediaRead\?\.create\(/,
      );
    assert.doesNotMatch(source, /wx\.previewImage|wx\.saveFile/);
    assert.match(
      source,
      /onPageScroll\(\)[\s\S]*?mediaGalleryController\?\.clear\(\)/,
    );
    assert.match(
      template,
      /data-kind="comment"[\s\S]*?bindtap="onSelectGallery"/,
    );
    assert.match(
      template,
      /data-kind="reply"[\s\S]*?bindtap="onSelectGallery"/,
    );
    assert.match(template, /src="\{\{item\.localSrc\}\}"/);
    assert.doesNotMatch(template, /src="\{\{(?:post|root|reply|item)\.images/);
    assert.match(template, /show-menu-by-longpress="\{\{false\}\}"/);
    if (page === 'community-detail')
      assert.match(
        template,
        /\{\{reply\.text \|\| '查看图片回复'\}\} →<\/navigator>/,
      );
  }
});
