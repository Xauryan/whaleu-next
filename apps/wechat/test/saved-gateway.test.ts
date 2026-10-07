import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { HttpCommunityGateway } from '../src/community/gateway';
import type {
  PostUpdatePreferences,
  SavedIntent,
  SavedReceipt,
} from '../src/community/saved-contract';
import { Cancellation } from '../src/platform/contracts';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  createdAt,
  otherId,
  post,
  postId,
  requestId,
} from './community-helpers';

const preferences = (): PostUpdatePreferences => ({
  postId,
  savedUpdatesEnabled: true,
  externalUpdatesEnabled: true,
  revision: '0',
  canSetPreference: true,
  reason: null,
  inAppCapability: 'local',
  inAppProcessing: 'manual_only',
  externalCapability: 'unavailable',
});
const intent = (overrides: Partial<SavedIntent> = {}): SavedIntent => ({
  clientRequestId: requestId,
  operation: 'set_post_saved',
  postId,
  desired: true,
  channel: null,
  ...overrides,
});
const receipt = (value = intent()): SavedReceipt => ({
  requestId: value.clientRequestId,
  operation: value.operation,
  postId: value.postId,
  desired: value.desired,
  channel: value.channel,
  outcome: 'applied',
});
const list = () => ({
  items: [
    {
      post: {
        ...post(),
        saveCount: 1,
        viewer: {
          ...post().viewer,
          isSaved: true,
          canSave: true,
          canSetUpdatePreference: true,
        },
      },
      savedAt: createdAt,
      saveEpochId: otherId,
    },
  ],
  nextCursor: null,
  visibleSavedCount: 1,
});
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

test('Saved routes use authenticated self-only list/batch/recovery and exact save, unsave and independent preference bodies', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(list());
  await s.gateway.saved('opaque_cursor', cancel, 50);
  s.transport.reply({ items: [{ postId, status: 'unavailable' }] });
  await s.gateway.savedStatuses([postId], cancel);
  s.transport.reply(preferences());
  await s.gateway.postUpdatePreferences(postId, cancel);
  for (const value of [
    intent(),
    intent({ desired: false }),
    intent({
      operation: 'set_post_update_preference',
      channel: 'saved',
      desired: false,
    }),
    intent({
      operation: 'set_post_update_preference',
      channel: 'external',
      desired: true,
    }),
  ]) {
    s.transport.reply(receipt(value));
    await s.gateway.applySaved(value, cancel);
  }
  s.transport.reply(receipt());
  await s.gateway.savedReceipt(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map(({ method, url }) => [
      method,
      new URL(url).pathname,
    ]),
    [
      ['GET', '/v1/me/community/saved'],
      ['POST', '/v1/me/community/saved/status'],
      ['GET', `/v1/community/posts/${postId}/update-preferences`],
      ['PUT', `/v1/community/posts/${postId}/save`],
      ['DELETE', `/v1/community/posts/${postId}/save`],
      ['PUT', `/v1/community/posts/${postId}/update-preferences`],
      ['PUT', `/v1/community/posts/${postId}/update-preferences`],
      ['GET', `/v1/me/community/saved-requests/${requestId}`],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[0]!.url).searchParams),
    { limit: '50', cursor: 'opaque_cursor' },
  );
  assert.deepEqual(
    s.transport.requests.map((r) => r.body),
    [
      undefined,
      { postIds: [postId] },
      undefined,
      { clientRequestId: requestId },
      { clientRequestId: requestId },
      { clientRequestId: requestId, channel: 'saved', enabled: false },
      { clientRequestId: requestId, channel: 'external', enabled: true },
      undefined,
    ],
  );
  assert.ok(s.transport.requests.every((r) => r.headers.Authorization));
});

test('all Saved reads and mutations require authentication before transport', async () => {
  const s = setup(false),
    cancel = new Cancellation();
  for (const run of [
    () => s.gateway.saved(null, cancel),
    () => s.gateway.savedStatuses([postId], cancel),
    () => s.gateway.postUpdatePreferences(postId, cancel),
    () => s.gateway.applySaved(intent(), cancel),
    () => s.gateway.savedReceipt(requestId, cancel),
  ])
    await assert.rejects(run, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
});

test('invalid Saved target, batch size, duplicate identity, cursor, limit and intent never reaches transport', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const uuid = (n: number) =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, '0')}`;
  for (const run of [
    () => s.gateway.saved('bad&cursor', cancel),
    ...[0, 51, 1.5, NaN, '20'].map(
      (limit) => () => s.gateway.saved(null, cancel, limit as number),
    ),
    () => s.gateway.savedStatuses([], cancel),
    () => s.gateway.savedStatuses([postId, postId], cancel),
    () => s.gateway.savedStatuses([uuid(1), uuid(1).toUpperCase()], cancel),
    () => s.gateway.savedStatuses(['bad'], cancel),
    () =>
      s.gateway.savedStatuses(
        Array.from({ length: 101 }, (_, n) => uuid(n)),
        cancel,
      ),
    () => s.gateway.postUpdatePreferences('bad', cancel),
    () =>
      s.gateway.savedReceipt('77777777-7777-1777-8777-777777777777', cancel),
    () => s.gateway.applySaved(intent({ postId: 'bad' }), cancel),
    () => s.gateway.applySaved(intent({ clientRequestId: 'bad' }), cancel),
    () =>
      s.gateway.applySaved(
        intent({ desired: 'true' as unknown as boolean }),
        cancel,
      ),
    () =>
      s.gateway.applySaved(
        intent({ operation: 'set_post_update_preference' }),
        cancel,
      ),
    () => s.gateway.applySaved(intent({ channel: 'saved' }), cancel),
  ])
    await assert.rejects(run, { kind: 'protocol' });
  assert.equal(s.transport.requests.length, 0);
});

test('Saved mutation success checks full frozen identity for applied and rejected receipts, including exact preference channel', async () => {
  const requested = intent({
    operation: 'set_post_update_preference',
    channel: 'saved',
    desired: false,
  });
  for (const outcome of ['applied', 'rejected'] as const) {
    const result =
      outcome === 'applied'
        ? receipt(requested)
        : { ...receipt(requested), outcome, code: 'POST_NOT_FOUND' };
    for (const body of [
      { ...result, requestId: otherId },
      { ...result, postId: otherId },
      { ...result, desired: true },
      { ...result, channel: 'external' },
      { ...result, operation: 'set_post_saved', channel: null },
      { ...result, saveCount: 10 },
      { ...result, preferences: preferences() },
    ]) {
      const s = setup();
      s.transport.reply(body);
      await assert.rejects(
        s.gateway.applySaved(requested, new Cancellation()),
        { kind: 'protocol' },
      );
    }
  }
  const s = setup();
  s.transport.reply({
    ...receipt(requested),
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  });
  assert.equal(
    (await s.gateway.applySaved(requested, new Cancellation())).outcome,
    'rejected',
  );
  s.transport.reply({ ...receipt(), requestId: otherId });
  await assert.rejects(s.gateway.savedReceipt(requestId, new Cancellation()), {
    kind: 'protocol',
  });
  s.transport.reply({ ...preferences(), postId: otherId });
  await assert.rejects(
    s.gateway.postUpdatePreferences(postId, new Cancellation()),
    { kind: 'protocol' },
  );
});

test('Saved gateway rejects unexpected success status and batch target mismatch without partial data', async () => {
  for (const status of [201, 202, 204]) {
    const s = setup(),
      cancel = new Cancellation();
    s.transport.reply(receipt(), status);
    await assert.rejects(s.gateway.applySaved(intent(), cancel), {
      kind: 'protocol',
    });
    s.transport.reply(receipt(), status);
    await assert.rejects(s.gateway.savedReceipt(requestId, cancel), {
      kind: 'protocol',
    });
    s.transport.reply(preferences(), status);
    await assert.rejects(s.gateway.postUpdatePreferences(postId, cancel), {
      kind: 'protocol',
    });
    s.transport.reply(list(), status);
    await assert.rejects(s.gateway.saved(null, cancel), { kind: 'protocol' });
    s.transport.reply({ items: [{ postId, status: 'unavailable' }] }, status);
    await assert.rejects(s.gateway.savedStatuses([postId], cancel), {
      kind: 'protocol',
    });
  }
  const s = setup();
  for (const items of [
    [{ postId: otherId, status: 'unavailable' }],
    [
      { postId, status: 'unavailable' },
      { postId: otherId, status: 'unavailable' },
    ],
    [
      { postId, status: 'unavailable' },
      { postId, status: 'unavailable' },
    ],
  ]) {
    s.transport.reply({ items });
    await assert.rejects(
      s.gateway.savedStatuses([postId], new Cancellation()),
      { kind: 'protocol' },
    );
  }
  s.transport.reply({ items: [{ postId, status: 'unavailable' }] });
  await assert.rejects(
    s.gateway.savedStatuses([postId, otherId], new Cancellation()),
    { kind: 'protocol' },
  );
  s.transport.reply({
    ...list(),
    items: [
      list().items[0],
      {
        ...list().items[0]!,
        post: { ...list().items[0]!.post, id: requestId },
        saveEpochId: requestId,
      },
    ],
    visibleSavedCount: 2,
  });
  await assert.rejects(s.gateway.saved(null, new Cancellation(), 1), {
    kind: 'protocol',
  });
});

test('batch target validation uses the dispatched immutable request snapshot when caller arrays change', async () => {
  const s = setup(),
    ids = [postId],
    pending = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => pending.promise);
  const running = s.gateway.savedStatuses(ids, new Cancellation());
  await flush();
  ids[0] = otherId;
  pending.resolve(response({ items: [{ postId, status: 'unavailable' }] }));
  assert.deepEqual((await running).items, [{ postId, status: 'unavailable' }]);
  assert.deepEqual(s.transport.requests[0]!.body, { postIds: [postId] });

  const wrong = setup(),
    changed = [postId],
    later = deferred<ReturnType<typeof response>>();
  wrong.transport.steps.push(() => later.promise);
  const wrongRequest = wrong.gateway.savedStatuses(changed, new Cancellation());
  await flush();
  changed[0] = otherId;
  later.resolve(
    response({ items: [{ postId: otherId, status: 'unavailable' }] }),
  );
  await assert.rejects(wrongRequest, { kind: 'protocol' });
});

test('Saved auth refresh replays exact frozen intent once; timeout, missing receipt and cancellation never launch a new mutation', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    value = intent({
      operation: 'set_post_update_preference',
      channel: 'external',
      desired: false,
    });
  s.transport.reply({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
  s.transport.reply(receipt(value));
  await s.gateway.applySaved(value, cancel);
  assert.equal(s.refreshes(), 1);
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  s.transport.steps.push(async () => {
    throw new ClientError('timeout', 'safe');
  });
  await assert.rejects(s.gateway.applySaved(value, cancel), {
    kind: 'timeout',
  });
  assert.equal(s.transport.requests.length, 3);
  s.transport.reply({ error: { code: 'REQUEST_NOT_FOUND' } }, 404);
  await assert.rejects(s.gateway.savedReceipt(requestId, cancel), {
    details: { httpStatus: 404, serverCode: 'REQUEST_NOT_FOUND' },
  });
  assert.equal(s.transport.requests.length, 4);
  const cancelled = new Cancellation();
  cancelled.cancel();
  await assert.rejects(s.gateway.applySaved(value, cancelled), {
    kind: 'cancelled',
  });
  await assert.rejects(s.gateway.saved(null, cancelled), { kind: 'cancelled' });
  assert.equal(s.transport.requests.length, 4);
});

for (const account of ['same-account', 'different-account'] as const) {
  test(`late Saved reads and mutation receipts cannot cross ${account} login epochs`, async () => {
    for (const operation of [
      'list',
      'batch',
      'preferences',
      'mutation',
      'receipt',
    ] as const) {
      const s = setup(),
        cancel = new Cancellation();
      s.transport.steps.push(async () => {
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials('c'),
          ...(account === 'different-account' ? { accountId: otherId } : {}),
        });
        return response(
          operation === 'list'
            ? list()
            : operation === 'batch'
              ? { items: [{ postId, status: 'unavailable' }] }
              : operation === 'preferences'
                ? preferences()
                : receipt(),
        );
      });
      const running =
        operation === 'list'
          ? s.gateway.saved(null, cancel)
          : operation === 'batch'
            ? s.gateway.savedStatuses([postId], cancel)
            : operation === 'preferences'
              ? s.gateway.postUpdatePreferences(postId, cancel)
              : operation === 'mutation'
                ? s.gateway.applySaved(intent(), cancel)
                : s.gateway.savedReceipt(requestId, cancel);
      await assert.rejects(running, { kind: 'stale-session' });
    }
  });
}

test('all Saved routes reject noncanonical uppercase UUIDs before any request dispatch', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const lowerPost = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const lowerRequest = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const value = intent({ postId: lowerPost, clientRequestId: lowerRequest });
  for (const run of [
    () =>
      s.gateway.applySaved(
        { ...value, postId: lowerPost.toUpperCase() },
        cancel,
      ),
    () =>
      s.gateway.applySaved(
        { ...value, clientRequestId: lowerRequest.toUpperCase() },
        cancel,
      ),
    () => s.gateway.savedReceipt(lowerRequest.toUpperCase(), cancel),
    () => s.gateway.postUpdatePreferences(lowerPost.toUpperCase(), cancel),
    () => s.gateway.savedStatuses([lowerPost.toUpperCase()], cancel),
  ])
    await assert.rejects(run, { kind: 'protocol' });
  assert.equal(s.transport.requests.length, 0);
});
