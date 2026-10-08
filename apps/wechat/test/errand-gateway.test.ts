import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import {
  type ErrandDetail,
  type ErrandIntent,
  type ErrandListQuery,
  type ErrandReceipt,
  type ErrandSummary,
  type PublishErrand,
} from '../src/errands/contract';
import { HttpErrandsGateway } from '../src/errands/gateway';
import { PendingErrandStore, type PendingErrand } from '../src/errands/pending';
import { Cancellation, type Storage } from '../src/platform/contracts';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';

const orderId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const revision = '33333333-3333-4333-8333-333333333333';
const regionId = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const timestamp = '2026-10-08T12:00:00.000Z';
const accountId = wireCredentials().accountId;
const cursor = 'a'.repeat(43);
const contacts = () => ({ wechat: 'synthetic-contact', phone: '12345678901' });
const publish = (patch: Partial<PublishErrand> = {}): PublishErrand => ({
  clientRequestId: requestId,
  targetRegionId: regionId,
  title: 'Synthetic errand',
  publicText: 'Public instructions',
  privateText: 'Participant instructions',
  expectedTimeText: 'Tomorrow',
  reward: '12.3456789',
  publisherContacts: contacts(),
  publicAssetIds: [],
  privateAssetIds: [],
  ...patch,
});
const command = (
  operation: 'accept' | 'cancel' | 'complete' | 'delete' = 'accept',
): ErrandIntent =>
  operation === 'accept'
    ? {
        operation,
        orderId,
        payload: {
          clientRequestId: requestId,
          expectedRevision: revision,
          contacts: contacts(),
        },
      }
    : {
        operation,
        orderId,
        payload: { clientRequestId: requestId, expectedRevision: revision },
      };
const summary = (patch: Partial<ErrandSummary> = {}): ErrandSummary => ({
  id: orderId,
  revision,
  title: 'Synthetic errand',
  publicText: 'Public instructions',
  expectedTimeText: 'Tomorrow',
  reward: '12.3456789',
  state: 'pending',
  createdAt: timestamp,
  acceptedAt: null,
  completedAt: null,
  cancelledAt: null,
  targetRegion: { id: regionId, label: 'Synthetic target' },
  sourceRegion: { id: otherId, label: 'Synthetic source' },
  scope: 'home',
  ...patch,
});
const detail = (patch: Partial<ErrandDetail> = {}): ErrandDetail => ({
  ...summary(),
  relation: 'none',
  capabilities: { accept: true, cancel: false, complete: false, delete: false },
  ...patch,
});
const page = (items = [summary()]) => ({
  context: { kind: 'discovery', regionId, discoveryMode: 'home' },
  items,
  continuation: 'end',
  nextCursor: null,
});
const ownPage = (relation = 'published', items = [summary()]) => ({
  ...page(items),
  context: { kind: 'own', relation },
});
const query = (patch: Partial<ErrandListQuery> = {}): ErrandListQuery => ({
  regionId,
  filter: 'all',
  sort: 'created',
  direction: 'desc',
  ...patch,
});
const receipt = (
  patch: Partial<Extract<ErrandReceipt, { outcome: 'applied' }>> = {},
): ErrandReceipt => ({
  requestId,
  operation: 'accept',
  outcome: 'applied',
  orderId,
  revision,
  occurredAt: timestamp,
  ...patch,
});
const attempt = (intent: ErrandIntent = command()): PendingErrand => ({
  version: 1,
  accountId,
  intent,
});
function setup(loggedIn = true) {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let refreshes = 0;
  const gateway = new HttpErrandsGateway(
    new ApiClient('https://api.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}

test('errands use authenticated region, discovery, own, detail and contact-history reads with encoded bounded queries', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({
    items: [{ id: regionId, name: 'Synthetic target', isActive: true }],
  });
  await s.gateway.regions(otherId, cancel);
  s.transport.reply(page());
  await s.gateway.list(
    query({ filter: 'pending', sort: 'reward', direction: 'asc' }),
    cursor,
    cancel,
    10,
  );
  s.transport.reply(ownPage('accepted'));
  await s.gateway.mine('accepted', cursor, cancel, 50);
  s.transport.reply(detail());
  await s.gateway.detail(orderId, cancel);
  s.transport.reply({ status: 'available', contacts: contacts() });
  await s.gateway.contactHistory(cancel);
  assert.deepEqual(
    s.transport.requests.map((request) => [
      request.method,
      new URL(request.url).pathname,
    ]),
    [
      ['GET', '/v1/operating-regions'],
      ['GET', '/v1/errands'],
      ['GET', '/v1/me/errands'],
      ['GET', `/v1/errands/${orderId}`],
      ['GET', '/v1/me/errands/contact-history'],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[0]!.url).searchParams),
    { campusId: otherId },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[1]!.url).searchParams),
    {
      regionId,
      filter: 'pending',
      sort: 'reward',
      direction: 'asc',
      limit: '10',
      cursor,
    },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[2]!.url).searchParams),
    { relation: 'accepted', limit: '50', cursor },
  );
  for (const request of s.transport.requests) {
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
    assert.equal(request.body, undefined);
  }
});

test('all five commands send only the frozen payload and recovery uses the owner-only request route', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const intents: ErrandIntent[] = [
    { operation: 'publish', payload: publish() },
    ...(['accept', 'cancel', 'complete', 'delete'] as const).map(command),
  ];
  for (const intent of intents) {
    s.transport.reply(receipt({ operation: intent.operation }));
    await s.gateway.command(intent, cancel);
  }
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map((request) => [
      request.method,
      new URL(request.url).pathname,
    ]),
    [
      ['POST', '/v1/errands'],
      ['POST', `/v1/errands/${orderId}/accept`],
      ['POST', `/v1/errands/${orderId}/cancel`],
      ['POST', `/v1/errands/${orderId}/complete`],
      ['POST', `/v1/errands/${orderId}/delete`],
      ['GET', `/v1/me/errand-requests/${requestId}`],
    ],
  );
  for (let i = 0; i < intents.length; i++)
    assert.deepEqual(s.transport.requests[i]!.body, intents[i]!.payload);
  for (const request of s.transport.requests)
    assert.ok(request.headers.Authorization);
  assert.equal(s.transport.requests[5]!.body, undefined);
});

test('every errand endpoint requires authentication before dispatch, including private contacts and receipt lookup', async () => {
  const s = setup(false),
    cancel = new Cancellation();
  for (const read of [
    () => s.gateway.regions(otherId, cancel),
    () => s.gateway.list(query(), null, cancel),
    () => s.gateway.mine('published', null, cancel),
    () => s.gateway.detail(orderId, cancel),
    () => s.gateway.contactHistory(cancel),
    () => s.gateway.receipt(requestId, cancel),
    () => s.gateway.command(command(), cancel),
    () =>
      s.gateway.command({ operation: 'publish', payload: publish() }, cancel),
  ])
    await assert.rejects(read, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
});

test('query/path injection, invalid pagination and unsupported media fail before network dispatch', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const value of ['not-an-id', orderId + '?owner=true']) {
    await assert.rejects(async () => s.gateway.regions(value, cancel));
    await assert.rejects(s.gateway.detail(value, cancel));
    await assert.rejects(s.gateway.receipt(value, cancel));
  }
  for (const patch of [
    { regionId: 'bad' },
    { filter: 'pending&limit=50' },
    { sort: 'price' },
    { direction: 'ASC' },
    { accountId: otherId },
  ])
    await assert.rejects(
      s.gateway.list({ ...query(), ...patch } as ErrandListQuery, null, cancel),
    );
  for (const limit of [0, 51, 1.5, NaN, Infinity]) {
    await assert.rejects(s.gateway.list(query(), null, cancel, limit));
    await assert.rejects(s.gateway.mine('published', null, cancel, limit));
  }
  for (const value of ['', 'a'.repeat(42), cursor + '&owner=true']) {
    await assert.rejects(s.gateway.list(query(), value, cancel));
    await assert.rejects(s.gateway.mine('accepted', value, cancel));
  }
  await assert.rejects(
    s.gateway.mine('publisher' as 'published', null, cancel),
  );
  await assert.rejects(
    s.gateway.command({ ...command(), orderId: 'bad' } as ErrandIntent, cancel),
  );
  await assert.rejects(
    s.gateway.command(
      { operation: 'publish', payload: publish({ publicAssetIds: [otherId] }) },
      cancel,
    ),
    { kind: 'configuration' },
  );
  assert.equal(s.transport.requests.length, 0);
});

test('discovery and own pages bind their query context, requested limits, active states and forward cursor', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const body of [
    {
      ...page(),
      context: { kind: 'discovery', regionId: otherId, discoveryMode: 'home' },
    },
    ownPage(),
    page([summary({ targetRegion: { id: otherId, label: 'Wrong target' } })]),
    page([
      summary({
        state: 'completed',
        acceptedAt: timestamp,
        completedAt: timestamp,
      }),
    ]),
    page([summary({ state: 'cancelled', cancelledAt: timestamp })]),
    { ...page(), continuation: 'more', nextCursor: cursor },
    page([summary(), summary({ id: otherId })]),
  ]) {
    s.transport.reply(body);
    await assert.rejects(s.gateway.list(query(), cursor, cancel, 1), {
      kind: 'protocol',
    });
  }
  s.transport.reply(
    page([summary({ state: 'accepted', acceptedAt: timestamp })]),
  );
  await assert.rejects(
    s.gateway.list(query({ filter: 'pending' }), null, cancel),
    { kind: 'protocol' },
  );
  for (const body of [
    page(),
    ownPage('accepted'),
    { ...ownPage(), continuation: 'more', nextCursor: cursor },
  ]) {
    s.transport.reply(body);
    await assert.rejects(s.gateway.mine('published', cursor, cancel), {
      kind: 'protocol',
    });
  }
  s.transport.reply({
    ...page(),
    context: { kind: 'discovery', regionId, discoveryMode: 'own_only' },
  });
  assert.equal(
    (await s.gateway.list(query(), null, cancel)).context.kind,
    'discovery',
  );
});

test('detail and terminal success bind the exact request, operation and order without accepting mutable snapshots', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const body of [
    detail({ id: otherId }),
    { ...detail(), privateText: 'leak' },
  ]) {
    s.transport.reply(body);
    await assert.rejects(s.gateway.detail(orderId, cancel), {
      kind: 'protocol',
    });
  }
  for (const body of [
    receipt({ requestId: otherId }),
    receipt({ operation: 'cancel' }),
    receipt({ orderId: otherId }),
    { ...receipt(), order: summary() },
    { ...receipt(), contacts: contacts() },
  ]) {
    s.transport.reply(body);
    await assert.rejects(s.gateway.command(command(), cancel), {
      kind: 'protocol',
    });
  }
  s.transport.reply(receipt({ requestId: otherId }));
  await assert.rejects(s.gateway.receipt(requestId, cancel), {
    kind: 'protocol',
  });
  const rejection = {
    requestId,
    operation: 'accept',
    outcome: 'rejected',
    code: 'ERRAND_REVISION_CONFLICT',
  };
  s.transport.reply(rejection);
  assert.deepEqual(await s.gateway.command(command(), cancel), rejection);
  s.transport.reply(rejection);
  assert.deepEqual(await s.gateway.receipt(requestId, cancel), rejection);
});

test('read and write success statuses are exact and a missing recovery receipt is never a terminal outcome', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const status of [201, 202, 204]) {
    s.transport.reply(detail(), status);
    await assert.rejects(s.gateway.detail(orderId, cancel), {
      kind: 'protocol',
    });
    s.transport.reply(receipt(), status);
    await assert.rejects(s.gateway.command(command(), cancel), {
      kind: 'protocol',
    });
    s.transport.reply(receipt(), status);
    await assert.rejects(s.gateway.receipt(requestId, cancel), {
      kind: 'protocol',
    });
  }
  s.transport.reply({ error: { code: 'REQUEST_NOT_FOUND' } }, 404);
  await assert.rejects(s.gateway.receipt(requestId, cancel));
});

test('expired authorization replays the same request key and canonical payload despite caller mutation', async () => {
  for (const operation of ['publish', 'accept'] as const) {
    const s = setup();
    const raw =
      operation === 'publish'
        ? {
            operation,
            payload: {
              ...publish({ reward: '12.345678900' }),
              publisherContacts: contacts(),
            },
          }
        : {
            operation,
            orderId,
            payload: {
              clientRequestId: requestId,
              expectedRevision: revision,
              contacts: contacts(),
            },
          };
    s.transport.steps.push(async () => {
      raw.payload.clientRequestId = otherId;
      if ('publisherContacts' in raw.payload) {
        raw.payload.publisherContacts.wechat = 'mutated';
        raw.payload.reward = '500';
      } else {
        raw.payload.contacts.wechat = 'mutated';
        raw.payload.expectedRevision = otherId;
      }
      return {
        status: 401,
        headers: {},
        body: { error: { code: 'ACCESS_TOKEN_EXPIRED' } },
      };
    });
    s.transport.reply(receipt({ operation }));
    await s.gateway.command(raw, new Cancellation());
    assert.equal(s.refreshes(), 1);
    assert.equal(s.transport.requests.length, 2);
    assert.deepEqual(
      s.transport.requests[0]!.body,
      s.transport.requests[1]!.body,
    );
    assert.equal(
      (s.transport.requests[1]!.body as { clientRequestId: string })
        .clientRequestId,
      requestId,
    );
    assert.equal(
      JSON.stringify(s.transport.requests[1]!.body).includes('mutated'),
      false,
    );
    assert.equal(
      s.transport.requests[1]!.headers.Authorization,
      `Bearer ${wireCredentials('b').accessToken}`,
    );
    if (operation === 'publish')
      assert.equal(
        (s.transport.requests[1]!.body as { reward: string }).reward,
        '12.3456789',
      );
  }
});

test('auth replay is bounded and unknown timeout/cancellation outcomes never replay a command', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  await assert.rejects(s.gateway.command(command(), cancel));
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests.length, 2);
  s.transport.steps.push(async () => {
    throw new ClientError('timeout', 'Synthetic timeout');
  });
  await assert.rejects(s.gateway.command(command(), cancel), {
    kind: 'timeout',
  });
  assert.equal(s.transport.requests.length, 3);
  const cancelled = new Cancellation();
  cancelled.cancel();
  await assert.rejects(s.gateway.command(command(), cancelled), {
    kind: 'cancelled',
  });
  await assert.rejects(s.gateway.contactHistory(cancelled), {
    kind: 'cancelled',
  });
  assert.equal(s.transport.requests.length, 3);
});

test('late private, command and recovery results cannot cross an account or login epoch', async () => {
  for (const kind of ['detail', 'contacts', 'command', 'receipt']) {
    const s = setup(),
      cancel = new Cancellation();
    s.transport.steps.push(async () => {
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('c'),
        accountId: otherId,
      });
      return {
        status: 200,
        headers: {},
        body:
          kind === 'detail'
            ? detail()
            : kind === 'contacts'
              ? { status: 'available', contacts: contacts() }
              : receipt(),
      };
    });
    await assert.rejects(
      kind === 'detail'
        ? s.gateway.detail(orderId, cancel)
        : kind === 'contacts'
          ? s.gateway.contactHistory(cancel)
          : kind === 'command'
            ? s.gateway.command(command(), cancel)
            : s.gateway.receipt(requestId, cancel),
      { kind: 'stale-session' },
    );
  }
});

test('pending errands use one immutable unresolved command per account and origin', () => {
  const storage = new MemoryStorage(),
    store = new PendingErrandStore(storage, 'https://api.example');
  const frozen = store.freeze(attempt());
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.intent));
  assert.ok(Object.isFrozen(frozen.intent.payload));
  assert.deepEqual(store.freeze(attempt()), frozen);
  assert.equal(storage.data.size, 1);
  assert.equal(store.load(otherId), null);
  assert.equal(
    new PendingErrandStore(storage, 'https://other.example').load(accountId),
    null,
  );
  assert.doesNotThrow(() => store.assertOriginal(frozen));
  for (const intent of [
    command('cancel'),
    { ...command(), orderId: otherId } as ErrandIntent,
    { operation: 'publish', payload: publish() } as ErrandIntent,
  ])
    assert.throws(() => store.freeze(attempt(intent)), { kind: 'storage' });
  assert.throws(
    () =>
      store.freeze(
        attempt({
          operation: 'accept',
          orderId,
          payload: {
            clientRequestId: otherId,
            expectedRevision: revision,
            contacts: contacts(),
          },
        }),
      ),
    { kind: 'storage' },
  );
  assert.throws(
    () =>
      store.freeze(
        attempt({
          operation: 'accept',
          orderId,
          payload: {
            clientRequestId: requestId,
            expectedRevision: revision,
            contacts: { ...contacts(), wechat: 'changed' },
          },
        }),
      ),
    { kind: 'storage' },
  );
  new PendingErrandStore(storage, 'https://other.example').freeze(
    attempt(command('cancel')),
  );
  store.freeze({ ...attempt(command('delete')), accountId: otherId });
  assert.equal(storage.data.size, 3);
  store.settle(frozen, receipt());
  assert.equal(store.load(accountId), null);
  assert.ok(store.load(otherId));
  assert.ok(
    new PendingErrandStore(storage, 'https://other.example').load(accountId),
  );
});

test('journal writes require verified readback and corruption never gets overwritten or silently released', () => {
  const storage = new MemoryStorage(),
    store = new PendingErrandStore(storage, 'origin');
  storage.failWrite = true;
  assert.throws(() => store.freeze(attempt()), { kind: 'storage' });
  storage.failWrite = false;
  const frozen = store.freeze(attempt()),
    key = [...storage.data.keys()][0]!;
  for (const corrupted of [
    { ...frozen, accountId: otherId },
    { ...frozen, version: 2 },
    { ...frozen, ownerAccountId: otherId },
    { ...frozen, intent: { ...command(), orderId: 'bad' } },
  ]) {
    storage.data.set(key, corrupted);
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(attempt()), { kind: 'storage' });
    assert.equal(storage.data.get(key), corrupted);
  }
  for (const broken of [
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    {
      get: () => {
        throw new Error('Synthetic read failure');
      },
      set: () => undefined,
      remove: () => undefined,
    },
    {
      get: () => undefined,
      set: () => {
        throw new Error('Synthetic write failure');
      },
      remove: () => undefined,
    },
  ] satisfies Storage[])
    assert.throws(
      () => new PendingErrandStore(broken, 'origin').freeze(attempt()),
      { kind: 'storage' },
    );
  const altered = new MemoryStorage();
  const wrongReadback: Storage = {
    get: (name) => altered.get(name),
    set: (name, value) =>
      altered.set(name, {
        ...(value as PendingErrand),
        intent: command('cancel'),
      }),
    remove: (name) => altered.remove(name),
  };
  assert.throws(
    () => new PendingErrandStore(wrongReadback, 'origin').freeze(attempt()),
    { kind: 'storage' },
  );
});

test('only a matching durable terminal receipt releases the exact stored errand intent', () => {
  const storage = new MemoryStorage(),
    store = new PendingErrandStore(storage, 'origin'),
    frozen = store.freeze(attempt());
  for (const wrong of [
    receipt({ requestId: otherId }),
    receipt({ operation: 'delete' }),
    receipt({ orderId: otherId }),
  ]) {
    assert.throws(() => store.settle(frozen, wrong), { kind: 'protocol' });
    assert.deepEqual(store.load(accountId), frozen);
  }
  assert.throws(
    () =>
      store.settle(
        attempt(command('cancel')),
        receipt({ operation: 'cancel' }),
      ),
    { kind: 'storage' },
  );
  storage.failRemove = true;
  assert.throws(() => store.settle(frozen, receipt()), { kind: 'storage' });
  assert.deepEqual(store.load(accountId), frozen);
  storage.failRemove = false;
  assert.equal(
    store.settle(frozen, {
      requestId,
      operation: 'accept',
      outcome: 'rejected',
      code: 'ERRAND_REVISION_CONFLICT',
    }).outcome,
    'rejected',
  );
  assert.equal(store.load(accountId), null);
  assert.throws(() => store.settle(frozen, receipt()), { kind: 'storage' });
  const noRemoval = new MemoryStorage(),
    broken = new PendingErrandStore(
      {
        get: (key) => noRemoval.get(key),
        set: (key, value) => noRemoval.set(key, value),
        remove: () => undefined,
      },
      'origin',
    );
  const pending = broken.freeze(attempt());
  assert.throws(() => broken.settle(pending, receipt()), { kind: 'storage' });
  assert.ok(broken.load(accountId));
});

test('publisher contacts are remembered only after an applied matching publication and stay account/origin isolated', () => {
  const storage = new MemoryStorage(),
    store = new PendingErrandStore(storage, 'origin');
  const publication = attempt({ operation: 'publish', payload: publish() });
  let frozen = store.freeze(publication);
  assert.equal(store.publisherContacts(accountId), null);
  assert.throws(() =>
    store.settle(frozen, receipt({ operation: 'publish', requestId: otherId })),
  );
  assert.equal(store.publisherContacts(accountId), null);
  store.settle(frozen, {
    requestId,
    operation: 'publish',
    outcome: 'rejected',
    code: 'CONTENT_REJECTED',
  });
  assert.equal(store.publisherContacts(accountId), null);
  frozen = store.freeze(publication);
  storage.failWrite = true;
  assert.throws(() => store.settle(frozen, receipt({ operation: 'publish' })), {
    kind: 'storage',
  });
  assert.ok(store.load(accountId));
  storage.failWrite = false;
  store.settle(frozen, receipt({ operation: 'publish' }));
  assert.equal(store.load(accountId), null);
  assert.deepEqual(store.publisherContacts(accountId), contacts());
  assert.equal(store.publisherContacts(otherId), null);
  assert.equal(
    new PendingErrandStore(storage, 'other-origin').publisherContacts(
      accountId,
    ),
    null,
  );
  assert.ok(Object.isFrozen(store.publisherContacts(accountId)));
  const acceptance = store.freeze(attempt());
  store.settle(acceptance, receipt());
  assert.deepEqual(store.publisherContacts(accountId), contacts());
});

test('failed publisher preference readback preserves the publication recovery barrier', () => {
  const storage = new MemoryStorage();
  const dropsPreferences: Storage = {
    get: (key) => storage.get(key),
    set: (key, value) => {
      if (!key.includes('publisher-contacts')) storage.set(key, value);
    },
    remove: (key) => storage.remove(key),
  };
  const store = new PendingErrandStore(dropsPreferences, 'origin');
  const frozen = store.freeze(
    attempt({ operation: 'publish', payload: publish() }),
  );
  assert.throws(() => store.settle(frozen, receipt({ operation: 'publish' })), {
    kind: 'storage',
  });
  assert.deepEqual(store.load(accountId), frozen);
  assert.equal(store.publisherContacts(accountId), null);
});
