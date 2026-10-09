import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingCategoryManagementGateway } from '../src/ratings/category-management-gateway';
import { ratingCategoryRejections } from '../src/ratings/category-management-contract';
import { deferred, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { otherId, regionId, requestId, revision } from './ratings-helpers';
import {
  cancelledCategoryReceipt,
  categoryCreationIntent,
  categoryCreationReceipt,
  categoryManagementContext,
  categoryPreparation,
  categoryTestId,
} from './category-management-helpers';

const prefix = '/v1/ratings/category-management';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpRatingCategoryManagementGateway(
    new ApiClient('https://ratings.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
    sessions,
  );
  return { transport, sessions, gateway };
}

test('category creation uses exact authenticated context, prepare, categories, receipt and cancel routes', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(categoryManagementContext());
  assert.deepEqual(
    await s.gateway.context(null, cancel),
    categoryManagementContext(),
  );
  s.transport.reply(categoryManagementContext(regionId));
  assert.deepEqual(
    await s.gateway.context(regionId, cancel),
    categoryManagementContext(regionId),
  );
  s.transport.reply(categoryPreparation());
  s.transport.reply(categoryCreationReceipt());
  assert.deepEqual(
    await s.gateway.command(categoryCreationIntent(), cancel),
    categoryCreationReceipt(),
  );
  s.transport.reply(categoryCreationReceipt());
  assert.deepEqual(
    await s.gateway.receipt(requestId, cancel),
    categoryCreationReceipt(),
  );
  s.transport.reply(cancelledCategoryReceipt());
  assert.deepEqual(
    await s.gateway.cancel(categoryCreationIntent(), cancel),
    cancelledCategoryReceipt(),
  );
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `${prefix}/context`],
      ['GET', `${prefix}/context`],
      ['POST', `${prefix}/prepare`],
      ['POST', `${prefix}/categories`],
      ['GET', `${prefix}/requests/${requestId}`],
      ['POST', `${prefix}/cancel`],
    ],
  );
  assert.equal(new URL(s.transport.requests[0]!.url).search, '');
  assert.equal(
    new URL(s.transport.requests[1]!.url).search,
    `?regionId=${regionId}`,
  );
  for (const index of [0, 1, 4])
    assert.equal(s.transport.requests[index]!.body, undefined);
  assert.deepEqual(
    s.transport.requests[2]!.body,
    categoryCreationIntent().payload,
  );
  assert.deepEqual(s.transport.requests[3]!.body, {
    ...categoryCreationIntent().payload,
    expectedContextRevision: categoryPreparation().contextRevision,
  });
  assert.deepEqual(
    s.transport.requests[5]!.body,
    categoryCreationIntent().payload,
  );
  for (const request of s.transport.requests) {
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
    assert.equal(request.cancellation, cancel);
  }
  for (const index of [2, 3, 4, 5])
    assert.equal(new URL(s.transport.requests[index]!.url).search, '');
});

test('regional creation preserves its exact scope without campus substitution or global authority', async () => {
  const s = setup(),
    intent = categoryCreationIntent({ regionId });
  s.transport.reply(categoryPreparation(intent));
  s.transport.reply(categoryCreationReceipt(intent));
  assert.deepEqual(
    await s.gateway.command(intent, new Cancellation()),
    categoryCreationReceipt(intent),
  );
  assert.deepEqual(s.transport.requests[0]!.body, intent.payload);
  assert.deepEqual(s.transport.requests[1]!.body, {
    ...intent.payload,
    expectedContextRevision: categoryPreparation(intent).contextRevision,
  });
});

test('invalid route and original input never dispatch, and cross-scope or noncanonical context fails closed', async () => {
  const s = setup(),
    cancel = new Cancellation();
  await assert.rejects(() => s.gateway.context('invalid', cancel));
  await assert.rejects(() => s.gateway.receipt('invalid', cancel));
  const invalid = {
    ...categoryCreationIntent(),
    payload: {
      ...categoryCreationIntent().payload,
      expectedScopeRevision: 'invalid',
    },
  };
  for (const send of [
    s.gateway.prepare.bind(s.gateway),
    s.gateway.command.bind(s.gateway),
    s.gateway.cancel.bind(s.gateway),
  ])
    await assert.rejects(() => send(invalid, cancel), { kind: 'protocol' });
  assert.equal(s.transport.requests.length, 0);
  for (const patch of [
    { regionId: otherId },
    { campusIds: [] },
    { campusIds: [otherId, otherId] },
    { actorId: otherId },
    { maximumDepth: 4 },
    { scopeRevision: 'bad' },
    {
      parents: [
        { ...categoryManagementContext().parents[0], name: ' leading' },
      ],
    },
  ]) {
    s.transport.reply({ ...categoryManagementContext(regionId), ...patch });
    await assert.rejects(() => s.gateway.context(regionId, cancel), {
      kind: 'protocol',
    });
  }
  s.transport.reply(categoryManagementContext(regionId));
  await assert.rejects(() => s.gateway.context(null, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(categoryManagementContext());
  await assert.rejects(() => s.gateway.context(regionId, cancel), {
    kind: 'protocol',
  });
});

test('every mismatched preparation blocks publication before categories can be sent', async () => {
  const prepared = categoryPreparation();
  for (const patch of [
    { requestId: otherId },
    { contextRevision: 'invalid' },
    { releaseId: otherId },
    { categories: prepared.categories.slice(0, 2) },
    { categories: [...prepared.categories].reverse() },
    {
      categories: [
        { ...prepared.categories[0], key: 'wrong' },
        ...prepared.categories.slice(1),
      ],
    },
    {
      categories: [
        { ...prepared.categories[0], parentId: otherId },
        ...prepared.categories.slice(1),
      ],
    },
    {
      categories: [
        { ...prepared.categories[0], level: 2 },
        ...prepared.categories.slice(1),
      ],
    },
    {
      categories: [
        prepared.categories[0],
        { ...prepared.categories[1], parentId: otherId },
        prepared.categories[2],
      ],
    },
    {
      categories: [
        prepared.categories[0],
        { ...prepared.categories[1], id: prepared.categories[0]!.id },
        prepared.categories[2],
      ],
    },
  ]) {
    const s = setup();
    s.transport.reply({ ...prepared, ...patch });
    await assert.rejects(
      () => s.gateway.command(categoryCreationIntent(), new Cancellation()),
      { kind: 'protocol' },
    );
    assert.equal(s.transport.requests.length, 1);
    assert.equal(
      new URL(s.transport.requests[0]!.url).pathname,
      `${prefix}/prepare`,
    );
  }
});

test('applied commit must exactly equal the category identities and revisions reserved by preparation', async () => {
  const receipt = categoryCreationReceipt();
  for (const patch of [
    { requestId: otherId },
    { outcome: 'noop' },
    { releaseId: 'invalid' },
    {
      categories: [
        { ...receipt.categories[0], revision: otherId },
        ...receipt.categories.slice(1),
      ],
    },
    {
      categories: [
        receipt.categories[0],
        receipt.categories[1],
        { ...receipt.categories[2], id: otherId },
      ],
    },
    {
      categories: [
        receipt.categories[0],
        { ...receipt.categories[1], parentId: otherId },
        receipt.categories[2],
      ],
    },
    { categories: [...receipt.categories].reverse() },
    { catalogs: [{ regionId: null, catalogRevision: revision }] },
    { catalogs: receipt.catalogs.slice(1) },
    { contextRevision: categoryPreparation().contextRevision },
  ]) {
    const s = setup();
    s.transport.reply(categoryPreparation());
    s.transport.reply({ ...receipt, ...patch });
    await assert.rejects(
      () => s.gateway.command(categoryCreationIntent(), new Cancellation()),
      { kind: 'protocol' },
    );
    assert.equal(s.transport.requests.length, 2);
  }
  const s = setup(),
    regional = categoryCreationIntent({ regionId });
  s.transport.reply(categoryPreparation(regional));
  s.transport.reply({
    ...categoryCreationReceipt(regional),
    catalogs: categoryCreationReceipt().catalogs,
  });
  await assert.rejects(() => s.gateway.command(regional, new Cancellation()), {
    kind: 'protocol',
  });
});

test('validated durable prepare rejection stops commit; applied and unavailable prepare results cannot be terminal', async () => {
  for (const code of ratingCategoryRejections) {
    const s = setup(),
      receipt = { ...cancelledCategoryReceipt(), code };
    s.transport.reply(receipt);
    assert.deepEqual(
      await s.gateway.command(categoryCreationIntent(), new Cancellation()),
      receipt,
    );
    assert.equal(s.transport.requests.length, 1);
  }
  for (const value of [
    { ...cancelledCategoryReceipt(), requestId: otherId },
    { ...cancelledCategoryReceipt(), code: 'RATING_UNAVAILABLE' },
    { ...cancelledCategoryReceipt(), code: 'CONTENT_REVIEW_UNAVAILABLE' },
    { ...cancelledCategoryReceipt(), releaseId: otherId },
    categoryCreationReceipt(),
    { ...categoryCreationReceipt(), outcome: 'noop' },
    { requestId, outcome: 'pending' },
  ]) {
    const s = setup();
    s.transport.reply(value);
    await assert.rejects(
      () => s.gateway.prepare(categoryCreationIntent(), new Cancellation()),
      { kind: 'protocol' },
    );
    assert.equal(s.transport.requests.length, 1);
  }
});

test('HTTP denials, Review/auth/topology uncertainty and absent receipts are never synthesized terminal outcomes', async () => {
  for (const phase of ['prepare', 'commit', 'cancel', 'receipt'] as const)
    for (const [status, code] of [
      [404, 'RATING_NOT_FOUND'],
      [404, 'REQUEST_NOT_FOUND'],
      [409, 'RATING_CATEGORY_CONTEXT_CHANGED'],
      [403, 'PHONE_VERIFICATION_REQUIRED'],
      [403, 'SAFETY_ACTION_RESTRICTED'],
      [503, 'CONTENT_REVIEW_UNAVAILABLE'],
      [503, 'VERIFICATION_UNAVAILABLE'],
      [503, 'SAFETY_UNAVAILABLE'],
      [503, 'RATING_UNAVAILABLE'],
      [503, 'TOPOLOGY_UNAVAILABLE'],
      [500, 'INTERNAL_ERROR'],
    ] as const) {
      const s = setup(),
        cancel = new Cancellation();
      if (phase === 'commit') s.transport.reply(categoryPreparation());
      s.transport.reply(
        { error: { code, message: 'synthetic uncertain result' } },
        status,
      );
      await assert.rejects(() =>
        phase === 'cancel'
          ? s.gateway.cancel(categoryCreationIntent(), cancel)
          : phase === 'receipt'
            ? s.gateway.receipt(requestId, cancel)
            : s.gateway.command(categoryCreationIntent(), cancel),
      );
      assert.equal(s.transport.requests.length, phase === 'commit' ? 2 : 1);
    }
});

test('account changes, same-account login, logout or cancellation after prepare block old-context commit', async () => {
  for (const stop of ['account', 'same-account', 'logout', 'cancel'] as const)
    for (const prepared of [
      categoryPreparation(),
      cancelledCategoryReceipt(),
    ]) {
      const s = setup(),
        cancel = new Cancellation();
      const prepare = s.gateway.prepare.bind(s.gateway);
      s.gateway.prepare = async (...args) => {
        const result = await prepare(...args);
        if (stop === 'cancel') cancel.cancel();
        else if (stop === 'logout') s.sessions.logout();
        else
          s.sessions.completeLogin(
            s.sessions.beginLogin(),
            stop === 'account'
              ? { ...wireCredentials('b'), accountId: otherId }
              : { ...wireCredentials('b'), sessionId: otherId },
          );
        return result;
      };
      s.transport.reply(prepared);
      await assert.rejects(
        () => s.gateway.command(categoryCreationIntent(), cancel),
        {
          kind: stop === 'cancel' ? 'cancelled' : 'stale-session',
        },
      );
      assert.equal(s.transport.requests.length, 1);
    }
});

test('session replacement during commit or cancellation cannot deliver an old-session success', async () => {
  for (const phase of ['commit', 'cancel'] as const) {
    const s = setup(),
      cancel = new Cancellation(),
      pending = deferred<ReturnType<typeof response>>();
    const dispatched = deferred<void>();
    if (phase === 'commit') s.transport.reply(categoryPreparation());
    s.transport.steps.push(async () => {
      dispatched.resolve();
      return pending.promise;
    });
    const work =
      phase === 'commit'
        ? s.gateway.command(categoryCreationIntent(), cancel)
        : s.gateway.cancel(categoryCreationIntent(), cancel);
    await dispatched.promise;
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('b'),
      sessionId: otherId,
    });
    pending.resolve(response(categoryCreationReceipt()));
    await assert.rejects(work, { kind: 'stale-session' });
    assert.equal(s.transport.requests.length, phase === 'commit' ? 2 : 1);
  }
});

test('standalone preparation is never reused across sessions; command re-prepares its same original key', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(categoryPreparation());
  assert.deepEqual(
    await s.gateway.prepare(categoryCreationIntent(), cancel),
    categoryPreparation(),
  );
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    sessionId: otherId,
  });
  s.transport.reply(categoryPreparation());
  const rejected = {
    ...cancelledCategoryReceipt(),
    code: 'RATING_CATEGORY_CONTEXT_CHANGED' as const,
  };
  s.transport.reply(rejected);
  assert.deepEqual(
    await s.gateway.command(categoryCreationIntent(), cancel),
    rejected,
  );
  assert.deepEqual(
    s.transport.requests.map((r) => new URL(r.url).pathname),
    [`${prefix}/prepare`, `${prefix}/prepare`, `${prefix}/categories`],
  );
  assert.equal(
    JSON.stringify(s.transport.requests[0]!.body),
    JSON.stringify(s.transport.requests[1]!.body),
  );
  assert.equal(
    s.transport.requests[1]!.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
});

test('lost prepare and commit responses replay original bytes including every node and scope binding', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    original = categoryCreationIntent();
  const originalBytes = JSON.stringify(original.payload);
  s.transport.steps.push(async () => {
    throw new Error('lost prepare');
  });
  await assert.rejects(() => s.gateway.command(original, cancel), {
    kind: 'network',
  });
  s.transport.reply(categoryPreparation());
  s.transport.steps.push(async () => {
    throw new Error('lost commit');
  });
  await assert.rejects(() => s.gateway.command(original, cancel), {
    kind: 'network',
  });
  s.transport.reply(categoryPreparation());
  s.transport.reply(categoryCreationReceipt());
  assert.deepEqual(
    await s.gateway.command(original, cancel),
    categoryCreationReceipt(),
  );
  for (const index of [0, 1, 3])
    assert.equal(
      JSON.stringify(s.transport.requests[index]!.body),
      originalBytes,
    );
  for (const index of [2, 4])
    assert.equal(
      JSON.stringify(s.transport.requests[index]!.body),
      JSON.stringify({
        ...original.payload,
        expectedContextRevision: categoryPreparation().contextRevision,
      }),
    );
  assert.equal(JSON.stringify(original.payload), originalBytes);
});

test('mutating caller nodes while prepare is pending cannot change the frozen original commit input', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    pending = deferred<ReturnType<typeof response>>();
  const dispatched = deferred<void>();
  const original = categoryCreationIntent();
  const raw = {
    ...original,
    payload: {
      ...original.payload,
      nodes: original.payload.nodes.map((node) => ({ ...node })),
    },
  };
  s.transport.steps.push(async () => {
    dispatched.resolve();
    return pending.promise;
  });
  s.transport.reply(categoryCreationReceipt());
  const work = s.gateway.command(raw, cancel);
  await dispatched.promise;
  raw.payload.clientRequestId = otherId;
  raw.payload.regionId = regionId;
  raw.payload.expectedScopeRevision = 'z'.repeat(43);
  raw.payload.nodes[0]!.name = 'Changed after dispatch';
  raw.payload.nodes[1]!.description = 'Changed after dispatch';
  raw.payload.nodes.reverse();
  pending.resolve(response(categoryPreparation()));
  await work;
  assert.equal(
    JSON.stringify(s.transport.requests[0]!.body),
    JSON.stringify(original.payload),
  );
  assert.equal(
    JSON.stringify(s.transport.requests[1]!.body),
    JSON.stringify({
      ...original.payload,
      expectedContextRevision: categoryPreparation().contextRevision,
    }),
  );
});

test('cancel sends only original intent bytes and preserves prior applied receipt precedence', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    original = categoryCreationIntent();
  for (const result of [
    categoryCreationReceipt(),
    cancelledCategoryReceipt(),
  ]) {
    s.transport.reply(result);
    assert.deepEqual(await s.gateway.cancel(original, cancel), result);
  }
  s.transport.steps.push(async () => {
    throw new Error('lost cancellation');
  });
  await assert.rejects(() => s.gateway.cancel(original, cancel), {
    kind: 'network',
  });
  s.transport.reply(categoryCreationReceipt());
  assert.deepEqual(
    await s.gateway.cancel(original, cancel),
    categoryCreationReceipt(),
  );
  for (const request of s.transport.requests) {
    assert.equal(new URL(request.url).pathname, `${prefix}/cancel`);
    assert.equal(request.method, 'POST');
    assert.equal(
      JSON.stringify(request.body),
      JSON.stringify(original.payload),
    );
    assert.equal(
      JSON.stringify(request.body).includes('contextRevision'),
      false,
    );
  }
});

test('receipt and cancellation reject another original key, another operation or incompatible scope', async () => {
  for (const value of [
    { ...categoryCreationReceipt(), requestId: otherId },
    { ...cancelledCategoryReceipt(), requestId: otherId },
    { ...cancelledCategoryReceipt(), operation: 'edit_target' },
    { ...cancelledCategoryReceipt(), code: 'RATING_UNAVAILABLE' },
  ]) {
    const s = setup();
    s.transport.reply(value);
    await assert.rejects(
      () => s.gateway.receipt(requestId, new Cancellation()),
      { kind: 'protocol' },
    );
    s.transport.reply(value);
    await assert.rejects(
      () => s.gateway.cancel(categoryCreationIntent(), new Cancellation()),
      { kind: 'protocol' },
    );
  }
  const s = setup();
  s.transport.reply({
    ...categoryCreationReceipt(),
    catalogs: [{ regionId: otherId, catalogRevision: categoryTestId(450) }],
  });
  await assert.rejects(
    () => s.gateway.cancel(categoryCreationIntent(), new Cancellation()),
    { kind: 'protocol' },
  );
});

test('all five endpoints require login and exact HTTP 200 success', async () => {
  for (const phase of [
    'context',
    'prepare',
    'command',
    'cancel',
    'receipt',
  ] as const) {
    const s = setup(),
      cancel = new Cancellation();
    const invoke = () =>
      phase === 'context'
        ? s.gateway.context(null, cancel)
        : phase === 'prepare'
          ? s.gateway.prepare(categoryCreationIntent(), cancel)
          : phase === 'command'
            ? s.gateway.command(categoryCreationIntent(), cancel)
            : phase === 'cancel'
              ? s.gateway.cancel(categoryCreationIntent(), cancel)
              : s.gateway.receipt(requestId, cancel);
    s.sessions.logout();
    await assert.rejects(invoke, { kind: 'auth-required' });
    assert.equal(s.transport.requests.length, 0);
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
    const value =
      phase === 'context'
        ? categoryManagementContext()
        : phase === 'prepare' || phase === 'command'
          ? categoryPreparation()
          : categoryCreationReceipt();
    s.transport.reply(value, 201);
    await assert.rejects(invoke, { kind: 'protocol' });
    assert.equal(s.transport.requests.length, 1);
  }
});

test('a historically applied category batch replays after a new same-account session using its stable original key', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(categoryPreparation());
  s.transport.reply(categoryCreationReceipt());
  await s.gateway.command(categoryCreationIntent(), cancel);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    sessionId: otherId,
  });
  s.transport.reply(categoryPreparation());
  s.transport.reply(categoryCreationReceipt());
  assert.deepEqual(
    await s.gateway.command(categoryCreationIntent(), cancel),
    categoryCreationReceipt(),
  );
  assert.equal(
    JSON.stringify(s.transport.requests[0]!.body),
    JSON.stringify(s.transport.requests[2]!.body),
  );
  assert.equal(
    JSON.stringify(s.transport.requests[1]!.body),
    JSON.stringify(s.transport.requests[3]!.body),
  );
  assert.equal(
    new URL(s.transport.requests[2]!.url).pathname,
    `${prefix}/prepare`,
  );
  assert.equal(
    new URL(s.transport.requests[3]!.url).pathname,
    `${prefix}/categories`,
  );
});

test('same-session access refresh replays original prepare and commit bytes exactly once', async () => {
  for (const phase of [
    'prepare',
    'commit',
    'cancel',
    'receipt',
    'context',
  ] as const) {
    const s = setup(),
      cancel = new Cancellation();
    if (phase === 'commit') s.transport.reply(categoryPreparation());
    s.transport.reply(
      {
        error: {
          code: 'ACCESS_TOKEN_EXPIRED',
          message: 'expired synthetic access',
        },
      },
      401,
    );
    s.transport.reply(
      phase === 'context'
        ? categoryManagementContext()
        : phase === 'prepare'
          ? categoryPreparation()
          : categoryCreationReceipt(),
    );
    if (phase === 'prepare') s.transport.reply(categoryCreationReceipt());
    const result =
      phase === 'context'
        ? await s.gateway.context(null, cancel)
        : phase === 'cancel'
          ? await s.gateway.cancel(categoryCreationIntent(), cancel)
          : phase === 'receipt'
            ? await s.gateway.receipt(requestId, cancel)
            : await s.gateway.command(categoryCreationIntent(), cancel);
    assert.deepEqual(
      result,
      phase === 'context'
        ? categoryManagementContext()
        : categoryCreationReceipt(),
    );
    const first = phase === 'commit' ? 1 : 0;
    assert.equal(
      s.transport.requests[first]!.url,
      s.transport.requests[first + 1]!.url,
    );
    assert.equal(
      s.transport.requests[first]!.method,
      s.transport.requests[first + 1]!.method,
    );
    assert.equal(
      JSON.stringify(s.transport.requests[first]!.body),
      JSON.stringify(s.transport.requests[first + 1]!.body),
    );
    assert.equal(
      s.transport.requests[first]!.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
    assert.equal(
      s.transport.requests[first + 1]!.headers.Authorization,
      `Bearer ${wireCredentials('b').accessToken}`,
    );
    assert.equal(
      s.transport.requests.length,
      phase === 'prepare' || phase === 'commit' ? 3 : 2,
    );
  }
  const s = setup();
  for (let i = 0; i < 2; i++)
    s.transport.reply(
      { error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'still expired' } },
      401,
    );
  await assert.rejects(
    () => s.gateway.command(categoryCreationIntent(), new Cancellation()),
    { kind: 'auth-expired' },
  );
  assert.equal(s.transport.requests.length, 2);
  assert.equal(
    s.transport.requests.every(
      (request) => new URL(request.url).pathname === `${prefix}/prepare`,
    ),
    true,
  );
});
