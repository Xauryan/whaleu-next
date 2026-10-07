import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { HttpProfileGateway } from '../src/profile/gateway';
import { Cancellation } from '../src/platform/contracts';
import { WechatTransport, type WxApi } from '../src/platform/wechat';
import {
  FakeClock,
  ScriptedTransport,
  deferred,
  flush,
  response,
} from './helpers';
import { wireCredentials } from './identity-helpers';
import { campus, campusId, ownProfile } from './profile-helpers';
function setup() {
  const sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const transport = new ScriptedTransport();
  let refreshes = 0;
  const api = new ApiClient(
    'https://api.example.invalid',
    transport,
    sessions,
    {
      refresh: async () => {
        refreshes += 1;
        return sessions.snapshot();
      },
    },
  );
  return {
    sessions,
    transport,
    gateway: new HttpProfileGateway(api),
    refreshes: () => refreshes,
  };
}
test('campus gateway omits blank optional filters and never sends identity tokens to public catalog', async () => {
  const s = setup();
  s.transport.reply({ items: [], page: 1, pageSize: 20, total: 0 });
  await s.gateway.campuses(
    { q: '', district: '', page: 1, pageSize: 20 },
    new Cancellation(),
  );
  assert.equal(
    s.transport.requests[0]?.url,
    'https://api.example.invalid/v1/campuses?page=1&pageSize=20',
  );
  assert.equal(s.transport.requests[0]?.headers.Authorization, undefined);
});
test('campus query values are percent encoded without changing endpoint or fragments', async () => {
  const s = setup();
  s.transport.reply({ items: [campus()], page: 2, pageSize: 20, total: 21 });
  await s.gateway.campuses(
    { q: '鲸&/?#', district: '海 淀', page: 2, pageSize: 20 },
    new Cancellation(),
  );
  assert.equal(
    s.transport.requests[0]?.url,
    `https://api.example.invalid/v1/campuses?page=2&pageSize=20&q=${encodeURIComponent('鲸&/?#')}&district=${encodeURIComponent('海 淀')}`,
  );
});
test('profile gateway uses exact new endpoint, expected revision and no user or role fields', async () => {
  const s = setup();
  s.transport.reply(ownProfile());
  s.transport.reply(ownProfile({ revision: 1, nickname: '鲸' }));
  s.transport.reply(ownProfile({ revision: 2 }));
  s.transport.reply(ownProfile({ revision: 3, selectedCampus: campus() }));
  const cancel = new Cancellation();
  await s.gateway.profile(cancel);
  await s.gateway.updateProfile(
    { expectedRevision: 0, nickname: '鲸' },
    cancel,
  );
  await s.gateway.updatePreferences(
    { expectedRevision: 1, preferences: { showHotTopic: false } },
    cancel,
  );
  await s.gateway.selectCampus({ expectedRevision: 2, campusId }, cancel);
  assert.deepEqual(
    s.transport.requests.map((item) => [item.method, item.url.split('/v1')[1]]),
    [
      ['GET', '/me/profile'],
      ['PATCH', '/me/profile'],
      ['PATCH', '/me/preferences'],
      ['PUT', '/me/campus'],
    ],
  );
  assert.deepEqual(s.transport.requests[1]?.body, {
    expectedRevision: 0,
    nickname: '鲸',
  });
  assert.equal(
    s.transport.requests[3]?.headers.Authorization,
    `Bearer ${wireCredentials().accessToken}`,
  );
});
test('writes reject invalid fields before transport and never refresh/replay an uncertain or rejected mutation', async () => {
  const s = setup(),
    cancel = new Cancellation();
  assert.throws(() =>
    s.gateway.updateProfile(
      { expectedRevision: 0, nickname: 'bad space' },
      cancel,
    ),
  );
  assert.throws(() =>
    s.gateway.selectCampus({ expectedRevision: 0, campusId: 'fake' }, cancel),
  );
  assert.equal(s.transport.requests.length, 0);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(
    s.gateway.updateProfile({ expectedRevision: 0, bio: 'hello' }, cancel),
    { kind: 'auth-expired' },
  );
  assert.equal(s.refreshes(), 0);
  assert.equal(s.transport.requests.length, 1);
});
test('read permits one expiry refresh but rejects malformed success/status and mismatched pagination', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(ownProfile());
  await s.gateway.profile(cancel);
  assert.equal(s.refreshes(), 1);
  s.transport.reply(ownProfile(), 201);
  await assert.rejects(s.gateway.profile(cancel), { kind: 'protocol' });
  s.transport.reply({ ...ownProfile(), admin: true });
  await assert.rejects(s.gateway.profile(cancel), { kind: 'protocol' });
  s.transport.reply({ items: [], page: 2, pageSize: 20, total: 0 });
  await assert.rejects(
    s.gateway.campuses({ q: '', district: '', page: 1, pageSize: 20 }, cancel),
    { kind: 'protocol' },
  );
});
test('account switch prevents late profile reads and saves from reaching the new account', async () => {
  const s = setup(),
    late = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => late.promise);
  const pending = s.gateway.updateProfile(
    { expectedRevision: 0, bio: 'old account' },
    new Cancellation(),
  );
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: '99999999-9999-4999-8999-999999999999',
  });
  late.resolve(response(ownProfile({ revision: 1 })));
  await assert.rejects(pending, { kind: 'stale-session' });
  assert.equal(s.transport.requests.length, 1);
});
test('fake native platform aborts a campus request and never leaks late native data', async () => {
  const clock = new FakeClock(),
    sessions = new SessionStore();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let aborted = 0;
  let callback: Parameters<WxApi['request']>[0] | undefined;
  const transport = new WechatTransport(
    {
      request(options) {
        callback = options;
        return {
          abort() {
            aborted += 1;
          },
        };
      },
    },
    clock,
  );
  const gateway = new HttpProfileGateway(
    new ApiClient('https://api.example.invalid', transport, sessions, {
      refresh: async () => sessions.snapshot(),
    }),
  );
  const cancel = new Cancellation();
  const pending = gateway.campuses(
    { q: '', district: '', page: 1, pageSize: 20 },
    cancel,
  );
  await flush();
  cancel.cancel();
  await assert.rejects(pending, { kind: 'cancelled' });
  assert.equal(aborted, 1);
  assert.equal(clock.timers, 0);
  callback?.success({
    statusCode: 200,
    data: { items: [campus()], page: 1, pageSize: 20, total: 1 },
  });
});
