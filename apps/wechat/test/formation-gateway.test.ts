import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpCommunityGateway } from '../src/community/gateway';
import { Cancellation } from '../src/platform/contracts';
import { ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  formation,
  formationReceipt,
  postId,
  requestId,
  otherId,
  createdAt,
  intent,
  receipt,
} from './community-helpers';
const join = {
  clientRequestId: requestId,
  contacts: { wechat: 'synthetic', qq: '', phone: '' },
  contactSharing: 'members_v1' as const,
};
function setup(loggedIn = true) {
  const sessions = new SessionStore();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpCommunityGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
test('strict formation gateway uses parent-visible and owner-only paths, exact intended contacts and explicit sharing', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(formation());
  await s.gateway.formation(postId, cancel);
  s.transport.reply(formationReceipt(), 201);
  await s.gateway.joinFormation(postId, join, cancel);
  s.transport.reply(formationReceipt());
  await s.gateway.formationReceipt(requestId, cancel);
  s.transport.reply({
    postId,
    membershipId: otherId,
    joinedAt: createdAt,
    isCreator: false,
  });
  await s.gateway.ownFormationMembership(postId, cancel);
  s.transport.reply({ postId, members: [] });
  await s.gateway.formationContacts(postId, cancel);
  assert.deepEqual(
    s.transport.requests.map((item) => [item.method, item.url]),
    [
      ['GET', `https://api.example/v1/community/posts/${postId}/formation`],
      [
        'POST',
        `https://api.example/v1/community/posts/${postId}/formation/memberships`,
      ],
      [
        'GET',
        `https://api.example/v1/me/community/formation-requests/${requestId}`,
      ],
      [
        'GET',
        `https://api.example/v1/me/community/formation-memberships/${postId}`,
      ],
      [
        'GET',
        `https://api.example/v1/community/posts/${postId}/formation/contacts`,
      ],
    ],
  );
  assert.deepEqual(s.transport.requests[1]!.body, join);
  assert.ok(s.transport.requests.every((r) => r.headers.Authorization));
  const guest = setup(false);
  await assert.rejects(guest.gateway.formationContacts(postId, cancel));
  assert.equal(guest.transport.requests.length, 0);
});
test('formation publication preserves component payload and never silently drops formation into none', async () => {
  const s = setup(),
    component = {
      kind: 'formation' as const,
      capacity: 1,
      theme: '组队',
      contacts: join.contacts,
      contactSharing: 'members_v1' as const,
    };
  s.transport.reply(receipt(), 201);
  await s.gateway.publishPost(intent({ component }), new Cancellation());
  assert.deepEqual(
    (s.transport.requests[0]!.body as Record<string, unknown>).component,
    component,
  );
});
test('formation responses reject parent/receipt/status mismatches and contact/error leakage', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(formation({ postId: otherId }));
  await assert.rejects(s.gateway.formation(postId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(formationReceipt(), 200);
  await assert.rejects(s.gateway.joinFormation(postId, join, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(formationReceipt({ requestId: otherId }));
  await assert.rejects(s.gateway.formationReceipt(requestId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ postId: otherId, members: [] });
  await assert.rejects(s.gateway.formationContacts(postId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({
    postId,
    membershipId: otherId,
    joinedAt: createdAt,
    isCreator: false,
    contacts: join.contacts,
  });
  await assert.rejects(s.gateway.ownFormationMembership(postId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ error: { code: 'FORMATION_FULL' } }, 403);
  await assert.rejects(s.gateway.formation(postId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ error: { code: 'FORMATION_MEMBERSHIP_REQUIRED' } }, 403);
  await assert.rejects(s.gateway.formationContacts(postId, cancel), {
    kind: 'forbidden',
  });
});
test('access refresh retries exact join intent with same key; malformed intent never reaches transport', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(formationReceipt(), 201);
  await s.gateway.joinFormation(postId, join, cancel);
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  const before = s.transport.requests.length;
  await assert.rejects(
    s.gateway.joinFormation(
      postId,
      { ...join, contacts: { ...join.contacts, wechat: 'x'.repeat(101) } },
      cancel,
    ),
  );
  assert.equal(s.transport.requests.length, before);
});
