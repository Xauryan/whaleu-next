import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from './smoke-ratings.mjs';
const require = createRequire(import.meta.url);

/** Actual emitted Page/gateway/storage/WXML; only transport and platform are synthetic. */
export async function smokeAdminDiscussionRemoval({ dist }) {
  for (const kind of ['comment', 'reply']) await smokeKind({ dist, kind });
}
async function smokeKind({ dist, kind }) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { ApiClient } = emitted('api/client');
  const { ClientError } = emitted('api/errors');
  const { SessionStore } = emitted('auth/session');
  const { createCommunityRuntime } = emitted('community/runtime');
  const id = (n) => `${String(n).padStart(8, '0')}-ca71-4ca7-8ca7-ca71ca71ca71`;
  const accountId = id(1),
    origin = 'https://admin-discussion-removal.example';
  const sessions = new SessionStore();
  const login = (account = accountId) =>
    sessions.completeLogin(sessions.beginLogin(), {
      accountId: account,
      sessionId: id(3),
      accessToken: `wu_a_${'a'.repeat(43)}`,
      refreshToken: `wu_r_${'b'.repeat(43)}`,
      expiresAt: 1900000000000,
      refreshExpiresAt: 1900600000000,
    });
  login();
  const storage = new Map(),
    receipts = new Map(),
    requests = [],
    notices = [],
    removed = new Set();
  const createdAt = '2026-10-12T00:00:00.000Z';
  const older = [
    {
      noticeId: id(50),
      kind: 'post_jury_removed',
      createdAt,
      readAt: null,
      keepVotes: 5,
      removeVotes: 6,
    },
    {
      noticeId: id(51),
      kind: 'profile_nickname_reset',
      createdAt,
      readAt: null,
      nickname: '违规昵称Ab123Z',
    },
    {
      noticeId: id(53),
      kind: 'admin_post_removed',
      createdAt,
      readAt: null,
    },
    {
      noticeId: id(52),
      kind: 'profile_custom_avatar_cleared',
      createdAt,
      readAt: null,
    },
  ];
  const native = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
  };
  let runtime,
    counter = 100,
    writes = 0,
    loseAfterCommit = false,
    dropBeforeRecord = false,
    managementUnavailable = false;
  let targetVersion = 'a'.repeat(64);
  const transport = {
    async send(request) {
      const url = new URL(request.url);
      assert.equal(url.origin, origin);
      assert.ok(request.headers.Authorization);
      requests.push({
        path: url.pathname,
        method: request.method,
        body: request.body,
      });
      let body;
      if (
        url.pathname === '/v1/community/admin-discussion-removal/management'
      ) {
        assert.equal(request.method, 'GET');
        assert.deepEqual([...url.searchParams.keys()].sort(), ['id', 'kind']);
        if (managementUnavailable || removed.has(url.searchParams.get('id')))
          throw new ClientError('http', 'Synthetic current target unavailable');
        body = {
          target: {
            kind: url.searchParams.get('kind'),
            id: url.searchParams.get('id'),
          },
          targetVersion,
          canRemove: true,
        };
      } else if (
        /^\/v1\/community\/admin-discussion-removal\/commands(?:\/cancel)?$/.test(
          url.pathname,
        )
      ) {
        assert.equal(request.method, 'POST');
        const command = request.body,
          cancelling = url.pathname.endsWith('/cancel');
        const pending = runtime.pendingAdminDiscussionRemoval.load(accountId);
        assert.deepEqual(
          pending.command,
          command,
          'Durable readback must precede every dispatch',
        );
        assert.equal(pending.phase, cancelling ? 'cancel' : 'submit');
        assert.deepEqual(Object.keys(command).sort(), [
          'action',
          'clientRequestId',
          'expectedTargetVersion',
          'target',
        ]);
        assert.deepEqual(Object.keys(command.target).sort(), ['id', 'kind']);
        assert.equal(command.target.kind, kind);
        assert.equal(command.action, 'remove_discussion');
        if (dropBeforeRecord) {
          dropBeforeRecord = false;
          throw new ClientError('timeout', 'Not recorded');
        }
        body = receipts.get(command.clientRequestId);
        if (!body) {
          const base = {
            requestId: command.clientRequestId,
            target: command.target,
            expectedTargetVersion: command.expectedTargetVersion,
            action: command.action,
          };
          if (cancelling)
            body = {
              ...base,
              outcome: 'rejected',
              code: 'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
            };
          else if (
            targetVersion !== command.expectedTargetVersion ||
            removed.has(command.target.id)
          )
            body = {
              ...base,
              outcome: 'rejected',
              code: 'ADMIN_DISCUSSION_REMOVAL_STALE',
            };
          else {
            writes++;
            removed.add(command.target.id);
            body = {
              ...base,
              outcome: 'applied',
              eventId: id(counter++),
              recordedAt: createdAt,
            };
          }
          receipts.set(command.clientRequestId, body);
        }
        if (loseAfterCommit) {
          loseAfterCommit = false;
          throw new ClientError('timeout', 'Committed response lost');
        }
      } else if (
        url.pathname.startsWith(
          '/v1/community/admin-discussion-removal/requests/',
        )
      ) {
        assert.equal(request.method, 'GET');
        const found = receipts.get(url.pathname.split('/').at(-1));
        body = found
          ? { state: 'recorded', receipt: found }
          : { state: 'not_recorded' };
      } else if (url.pathname === '/v1/me/system-notices') {
        body = {
          items: [...older, ...notices],
          nextCursor: null,
          unreadCount: 4 + notices.filter((n) => !n.readAt).length,
        };
      } else if (/^\/v1\/me\/system-notices\/[^/]+\/read$/.test(url.pathname)) {
        const notice = notices.find(
          (n) => n.noticeId === url.pathname.split('/').at(-2),
        );
        assert.ok(notice);
        notice.readAt ??= createdAt;
        body = {
          noticeId: notice.noticeId,
          readAt: notice.readAt,
          unreadCount: 4 + notices.filter((n) => !n.readAt).length,
        };
      } else
        throw Error(
          `Unexpected admin discussion removal smoke route: ${url.pathname}`,
        );
      return { status: 200, headers: {}, body };
    },
  };
  const api = new ApiClient(origin, transport, sessions, {
    refresh: async () => {
      throw Error('No automatic auth replay');
    },
  });
  runtime = createCommunityRuntime({ api, sessions }, native, origin);
  runtime.newRequestId = async () => id(counter++);
  const app = { community: runtime, identity: { api, sessions } };
  const previous = {
      Page: globalThis.Page,
      getApp: globalThis.getApp,
      wx: globalThis.wx,
    },
    pages = [];
  const flush = async () => {
    for (let n = 0; n < 160; n++) await Promise.resolve();
  };
  const mount = (
    name = 'admin-discussion-removal',
    query = {},
    show = true,
  ) => {
    let definition;
    globalThis.Page = (value) => {
      definition = value;
    };
    const file = path.join(dist, `pages/${name}/${name}.js`);
    delete require.cache[require.resolve(file)];
    require(file);
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(patch) {
        Object.assign(this.data, patch);
      },
    };
    pages.push(page);
    page.onLoad?.(query);
    if (show) page.onShow();
    return page;
  };
  const flatten = (nodes) =>
    nodes.flatMap((node) =>
      typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
    );
  try {
    globalThis.getApp = () => app;
    const navigation = [],
      clears = [];
    globalThis.wx = {
      ...native,
      navigateTo(options) {
        navigation.push(options.url);
        options.success?.();
      },
    };
    // Drive the actual emitted WXML bindings and handlers for each child surface.
    // Transport fixtures below remain synthetic; this is not PostgreSQL acceptance.
    for (const pageName of ['community-detail', 'community-thread']) {
      const entryPage = mount(
        pageName,
        { postId: id(80), rootCommentId: id(81) },
        false,
      );
      const entrySource = readFileSync(
        path.join(dist, `pages/${pageName}/${pageName}.wxml`),
        'utf8',
      );
      const bindings = [
        ...entrySource.matchAll(
          /<button[^>]*bindtap="onAdminDiscussionRemoval"[^>]*>[^<]*<\/button>/g,
        ),
      ].map((entry) => entry[0]);
      assert.equal(bindings.length, pageName === 'community-detail' ? 4 : 2);
      const child = {
        id: id(81),
        rootCommentId: id(81),
        postId: id(80),
        viewer: { isSelf: false },
        replyPreview: { items: [] },
        author: { kind: 'anonymous' },
      };
      const childReply = { ...child, id: id(82) };
      child.replyPreview.items = [childReply];
      const clear = (name) => ({
        clear() {
          clears.push(name);
        },
        dispose() {},
      });
      entryPage.namedAvatarController = clear('avatar');
      entryPage.mediaGalleryController = clear('gallery');
      entryPage.mediaReadController = clear('reader');
      entryPage.identityOverlay = clear('overlay');
      Object.assign(entryPage.data, {
        loaded: true,
        busy: false,
        needsReload: false,
        post: { id: id(80) },
        comments: [child],
        locatedComment: child,
        locatedReply: childReply,
        root: child,
        replies: [childReply],
        contextReplies: [],
      });
      for (const binding of bindings) {
        const rendered = flatten(
          render(
            parse(binding).children,
            { ...entryPage.data, item: child, reply: childReply },
            {},
          ),
        );
        const button = rendered.find(
          (node) => typeof node !== 'string' && node.tag === 'button',
        );
        assert.ok(button, 'Anonymous child gets a real management entry');
        assert.doesNotMatch(binding, /author.kind|role|canManage/);
        const before = navigation.length;
        entryPage[button.attrs.bindtap]({
          currentTarget: {
            dataset: {
              kind: button.attrs['data-kind'],
              id: button.attrs['data-id'],
            },
          },
        });
        assert.equal(navigation.length, before + 1);
        assert.equal(
          navigation.at(-1),
          `/pages/admin-discussion-removal/admin-discussion-removal?kind=${button.attrs['data-kind']}&id=${button.attrs['data-id']}`,
        );
        assert.ok(
          clears.includes('gallery') &&
            clears.includes('avatar') &&
            clears.includes('overlay'),
        );
        assert.equal(
          flatten(
            render(
              parse(binding).children,
              {
                ...entryPage.data,
                item: { ...child, viewer: { isSelf: true } },
                reply: { ...childReply, viewer: { isSelf: true } },
                locatedComment: { ...child, viewer: { isSelf: true } },
                locatedReply: { ...childReply, viewer: { isSelf: true } },
                root: { ...child, viewer: { isSelf: true } },
              },
              {},
            ),
          ).length,
          0,
        );
      }
      if (pageName === 'community-thread') {
        for (const location of ['replies', 'contextReplies', 'locatedReply']) {
          Object.assign(entryPage.data, {
            replies: [],
            contextReplies: [],
            locatedReply: null,
          });
          entryPage.data[location] =
            location === 'locatedReply' ? childReply : [childReply];
          const before = navigation.length;
          entryPage.onAdminDiscussionRemoval({
            currentTarget: { dataset: { kind: 'reply', id: childReply.id } },
          });
          assert.equal(navigation.length, before + 1, location);
        }
      }
      const before = navigation.length;
      entryPage.onAdminDiscussionRemoval({
        currentTarget: { dataset: { kind: 'reply', id: id(999) } },
      });
      entryPage.data.needsReload = true;
      entryPage.onAdminDiscussionRemoval({
        currentTarget: { dataset: { kind: 'comment', id: child.id } },
      });
      assert.equal(
        navigation.length,
        before,
        'Missing or stale DTO cannot navigate',
      );
      entryPage.onUnload();
    }

    const template = parse(
      readFileSync(
        path.join(
          dist,
          'pages/admin-discussion-removal/admin-discussion-removal.wxml',
        ),
        'utf8',
      ),
    );
    assert.ok(
      JSON.parse(
        readFileSync(path.join(dist, 'app.json'), 'utf8'),
      ).pages.includes(
        'pages/admin-discussion-removal/admin-discussion-removal',
      ),
    );
    const confirm = async (page) => {
      page.onRemoveDiscussion();
      await flush();
      assert.equal(page.data.confirming, 'remove');
      const words = flatten(render(template.children, page.data, {}))
        .filter((n) => typeof n === 'string')
        .join(' ');
      assert.match(
        words,
        kind === 'comment'
          ? /该根评论及其全部回复将不可访问/
          : /仅删除选中的这条回复/,
      );
      assert.match(words, /不会通知作者/);
      assert.match(words, /没有恢复此内容/);
      assert.doesNotMatch(words, /已通知作者|私有系统通知/);
      assert.doesNotMatch(words, /super_admin|school_admin|公开昵称/);
    };
    let page = mount('admin-discussion-removal', { kind, id: id(10) });
    await flush();
    await confirm(page);
    page.onClose();
    page.onSubmit();
    await flush();
    assert.equal(writes, 0);
    await confirm(page);
    page.onSubmit();
    page.onSubmit();
    await flush();
    assert.equal(writes, 1);
    assert.equal(page.data.frozen, false);
    assert.match(page.data.receiptStatus, /已确认删除评论\/回复/);
    page.onHide();
    assert.equal(page.data.management, null);
    page.onShow();
    await flush();
    assert.equal(
      page.data.management,
      null,
      'Back/reopen never restores removed target authority',
    );
    page.onUnload();

    page = mount('admin-discussion-removal', { kind, id: id(11) });
    await flush();
    await confirm(page);
    loseAfterCommit = true;
    page.onSubmit();
    await flush();
    assert.equal(writes, 2);
    assert.equal(page.data.frozen, true);
    const original = runtime.pendingAdminDiscussionRemoval.load(accountId);
    page.onUnload();
    managementUnavailable = true;
    login(id(4));
    page = mount();
    await flush();
    assert.equal(page.data.pendingRequestId, '');
    page.onUnload();
    login();
    const beforeRecovery = requests.length;
    page = mount();
    await flush();
    assert.equal(page.data.pendingRequestId, original.command.clientRequestId);
    page.onRecover();
    await flush();
    assert.equal(runtime.pendingAdminDiscussionRemoval.load(accountId), null);
    assert.equal(writes, 2);
    assert.ok(
      requests
        .slice(beforeRecovery)
        .every((r) => r.path.includes('/requests/')),
    );
    page.onUnload();
    managementUnavailable = false;

    page = mount('admin-discussion-removal', { kind, id: id(12) });
    await flush();
    await confirm(page);
    dropBeforeRecord = true;
    page.onSubmit();
    await flush();
    const unrecorded = runtime.pendingAdminDiscussionRemoval.load(accountId);
    page.onRecover();
    await flush();
    assert.equal(page.data.frozen, true);
    assert.equal(
      page.data.pendingRequestId,
      unrecorded.command.clientRequestId,
    );
    page.onCancelRequest();
    page.onConfirmCancel();
    await flush();
    assert.equal(
      receipts.get(unrecorded.command.clientRequestId).code,
      'ADMIN_DISCUSSION_REMOVAL_CANCELLED',
    );
    assert.equal(writes, 2);
    page.onUnload();

    page = mount('admin-discussion-removal', { kind, id: id(13) });
    await flush();
    await confirm(page);
    targetVersion = 'b'.repeat(64);
    page.onSubmit();
    await flush();
    assert.match(page.data.receiptStatus, /评论\/回复状态已变化/);
    assert.equal(writes, 2);
    page.onUnload();

    assert.equal(
      notices.length,
      0,
      'Ordinary discussion removal sends no system notices',
    );
    const noticesPage = mount('system-notices');
    await flush();
    assert.equal(noticesPage.data.items.length, 4);
    assert.deepEqual(
      noticesPage.data.items.map((item) => item.kind),
      older.map((item) => item.kind),
    );
  } finally {
    for (const page of pages) page.onUnload?.();
    globalThis.Page = previous.Page;
    globalThis.getApp = previous.getApp;
    globalThis.wx = previous.wx;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await smokeAdminDiscussionRemoval({
    dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
  });
  console.log(
    'Emitted admin discussion removal smoke passed for root and reply (synthetic transport/WXML model; not device/PG acceptance)',
  );
}
