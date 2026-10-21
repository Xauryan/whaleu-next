/** Bounded emitted native Component -> Page -> controller smoke. Synthetic
 * source/receipt fixtures only: not PostgreSQL, provider or device evidence. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createNativePressBridge } from '../test/native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export async function smokeFramework7Discussions({
  app,
  dist,
  extension = 'js',
  flush,
}) {
  const load = (file) => require(path.join(dist, `${file}.${extension}`));
  const { ClientError } = load('api/errors');
  const { PendingMajorDiscussionStore } = load('major-discussion/pending');
  const { PendingWindowDiscussionStore } = load('window-discussion/pending');
  const runtime = app.community;
  const keys = [
    'majors',
    'majorDiscussion',
    'windowDiscussion',
    'pendingMajorDiscussion',
    'pendingWindowDiscussion',
    'majorDiscussionV2',
    'windowDiscussionV2',
    'majorDiscussionImages',
    'windowDiscussionImages',
    'newRequestId',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, runtime[key]]));
  const globals = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: globalThis.wx,
  };
  const storage = new Map(),
    store = {
      get: (key) => storage.get(key),
      set: (key, value) => storage.set(key, structuredClone(value)),
      remove: (key) => storage.delete(key),
    };
  const accountId = runtime.sessions.snapshot().credentials?.accountId;
  assert.ok(accountId, 'Synthetic smoke owner is signed in');
  let sequence = 100,
    loseSubmit = false,
    loseCancel = false;
  const submitted = [],
    cancelled = [],
    queries = [],
    navigation = [],
    targetReads = [],
    readAcks = [];
  const mounted = new Set();
  globalThis.wx = {
    ...globalThis.wx,
    navigateTo: ({ url, success }) => {
      navigation.push(url);
      success?.();
    },
  };
  globalThis.getApp = () => app;
  runtime.newRequestId = async () => id(++sequence);
  runtime.majorDiscussionV2 = undefined;
  runtime.windowDiscussionV2 = undefined;
  runtime.majorDiscussionImages = undefined;
  runtime.windowDiscussionImages = undefined;
  runtime.pendingMajorDiscussion = new PendingMajorDiscussionStore(
    store,
    'https://synthetic-discussions.invalid',
  );
  runtime.pendingWindowDiscussion = new PendingWindowDiscussionStore(
    store,
    'https://synthetic-discussions.invalid',
  );
  const majorItem = (key = id(1)) => ({
    id: key,
    majorRevision: id(2),
    catalogRevision: id(3),
    campusId: id(4),
    departmentId: 110,
    collegeName: '合成学院',
    majorName: '合成专业',
    summary: { kind: 'unavailable' },
  });
  runtime.majors = {
    departments: async () => ({
      catalogRevision: id(3),
      items: [{ departmentId: 110, name: '110系' }],
    }),
    list: async (query, cursor) => {
      queries.push({ kind: 'directory', query, cursor });
      return {
        catalogRevision: id(3),
        items: [majorItem()],
        totalCount: 1,
        nextCursor: null,
        continuation: 'end',
      };
    },
    detail: async () => ({ catalogRevision: id(3), item: majorItem() }),
    related: async () => ({
      catalogRevision: id(3),
      items: [majorItem(id(9))],
      totalCount: 1,
      nextCursor: null,
      continuation: 'end',
    }),
  };
  const item = (family, reply = false) => ({
    id: reply ? id(6) : id(5),
    [`${family}Id`]: id(1),
    rootId: reply ? id(5) : null,
    replyToReplyId: null,
    body: reply ? '合成回复原文' : '合成主题原文',
    author: { mode: 'named', profileId: id(7), displayName: '合成昵称' },
    addressedAuthor: null,
    createdAt: '2026-10-20T09:00:00.000Z',
    likes: 0,
    replyCount: reply ? 0 : 1,
    isLiked: false,
    myMembershipRevision: null,
  });
  const missing = () =>
    new ClientError('http', 'Synthetic not recorded', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  const receipt = (intent, cancel = false) => ({
    requestId: intent.command.clientRequestId,
    [`${intent.operation.startsWith('major') ? 'major' : 'window'}Id`]: id(1),
    operation: intent.operation,
    ...(intent.operation.includes('.delete.')
      ? { commentId: intent.commentId, rootId: intent.command.rootId }
      : intent.operation.includes('.reply.')
        ? { rootId: intent.rootId }
        : intent.operation.includes('.like.')
          ? { commentId: intent.commentId }
          : {}),
    ...(cancel
      ? {
          outcome: 'rejected',
          code: intent.operation.startsWith('major')
            ? 'MAJOR_DISCUSSION_CANCELLED'
            : 'WINDOW_DISCUSSION_CANCELLED',
        }
      : intent.operation.includes('.delete.')
        ? {
            outcome: 'applied',
            tombstoneId: id(8),
            recordedAt: '2026-10-20T09:00:00.000Z',
          }
        : intent.operation.includes('.like.')
          ? {
              outcome: 'applied',
              active: intent.command.active,
              membershipRevision: id(8),
              recordedAt: '2026-10-20T09:00:00.000Z',
            }
          : {
              outcome: 'applied',
              commentId: intent.operation.includes('.reply.') ? id(6) : id(5),
              createdAt: '2026-10-20T09:00:00.000Z',
            }),
  });
  for (const family of ['major', 'window'])
    runtime[`${family}Discussion`] = {
      list: async (target, rootId, sort, cursor) => {
        queries.push({ family, target, rootId, sort, cursor });
        return {
          [`${family}Id`]: id(1),
          catalogRevision: id(3),
          [`${family}Revision`]: id(2),
          discussionRevision: '1',
          root: rootId ? item(family) : null,
          items: [item(family, Boolean(rootId))],
          totalCount: 1,
          nextCursor: null,
          continuation: 'end',
          ...(family === 'window' ? { creatorNotice: 'unavailable' } : {}),
        };
      },
      own: async () => ({
        kind: 'recorded',
        active: true,
        revision: id(8),
        recordedAt: '2026-10-20T09:00:00.000Z',
        catalogRevision: id(3),
        [`${family}Revision`]: id(2),
      }),
      deleteCapability: async (locator) => ({ ...locator, allowed: true }),
      submit: async (intent) => {
        submitted.push(structuredClone(intent));
        if (loseSubmit)
          throw new ClientError('network', 'Synthetic unknown submission');
        return receipt(intent);
      },
      cancel: async (intent) => {
        cancelled.push(structuredClone(intent));
        if (loseCancel)
          throw new ClientError('network', 'Synthetic unknown cancellation');
        return receipt(intent, true);
      },
      receipt: async () => {
        throw missing();
      },
      target: async (noticeId) => {
        targetReads.push(noticeId);
        return { [`${family}Id`]: id(1), rootId: id(5), commentId: id(6) };
      },
      notices: async () => ({ items: [], nextCursor: null, unreadCount: 0 }),
      read: async (noticeId) => {
        readAcks.push(noticeId);
        return { noticeId, readAt: '2026-10-20T09:00:00.000Z' };
      },
    };
  const mount = (name, query = {}) => {
    let page;
    globalThis.Page = (value) => {
      page = value;
    };
    const module = path.join(dist, `pages/${name}/${name}.${extension}`);
    delete require.cache[require.resolve(module)];
    require(module);
    assert.ok(page);
    page.setData = (patch, callback) => {
      page.data = { ...page.data, ...patch };
      callback?.();
    };
    page.onLoad(query);
    page.onShow();
    const bridge = createNativePressBridge({
      page,
      pageFile: path.join(dist, `pages/${name}/${name}`),
      dist,
      extension,
    });
    for (const [method, lifecycle] of [
      ['onHide', 'hide'],
      ['onShow', 'show'],
      ['onUnload', 'detach'],
    ]) {
      const handler = page[method];
      page[method] = function (...args) {
        if (lifecycle !== 'show') bridge.lifecycle(lifecycle);
        const result = handler.apply(this, args);
        if (lifecycle === 'show') bridge.lifecycle(lifecycle);
        return result;
      };
    }
    mounted.add(page);
    return {
      page,
      bridge,
      press(handler, dataset = {}) {
        const control = bridge.capture(handler, dataset);
        const emitted = control.press();
        control.detach();
        return emitted;
      },
      close() {
        page.onUnload();
        mounted.delete(page);
      },
    };
  };
  try {
    const catalog = mount('major-directory');
    await flush();
    assert.equal(catalog.page.data.loaded, true);
    catalog.press('onSearch');
    await flush();
    catalog.press('onDetail', { id: id(1) });
    assert.equal(
      navigation.at(-1),
      `/pages/major-detail/major-detail?majorId=${id(1)}`,
    );
    catalog.close();
    const detail = mount('major-detail', { majorId: id(1) });
    await flush();
    assert.equal(detail.page.data.relatedLoaded, true);
    detail.press('onDetail', { id: id(9) });
    assert.equal(
      navigation.at(-1),
      `/pages/major-detail/major-detail?majorId=${id(9)}`,
    );
    detail.press('onOpenDiscussion');
    assert.equal(
      navigation.at(-1),
      `/pages/major-discussion/major-discussion?majorId=${id(1)}`,
    );
    detail.close();
    for (const family of ['major', 'window']) {
      const f = mount(`${family}-discussion`, { [`${family}Id`]: id(1) });
      await flush();
      assert.equal(f.page.data.loaded, true);
      f.press('onSort', { sort: 'time' });
      await flush();
      assert.equal(f.page.data.sort, 'time');
      f.press('onThread', { id: id(5) });
      assert.equal(
        navigation.at(-1),
        `/pages/${family}-discussion-thread/${family}-discussion-thread?${family}Id=${id(1)}&rootId=${id(5)}`,
      );
      const compose = () =>
        family === 'major'
          ? f.press('onTogglePanel', { panel: 'compose' })
          : f.press('onOpenComposer');
      compose();
      f.page.onBody({ detail: { value: '  合成原文 😀  ' } });
      f.press('onConfirmPublish');
      const count = submitted.length;
      assert.equal(f.page.data.confirming, 'publish');
      f.press('onCloseConfirmation');
      assert.equal(submitted.length, count);
      assert.equal(f.page.data.body, '  合成原文 😀  ');
      f.press('onConfirmPublish');
      const submit = f.bridge.capture('onSubmit');
      assert.equal(submit.press(), true);
      assert.equal(submit.press(), false);
      await flush();
      assert.equal(submitted.length, count + 1);
      assert.equal(submitted.at(-1).command.body, '  合成原文 😀  ');
      f.press('onLike', { id: id(5) });
      assert.equal(f.page.data.confirming, 'like');
      f.press('onSubmit');
      await flush();
      assert.equal(submitted.at(-1).operation, `${family}.discussion.like.v1`);
      assert.equal(submitted.at(-1).command.expectedMembershipRevision, null);
      if (family === 'major') {
        f.press('onDeleteMenu', { id: id(5) });
        await flush();
        f.press('onDelete', { id: id(5) });
        assert.equal(f.page.data.confirming, 'delete');
        const before = submitted.length;
        f.press('onSubmit');
        await flush();
        assert.equal(submitted.length, before + 1);
        assert.equal(submitted.at(-1).operation, 'major.discussion.delete.v1');
      }
      compose();
      f.page.onBody({ detail: { value: '不可改写的未知原请求' } });
      f.press('onConfirmPublish');
      loseSubmit = true;
      f.press('onSubmit');
      await flush();
      const pendingStore =
        runtime[
          family === 'major'
            ? 'pendingMajorDiscussion'
            : 'pendingWindowDiscussion'
        ];
      const pending = pendingStore.load(accountId);
      assert.ok(pending);
      assert.equal(f.page.data.frozen, true);
      f.press('onRecover');
      await flush();
      assert.deepEqual(pendingStore.load(accountId), pending);
      f.press('onRetry');
      await flush();
      assert.deepEqual(submitted.at(-1), pending.intent);
      f.press('onRequestCancellation');
      await flush();
      assert.equal(f.page.data.confirming, 'cancel');
      loseCancel = true;
      f.press('onConfirmCancellation');
      await flush();
      assert.deepEqual(pendingStore.load(accountId), {
        ...pending,
        phase: 'cancel',
      });
      loseCancel = false;
      f.press('onRetry');
      await flush();
      assert.equal(pendingStore.load(accountId), null);
      loseSubmit = false;
      f.close();
      const t = mount(`${family}-discussion-thread`, {
        [`${family}Id`]: id(1),
        rootId: id(5),
        noticeId: id(10),
        commentId: id(6),
      });
      await flush();
      assert.equal(t.page.data.loaded, true);
      assert.equal(t.page.data.focusCommentId, id(6));
      t.press('onReply', { id: id(6) });
      t.page.onBody({ detail: { value: '合成定向回复' } });
      t.press('onConfirmPublish');
      t.press('onSubmit');
      await flush();
      assert.equal(submitted.at(-1).operation, `${family}.discussion.reply.v1`);
      assert.equal(submitted.at(-1).command.replyToReplyId, id(6));
      assert.equal(submitted.at(-1).rootId, id(5));
      const old = t.bridge.capture('onLike', { id: id(6) });
      t.page.onHide();
      assert.equal(old.press(), false);
      t.close();
    }
    assert.equal(
      targetReads.length,
      4,
      'Each thread load/reload rechecks the current notice target',
    );
    assert.equal(
      readAcks.length,
      0,
      'Thread viewing never impersonates explicit notice read acknowledgement',
    );
    return {
      routes: 6,
      submitted: submitted.length,
      cancelled: cancelled.length,
      sourceModelOnly: true,
    };
  } finally {
    for (const page of mounted) page.onUnload();
    for (const key of keys) runtime[key] = saved[key];
    Object.assign(globalThis, globals);
  }
}
