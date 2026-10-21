import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SafetyChanges } from '../src/community/safety-changes';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeOwnProfileStats,
  unavailableProfileCount,
  type OwnProfileStats,
} from '../src/profile/stats-contract';
import {
  ProfileStatsController,
  type ProfileStatsView,
} from '../src/profile/stats-controller';
import {
  HttpProfileStatsGateway,
  type ProfileStatsGateway,
} from '../src/profile/stats-gateway';
import { otherId, setup } from './community-helpers';
import { deferred, flush, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';

const owned = (patch: Partial<OwnProfileStats> = {}): OwnProfileStats => ({
  accountId: wireCredentials().accountId,
  following: { status: 'known', value: 0 },
  followers: { status: 'known', value: 17 },
  receivedInteractions: unavailableProfileCount(),
  ...patch,
});
function harness(loggedIn = true) {
  const s = setup(loggedIn);
  const safetyChanges = new SafetyChanges(s.runtime.privateViews);
  const runtime = { ...s.runtime, safetyChanges };
  const gateway: ProfileStatsGateway = { own: async () => owned() };
  let view: ProfileStatsView;
  const controller = new ProfileStatsController(runtime, gateway, (next) => {
    view = next;
  });
  return { ...s, runtime, gateway, controller, view: () => view! };
}

test('profile stats strictly distinguish confirmed zero and unavailable, reject invented received totals and extra data', () => {
  assert.equal(decodeOwnProfileStats(owned()).following.value, 0);
  assert.equal(
    decodeOwnProfileStats(
      owned({ followers: { status: 'known', value: Number.MAX_SAFE_INTEGER } }),
    ).followers.value,
    Number.MAX_SAFE_INTEGER,
  );
  assert.deepEqual(
    decodeOwnProfileStats(
      owned({
        following: unavailableProfileCount(),
        followers: unavailableProfileCount(),
      }),
    ).following,
    { status: 'unavailable', value: null },
  );
  for (const count of [
    { status: 'known', value: null },
    { status: 'known', value: '0' },
    { status: 'known', value: -1 },
    { status: 'known', value: 1.1 },
    { status: 'known', value: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'unavailable', value: 0 },
    { status: 'known', value: 0, hiddenCount: 2 },
  ])
    assert.throws(() =>
      decodeOwnProfileStats({ ...owned(), following: count }),
    );
  for (const patch of [
    { accountId: 'invalid' },
    { receivedInteractions: { status: 'known', value: 0 } },
    { anonymousLikes: 10 },
    { privateSavedCount: 10 },
  ])
    assert.throws(() => decodeOwnProfileStats({ ...owned(), ...patch }));
});

test('profile stats gateway reads only the authenticated own route with strict decoding', async () => {
  const s = setup();
  const transport = new ScriptedTransport();
  const api = new ApiClient('https://api.example.test', transport, s.sessions, {
    refresh: async () => s.sessions.snapshot(),
  });
  const gateway = new HttpProfileStatsGateway(api);
  transport.reply(owned());
  assert.deepEqual(await gateway.own(new Cancellation()), owned());
  assert.match(transport.requests[0]!.url, /\/v1\/me\/profile-stats$/);
  assert.equal(transport.requests[0]!.method, 'GET');
  assert.equal(transport.requests[0]!.body, undefined);
  assert.ok(transport.requests[0]!.headers.Authorization);
  transport.reply({
    ...owned(),
    receivedInteractions: { status: 'known', value: 1 },
  });
  await assert.rejects(gateway.own(new Cancellation()));
  s.sessions.logout();
  await assert.rejects(gateway.own(new Cancellation()));
  assert.equal(transport.requests.length, 2);
});

test('own stats accept verified zero, never derive counts, and clear on refresh failures or foreign-owner responses', async () => {
  const s = harness();
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.deepEqual(s.view().following, { status: 'known', value: 0 });
  assert.equal(s.view().receivedInteractions.value, null);
  assert.match(s.view().status, /当前可见关系/);
  s.gateway.own = async () => {
    throw new ClientError('network', 'Offline');
  };
  await s.controller.load();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().following.value, null);
  assert.equal(s.view().followers.value, null);
  s.gateway.own = async () => owned({ accountId: otherId });
  await s.controller.load();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().followers.value, null);
  assert.ok(s.view().error);
  s.controller.dispose();
});

test('stats reads revoke stale results after replacement reads, account changes, same-account login, hide or disposal', async () => {
  for (const event of [
    'replace',
    'account',
    'relogin',
    'hide',
    'dispose',
  ] as const) {
    const s = harness();
    const pending = deferred<OwnProfileStats>();
    s.gateway.own = async () => pending.promise;
    const read = s.controller.load();
    await flush();
    if (event === 'replace') {
      s.gateway.own = async () =>
        owned({ following: { status: 'known', value: 4 } });
      await s.controller.load();
    } else if (event === 'account' || event === 'relogin') {
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: event === 'account' ? otherId : s.accountId,
      });
    } else if (event === 'hide') {
      s.runtime.privateViews!.clear();
    } else s.controller.dispose();
    pending.resolve(owned({ following: { status: 'known', value: 99 } }));
    await read;
    assert.equal(
      s.view().following.value,
      event === 'replace' ? 4 : null,
      event,
    );
    s.controller.dispose();
  }
});

test('block/safety invalidation removes statistics synchronously before revalidation and never revives cancelled data', async () => {
  const s = harness();
  await s.controller.load();
  s.runtime.privateViews!.clear(otherId);
  assert.equal(s.view().following.value, 0);
  s.runtime.privateViews!.clear(s.accountId);
  assert.equal(s.view().following.value, null);
  await s.controller.load();
  const pending = deferred<OwnProfileStats>();
  s.gateway.own = async () => pending.promise;
  s.runtime.safetyChanges.invalidate(s.accountId);
  assert.equal(s.view().followers.value, null);
  await flush();
  s.controller.cancel();
  pending.resolve(owned());
  await flush();
  assert.equal(s.view().followers.value, null);
  assert.equal(s.view().busy, false);
  s.controller.dispose();
});

test('guest and unconfigured stats remain unavailable without requesting or inventing zeroes', async () => {
  const s = harness(false);
  let calls = 0;
  s.gateway.own = async () => {
    calls += 1;
    return owned();
  };
  await s.controller.load();
  assert.equal(calls, 0);
  assert.equal(s.view().following.value, null);
  s.controller.dispose();
  const loggedIn = setup();
  let view: ProfileStatsView;
  const controller = new ProfileStatsController(
    loggedIn.runtime,
    undefined,
    (value) => {
      view = value;
    },
  );
  await controller.load();
  assert.equal(view!.followers.value, null);
  assert.equal(view!.loaded, false);
  assert.ok(view!.error);
  controller.dispose();
});
