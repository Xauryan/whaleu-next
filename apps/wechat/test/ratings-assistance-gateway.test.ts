import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpAssistanceGateway } from '../src/ratings/assistance-gateway';
import {
  assistanceIntentHash,
  decodeAssistanceRequest,
} from '../src/ratings/assistance-contract';
import { HttpCommunityGateway } from '../src/community/gateway';
import { decodePostIntent } from '../src/community/contract';
import { batchPublicationReference } from '../src/media/batch-publication';
import { managementContext, managedSnapshot } from './category-scoped-helpers';
import { categoryTestId } from './category-management-helpers';
import { ScriptedTransport, deferred, response } from './helpers';
import { wireCredentials } from './identity-helpers';
import { intent, requestId } from './community-helpers';
function harness() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const api = new ApiClient('https://synthetic.example', transport, sessions, {
    refresh: async () => sessions.snapshot(),
  });
  const context = managementContext({ kind: 'global' }).commandContext;
  const request = decodeAssistanceRequest({
    version: 1,
    requestId,
    draftId: categoryTestId(9700),
    inputRevision: 0,
    purpose: 'category_description',
    selector: context.selector,
    context,
    payload: {
      operation: 'create_categories_scoped',
      parentId: null,
      draftNodeKey: 'root',
      name: '课程',
      placement: { kind: 'global' },
      expectedSnapshot: managedSnapshot,
    },
  });
  const metadata = {
    version: 1,
    requestId,
    purpose: request.purpose,
    intentHash: assistanceIntentHash(request),
    outcome: 'unavailable',
  } as const;
  return {
    sessions,
    transport,
    api,
    request,
    metadata,
    gateway: new HttpAssistanceGateway(api, sessions),
  };
}
test('assistance uses four exact authenticated endpoints; result/status GETs never resend input or context', async () => {
  const s = harness(),
    cancel = new Cancellation();
  s.transport.reply(s.metadata);
  await s.gateway.create(s.request, cancel);
  s.transport.reply(s.metadata);
  await s.gateway.status(requestId, cancel);
  s.transport.reply({ status: 'unavailable' });
  await s.gateway.result(requestId, cancel);
  s.transport.reply(s.metadata);
  await s.gateway.cancel(s.metadata, cancel);
  const requests = s.transport.requests;
  assert.deepEqual(
    requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['POST', '/v2/ratings/assistance/requests'],
      ['GET', `/v2/ratings/assistance/requests/${requestId}`],
      ['GET', `/v2/ratings/assistance/requests/${requestId}/result`],
      ['POST', `/v2/ratings/assistance/requests/${requestId}/cancel`],
    ],
  );
  assert.deepEqual(requests[0]!.body, s.request);
  assert.equal(requests[1]!.body, undefined);
  assert.equal(requests[2]!.body, undefined);
  assert.deepEqual(requests[3]!.body, {
    purpose: s.request.purpose,
    intentHash: s.metadata.intentHash,
  });
  for (const request of requests) {
    assert.equal(new URL(request.url).search, '');
    assert.ok(request.headers.Authorization);
  }
  s.transport.reply({ ...s.metadata, intentHash: 'f'.repeat(64) });
  await assert.rejects(s.gateway.create(s.request, cancel));
});
test('late assistance metadata after same-account relogin is rejected instead of populating another page', async () => {
  const s = harness(),
    held = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => held.promise);
  const loading = s.gateway.status(requestId, new Cancellation());
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  held.resolve(response({ data: s.metadata }));
  await assert.rejects(loading);
});
test('v5 Review and publish gateways send typed card without silently falling back to none, exact cancel hash retained', async () => {
  const s = harness(),
    gateway = new HttpCommunityGateway(s.api),
    cancel = new Cancellation();
  const payload = decodePostIntent(
    intent({
      component: {
        kind: 'rating_target_link',
        targetId: categoryTestId(9710),
        label: '手动标签',
        selector: { kind: 'campus', campusId: categoryTestId(9711) },
        expectedTargetRevision: categoryTestId(9712),
        expectedCategoryRevision: categoryTestId(9713),
        expectedSourceRevision: categoryTestId(9714),
      },
    }),
  );
  const attempt = {
    kind: 'community_rating_target_link_v5' as const,
    version: 5 as const,
    accountId: wireCredentials().accountId,
    operation: 'publish_post' as const,
    payload,
  };
  s.transport.reply({
    requestId,
    operation: 'publish_post',
    status: 'pending',
  });
  await gateway.submitReview(attempt, cancel);
  s.transport.reply(
    {
      requestId,
      operation: 'publish_post',
      outcome: 'created',
      resourceId: categoryTestId(9715),
      createdAt: new Date().toISOString(),
    },
    201,
  );
  await gateway.publishPost(payload, cancel);
  s.transport.reply({
    requestId,
    operation: 'publish_post',
    outcome: 'cancelled',
    intentHash: batchPublicationReference(attempt).intentHash,
  });
  await gateway.cancelReview(attempt, cancel);
  assert.deepEqual(
    (s.transport.requests[0]!.body as Record<string, unknown>).component,
    payload.component,
  );
  assert.deepEqual(
    (s.transport.requests[1]!.body as Record<string, unknown>).component,
    payload.component,
  );
  assert.deepEqual(s.transport.requests[2]!.body, {
    operation: 'publish_post',
    intentHash: batchPublicationReference(attempt).intentHash,
  });
});
