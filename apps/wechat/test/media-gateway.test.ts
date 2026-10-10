import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import type { MediaPrepare, MediaSession } from '../src/media/contracts';
import { decodeMediaIntentStatus } from '../src/media/decoders';
import { HttpMediaGateway } from '../src/media/http-gateway';
import { Cancellation } from '../src/platform/contracts';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
const intentId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const input: MediaPrepare = {
  clientRequestId: intentId,
  draftId: intentId,
  spaceId: otherId,
  purpose: 'community-post-image',
  slot: 'images',
  ordinal: 0,
  declaration: { mime: 'image/png', bytes: 100 },
};
const status = {
  intentId,
  expiresAt: 1_900_000_000_000,
  status: 'prepared',
  reasonCode: null,
  retryable: false,
};
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const ticket = sessions.snapshot();
  const session: MediaSession = {
    current: () => {
      sessions.assertCurrent(ticket);
      return sessions.snapshot();
    },
  };
  const transport = new ScriptedTransport();
  const gateway = new HttpMediaGateway(
    'https://api.example',
    transport,
    sessions,
    {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    },
  );
  return { sessions, session, transport, gateway, cancel: new Cancellation() };
}
test('HTTP media prepare/status/finalize use authenticated exact routes and cancellation accepts only an empty 204', async () => {
  const h = setup();
  h.transport.reply(status);
  await h.gateway.prepare(input, h.session, h.cancel);
  assert.equal(
    h.transport.requests[0]?.url,
    'https://api.example/v1/media/upload-intents',
  );
  assert.deepEqual(h.transport.requests[0]?.body, input);
  assert.ok(h.transport.requests[0]?.headers.Authorization);
  h.transport.reply(status);
  await h.gateway.status(intentId, h.session, h.cancel);
  assert.equal(h.transport.requests[1]?.method, 'GET');
  assert.equal(
    h.transport.requests[1]?.url,
    `https://api.example/v1/media/upload-intents/${intentId}`,
  );
  h.transport.reply({ ...status, status: 'processing' });
  await h.gateway.finalize(intentId, h.session, h.cancel);
  assert.equal(
    h.transport.requests[2]?.url,
    `https://api.example/v1/media/upload-intents/${intentId}/finalize`,
  );
  assert.deepEqual(h.transport.requests[2]?.body, {});
  h.transport.reply('', 204);
  await h.gateway.cancel(intentId, h.session, h.cancel);
  assert.equal(
    h.transport.requests[3]?.url,
    `https://api.example/v1/media/upload-intents/${intentId}/cancel`,
  );
  h.transport.reply({}, 204);
  await assert.rejects(h.gateway.cancel(intentId, h.session, h.cancel));
});
test('exact status rejects extra URLs, wrong reason, unknown status, invalid IDs and non-ready asset disclosure', () => {
  assert.equal(decodeMediaIntentStatus(status).status, 'prepared');
  assert.equal(
    decodeMediaIntentStatus({ ...status, status: 'ready', assetId: otherId })
      .status,
    'ready',
  );
  for (const patch of [
    { url: 'https://media.example/image' },
    { status: 'unknown' },
    { assetId: otherId },
    { intentId: '../other' },
    { expiresAt: 'tomorrow' },
    { retryable: 'true' },
    { reasonCode: 'MEDIA_UNAVAILABLE' },
    { status: 'ready' },
  ])
    assert.throws(() => decodeMediaIntentStatus({ ...status, ...patch }));
  assert.equal(
    decodeMediaIntentStatus({
      ...status,
      status: 'unavailable',
      reasonCode: 'MEDIA_UNAVAILABLE',
      retryable: true,
    }).status,
    'unavailable',
  );
});
test('gateway rejects mismatched intent response, invalid prepare shape and unavailable grant without transfer/provider wiring', async () => {
  const h = setup();
  h.transport.reply({ ...status, intentId: otherId });
  await assert.rejects(h.gateway.status(intentId, h.session, h.cancel));
  await assert.rejects(
    h.gateway.prepare(
      {
        ...input,
        declaration: { ...input.declaration, width: 20 },
      } as MediaPrepare,
      h.session,
      h.cancel,
    ),
  );
  await assert.rejects(
    h.gateway.grant(intentId, h.session, h.cancel),
    (error: unknown) =>
      error instanceof ClientError && error.kind === 'configuration',
  );
  assert.equal(h.transport.requests.length, 1);
});
test('late HTTP success is rejected on account epoch change', async () => {
  const h = setup();
  const pending = deferred<ReturnType<typeof response>>();
  h.transport.steps.push(async () => pending.promise);
  const read = h.gateway.status(intentId, h.session, h.cancel);
  const rejected = assert.rejects(read);
  await flush();
  h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials('b'));
  pending.resolve(response(status));
  await rejected;
  assert.equal(h.transport.requests.length, 1);
});
test('status refreshes authentication within the same epoch but a stale media context cannot start a request', async () => {
  const h = setup();
  h.transport.reply(
    {
      error: {
        code: 'ACCESS_TOKEN_EXPIRED',
        message: 'expired',
        requestId: intentId,
      },
    },
    401,
  );
  h.transport.reply(status);
  await h.gateway.status(intentId, h.session, h.cancel);
  assert.equal(
    h.transport.requests[1]?.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
  h.sessions.beginLogin();
  await assert.rejects(h.gateway.status(intentId, h.session, h.cancel));
  assert.equal(h.transport.requests.length, 2);
});
