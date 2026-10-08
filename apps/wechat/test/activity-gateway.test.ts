import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { HttpActivitiesGateway } from '../src/activities/gateway';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport, signedIn } from './helpers';
import {
  activityId,
  detail,
  otherRegion,
  page,
  receipt,
  regionId,
  token,
  visitIntent,
} from './activity-helpers';
function harness(loggedIn = true) {
  const transport = new ScriptedTransport(),
    sessions = loggedIn ? signedIn() : new SessionStore();
  return {
    transport,
    gateway: new HttpActivitiesGateway(
      new ApiClient('https://api.example', transport, sessions, {
        refresh: async () => {
          throw new Error('Unexpected refresh');
        },
      }),
    ),
  };
}
test('activity reads and exact visit PUT use required auth, bounded params, no GET body and matched receipt', async () => {
  const h = harness(),
    cancel = new Cancellation();
  h.transport.reply({ regionId, visitHistory: 'visited' });
  await h.gateway.context(cancel);
  h.transport.reply(page());
  await h.gateway.list(regionId, 'entry', null, cancel);
  h.transport.reply(detail());
  await h.gateway.detail(regionId, activityId, cancel);
  h.transport.reply(receipt());
  await h.gateway.visit(visitIntent(), cancel);
  assert.deepEqual(
    h.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', '/v1/activities/context'],
      ['GET', `/v1/regions/${regionId}/activities`],
      ['GET', `/v1/regions/${regionId}/activities/${activityId}`],
      ['PUT', `/v1/me/activity-visits/${visitIntent().requestId}`],
    ],
  );
  assert.equal(
    new URL(h.transport.requests[1]!.url).searchParams.get('limit'),
    '20',
  );
  for (const request of h.transport.requests) {
    assert.ok(request.headers.Authorization);
    if (request.method === 'GET') assert.equal(request.body, undefined);
  }
  assert.deepEqual(h.transport.requests[3]!.body, {
    regionId,
    expectedCatalogRevision: visitIntent().expectedCatalogRevision,
  });
});
test('guest, cancelled, unsafe/extra coordinates never dispatch, and mismatched public results fail closed', async () => {
  const guest = harness(false);
  await assert.rejects(guest.gateway.context(new Cancellation()));
  assert.equal(guest.transport.requests.length, 0);
  const h = harness(),
    cancel = new Cancellation();
  cancel.cancel();
  await assert.rejects(h.gateway.context(cancel));
  for (const limit of [0, 51, 1.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      h.gateway.list(regionId, 'entry', null, new Cancellation(), limit),
    );
  await assert.rejects(
    h.gateway.detail('../x', activityId, new Cancellation()),
  );
  assert.equal(h.transport.requests.length, 0);
  for (const wire of [
    page({ context: { ...page().context, regionId: otherRegion } }),
    page({ continuation: 'more', nextCursor: token(2) }),
    page({ pageCursor: token(2), nextCursor: token(2), continuation: 'more' }),
  ]) {
    h.transport.reply(wire);
    await assert.rejects(
      h.gateway.list(regionId, 'entry', null, new Cancellation()),
    );
  }
  h.transport.reply(page());
  await assert.rejects(
    h.gateway.list(regionId, 'all', null, new Cancellation()),
  );
  h.transport.reply(page({ pageCursor: token(3) }));
  await assert.rejects(
    h.gateway.list(regionId, 'entry', token(2), new Cancellation()),
  );
  h.transport.reply(detail({ regionId: otherRegion }));
  await assert.rejects(
    h.gateway.detail(regionId, activityId, new Cancellation()),
  );
  h.transport.reply(receipt({ catalogRevision: otherRegion }));
  await assert.rejects(h.gateway.visit(visitIntent(), new Cancellation()));
});
