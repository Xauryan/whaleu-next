import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import type { RatingReplyIntent } from '../src/ratings/discussion-contract';
import { HttpRatingDiscussionGateway } from '../src/ratings/discussion-gateway';
import { HttpRatingUpdatesGateway } from '../src/ratings/updates-gateway';
import { PendingRatingStore, type PendingRating } from '../src/ratings/pending';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  cursor,
  intent,
  otherId,
  receipt,
  regionId,
  requestId,
} from './ratings-helpers';
import {
  discussion,
  noticeId,
  noticeTarget,
  position,
  readReceipt,
  reply,
  replyId,
  replyIntent,
  replyPage,
  replyReceipt,
  updates,
} from './ratings-r2a-helpers';
const accountId = wireCredentials().accountId;
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
    discussion: new HttpRatingDiscussionGateway(api),
    updates: new HttpRatingUpdatesGateway(api),
  };
}
test('all eleven R2A routes use authenticated exact HTTP methods/body with explicit nullable scope', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(discussion());
  await s.discussion.discussion(null, commentId, cancel);
  s.transport.reply(replyPage());
  await s.discussion.replies(null, commentId, null, cancel);
  s.transport.reply(reply());
  await s.discussion.reply(regionId, replyId, cancel);
  s.transport.reply(position());
  await s.discussion.position(null, replyId, cancel, 50);
  for (const operation of ['create_reply', 'delete_reply'] as const) {
    const command = replyIntent(operation);
    s.transport.reply(replyReceipt(command));
    await s.discussion.command(command, cancel);
  }
  s.transport.reply(replyReceipt());
  await s.discussion.receipt(requestId, cancel);
  s.transport.reply(updates());
  await s.updates.list(null, cancel);
  s.transport.reply({ unreadCount: 1 });
  await s.updates.unread(cancel);
  s.transport.reply(noticeTarget());
  await s.updates.target(noticeId, cancel);
  s.transport.reply(readReceipt());
  await s.updates.markRead(noticeId, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `/v1/ratings/comments/${commentId}/discussion`],
      ['GET', `/v1/ratings/comments/${commentId}/replies`],
      ['GET', `/v1/ratings/replies/${replyId}`],
      ['GET', `/v1/ratings/replies/${replyId}/position`],
      ['POST', `/v1/ratings/comments/${commentId}/replies`],
      ['DELETE', `/v1/ratings/replies/${replyId}`],
      ['GET', `/v1/ratings/reply-requests/${requestId}`],
      ['GET', '/v1/me/ratings/updates'],
      ['GET', '/v1/me/ratings/updates/unread-count'],
      ['GET', `/v1/me/ratings/updates/${noticeId}/target`],
      ['PUT', `/v1/me/ratings/updates/${noticeId}/read`],
    ],
  );
  assert.equal(new URL(s.transport.requests[0]!.url).search, '');
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[2]!.url).searchParams),
    { regionId },
  );
  assert.deepEqual(
    Object.fromEntries(new URL(s.transport.requests[3]!.url).searchParams),
    { limit: '50' },
  );
  assert.deepEqual(s.transport.requests[4]!.body, replyIntent().payload);
  assert.deepEqual(s.transport.requests[10]!.body, {});
  for (const request of s.transport.requests)
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
});
test('every R2A gateway read/write fails before dispatch without authentication', async () => {
  const s = setup(false),
    c = new Cancellation();
  for (const call of [
    () => s.discussion.discussion(null, commentId, c),
    () => s.discussion.replies(null, commentId, null, c),
    () => s.discussion.reply(null, replyId, c),
    () => s.discussion.position(null, replyId, c),
    () => s.discussion.command(replyIntent(), c),
    () => s.discussion.command(replyIntent('delete_reply'), c),
    () => s.discussion.receipt(requestId, c),
    () => s.updates.list(null, c),
    () => s.updates.unread(c),
    () => s.updates.target(noticeId, c),
    () => s.updates.markRead(noticeId, c),
  ])
    await assert.rejects(call, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
});
test('R2A gateways reject untrusted route inputs, cursor/limit injection and unsolicited recipient before dispatch', async () => {
  const s = setup(),
    c = new Cancellation();
  for (const id of ['bad', `${replyId}?recipient=${otherId}`])
    for (const call of [
      () => s.discussion.discussion(null, id, c),
      () => s.discussion.discussion(id, commentId, c),
      () => s.discussion.replies(null, id, null, c),
      () => s.discussion.reply(null, id, c),
      () => s.discussion.position(null, id, c),
      () => s.discussion.receipt(id, c),
      () => s.updates.target(id, c),
      () => s.updates.markRead(id, c),
    ])
      await assert.rejects(async () => call());
  for (const limit of [0, 51, 1.5, NaN])
    for (const call of [
      () => s.discussion.replies(null, commentId, null, c, limit),
      () => s.discussion.position(null, replyId, c, limit),
      () => s.updates.list(null, c, limit),
    ])
      await assert.rejects(async () => call());
  await assert.rejects(async () => s.updates.list(null, c, 21));
  await assert.rejects(async () =>
    s.discussion.replies(null, commentId, 'bad', c),
  );
  await assert.rejects(async () =>
    s.discussion.command(
      {
        ...replyIntent(),
        payload: { ...replyIntent().payload, recipient: otherId },
      } as unknown as RatingReplyIntent,
      c,
    ),
  );
  assert.equal(s.transport.requests.length, 0);
});
test('gateway binds current locator, strict page limit, forward cursor and exact receipt request ancestry', async () => {
  const s = setup(),
    c = new Cancellation();
  for (const raw of [
    discussion({ context: { ...discussion().context, regionId } }),
    discussion({
      context: { ...discussion().context, rootId: otherId },
      root: { ...discussion().root, id: otherId },
    }),
  ]) {
    s.transport.reply(raw);
    await assert.rejects(s.discussion.discussion(null, commentId, c), {
      kind: 'protocol',
    });
  }
  s.transport.reply(
    replyPage({ nextCursor: cursor, continuation: 'scan', items: [] }),
  );
  await assert.rejects(s.discussion.replies(null, commentId, cursor, c), {
    kind: 'protocol',
  });
  s.transport.reply(replyPage({ items: [reply(), reply({ id: otherId })] }));
  await assert.rejects(s.discussion.replies(null, commentId, null, c, 1), {
    kind: 'protocol',
  });
  s.transport.reply(reply({ id: otherId }));
  await assert.rejects(s.discussion.reply(null, replyId, c), {
    kind: 'protocol',
  });
  s.transport.reply(
    position({
      context: { ...position().context, regionId },
      page: replyPage({ context: { ...replyPage().context, regionId } }),
    }),
  );
  await assert.rejects(s.discussion.position(null, replyId, c), {
    kind: 'protocol',
  });
  for (const patch of [
    { requestId: otherId },
    { targetId: otherId },
    { rootId: otherId },
    { operation: 'delete_reply' as const },
  ]) {
    s.transport.reply(replyReceipt(replyIntent(), patch));
    await assert.rejects(s.discussion.command(replyIntent(), c), {
      kind: 'protocol',
    });
  }
  s.transport.reply(replyReceipt(replyIntent(), { requestId: otherId }));
  await assert.rejects(s.discussion.receipt(requestId, c), {
    kind: 'protocol',
  });
  s.transport.reply({ ...noticeTarget(), noticeId: otherId });
  await assert.rejects(s.updates.target(noticeId, c), { kind: 'protocol' });
  s.transport.reply(readReceipt({ noticeId: otherId }));
  await assert.rejects(s.updates.markRead(noticeId, c), { kind: 'protocol' });
});
test('reply authentication replay preserves exact frozen canonical body/key despite mutable caller', async () => {
  const s = setup(),
    c = new Cancellation(),
    original = replyIntent();
  if (original.operation !== 'create_reply') throw new Error('fixture');
  const raw = {
    ...original,
    payload: { ...original.payload, body: ` \r\n${original.payload.body} ` },
  };
  s.transport.steps.push(async () => {
    raw.payload.body = 'different';
    raw.rootId = otherId;
    raw.payload.clientRequestId = otherId;
    return {
      status: 401,
      headers: {},
      body: { error: { code: 'ACCESS_TOKEN_EXPIRED' } },
    };
  });
  s.transport.reply(replyReceipt(original));
  await s.discussion.command(raw, c);
  assert.deepEqual(s.transport.requests[0]!.body, original.payload);
  assert.deepEqual(s.transport.requests[1]!.body, original.payload);
  assert.equal(s.transport.requests[0]!.url, s.transport.requests[1]!.url);
});
for (const code of [
  'RATING_NOT_FOUND',
  'REQUEST_NOT_FOUND',
  'RATING_UNAVAILABLE',
  'CONTENT_REVIEW_UNAVAILABLE',
  'NOTICE_NOT_FOUND',
])
  test(`R2A ${code} stays error/unknown and is never converted to empty/success`, async () => {
    const s = setup(),
      c = new Cancellation(),
      status = code.endsWith('NOT_FOUND') ? 404 : 503;
    s.transport.reply({ error: { code } }, status);
    await assert.rejects(
      s.discussion.receipt(requestId, c),
      (error) =>
        error instanceof ClientError && error.details.serverCode === code,
    );
    assert.equal(s.transport.requests.length, 1);
  });
test('v1 byte identity remains immutable; v2 uses another key and two existing keys settle v1 before v2', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const legacy: PendingRating = {
      version: 1,
      accountId,
      intent: intent('create_comment'),
    },
    fresh: PendingRating = { version: 2, accountId, intent: replyIntent() };
  const key1 = `whaleu.ratings.pending.v1:origin:${accountId}`,
    key2 = `whaleu.ratings.pending.v2:origin:${accountId}`;
  storage.set(key1, legacy);
  storage.set(key2, fresh);
  const legacyBytes = JSON.stringify(storage.get(key1));
  assert.deepEqual(store.load(accountId), legacy);
  assert.equal(JSON.stringify(storage.get(key1)), legacyBytes);
  assert.throws(() => store.freeze(fresh), { kind: 'storage' });
  assert.throws(() => store.settle(fresh, replyReceipt()), { kind: 'storage' });
  store.settle(legacy, receipt(legacy.intent));
  assert.equal(storage.get(key1), undefined);
  assert.deepEqual(storage.get(key2), fresh);
  assert.deepEqual(store.load(accountId), fresh);
  store.settle(fresh, replyReceipt());
  assert.equal(store.load(accountId), null);
});
test('pending v2 isolates account/origin, validates canonical bytes and never drops corrupt or mismatched uncertain data', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const original = store.freeze({
      version: 2,
      accountId,
      intent: replyIntent(),
    }),
    key = [...storage.data.keys()][0]!;
  assert.ok(key.includes('.v2:'));
  assert.equal(store.load(otherId), null);
  assert.equal(new PendingRatingStore(storage, 'other').load(accountId), null);
  for (const raw of [
    { ...replyReceipt(), rootId: otherId },
    { ...replyReceipt(), replyId: 'bad' },
    { ...replyReceipt(), outcome: 'noop' },
    { ...replyReceipt(), body: 'hidden' },
  ]) {
    assert.throws(() =>
      store.settle(original, raw as ReturnType<typeof replyReceipt>),
    );
    assert.deepEqual(store.load(accountId), original);
  }
  for (const corrupted of [
    { ...original, version: 3 },
    { ...original, accountId: otherId },
    {
      ...original,
      intent: {
        ...replyIntent(),
        payload: { ...replyIntent().payload, body: ' leading' },
      },
    },
  ]) {
    storage.set(key, corrupted);
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(original), { kind: 'storage' });
    assert.equal(storage.get(key), corrupted);
  }
});
test('legacy recovery may finish with corrupt v2 preserved; no replacement can dispatch', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin'),
    legacy: PendingRating = { version: 1, accountId, intent: intent() };
  const key1 = `whaleu.ratings.pending.v1:origin:${accountId}`,
    key2 = `whaleu.ratings.pending.v2:origin:${accountId}`;
  storage.set(key1, legacy);
  storage.set(key2, { broken: true });
  assert.deepEqual(store.load(accountId), legacy);
  store.settle(legacy, receipt());
  assert.deepEqual(storage.get(key2), { broken: true });
  assert.throws(() => store.load(accountId), { kind: 'storage' });
  assert.throws(
    () => store.freeze({ version: 2, accountId, intent: replyIntent() }),
    { kind: 'storage' },
  );
});
test('v2 fail-read/write/read-back/remove never replaces a request or exposes author/recipient snapshot', () => {
  const original = { version: 2 as const, accountId, intent: replyIntent() },
    storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  storage.failWrite = true;
  assert.throws(() => store.freeze(original), { kind: 'storage' });
  assert.equal(storage.data.size, 0);
  storage.failWrite = false;
  const frozen = store.freeze(original);
  storage.failRemove = true;
  assert.throws(() => store.settle(frozen, replyReceipt()), {
    kind: 'storage',
  });
  assert.deepEqual(store.load(accountId), frozen);
  assert.doesNotMatch(
    JSON.stringify(frozen.intent),
    /recipient|profileId|personaId|original_user_id/,
  );
  const silent = new PendingRatingStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'origin',
  );
  assert.throws(() => silent.freeze(original), { kind: 'storage' });
});
test('late same-account login/account switch and cancellation fence R2A transport data', async () => {
  for (const next of [accountId, otherId])
    for (const operation of [
      'reply',
      'receipt',
      'updates',
      'markRead',
    ] as const) {
      const s = setup(),
        c = new Cancellation();
      s.transport.steps.push(async () => {
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials(),
          accountId: next,
        });
        return {
          status: 200,
          headers: {},
          body:
            operation === 'reply'
              ? reply()
              : operation === 'receipt'
                ? replyReceipt()
                : operation === 'updates'
                  ? updates()
                  : readReceipt(),
        };
      });
      await assert.rejects(
        operation === 'reply'
          ? s.discussion.reply(null, replyId, c)
          : operation === 'receipt'
            ? s.discussion.receipt(requestId, c)
            : operation === 'updates'
              ? s.updates.list(null, c)
              : s.updates.markRead(noticeId, c),
        { kind: 'stale-session' },
      );
    }
  const s = setup(),
    c = new Cancellation();
  c.cancel();
  await assert.rejects(s.discussion.command(replyIntent(), c), {
    kind: 'cancelled',
  });
  assert.equal(s.transport.requests.length, 0);
});
