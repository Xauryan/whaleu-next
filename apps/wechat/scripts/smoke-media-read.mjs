import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);

/** Emitted Page + native adapters, synthetic device only. Actual bytes/backend
 * are independently exercised by the mandatory HTTP-native integration suite. */
export async function smokeMediaRead({
  app,
  dist,
  mountPage,
  flush,
  postWire,
}) {
  const { createMediaReadRuntime } = require(
    path.join(dist, 'media/runtime.js'),
  );
  const { systemClock } = require(path.join(dist, 'platform/clock.js'));
  const original = {
    mediaRead: app.mediaRead,
    gateway: app.community.gateway,
    reports: app.community.reports,
    identityPrivacy: app.community.identityPrivacy,
  };
  const sessions = app.identity.sessions;
  const descriptor = {
    version: 1,
    kind: 'authenticated-media',
    assetId: '11111111-1111-4111-8111-111111111111',
    bindingId: '22222222-2222-4222-8222-222222222222',
    variants: ['thumb-v1', 'display-v1'],
    width: 80,
    height: 60,
  };
  const post = {
    ...postWire(),
    images: [descriptor],
    component: { kind: 'none' },
    trading: null,
  };
  const files = new Map();
  const downloads = [];
  let held = false,
    release;
  const device = {
    downloadFile(options) {
      let header, progress;
      const local = `wxfile://tmp/emitted-media-${downloads.length}.png`;
      downloads.push(options);
      assert.equal(
        options.url,
        `https://native-media.invalid/v1/media/bindings/${descriptor.bindingId}/display-v1`,
      );
      assert.equal(
        options.header.Authorization,
        `Bearer ${sessions.snapshot().credentials.accessToken}`,
      );
      queueMicrotask(() => {
        header?.({
          header: {
            'Content-Type': 'image/png',
            'Content-Length': '101',
            'Cache-Control': 'private, no-store',
          },
        });
        progress?.({ totalBytesWritten: 101 });
        files.set(local, 101);
        const deliver = () => {
          options.success({ statusCode: 200, tempFilePath: local });
          options.complete();
        };
        if (held) release = deliver;
        else deliver();
      });
      return {
        abort() {},
        onHeadersReceived(value) {
          header = value;
        },
        offHeadersReceived(value) {
          if (header === value) header = undefined;
        },
        onProgressUpdate(value) {
          progress = value;
        },
        offProgressUpdate(value) {
          if (progress === value) progress = undefined;
        },
      };
    },
    getFileSystemManager: () => ({
      getFileInfo(options) {
        if (files.has(options.filePath))
          options.success({ size: files.get(options.filePath) });
        else options.fail({});
      },
      readFile() {
        assert.fail('Successful image must not be parsed as an error envelope');
      },
      unlink(options) {
        assert.ok(files.delete(options.filePath));
        options.success();
      },
    }),
    getImageInfo(options) {
      assert.ok(files.has(options.src));
      options.success({
        width: 80,
        height: 60,
        type: 'png',
        orientation: 'up',
        path: options.src,
      });
    },
    previewImage() {
      assert.fail('Native preview callbacks are not close signals');
    },
    saveFile() {
      assert.fail('No permanent media cache');
    },
  };
  app.community.gateway = {
    ...original.gateway,
    post: async () => post,
    comments: async () => ({ items: [], nextCursor: null }),
  };
  app.community.reports = undefined;
  app.community.identityPrivacy = undefined;
  app.mediaRead = createMediaReadRuntime(
    {
      sessions,
      auth: {
        refresh: async () => assert.fail('Fresh-token smoke must not refresh'),
      },
    },
    device,
    'https://native-media.invalid',
    systemClock,
    app.community.privateViews,
    true,
  );
  let page;
  const drain = async () => {
    for (let index = 0; index < 5; index++) await flush();
  };
  try {
    const template = readFileSync(
      path.join(dist, 'pages/community-detail/community-detail.wxml'),
      'utf8',
    );
    assert.match(template, /src="\{\{mediaRead\.localSrc\}\}"/);
    assert.match(template, /data-src="\{\{mediaRead\.localSrc\}\}"/);
    assert.match(template, /show-menu-by-longpress="\{\{false\}\}"/);
    assert.doesNotMatch(template, /src="\{\{post\.images/);
    page = mountPage(
      path.join(dist, 'pages/community-detail/community-detail.js'),
      { postId: post.id },
    );
    await drain();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.mediaRead.status, 'ready');
    const inline = page.data.mediaRead.localSrc;
    assert.equal(downloads.length, 1);
    page.onOpenMedia();
    page.onOpenMedia();
    assert.equal(page.data.mediaRead.localSrc, '');
    await drain();
    assert.equal(downloads.length, 2);
    assert.equal(page.data.mediaRead.expanded, true);
    assert.equal(files.has(inline), false);
    const expanded = page.data.mediaRead.localSrc;
    page.onMediaError({ currentTarget: { dataset: { src: inline } } });
    assert.equal(page.data.mediaRead.localSrc, expanded);
    page.onCloseMedia();
    page.onCloseMedia();
    await drain();
    assert.equal(downloads.length, 3);
    assert.equal(page.data.mediaRead.expanded, false);
    held = true;
    page.onOpenMedia();
    await drain();
    assert.equal(typeof release, 'function');
    page.onHide();
    assert.equal(page.data.mediaRead.localSrc, '');
    release();
    await drain();
    assert.equal(page.data.mediaRead.status, 'idle');
    assert.equal(files.size, 0);
    held = false;
    page.onShow();
    await drain();
    assert.equal(page.data.mediaRead.status, 'ready');
    assert.equal(downloads.length, 5);
    app.community.privateViews.clear();
    assert.equal(page.data.mediaRead.localSrc, '');
    await drain();
    assert.equal(files.size, 0);
  } finally {
    page?.onUnload();
    release?.();
    await drain();
    app.mediaRead = original.mediaRead;
    app.community.gateway = original.gateway;
    app.community.reports = original.reports;
    app.community.identityPrivacy = original.identityPrivacy;
  }
  console.log(
    'Media N1 emitted smoke passed: real detail Page/setData, fixed authenticated route, current session, inline/expanded reauthorization, duplicate clicks, stale image errors, hide/show/root-clear and late-file cleanup. Synthetic platform only; not device or PG evidence.',
  );
}
