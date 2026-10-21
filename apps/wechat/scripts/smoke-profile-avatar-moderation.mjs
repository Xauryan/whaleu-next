import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, render } from './smoke-ratings.mjs';
import { createNativePressBridge } from '../test/native-press-emitted-harness.mjs';
const require = createRequire(import.meta.url);

/** Emitted App runtime/Page/HTTP/WXML-model lifecycle with synthetic authority.
 * This is not a real device, production source or PostgreSQL acceptance test. */
export async function smokeProfileAvatarModeration({ dist }) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { ApiClient } = emitted('api/client');
  const { ClientError } = emitted('api/errors');
  const { SessionStore } = emitted('auth/session');
  const { createCommunityRuntime } = emitted('community/runtime');
  const id = (n) => `${String(n).padStart(8, '0')}-ca71-4ca7-8ca7-ca71ca71ca71`;
  const accountId = id(1),
    targetId = id(2),
    origin = 'https://profile-avatar-moderation.example';
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), {
    accountId,
    sessionId: id(3),
    accessToken: `wu_a_${'a'.repeat(43)}`,
    refreshToken: `wu_r_${'b'.repeat(43)}`,
    expiresAt: 1900000000000,
    refreshExpiresAt: 1900600000000,
  });
  const storage = new Map(),
    receipts = new Map(),
    requests = [],
    notices = [];
  const native = {
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: (key) => storage.delete(key),
  };
  let appearanceId = id(90);
  let revision = 0,
    counter = 100,
    writes = 0,
    runtime;
  let loseAfterCommit = false,
    dropBeforeRecord = false,
    managementUnavailable = false;
  const displayName = '合成公开昵称';
  const createdAt = '2026-10-12T00:00:00.000Z';
  const transport = {
    async send(request) {
      const url = new URL(request.url);
      assert.equal(url.origin, origin);
      assert.ok(request.headers.Authorization);
      requests.push({
        method: request.method,
        path: url.pathname,
        body: request.body,
      });
      let body;
      if (
        url.pathname === '/v1/community/profile-avatar-moderation/management'
      ) {
        assert.equal(request.method, 'GET');
        assert.deepEqual([...url.searchParams.keys()].sort(), ['id', 'kind']);
        if (managementUnavailable)
          throw new ClientError('http', 'Synthetic authority unavailable');
        body = {
          target: {
            kind: url.searchParams.get('kind'),
            id: url.searchParams.get('id'),
          },
          displayName,
          revision,
          canClearCustomAvatar: appearanceId !== null,
          expectedAppearanceId: appearanceId,
        };
      } else if (
        url.pathname === '/v1/community/profile-avatar-moderation/commands' ||
        url.pathname ===
          '/v1/community/profile-avatar-moderation/commands/cancel'
      ) {
        assert.equal(request.method, 'POST');
        const command = request.body,
          cancelling = url.pathname.endsWith('/cancel');
        const pending = runtime.pendingProfileAvatarModeration.load(accountId);
        assert.deepEqual(
          pending.command,
          command,
          'Read-back durable original exists before every send',
        );
        assert.equal(pending.phase, cancelling ? 'cancel' : 'submit');
        assert.deepEqual(Object.keys(command).sort(), [
          'action',
          'clientRequestId',
          'expectedAppearanceId',
          'expectedProfileRevision',
          'target',
        ]);
        assert.deepEqual(Object.keys(command.target).sort(), ['id', 'kind']);
        if (dropBeforeRecord) {
          dropBeforeRecord = false;
          throw new ClientError('timeout', 'No recorded request yet');
        }
        body = receipts.get(command.clientRequestId);
        if (!body) {
          const metadata = {
            requestId: command.clientRequestId,
            target: command.target,
            expectedProfileRevision: command.expectedProfileRevision,
            expectedAppearanceId: command.expectedAppearanceId,
            action: 'clear_custom_avatar',
          };
          if (cancelling)
            body = {
              ...metadata,
              outcome: 'rejected',
              code: 'PROFILE_AVATAR_MODERATION_CANCELLED',
            };
          else if (
            revision !== command.expectedProfileRevision ||
            appearanceId !== command.expectedAppearanceId
          )
            body = {
              ...metadata,
              outcome: 'rejected',
              code: 'PROFILE_AVATAR_MODERATION_STALE',
            };
          else {
            writes++;
            revision++;
            appearanceId = null;
            body = {
              ...metadata,
              outcome: 'applied',
              revision,
              eventId: id(counter++),
              recordedAt: createdAt,
            };
            notices.push({
              noticeId: id(counter++),
              kind: 'profile_custom_avatar_cleared',
              createdAt,
              readAt: null,
            });
          }
          receipts.set(command.clientRequestId, body);
        }
        if (loseAfterCommit) {
          loseAfterCommit = false;
          throw new ClientError('timeout', 'Committed response lost');
        }
      } else if (
        url.pathname.startsWith(
          '/v1/community/profile-avatar-moderation/requests/',
        )
      ) {
        assert.equal(request.method, 'GET');
        const found = receipts.get(url.pathname.split('/').at(-1));
        body = found
          ? { state: 'recorded', receipt: found }
          : { state: 'not_recorded' };
      } else if (url.pathname === '/v1/me/system-notices') {
        body = {
          items: [
            {
              noticeId: id(50),
              kind: 'post_jury_removed',
              createdAt,
              readAt: null,
              keepVotes: 5,
              removeVotes: 6,
            },
            ...notices,
          ],
          nextCursor: null,
          unreadCount: 1 + notices.filter((n) => !n.readAt).length,
        };
      } else if (
        url.pathname.match(/^\/v1\/me\/system-notices\/[^/]+\/read$/)
      ) {
        assert.equal(request.method, 'PUT');
        const notice = notices.find(
          (n) => n.noticeId === url.pathname.split('/').at(-2),
        );
        assert.ok(notice);
        notice.readAt = createdAt;
        body = {
          noticeId: notice.noticeId,
          readAt: createdAt,
          unreadCount: 1 + notices.filter((n) => !n.readAt).length,
        };
      } else
        throw new Error(
          `Unexpected profile-avatar-moderation smoke route: ${url.pathname}`,
        );
      return { status: 200, headers: {}, body };
    },
  };
  const api = new ApiClient(origin, transport, sessions, {
    refresh: async () => {
      throw new Error('No automatic auth replay');
    },
  });
  runtime = createCommunityRuntime({ api, sessions }, native, origin);
  runtime.newRequestId = async () => id(counter++);
  const app = { community: runtime, identity: { api, sessions } };
  const originalPage = globalThis.Page,
    originalApp = globalThis.getApp;
  const pages = [];
  const flush = async () => {
    for (let n = 0; n < 120; n++) await Promise.resolve();
  };
  const mount = (name = 'profile-avatar-moderation', query = {}) => {
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
    page.onShow();
    return page;
  };
  // Actual emitted Component → Page event boundary; native fields and direct
  // invalid/double-submit probes below intentionally retain controller coverage.
  const moderationBridges = new WeakMap();
  const nativePress = (page, handler) => {
    let bridge = moderationBridges.get(page);
    if (!bridge) {
      bridge = createNativePressBridge({
        page,
        pageFile: path.join(
          dist,
          'pages/profile-avatar-moderation/profile-avatar-moderation',
        ),
        dist,
      });
      moderationBridges.set(page, bridge);
    }
    const capture = bridge.capture(handler);
    assert.equal(capture.press(), true, `Native management press ${handler}`);
    capture.detach();
  };
  const flatten = (nodes) =>
    nodes.flatMap((node) =>
      typeof node === 'string' ? [node] : [node, ...flatten(node.children)],
    );
  try {
    globalThis.getApp = () => app;
    const template = parse(
      readFileSync(
        path.join(
          dist,
          'pages/profile-avatar-moderation/profile-avatar-moderation.wxml',
        ),
        'utf8',
      ),
    );
    assert.ok(
      JSON.parse(
        readFileSync(path.join(dist, 'app.json'), 'utf8'),
      ).pages.includes(
        'pages/profile-avatar-moderation/profile-avatar-moderation',
      ),
    );
    for (const kind of ['post', 'comment', 'reply']) {
      // A fresh owner selection is synthetic only in this transport smoke.
      appearanceId = id(counter++);
      const page = mount('profile-avatar-moderation', { kind, id: targetId });
      await flush();
      assert.equal(page.data.management.target.kind, kind);
      nativePress(page, 'onClearCustomAvatar');
      await flush();
      assert.equal(page.data.confirming, 'clear');
      const rendered = flatten(render(template.children, page.data, {}));
      assert.ok(
        rendered.some(
          (node) =>
            typeof node === 'string' &&
            node.includes('包括其他地区的非分身头像展示'),
        ),
      );
      assert.ok(
        rendered.some(
          (node) => typeof node === 'string' && node.includes('分身保持不变'),
        ),
      );
      nativePress(page, 'onSubmit');
      page.onSubmit();
      await flush();
      assert.equal(page.data.frozen, false);
      assert.equal(
        runtime.pendingProfileAvatarModeration.load(accountId),
        null,
      );
      page.onHide();
      assert.equal(page.controller, undefined);
      assert.equal(page.data.management, null);
    }
    assert.equal(writes, 3);
    appearanceId = id(counter++);
    let page = mount('profile-avatar-moderation', {
      kind: 'post',
      id: targetId,
    });
    await flush();
    nativePress(page, 'onClearCustomAvatar');
    await flush();
    loseAfterCommit = true;
    page.onSubmit();
    await flush();
    assert.equal(writes, 4);
    assert.equal(page.data.frozen, true);
    const original = runtime.pendingProfileAvatarModeration.load(accountId);
    assert.equal(page.data.management, null);
    page.onUnload();
    managementUnavailable = true;
    const beforeRecovery = requests.length;
    page = mount();
    await flush();
    assert.equal(page.data.pendingRequestId, original.command.clientRequestId);
    nativePress(page, 'onRecover');
    await flush();
    assert.equal(runtime.pendingProfileAvatarModeration.load(accountId), null);
    assert.equal(writes, 4);
    assert.ok(
      requests
        .slice(beforeRecovery)
        .every((request) => request.path.includes('/requests/')),
    );
    page.onUnload();
    managementUnavailable = false;
    appearanceId = id(counter++);
    page = mount('profile-avatar-moderation', { kind: 'reply', id: targetId });
    await flush();
    nativePress(page, 'onClearCustomAvatar');
    await flush();
    dropBeforeRecord = true;
    page.onSubmit();
    await flush();
    const unrecorded = runtime.pendingProfileAvatarModeration.load(accountId);
    nativePress(page, 'onRecover');
    await flush();
    assert.equal(page.data.frozen, true);
    assert.equal(
      runtime.pendingProfileAvatarModeration.load(accountId).command
        .clientRequestId,
      unrecorded.command.clientRequestId,
    );
    nativePress(page, 'onCancelRequest');
    assert.equal(page.data.confirming, 'cancel');
    nativePress(page, 'onConfirmCancel');
    await flush();
    assert.equal(page.data.frozen, false);
    assert.equal(writes, 4);
    assert.equal(
      receipts.get(unrecorded.command.clientRequestId).code,
      'PROFILE_AVATAR_MODERATION_CANCELLED',
    );
    page.onUnload();
    appearanceId = null;
    const nonePage = mount('profile-avatar-moderation', {
      kind: 'post',
      id: targetId,
    });
    await flush();
    assert.equal(nonePage.data.management.canClearCustomAvatar, false);
    nonePage.onClearCustomAvatar();
    await flush();
    assert.equal(nonePage.data.confirming, null);
    assert.equal(writes, 4);
    nonePage.onUnload();
    const noticePage = mount('system-notices');
    await flush();
    assert.equal(noticePage.data.items.length, 5);
    const noticeTemplate = parse(
      readFileSync(
        path.join(dist, 'pages/system-notices/system-notices.wxml'),
        'utf8',
      ),
    );
    const onlyReset = {
      ...noticePage.data,
      items: [
        noticePage.data.items.find(
          (item) => item.key === `system:${notices[0].noticeId}`,
        ),
      ],
    };
    const resetText = flatten(render(noticeTemplate.children, onlyReset, {}))
      .filter((node) => typeof node === 'string')
      .join(' ');
    assert.match(resetText, /自定义头像已被管理员清除/);
    assert.doesNotMatch(resetText, /违规昵称|随机|91/);
    assert.doesNotMatch(resetText, /保留 .*票|移除 .*票/);
    noticePage.onRead({
      currentTarget: { dataset: { id: `system:${notices[0].noticeId}` } },
    });
    await flush();
    assert.equal(
      noticePage.data.items.find(
        (item) => item.key === `system:${notices[0].noticeId}`,
      ).readAt,
      createdAt,
    );
    assert.equal(
      noticePage.data.items.find(
        (item) => item.key === `system:${notices[1].noticeId}`,
      ).readAt,
      null,
    );
  } finally {
    for (const page of pages) page.onUnload?.();
    globalThis.Page = originalPage;
    globalThis.getApp = originalApp;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await smokeProfileAvatarModeration({
    dist: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'),
  });
  console.log(
    'Emitted profile avatar moderation smoke passed (synthetic transport/WXML model; not device/PG acceptance)',
  );
}
