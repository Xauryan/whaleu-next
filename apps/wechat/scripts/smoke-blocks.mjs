import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Execute emitted native page handlers against the real block gateway/decoders and
// account-scoped durable store. The in-memory API is synthetic; no provider runs.
export async function smokeNamedBlocks({
  app,
  dist,
  mountPage,
  flush,
  postWire,
  rootWire,
  replyWire,
  accountId,
}) {
  const { HttpBlockGateway } = require(
    path.join(dist, 'community/block-gateway.js'),
  );
  const { decodePost, decodeComment } = require(
    path.join(dist, 'community/contract.js'),
  );
  const { decodeReply } = require(
    path.join(dist, 'community/discussion-contract.js'),
  );
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const original = {
    gateway: app.community.gateway,
    blocks: app.community.blocks,
    profiles: app.community.profiles,
    privacy: app.community.identityPrivacy,
    newRequestId: app.community.newRequestId,
  };
  const postId = postWire().id,
    rootId = rootWire().id,
    replyId = replyWire().id;
  const named = (digit) => ({
    kind: 'named',
    experienceDisplay: {
      title: { status: 'unavailable', value: null },
      color: { status: 'unavailable', value: null },
      level: { status: 'unavailable', value: null },
    },
    profileId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
    displayName: `合成公开名称 ${digit}`,
    avatar: null,
  });
  const namedPost = () =>
    decodePost({
      ...postWire(),
      author: named('1'),
      component: { kind: 'none' },
      commentCount: 1,
      replyCount: 1,
      discussionCount: 2,
      viewer: { ...postWire().viewer, isSelf: false, canDelete: false },
    });
  const namedReply = () =>
    decodeReply({
      ...replyWire(),
      author: named('3'),
      target: { ...replyWire().target, author: named('2') },
      viewer: { ...replyWire().viewer, isSelf: false, canDelete: false },
    });
  const namedRoot = () =>
    decodeComment({
      ...rootWire(),
      author: named('2'),
      replyPreview: {
        items: isBlocked(replyId) ? [] : [namedReply()],
        nextCursor: null,
      },
      viewer: { ...rootWire().viewer, isSelf: false, canDelete: false },
    });
  const anonymousId = '45454545-4545-4545-8545-454545454545';
  const selfId = '46464646-4646-4646-8646-464646464646';
  const anonymousPost = decodePost({
    ...postWire(),
    id: anonymousId,
    component: { kind: 'none' },
    viewer: { ...postWire().viewer, isSelf: false, canDelete: false },
  });
  const selfPost = decodePost({
    ...namedPost(),
    id: selfId,
    viewer: { ...postWire().viewer, isSelf: true },
  });
  const ids = {
    [postId]: '51515151-5151-4151-8151-515151515151',
    [rootId]: '52525252-5252-4252-8252-525252525252',
    [replyId]: '53535353-5353-4353-8353-535353535353',
  };
  const removedId = '54545454-5454-4454-8454-545454545454';
  const snapshotId = '55555555-5555-4555-8555-555555555554';
  const states = new Map([
    ...Object.values(ids).map((relationshipId) => [
      relationshipId,
      { relationshipId, revision: '1', blocked: false },
    ]),
    ...[removedId, snapshotId].map((relationshipId) => [
      relationshipId,
      { relationshipId, revision: '1', blocked: true },
    ]),
  ]);
  const isBlocked = (id) => states.get(ids[id]).blocked;
  const entry = (state) => ({
    ...state,
    blockedAt: '2026-10-07T04:00:00.000Z',
    canUnblock: true,
    display:
      state.relationshipId === removedId
        ? { kind: 'unavailable', displayName: null }
        : {
            kind: state.relationshipId === snapshotId ? 'snapshot' : 'current',
            displayName: '安全公开名称',
          },
  });
  const receipts = new Map(),
    writes = [],
    reads = [];
  let requestNumber = 0,
    deferWrite = false,
    completeWrite,
    writeCancellation;
  let deferList = false,
    completeList,
    listCancellation;
  app.community.newRequestId = async () =>
    `60606060-6060-4060-8060-${String(++requestNumber).padStart(12, '0')}`;
  app.community.blocks = new HttpBlockGateway({
    async request(endpoint, options) {
      const { path: route, method } = endpoint;
      if (method === 'PUT') {
        const body = options.body;
        writes.push({ route, body: structuredClone(body) });
        writeCancellation = options.cancellation;
        const relationshipId = body.blocked
          ? ids[body.source.id]
          : route.split('/').at(-1);
        assert.ok(relationshipId);
        if (body.blocked)
          assert.deepEqual(Object.keys(body).sort(), [
            'blocked',
            'clientRequestId',
            'source',
          ]);
        else
          assert.deepEqual(Object.keys(body).sort(), [
            'blocked',
            'clientRequestId',
            'expectedRevision',
          ]);
        const committed = receipts.get(body.clientRequestId);
        if (committed)
          return endpoint.decode({
            receipt: committed,
            current: states.get(committed.relationshipId),
          });
        const previous = states.get(relationshipId);
        const current = {
          relationshipId,
          blocked: body.blocked,
          revision: String(Number(previous.revision) + 1),
        };
        states.set(relationshipId, current);
        const result = {
          receipt: {
            ...current,
            requestId: body.clientRequestId,
            operation: body.blocked ? 'block_named' : 'unblock_named',
            outcome: 'applied',
          },
          current,
        };
        receipts.set(body.clientRequestId, result.receipt);
        if (deferWrite)
          return new Promise((resolve) => {
            completeWrite = () => resolve(endpoint.decode(result));
          });
        return endpoint.decode(result);
      }
      if (route.startsWith('/v1/me/safety/block-requests/')) {
        const receipt = receipts.get(route.split('/').at(-1));
        assert.ok(receipt);
        return endpoint.decode({
          receipt,
          current: states.get(receipt.relationshipId),
        });
      }
      assert.equal(route, '/v1/me/safety/blocks');
      reads.push(options.query);
      const all = [...states.values()]
        .filter((state) => state.blocked)
        .map(entry);
      const result = options.query.cursor
        ? { items: all.slice(1), nextCursor: null }
        : {
            items: all.slice(0, 1),
            nextCursor: all.length > 1 ? 'synthetic-next' : null,
          };
      if (deferList) {
        listCancellation = options.cancellation;
        return new Promise((resolve) => {
          completeList = () => resolve(endpoint.decode(result));
        });
      }
      return endpoint.decode(result);
    },
  });
  const readParent = () => {
    if (isBlocked(postId))
      throw new ClientError('business', 'Unavailable', {
        httpStatus: 404,
        serverCode: 'POST_BLOCKED_BY_YOU',
      });
    return namedPost();
  };
  const campus = {
    id: '71717171-7171-4171-8171-717171717171',
    fullName: '合成校园',
    isActive: true,
  };
  app.community.profiles = {
    profile: async () => ({ accountId, selectedCampus: campus }),
    campuses: async () => ({
      items: [campus],
      page: 1,
      pageSize: 100,
      total: 1,
    }),
  };
  app.community.identityPrivacy = {
    authorization: async () => ({
      role: 'member',
      management: { global: false, operatingRegionIds: [] },
      identityView: { allowed: false, maxBatchSize: 20 },
    }),
  };
  app.community.gateway = {
    spaces: async () => ({
      regional: {
        ...namedPost().space,
        isActive: true,
        operatingRegionId: campus.id,
      },
      global: [],
    }),
    feed: async () => ({
      items: [
        ...(isBlocked(postId) ? [] : [namedPost()]),
        anonymousPost,
        selfPost,
      ],
      nextCursor: null,
      continuation: 'end',
    }),
    post: async () => readParent(),
    comments: async () => {
      readParent();
      return {
        items: isBlocked(rootId) ? [] : [namedRoot()],
        nextCursor: null,
      };
    },
    comment: async () => {
      readParent();
      if (isBlocked(rootId))
        throw new ClientError('business', 'Unavailable', {
          httpStatus: 404,
          serverCode: 'COMMENT_NOT_FOUND',
        });
      return namedRoot();
    },
    replies: async () => {
      readParent();
      return {
        items: isBlocked(replyId) ? [] : [namedReply()],
        nextCursor: null,
      };
    },
    updatesUnread: async () => ({ unreadCount: 0 }),
  };
  const route = (name) => path.join(dist, `pages/${name}/${name}.js`);
  const tap = (id) => ({ currentTarget: { dataset: { id } } });
  const feed = mountPage(route('community-feed'), {});
  const detail = mountPage(route('community-detail'), { postId });
  const thread = mountPage(route('community-thread'), {
    postId,
    rootCommentId: rootId,
  });
  const own = mountPage(route('community-blocks'), {});
  await flush();
  assert.equal(feed.data.posts.length, 3);
  assert.equal(detail.data.comments.length, 1);
  assert.equal(thread.data.replies.length, 1);
  assert.equal(own.data.items.length, 1);
  assert.equal(own.data.canLoadMore, true);
  own.onMore();
  await flush();
  assert.equal(own.data.items.length, 2);
  assert.equal(reads.at(-1).cursor, 'synthetic-next');
  assert.equal(
    own.data.items.find((item) => item.relationshipId === removedId).display
      .kind,
    'unavailable',
  );
  let stoppedRefresh = 0;
  globalThis.wx.stopPullDownRefresh = () => {
    stoppedRefresh++;
  };
  await own.onPullDownRefresh();
  assert.equal(stoppedRefresh, 1);
  own.onMore();
  await flush();

  // Menus resolve current page DTOs, never public profile IDs or private account IDs.
  feed.onBlockPost(tap(anonymousId));
  feed.onBlockPost(tap(selfId));
  feed.onBlockPost(tap('missing'));
  assert.equal(feed.data.block.confirmSource, null);
  feed.onBlockPost(tap(postId));
  assert.deepEqual(feed.data.block.confirmSource, { kind: 'post', id: postId });
  feed.onDismissBlock();
  feed.onConfirmBlock();
  await flush();
  assert.equal(writes.length, 0);
  detail.onBlockPost();
  assert.equal(detail.data.block.confirmSource.kind, 'post');
  detail.onReload();
  assert.equal(detail.data.block.confirmSource, null);
  await flush();
  detail.onBlockComment(tap(rootId));
  assert.deepEqual(detail.data.block.confirmSource, {
    kind: 'comment',
    id: rootId,
  });
  detail.onDismissBlock();
  detail.onBlockReply(tap(replyId));
  assert.deepEqual(detail.data.block.confirmSource, {
    kind: 'reply',
    id: replyId,
  });
  detail.onDismissBlock();
  thread.onBlockRoot();
  assert.deepEqual(thread.data.block.confirmSource, {
    kind: 'comment',
    id: rootId,
  });
  thread.onDismissBlock();
  thread.onBlockPost();
  assert.deepEqual(thread.data.block.confirmSource, {
    kind: 'post',
    id: postId,
  });
  thread.onDismissBlock();
  thread.onBlockReply(tap(replyId));
  thread.onConfirmBlock();
  thread.onConfirmBlock();
  await flush();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.source, { kind: 'reply', id: replyId });
  assert.equal(thread.data.replies.length, 0);
  assert.equal(detail.data.comments[0].replyPreview.items.length, 0);
  assert.equal(thread.data.block.frozen, false);

  // Owner cleanup works without loading the removed target's content or profile.
  own.onMore();
  await flush();
  deferWrite = true;
  own.onUnblock(tap(removedId));
  own.onUnblock(tap(snapshotId));
  await flush();
  assert.equal(writes.length, 2);
  assert.equal(own.data.block.activeRelationshipId, removedId);
  assert.equal(own.data.block.busy, true);
  assert.equal(writes[1].route, `/v1/me/safety/blocks/${removedId}`);
  assert.equal('source' in writes[1].body, false);
  own.onBlockCancel();
  assert.equal(writeCancellation.isCancelled, true);
  assert.equal(own.data.block.frozen, true);
  assert.equal(own.data.block.receiptStatus, '');
  assert.equal(own.data.block.activeRelationshipId, removedId);
  own.onBlockRetry();
  await flush();
  assert.equal(writes.length, 3);
  assert.deepEqual(
    writes[2],
    writes[1],
    'Retry retains the exact original cleanup request',
  );
  completeWrite();
  deferWrite = false;
  await flush();
  assert.equal(
    own.data.items.some((item) => item.relationshipId === removedId),
    false,
  );
  assert.equal(own.data.block.current.blocked, false);

  // A committed response lost across app hide retains the original source-only
  // request. Own-list recovery does not re-read its now inaccessible post.
  deferWrite = true;
  feed.onBlockPost(tap(postId));
  feed.onConfirmBlock();
  feed.onConfirmBlock();
  await flush();
  assert.equal(writes.length, 4);
  assert.equal(feed.data.block.frozen, true);
  assert.equal(feed.data.block.receiptStatus, '');
  const pending = app.community.pendingBlocks.load(accountId);
  assert.deepEqual(pending.intent.source, { kind: 'post', id: postId });
  app.onHide();
  assert.equal(writeCancellation.isCancelled, true);
  assert.deepEqual(feed.data.posts, []);
  assert.equal(detail.data.post, null);
  assert.deepEqual(thread.data.replies, []);
  assert.deepEqual(own.data.items, []);
  completeWrite();
  deferWrite = false;
  await flush();
  assert.equal(feed.data.block.receiptStatus, '');
  assert.ok(app.community.pendingBlocks.load(accountId));
  own.onShow();
  await flush();
  assert.equal(own.data.block.frozen, true);
  own.onBlockReceipt();
  await flush();
  assert.equal(app.community.pendingBlocks.load(accountId), null);
  assert.equal(own.data.block.current.blocked, true);
  assert.match(own.data.block.receiptStatus, /已确认/);
  feed.onShow();
  detail.onShow();
  await flush();
  assert.deepEqual(
    feed.data.posts.map((post) => post.id),
    [anonymousId, selfId],
  );
  assert.equal(detail.data.post, null);
  assert.match(detail.data.error, /屏蔽|拉黑/);

  // An older list callback cannot populate the next account's page.
  deferList = true;
  own.onReload();
  await flush();
  assert.equal(own.data.items.length, 0);
  app.identity.sessions.logout();
  assert.equal(listCancellation.isCancelled, true);
  completeList();
  deferList = false;
  await flush();
  assert.equal(own.data.loaded, false);
  assert.deepEqual(own.data.items, []);
  assert.equal(own.data.block.current, null);
  for (const current of [feed, detail, thread, own]) {
    current.onUnload();
    assert.equal(current.blockMutations, undefined);
  }

  const recovery = readFileSync(
    path.join(dist, 'community/block-recovery.wxml'),
    'utf8',
  );
  assert.match(recovery, /匿名内容不会仅因/);
  assert.match(recovery, /任一方拉黑/);
  const ownTemplate = readFileSync(
    path.join(dist, 'pages/community-blocks/community-blocks.wxml'),
    'utf8',
  );
  assert.match(ownTemplate, /公开个人主页的拉黑入口尚未接入/);
  assert.match(
    ownTemplate,
    /block.activeRelationshipId === item.relationshipId/,
  );
  assert.equal(
    /profileId|accountId|actorId|studentNumber/.test(recovery + ownTemplate),
    false,
  );
  for (const current of [feed, detail, thread, own]) {
    for (const match of recovery.matchAll(/bindtap="([^"]+)"/g))
      assert.equal(
        typeof current[match[1]],
        'function',
        `Missing recovery handler ${match[1]}`,
      );
  }
  app.community.gateway = original.gateway;
  app.community.blocks = original.blocks;
  app.community.profiles = original.profiles;
  app.community.identityPrivacy = original.privacy;
  app.community.newRequestId = original.newRequestId;
  console.log(
    'Named-block compiled native smoke passed: current-source menus, cancel/reload confirmation clearing, duplicate click suppression, source-only transport, discussion invalidation, paged owner cleanup, per-row pending state, pull refresh, app-hide lost-response recovery, anonymous preservation and account-switch stale-list suppression',
  );
}
