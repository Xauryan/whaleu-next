import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpCoverGateway } from '../src/profile/cover-gateway';
import { CoverPrincipalOwner } from '../src/profile/cover-principal';
import { PROFILE_COVER_PROTOCOL as protocol } from '../src/profile/cover-contract';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  coverCurrent,
  coverIds,
  coverPrepare,
  coverPrepared,
  coverReceipt,
} from './support/cover-fixtures';
function setup() {
  const sessions = new SessionStore(),
    principals = new CoverPrincipalOwner(sessions),
    transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, sessions, {
    refresh: async () => sessions.snapshot(),
  });
  const gateway = new HttpCoverGateway(api);
  return { sessions, principals, transport, gateway };
}
test('guest metadata read has no authorization, signed bad token never falls back to guest', async () => {
  const s = setup();
  s.transport.reply(coverCurrent);
  const first = s.principals.snapshot();
  await s.gateway.current(
    coverIds.profile,
    {
      current: () => {
        s.principals.assertCurrent(first);
        return s.principals.snapshot();
      },
    },
    new Cancellation(),
  );
  assert.equal(s.transport.requests[0]!.headers.Authorization, undefined);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  s.transport.reply(
    {
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Denied',
        requestId: coverIds.request,
      },
    },
    401,
  );
  const second = s.principals.snapshot();
  await assert.rejects(
    s.gateway.current(
      coverIds.profile,
      {
        current: () => {
          s.principals.assertCurrent(second);
          return s.principals.snapshot();
        },
      },
      new Cancellation(),
    ),
  );
  assert.equal(s.transport.requests.length, 2);
  assert.ok(s.transport.requests[1]!.headers.Authorization);
});
test('independent mutation paths carry exact frozen Profile bodies and are never automatically replayed', async () => {
  const s = setup();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  const owner = s.sessions.snapshot(),
    session = {
      current: () => {
        s.sessions.assertCurrent(owner);
        return s.sessions.snapshot();
      },
    };
  s.transport.reply(coverPrepared());
  await s.gateway.prepare(coverPrepare, session, new Cancellation());
  assert.equal(
    s.transport.requests[0]!.url,
    'https://api.example.test/v1/me/profile/cover-edits',
  );
  assert.deepEqual(s.transport.requests[0]!.body, coverPrepare);
  const command = {
    protocol,
    clientRequestId: coverIds.command,
    expectedRevision: 5,
    source: { kind: 'clear' as const },
  };
  s.transport.reply(coverReceipt(command));
  await s.gateway.command(command, session, new Cancellation());
  assert.equal(
    s.transport.requests[1]!.url,
    'https://api.example.test/v1/me/profile/cover-commands',
  );
  s.transport.reply(
    {
      error: {
        code: 'ACCESS_TOKEN_EXPIRED',
        message: 'Expired',
        requestId: coverIds.request,
      },
    },
    401,
  );
  await assert.rejects(s.gateway.command(command, session, new Cancellation()));
  assert.equal(s.transport.requests.length, 3);
});

test('cover capability endpoint is owner-authenticated and rejects guest dispatch', async () => {
  const s = setup();
  const principal = { current: () => s.principals.snapshot() };
  await assert.rejects(s.gateway.capabilities(principal, new Cancellation()));
  assert.equal(s.transport.requests.length, 0);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  s.transport.reply({ protocol, upload: 'unavailable' });
  assert.equal(
    (await s.gateway.capabilities(principal, new Cancellation())).upload,
    'unavailable',
  );
  assert.equal(
    s.transport.requests[0]?.url,
    'https://api.example.test/v1/me/profile/cover-capabilities',
  );
  assert.ok(s.transport.requests[0]?.headers.Authorization);
});
