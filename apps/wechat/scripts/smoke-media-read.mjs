import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';
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
  const uuid = (value) =>
    `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const images = (start, count = 3) =>
    Array.from({ length: count }, (_, index) => ({
      ...descriptor,
      assetId: uuid(start + index),
      bindingId: uuid(1000 + start + index),
    }));
  const roots = Array.from({ length: 10 }, (_, index) => ({
    id: uuid(2000 + index),
    postId: post.id,
    text: '',
    images: images(100 + index * 10),
    author: post.author,
    createdAt: post.publishedAt,
    likeCount: 0,
    replyCount: 2,
    isPinned: false,
    viewer: { isSelf: false, canDelete: false, isLiked: false, canPin: false },
    replyPreview: {
      nextCursor: null,
      items: Array.from({ length: 2 }, (_, replyIndex) => ({
        id: uuid(3000 + index * 10 + replyIndex),
        postId: post.id,
        rootCommentId: uuid(2000 + index),
        target: { status: 'unavailable' },
        text: '',
        images: images(300 + index * 10 + replyIndex * 3),
        author: post.author,
        createdAt: post.publishedAt,
        likeCount: 0,
        viewer: { isSelf: false, canDelete: false, isLiked: false },
      })),
    },
  }));
  const postGallery = images(500, 9);
  const bindings = new Set([
    descriptor.bindingId,
    ...postGallery.map((image) => image.bindingId),
    ...roots
      .flatMap((root) => [
        ...root.images,
        ...root.replyPreview.items.flatMap((reply) => reply.images),
      ])
      .map((image) => image.bindingId),
  ]);
  const files = new Map();
  const downloads = [];
  let held = false,
    release;
  let holdUnlink = false;
  const pendingUnlinks = [];
  let peakFiles = 0;
  const device = {
    downloadFile(options) {
      let header, progress;
      const local = `wxfile://tmp/emitted-media-${downloads.length}.png`;
      downloads.push(options);
      const route = options.url.match(
        /^https:\/\/native-media\.invalid\/v1\/media\/bindings\/([0-9a-f-]+)\/(thumb-v1|display-v1)$/,
      );
      assert.ok(route && bindings.has(route[1]));
      if (route[1] === descriptor.bindingId)
        assert.equal(
          route[2],
          'display-v1',
          'Single posts retain their legacy display read',
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
        peakFiles = Math.max(peakFiles, files.size);
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
        assert.notEqual(page?.data.mediaRead.localSrc, options.filePath);
        assert.ok(
          page?.data.mediaGallery.slots.every(
            (slot) => slot.localSrc !== options.filePath,
          ),
        );
        const finish = () => {
          assert.ok(files.delete(options.filePath));
          options.success();
        };
        if (holdUnlink) pendingUnlinks.push(finish);
        else finish();
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
    comments: async () => ({ items: roots, nextCursor: null }),
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
    assert.match(template, /src="\{\{item\.localSrc\}\}"/);
    assert.match(template, /bindtap="onSelectGallery"/);
    assert.match(template, /show-menu-by-longpress="\{\{false\}\}"/);
    assert.doesNotMatch(template, /src="\{\{post\.images/);
    // Render the actual emitted return button against the mounted Page data.
    // Reuse the bounded repository WXML model; this is not device rendering.
    const postReturnSources = [
      ...template.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g),
    ].filter(
      ([source]) =>
        /\bdata-kind="post"/.test(source) &&
        /\bbindtap="onSelectGallery"/.test(source),
    );
    assert.equal(postReturnSources.length, 1);
    const postReturnNodes = parse(
      postReturnSources[0][0].replaceAll('&amp;', '&'),
    ).children;
    const renderedPostReturnButton = () => {
      const rendered = render(postReturnNodes, page.data, {});
      assert.ok(rendered.length <= 1);
      return rendered[0] ?? null;
    };
    const assertPostReturnCount = (count) => {
      assert.equal(page.data.post.images.length, count);
      const button = renderedPostReturnButton();
      assert.ok(
        button,
        'A discussion selection exposes the post return button',
      );
      assert.equal(button.tag, 'button');
      assert.equal(button.attrs['data-kind'], 'post');
      assert.equal(button.attrs['data-id'], page.data.post.id);
      assert.equal(button.attrs.bindtap, 'onSelectGallery');
      assert.ok(button.children.every((child) => typeof child === 'string'));
      const text = button.children.join('');
      assert.equal(text, `查看帖子图片（${count} 张）`);
      assert.doesNotMatch(text, /true|false|\{\{/);
    };
    page = mountPage(
      path.join(dist, 'pages/community-detail/community-detail.js'),
      { postId: post.id },
    );
    await drain();
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.mediaRead.status, 'ready');
    const inline = page.data.mediaRead.localSrc;
    assert.equal(
      downloads.length,
      1,
      'Many discussion rows must not auto-download',
    );
    assert.equal(page.data.comments.length, 10);
    assert.equal(renderedPostReturnButton(), null);
    page.onPageScroll();
    assert.equal(
      page.data.mediaRead.localSrc,
      inline,
      'Scrolling preserves ordinary post media',
    );
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

    const select = (kind, id) =>
      page.onSelectGallery({
        currentTarget: { dataset: { kind, id } },
      });
    const beforeComment = downloads.length;
    holdUnlink = true;
    select('comment', roots[0].id);
    assert.equal(page.data.mediaRead.localSrc, '');
    assert.equal(page.data.mediaGallery.groupKind, 'comment');
    await drain();
    assert.equal(
      downloads.length,
      beforeComment,
      'Comment waits for old single-post cleanup',
    );
    assert.equal(pendingUnlinks.length, 1);
    holdUnlink = false;
    pendingUnlinks.splice(0).forEach((finish) => finish());
    await drain();
    assert.equal(downloads.length, beforeComment + 3);
    assert.equal(page.data.mediaGallery.status, 'ready');
    assert.equal(files.size, 3);
    assertPostReturnCount(1);
    const commentInline = page.data.mediaGallery.slots[0];
    page.onGalleryOpen({ currentTarget: { dataset: { index: 0 } } });
    page.onGalleryOpen({ currentTarget: { dataset: { index: 0 } } });
    assert.ok(
      page.data.mediaGallery.slots.every((slot) => slot.localSrc === ''),
    );
    await drain();
    assert.equal(downloads.length, beforeComment + 4);
    assert.equal(page.data.mediaGallery.expanded, true);
    const commentExpanded = page.data.mediaGallery.slots[0].localSrc;
    page.onGalleryError({
      currentTarget: {
        dataset: {
          index: 0,
          src: commentInline.localSrc,
          viewId: commentInline.viewId,
        },
      },
    });
    assert.equal(page.data.mediaGallery.slots[0].localSrc, commentExpanded);
    page.onGalleryClose();
    page.onGalleryClose();
    await drain();
    assert.equal(downloads.length, beforeComment + 7);
    select('reply', roots[0].replyPreview.items[0].id);
    await drain();
    assert.equal(page.data.mediaGallery.groupKind, 'reply');
    assert.equal(downloads.length, beforeComment + 10);
    assert.equal(files.size, 3);
    assertPostReturnCount(1);

    holdUnlink = true;
    const beforeReturn = downloads.length;
    select('post', post.id);
    assert.equal(page.data.mediaGallery.groupKind, 'post');
    assert.equal(page.data.mediaRead.localSrc, '');
    assert.deepEqual(page.data.mediaGallery.slots, []);
    await drain();
    assert.equal(
      downloads.length,
      beforeReturn,
      'Returning single post waits for discussion cleanup',
    );
    assert.equal(pendingUnlinks.length, 3);
    holdUnlink = false;
    pendingUnlinks.splice(0).forEach((finish) => finish());
    await drain();
    assert.equal(downloads.length, beforeReturn + 1);
    assert.equal(page.data.mediaRead.status, 'ready');
    assert.equal(files.size, 1);
    assert.equal(renderedPostReturnButton(), null);

    post.images = postGallery;
    const beforePostGallery = downloads.length;
    page.onReload();
    await drain();
    assert.equal(page.data.mediaGallery.groupKind, 'post');
    assert.equal(page.data.mediaGallery.total, 9);
    assert.equal(page.data.mediaGallery.status, 'ready');
    assert.equal(page.data.mediaRead.localSrc, '');
    assert.equal(
      downloads.length,
      beforePostGallery + 3,
      'Multi-image post auto-loads only its first window',
    );
    assert.equal(renderedPostReturnButton(), null);
    const postSources = page.data.mediaGallery.slots.map(
      (slot) => slot.localSrc,
    );
    page.onPageScroll();
    assert.deepEqual(
      page.data.mediaGallery.slots.map((slot) => slot.localSrc),
      postSources,
    );
    page.onGalleryWindow({ currentTarget: { dataset: { start: 6 } } });
    await drain();
    assert.deepEqual(
      page.data.mediaGallery.slots.map((slot) => slot.index),
      [6, 7, 8],
    );
    assert.equal(downloads.length, beforePostGallery + 6);
    select('comment', roots[9].id);
    await drain();
    assert.equal(page.data.mediaGallery.groupKind, 'comment');
    assertPostReturnCount(9);
    select('post', post.id);
    await drain();
    assert.equal(page.data.mediaGallery.groupKind, 'post');
    assert.equal(page.data.mediaGallery.total, 9);
    assert.equal(files.size, 3);
    assert.equal(renderedPostReturnButton(), null);
    assert.equal(
      peakFiles,
      3,
      'Switching reuses the existing bounded file registry',
    );
    select('reply', roots[9].replyPreview.items[1].id);
    await drain();
    assertPostReturnCount(9);
    page.onPageScroll();
    assert.equal(page.data.mediaGallery.groupId, '');
    await drain();
    assert.equal(files.size, 0);
    assertPostReturnCount(9);
    select('post', post.id);
    await drain();
    app.community.privateViews.clear();
    assert.equal(page.data.mediaRead.localSrc, '');
    await drain();
    assert.equal(files.size, 0);
  } finally {
    holdUnlink = false;
    pendingUnlinks.splice(0).forEach((finish) => finish());
    page?.onUnload();
    release?.();
    await drain();
    app.mediaRead = original.mediaRead;
    app.community.gateway = original.gateway;
    app.community.reports = original.reports;
    app.community.identityPrivacy = original.identityPrivacy;
  }
  console.log(
    'Media N1 emitted smoke passed: real detail Page/setData, fixed authenticated route, current session, automatic single/multi-post reads, explicit discussion groups, shared cleanup before switching and returning to post, inline/expanded reauthorization, duplicate clicks, stale image errors, hide/show/root-clear and late-file cleanup. Synthetic platform only; not device or PG evidence.',
  );
}
