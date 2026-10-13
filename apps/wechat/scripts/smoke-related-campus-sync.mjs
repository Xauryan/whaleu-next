import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
// Actual emitted Page/handler/journal/HTTP decoder journey with synthetic responses.
// Real HTTP/AppModule/PostgreSQL and physical-device acceptance are separate gates.
export async function smokeRelatedCampusSync({
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
  const { batchPublicationReference } = require(
    path.join(dist, 'media/batch-publication.js'),
  );
  const saved = {
    gateway: app.community.gateway,
    profiles: app.community.profiles,
    newRequestId: app.community.newRequestId,
  };
  const accountId = app.identity.sessions.snapshot().credentials.accountId;
  const post = postWire(),
    destination = 'abababab-abab-4bab-8bab-abababababab',
    requestId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  const requests = [];
  let reviewStatus = 'pending',
    published = false,
    page;
  app.community.newRequestId = async () => requestId;
  app.community.profiles = {
    profile: async () => ({
      accountId,
      preferences: { defaultAnonymousEnabled: true },
    }),
  };
  app.community.gateway = new HttpCommunityGateway({
    async request(endpoint, options = {}) {
      requests.push({
        path: endpoint.path,
        body: options.body,
        query: options.query,
      });
      let result;
      if (endpoint.path === '/v1/community/capabilities')
        result = {
          publish: { availability: 'allowed', reason: null },
          relatedCampusSync: { availability: 'allowed', reason: null },
          authorModes: ['named', 'anonymous'],
          canDisableComments: false,
          postImageLimit: 9,
          commentImageLimit: 3,
          mediaAvailability: 'unavailable',
          commentRules: {
            unverifiedRequiresNamed: true,
            ownAnonymousPostForcesAnonymous: true,
          },
        };
      else if (endpoint.path === '/v1/community/reviews/posts') {
        assert.equal(options.body.syncToRelatedCampuses, true);
        assert.equal(
          app.community.pending.load(accountId).viewSpaceId,
          destination,
        );
        result = { requestId, operation: 'publish_post', status: reviewStatus };
      } else if (
        endpoint.path === `/v1/community/reviews/requests/${requestId}`
      )
        result = { requestId, operation: 'publish_post', status: reviewStatus };
      else if (
        endpoint.path === '/v1/community/posts' &&
        endpoint.method === 'POST'
      ) {
        assert.equal(options.body.syncToRelatedCampuses, true);
        published = true;
        throw new ClientError(
          'timeout',
          'Synthetic response loss after publication',
        );
      } else if (endpoint.path === `/v1/me/community/requests/${requestId}`) {
        if (!published)
          throw new ClientError('http', 'Not yet recorded', {
            httpStatus: 404,
            serverCode: 'REQUEST_NOT_FOUND',
          });
        result = {
          requestId,
          operation: 'publish_post',
          outcome: 'created',
          resourceId: post.id,
          createdAt: post.publishedAt,
        };
      } else
        throw new Error(
          `Unexpected related-sync smoke route: ${endpoint.path}`,
        );
      return endpoint.decode(result);
    },
  });
  try {
    page = mountPage(
      path.join(dist, 'pages/community-compose/community-compose.js'),
      {
        spaceId: post.space.id,
        category: 'discussion',
        viewSpaceId: destination,
      },
    );
    await flush();
    assert.equal(page.data.syncToRelatedCampuses, false);
    page.onText({ detail: { value: '合成关联学校同步正文' } });
    page.onRelatedCampusSync({ detail: { value: true } });
    assert.equal(page.data.syncToRelatedCampuses, true);
    page.onReload();
    await flush();
    assert.equal(page.data.syncToRelatedCampuses, false);
    page.onRelatedCampusSync({ detail: { value: true } });
    page.onSubmit();
    await flush();
    const frozen = app.community.pending.load(accountId);
    assert.equal(frozen.payload.syncToRelatedCampuses, true);
    assert.equal(frozen.viewSpaceId, destination);
    const originalHash = batchPublicationReference(frozen).intentHash;
    page.onHide();
    page.onShow();
    await flush();
    assert.equal(page.data.syncToRelatedCampuses, true);
    assert.equal(page.data.frozen, true);
    page.onRelatedCampusSync({ detail: { value: false } });
    assert.equal(
      batchPublicationReference(app.community.pending.load(accountId))
        .intentHash,
      originalHash,
    );
    reviewStatus = 'approved';
    page.onRetry();
    await flush();
    assert.equal(published, true);
    assert.equal(page.data.frozen, true);
    page.onReceipt();
    await flush();
    assert.equal(app.community.pending.load(accountId), null);
    assert.equal(page.data.resourcePostId, post.id);
    assert.equal(
      requests.filter((item) => item.path === '/v1/community/posts').length,
      1,
    );
    const template = readFileSync(
      path.join(dist, 'pages/community-compose/community-compose.wxml'),
      'utf8',
    );
    assert.match(template, /bindchange="onRelatedCampusSync"/);
    assert.match(template, /relatedCampusSyncNotice/);
    assert.match(template, /viewSpaceQuery/);
    for (const name of ['community-feed', 'community-hot', 'community-search'])
      assert.match(
        readFileSync(path.join(dist, `pages/${name}/${name}.wxml`), 'utf8'),
        /relatedCampusDistribution === 'unavailable'/,
      );
  } finally {
    page?.onUnload();
    app.community.gateway = saved.gateway;
    app.community.profiles = saved.profiles;
    app.community.newRequestId = saved.newRequestId;
  }
}
