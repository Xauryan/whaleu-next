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
    profiles: app.community.profiles,
    identityPrivacy: app.community.identityPrivacy,
    reports: app.community.reports,
    credentials: app.identity.sessions.snapshot().credentials,
  };
  const accountId = original.credentials.accountId;
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
        result = publicPost;
      } else if (
        endpoint.path === `/v1/community/posts/${publicPost.id}/comments`
      ) {
        result = { items: [], nextCursor: null };
      } else if (
        endpoint.path === `/v1/community/posts/${publicPost.id}/like`
      ) {
        assert.equal(endpoint.method, 'PUT');
        assert.equal(options.body, undefined);
        result = { postId: publicPost.id, isLiked: true, likeCount: 1 };
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
    assert.match(template, /身份校区选择与审核提交流程尚未开放/);
    assert.match(template, /显示身份选项不代表已取得发布资格/);
    assert.match(template, /查询原请求回执/);
  } finally {
    for (const page of pages) page.onUnload();
    app.community.gateway = original.gateway;
    app.community.profiles = original.profiles;
    app.community.identityPrivacy = original.identityPrivacy;
    app.community.reports = original.reports;
  }
}
