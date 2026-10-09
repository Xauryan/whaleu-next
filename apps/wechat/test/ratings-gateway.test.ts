import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation, type Storage } from '../src/platform/contracts';
import type { RatingIntent } from '../src/ratings/contract';
import { HttpRatingsGateway } from '../src/ratings/gateway';
import { PendingRatingStore, type PendingRating } from '../src/ratings/pending';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  body,
  categoryId,
  categoryPage,
  comment,
  commentId,
  commentPage,
  context,
  cursor,
  intent,
  myScore,
  otherId,
  receipt,
  regionId,
  requestId,
  revision,
  summary,
  target,
  targetId,
  targetPage,
} from './ratings-helpers';
const accountId = wireCredentials().accountId;
function setup(loggedIn = true) {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  if (loggedIn)
    sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  let refreshes = 0;
  const gateway = new HttpRatingsGateway(
    new ApiClient('https://ratings.example', transport, sessions, {
      refresh: async () => {
        refreshes++;
        return sessions.rotate(sessions.snapshot(), wireCredentials('b'));
      },
    }),
  );
  return { sessions, transport, gateway, refreshes: () => refreshes };
}
const attempt = (command = intent()): PendingRating => ({
  version: 1,
  accountId,
  intent: command,
});

test('real ApiClient ratings gateway uses authenticated bounded GET routes and explicit global omission', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(context());
  await s.gateway.context(cancel);
  s.transport.reply(categoryPage());
  await s.gateway.categories(null, null, null, cancel);
  s.transport.reply(
    targetPage({
      context: { regionId, catalogRevision: revision, categoryId },
    }),
  );
  await s.gateway.targets(regionId, categoryId, cursor, cancel, 10);
  s.transport.reply(target());
  await s.gateway.detail(regionId, targetId, cancel);
  s.transport.reply(myScore());
  await s.gateway.myScore(regionId, targetId, cancel);
  s.transport.reply(summary());
  await s.gateway.summary(null, targetId, cancel);
  s.transport.reply(
    commentPage({ context: { regionId, catalogRevision: revision, targetId } }),
  );
  await s.gateway.comments(regionId, targetId, cursor, cancel, 50);
  s.transport.reply(comment());
  await s.gateway.comment(regionId, commentId, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', '/v1/ratings/context'],
      ['GET', '/v1/ratings/categories'],
      ['GET', '/v1/ratings/targets'],
      ['GET', `/v1/ratings/targets/${targetId}`],
      ['GET', `/v1/ratings/targets/${targetId}/my-score`],
      ['GET', `/v1/ratings/targets/${targetId}/score-summary`],
      ['GET', `/v1/ratings/targets/${targetId}/comments`],
      ['GET', `/v1/ratings/comments/${commentId}`],
    ],
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[1]!.url).searchParams),
    { limit: '20' },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[2]!.url).searchParams),
    { regionId, categoryId, cursor, limit: '10' },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[6]!.url).searchParams),
    { regionId, cursor, limit: '50' },
  );
  assert.equal(new URL(s.transport.requests[5]!.url).search, '');
  for (const request of s.transport.requests) {
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
    assert.equal(request.body, undefined);
  }
});

test('three independent commands and recovery use exact frozen body, method and owner-only receipt route', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    commands = (['set_score', 'create_comment', 'delete_comment'] as const).map(
      intent,
    );
  for (const command of commands) {
    s.transport.reply(receipt(command));
    await s.gateway.command(command, cancel);
  }
  s.transport.reply(receipt());
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['PUT', `/v1/ratings/targets/${targetId}/my-score`],
      ['POST', `/v1/ratings/targets/${targetId}/comments`],
      ['DELETE', `/v1/ratings/comments/${commentId}`],
      ['GET', `/v1/ratings/requests/${requestId}`],
    ],
  );
  for (let i = 0; i < commands.length; i++)
    assert.deepEqual(s.transport.requests[i]!.body, commands[i]!.payload);
  assert.equal(s.transport.requests[3]!.body, undefined);
});

test('all public and owner-only rating reads and commands require authentication before dispatch', async () => {
  const s = setup(false),
    cancel = new Cancellation();
  for (const call of [
    () => s.gateway.context(cancel),
    () => s.gateway.categories(null, null, null, cancel),
    () => s.gateway.targets(null, categoryId, null, cancel),
    () => s.gateway.detail(null, targetId, cancel),
    () => s.gateway.myScore(null, targetId, cancel),
    () => s.gateway.summary(null, targetId, cancel),
    () => s.gateway.comments(null, targetId, null, cancel),
    () => s.gateway.comment(null, commentId, cancel),
    () => s.gateway.receipt(requestId, cancel),
    ...(['set_score', 'create_comment', 'delete_comment'] as const).map(
      (op) => () => s.gateway.command(intent(op), cancel),
    ),
  ])
    await assert.rejects(call, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
});

test('invalid identifiers, cursor and limit injection, score coercion and unsupported media fail before dispatch', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const id of ['bad', `${targetId}?accountId=${otherId}`])
    for (const call of [
      () => s.gateway.categories(id, null, null, cancel),
      () => s.gateway.categories(null, id, null, cancel),
      () => s.gateway.targets(null, id, null, cancel),
      () => s.gateway.detail(null, id, cancel),
      () => s.gateway.myScore(id, targetId, cancel),
      () => s.gateway.summary(null, id, cancel),
      () => s.gateway.comment(null, id, cancel),
      () => s.gateway.receipt(id, cancel),
    ])
      await assert.rejects(async () => call());
  for (const limit of [0, 51, 1.5, NaN, Infinity]) {
    await assert.rejects(async () =>
      s.gateway.categories(null, null, null, cancel, limit),
    );
    await assert.rejects(async () =>
      s.gateway.targets(null, categoryId, null, cancel, limit),
    );
    await assert.rejects(async () =>
      s.gateway.comments(null, targetId, null, cancel, limit),
    );
  }
  for (const token of ['', 'a'.repeat(42), cursor + '&targetId=other'])
    await assert.rejects(async () =>
      s.gateway.comments(null, targetId, token, cancel),
    );
  for (const command of [
    { ...intent(), payload: { ...intent().payload, score: '5' } },
    {
      ...intent('create_comment'),
      payload: { ...intent('create_comment').payload, assetIds: [otherId] },
    },
  ])
    await assert.rejects(async () =>
      s.gateway.command(command as RatingIntent, cancel),
    );
  assert.equal(s.transport.requests.length, 0);
});

test('decoder binds exact page scope and locator, bounded size, duplicate IDs, and forward cursor including empty scans', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const data of [
    categoryPage({
      context: { regionId, catalogRevision: revision, parentId: null },
    }),
    categoryPage({
      context: { regionId: null, catalogRevision: revision, parentId: otherId },
    }),
    categoryPage({ items: [], nextCursor: cursor, continuation: 'scan' }),
    categoryPage({
      items: [
        categoryPage().items[0]!,
        { ...categoryPage().items[0]!, id: otherId },
      ],
    }),
  ]) {
    s.transport.reply(data);
    await assert.rejects(s.gateway.categories(null, null, cursor, cancel, 1), {
      kind: 'protocol',
    });
  }
  s.transport.reply(
    targetPage({
      context: {
        regionId: null,
        catalogRevision: revision,
        categoryId: otherId,
      },
    }),
  );
  await assert.rejects(s.gateway.targets(null, categoryId, null, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(targetPage({ items: [target({ categoryId: otherId })] }));
  await assert.rejects(s.gateway.targets(null, categoryId, null, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(
    commentPage({
      context: { regionId: null, catalogRevision: revision, targetId: otherId },
      items: [],
    }),
  );
  await assert.rejects(s.gateway.comments(null, targetId, null, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(
    commentPage({ items: [], continuation: 'scan', nextCursor: cursor }),
  );
  assert.equal(
    (await s.gateway.comments(null, targetId, null, cancel)).continuation,
    'scan',
  );
});

test('detail, comment and receipts reject wrong resource, mismatched operation and any historical content snapshot', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(target({ id: otherId }));
  await assert.rejects(s.gateway.detail(null, targetId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply(comment({ id: otherId }));
  await assert.rejects(s.gateway.comment(null, commentId, cancel), {
    kind: 'protocol',
  });
  for (const data of [
    { ...receipt(), requestId: otherId },
    { ...receipt(), targetId: otherId, subjectId: otherId },
    { ...receipt(), operation: 'delete_comment' },
    { ...receipt(), body },
    { ...receipt(), score: 5 },
    { ...receipt(), comment: comment() },
  ]) {
    s.transport.reply(data);
    await assert.rejects(s.gateway.command(intent(), cancel), {
      kind: 'protocol',
    });
  }
  s.transport.reply({ ...receipt(), requestId: otherId });
  await assert.rejects(s.gateway.receipt(requestId, cancel), {
    kind: 'protocol',
  });
  for (const status of [201, 202, 204]) {
    s.transport.reply(receipt(), status);
    await assert.rejects(s.gateway.receipt(requestId, cancel), {
      kind: 'protocol',
    });
  }
  s.transport.reply({ error: { code: 'REQUEST_NOT_FOUND' } }, 404);
  await assert.rejects(s.gateway.receipt(requestId, cancel), {
    details: { httpStatus: 404, serverCode: 'REQUEST_NOT_FOUND' },
  });
});

test('authentication replay preserves immutable canonical request key and body after caller mutation', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    frozen = intent('create_comment');
  if (frozen.operation !== 'create_comment') throw new Error('fixture');
  const raw = {
    ...frozen,
    payload: { ...frozen.payload, body: ` \r\n${body} ` },
  };
  s.transport.steps.push(async () => {
    raw.payload.body = 'must not replace';
    raw.payload.clientRequestId = otherId;
    raw.payload.authorMode = 'named';
    raw.targetId = otherId;
    return {
      status: 401,
      headers: {},
      body: { error: { code: 'ACCESS_TOKEN_EXPIRED' } },
    };
  });
  s.transport.reply(receipt(frozen));
  await s.gateway.command(raw, cancel);
  assert.equal(s.refreshes(), 1);
  assert.equal(s.transport.requests.length, 2);
  assert.deepEqual(s.transport.requests[0]!.body, frozen.payload);
  assert.deepEqual(s.transport.requests[1]!.body, frozen.payload);
  assert.equal(s.transport.requests[0]!.url, s.transport.requests[1]!.url);
  assert.equal(
    s.transport.requests[1]!.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
});

test('unknown outcomes never auto-retry, cancellation blocks dispatch, and late account/epoch replies are fenced', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.steps.push(async () => {
    throw new ClientError('timeout', 'Synthetic response loss');
  });
  await assert.rejects(s.gateway.command(intent(), cancel), {
    kind: 'timeout',
  });
  assert.equal(s.transport.requests.length, 1);
  cancel.cancel();
  await assert.rejects(s.gateway.command(intent(), cancel), {
    kind: 'cancelled',
  });
  assert.equal(s.transport.requests.length, 1);
  for (const account of [accountId, otherId])
    for (const kind of [
      'detail',
      'myScore',
      'comments',
      'command',
      'receipt',
    ] as const) {
      const late = setup();
      late.transport.steps.push(async () => {
        late.sessions.completeLogin(late.sessions.beginLogin(), {
          ...wireCredentials('c'),
          accountId: account,
        });
        return {
          status: 200,
          headers: {},
          body:
            kind === 'detail'
              ? target()
              : kind === 'myScore'
                ? myScore()
                : kind === 'comments'
                  ? commentPage()
                  : receipt(),
        };
      });
      const c = new Cancellation();
      await assert.rejects(
        kind === 'detail'
          ? late.gateway.detail(null, targetId, c)
          : kind === 'myScore'
            ? late.gateway.myScore(null, targetId, c)
            : kind === 'comments'
              ? late.gateway.comments(null, targetId, null, c)
              : kind === 'command'
                ? late.gateway.command(intent(), c)
                : late.gateway.receipt(requestId, c),
        { kind: 'stale-session' },
      );
    }
});

test('pending ratings keep one immutable original account/origin intent and cannot replace its target/body/key', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'https://ratings.example'),
    command = intent('create_comment'),
    original = store.freeze(attempt(command));
  assert.ok(Object.isFrozen(original));
  assert.ok(Object.isFrozen(original.intent));
  assert.ok(Object.isFrozen(original.intent.payload));
  assert.deepEqual(store.freeze(attempt(command)), original);
  assert.equal(storage.data.size, 1);
  assert.equal(store.load(otherId), null);
  assert.equal(
    new PendingRatingStore(storage, 'https://other.example').load(accountId),
    null,
  );
  for (const changed of [
    intent(),
    { ...command, targetId: otherId },
    { ...command, payload: { ...command.payload, body: 'replacement' } },
    { ...command, payload: { ...command.payload, clientRequestId: otherId } },
  ])
    assert.throws(() => store.freeze(attempt(changed as RatingIntent)), {
      kind: 'storage',
    });
  assert.deepEqual(store.load(accountId), original);
  new PendingRatingStore(storage, 'https://other.example').freeze(attempt());
  store.freeze({ ...attempt(), accountId: otherId });
  store.settle(original, receipt(command));
  assert.equal(store.load(accountId), null);
  assert.ok(store.load(otherId));
  assert.ok(
    new PendingRatingStore(storage, 'https://other.example').load(accountId),
  );
});

test('journal write/readback/corruption/removal failures remain closed and never erase unknown attempts', () => {
  const broken: Storage[] = [
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    {
      get: () => {
        throw new Error('read');
      },
      set: () => undefined,
      remove: () => undefined,
    },
    {
      get: () => undefined,
      set: () => {
        throw new Error('write');
      },
      remove: () => undefined,
    },
  ];
  for (const storage of broken)
    assert.throws(
      () => new PendingRatingStore(storage, 'origin').freeze(attempt()),
      { kind: 'storage' },
    );
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin'),
    original = store.freeze(attempt()),
    key = [...storage.data.keys()][0]!;
  for (const corrupted of [
    { ...original, version: 2 },
    { ...original, accountId: otherId },
    { ...original, intent: { ...original.intent, accountId: otherId } },
  ]) {
    storage.data.set(key, corrupted);
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(attempt()), { kind: 'storage' });
    assert.equal(storage.data.get(key), corrupted);
  }
  storage.data.set(key, original);
  storage.failRemove = true;
  assert.throws(() => store.settle(original, receipt()), { kind: 'storage' });
  assert.deepEqual(store.load(accountId), original);
  storage.failRemove = false;
  storage.remove = () => undefined;
  assert.throws(() => store.settle(original, receipt()), { kind: 'storage' });
  assert.throws(() =>
    store.settle(original, { ...receipt(), requestId: otherId }),
  );
  assert.deepEqual(store.load(accountId), original);
});

for (const [code, status] of [
  ['RATING_UNAVAILABLE', 503],
  ['RATING_NOT_FOUND', 404],
  ['RATING_SCOPE_UNAVAILABLE', 403],
  ['RATING_SCORE_UNAVAILABLE', 503],
  ['RATING_REVISION_CONFLICT', 409],
] as const)
  test(`${code} HTTP status is exact and cannot downgrade protocol mismatch into business state`, async () => {
    const s = setup(),
      cancel = new Cancellation();
    s.transport.reply({ error: { code } }, status);
    await assert.rejects(
      s.gateway.myScore(null, targetId, cancel),
      (error: unknown) =>
        error instanceof ClientError &&
        error.kind !== 'protocol' &&
        error.details.serverCode === code &&
        error.details.httpStatus === status,
    );
    for (const wrong of [400, 401, 404, 409, 500, 503].filter(
      (n) => n !== status,
    )) {
      s.transport.reply({ error: { code } }, wrong);
      await assert.rejects(s.gateway.myScore(null, targetId, cancel), {
        kind: 'protocol',
      });
    }
  });

test('pending freeze validates its outer version/account/keys and refuses persisted noncanonical text', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  for (const value of [
    { ...attempt(), version: 2 },
    { ...attempt(), accountId: 'bad' },
    { ...attempt(), extra: 'private' },
  ])
    assert.throws(() => store.freeze(value as PendingRating), {
      kind: 'storage',
    });
  const command = intent('create_comment');
  if (command.operation !== 'create_comment') throw new Error('fixture');
  const original = store.freeze(
    attempt({
      ...command,
      payload: { ...command.payload, body: ` ${body}\r\n` },
    }),
  );
  assert.deepEqual(original.intent, command);
  const key = [...storage.data.keys()][0]!;
  storage.data.set(key, {
    ...original,
    intent: { ...command, payload: { ...command.payload, body: ` ${body}` } },
  });
  assert.throws(() => store.load(accountId), { kind: 'storage' });
});
