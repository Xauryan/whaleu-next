import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ClientError } from '../src/api/errors';
import { ApiClient } from '../src/api/client';
import { Cancellation } from '../src/platform/contracts';
import {
  decodeViewEpoch,
  decodeViewIntent,
  decodeViewReceipt,
  matchViewReceipt,
  viewFingerprint,
  VIEW_COLLECTION_MS,
  VIEW_RETENTION_MS,
  VIEW_RETRY_MS,
  type ViewEpoch,
  type ViewIntent,
} from '../src/community/view-contract';
import {
  HttpViewGateway,
  type ViewGateway,
} from '../src/community/view-gateway';
import {
  PendingViewStore,
  VIEW_QUEUE_KEY,
} from '../src/community/view-pending';
import { ViewRuntime } from '../src/community/view-runtime';
import { createCommunityRuntime } from '../src/community/runtime';
import {
  credentials,
  deferred,
  FakeClock,
  flush,
  MemoryStorage,
  ScriptedTransport,
  signedIn,
} from './helpers';
const a = '11111111-1111-4111-8111-111111111111',
  b = '22222222-2222-4222-8222-222222222222';
const epochId = '33333333-3333-4333-8333-333333333333',
  batchId = '44444444-4444-4444-8444-444444444444';
const origin = 'https://api.example.test';
const epoch = (now = 1000, issued = 1000, id = epochId): ViewEpoch => ({
  version: 1,
  epochId: id,
  issuedAt: new Date(issued).toISOString(),
  collectionUntil: new Date(issued + VIEW_COLLECTION_MS).toISOString(),
  expiresAt: new Date(issued + VIEW_RETENTION_MS).toISOString(),
  serverNow: new Date(now).toISOString(),
});
const intent = (
  postIds: readonly string[] = [a],
  kind: ViewIntent['kind'] = 'list_exposure',
): ViewIntent => ({ version: 1, epochId, batchId, kind, postIds });
const receipt = (value: ViewIntent) => ({
  version: 1 as const,
  epochId: value.epochId,
  batchId: value.batchId,
  kind: value.kind,
  payloadFingerprint: viewFingerprint(value),
  acceptedCount: value.postIds.length,
});
function store(storage = new MemoryStorage(), now = 1000) {
  const pending = new PendingViewStore(storage, origin, now);
  assert.equal(pending.synchronize('12', epoch(now), now, now), true);
  return { pending, storage };
}
let sequence = 1;
const uuid = async () =>
  `${(sequence++).toString(16).padStart(8, '0')}-7777-4777-8777-777777777777`;
function harness() {
  const clock = new FakeClock(),
    storage = new MemoryStorage(),
    sessions = signedIn();
  const pending = new PendingViewStore(storage, origin, clock.now());
  const reports: ViewIntent[] = [];
  const gateway: ViewGateway = {
    epoch: async () =>
      epoch(
        clock.now(),
        Math.floor((clock.now() - 1000) / VIEW_COLLECTION_MS) *
          VIEW_COLLECTION_MS +
          1000,
        `${(Math.floor(clock.now() / VIEW_COLLECTION_MS) + 3).toString(16).padStart(8, '0')}-3333-4333-8333-333333333333`,
      ),
    report: async (value) => {
      reports.push(value);
      return receipt(value);
    },
  };
  const runtime = new ViewRuntime(sessions, gateway, pending, uuid, clock);
  return { clock, storage, sessions, pending, gateway, reports, runtime };
}

test('view contract exactly binds multiset multiplicities and kind to official SHA-256 fixtures', () => {
  const values = [
    [
      intent([a, a]),
      '07e9f88de1b276aeb3364f1ba24412f4f885523a442157a882e5ca58cef2b162',
    ],
    [
      intent([a, b, a]),
      '67d9f41e18ae9de8bb391d5a656f0d9d299e93da7f99f6fc46cceedbb66fd414',
    ],
    [
      intent([a], 'detail_visit'),
      'f7de73883b1736204cf4c0be07b3dd2b1ced9c73230207a35791c42637fe55d6',
    ],
  ] as const;
  for (const [value, expected] of values)
    assert.equal(viewFingerprint(value), expected);
  assert.equal(
    viewFingerprint(intent([b, a, a])),
    viewFingerprint(intent([a, b, a])),
  );
  assert.notEqual(
    viewFingerprint(intent([a, b])),
    viewFingerprint(intent([a, b, a])),
  );
  const text = JSON.stringify([
    1,
    'list_exposure',
    [
      [a, 2],
      [b, 1],
    ],
  ]);
  assert.equal(
    viewFingerprint(intent([a, b, a])),
    createHash('sha256').update(text).digest('hex'),
  );
  assert.equal(decodeViewIntent(intent([a.toUpperCase()])).postIds[0], a);
});
test('view strict decoders reject extras, bad bounds, clocks and mismatched receipts', () => {
  for (const value of [
    { ...intent(), actorId: a },
    intent([]),
    intent(Array(51).fill(a)),
    intent([a, b], 'detail_visit'),
    { ...intent(), batchId: 'bad' },
  ])
    assert.throws(() => decodeViewIntent(value), { kind: 'protocol' });
  assert.equal(decodeViewIntent(intent(Array(50).fill(a))).postIds.length, 50);
  for (const value of [
    { ...receipt(intent()), publicCount: 2 },
    { ...receipt(intent()), acceptedCount: 1.5 },
    { ...receipt(intent()), acceptedCount: -1 },
  ])
    assert.throws(() => decodeViewReceipt(value), { kind: 'protocol' });
  for (const patch of [
    { batchId: b },
    { epochId: b },
    { kind: 'detail_visit' },
    { payloadFingerprint: '0'.repeat(64) },
    { acceptedCount: 2 },
  ])
    assert.throws(
      () => matchViewReceipt(intent(), { ...receipt(intent()), ...patch }),
      { kind: 'protocol' },
    );
  for (const value of [
    { ...epoch(), serverNow: epoch().collectionUntil },
    { ...epoch(), expiresAt: epoch().collectionUntil },
    { ...epoch(), owner: a },
  ])
    assert.throws(() => decodeViewEpoch(value), { kind: 'protocol' });
});
test('gateway uses exact authenticated POST routes and no observation or actor metadata', async () => {
  const sessions = signedIn(),
    transport = new ScriptedTransport();
  const gateway = new HttpViewGateway(
    new ApiClient(origin, transport, sessions, {
      refresh: async () => sessions.snapshot(),
    }),
  );
  transport.reply(epoch());
  await gateway.epoch(new Cancellation());
  transport.reply(receipt(intent()));
  await gateway.report(intent(), new Cancellation());
  assert.equal(
    transport.requests[0]?.url,
    `${origin}/v1/me/community/view-reporting-epoch`,
  );
  assert.deepEqual(transport.requests[0]?.body, { version: 1 });
  assert.equal(
    transport.requests[1]?.url,
    `${origin}/v1/me/community/view-reports`,
  );
  assert.deepEqual(transport.requests[1]?.body, intent());
  assert.equal(transport.requests[1]?.method, 'POST');
  assert.match(transport.requests[1]?.headers.Authorization ?? '', /^Bearer /);
});
test('persist-before-send freeze preserves duplicate events and exact identity across restart', () => {
  const { pending, storage } = store();
  for (let n = 0; n < 50; n++)
    assert.equal(pending.observe('12', 'list_exposure', a, 1000), true);
  const due = pending.dueObservation('12', 1000)!;
  const frozen = pending.freeze('12', due, batchId, 1000)!;
  assert.equal(frozen.intent.postIds.length, 50);
  pending.assertOriginal('12', frozen);
  const restarted = new PendingViewStore(storage, origin, 1100);
  assert.deepEqual(restarted.dueBatch('12', 1100), frozen);
  assert.equal(restarted.settle('12', frozen, receipt(frozen.intent)), true);
  assert.equal(restarted.quantities('12').events, 0);
});
test('failed local success deletion retains original frozen identity and cannot create replacement', () => {
  const { pending, storage } = store();
  pending.observe('12', 'detail_visit', a, 1000);
  const frozen = pending.freeze(
    '12',
    pending.dueObservation('12', 1000)!,
    batchId,
    1000,
  )!;
  storage.failWrite = true;
  assert.equal(pending.settle('12', frozen, receipt(frozen.intent)), false);
  assert.equal(pending.observe('12', 'detail_visit', b, 1000), false);
  storage.failWrite = false;
  const restarted = new PendingViewStore(storage, origin, 1100);
  assert.deepEqual(restarted.dueBatch('12', 1100), frozen);
});
test('read exception never overwrites unknown storage, corruption discards without reconstructing events', () => {
  const storage = new MemoryStorage();
  let writes = 0;
  storage.get = () => {
    throw new Error('unavailable');
  };
  storage.set = () => {
    writes++;
  };
  const pending = new PendingViewStore(storage, origin, 1000);
  assert.equal(pending.synchronize('12', epoch(), 1000, 1000), false);
  assert.equal(writes, 0);
  const corrupt = new MemoryStorage();
  corrupt.set(VIEW_QUEUE_KEY, { version: 1, owners: [{ postIds: [a] }] });
  const recovered = new PendingViewStore(corrupt, origin, 1000);
  assert.equal(recovered.quantities('12').events, 0);
  assert.equal(recovered.diagnostics.corruptDropped, 1);
});
test('queue limits drop new work, evict only inactive owners and keep API origins isolated', () => {
  const { pending, storage } = store();
  for (let n = 0; n < 500; n++)
    assert.equal(pending.observe('12', 'list_exposure', a, 1000), true);
  assert.equal(pending.observe('12', 'list_exposure', b, 1000), false);
  assert.equal(pending.quantities('12').events, 500);
  for (const account of ['13', '14', '15'])
    assert.equal(pending.synchronize(account, epoch(), 1000, 1000), true);
  assert.equal(pending.quantities('12').events, 0);
  assert.equal(pending.quantities('15').owners, 3);
  const other = new PendingViewStore(
    storage,
    'https://other.example.test',
    1000,
  );
  assert.equal(other.quantities('15').events, 0);
  assert.equal(other.collecting('15', 1000), undefined);
});
test('collection closes at one hour while original frozen reports recover only until immutable expiry', () => {
  const { pending } = store();
  pending.observe('12', 'detail_visit', a, 1000);
  const frozen = pending.freeze(
    '12',
    pending.dueObservation('12', 1000)!,
    batchId,
    1000,
  )!;
  assert.equal(
    pending.observe('12', 'list_exposure', a, 1000 + VIEW_COLLECTION_MS),
    false,
  );
  assert.deepEqual(pending.dueBatch('12', 1000 + VIEW_COLLECTION_MS), frozen);
  pending.purge(1000 + VIEW_RETENTION_MS);
  assert.equal(pending.quantities('12').events, 0);
  pending.synchronize(
    '12',
    epoch(1000 + VIEW_RETENTION_MS, 1000 + VIEW_RETENTION_MS, b),
    1000 + VIEW_RETENTION_MS,
    1000 + VIEW_RETENTION_MS,
  );
  assert.equal(pending.dueBatch('12', 1000 + VIEW_RETENTION_MS), undefined);
});
test('rollback pauses collection until fresh server clock and never extends original server expiry', () => {
  const { pending, storage } = store();
  pending.observe('12', 'detail_visit', a, 5000);
  const frozen = pending.freeze(
    '12',
    pending.dueObservation('12', 5000)!,
    batchId,
    5000,
  )!;
  const restarted = new PendingViewStore(storage, origin, 2000);
  assert.equal(restarted.collecting('12', 2000), undefined);
  assert.equal(restarted.dueBatch('12', 2000), undefined);
  assert.equal(restarted.synchronize('12', epoch(6000), 2000, 2000), true);
  assert.deepEqual(restarted.dueBatch('12', 5000)?.intent, frozen.intent);
  restarted.purge(1000 + VIEW_RETENTION_MS - 4000);
  assert.equal(restarted.quantities('12').events, 0);
});
test('runtime sends detail immediately, list at fifty or five minutes, and hide never flushes small batches', async () => {
  const h = harness();
  await h.runtime.foreground();
  h.runtime.observe('list_exposure', a);
  await flush();
  assert.equal(h.reports.length, 0);
  h.runtime.hide();
  h.clock.advance(VIEW_RETRY_MS);
  await flush();
  assert.equal(h.reports.length, 0);
  await h.runtime.foreground();
  assert.equal(h.reports.length, 1);
  h.runtime.observe('detail_visit', b);
  await flush();
  assert.equal(h.reports.length, 2);
  for (let n = 0; n < 50; n++) h.runtime.observe('list_exposure', a);
  await flush();
  assert.equal(h.reports.length, 3);
  assert.equal(h.reports[2]?.postIds.length, 50);
  h.runtime.dispose();
});
test('uncertain report retries identical payload after five minutes while later due work progresses', async () => {
  const h = harness();
  await h.runtime.foreground();
  let first: ViewIntent | undefined;
  h.gateway.report = async (value) => {
    h.reports.push(value);
    if (!first) {
      first = value;
      throw new ClientError('network', 'lost response');
    }
    return receipt(value);
  };
  h.runtime.observe('detail_visit', a);
  await flush();
  assert.equal(h.pending.quantities('12').batches, 1);
  h.runtime.observe('detail_visit', b);
  await flush();
  assert.equal(h.reports.length, 2);
  h.clock.advance(VIEW_RETRY_MS);
  await flush();
  assert.equal(h.reports.length, 3);
  assert.deepEqual(h.reports[2], first);
  h.runtime.dispose();
});
test('wrong receipt remains original pending; terminal closed/conflict discards without rewrap', async () => {
  const h = harness();
  await h.runtime.foreground();
  h.gateway.report = async (value) => ({
    ...receipt(value),
    payloadFingerprint: '0'.repeat(64),
  });
  h.runtime.observe('detail_visit', a);
  await flush();
  const first = h.pending.dueBatch('12', h.clock.now() + VIEW_RETRY_MS)!;
  assert.ok(first);
  h.gateway.report = async () => {
    throw new ClientError('business', 'closed', {
      httpStatus: 410,
      serverCode: 'VIEW_REPORTING_EPOCH_CLOSED',
    });
  };
  h.clock.advance(VIEW_RETRY_MS);
  await flush();
  assert.equal(h.pending.quantities('12').events, 0);
  assert.equal(h.pending.diagnostics.terminalDropped, 1);
  h.runtime.dispose();
});
test('owner switch fences late success, old owner can recover exact work but cannot send as new account', async () => {
  const h = harness();
  await h.runtime.foreground();
  const wait = deferred<ReturnType<typeof receipt>>();
  let sent: ViewIntent | undefined;
  h.gateway.report = async (value) => {
    sent = value;
    return wait.promise;
  };
  h.runtime.observe('detail_visit', a);
  await flush();
  assert.ok(sent);
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials('13'));
  await flush();
  wait.resolve(receipt(sent));
  await flush();
  assert.equal(h.pending.quantities('12').events, 1);
  assert.equal(h.pending.quantities('13').events, 0);
  h.gateway.report = async (value) => {
    h.reports.push(value);
    return receipt(value);
  };
  h.sessions.completeLogin(h.sessions.beginLogin(), credentials('12'));
  await flush();
  assert.deepEqual(h.reports[0], sent);
  h.runtime.dispose();
});
test('foreground offline and logged-out all-owner expiry cleanup does not depend on epoch fetch', async () => {
  const h = harness();
  await h.runtime.foreground();
  h.runtime.observe('list_exposure', a);
  await flush();
  h.gateway.epoch = async () => {
    throw new ClientError('network', 'offline');
  };
  h.clock.advance(VIEW_RETENTION_MS);
  await flush();
  assert.equal(h.pending.quantities('12').events, 0);
  h.runtime.dispose();
  const j = harness();
  await j.runtime.foreground();
  j.runtime.observe('list_exposure', a);
  await flush();
  j.sessions.logout();
  j.clock.advance(VIEW_RETENTION_MS);
  await flush();
  assert.equal(j.pending.quantities('12').events, 0);
  j.runtime.dispose();
});
test('late receipt for batch removed at expiry cannot block subsequent fresh reporting', async () => {
  const h = harness();
  await h.runtime.foreground();
  const wait = deferred<ReturnType<typeof receipt>>();
  let sent: ViewIntent | undefined;
  h.gateway.report = async (value) => {
    sent = value;
    return wait.promise;
  };
  h.runtime.observe('detail_visit', a);
  await flush();
  assert.ok(sent);
  h.clock.advance(VIEW_RETENTION_MS);
  await flush();
  assert.equal(h.pending.quantities('12').events, 0);
  wait.resolve(receipt(sent));
  await flush();
  assert.equal(h.pending.usable, true);
  h.gateway.report = async (value) => {
    h.reports.push(value);
    return receipt(value);
  };
  await h.runtime.foreground();
  h.runtime.observe('detail_visit', b);
  await flush();
  assert.equal(h.reports.length, 1);
  h.runtime.dispose();
});
test('batch capacity and round-trip storage verification prevent overwriting or sending uncertain work', () => {
  const { pending, storage } = store();
  for (let n = 0; n < 128; n++) {
    assert.equal(pending.observe('12', 'detail_visit', a, 1000), true);
    assert.ok(
      pending.freeze(
        '12',
        pending.dueObservation('12', 1000)!,
        `${n.toString(16).padStart(8, '0')}-7777-4777-8777-777777777777`,
        1000,
      ),
    );
  }
  assert.equal(pending.quantities('12').batches, 128);
  assert.equal(pending.observe('12', 'detail_visit', b, 1000), false);
  const first = pending.dueBatch('12', 1000)!;
  const persisted = storage.get(VIEW_QUEUE_KEY) as { revision: number };
  storage.set(VIEW_QUEUE_KEY, {
    ...persisted,
    revision: persisted.revision + 1,
  });
  assert.throws(() => pending.assertOriginal('12', first), { kind: 'storage' });
  assert.equal(pending.usable, false);
});
test('fresh descriptor is required after restart/foreground and offline observations are never attached retrospectively', async () => {
  const h = harness();
  const waiting = deferred<ViewEpoch>();
  h.gateway.epoch = async () => waiting.promise;
  const foreground = h.runtime.foreground();
  h.runtime.observe('detail_visit', a);
  assert.equal(h.pending.quantities('12').events, 0);
  waiting.resolve(epoch());
  await foreground;
  assert.equal(h.pending.quantities('12').events, 0);
  h.gateway.epoch = async () => {
    throw new ClientError('network', 'offline');
  };
  h.clock.advance(VIEW_COLLECTION_MS);
  await flush();
  h.runtime.observe('detail_visit', b);
  assert.equal(h.pending.quantities('12').events, 0);
  h.runtime.dispose();
});

test('configured runtime hydration and empty cleanup never persist an unrelated read-only page cache', () => {
  const clock = new FakeClock(),
    storage = new MemoryStorage(),
    sessions = signedIn();
  const transport = new ScriptedTransport();
  const api = new ApiClient(origin, transport, sessions, {
    refresh: async () => sessions.snapshot(),
  });
  let writes = 0;
  const runtime = createCommunityRuntime(
    { sessions, api },
    {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => {
        writes += 1;
        storage.set(key, value);
      },
      removeStorageSync: (key) => storage.remove(key),
      request: () => {
        throw new Error('No native network expected');
      },
      login: () => {
        throw new Error('No native login expected');
      },
    },
    origin,
    clock,
  );
  assert.equal(writes, 0);
  assert.equal(storage.data.size, 0);
  clock.advance(60_000);
  runtime.views!.pending.purge(clock.now());
  runtime.privateViews?.clear();
  runtime.views!.hide();
  sessions.logout();
  runtime.views!.dispose();
  assert.equal(writes, 0);
  assert.equal(storage.data.size, 0);
  assert.equal(transport.requests.length, 0);
});
