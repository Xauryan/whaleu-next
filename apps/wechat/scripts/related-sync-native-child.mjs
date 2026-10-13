/**
 * Actual emitted App/Page/WXML -> production WechatTransport -> loopback HTTP.
 * The parent owns a normal AppModule and PostgreSQL fixtures. Only wx platform
 * callbacks and one deliberately lost, already committed response are synthetic.
 * This is an emitted native journey, not DevTools or physical-device acceptance.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mountEmittedPage } from '../test/text-review-emitted-harness.mjs';

const require = createRequire(import.meta.url);
const dist = path.resolve(
  process.env.WHALEU_WECHAT_DIST ??
    fileURLToPath(new URL('../dist/', import.meta.url)),
);
const emitted = (name) => require(path.join(dist, `${name}.js`));
const {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
} = require('../../api/test/support/experience-native-bridge.ts');
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
let checkpointId = 0;
async function checkpoint(name, extra = {}) {
  const id = ++checkpointId;
  const response = new Promise((resolve) => {
    const listener = (value) => {
      if (value.event === 'continue' && value.checkpointId === id) {
        process.off('message', listener);
        resolve(value);
      }
    };
    process.on('message', listener);
  });
  await send({ event: 'checkpoint', name, checkpointId: id, ...extra });
  const answer = await response;
  assert.equal(answer.name, name);
  return answer;
}
let diagnostics = () => ({});
async function until(check, label, h) {
  const deadline = Date.now() + 25000;
  while (!check()) {
    assert.ok(
      Date.now() < deadline,
      `${label}: ${JSON.stringify({ view: h?.page.data, ...diagnostics() })}`,
    );
    await delay(10);
  }
}
const renderedText = (h) =>
  h
    .nodes()
    .filter((node) => typeof node === 'string')
    .join('');
const bound = (h, binding, handler) =>
  h
    .nodes()
    .filter(
      (node) => typeof node !== 'string' && node.attrs[binding] === handler,
    );
const navigator = (h, predicate) => {
  const node = h
    .nodes()
    .find(
      (item) =>
        typeof item !== 'string' &&
        item.tag === 'navigator' &&
        typeof item.attrs.url === 'string' &&
        predicate(item.attrs.url),
    );
  assert.ok(node, 'The actual WXML exposes the intended navigation');
  return node.attrs.url;
};
const route = (url) => {
  const parsed = new URL(url, 'https://native-route.invalid');
  const segments = parsed.pathname.split('/');
  assert.equal(segments[1], 'pages');
  assert.equal(segments[2], segments[3]);
  return { name: segments[2], query: Object.fromEntries(parsed.searchParams) };
};

process.once('message', async (input) => {
  let app;
  const pages = new Set();
  try {
    const { actors, scope } = input;
    const { home, related, foreign } = scope;
    const queryText = input.queryText ?? 'related native golden text';
    const transport = new NativeExperienceTransport(input.port);
    const platform = platformStorage();
    const calls = [],
      commands = [],
      publicationRequests = [],
      navigations = [];
    const policyCommands = [],
      pinCommands = [],
      removalCommands = [];
    let bridgeFailure = null;
    diagnostics = () => ({
      calls: calls.slice(-12),
      exchanges: transport.exchanges.slice(-12),
      bridgeFailure: bridgeFailure?.message,
    });
    const wx = {
      ...platform,
      nextTick: queueMicrotask,
      navigateTo(options) {
        navigations.push(options.url);
        options.success?.();
      },
      request(options) {
        const url = new URL(options.url);
        const requestPath = url.pathname;
        calls.push({
          path: `${requestPath}${url.search}`,
          method: options.method,
        });
        try {
          const body = options.data;
          const actorId =
            app.identity.sessions.snapshot().credentials?.accountId;
          if (options.method === 'POST') {
            if (
              requestPath === `/v1/me/school-posting-policy/${home.regionId}`
            ) {
              assert.equal(body.version, 2);
              assert.equal(body.policy.relatedSyncEnabled, true);
              assert.deepEqual(body.policy.expiry, { kind: 'policy_exempt' });
              assert.equal(actorId, actors.adminA.accountId);
              policyCommands.push(structuredClone(body));
              commands.push({
                kind: 'posting_policy',
                ...structuredClone(body),
              });
            }
            if (
              requestPath === '/v1/community/reviews/posts' ||
              /^\/v1\/community\/reviews\/(posts|comments)\/[^/]+\/(comments|replies)$/.test(
                requestPath,
              ) ||
              requestPath === '/v1/community/posts' ||
              /^\/v1\/community\/(posts|comments)\/[^/]+\/(comments|replies)$/.test(
                requestPath,
              )
            ) {
              const durable = app.community.pending.load(actorId);
              assert.ok(
                durable,
                'Publication intent is durable before native dispatch',
              );
              assert.equal(
                body.clientRequestId,
                durable.payload.clientRequestId,
              );
              assert.equal(body.text, durable.payload.text);
              assert.equal(body.authorMode, 'named');
              if (durable.operation === 'publish_post') {
                assert.equal(body.syncToRelatedCampuses, true);
                assert.equal(body.spaceId, home.spaceId);
              } else {
                assert.equal(durable.viewSpaceId, related.spaceId);
                assert.equal(durable.postId, postId);
              }
              publicationRequests.push({
                path: requestPath,
                operation: durable.operation,
                requestId: body.clientRequestId,
                viewSpaceId: durable.viewSpaceId,
                postId: durable.postId,
                rootCommentId: durable.rootCommentId,
                syncToRelatedCampuses: body.syncToRelatedCampuses === true,
              });
            }
            if (requestPath === '/v1/community/post-pin-commands') {
              const durable = app.community.pendingPostPins.load(actorId);
              assert.deepEqual(durable.command, body);
              assert.equal(body.version, 2);
              assert.equal(body.spaceId, related.spaceId);
              assert.equal(body.postId, postId);
              pinCommands.push(structuredClone(body));
              commands.push({ kind: 'pin', ...structuredClone(body) });
            }
            if (
              requestPath === '/v1/community/admin-post-removal/commands' ||
              requestPath === '/v1/community/admin-discussion-removal/commands'
            ) {
              const store = requestPath.includes('admin-post-removal')
                ? app.community.pendingAdminPostRemoval
                : app.community.pendingAdminDiscussionRemoval;
              assert.deepEqual(store.load(actorId).command, body);
              assert.equal(actorId, actors.adminB.accountId);
              assert.equal(body.version, 3);
              assert.equal(body.viewSpaceId, related.spaceId);
              assert.equal('punishment' in body, false);
              assert.deepEqual(Object.keys(body).sort(), [
                'action',
                'clientRequestId',
                'expectedTargetVersion',
                'target',
                'version',
                'viewSpaceId',
              ]);
              removalCommands.push(structuredClone(body));
              commands.push({ kind: 'removal', ...structuredClone(body) });
            }
            assert.ok(
              !/\/(profile-moderation|profile-avatar-moderation)\/commands/.test(
                requestPath,
              ) && requestPath !== '/v1/community/category-commands',
              'Unsupported profile/avatar/category controls must not issue commands',
            );
          }
        } catch (error) {
          bridgeFailure = error;
          throw error;
        }
        transport
          .send({
            url: options.url,
            method: options.method,
            headers: options.header,
            body: options.data,
            timeoutMs: options.timeout,
          })
          .then(
            (response) =>
              options.success({
                statusCode: response.status,
                header: response.headers,
                data: response.body,
              }),
            () => options.fail({ errMsg: 'request:fail native loopback' }),
          );
        // Platform cancellation can be uncooperative. The real runtime must fence owners.
        return { abort() {} };
      },
    };
    function boot() {
      emitted('config').clientConfiguration = Object.freeze({
        apiOrigin: nativeOrigin,
        providerLoginEnabled: true,
      });
      globalThis.wx = wx;
      globalThis.App = (value) => {
        app = value;
      };
      globalThis.getApp = () => app;
      delete require.cache[require.resolve(path.join(dist, 'app.js'))];
      emitted('app');
      assert.ok(app, 'The actual emitted entrypoint calls App');
      app.onLaunch();
      assert.ok(app.identity.api && app.community.gateway);
    }
    const login = (actor) =>
      app.identity.sessions.completeLogin(
        app.identity.sessions.beginLogin(),
        actor,
      );
    function mount(name, query = {}) {
      const h = mountEmittedPage(name, app, wx);
      pages.add(h);
      h.page.onLoad?.(query);
      h.page.onShow();
      return h;
    }
    function follow(url) {
      const selected = route(url);
      return mount(selected.name, selected.query);
    }
    function close(h) {
      h.page.onHide?.();
      h.page.onUnload?.();
      pages.delete(h);
    }
    const loaded = (h, label) =>
      until(() => !h.page.data.busy && h.page.data.loaded, label, h);
    let postId = '',
      requestId = '',
      rootCommentId = '',
      replyId = '',
      pinId = '';
    function assertDisplay(value, synced) {
      assert.ok(value);
      assert.equal(
        value.id ?? value.contentId,
        postId,
        'One canonical root ID',
      );
      assert.equal(
        value.space.id,
        home.spaceId,
        'Canonical owning space never changes',
      );
      assert.equal(value.isRelatedCampusSync, synced);
      if (synced) {
        assert.deepEqual(Object.keys(value.sourceRegion).sort(), [
          'id',
          'name',
        ]);
        assert.equal(value.sourceRegion.id, home.regionId);
        assert.ok(value.sourceRegion.name.length > 0);
      } else assert.equal('sourceRegion' in value, false);
      for (const key of [
        'accountId',
        'authorAccountId',
        'identityCampusId',
        'management',
        'punishmentOptions',
      ])
        assert.equal(key in value, false, `Public root excludes ${key}`);
    }
    const assertBadge = (h, value) => {
      assert.match(renderedText(h), /关联学校同步/);
      assert.ok(renderedText(h).includes(value.sourceRegion.name));
    };
    async function detail(selected, available = true) {
      const h = mount('community-detail', {
        postId,
        viewSpaceId: selected.spaceId,
      });
      if (available) {
        await until(
          () =>
            !h.page.data.busy &&
            h.page.data.loaded &&
            h.page.data.post?.id === postId,
          'visible canonical detail',
          h,
        );
        assertDisplay(h.page.data.post, selected.spaceId !== home.spaceId);
        if (selected.spaceId !== home.spaceId) assertBadge(h, h.page.data.post);
      } else {
        await until(
          () => !h.page.data.busy && !h.page.data.post && !!h.page.data.error,
          'withdrawn detail has no stale root',
          h,
        );
        assert.equal(h.page.data.comments.length, 0);
        assert.equal(h.button('bindtap', 'onLike'), undefined);
      }
      return h;
    }
    async function feed(selected, available, exactCategory = false) {
      const h = mount('community-feed');
      await loaded(h, 'feed campus catalog');
      if (h.page.data.campusId !== selected.campusId) {
        h.tap('onCampus', { id: selected.campusId });
        await until(
          () =>
            !h.page.data.busy &&
            h.page.data.loaded &&
            h.page.data.space?.id === selected.spaceId,
          'selected regional feed',
          h,
        );
      }
      assert.equal(h.page.data.space?.id, selected.spaceId);
      if (exactCategory) {
        h.tap('onCategory', { key: 'discussion' });
        await until(
          () =>
            !h.page.data.busy &&
            h.page.data.loaded &&
            h.page.data.category === 'discussion',
          'exact category feed',
          h,
        );
      }
      await until(
        () =>
          !h.page.data.postPin.busy &&
          (h.page.data.postPin.loaded || !!h.page.data.postPin.error),
        'pin projection',
        h,
      );
      const seen = [...h.page.data.posts];
      if (h.page.data.postPin.item) seen.push(h.page.data.postPin.item.post);
      const deadline = Date.now() + 25000;
      while (
        (!available || !seen.some((post) => post.id === postId)) &&
        h.page.data.canLoadMore
      ) {
        assert.ok(Date.now() < deadline, 'Bounded real feed traversal');
        h.tap('onMore');
        await loaded(h, 'next feed page');
        seen.push(...h.page.data.posts);
      }
      const found = seen.find((post) => post.id === postId);
      if (available) {
        assertDisplay(found, selected.spaceId !== home.spaceId);
        if (selected.spaceId !== home.spaceId) assertBadge(h, found);
      } else {
        assert.equal(
          found,
          undefined,
          'Unavailable destination excludes the root',
        );
        assert.equal(h.page.data.postPin.item?.post.id === postId, false);
      }
      return h;
    }
    async function search(selected, available) {
      const h = mount('community-search', {
        campusId: selected.campusId,
        spaceId: selected.spaceId,
        type: 'post',
      });
      await until(
        () => !h.page.data.busy && h.page.data.scopeLoaded,
        'explicit keyword search scope',
        h,
      );
      h.event('bindinput', 'onInput', { value: queryText });
      h.tap('onSubmit');
      await loaded(h, 'real keyword results');
      const seen = [...h.page.data.hits];
      const deadline = Date.now() + 25000;
      while (
        (!available || !seen.some((hit) => hit.contentId === postId)) &&
        h.page.data.canNext
      ) {
        assert.ok(Date.now() < deadline, 'Bounded real search traversal');
        h.tap('onNext');
        await loaded(h, 'next keyword page');
        seen.push(...h.page.data.hits);
      }
      const found = seen.find((hit) => hit.contentId === postId);
      if (available) {
        assertDisplay(found, selected.spaceId !== home.spaceId);
        if (selected.spaceId !== home.spaceId) assertBadge(h, found);
        const before = navigations.length;
        h.tap('onHit', { kind: 'post', id: postId });
        await until(
          () => navigations.length > before,
          'real search-hit navigation',
          h,
        );
        assert.equal(route(navigations.at(-1)).query.postId, postId);
        assert.equal(
          route(navigations.at(-1)).query.viewSpaceId,
          selected.spaceId,
        );
      } else
        assert.equal(
          found,
          undefined,
          'Withdrawn destination search excludes root',
        );
      close(h);
    }
    async function hot(selected, available) {
      const h = mount('community-hot', {
        spaceId: selected.spaceId,
        range: 'history',
      });
      await loaded(h, 'materialized real hot feed');
      const seen = [...h.page.data.posts];
      const deadline = Date.now() + 25000;
      while (
        (!available || !seen.some((post) => post.id === postId)) &&
        h.page.data.canNext
      ) {
        assert.ok(Date.now() < deadline, 'Bounded real hot traversal');
        h.tap('onNext');
        await loaded(h, 'next hot page');
        seen.push(...h.page.data.posts);
      }
      const found = seen.find((post) => post.id === postId);
      if (available) {
        assertDisplay(found, selected.spaceId !== home.spaceId);
        if (selected.spaceId !== home.spaceId) assertBadge(h, found);
      } else
        assert.equal(
          found,
          undefined,
          'Withdrawn destination hot excludes root',
        );
      close(h);
    }
    async function publishChild(query, text, operation) {
      const h = mount('community-compose', query);
      await loaded(h, 'scoped discussion composer');
      assert.equal(h.page.data.viewSpaceId, related.spaceId);
      if (h.page.data.authorMode !== 'named')
        h.tap('onMode', { mode: 'named' });
      h.event('bindinput', 'onText', { value: text });
      h.tap('onSubmit');
      await until(
        () =>
          !h.page.data.busy &&
          h.page.data.frozen &&
          h.page.data.reviewStatus === 'pending',
        'discussion review remains pending',
        h,
      );
      const frozen = structuredClone(
        app.community.pending.load(actors.reader.accountId),
      );
      assert.equal(frozen.operation, operation);
      assert.equal(frozen.viewSpaceId, related.spaceId);
      assert.equal(frozen.postId, postId);
      assert.equal(frozen.payload.text, text);
      await checkpoint('approve-child', {
        accountId: actors.reader.accountId,
        requestId: frozen.payload.clientRequestId,
        operation,
      });
      h.tap('onRetry');
      await until(
        () =>
          !h.page.data.busy && !h.page.data.frozen && !!h.page.data.resourceId,
        'exact reviewed discussion publication',
        h,
      );
      assert.equal(h.page.data.resourcePostId, postId);
      assert.equal(app.community.pending.load(actors.reader.accountId), null);
      assert.ok(
        navigator(h, (url) => url.includes(`viewSpaceId=${related.spaceId}`)),
      );
      const id = h.page.data.resourceId;
      close(h);
      return id;
    }

    boot();
    login(actors.adminA);
    let h = mount('school-posting-policy', { regionId: home.regionId });
    await until(
      () =>
        !h.page.data.busy &&
        h.page.data.loaded &&
        h.page.data.editable &&
        !!h.page.data.form,
      'origin school policy editable',
      h,
    );
    const oldRevision = h.page.data.revision;
    h.event(
      'bindchange',
      'onSwitch',
      { value: true },
      { field: 'relatedSyncEnabled' },
    );
    h.event('bindchange', 'onExpiryKind', { value: 'policy_exempt' });
    h.tap('onSave');
    await until(
      () =>
        !h.page.data.busy &&
        !h.page.data.pending &&
        /已保存为版本/.test(h.page.data.status),
      'native policy save receipt',
      h,
    );
    h.tap('onRefresh');
    await loaded(h, 'policy reread');
    assert.equal(h.page.data.revision, oldRevision + 1);
    assert.equal(h.page.data.form.relatedSyncEnabled, true);
    assert.equal(policyCommands.length, 1);
    close(h);

    login(actors.publisher);
    h = mount('identity-campus');
    await loaded(h, 'publisher identity campus options');
    assert.equal(h.page.data.state.selectedCampus, null);
    h.tap('onChoose', { id: home.campusId });
    h.tap('onRequestConfirmation');
    assert.equal(h.page.data.confirmation.id, home.campusId);
    h.tap('onConfirm');
    await until(
      () =>
        !h.page.data.busy &&
        !h.page.data.frozen &&
        h.page.data.state?.selectedCampus?.id === home.campusId,
      'explicit publisher identity campus saved',
      h,
    );
    close(h);

    const originalRoute = {
      spaceId: home.spaceId,
      category: 'discussion',
      viewSpaceId: home.spaceId,
    };
    h = mount('community-compose', originalRoute);
    await loaded(h, 'root composer eligibility');
    assert.equal(h.page.data.syncToRelatedCampuses, false);
    assert.equal(h.page.data.canChooseRelatedCampusSync, true);
    if (h.page.data.authorMode !== 'named') h.tap('onMode', { mode: 'named' });
    if (h.page.data.allowAnonymousDm)
      h.event('bindchange', 'onAllowAnonymousDm', { value: false });
    h.event('bindinput', 'onText', { value: queryText });
    h.event('bindchange', 'onRelatedCampusSync', { value: true });
    assert.equal(h.page.data.syncToRelatedCampuses, true);
    h.tap('onSubmit');
    await until(
      () =>
        !h.page.data.busy &&
        h.page.data.frozen &&
        h.page.data.reviewStatus === 'pending',
      'root review pending',
      h,
    );
    const original = structuredClone(
      app.community.pending.load(actors.publisher.accountId),
    );
    requestId = original.payload.clientRequestId;
    assert.equal(original.payload.syncToRelatedCampuses, true);
    assert.equal(original.viewSpaceId, home.spaceId);
    assert.equal(original.payload.authorMode, 'named');
    assert.equal(
      calls.filter(
        (call) => call.path === '/v1/community/posts' && call.method === 'POST',
      ).length,
      0,
      'Pending Review cannot publish',
    );
    await checkpoint('approve-root', {
      accountId: actors.publisher.accountId,
      requestId,
    });
    transport.dropSuccess = { path: '/v1/community/posts', method: 'POST' };
    h.tap('onRetry');
    await until(
      () =>
        !h.page.data.busy &&
        h.page.data.frozen &&
        transport.dropSuccess === null,
      'committed publication response lost',
      h,
    );
    assert.deepEqual(
      app.community.pending.load(actors.publisher.accountId),
      original,
    );
    close(h);
    assert.equal(
      h.page.data.text,
      '',
      'Hidden composer clears private display',
    );
    app.onHide();
    login(actors.reader);
    boot();
    assert.equal(
      app.identity.sessions.snapshot().credentials.accountId,
      actors.reader.accountId,
    );
    h = mount('community-compose');
    await loaded(h, 'replacement account has no original draft');
    assert.equal(h.page.data.frozen, false);
    assert.equal(h.page.data.text, '');
    assert.equal(app.community.pending.load(actors.reader.accountId), null);
    close(h);
    app.onHide();
    login(actors.publisher);
    boot();
    h = mount('community-compose', originalRoute);
    await until(
      () => !h.page.data.busy && h.page.data.frozen,
      'cold reopen restores original account request',
      h,
    );
    assert.deepEqual(
      app.community.pending.load(actors.publisher.accountId),
      original,
    );
    assert.equal(h.page.data.syncToRelatedCampuses, true);
    h.tap('onReceipt');
    await until(
      () =>
        !h.page.data.busy &&
        !h.page.data.frozen &&
        !!h.page.data.resourcePostId,
      'original receipt recovers canonical root',
      h,
    );
    postId = h.page.data.resourcePostId;
    assert.equal(app.community.pending.load(actors.publisher.accountId), null);
    assert.equal(
      calls.filter(
        (call) => call.path === '/v1/community/posts' && call.method === 'POST',
      ).length,
      1,
      'Cold recovery never republishes',
    );
    close(h);
    await checkpoint('published', { postId, requestId });

    login(actors.reader);
    h = await feed(related, true);
    const detailUrl = navigator(
      h,
      (url) =>
        url.includes(`postId=${postId}`) &&
        url.includes(`viewSpaceId=${related.spaceId}`),
    );
    close(h);
    h = follow(detailUrl);
    await loaded(h, 'feed navigator preserves destination detail');
    assertDisplay(h.page.data.post, true);
    assertBadge(h, h.page.data.post);
    close(h);
    close(await feed(related, true, true));
    await search(related, true);
    await hot(related, true);
    close(await detail(home));
    close(await feed(foreign, false));

    h = await detail(related);
    const commentRoute = route(
      navigator(
        h,
        (url) =>
          url.startsWith('/pages/community-compose/') &&
          !url.includes('copyCommentId=') &&
          url.includes(`postId=${postId}`),
      ),
    );
    assert.equal(commentRoute.query.viewSpaceId, related.spaceId);
    close(h);
    rootCommentId = await publishChild(
      commentRoute.query,
      'related native golden comment',
      'publish_comment',
    );
    h = await detail(related);
    const threadUrl = navigator(
      h,
      (url) =>
        url.startsWith('/pages/community-thread/') &&
        url.includes(`rootCommentId=${rootCommentId}`),
    );
    close(h);
    h = follow(threadUrl);
    await loaded(h, 'B discussion thread');
    assert.equal(h.page.data.root.id, rootCommentId);
    const replyRoute = route(
      navigator(
        h,
        (url) =>
          url.startsWith('/pages/community-compose/') &&
          url.includes(`rootCommentId=${rootCommentId}`) &&
          !url.includes('targetReplyId=') &&
          !url.includes('copyReplyId='),
      ),
    );
    assert.equal(replyRoute.query.viewSpaceId, related.spaceId);
    close(h);
    replyId = await publishChild(
      replyRoute.query,
      'related native golden reply',
      'publish_reply',
    );
    h = await detail(related);
    assert.ok(
      h.page.data.comments.some((comment) => comment.id === rootCommentId),
    );
    assert.equal(h.page.data.post.viewer.isLiked, false);
    h.tap('onLike');
    await until(
      () =>
        !h.page.data.busy &&
        !h.page.data.postLikeMutation.busy &&
        !h.page.data.postLikeMutation.frozen &&
        h.page.data.post?.viewer.isLiked === true,
      'one shared canonical like',
      h,
    );
    close(h);
    h = await detail(home);
    assert.equal(h.page.data.post.viewer.isLiked, true);
    assert.equal(h.page.data.post.likeCount, 1);
    assert.equal(h.page.data.post.commentCount, 1);
    assert.equal(h.page.data.post.replyCount, 1);
    assert.equal(h.page.data.post.discussionCount, 2);
    const sharedComment = h.page.data.comments.find(
      (comment) => comment.id === rootCommentId,
    );
    assert.ok(sharedComment);
    assert.ok(
      sharedComment.replyPreview.items.some((reply) => reply.id === replyId),
    );
    close(h);

    login(actors.adminB);
    h = await detail(related);
    await until(
      () =>
        !h.page.data.postPin.busy &&
        h.page.data.postPin.loaded &&
        h.page.data.postPin.detail?.canPin,
      'B scoped pin management',
      h,
    );
    h.tap('onPinCreate');
    assert.equal(h.page.data.postPin.confirming, 'pin');
    h.tap('onPinDuration', { hours: '1' });
    h.tap('onPinLevel', { level: '2' });
    h.tap('onPinSubmit');
    await until(
      () =>
        !h.page.data.postPin.busy &&
        !h.page.data.postPin.frozen &&
        !!h.page.data.postPin.detail?.pin,
      'B scoped pin receipt',
      h,
    );
    pinId = h.page.data.postPin.detail.pin.pinId;
    assert.equal(h.page.data.postPin.detail.spaceId, related.spaceId);
    assert.equal(
      pinCommands.filter((command) => command.operation === 'pin').length,
      1,
    );
    await until(
      () =>
        !h.page.data.categoryManagement.busy &&
        !!h.page.data.categoryManagement.management,
      'related root category management',
      h,
    );
    assert.equal(h.page.data.categoryManagement.management.canChange, false);
    assert.equal(
      h.page.data.categoryManagement.management.blocker,
      'related_sync_unsupported',
    );
    assert.equal(h.page.data.categoryManagement.confirming, null);
    assert.equal(bound(h, 'bindtap', 'onCategoryChoose').length, 0);
    close(h);
    for (const [name, control, allowed] of [
      ['profile-moderation', 'onResetNickname', 'canReset'],
      [
        'profile-avatar-moderation',
        'onClearCustomAvatar',
        'canClearCustomAvatar',
      ],
    ]) {
      h = mount(name, { kind: 'post', id: postId });
      await loaded(h, `${name} read-only management`);
      assert.equal(h.page.data.management.availability, 'unavailable');
      assert.equal(h.page.data.management.blocker, 'related_sync_unsupported');
      assert.equal(h.page.data.management[allowed], false);
      assert.equal(h.page.data.confirming, null);
      assert.equal(h.button('bindtap', control), undefined);
      assert.equal(h.button('bindtap', 'onSubmit'), undefined);
      close(h);
    }
    await checkpoint('pinned', { postId, pinId, rootCommentId, replyId });
    login(actors.reader);
    h = await feed(related, true);
    assert.equal(h.page.data.postPin.item.pin.pinId, pinId);
    assert.equal(h.page.data.postPin.item.post.id, postId);
    assert.equal(
      h.page.data.posts.some((post) => post.id === postId),
      false,
      'One pinned root is de-duplicated from ordinary cards',
    );
    close(h);

    await checkpoint('withdraw-b', { postId, pinId });
    close(await feed(related, false));
    await search(related, false);
    await hot(related, false);
    close(await detail(related, false));
    close(await detail(home));
    await checkpoint('add-c', { postId });
    close(await feed(foreign, true));
    close(await feed(foreign, true, true));
    await search(foreign, true);
    await hot(foreign, true);
    close(await detail(foreign));
    close(await feed(related, false));
    close(await detail(home));

    await checkpoint('restore-b', { postId });
    login(actors.adminB);
    async function remove(kind, id) {
      const d = await detail(related);
      if (kind === 'post') d.tap('onAdminPostRemoval');
      else d.tap('onAdminDiscussionRemoval', { kind, id });
      const url = navigations.at(-1);
      assert.equal(route(url).query.kind, kind);
      assert.equal(route(url).query.id, id);
      assert.equal(route(url).query.viewSpaceId, related.spaceId);
      close(d);
      const removal = follow(url);
      await until(
        () =>
          !removal.page.data.busy && removal.page.data.management?.canRemove,
        'current B removal management',
        removal,
      );
      assert.equal(removal.page.data.management.version, 3);
      assert.equal(removal.page.data.management.viewSpaceId, related.spaceId);
      assert.equal('punishmentOptions' in removal.page.data.management, false);
      removal.tap(kind === 'post' ? 'onRemovePost' : 'onRemoveDiscussion');
      await until(
        () =>
          !removal.page.data.busy && removal.page.data.confirming === 'remove',
        'fresh pure removal confirmation',
        removal,
      );
      assert.equal(bound(removal, 'bindchange', 'onPunishmentKind').length, 0);
      assert.match(renderedText(removal), /删除会影响所有地区的同一条内容/);
      removal.tap('onSubmit');
      await until(
        () =>
          !removal.page.data.busy &&
          !removal.page.data.frozen &&
          !!removal.page.data.receiptStatus,
        'exact v3 removal receipt',
        removal,
      );
      assert.equal(removal.page.data.error, '');
      close(removal);
    }
    await remove('reply', replyId);
    h = await detail(home);
    assert.equal(h.page.data.post.replyCount, 0);
    assert.ok(
      h.page.data.comments.some((comment) => comment.id === rootCommentId),
    );
    close(h);
    await remove('comment', rootCommentId);
    h = await detail(home);
    assert.equal(h.page.data.post.commentCount, 0);
    assert.equal(
      h.page.data.comments.some((comment) => comment.id === rootCommentId),
      false,
    );
    close(h);
    await remove('post', postId);
    assert.equal(removalCommands.length, 3);
    assert.deepEqual(
      removalCommands.map((command) => command.target),
      [
        { kind: 'reply', id: replyId },
        { kind: 'comment', id: rootCommentId },
        { kind: 'post', id: postId },
      ],
    );
    await checkpoint('removed', {
      postId,
      requestId,
      rootCommentId,
      replyId,
      pinId,
    });
    login(actors.reader);
    for (const selected of [home, related, foreign]) {
      close(await feed(selected, false));
      close(await detail(selected, false));
    }
    assert.equal(bridgeFailure, null);
    assert.ok(!calls.some((call) => call.path.includes('/identity-view')));
    assert.ok(
      !calls.some((call) => call.path.startsWith('/v1/identity-privacy/')),
      'Ordinary destination moderation never opens private author identity',
    );
    await send({
      event: 'done',
      postId,
      requestId,
      rootCommentId,
      replyId,
      pinId,
      httpCalls: transport.exchanges.length,
      commands: [
        ...commands,
        ...publicationRequests.map((command) => ({
          kind: 'publication',
          ...command,
        })),
      ],
    });
  } catch (error) {
    await send({ event: 'failure', message: error?.stack ?? String(error) });
  } finally {
    for (const h of pages) {
      h.page.onHide?.();
      h.page.onUnload?.();
    }
    app?.onHide?.();
    process.disconnect();
  }
});
