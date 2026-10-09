import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingSubscriptionsGateway } from '../src/ratings/subscription-gateway';
import { HttpRatingSubscriptionUpdatesGateway } from '../src/ratings/subscription-updates-gateway';
import type {
  RatingSubscriptionIntent,
  RatingSubscriptionTarget,
} from '../src/ratings/subscription-contract';
import {
  PendingRatingStore,
  ratingIntentTarget,
  type PendingRating,
} from '../src/ratings/pending';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  cursor,
  intent,
  otherId,
  receipt,
  regionId,
  requestId,
  revision,
  targetId,
} from './ratings-helpers';
import {
  noticeId,
  readReceipt,
  replyIntent,
  replyReceipt,
} from './ratings-r2a-helpers';
import { likeIntent, likeReceipt } from './ratings-r2b-helpers';
import {
  subscriptionBatch,
  subscriptionIntent,
  subscriptionNoticeTarget,
  subscriptionReceipt,
  subscriptionState,
  subscriptionUpdates,
} from './ratings-r2c-helpers';
const accountId = wireCredentials().accountId;
const targets = [{ targetId, expectedTargetRevision: revision }];
function setup(loggedIn = true) {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const api = new ApiClient('https://ratings.example', transport, sessions, {
    refresh: async () =>
      sessions.rotate(sessions.snapshot(), wireCredentials('b')),
  });
  return {
    sessions,
    transport,
    subscriptions: new HttpRatingSubscriptionsGateway(api),
    updates: new HttpRatingSubscriptionUpdatesGateway(api),
  };
}

test('R2C exact authenticated routes keep target-only PUT body and read-only single-scope batch separate', async () => {
  const s = setup(),
    c = new Cancellation();
  s.transport.reply(subscriptionState());
  await s.subscriptions.state(null, targetId, c);
  s.transport.reply(subscriptionState());
  await s.subscriptions.state(regionId, targetId, c);
  s.transport.reply(subscriptionBatch());
  await s.subscriptions.states(regionId, targets, c);
  s.transport.reply(subscriptionReceipt());
  await s.subscriptions.command(subscriptionIntent(), c);
  s.transport.reply(subscriptionReceipt());
  await s.subscriptions.receipt(requestId, c);
  s.transport.reply(subscriptionUpdates());
  await s.updates.list(null, c);
  s.transport.reply({ unreadCount: 1 });
  await s.updates.unread(c);
  s.transport.reply(subscriptionNoticeTarget());
  await s.updates.target(noticeId, c);
  s.transport.reply(readReceipt());
  await s.updates.markRead(noticeId, c);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `/v1/ratings/targets/${targetId}/subscription`],
      ['GET', `/v1/ratings/targets/${targetId}/subscription`],
      ['POST', '/v1/ratings/subscription-states/query'],
      ['PUT', `/v1/ratings/targets/${targetId}/subscription`],
      ['GET', `/v1/ratings/subscription-requests/${requestId}`],
      ['GET', '/v1/me/ratings/subscription-updates'],
      ['GET', '/v1/me/ratings/subscription-updates/unread-count'],
      ['GET', `/v1/me/ratings/subscription-updates/${noticeId}/target`],
      ['PUT', `/v1/me/ratings/subscription-updates/${noticeId}/read`],
    ],
  );
  assert.equal(new URL(s.transport.requests[0]!.url).search, '');
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[1]!.url).searchParams),
    { regionId },
  );
  assert.deepEqual(s.transport.requests[2]!.body, { regionId, targets });
  assert.deepEqual(s.transport.requests[3]!.body, subscriptionIntent().payload);
  assert.deepEqual(s.transport.requests[8]!.body, {});
  for (const request of s.transport.requests)
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('R2C no-auth, malformed and empty/oversized/duplicate/mixed-scope batch inputs dispatch nothing', async () => {
  const s = setup(false),
    c = new Cancellation();
  for (const run of [
    () => s.subscriptions.state(null, targetId, c),
    () => s.subscriptions.states(null, targets, c),
    () => s.subscriptions.command(subscriptionIntent(), c),
    () => s.subscriptions.receipt(requestId, c),
    () => s.updates.list(null, c),
    () => s.updates.unread(c),
    () => s.updates.target(noticeId, c),
    () => s.updates.markRead(noticeId, c),
  ])
    await assert.rejects(run, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
  const v = setup();
  for (const bad of [
    [],
    [...targets, ...targets],
    Array.from({ length: 21 }, (_, n) => ({
      targetId: `${String(n).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`,
      expectedTargetRevision: revision,
    })),
    [{ targetId, expectedTargetRevision: null }],
    [{ ...targets[0], regionId }],
    [
      {
        targetId: `${targetId}?actor=${otherId}`,
        expectedTargetRevision: revision,
      },
    ],
  ])
    await assert.rejects(async () =>
      v.subscriptions.states(null, bad as RatingSubscriptionTarget[], c),
    );
  for (const run of [
    () => v.subscriptions.state('bad', targetId, c),
    () => v.subscriptions.state(null, 'bad', c),
    () => v.subscriptions.receipt('bad', c),
    () => v.updates.list('bad', c),
    () => v.updates.list(null, c, 21),
    () => v.updates.target('bad', c),
    () => v.updates.markRead('bad', c),
    () =>
      v.subscriptions.command(
        {
          ...subscriptionIntent(),
          payload: { ...subscriptionIntent().payload, targetId },
        } as unknown as RatingSubscriptionIntent,
        c,
      ),
  ])
    await assert.rejects(async () => run());
  assert.equal(v.transport.requests.length, 0);
});
test('R2C successful HTTP cannot cross target, reorder/omit/add batch IDs or mismatch the original desired receipt', async () => {
  const s = setup(),
    c = new Cancellation(),
    two = [...targets, { targetId: otherId, expectedTargetRevision: revision }];
  s.transport.reply(subscriptionState({ targetId: otherId }));
  await assert.rejects(s.subscriptions.state(null, targetId, c), {
    kind: 'protocol',
  });
  for (const raw of [
    subscriptionBatch([otherId, targetId]),
    subscriptionBatch([targetId]),
    subscriptionBatch([targetId, otherId, requestId]),
    {
      items: [
        { targetId, state: subscriptionState({ targetId: otherId }) },
        { targetId: otherId, state: { status: 'unavailable' } },
      ],
    },
  ]) {
    s.transport.reply(raw);
    await assert.rejects(s.subscriptions.states(null, two, c), {
      kind: 'protocol',
    });
  }
  for (const patch of [
    { requestId: otherId },
    { targetId: otherId },
    { subscribed: false },
  ]) {
    s.transport.reply({ ...subscriptionReceipt(), ...patch });
    await assert.rejects(s.subscriptions.command(subscriptionIntent(), c), {
      kind: 'protocol',
    });
  }
  for (const raw of [
    subscriptionReceipt(subscriptionIntent(), { requestId: otherId }),
    receipt(),
    replyReceipt(),
    likeReceipt(),
  ]) {
    s.transport.reply(raw);
    await assert.rejects(s.subscriptions.receipt(requestId, c), {
      kind: 'protocol',
    });
  }
  s.transport.reply(subscriptionNoticeTarget({ noticeId: otherId }));
  await assert.rejects(s.updates.target(noticeId, c), { kind: 'protocol' });
  s.transport.reply(readReceipt({ noticeId: otherId }));
  await assert.rejects(s.updates.markRead(noticeId, c), { kind: 'protocol' });
  s.transport.reply(subscriptionUpdates({ nextCursor: cursor }));
  await assert.rejects(s.updates.list(cursor, c), { kind: 'protocol' });
});
test('R2C authentication replay freezes desired command and batch bodies before caller mutation', async () => {
  const s = setup(),
    c = new Cancellation(),
    command = subscriptionIntent(),
    mutable = structuredClone(command);
  s.transport.steps.push(async () => {
    Object.assign(mutable, { targetId: otherId });
    Object.assign(mutable.payload, {
      subscribed: false,
      clientRequestId: otherId,
      expectedSubscriptionRevision: otherId,
    });
    return {
      status: 401,
      headers: {},
      body: { error: { code: 'ACCESS_TOKEN_EXPIRED' } },
    };
  });
  s.transport.reply(subscriptionReceipt(command));
  await s.subscriptions.command(mutable, c);
  assert.deepEqual(s.transport.requests[0]!.body, command.payload);
  assert.deepEqual(s.transport.requests[1]!.body, command.payload);
  assert.equal(s.transport.requests[0]!.url, s.transport.requests[1]!.url);
  const batch = structuredClone(targets),
    v = setup();
  v.transport.steps.push(async () => {
    batch[0]!.targetId = otherId;
    batch.push({ targetId: requestId, expectedTargetRevision: otherId });
    return {
      status: 401,
      headers: {},
      body: { error: { code: 'ACCESS_TOKEN_EXPIRED' } },
    };
  });
  v.transport.reply(subscriptionBatch());
  await v.subscriptions.states(regionId, batch, c);
  assert.deepEqual(v.transport.requests[0]!.body, { regionId, targets });
  assert.deepEqual(v.transport.requests[1]!.body, { regionId, targets });
});
for (const account of [accountId, otherId])
  for (const operation of [
    'state',
    'states',
    'command',
    'receipt',
    'list',
    'read',
  ] as const)
    test(`R2C late ${operation} cannot publish after ${account === accountId ? 'owner epoch' : 'account'} switch`, async () => {
      const s = setup(),
        c = new Cancellation();
      s.transport.steps.push(async () => {
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials(),
          accountId: account,
        });
        return {
          status: 200,
          headers: {},
          body:
            operation === 'state'
              ? subscriptionState()
              : operation === 'states'
                ? subscriptionBatch()
                : operation === 'list'
                  ? subscriptionUpdates()
                  : operation === 'read'
                    ? readReceipt()
                    : subscriptionReceipt(),
        };
      });
      await assert.rejects(
        operation === 'state'
          ? s.subscriptions.state(null, targetId, c)
          : operation === 'states'
            ? s.subscriptions.states(null, targets, c)
            : operation === 'command'
              ? s.subscriptions.command(subscriptionIntent(), c)
              : operation === 'receipt'
                ? s.subscriptions.receipt(requestId, c)
                : operation === 'list'
                  ? s.updates.list(null, c)
                  : s.updates.markRead(noticeId, c),
        { kind: 'stale-session' },
      );
    });
test('R2C pre-dispatch cancellation sends no subscription mutation or batch', async () => {
  const s = setup(),
    c = new Cancellation();
  c.cancel();
  await assert.rejects(s.subscriptions.command(subscriptionIntent(), c), {
    kind: 'cancelled',
  });
  await assert.rejects(s.subscriptions.states(null, targets, c), {
    kind: 'cancelled',
  });
  assert.equal(s.transport.requests.length, 0);
});

test('R2C v3 slot accepts only subscription; legacy bytes and recovery order v1 → v2 → v3 are immutable', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const legacy: PendingRating = { version: 1, accountId, intent: intent() },
    reply: PendingRating = { version: 2, accountId, intent: replyIntent() },
    fresh: PendingRating = {
      version: 3,
      accountId,
      intent: subscriptionIntent(),
    };
  const key = (version: number) =>
    `whaleu.ratings.pending.v${version}:origin:${accountId}`;
  storage.set(key(1), legacy);
  storage.set(key(2), reply);
  storage.set(key(3), fresh);
  const bytes = JSON.stringify([...storage.data]);
  assert.deepEqual(store.load(accountId), legacy);
  assert.throws(() => store.freeze(fresh), { kind: 'storage' });
  assert.throws(() => store.settle(fresh, subscriptionReceipt()), {
    kind: 'storage',
  });
  assert.equal(JSON.stringify([...storage.data]), bytes);
  store.settle(legacy, receipt());
  assert.deepEqual(store.load(accountId), reply);
  assert.throws(() => store.settle(fresh, subscriptionReceipt()), {
    kind: 'storage',
  });
  store.settle(reply, replyReceipt());
  assert.deepEqual(store.load(accountId), fresh);
  assert.equal(ratingIntentTarget(fresh.intent), targetId);
  store.settle(fresh, subscriptionReceipt());
  assert.equal(storage.data.size, 0);
  for (const version of [1, 2]) {
    storage.set(key(version), { ...fresh, version });
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    storage.data.clear();
  }
  for (const old of [intent(), replyIntent(), likeIntent()]) {
    storage.set(key(3), { ...fresh, intent: old });
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    storage.data.clear();
  }
});
test('R2C all account/origin journals gate new work, mismatched receipt and storage failures retain exact v3 command', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin'),
    fresh: PendingRating = {
      version: 3,
      accountId,
      intent: subscriptionIntent(),
    };
  const pending = store.freeze(fresh),
    key = `whaleu.ratings.pending.v3:origin:${accountId}`;
  assert.deepEqual(storage.get(key), pending);
  assert.equal(store.load(otherId), null);
  assert.equal(new PendingRatingStore(storage, 'other').load(accountId), null);
  assert.throws(
    () => store.freeze({ version: 2, accountId, intent: likeIntent() }),
    { kind: 'storage' },
  );
  for (const raw of [
    receipt(),
    replyReceipt(),
    likeReceipt(),
    subscriptionReceipt(subscriptionIntent(), { targetId: otherId }),
    subscriptionReceipt(subscriptionIntent(), { subscribed: false }),
  ]) {
    assert.throws(() => store.settle(pending, raw));
    assert.deepEqual(store.load(accountId), pending);
  }
  storage.failRemove = true;
  assert.throws(() => store.settle(pending, subscriptionReceipt()), {
    kind: 'storage',
  });
  assert.deepEqual(store.load(accountId), pending);
  storage.failRemove = false;
  store.settle(pending, subscriptionReceipt());
  for (const version of [1, 2, 3]) {
    const k = `whaleu.ratings.pending.v${version}:origin:${accountId}`;
    storage.set(k, { broken: true });
    assert.throws(() => store.freeze(fresh), { kind: 'storage' });
    assert.deepEqual(storage.get(k), { broken: true });
    storage.data.clear();
  }
  storage.failWrite = true;
  assert.throws(() => store.freeze(fresh), { kind: 'storage' });
  assert.equal(storage.data.size, 0);
  const silent = new PendingRatingStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'origin',
  );
  assert.throws(() => silent.freeze(fresh), { kind: 'storage' });
});
