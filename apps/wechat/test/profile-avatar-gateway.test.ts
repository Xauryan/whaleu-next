import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpAvatarGateway } from '../src/profile/avatar-gateway';
import { AvatarPrincipalOwner } from '../src/profile/avatar-principal';
import { PROFILE_MEDIA_PROTOCOL as protocol } from '../src/profile/avatar-contract';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  avatarCurrent,
  avatarIds,
  avatarPrepare,
  avatarPrepared,
  avatarReceipt,
} from './support/avatar-fixtures';
function setup() {
  const sessions = new SessionStore(),
    principals = new AvatarPrincipalOwner(sessions),
    transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, sessions, {
    refresh: async () => sessions.snapshot(),
  });
  const gateway = new HttpAvatarGateway(api);
  return { sessions, principals, transport, gateway };
}
test('guest metadata read has no authorization, signed bad token never falls back to guest', async () => {
  const s = setup();
  s.transport.reply(avatarCurrent);
  const first = s.principals.snapshot();
  await s.gateway.current(
    avatarIds.profile,
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
        requestId: avatarIds.request,
      },
    },
    401,
  );
  const second = s.principals.snapshot();
  await assert.rejects(
    s.gateway.current(
      avatarIds.profile,
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
  s.transport.reply(avatarPrepared());
  await s.gateway.prepare(avatarPrepare, session, new Cancellation());
  assert.equal(
    s.transport.requests[0]!.url,
    'https://api.example.test/v1/me/profile/avatar-edits',
  );
  assert.deepEqual(s.transport.requests[0]!.body, avatarPrepare);
  const command = {
    protocol,
    clientRequestId: avatarIds.command,
    expectedRevision: 5,
    source: { kind: 'clear' as const },
  };
  s.transport.reply(avatarReceipt(command));
  await s.gateway.command(command, session, new Cancellation());
  assert.equal(
    s.transport.requests[1]!.url,
    'https://api.example.test/v1/me/profile/avatar-commands',
  );
  s.transport.reply(
    {
      error: {
        code: 'ACCESS_TOKEN_EXPIRED',
        message: 'Expired',
        requestId: avatarIds.request,
      },
    },
    401,
  );
  await assert.rejects(s.gateway.command(command, session, new Cancellation()));
  assert.equal(s.transport.requests.length, 3);
});
test('nonpersonal catalog sends no token and command cancellation uses its exact separate fence endpoint', async () => {
  const s = setup();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  const principal = s.principals.snapshot(),
    context = {
      current: () => {
        s.principals.assertCurrent(principal);
        return s.principals.snapshot();
      },
    };
  s.transport.reply({
    protocol,
    availability: 'unavailable',
    catalogVersion: null,
    items: [],
  });
  await s.gateway.catalog(context, new Cancellation());
  assert.equal(s.transport.requests[0]!.headers.Authorization, undefined);
  const ticket = s.sessions.snapshot(),
    session = {
      current: () => {
        s.sessions.assertCurrent(ticket);
        return s.sessions.snapshot();
      },
    };
  const requestHash = 'a'.repeat(64);
  s.transport.reply({
    protocol,
    clientRequestId: avatarIds.command,
    state: 'cancelled',
    requestHash,
  });
  await s.gateway.cancelCommand(
    avatarIds.command,
    requestHash,
    session,
    new Cancellation(),
  );
  assert.equal(
    s.transport.requests[1]!.url,
    `https://api.example.test/v1/me/profile/avatar-command-requests/${avatarIds.command}/cancel`,
  );
  assert.deepEqual(s.transport.requests[1]!.body, { protocol, requestHash });
});
