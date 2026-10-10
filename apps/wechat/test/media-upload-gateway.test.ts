import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpUploadGateway } from '../src/media/upload-gateway';
import type { MediaSession } from '../src/media/contracts';
import { Cancellation } from '../src/platform/contracts';
import { credentials, ScriptedTransport, signedIn } from './helpers';
import {
  grant,
  hash,
  ids,
  notRecorded,
  origin,
  prepare,
  prepared,
  recovery,
  terminal,
} from './support/media-upload-fixtures';
function harness() {
  const sessions = signedIn(ids.actor),
    ticket = sessions.snapshot(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const auth = {
    async refresh() {
      refreshes++;
      return sessions.rotate(ticket, credentials(ids.actor, 'fresh'));
    },
  };
  const session: MediaSession = {
    current: () => {
      sessions.assertCurrent(ticket);
      return sessions.snapshot();
    },
  };
  return {
    sessions,
    ticket,
    transport,
    session,
    cancel: new Cancellation(),
    gateway: new HttpUploadGateway(origin, transport, sessions, auth),
    refreshes: () => refreshes,
  };
}
test('v2 gateway uses exact versioned routes and no caller URL/query; prepare remains immutable', async () => {
  const h = harness();
  h.transport.reply(prepared());
  await h.gateway.prepare(prepare, h.session, h.cancel);
  h.transport.reply(notRecorded);
  await h.gateway.recover(ids.request, h.session, h.cancel);
  h.transport.reply(grant);
  await h.gateway.grant(ids.intent, h.session, h.cancel);
  h.transport.reply(recovery(terminal()));
  await h.gateway.cancelRequest(ids.request, hash, h.session, h.cancel);
  assert.deepEqual(
    h.transport.requests.map((r) => r.url),
    [
      `${origin}/v2/media/upload-intents`,
      `${origin}/v2/media/upload-requests/${ids.request}`,
      `${origin}/v2/media/upload-intents/${ids.intent}/grant`,
      `${origin}/v2/media/upload-requests/${ids.request}/cancel`,
    ],
  );
  assert.deepEqual(h.transport.requests[0]!.body, prepare);
  assert.deepEqual(h.transport.requests[3]!.body, { requestHash: hash });
  assert.ok(
    h.transport.requests.every(
      (r) => r.headers.Authorization === 'Bearer synthetic-access-a',
    ),
  );
});
test('read-only request lookup refreshes once; prepare/grant/finalize/cancel writes never auto replay', async () => {
  const h = harness();
  h.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  h.transport.reply(notRecorded);
  await h.gateway.recover(ids.request, h.session, h.cancel);
  assert.equal(h.refreshes(), 1);
  assert.equal(
    h.transport.requests[1]!.headers.Authorization,
    'Bearer synthetic-access-fresh',
  );
  for (const action of [
    () => h.gateway.prepare(prepare, h.session, h.cancel),
    () => h.gateway.grant(ids.intent, h.session, h.cancel),
    () => h.gateway.finalize(ids.intent, h.session, h.cancel),
    () => h.gateway.cancelRequest(ids.request, hash, h.session, h.cancel),
  ]) {
    h.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
    const count = h.transport.requests.length;
    await assert.rejects(action());
    assert.equal(h.transport.requests.length, count + 1);
  }
  assert.equal(h.refreshes(), 1);
});
test('gateway rejects mismatched intent/request receipts and old actors before transport', async () => {
  const h = harness();
  h.transport.reply({ ...prepared(), intentId: ids.other });
  await assert.rejects(h.gateway.status(ids.intent, h.session, h.cancel));
  h.transport.reply({ ...notRecorded, requestId: ids.other });
  await assert.rejects(h.gateway.recover(ids.request, h.session, h.cancel));
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials(ids.other));
  const count = h.transport.requests.length;
  await assert.rejects(h.gateway.prepare(prepare, h.session, h.cancel));
  assert.equal(h.transport.requests.length, count);
});
