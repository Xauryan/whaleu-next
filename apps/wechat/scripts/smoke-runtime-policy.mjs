import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Real emitted pages, controllers, gateway and strict decoders; synthetic API
// responses only. This smoke is not ordinary-runtime HTTP/PG or device evidence.
export async function smokeRuntimePolicy({
  app,
  dist,
  mountPage,
  flush,
  postWire,
}) {
  const { HttpCommunityGateway } = require(
    path.join(dist, 'community/gateway.js'),
  );
  const { ClientError } = require(path.join(dist, 'api/errors.js'));
  const original = {
    gateway: app.community.gateway,
    newRequestId: app.community.newRequestId,
    profiles: app.community.profiles,
    identityPrivacy: app.community.identityPrivacy,
    reports: app.community.reports,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  const accountId = original.credentials.accountId;
  const { Cancellation } = require(path.join(dist, 'platform/contracts.js'));
  let likeSequence = 1,
    liveLike = false,
    loseLikeResponse = false,
    likeReceiptReady = true,
    finishLike;
  const likeReceipts = new Map();
  app.community.newRequestId = async () =>
    `cdcdcdcd-cdcd-4dcd-8dcd-${String(likeSequence++).padStart(12, '0')}`;
  const requestId = 'abababab-abab-4bab-8bab-abababababab';
  const publicPost = {
    ...postWire(),
    component: { kind: 'none' },
    commentCount: 0,
    replyCount: 0,
    discussionCount: 0,
    viewer: { ...postWire().viewer, canComment: false },
  };
  const capability = {
    publish: {
      availability: 'unavailable',
      reason: 'CONTENT_REVIEW_UNAVAILABLE',
    },
    authorModes: ['named', 'anonymous'],
    canDisableComments: true,
    postImageLimit: 9,
    commentImageLimit: 3,
    mediaAvailability: 'unavailable',
    commentRules: {
      unverifiedRequiresNamed: true,
      ownAnonymousPostForcesAnonymous: true,
    },
  };
  const unavailable = () =>
    new ClientError('http', 'safe', {
      serverCode: 'CONTENT_REVIEW_UNAVAILABLE',
      httpStatus: 503,
    });
  const requests = [];
  let leakAuthority = false,
    receiptReady = false,
    contentAvailable = true;
  let lateCapability, finishCapability;
  const gateway = new HttpCommunityGateway({
    async request(endpoint, options = {}) {
      requests.push({
        path: endpoint.path,
        method: endpoint.method,
        body: options.body,
      });
      let result;
      if (endpoint.path === '/v1/community/capabilities') {
        assert.deepEqual(options.query, {
          spaceId: publicPost.space.id,
          category: 'discussion',
        });
        result = lateCapability
          ? await lateCapability
          : {
              ...capability,
              ...(leakAuthority ? { approvalDecisionId: requestId } : {}),
            };
      } else if (endpoint.path === `/v1/community/posts/${publicPost.id}`) {
        if (!contentAvailable) throw unavailable();
        result = {
          ...publicPost,
          likeCount: liveLike ? 1 : 0,
          viewer: { ...publicPost.viewer, isLiked: liveLike },
        };
      } else if (
        endpoint.path === `/v1/community/posts/${publicPost.id}/comments`
      ) {
        result = { items: [], nextCursor: null };
      } else if (
        endpoint.path === `/v1/community/posts/${publicPost.id}/like`
      ) {
        assert.equal(endpoint.method, 'PUT');
        assert.equal(endpoint.authReplay, 'never');
        assert.deepEqual(Object.keys(options.body).sort(), [
          'liked',
          'requestId',
        ]);
        result = likeReceipts.get(options.body.requestId);
        if (!result) {
          const pending = app.community.pendingPostLikes.load(accountId);
          assert.equal(pending.requestId, options.body.requestId);
          assert.equal(pending.liked, options.body.liked);
          assert.equal(pending.postId, publicPost.id);
          liveLike = options.body.liked;
          result = {
            requestId: options.body.requestId,
            operation: 'set_post_like',
            postId: publicPost.id,
            liked: options.body.liked,
            outcome: 'applied',
          };
          likeReceipts.set(result.requestId, result);
          if (loseLikeResponse) {
            loseLikeResponse = false;
            await new Promise((resolve) => {
              finishLike = resolve;
            });
          }
        }
      } else if (
        endpoint.path.startsWith('/v1/me/community/post-like-requests/')
      ) {
        assert.equal(endpoint.method, 'GET');
        assert.equal(options.body, undefined);
        result = likeReceipts.get(endpoint.path.split('/').pop());
        if (!likeReceiptReady || !result)
          throw new ClientError('http', 'safe', {
            serverCode: 'REQUEST_NOT_FOUND',
            httpStatus: 404,
          });
      } else if (endpoint.path === `/v1/me/community/requests/${requestId}`) {
        if (!receiptReady) throw unavailable();
        result = {
          requestId,
          operation: 'publish_post',
          outcome: 'created',
          resourceId: publicPost.id,
          createdAt: '2026-10-07T00:00:00.000Z',
        };
      } else throw unavailable();
      return endpoint.decode(result);
    },
  });
  let profileReads = 0;
  app.community.gateway = gateway;
  app.community.profiles = {
    profile: async () => {
      profileReads++;
      return { accountId, preferences: { defaultAnonymousEnabled: true } };
    },
  };
  app.community.identityPrivacy = undefined;
  app.community.reports = undefined;
  const composeModule = path.join(
    dist,
    'pages/community-compose/community-compose.js',
  );
  const pages = [];
  const mount = (module, query) => {
    const page = mountPage(module, query);
    pages.push(page);
    return page;
  };
  try {
    const compose = mount(composeModule, {
      spaceId: publicPost.space.id,
      category: 'discussion',
    });
    await flush();
    compose.onText({ detail: { value: '审核提交尚未开放时只保存草稿' } });
    compose.onRestricted({ detail: { value: true } });
    assert.equal(compose.data.loaded, true);
    assert.equal(compose.data.canDisableComments, true);
    assert.equal(compose.data.canSubmit, false);
    assert.match(compose.data.blocker, /尚未开放审核/);
    compose.onSubmit();
    await flush();
    assert.equal(
      requests.some(({ method }) => method === 'POST'),
      false,
    );
    assert.equal(app.community.pending.load(accountId), null);

    const detail = mount(
      path.join(dist, 'pages/community-detail/community-detail.js'),
      { postId: publicPost.id },
    );
    await flush();
    assert.equal(detail.data.post.text, publicPost.text);
    assert.equal(detail.data.post.viewer.canComment, false);
    detail.onLike();
    await flush();
    assert.equal(detail.data.post.viewer.isLiked, true);
    assert.equal(detail.data.post.text, publicPost.text);
    assert.equal(
      requests.filter(({ path }) => path === '/v1/community/capabilities')
        .length,
      1,
    );
    assert.equal(profileReads, 1);

    // A malformed advisory cannot enable publishing or suppress another page's content.
    leakAuthority = true;
    compose.onReload();
    await flush();
    assert.equal(compose.data.canSubmit, false);
    assert.match(compose.data.error, /格式异常/);
    assert.equal(detail.data.post.text, publicPost.text);
    leakAuthority = false;

    // Native hide/reopen preserves lost-response intent even with an unreadable parent.
    const firstLike = [...likeReceipts.values()][0];
    loseLikeResponse = true;
    detail.onLike();
    await flush();
    const unresolved = app.community.pendingPostLikes.load(accountId);
    assert.equal(unresolved.liked, false);
    assert.equal(detail.data.postLikeMutation.frozen, true);
    const sentLikes = () =>
      requests.filter(({ path }) => path.endsWith('/like')).length;
    const beforeDuplicate = sentLikes();
    detail.onLike();
    await flush();
    assert.equal(sentLikes(), beforeDuplicate);
    detail.onHide();
    finishLike();
    await flush();
    assert.equal(detail.data.post, null);
    assert.deepEqual(
      app.community.pendingPostLikes.load(accountId),
      unresolved,
    );
    contentAvailable = false;
    detail.onShow();
    await flush();
    assert.equal(detail.data.post, null);
    assert.equal(detail.data.postLikeMutation.frozen, true);
    likeReceiptReady = false;
    detail.onPostLikeReceipt();
    await flush();
    assert.deepEqual(
      app.community.pendingPostLikes.load(accountId),
      unresolved,
    );
    assert.equal(detail.data.postLikeMutation.frozen, true);
    likeReceiptReady = true;
    detail.onPostLikeReceipt();
    await flush();
    assert.equal(app.community.pendingPostLikes.load(accountId), null);
    assert.equal(detail.data.post, null);
    // Replaying original like after independent unlike only returns history.
    assert.deepEqual(
      await gateway.like(
        {
          requestId: firstLike.requestId,
          operation: 'set_post_like',
          postId: publicPost.id,
          liked: true,
        },
        new Cancellation(),
      ),
      firstLike,
    );
    assert.equal(liveLike, false);
    contentAvailable = true;
    detail.onReload();
    await flush();
    assert.equal(detail.data.post.viewer.isLiked, false);
    assert.equal(detail.data.post.likeCount, 0);
    detail.onLike();
    await flush();
    assert.equal(detail.data.post.viewer.isLiked, true);
    assert.equal(likeReceipts.size, 3);
    assert.equal(new Set([...likeReceipts.keys()]).size, 3);
    const detailTemplate = readFileSync(
      path.join(dist, 'pages/community-detail/community-detail.wxml'),
      'utf8',
    );
    assert.match(detailTemplate, /post-like-recovery/);
    assert.match(
      detailTemplate,
      /postLikeMutation.busy \|\| postLikeMutation.frozen/,
    );
    const recoveryTemplate = readFileSync(
      path.join(dist, 'community/post-like-recovery.wxml'),
      'utf8',
    );
    assert.match(recoveryTemplate, /onPostLikeReceipt/);
    assert.match(recoveryTemplate, /onPostLikeRetry/);
    assert.match(recoveryTemplate, /onPostLikeCancel/);
    assert.match(recoveryTemplate, /当前点赞与赞数需重新读取/);

    lateCapability = new Promise((resolve) => {
      finishCapability = resolve;
    });
    compose.onReload();
    await flush();
    app.identity.sessions.completeLogin(
      app.identity.sessions.beginLogin(),
      original.credentials,
    );
    assert.equal(detail.data.post, null);
    assert.equal(compose.data.text, '');
    finishCapability(capability);
    await flush();
    assert.equal(compose.data.loaded, false);
    assert.equal(compose.data.canDisableComments, false);
    lateCapability = undefined;
    compose.onUnload();
    detail.onUnload();

    // Existing account-owned receipts remain recoverable with unavailable review
    // and inaccessible content, without profile, identity, approval or parent reads.
    const pending = {
      version: 1,
      accountId,
      operation: 'publish_post',
      payload: {
        clientRequestId: requestId,
        spaceId: publicPost.space.id,
        category: 'discussion',
        text: '保留原始待确认内容',
        imageAssetIds: [],
        authorMode: 'anonymous',
        commentsPolicy: 'open',
      },
    };
    app.community.pending.freeze(pending);
    contentAvailable = false;
    const before = requests.length,
      profilesBefore = profileReads;
    const recovery = mount(composeModule, {});
    await flush();
    assert.equal(recovery.data.frozen, true);
    assert.equal(requests.length, before);
    assert.equal(profileReads, profilesBefore);
    recovery.onReceipt();
    await flush();
    assert.equal(recovery.data.frozen, true);
    assert.deepEqual(app.community.pending.load(accountId), pending);
    app.onHide();
    assert.equal(recovery.data.text, '');
    assert.deepEqual(app.community.pending.load(accountId), pending);
    recovery.onShow();
    await flush();
    receiptReady = true;
    recovery.onReceipt();
    await flush();
    assert.equal(app.community.pending.load(accountId), null);
    assert.equal(recovery.data.receiptStatus, '发布已确认');
    assert.deepEqual(
      requests.slice(before).map(({ path }) => path),
      [
        `/v1/me/community/requests/${requestId}`,
        `/v1/me/community/requests/${requestId}`,
      ],
    );
    const template = readFileSync(
      path.join(dist, 'pages/community-compose/community-compose.wxml'),
      'utf8',
    );
    assert.match(template, /可另行确认身份校区，内容审核提交流程尚未开放/);
    assert.match(template, /pages\/identity-campus\/identity-campus/);
    assert.match(template, /返回后需再次点击发送/);
    assert.match(template, /显示身份选项不代表已取得发布资格/);
    assert.match(template, /查询原请求回执/);
  } finally {
    for (const page of pages) page.onUnload();
    app.community.gateway = original.gateway;
    app.community.newRequestId = original.newRequestId;
    app.community.profiles = original.profiles;
    app.community.identityPrivacy = original.identityPrivacy;
    app.community.reports = original.reports;
  }
}
