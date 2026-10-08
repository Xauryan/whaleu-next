import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpAnnouncementsGateway } from '../src/announcements/gateway';
import { Cancellation } from '../src/platform/contracts';
import { deferred, flush, ScriptedTransport } from './helpers';
import { HttpProfileGateway } from '../src/profile/gateway';
import { wireCredentials } from './identity-helpers';
import {
  announcementId,
  campusId,
  changes,
  detail,
  otherId,
  popup,
  revision,
  summary,
  timestamp,
  token,
} from './announcement-helpers';
function harness(loggedIn = false) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  return {
    sessions,
    transport,
    gateway: new HttpAnnouncementsGateway(
      new ApiClient('https://api.example', transport, sessions, {
        refresh: async () => {
          throw new Error('no refresh');
        },
      }),
    ),
  };
}
test('public list/detail/latest/changes keep optional auth and exact browsing context; no GET acknowledges', async () => {
  for (const loggedIn of [false, true]) {
    const h = harness(loggedIn),
      c = new Cancellation();
    h.transport.reply({
      context: { campusId: null },
      items: [summary()],
      continuation: 'end',
      nextCursor: null,
    });
    await h.gateway.list(null, null, c);
    h.transport.reply(detail());
    await h.gateway.detail(campusId, announcementId, c);
    h.transport.reply({ context: { campusId }, popup: popup() });
    await h.gateway.popup(campusId, c);
    h.transport.reply(changes(campusId));
    await h.gateway.changes(campusId, timestamp, c);
    assert.equal(
      new URL(h.transport.requests[0]!.url).searchParams.has('campusId'),
      false,
    );
    assert.equal(
      new URL(h.transport.requests[3]!.url).searchParams.get('since'),
      timestamp,
    );
    for (const request of h.transport.requests) {
      assert.equal(request.method, 'GET');
      assert.equal(request.body, undefined);
      assert.equal(!!request.headers.Authorization, loggedIn);
    }
  }
});
test('popup owner and explicit exact ID/revision command require login and strict receipt identity', async () => {
  const c = new Cancellation(),
    guest = harness();
  await assert.rejects(guest.gateway.ownerPopup(null, c));
  await assert.rejects(
    guest.gateway.acknowledge(null, announcementId, revision, c),
  );
  assert.equal(guest.transport.requests.length, 0);
  const h = harness(true);
  h.transport.reply({
    context: { campusId },
    candidate: popup(),
    acknowledgement: { status: 'unseen', acknowledgedAt: null },
  });
  await h.gateway.ownerPopup(campusId, c);
  h.transport.reply({
    announcementId,
    acknowledgement: { status: 'acknowledged', acknowledgedAt: timestamp },
  });
  await h.gateway.acknowledge(campusId, announcementId, revision, c);
  assert.equal(h.transport.requests[1]!.method, 'PUT');
  assert.deepEqual(h.transport.requests[1]!.body, {
    campusId,
    expectedRevision: revision,
  });
  h.transport.reply({
    announcementId: otherId,
    acknowledgement: { status: 'acknowledged', acknowledgedAt: timestamp },
  });
  await assert.rejects(
    h.gateway.acknowledge(campusId, announcementId, revision, c),
  );
});
test('invalid current optional bearer never falls back to guest; scope/target/cursor/protocol mismatch fails closed', async () => {
  const h = harness(true),
    c = new Cancellation();
  h.transport.reply(
    {
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Synthetic unauthorized',
      },
    },
    401,
  );
  await assert.rejects(h.gateway.list(null, null, c));
  assert.equal(h.transport.requests.length, 1);
  assert.ok(h.transport.requests[0]!.headers.Authorization);
  await assert.rejects(h.gateway.list('', null, c));
  await assert.rejects(h.gateway.detail(null, '../escape', c));
  await assert.rejects(h.gateway.list(null, 'bad', c));
  h.transport.reply({
    context: { campusId },
    items: [],
    continuation: 'end',
    nextCursor: null,
  });
  await assert.rejects(h.gateway.list(null, null, c));
  h.transport.reply({ ...detail(), id: otherId });
  await assert.rejects(h.gateway.detail(null, announcementId, c));
  h.transport.reply({
    context: { campusId: null },
    items: [summary()],
    continuation: 'more',
    nextCursor: token(),
  });
  await assert.rejects(h.gateway.list(null, null, c));
  h.transport.reply({
    context: { campusId: null },
    items: [summary()],
    continuation: 'end',
    nextCursor: null,
  });
  await assert.rejects(h.gateway.list(null, token(), c));
});

test('profile campus writes invalidate browsing readers before dispatch and after uncertain completion without changing identity scope', async () => {
  const h = harness(true),
    cancel = new Cancellation();
  const pending = deferred<Awaited<ReturnType<ScriptedTransport['send']>>>();
  let invalidations = 0;
  const profile = new HttpProfileGateway(
    new ApiClient('https://api.example', h.transport, h.sessions, {
      refresh: async () => {
        throw new Error('No refresh');
      },
    }),
    () => {
      invalidations++;
    },
  );
  h.transport.steps.push(async () => pending.promise);
  const writing = profile.selectCampus(
    { campusId, expectedRevision: 0 },
    cancel,
  );
  assert.equal(invalidations, 1);
  await flush();
  pending.reject(new Error('Lost reply'));
  await assert.rejects(writing);
  assert.equal(invalidations, 2);
  assert.throws(() =>
    profile.selectCampus({ campusId: 'bad', expectedRevision: 0 }, cancel),
  );
  assert.equal(invalidations, 2);
});
