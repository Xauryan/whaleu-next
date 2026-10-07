import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import {
  decodeAuthorization,
  decodeIdentityBatch,
  HttpIdentityPrivacyGateway,
  IdentityOverlayController,
  PrivateViewLifecycle,
  type Authorization,
  type IdentityItem,
  type IdentityPrivacyGateway,
  type OverlayView,
} from '../src/identity-privacy/overlay';
import { Cancellation } from '../src/platform/contracts';
import { deferred, FakeClock, flush, ScriptedTransport } from './helpers';
import { otherId, postId, setup } from './community-helpers';
import { wireCredentials } from './identity-helpers';
const authorization = (
  role: Authorization['role'] = 'developer',
): Authorization => ({
  role,
  management: {
    global: role === 'developer' || role === 'super_admin',
    operatingRegionIds: [],
  },
  identityView: { allowed: role === 'developer', maxBatchSize: 20 },
});
const identity = (): IdentityItem => ({
  target: { kind: 'post', id: postId },
  status: 'available',
  authorMode: 'anonymous',
  identity: {
    accountId: otherId,
    nickname: '合成测试昵称',
    avatar: null,
    studentNumber: null,
    studentNumberStatus: 'unavailable',
  },
});
const targets = [
  { kind: 'post' as const, id: postId, authorMode: 'anonymous' as const },
];
function overlay() {
  const s = setup(),
    clock = new FakeClock(),
    views: OverlayView[] = [],
    lifecycle = new PrivateViewLifecycle();
  let role: Authorization['role'] = 'developer';
  const gateway: IdentityPrivacyGateway = {
    authorization: async () => authorization(role),
    identities: async () => [identity()],
  };
  const controller = new IdentityOverlayController(
    s.sessions,
    gateway,
    clock,
    (view) => views.push(view),
    lifecycle,
  );
  return {
    ...s,
    clock,
    views,
    lifecycle,
    gateway,
    controller,
    setRole: (next: Authorization['role']) => {
      role = next;
    },
    view: () => views[views.length - 1]!,
  };
}
test('privileged decoder keeps capability hierarchy and student-number authority strict', () => {
  assert.deepEqual(decodeAuthorization(authorization()), authorization());
  for (const role of ['member', 'school_admin', 'super_admin'] as const)
    assert.equal(
      decodeAuthorization(authorization(role)).identityView.allowed,
      false,
    );
  assert.throws(() =>
    decodeAuthorization({
      ...authorization('super_admin'),
      identityView: { allowed: true, maxBatchSize: 20 },
    }),
  );
  assert.throws(() =>
    decodeAuthorization({ ...authorization(), isDeveloper: true }),
  );
  const item = identity();
  assert.equal(decodeIdentityBatch({ items: [item] }).length, 1);
  if (item.status === 'available') {
    assert.throws(() =>
      decodeIdentityBatch({
        items: [
          {
            ...item,
            identity: { ...item.identity, studentNumber: 'invented' },
          },
        ],
      }),
    );
    assert.throws(() =>
      decodeIdentityBatch({
        items: [{ ...item, identity: { ...item.identity, verified: true } }],
      }),
    );
  }
});
test('only developer automatically sees separate transient overlay; revocation refresh clears before awaiting', async () => {
  const s = overlay();
  await s.controller.show(targets);
  assert.equal(s.view().items[postId]?.nickname, '合成测试昵称');
  assert.equal(s.storage.data.size, 0);
  s.setRole('super_admin');
  const pending = s.controller.show(targets);
  assert.deepEqual(s.view().items, {});
  await pending;
  assert.equal(s.view().developerEnabled, false);
  assert.deepEqual(s.view().items, {});
  s.setRole('developer');
  await s.controller.show(targets);
  s.gateway.identities = async () => {
    throw new Error('denied');
  };
  await s.controller.show(targets);
  assert.deepEqual(s.view().items, {});
  assert.equal(s.view().developerEnabled, false);
});
test('private identity clears on TTL, account switch, app hide, page disposal and stale completion', async () => {
  const s = overlay();
  await s.controller.show(targets);
  s.clock.advance(30000);
  assert.deepEqual(s.view().items, {});
  assert.equal(s.clock.timers, 0);
  await s.controller.show(targets);
  s.lifecycle.clear();
  assert.deepEqual(s.view().items, {});
  await s.controller.show(targets);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  assert.deepEqual(s.view().items, {});
  const late = deferred<readonly IdentityItem[]>();
  s.gateway.identities = () => late.promise;
  const pending = s.controller.show(targets);
  await flush();
  s.controller.dispose();
  late.resolve([identity()]);
  await pending;
  assert.deepEqual(s.view().items, {});
  assert.equal(s.clock.timers, 0);
});
test('a late privileged response for old targets or account cannot populate current view', async () => {
  const s = overlay(),
    late = deferred<readonly IdentityItem[]>();
  s.gateway.identities = () => late.promise;
  const pending = s.controller.show(targets);
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  late.resolve([identity()]);
  await pending;
  assert.equal(s.view().developerEnabled, false);
  assert.deepEqual(s.view().items, {});
});
test('overlay gateway sends only exact content targets, validates affinity and never replays audited POST', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  let refreshes = 0;
  const gateway = new HttpIdentityPrivacyGateway(
    new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => {
        refreshes++;
        return s.sessions.snapshot();
      },
    }),
  );
  transport.reply({ items: [identity()] });
  await gateway.identities([{ kind: 'post', id: postId }], new Cancellation());
  assert.deepEqual(transport.requests[0]!.body, {
    targets: [{ kind: 'post', id: postId }],
  });
  transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(
    gateway.identities([{ kind: 'post', id: postId }], new Cancellation()),
  );
  assert.equal(refreshes, 0);
  transport.reply({ items: [identity()] });
  await assert.rejects(
    gateway.identities([{ kind: 'comment', id: postId }], new Cancellation()),
  );
  assert.equal(s.storage.data.size, 0);
});
test('partial multi-batch failure is all-or-nothing and target replacement drops late privileged data', async () => {
  const s = overlay();
  let batches = 0;
  s.gateway.identities = async (incoming) => {
    batches++;
    if (batches === 2) throw new Error('grant revoked');
    return incoming.map((item) => ({
      target: item,
      status: 'available' as const,
      authorMode: 'anonymous' as const,
      identity: {
        accountId: otherId,
        nickname: null,
        avatar: null,
        studentNumber: null,
        studentNumberStatus: 'unavailable' as const,
      },
    }));
  };
  const many = Array.from({ length: 21 }, (_, i) => ({
    kind: 'post' as const,
    id: `${i.toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
    authorMode: 'anonymous' as const,
  }));
  await s.controller.show(many);
  assert.equal(batches, 2);
  assert.deepEqual(s.view().items, {});
  assert.equal(
    s.views.some((view) => Object.keys(view.items).length > 0),
    false,
  );
  const late = deferred<readonly IdentityItem[]>();
  s.gateway.identities = () => late.promise;
  const pending = s.controller.show(targets);
  await flush();
  await s.controller.show([]);
  late.resolve([identity()]);
  await pending;
  assert.deepEqual(s.view().items, {});
});
test('credential refresh preserves ownership while a new same-account login epoch clears the overlay', async () => {
  const s = overlay(),
    late = deferred<readonly IdentityItem[]>();
  s.gateway.identities = () => late.promise;
  const pending = s.controller.show(targets);
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  late.resolve([identity()]);
  await pending;
  assert.equal(s.view().developerEnabled, true);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('c'));
  assert.equal(s.view().developerEnabled, false);
  assert.deepEqual(s.view().items, {});
});
test('one native render failure cannot prevent other private views clearing on app hide', () => {
  const lifecycle = new PrivateViewLifecycle();
  let cleared = false;
  lifecycle.subscribe(() => {
    throw new Error('synthetic render failure');
  });
  lifecycle.subscribe(() => {
    cleared = true;
  });
  assert.doesNotThrow(() => lifecycle.clear());
  assert.equal(cleared, true);
});
test('formation_member overlay uses only membership targets and existing audited endpoint with strict author-mode affinity', async () => {
  const s = setup(),
    transport = new ScriptedTransport();
  const gateway = new HttpIdentityPrivacyGateway(
    new ApiClient('https://api.example', transport, s.sessions, {
      refresh: async () => {
        throw new Error('audited request cannot replay');
      },
    }),
  );
  const item = {
    ...identity(),
    target: { kind: 'formation_member' as const, id: otherId },
  };
  transport.reply({ items: [item] });
  await gateway.identities(
    [{ kind: 'formation_member', id: otherId }],
    new Cancellation(),
  );
  assert.deepEqual(transport.requests[0]!.body, {
    targets: [{ kind: 'formation_member', id: otherId }],
  });
  assert.throws(() =>
    decodeIdentityBatch({
      items: [
        {
          ...item,
          target: { kind: 'formation_member', id: otherId, accountId: otherId },
        },
      ],
    }),
  );
  const o = overlay();
  o.gateway.identities = async () => [item];
  await o.controller.show([
    { kind: 'formation_member', id: otherId, authorMode: 'anonymous' },
  ]);
  assert.equal(o.view().developerEnabled, true);
  assert.equal(o.storage.data.size, 0);
  await o.controller.show([
    { kind: 'formation_member', id: otherId, authorMode: 'named' },
  ]);
  assert.deepEqual(o.view().items, {});
});
test('formation roster and parent target batching stays bounded and invisible failed batches cannot partially disclose', async () => {
  const s = overlay(),
    sizes: number[] = [];
  s.gateway.identities = async (batch) => {
    sizes.push(batch.length);
    return batch.map((target) => ({ ...identity(), target }));
  };
  const members = Array.from({ length: 20 }, (_, i) => ({
    kind: 'formation_member' as const,
    id: `${i.toString().padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    authorMode: 'anonymous' as const,
  }));
  await s.controller.show([...targets, ...members]);
  assert.deepEqual(sizes, [20, 1]);
  assert.equal(Object.keys(s.view().items).length, 21);
  s.lifecycle.clear();
  assert.deepEqual(s.view().items, {});
});
test('late developer identity data after token expiry cannot render and unrelated refresh cannot extend older batch lease', async () => {
  for (const refresh of [false, true]) {
    const s = overlay();
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials(),
      expiresAt: 2000,
      refreshExpiresAt: 100000,
    });
    const late = deferred<readonly IdentityItem[]>();
    s.gateway.identities = () => late.promise;
    const pending = s.controller.show(targets);
    await flush();
    s.clock.advance(2000);
    if (refresh)
      s.sessions.rotate(s.sessions.snapshot(), {
        ...wireCredentials('b'),
        expiresAt: 90000,
        refreshExpiresAt: 100000,
      });
    late.resolve([identity()]);
    await pending;
    assert.deepEqual(s.view().items, {});
    assert.equal(s.view().developerEnabled, false);
  }
  const s = overlay();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials(),
    expiresAt: 2000,
    refreshExpiresAt: 100000,
  });
  await s.controller.show(targets);
  assert.equal(s.view().developerEnabled, true);
  s.clock.advance(1000);
  assert.deepEqual(s.view().items, {});
});
