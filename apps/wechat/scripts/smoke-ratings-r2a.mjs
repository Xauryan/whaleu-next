import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';

const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

/** Emitted JS handlers + real ApiClient/strict gateways + bounded WXML evaluation.
 * The business server below is synthetic, with no device, provider, PostgreSQL,
 * account, publication approval, signature, or push integration claim. */
export async function smokeRatingsR2A({ app, dist, flush }) {
  const { ApiClient } = require(path.join(dist, 'api/client.js'));
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const { HttpRatingsGateway } = require(path.join(dist, 'ratings/gateway.js'));
  const { HttpRatingDiscussionGateway } = require(
    path.join(dist, 'ratings/discussion-gateway.js'),
  );
  const { HttpRatingUpdatesGateway } = require(
    path.join(dist, 'ratings/updates-gateway.js'),
  );
  const { PendingRatingStore } = require(path.join(dist, 'ratings/pending.js'));
  const { decodeRatingIntent } = require(
    path.join(dist, 'ratings/contract.js'),
  );
  const { decodeRatingReplyIntent } = require(
    path.join(dist, 'ratings/discussion-contract.js'),
  );
  const original = {
    ratings: app.community.ratings,
    ratingDiscussion: app.community.ratingDiscussion,
    ratingUpdates: app.community.ratingUpdates,
    pendingRatings: app.community.pendingRatings,
    newRequestId: app.community.newRequestId,
    credentials: app.identity.sessions.snapshot().credentials,
    navigateTo: globalThis.wx.navigateTo,
  };
  assert.ok(original.credentials, 'synthetic owner is logged in');
  const id = (n) => `${String(n).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
  const targetId = id(1),
    rootId = id(2),
    categoryId = id(3),
    regionId = id(4),
    revision = id(5),
    nextRevision = id(6),
    firstReply = id(7),
    secondReply = id(8),
    blockedReply = id(9),
    personaId = id(10),
    noticeId = id(11),
    unavailableNotice = id(12),
    otherAccount = id(13),
    otherTarget = id(14),
    otherRoot = id(15);
  const now = '2026-10-09T01:00:00.123456Z',
    rootBody = '合成 R2A 根评价正文',
    firstBody = '合成第一条回复',
    secondBody = '合成保留的后续回复',
    draftBody = '不应恢复的合成回复草稿',
    origin = 'synthetic-ratings-r2a';
  const cursorA = 'a'.repeat(43),
    cursorB = 'b'.repeat(43),
    cursorPosition = 'p'.repeat(43);
  const requests = [],
    commands = [],
    readRequests = [],
    events = [],
    navigation = [],
    stored = new Map(),
    receipts = new Map(),
    pages = [],
    holds = new Map();
  let requestSequence = 100,
    replySequence = 200,
    minted = 0;
  const state = {
    rootActive: true,
    scan: false,
    positionMore: false,
    loseCommand: false,
    missingReceipt: false,
    failStorage: false,
    failReadBack: false,
    failRemove: false,
    reject: null,
    receiptTransform: null,
    wireTransform: null,
    noticeAvailable: true,
    badTarget: false,
    navigationFail: false,
    score: null,
    replies: [],
    read: new Map(),
  };
  const author = (mode = 'anonymous') =>
    mode === 'anonymous'
      ? { mode, targetId, personaId, displayName: '本目标合成回复分身' }
      : {
          mode: 'named',
          profileId: personaId,
          displayName: '合成回复公开姓名',
        };
  const root = () => ({
    id: rootId,
    targetId,
    revision,
    createdAt: now,
    body: rootBody,
    author: author('named'),
    isMine: true,
    allowedActions: { delete: true },
  });
  const target = () => ({
    id: targetId,
    categoryId,
    name: '合成 R2A 评分目标',
    description: '仅用于本地 synthetic smoke',
    revision,
    allowedActions: {
      setScore: true,
      createComment: true,
      authorModes: ['named', 'anonymous'],
    },
  });
  const context = (scope = null) => ({
    regionId: scope,
    catalogRevision: revision,
    targetId,
    rootId,
  });
  const row = (
    replyId,
    body,
    replyTo = null,
    isMine = true,
    canReply = true,
    mode = 'anonymous',
  ) => ({
    id: replyId,
    targetId,
    rootId,
    revision,
    createdAt: now,
    body,
    author: author(mode),
    isMine,
    allowedActions: { reply: canReply, delete: isMine },
    parentId: replyTo,
  });
  const seed = () => {
    state.replies = [
      row(firstReply, firstBody),
      row(secondReply, secondBody, firstReply),
      row(blockedReply, '合成可读但不可互动回复', null, false, false, 'named'),
    ];
    state.rootActive = true;
  };
  seed();
  const project = (item) => {
    const { parentId, ...current } = item;
    const parent = state.replies.find((value) => value.id === parentId);
    return {
      ...current,
      replyTo:
        parentId === null
          ? { kind: 'root' }
          : parent
            ? {
                kind: 'reply',
                status: 'available',
                replyId: parent.id,
                revision: parent.revision,
                author: parent.author,
              }
            : { kind: 'reply', status: 'unavailable' },
    };
  };
  const replyPage = (
    scope = null,
    items = state.replies,
    nextCursor = null,
    continuation = 'end',
  ) => ({
    context: { ...context(scope), order: 'oldest' },
    items: items.map(project),
    nextCursor,
    continuation,
  });
  const locator = () => ({
    regionId: null,
    targetId,
    rootId,
    replyId: secondReply,
  });
  const unreadCount = () => 2 - state.read.size;
  const notice = (currentId = noticeId) => ({
    noticeId: currentId,
    createdAt: now,
    readAt: state.read.get(currentId) ?? null,
    ...(currentId === unavailableNotice || !state.noticeAvailable
      ? { status: 'unavailable' }
      : {
          status: 'available',
          domain: 'ratings',
          kind: 'reply',
          reason: 'direct_reply',
          target: locator(),
          preview: { text: secondBody, author: author() },
        }),
  });
  const ok = (body) => ({
    status: 200,
    headers: { 'cache-control': 'no-store' },
    body,
  });
  const error = (status, code) => ({
    status,
    headers: {},
    body: { error: { code } },
  });
  const waitAt = async (kind, response) => {
    const snapshot = structuredClone(response);
    if (holds.has(kind)) await holds.get(kind).promise;
    events.push(`${kind}:return`);
    return state.wireTransform ? state.wireTransform(kind, snapshot) : snapshot;
  };
  const journalKey = (version, accountId = original.credentials.accountId) =>
    `whaleu.ratings.pending.v${version}:${origin}:${accountId}`;
  const server = async (request) => {
    requests.push(request);
    assert.ok(request.headers.Authorization);
    const url = new URL(request.url),
      pathname = url.pathname,
      scope = url.searchParams.get('regionId');
    if (request.method === 'GET') assert.equal(request.body, undefined);
    if (
      pathname.startsWith('/v1/ratings/requests/') ||
      pathname.startsWith('/v1/ratings/reply-requests/')
    ) {
      const requestId = pathname.split('/').at(-1);
      let receipt = receipts.get(requestId);
      if (state.receiptTransform && receipt)
        receipt = state.receiptTransform(receipt);
      return waitAt(
        'receipt',
        !state.missingReceipt && receipt
          ? ok(receipt)
          : error(404, 'REQUEST_NOT_FOUND'),
      );
    }
    if (pathname === '/v1/me/ratings/updates') {
      assert.equal(url.searchParams.get('limit'), '20');
      return waitAt(
        'updates',
        ok({
          items: [notice(), notice(unavailableNotice)],
          nextCursor: null,
          unreadCount: unreadCount(),
        }),
      );
    }
    if (pathname === '/v1/me/ratings/updates/unread-count')
      return ok({ unreadCount: unreadCount() });
    if (pathname.startsWith('/v1/me/ratings/updates/')) {
      const currentId = pathname.split('/')[5];
      assert.ok([noticeId, unavailableNotice].includes(currentId));
      if (pathname.endsWith('/target'))
        return waitAt(
          'notice-target',
          ok({
            noticeId: currentId,
            ...(state.noticeAvailable && currentId === noticeId
              ? {
                  status: 'available',
                  target: {
                    ...locator(),
                    ...(state.badTarget ? { targetId: otherTarget } : {}),
                  },
                }
              : { status: 'unavailable' }),
          }),
        );
      assert.equal(pathname.endsWith('/read'), true);
      assert.equal(request.method, 'PUT');
      assert.deepEqual(request.body, {});
      assert.equal(url.search, '');
      readRequests.push(request);
      events.push(`read:${currentId}`);
      state.read.set(currentId, state.read.get(currentId) ?? now);
      return waitAt(
        'read',
        ok({
          noticeId: currentId,
          readAt: state.read.get(currentId),
          unreadCount: unreadCount(),
        }),
      );
    }
    if (request.method !== 'GET') {
      commands.push(request);
      const body = request.body;
      assert.ok(
        stored.size,
        'read-back-verified immutable journal precedes dispatch',
      );
      assert.equal(body.expectedTargetRevision, revision);
      assert.equal(body.regionId === null || body.regionId === regionId, true);
      const isReply =
        pathname.endsWith('/replies') ||
        pathname.startsWith('/v1/ratings/replies/');
      const operation = isReply
        ? request.method === 'POST'
          ? 'create_reply'
          : 'delete_reply'
        : request.method === 'PUT'
          ? 'set_score'
          : request.method === 'POST'
            ? 'create_comment'
            : 'delete_comment';
      let receipt = receipts.get(body.clientRequestId);
      if (!receipt) {
        if (state.reject)
          receipt = {
            requestId: body.clientRequestId,
            operation,
            outcome: 'rejected',
            code: state.reject,
          };
        else if (isReply) {
          assert.equal(body.targetId, targetId);
          assert.equal(body.expectedRootRevision, revision);
          assert.equal(state.rootActive, true);
          let replyId;
          if (operation === 'create_reply') {
            assert.equal(pathname, `/v1/ratings/comments/${rootId}/replies`);
            assert.deepEqual(Object.keys(body).sort(), [
              'assetIds',
              'authorMode',
              'body',
              'clientRequestId',
              'expectedRootRevision',
              'expectedTargetRevision',
              'regionId',
              'replyTo',
              'targetId',
            ]);
            assert.deepEqual(body.assetIds, []);
            if (body.replyTo) {
              assert.deepEqual(Object.keys(body.replyTo).sort(), [
                'expectedRevision',
                'replyId',
              ]);
              const parent = state.replies.find(
                (item) => item.id === body.replyTo.replyId,
              );
              assert.ok(parent?.allowedActions.reply);
              assert.equal(body.replyTo.expectedRevision, parent.revision);
            }
            replyId = id(replySequence++);
            state.replies.push(
              row(
                replyId,
                body.body,
                body.replyTo?.replyId ?? null,
                true,
                true,
                body.authorMode,
              ),
            );
          } else {
            replyId = pathname.split('/').at(-1);
            assert.equal(body.rootId, rootId);
            assert.equal(body.expectedRevision, revision);
            assert.deepEqual(Object.keys(body).sort(), [
              'clientRequestId',
              'expectedRevision',
              'expectedRootRevision',
              'expectedTargetRevision',
              'regionId',
              'rootId',
              'targetId',
            ]);
            state.replies = state.replies.filter((item) => item.id !== replyId);
          }
          receipt = {
            requestId: body.clientRequestId,
            operation,
            outcome: 'applied',
            targetId,
            rootId,
            replyId,
            revision: nextRevision,
            occurredAt: now,
          };
        } else {
          if (operation === 'set_score') state.score = body.score;
          if (operation === 'delete_comment') state.rootActive = false;
          receipt = {
            requestId: body.clientRequestId,
            operation,
            outcome: 'applied',
            targetId,
            subjectId: operation === 'set_score' ? targetId : rootId,
            revision: nextRevision,
            occurredAt: now,
          };
        }
        receipts.set(body.clientRequestId, receipt);
      }
      const response = await waitAt(
        'command',
        ok(state.receiptTransform ? state.receiptTransform(receipt) : receipt),
      );
      if (state.loseCommand)
        throw new ClientError('timeout', 'Synthetic committed response loss');
      return response;
    }
    if (pathname === `/v1/ratings/targets/${targetId}`)
      return waitAt('detail', ok(target()));
    if (pathname.endsWith('/my-score'))
      return ok({
        myScore:
          state.score === null
            ? null
            : { score: state.score, revision: nextRevision },
      });
    if (pathname.endsWith('/score-summary'))
      return ok({ status: 'unavailable' });
    if (pathname === `/v1/ratings/targets/${targetId}/comments`)
      return ok({
        context: { regionId: scope, targetId, catalogRevision: revision },
        items: state.rootActive ? [root()] : [],
        nextCursor: null,
        continuation: 'end',
      });
    if (!state.rootActive) return error(404, 'RATING_NOT_FOUND');
    if (pathname === `/v1/ratings/comments/${rootId}/discussion`)
      return waitAt(
        'discussion',
        ok({
          context: context(scope),
          root: root(),
          allowedActions: {
            createReply: true,
            authorModes: ['named', 'anonymous'],
          },
        }),
      );
    if (pathname === `/v1/ratings/comments/${rootId}/replies`) {
      const cursor = url.searchParams.get('cursor');
      assert.equal(url.searchParams.get('limit'), '20');
      let page;
      if (state.scan && !cursor) page = replyPage(scope, [], cursorA, 'scan');
      else if (state.scan && cursor === cursorA)
        page = replyPage(scope, state.replies.slice(0, 1), cursorB, 'more');
      else if (state.scan && cursor === cursorB)
        page = replyPage(scope, state.replies.slice(1));
      else if (cursor === cursorPosition)
        page = replyPage(scope, state.replies.slice(2));
      else page = replyPage(scope);
      return waitAt(cursor ? 'more' : 'replies', ok(page));
    }
    if (pathname.startsWith('/v1/ratings/replies/')) {
      const replyId = pathname.split('/')[4],
        index = state.replies.findIndex((item) => item.id === replyId);
      if (index < 0) return error(404, 'RATING_NOT_FOUND');
      if (pathname.endsWith('/position')) {
        const page = state.positionMore
          ? replyPage(
              scope,
              state.replies.slice(index, index + 1),
              cursorPosition,
              'more',
            )
          : replyPage(scope, state.replies.slice(index));
        return waitAt(
          'position',
          ok({ context: page.context, anchorReplyId: replyId, page }),
        );
      }
      return ok(project(state.replies[index]));
    }
    if (pathname === `/v1/ratings/comments/${rootId}`) return ok(root());
    throw new Error(
      `Unexpected synthetic R2A route: ${request.method} ${pathname}`,
    );
  };
  const api = new ApiClient(
    'https://ratings-r2a-smoke.example',
    { send: server },
    app.identity.sessions,
    {
      refresh: async () => {
        throw new Error('Unexpected synthetic refresh');
      },
    },
  );
  app.community.ratings = new HttpRatingsGateway(api);
  app.community.ratingDiscussion = new HttpRatingDiscussionGateway(api);
  app.community.ratingUpdates = new HttpRatingUpdatesGateway(api);
  app.community.pendingRatings = new PendingRatingStore(
    {
      get: (key) =>
        state.failReadBack && stored.has(key) ? undefined : stored.get(key),
      set: (key, value) => {
        if (state.failStorage) throw new Error('Synthetic storage failure');
        stored.set(key, value);
      },
      remove: (key) => {
        if (state.failRemove) throw new Error('Synthetic remove failure');
        stored.delete(key);
      },
    },
    origin,
  );
  app.community.newRequestId = async () => {
    minted++;
    return id(requestSequence++);
  };
  globalThis.wx.navigateTo = ({ url, success, fail }) => {
    navigation.push(url);
    if (state.navigationFail) fail?.();
    else success?.();
  };
  const source = (mode) =>
    readFileSync(
      path.join(dist, `pages/rating-${mode}/rating-${mode}.wxml`),
      'utf8',
    );
  const common = readFileSync(path.join(dist, 'ratings/common.wxml'), 'utf8');
  const templates = Object.fromEntries(
    parse(common)
      .children.filter((n) => typeof n !== 'string')
      .map((n) => [n.attrs.name, n]),
  );
  const presented = (mode, page) =>
    render(parse(source(mode)).children, page.data, templates);
  const visible = (mode, page) => JSON.stringify(presented(mode, page));
  const nodes = (entries) =>
    entries.flatMap((entry) =>
      typeof entry === 'string' ? [] : [entry, ...nodes(entry.children)],
    );
  const buttons = (mode, page, handler) =>
    nodes(presented(mode, page)).filter(
      (node) => node.attrs.bindtap === handler,
    );
  const mount = (mode, route = {}) => {
    let page;
    const previousPage = globalThis.Page;
    globalThis.Page = (definition) => {
      page = definition;
    };
    const module = path.join(dist, `pages/rating-${mode}/rating-${mode}.js`);
    try {
      delete require.cache[require.resolve(module)];
      require(module);
    } finally {
      globalThis.Page = previousPage;
    }
    page.setData = (data) => {
      page.data = { ...page.data, ...data };
    };
    for (const [, handler] of (
      source(mode) + (source(mode).includes('<template') ? common : '')
    ).matchAll(/bind(?:tap|input)="([^"]+)"/g))
      assert.equal(
        typeof page[handler],
        'function',
        `emitted ${mode}.${handler}`,
      );
    pages.push(page);
    page.onLoad(route);
    page.onShow();
    return page;
  };
  const tap = (page, handler, dataset = {}) =>
    page[handler]({ currentTarget: { dataset } });
  const thread = (route = {}) =>
    mount('thread', { targetId, rootId, ...route });
  const routeFrom = (url) =>
    Object.fromEntries(new URL(url, 'https://native.invalid').searchParams);
  const login = (credentials = original.credentials) =>
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      credentials,
    );
  const clearThread = (page, label = '') => {
    for (const key of [
      'detail',
      'discussion',
      'authorMode',
      'replyToId',
      'deleteId',
    ])
      assert.equal(page.data[key], null, `${label}: ${key}`);
    assert.deepEqual(page.data.replies, [], label);
    for (const key of ['text', 'replyToName', 'anchorReplyId'])
      assert.equal(page.data[key], '', `${label}: ${key}`);
    for (const key of ['loaded', 'composerOpen', 'canMore'])
      assert.equal(page.data[key], false, `${label}: ${key}`);
    assert.equal(page.data.textLength, 0);
    const output = visible('thread', page);
    for (const body of [rootBody, firstBody, secondBody, draftBody])
      assert.equal(output.includes(body), false, `${label}: stale WXML body`);
  };
  const clearUpdates = (page, label = '') => {
    assert.deepEqual(page.data.items, [], label);
    assert.equal(page.data.unreadCount, null, label);
    assert.equal(page.data.loaded, false, label);
    assert.equal(page.data.canMore, false, label);
    assert.equal(visible('updates', page).includes(secondBody), false, label);
  };
  const compose = (page, body, mode = 'anonymous', replyId = null) => {
    if (replyId) tap(page, 'onReply', { id: replyId });
    else page.onRootReply();
    tap(page, 'onAuthorMode', { mode });
    page.onText({ detail: { value: body } });
  };
  const release = async (kind) => {
    const hold = holds.get(kind);
    holds.delete(kind);
    hold.resolve();
    await flush();
  };
  try {
    const config = JSON.parse(
      readFileSync(path.join(dist, 'app.json'), 'utf8'),
    );
    for (const mode of ['thread', 'updates']) {
      assert.ok(config.pages.includes(`pages/rating-${mode}/rating-${mode}`));
      assert.doesNotMatch(
        source(mode),
        /<image|rich-text|requestSubscribeMessage|requestPayment|bindtap="[^"]*(?:Like|Upload|Image)/i,
      );
    }
    assert.match(source('detail'), /bindtap="onDiscussion"/);
    assert.match(
      readFileSync(
        path.join(dist, 'pages/community-updates/community-updates.wxml'),
        'utf8',
      ),
      /\/pages\/rating-updates\/rating-updates/,
    );
    assert.match(source('updates'), /未接入微信外部推送/);

    // R1's root entry is an actual emitted handler; route ancestry stays explicit.
    let detail = mount('detail', { targetId });
    await flush();
    tap(detail, 'onDiscussion', { id: rootId });
    await flush();
    assert.equal(
      navigation.at(-1),
      `/pages/rating-thread/rating-thread?targetId=${targetId}&rootId=${rootId}`,
    );
    detail.onUnload();
    let page = thread();
    await flush();
    assert.equal(page.data.loaded, true);
    assert.ok(visible('thread', page).includes(rootBody));
    assert.equal(
      buttons('thread', page, 'onReply').length,
      2,
      'readable does not imply direct reply authorization',
    );
    assert.equal(
      buttons('thread', page, 'onDelete').length,
      2,
      'only server-authorized own rows are deletable',
    );
    tap(page, 'onReply', { id: blockedReply });
    assert.equal(page.data.composerOpen, false);
    tap(page, 'onDelete', { id: blockedReply });
    assert.equal(page.data.deleteId, null);
    page.onRootReply();
    assert.equal(page.data.authorMode, null);
    assert.equal(
      buttons('thread', page, 'onPublish')[0].attrs.disabled,
      'true',
    );
    const beforeText = commands.length;
    page.onText({ detail: { value: '未选择身份不能发送' } });
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText);
    assert.equal(minted, 0);
    tap(page, 'onAuthorMode', { mode: 'anonymous' });
    page.onText({ detail: { value: '😀'.repeat(501) } });
    assert.equal(page.data.textLength, 501);
    assert.equal(
      buttons('thread', page, 'onPublish')[0].attrs.disabled,
      'true',
    );
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText);
    page.onText({ detail: { value: ' '.repeat(101) + '😀'.repeat(500) } });
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText);
    page.onText({ detail: { value: '\ud800' } });
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText);
    page.onText({ detail: { value: '拒绝\u0001控制字符' } });
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText);
    const maximum = '😀'.repeat(500);
    page.onText({ detail: { value: maximum } });
    assert.equal(page.data.textLength, 500);
    assert.equal(
      buttons('thread', page, 'onPublish')[0].attrs.disabled,
      'false',
    );
    page.onPublish();
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeText + 1);
    assert.equal(commands.at(-1).body.body, maximum);
    assert.equal(commands.at(-1).body.replyTo, null);
    assert.equal(stored.size, 0);
    assert.ok(visible('thread', page).includes('已提交'));
    page.onFirst();
    await flush();
    compose(page, ` \r\n${draftBody}\r\n `, 'named', secondReply);
    assert.equal(page.data.replyToId, secondReply);
    assert.equal(page.data.textLength, [...draftBody].length);
    page.onPublish();
    await flush();
    assert.deepEqual(commands.at(-1).body.replyTo, {
      replyId: secondReply,
      expectedRevision: revision,
    });
    assert.equal(commands.at(-1).body.body, draftBody);
    assert.equal(commands.at(-1).body.authorMode, 'named');
    assert.ok(page.data.replies.some((item) => item.body === draftBody));
    assert.equal(
      JSON.stringify([...receipts.values()]).includes(draftBody),
      false,
      'receipts never replay frozen body',
    );
    page.onUnload();

    // Single deletion preserves descendants and strips all unavailable-quote identity.
    seed();
    page = thread();
    await flush();
    tap(page, 'onDelete', { id: firstReply });
    assert.ok(visible('thread', page).includes('只删除这条回复'));
    page.onConfirmDelete();
    page.onConfirmDelete();
    await flush();
    assert.equal(
      page.data.replies.some((item) => item.id === firstReply),
      false,
    );
    assert.deepEqual(
      page.data.replies.find((item) => item.id === secondReply).replyTo,
      { kind: 'reply', status: 'unavailable' },
    );
    assert.ok(visible('thread', page).includes(secondBody));
    assert.ok(visible('thread', page).includes('原回复当前不可查看'));
    compose(page, '父引用不可看也能回复当前这条', 'named', secondReply);
    page.onPublish();
    await flush();
    assert.equal(commands.at(-1).body.replyTo.replyId, secondReply);
    page.onFirst();
    await flush();
    detail = mount('detail', { targetId });
    await flush();
    tap(detail, 'onDelete', { id: rootId });
    detail.onConfirmDelete();
    await flush();
    assert.equal(state.rootActive, false);
    page.onRefresh();
    await flush();
    clearThread(page);
    assert.ok(visible('thread', page).includes('当前不可查看'));
    assert.equal(buttons('thread', page, 'onRootReply').length, 0);
    const afterRootDelete = commands.length;
    page.onPublish();
    page.onConfirmDelete();
    await flush();
    assert.equal(commands.length, afterRootDelete);
    detail.onUnload();
    page.onUnload();
    seed();

    // Scan-only pages and positioned pages have independent cursor histories.
    state.scan = true;
    page = thread({ regionId });
    await flush();
    assert.deepEqual(page.data.replies, []);
    assert.equal(page.data.canMore, true);
    assert.equal(buttons('thread', page, 'onMore').length, 1);
    page.onMore();
    await flush();
    assert.deepEqual(
      page.data.replies.map((item) => item.id),
      [firstReply],
    );
    page.onMore();
    await flush();
    assert.deepEqual(
      page.data.replies.map((item) => item.id),
      [firstReply, secondReply, blockedReply],
    );
    assert.equal(page.data.canMore, false);
    compose(page, draftBody);
    page.onCollapse();
    clearThread(page);
    assert.equal(page.data.collapsed, true);
    const beforeExpand = requests.length;
    state.replies[0].body = '重新核验后更新的首条正文';
    page.onExpand();
    await flush();
    assert.equal(page.data.collapsed, false);
    assert.deepEqual(page.data.replies, []);
    assert.ok(
      requests
        .slice(beforeExpand)
        .some((request) => request.url.includes('/discussion')),
    );
    assert.ok(
      requests
        .slice(beforeExpand)
        .some((request) =>
          request.url.endsWith('/replies?regionId=' + regionId + '&limit=20'),
        ),
    );
    page.onMore();
    await flush();
    assert.ok(visible('thread', page).includes('重新核验后更新的首条正文'));
    page.onUnload();
    seed();
    state.scan = false;
    state.positionMore = true;
    page = thread({ replyId: secondReply });
    await flush();
    assert.equal(page.data.anchorReplyId, secondReply);
    assert.deepEqual(
      page.data.replies.map((item) => item.id),
      [secondReply],
    );
    assert.ok(visible('thread', page).includes('rating-anchor'));
    page.onMore();
    await flush();
    assert.deepEqual(
      page.data.replies.map((item) => item.id),
      [secondReply, blockedReply],
    );
    assert.ok(requests.at(-1).url.includes(`cursor=${cursorPosition}`));
    page.onFirst();
    await flush();
    assert.equal(page.data.anchorReplyId, '');
    assert.equal(page.data.replies[0].id, firstReply);
    assert.equal(
      new URL(requests.at(-1).url).searchParams.has('cursor'),
      false,
    );
    page.onHide();
    page.onShow();
    await flush();
    assert.equal(
      page.data.anchorReplyId,
      '',
      'reopening after First retains the newer route',
    );
    assert.equal(page.data.replies[0].id, firstReply);
    page.onUnload();
    state.positionMore = false;

    // Source resolves only. Receiving page resolves again, reads position, applies it, then acknowledges exactly that notice.
    let updates = mount('updates');
    await flush();
    assert.equal(updates.data.items.length, 2);
    assert.equal(updates.data.unreadCount, 2);
    assert.ok(
      visible('updates', updates).includes('此条评分更新的内容当前不可查看'),
    );
    let readsBefore = readRequests.length;
    tap(updates, 'onOpen', { id: noticeId });
    await flush();
    assert.equal(readRequests.length, readsBefore);
    const noticeRoute = routeFrom(navigation.at(-1));
    assert.equal(noticeRoute.noticeId, noticeId);
    assert.equal(noticeRoute.replyId, secondReply);
    holds.set('position', deferred());
    page = thread(noticeRoute);
    await flush();
    assert.equal(page.data.loaded, false);
    assert.equal(readRequests.length, readsBefore);
    await release('position');
    assert.equal(page.data.loaded, true);
    assert.equal(page.data.anchorReplyId, secondReply);
    assert.equal(readRequests.length, readsBefore + 1);
    assert.ok(
      events.lastIndexOf('position:return') <
        events.lastIndexOf(`read:${noticeId}`),
    );
    assert.equal(
      updates.data.items[0].readAt,
      null,
      'source never synthesizes a read acknowledgment',
    );
    page.onUnload();
    updates.onRefresh();
    await flush();
    assert.equal(updates.data.items[0].readAt, now);
    tap(updates, 'onRead', { id: unavailableNotice });
    tap(updates, 'onRead', { id: unavailableNotice });
    await flush();
    assert.equal(readRequests.length, readsBefore + 2);
    assert.equal(updates.data.unreadCount, 0);
    tap(updates, 'onRead', { id: unavailableNotice });
    await flush();
    assert.equal(readRequests.length, readsBefore + 2);
    updates.onUnload();

    // Failed navigation, unavailable target, mismatched target or unavailable position must not mark anything read.
    state.read.clear();
    updates = mount('updates');
    await flush();
    state.navigationFail = true;
    readsBefore = readRequests.length;
    tap(updates, 'onOpen', { id: noticeId });
    await flush();
    clearUpdates(updates);
    assert.equal(readRequests.length, readsBefore);
    state.navigationFail = false;
    updates.onRefresh();
    await flush();
    state.noticeAvailable = false;
    tap(updates, 'onOpen', { id: noticeId });
    await flush();
    assert.deepEqual(updates.data.items[0], notice());
    assert.equal(readRequests.length, readsBefore);
    state.noticeAvailable = true;
    state.badTarget = true;
    page = thread(noticeRoute);
    await flush();
    clearThread(page);
    assert.equal(readRequests.length, readsBefore);
    page.onUnload();
    state.badTarget = false;
    state.rootActive = false;
    page = thread(noticeRoute);
    await flush();
    clearThread(page);
    assert.equal(readRequests.length, readsBefore);
    page.onUnload();
    seed();
    updates.onUnload();

    // Strict wire failures reach the emitted UI as unavailable, not permissive projections.
    for (const corrupt of [
      (kind, response) =>
        kind === 'position'
          ? {
              ...response,
              body: { ...response.body, anchorReplyId: firstReply },
            }
          : response,
      (kind, response) =>
        kind === 'position'
          ? {
              ...response,
              body: {
                ...response.body,
                page: {
                  ...response.body.page,
                  items: response.body.page.items.map((item, index) =>
                    index
                      ? item
                      : {
                          ...item,
                          replyTo: {
                            kind: 'reply',
                            status: 'unavailable',
                            author: author(),
                          },
                        },
                  ),
                },
              },
            }
          : response,
      (kind, response) =>
        kind === 'discussion'
          ? {
              ...response,
              body: {
                ...response.body,
                root: { ...response.body.root, replyCount: 999 },
              },
            }
          : response,
    ]) {
      state.wireTransform = corrupt;
      page = thread(noticeRoute);
      await flush();
      clearThread(page);
      assert.equal(readRequests.length, readsBefore);
      page.onUnload();
    }
    state.wireTransform = null;
    for (const route of [
      { targetId, rootId, arbitrary: id(40) },
      { targetId, rootId, noticeId },
      { targetId: 'bad', rootId },
      { targetId, rootId: otherRoot },
    ]) {
      const beforeInvalid = requests.length;
      page = mount('thread', route);
      await flush();
      clearThread(page);
      if (route.rootId !== otherRoot)
        assert.equal(requests.length, beforeInvalid);
      page.onUnload();
    }
    updates = mount('updates', { noticeId });
    await flush();
    clearUpdates(updates);
    updates.onUnload();

    // Interrupt each actual delayed ApiClient response at its owner boundary.
    const boundaries = [
      ['page hide', (current) => current.onHide()],
      ['page unload', (current) => current.onUnload()],
      ['cancel', (current) => current.onCancel()],
      [
        'Safety',
        () =>
          app.community.safetyChanges.invalidate(
            original.credentials.accountId,
          ),
      ],
      [
        'identity scope',
        () =>
          app.community.directoryScopeChanges.clear(
            original.credentials.accountId,
          ),
      ],
      [
        'browse scope',
        () =>
          app.community.browsingScopeChanges.clear(
            original.credentials.accountId,
          ),
      ],
      ['same-account generation', () => login()],
      [
        'other account',
        () => login({ ...original.credentials, accountId: otherAccount }),
      ],
      ['logout', () => app.identity.sessions.logout()],
      ['app hide', () => app.community.privateViews.clear()],
    ];
    for (const [label, interrupt] of boundaries) {
      login();
      holds.set('position', deferred());
      page = thread(noticeRoute);
      await flush();
      const pendingRequest = requests.at(-1);
      assert.ok(pendingRequest.url.includes('/position'), label);
      readsBefore = readRequests.length;
      interrupt(page);
      clearThread(page, label);
      assert.equal(pendingRequest.cancellation.isCancelled, true, label);
      await release('position');
      clearThread(page, label);
      assert.equal(
        readRequests.length,
        readsBefore,
        `${label}: late position cannot read`,
      );
      page.onUnload();
      login();
      page = thread();
      await flush();
      compose(page, draftBody);
      interrupt(page);
      clearThread(page, `${label}: draft`);
      page.onUnload();
      login();
      holds.set('updates', deferred());
      updates = mount('updates');
      await flush();
      interrupt(updates);
      clearUpdates(updates, label);
      await release('updates');
      clearUpdates(updates, label);
      updates.onUnload();
      login();
      // A delayed source-page resolve may not navigate after any owner boundary.
      updates = mount('updates');
      await flush();
      holds.set('notice-target', deferred());
      const navigationsBefore = navigation.length;
      readsBefore = readRequests.length;
      tap(updates, 'onOpen', { id: noticeId });
      await flush();
      interrupt(updates);
      clearUpdates(updates, `${label}: target resolve`);
      await release('notice-target');
      clearUpdates(updates, `${label}: late target resolve`);
      assert.equal(
        navigation.length,
        navigationsBefore,
        `${label}: late navigation`,
      );
      assert.equal(
        readRequests.length,
        readsBefore,
        `${label}: source never acknowledges`,
      );
      updates.onUnload();
      login();
      // A read already sent by the receiving page can commit, but a late acknowledgment
      // cannot restore its body, quoted identity, unread state, or a newer account's view.
      holds.set('read', deferred());
      page = thread(noticeRoute);
      await flush();
      assert.equal(
        page.data.loaded,
        true,
        `${label}: position applied before read`,
      );
      const readRequest = requests.at(-1);
      assert.ok(readRequest.url.endsWith('/read'));
      interrupt(page);
      clearThread(page, `${label}: pending read`);
      assert.equal(readRequest.cancellation.isCancelled, true);
      await release('read');
      clearThread(page, `${label}: late read`);
      page.onUnload();
      login();
    }
    // Newer navigation invalidates a position response owned by the earlier route.
    holds.set('position', deferred());
    page = thread(noticeRoute);
    await flush();
    readsBefore = readRequests.length;
    page.onLoad({ targetId, rootId });
    page.onShow();
    await flush();
    assert.equal(page.data.anchorReplyId, '');
    await release('position');
    assert.equal(page.data.anchorReplyId, '');
    assert.equal(readRequests.length, readsBefore);
    page.onUnload();
    // Already-sent read may commit, but its late result cannot repopulate a hidden page.
    holds.set('read', deferred());
    page = thread(noticeRoute);
    await flush();
    assert.equal(page.data.loaded, true);
    assert.ok(requests.at(-1).url.endsWith('/read'));
    const pendingRead = requests.at(-1);
    page.onHide();
    clearThread(page);
    assert.equal(pendingRead.cancellation.isCancelled, true);
    await release('read');
    clearThread(page);
    page.onUnload();

    // Uncertain v2 publication blocks R1 and retries byte-identical intent; recovery never renders journal body.
    seed();
    state.loseCommand = true;
    page = thread();
    detail = mount('detail', { targetId });
    await flush();
    compose(page, draftBody, 'anonymous', secondReply);
    page.onPublish();
    page.onPublish();
    await flush();
    assert.equal(page.data.frozen, true);
    clearThread(page);
    const frozen = structuredClone(
      app.community.pendingRatings.load(original.credentials.accountId),
    );
    assert.equal(frozen.version, 2);
    assert.equal(frozen.intent.operation, 'create_reply');
    const firstCommand = structuredClone(commands.at(-1).body),
      beforeBlocked = commands.length,
      mintedBeforeBlocked = minted;
    tap(detail, 'onScore', { score: 5 });
    detail.onConfirmScore();
    await flush();
    assert.equal(commands.length, beforeBlocked);
    assert.equal(minted, mintedBeforeBlocked);
    assert.equal(detail.data.frozen, true);
    detail.onUnload();
    state.loseCommand = false;
    state.missingReceipt = true;
    page.onRecover();
    await flush();
    assert.equal(page.data.frozen, true);
    assert.deepEqual(
      app.community.pendingRatings.load(original.credentials.accountId),
      frozen,
    );
    state.receiptTransform = (receipt) => ({ ...receipt, rootId: otherRoot });
    page.onRetry();
    await flush();
    assert.equal(page.data.frozen, true);
    assert.deepEqual(commands.at(-1).body, firstCommand);
    assert.deepEqual(
      app.community.pendingRatings.load(original.credentials.accountId),
      frozen,
    );
    state.receiptTransform = null;
    state.missingReceipt = false;
    page.onRetry();
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(page.data.frozen, false);
    assert.deepEqual(commands.at(-1).body, firstCommand);
    assert.equal(
      state.replies.filter((item) => item.body === draftBody).length,
      1,
      'same key retry does not duplicate',
    );
    page.onUnload();

    // R1 now uses v2 too; an uncertain score blocks reply dispatch from an already-open thread.
    page = thread();
    detail = mount('detail', { targetId });
    await flush();
    state.loseCommand = true;
    tap(detail, 'onScore', { score: 4 });
    detail.onConfirmScore();
    await flush();
    assert.equal(
      app.community.pendingRatings.load(original.credentials.accountId).version,
      2,
    );
    const beforeReplyBlocked = commands.length;
    compose(page, draftBody);
    page.onPublish();
    await flush();
    assert.equal(commands.length, beforeReplyBlocked);
    assert.equal(page.data.frozen, true);
    state.loseCommand = false;
    page.onRecover();
    await flush();
    assert.equal(stored.size, 0);
    detail.onUnload();
    page.onUnload();

    // Exact terminal rejection releases just that intent; no automatic modified publish.
    page = thread();
    await flush();
    compose(page, draftBody);
    state.reject = 'CONTENT_REJECTED';
    const rejectedBefore = commands.length;
    page.onPublish();
    await flush();
    assert.equal(commands.length, rejectedBefore + 1);
    assert.equal(stored.size, 0);
    assert.equal(page.data.frozen, false);
    assert.equal(page.data.needsRefresh, true);
    clearThread(page);
    page.onPublish();
    page.onRetry();
    await flush();
    assert.equal(commands.length, rejectedBefore + 1);
    assert.ok(visible('thread', page).includes('审核'));
    state.reject = null;
    page.onUnload();

    // A failed journal write or failed read-back must never reach transport.
    for (const failure of ['failStorage', 'failReadBack']) {
      page = thread();
      await flush();
      compose(page, draftBody);
      state[failure] = true;
      const sentBefore = commands.length;
      page.onPublish();
      await flush();
      assert.equal(commands.length, sentBefore, failure);
      assert.equal(page.data.frozen, true);
      clearThread(page);
      state[failure] = false;
      page.onUnload();
      stored.clear();
    }
    // Removal failure retains uncertainty; current root disappearance cannot be repaired with receipt text.
    seed();
    page = thread();
    await flush();
    compose(page, draftBody);
    state.failRemove = true;
    page.onPublish();
    await flush();
    assert.equal(page.data.frozen, true);
    assert.equal(stored.size, 1);
    state.failRemove = false;
    state.rootActive = false;
    page.onRecover();
    await flush();
    assert.equal(stored.size, 0);
    clearThread(page);
    assert.equal(page.data.frozen, false);
    page.onUnload();
    seed();

    // Legacy v1 and v2 coexistence: retain both, settle v1 first, then v2; never dispatch a third command.
    const legacyId = id(requestSequence++),
      newerId = id(requestSequence++);
    const legacy = {
      version: 1,
      accountId: original.credentials.accountId,
      intent: decodeRatingIntent({
        operation: 'set_score',
        targetId,
        payload: {
          clientRequestId: legacyId,
          regionId: null,
          expectedTargetRevision: revision,
          expectedRevision: null,
          score: 2,
        },
      }),
    };
    const newer = {
      version: 2,
      accountId: original.credentials.accountId,
      intent: decodeRatingReplyIntent({
        operation: 'create_reply',
        rootId,
        payload: {
          clientRequestId: newerId,
          regionId: null,
          targetId,
          expectedTargetRevision: revision,
          expectedRootRevision: revision,
          replyTo: null,
          authorMode: 'anonymous',
          body: draftBody,
          assetIds: [],
        },
      }),
    };
    page = thread();
    detail = mount('detail', { targetId });
    await flush();
    stored.set(journalKey(1), legacy);
    stored.set(journalKey(2), newer);
    const beforeBothPending = commands.length,
      mintedBeforeBothPending = minted;
    compose(page, '已有旧请求时不能发第三条');
    page.onPublish();
    tap(detail, 'onScore', { score: 3 });
    detail.onConfirmScore();
    await flush();
    assert.equal(commands.length, beforeBothPending);
    assert.equal(minted, mintedBeforeBothPending);
    assert.equal(page.data.frozen, true);
    assert.equal(detail.data.frozen, true);
    assert.deepEqual(stored.get(journalKey(1)), legacy);
    assert.deepEqual(stored.get(journalKey(2)), newer);
    page.onUnload();
    detail.onUnload();
    receipts.set(legacyId, {
      requestId: legacyId,
      operation: 'set_score',
      outcome: 'applied',
      targetId,
      subjectId: targetId,
      revision: nextRevision,
      occurredAt: now,
    });
    receipts.set(newerId, {
      requestId: newerId,
      operation: 'create_reply',
      outcome: 'applied',
      targetId,
      rootId,
      replyId: id(300),
      revision: nextRevision,
      occurredAt: now,
    });
    const beforeLegacy = requests.length,
      commandsBeforeLegacy = commands.length,
      mintedBeforeLegacy = minted;
    holds.set('receipt', deferred());
    page = mount('recovery');
    await flush();
    assert.ok(requests.at(-1).url.endsWith(`/v1/ratings/requests/${legacyId}`));
    assert.equal(stored.size, 2);
    assert.deepEqual(stored.get(journalKey(1)), legacy);
    assert.deepEqual(stored.get(journalKey(2)), newer);
    assert.equal(visible('recovery', page).includes(draftBody), false);
    await release('receipt');
    assert.equal(stored.has(journalKey(1)), false);
    assert.deepEqual(stored.get(journalKey(2)), newer);
    assert.equal(page.data.frozen, true);
    page.onRecover();
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(commands.length, commandsBeforeLegacy);
    assert.equal(minted, mintedBeforeLegacy);
    assert.deepEqual(
      requests
        .slice(beforeLegacy)
        .map((request) => new URL(request.url).pathname),
      [
        `/v1/ratings/requests/${legacyId}`,
        `/v1/ratings/reply-requests/${newerId}`,
      ],
    );
    assert.equal(visible('recovery', page).includes(draftBody), false);
    page.onUnload();

    // Late committed publication after an account switch preserves only the original owner's journal.
    page = thread();
    await flush();
    compose(page, draftBody);
    holds.set('command', deferred());
    page.onPublish();
    await flush();
    const ownerPending = structuredClone(
      app.community.pendingRatings.load(original.credentials.accountId),
    );
    const otherPending = { ...newer, accountId: otherAccount };
    stored.set(journalKey(2, otherAccount), otherPending);
    login({ ...original.credentials, accountId: otherAccount });
    clearThread(page);
    await release('command');
    clearThread(page);
    assert.deepEqual(
      stored.get(journalKey(2, original.credentials.accountId)),
      ownerPending,
    );
    assert.deepEqual(stored.get(journalKey(2, otherAccount)), otherPending);
    page.onUnload();
    stored.delete(journalKey(2, otherAccount));
    login();
    state.rootActive = false;
    page = mount('recovery');
    await flush();
    assert.equal(stored.size, 0);
    assert.equal(visible('recovery', page).includes(draftBody), false);
    page.onUnload();
  } finally {
    for (const hold of holds.values()) hold.resolve();
    holds.clear();
    for (const page of pages) page.onUnload?.();
    app.community.ratings = original.ratings;
    app.community.ratingDiscussion = original.ratingDiscussion;
    app.community.ratingUpdates = original.ratingUpdates;
    app.community.pendingRatings = original.pendingRatings;
    app.community.newRequestId = original.newRequestId;
    globalThis.wx.navigateTo = original.navigateTo;
    login();
  }
  console.log(
    'Ratings R2A emitted handlers + real ApiClient/strict gateways + bounded WXML smoke passed: root/reply publication, exact mode/text boundaries, non-cascading deletion, root-unavailable clearing, scan/position/collapse, receiving-page read acknowledgment, lifecycle late-response suppression, immutable uncertain retry, and v1/v2 coordination (synthetic only; no device/provider/PostgreSQL/push proof).',
  );
}
