import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingLikesGateway } from '../src/ratings/like-gateway';
import { HttpRatingLikeUpdatesGateway } from '../src/ratings/like-updates-gateway';
import { HttpRatingsGateway } from '../src/ratings/gateway';
import type { RatingLikeIntent } from '../src/ratings/like-contract';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  commentPage,
  cursor,
  intent,
  otherId,
  receipt,
  regionId,
  requestId,
  targetId,
} from './ratings-helpers';
import {
  noticeId,
  readReceipt,
  replyId,
  replyIntent,
  replyReceipt,
} from './ratings-r2a-helpers';
import {
  likeIntent,
  likeNoticeTarget,
  likeReceipt,
  likeState,
  likeUpdates,
} from './ratings-r2b-helpers';
import {
  PendingRatingStore,
  ratingIntentTarget,
  type PendingRating,
} from '../src/ratings/pending';

const accountId = wireCredentials().accountId;
const root = { targetId, rootId: commentId, replyId: null };
const child = { ...root, replyId };
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
    likes: new HttpRatingLikesGateway(api),
    updates: new HttpRatingLikeUpdatesGateway(api),
    ratings: new HttpRatingsGateway(api),
  };
}

test('R2B all nine authenticated like/local-notice routes use exact method, path, scope and payload', async () => {
  const s = setup(),
    c = new Cancellation();
  s.transport.reply(likeState());
  await s.likes.state(null, root, c);
  s.transport.reply(likeState({ replyId }));
  await s.likes.state(regionId, child, c);
  for (const operation of ['set_comment_like', 'set_reply_like'] as const) {
    const command = likeIntent(operation);
    s.transport.reply(likeReceipt(command));
    await s.likes.command(command, c);
  }
  s.transport.reply(likeReceipt());
  await s.likes.receipt(requestId, c);
  s.transport.reply(likeUpdates());
  await s.updates.list(null, c);
  s.transport.reply({ unreadCount: 1 });
  await s.updates.unread(c);
  s.transport.reply(likeNoticeTarget());
  await s.updates.target(noticeId, c);
  s.transport.reply(readReceipt());
  await s.updates.markRead(noticeId, c);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `/v1/ratings/comments/${commentId}/like`],
      ['GET', `/v1/ratings/replies/${replyId}/like`],
      ['PUT', `/v1/ratings/comments/${commentId}/like`],
      ['PUT', `/v1/ratings/replies/${replyId}/like`],
      ['GET', `/v1/ratings/like-requests/${requestId}`],
      ['GET', '/v1/me/ratings/like-updates'],
      ['GET', '/v1/me/ratings/like-updates/unread-count'],
      ['GET', `/v1/me/ratings/like-updates/${noticeId}/target`],
      ['PUT', `/v1/me/ratings/like-updates/${noticeId}/read`],
    ],
  );
  assert.equal(new URL(s.transport.requests[0]!.url).search, '');
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[1]!.url).searchParams),
    { regionId },
  );
  assert.deepEqual(s.transport.requests[2]!.body, likeIntent().payload);
  assert.deepEqual(
    s.transport.requests[3]!.body,
    likeIntent('set_reply_like').payload,
  );
  assert.deepEqual(s.transport.requests[8]!.body, {});
  for (const request of s.transport.requests)
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});

test('R2B no-auth and malformed inputs fail before any transport dispatch', async () => {
  const s = setup(false),
    c = new Cancellation();
  for (const run of [
    () => s.likes.state(null, root, c),
    () => s.likes.state(null, child, c),
    () => s.likes.command(likeIntent(), c),
    () => s.likes.command(likeIntent('set_reply_like'), c),
    () => s.likes.receipt(requestId, c),
    () => s.updates.list(null, c),
    () => s.updates.unread(c),
    () => s.updates.target(noticeId, c),
    () => s.updates.markRead(noticeId, c),
  ])
    await assert.rejects(run, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
  const valid = setup();
  for (const run of [
    () => valid.likes.state('bad', root, c),
    () =>
      valid.likes.state(
        null,
        { ...root, rootId: `${commentId}?actor=${otherId}` },
        c,
      ),
    () => valid.likes.state(null, { ...child, replyId: 'bad' }, c),
    () => valid.likes.state(null, { ...child, targetId: 'bad' }, c),
    () => valid.likes.receipt('bad', c),
    () => valid.updates.list('bad', c),
    () => valid.updates.list(null, c, 21),
    () => valid.updates.target('bad', c),
    () => valid.updates.markRead('bad', c),
    () =>
      valid.likes.command(
        {
          ...likeIntent(),
          payload: { ...likeIntent().payload, recipient: otherId },
        } as unknown as RatingLikeIntent,
        c,
      ),
  ])
    await assert.rejects(async () => run());
  assert.equal(valid.transport.requests.length, 0);
});

test('R2B gateways bind subject/request/desired-state and notice identity rather than trusting successful HTTP', async () => {
  const s = setup(),
    c = new Cancellation();
  for (const patch of [
    { targetId: otherId },
    { rootId: otherId },
    { replyId },
  ]) {
    s.transport.reply(likeState(patch));
    await assert.rejects(s.likes.state(null, root, c), { kind: 'protocol' });
  }
  s.transport.reply(likeState());
  await assert.rejects(s.likes.state(null, child, c), { kind: 'protocol' });
  s.transport.reply({ status: 'unavailable' });
  assert.deepEqual(await s.likes.state(null, root, c), {
    status: 'unavailable',
  });
  for (const patch of [
    { requestId: otherId },
    { targetId: otherId },
    { rootId: otherId },
    { liked: false },
  ]) {
    s.transport.reply({ ...likeReceipt(), ...patch });
    await assert.rejects(s.likes.command(likeIntent(), c), {
      kind: 'protocol',
    });
  }
  s.transport.reply(likeReceipt(likeIntent(), { requestId: otherId }));
  await assert.rejects(s.likes.receipt(requestId, c), { kind: 'protocol' });
  s.transport.reply(replyReceipt());
  await assert.rejects(s.likes.receipt(requestId, c), { kind: 'protocol' });
  s.transport.reply(likeNoticeTarget({ noticeId: otherId }));
  await assert.rejects(s.updates.target(noticeId, c), { kind: 'protocol' });
  s.transport.reply(readReceipt({ noticeId: otherId }));
  await assert.rejects(s.updates.markRead(noticeId, c), { kind: 'protocol' });
  s.transport.reply(likeUpdates({ nextCursor: cursor }));
  await assert.rejects(s.updates.list(cursor, c), { kind: 'protocol' });
});

test('R2B authentication replay freezes root/reply desired-state body and path against caller mutation', async () => {
  for (const operation of ['set_comment_like', 'set_reply_like'] as const) {
    const s = setup(),
      c = new Cancellation(),
      original = likeIntent(operation),
      raw = structuredClone(original);
    s.transport.steps.push(async () => {
      Object.assign(raw.payload, {
        liked: false,
        clientRequestId: otherId,
        expectedLikeRevision: otherId,
      });
      Object.assign(
        raw,
        operation === 'set_comment_like'
          ? { rootId: otherId }
          : { replyId: otherId },
      );
      return {
        status: 401,
        headers: {},
        body: { error: { code: 'ACCESS_TOKEN_EXPIRED' } },
      };
    });
    s.transport.reply(likeReceipt(original));
    await s.likes.command(raw, c);
    assert.deepEqual(s.transport.requests[0]!.body, original.payload);
    assert.deepEqual(s.transport.requests[1]!.body, original.payload);
    assert.equal(s.transport.requests[0]!.url, s.transport.requests[1]!.url);
  }
});

for (const code of [
  'RATING_NOT_FOUND',
  'REQUEST_NOT_FOUND',
  'RATING_UNAVAILABLE',
  'CONTENT_REVIEW_UNAVAILABLE',
  'NOTICE_NOT_FOUND',
])
  test(`R2B ${code} is never forged into terminal success or zero coverage`, async () => {
    const s = setup(),
      c = new Cancellation();
    s.transport.reply(
      { error: { code } },
      code.endsWith('NOT_FOUND') ? 404 : 503,
    );
    await assert.rejects(
      s.likes.receipt(requestId, c),
      (e) => e instanceof ClientError && e.details.serverCode === code,
    );
  });

test('R2B root sort query is opt-in; omitted sort preserves the exact legacy GET contract', async () => {
  const s = setup(),
    c = new Cancellation();
  s.transport.reply(commentPage());
  await s.ratings.comments(null, targetId, null, c);
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[0]!.url).searchParams),
    { limit: '20' },
  );
  for (const sort of ['time', 'likes'] as const)
    for (const order of ['asc', 'desc'] as const) {
      s.transport.reply(
        commentPage({ context: { ...commentPage().context, regionId } }),
      );
      await s.ratings.comments(regionId, targetId, null, c, 20, {
        sort,
        order,
      });
      assert.deepEqual(
        Object.fromEntries(
          new URL(s.transport.requests[s.transport.requests.length - 1]!.url)
            .searchParams,
        ),
        { regionId, limit: '20', sort, order },
      );
    }
  const before = s.transport.requests.length;
  for (const invalid of [
    { sort: 'hot', order: 'asc' },
    { sort: 'likes', order: 'newest' },
    { sort: 'time', order: 'desc', recipient: otherId },
  ])
    await assert.rejects(async () =>
      s.ratings.comments(
        null,
        targetId,
        null,
        c,
        20,
        invalid as { sort: 'time'; order: 'desc' },
      ),
    );
  assert.equal(s.transport.requests.length, before);
});

test('R2B late owner epoch, account switch and cancellation cannot publish transport results', async () => {
  for (const account of [accountId, otherId])
    for (const operation of [
      'state',
      'command',
      'receipt',
      'list',
      'read',
    ] as const) {
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
              ? likeState()
              : operation === 'list'
                ? likeUpdates()
                : operation === 'read'
                  ? readReceipt()
                  : likeReceipt(),
        };
      });
      await assert.rejects(
        operation === 'state'
          ? s.likes.state(null, root, c)
          : operation === 'command'
            ? s.likes.command(likeIntent(), c)
            : operation === 'receipt'
              ? s.likes.receipt(requestId, c)
              : operation === 'list'
                ? s.updates.list(null, c)
                : s.updates.markRead(noticeId, c),
        { kind: 'stale-session' },
      );
    }
  const s = setup(),
    c = new Cancellation();
  c.cancel();
  await assert.rejects(s.likes.command(likeIntent(), c), { kind: 'cancelled' });
  assert.equal(s.transport.requests.length, 0);
});

test('R2B v2 like commands share the original account/origin slot and v1 remains R1-only', () => {
  for (const operation of ['set_comment_like', 'set_reply_like'] as const) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    const pending = store.freeze({
      version: 2,
      accountId,
      intent: likeIntent(operation),
    });
    assert.equal(storage.data.size, 1);
    assert.deepEqual(
      storage.get(`whaleu.ratings.pending.v2:origin:${accountId}`),
      pending,
    );
    assert.equal(ratingIntentTarget(pending.intent), targetId);
    assert.throws(
      () => store.freeze({ version: 2, accountId, intent: replyIntent() }),
      { kind: 'storage' },
    );
    assert.throws(
      () => store.freeze({ version: 2, accountId, intent: intent() }),
      { kind: 'storage' },
    );
    assert.equal(store.load(otherId), null);
    assert.equal(
      new PendingRatingStore(storage, 'other').load(accountId),
      null,
    );
    assert.doesNotMatch(
      JSON.stringify(pending.intent),
      /recipient|accountId|profileId|personaId|displayName|points|count/,
    );
    store.settle(pending, likeReceipt(likeIntent(operation)));
    assert.equal(store.load(accountId), null);
    storage.set(`whaleu.ratings.pending.v1:origin:${accountId}`, {
      ...pending,
      version: 1,
    });
    assert.throws(() => store.load(accountId), { kind: 'storage' });
  }
});

test('R2B mixed v1 and v2 preserve both byte shapes and recover legacy then like without overwriting', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const legacy: PendingRating = { version: 1, accountId, intent: intent() },
    fresh: PendingRating = { version: 2, accountId, intent: likeIntent() };
  const key1 = `whaleu.ratings.pending.v1:origin:${accountId}`,
    key2 = `whaleu.ratings.pending.v2:origin:${accountId}`;
  storage.set(key1, legacy);
  storage.set(key2, fresh);
  const bytes = JSON.stringify([...storage.data]);
  assert.deepEqual(store.load(accountId), legacy);
  assert.throws(() => store.freeze(fresh), { kind: 'storage' });
  assert.throws(() => store.settle(fresh, likeReceipt()), { kind: 'storage' });
  assert.equal(JSON.stringify([...storage.data]), bytes);
  store.settle(legacy, receipt(legacy.intent));
  assert.deepEqual(store.load(accountId), fresh);
  store.settle(fresh, likeReceipt());
  assert.equal(storage.data.size, 0);
});

test('R2B wrong operation, subject, request or desired receipt never releases the original like slot', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const pending = store.freeze({
    version: 2,
    accountId,
    intent: likeIntent('set_reply_like'),
  });
  for (const raw of [
    receipt(),
    replyReceipt(),
    likeReceipt(),
    ...[
      { requestId: otherId },
      { rootId: otherId },
      { replyId: otherId },
      { liked: false },
      { count: 1 },
    ].map((p) => ({ ...likeReceipt(likeIntent('set_reply_like')), ...p })),
  ]) {
    assert.throws(() => store.settle(pending, raw));
    assert.deepEqual(store.load(accountId), pending);
  }
});

test('R2B corrupt storage and write/read-back/removal failures fail closed without replacing the command', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const pending: PendingRating = {
    version: 2,
    accountId,
    intent: likeIntent(),
  };
  storage.failWrite = true;
  assert.throws(() => store.freeze(pending), { kind: 'storage' });
  assert.equal(storage.data.size, 0);
  storage.failWrite = false;
  const frozen = store.freeze(pending);
  storage.failRemove = true;
  assert.throws(() => store.settle(frozen, likeReceipt()), { kind: 'storage' });
  assert.deepEqual(store.load(accountId), frozen);
  storage.failRemove = false;
  const key = `whaleu.ratings.pending.v2:origin:${accountId}`;
  for (const broken of [
    { ...pending, version: 3 },
    { ...pending, accountId: otherId },
    {
      ...pending,
      intent: {
        ...likeIntent(),
        payload: { ...likeIntent().payload, actorId: otherId },
      },
    },
    { broken: true },
  ]) {
    storage.set(key, broken);
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(pending), { kind: 'storage' });
    assert.equal(storage.get(key), broken);
  }
  const silent = new PendingRatingStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'origin',
  );
  assert.throws(() => silent.freeze(pending), { kind: 'storage' });
});
