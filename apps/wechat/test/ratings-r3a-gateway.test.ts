import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingDeletionGateway } from '../src/ratings/deletion-gateway';
import type { RatingAdminDeletionIntent } from '../src/ratings/deletion-contract';
import { PendingRatingStore, type PendingRating } from '../src/ratings/pending';
import { runRatingCommand } from '../src/ratings/commands';
import { MemoryStorage, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  targetId,
  otherId,
  requestId,
  intent,
  receipt,
} from './ratings-helpers';
import { replyId, replyIntent, replyReceipt } from './ratings-r2a-helpers';
import { likeIntent, likeReceipt } from './ratings-r2b-helpers';
import { subscriptionIntent, subscriptionReceipt } from './ratings-r2c-helpers';
import {
  adminContext,
  adminIntent,
  adminReceipt,
  deletionContext,
  locator,
  changed,
  missing,
  r3aHarness,
} from './ratings-r3a-helpers';
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
  return { sessions, transport, gateway: new HttpRatingDeletionGateway(api) };
}
test('R3A exact authenticated owner/admin context, typed DELETE and own-receipt routes send no authority/region override', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const reply of [false, true]) {
    s.transport.reply(deletionContext(reply));
    await s.gateway.context('owner', locator(reply), cancel);
    s.transport.reply(adminContext(reply));
    await s.gateway.context('admin', locator(reply), cancel);
    s.transport.reply(adminReceipt(adminIntent(reply)));
    await s.gateway.command(adminIntent(reply), cancel);
  }
  s.transport.reply(adminReceipt());
  await s.gateway.receipt(requestId, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `/v1/ratings/comments/${commentId}/deletion-context`],
      ['GET', `/v1/ratings/admin/comments/${commentId}/deletion-context`],
      ['DELETE', `/v1/ratings/admin/comments/${commentId}`],
      ['GET', `/v1/ratings/replies/${replyId}/deletion-context`],
      ['GET', `/v1/ratings/admin/replies/${replyId}/deletion-context`],
      ['DELETE', `/v1/ratings/admin/replies/${replyId}`],
      ['GET', `/v1/ratings/admin/requests/${requestId}`],
    ],
  );
  assert.deepEqual(s.transport.requests[2]!.body, adminIntent().payload);
  assert.deepEqual(s.transport.requests[5]!.body, adminIntent(true).payload);
  for (const request of s.transport.requests) {
    assert.equal(new URL(request.url).search, '');
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
  }
});
test('R3A bad locator/auth/command dispatch nothing; cross-subject minimal reads/receipts fail closed', async () => {
  const s = setup(false),
    c = new Cancellation();
  for (const run of [
    () => s.gateway.context('admin', locator(), c),
    () => s.gateway.command(adminIntent(), c),
    () => s.gateway.receipt(requestId, c),
  ])
    await assert.rejects(run, { kind: 'auth-required' });
  assert.equal(s.transport.requests.length, 0);
  const v = setup();
  await assert.rejects(() =>
    v.gateway.context(
      'admin',
      { ...locator(), subjectId: `${commentId}?actor=${otherId}` },
      c,
    ),
  );
  await assert.rejects(() =>
    v.gateway.command(
      {
        ...adminIntent(),
        payload: { ...adminIntent().payload, regionId: otherId },
      } as unknown as RatingAdminDeletionIntent,
      c,
    ),
  );
  await assert.rejects(() => v.gateway.receipt('bad', c));
  assert.equal(v.transport.requests.length, 0);
  v.transport.reply(adminContext(false, { targetId: otherId }));
  await assert.rejects(() => v.gateway.context('admin', locator(), c), {
    kind: 'protocol',
  });
  v.transport.reply({ ...adminReceipt(), subjectId: otherId, rootId: otherId });
  await assert.rejects(() => v.gateway.command(adminIntent(), c), {
    kind: 'protocol',
  });
  v.transport.reply({ ...adminReceipt(), requestId: otherId });
  await assert.rejects(() => v.gateway.receipt(requestId, c), {
    kind: 'protocol',
  });
});
test('R3A shared v4 journal preserves each v1/v2/v3 original and blocks cross-operation replacement in both directions', () => {
  const old: Array<
    [
      PendingRating,
      (
        | ReturnType<typeof receipt>
        | ReturnType<typeof replyReceipt>
        | ReturnType<typeof likeReceipt>
        | ReturnType<typeof subscriptionReceipt>
      ),
    ]
  > = [
    [
      { version: 1, accountId, intent: intent('delete_comment') },
      receipt(intent('delete_comment')),
    ],
    [
      { version: 2, accountId, intent: replyIntent('delete_reply') },
      replyReceipt(replyIntent('delete_reply')),
    ],
    [{ version: 2, accountId, intent: likeIntent() }, likeReceipt()],
    [
      { version: 3, accountId, intent: subscriptionIntent() },
      subscriptionReceipt(),
    ],
  ];
  for (const [raw, result] of old) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    const original = store.freeze(raw),
      bytes = JSON.stringify(
        storage.get(
          `whaleu.ratings.pending.v${raw.version}:origin:${accountId}`,
        ),
      );
    assert.throws(
      () => store.freeze({ version: 4, accountId, intent: adminIntent() }),
      { kind: 'storage' },
    );
    assert.equal(
      JSON.stringify(
        storage.get(
          `whaleu.ratings.pending.v${raw.version}:origin:${accountId}`,
        ),
      ),
      bytes,
    );
    store.settle(original, result);
    const admin = store.freeze({
      version: 4,
      accountId,
      intent: adminIntent(),
    });
    assert.throws(() => store.freeze(raw), { kind: 'storage' });
    assert.equal(
      new PendingRatingStore(storage, 'another-origin').load(accountId),
      null,
    );
    assert.equal(store.load(otherId), null);
    assert.throws(() => store.settle(admin, result));
    assert.throws(() =>
      store.settle(admin, { ...adminReceipt(), targetId: otherId }),
    );
    assert.deepEqual(store.load(accountId), admin);
    store.settle(admin, adminReceipt());
    assert.equal(store.load(accountId), null);
  }
});
test('R3A corrupted or owner-shaped v4 blocks every new command; old versions never decode admin', () => {
  for (const version of [1, 2, 3, 4]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    storage.set(`whaleu.ratings.pending.v${version}:origin:${accountId}`, {
      version,
      accountId,
      intent: version === 4 ? intent() : adminIntent(),
    });
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(
      () => store.freeze({ version: 4, accountId, intent: adminIntent() }),
      { kind: 'storage' },
    );
  }
});
test('R3A only replay-first explicit DELETE409 context rollback releases v4; GET missing, network and other errors keep original', async () => {
  for (const error of [
    missing(),
    changed(),
    new ClientError('timeout', 'lost'),
    new ClientError('http', 'unavailable', {
      httpStatus: 503,
      serverCode: 'RATING_UNAVAILABLE',
    }),
  ]) {
    const s = r3aHarness(),
      attempt = s.pendingRatings.freeze({
        version: 4,
        accountId,
        intent: adminIntent(),
      });
    s.ratingDeletion.receiptImpl = async () => {
      throw error;
    };
    await assert.rejects(() =>
      runRatingCommand(s.runtime, attempt, new Cancellation(), false),
    );
    assert.deepEqual(s.pendingRatings.load(accountId), attempt);
    s.ratingDeletion.commandImpl = async () => {
      throw error;
    };
    await assert.rejects(() =>
      runRatingCommand(s.runtime, attempt, new Cancellation(), true),
    );
    assert.equal(
      s.pendingRatings.load(accountId) === null,
      error.details.serverCode === 'RATING_DELETION_CONTEXT_CHANGED',
    );
  }
});
test('R3A admin history receipt recovery routes independently with no context/role/body reads', async () => {
  const s = r3aHarness(),
    attempt = s.pendingRatings.freeze({
      version: 4,
      accountId,
      intent: adminIntent(true),
    });
  s.ratingDeletion.receiptImpl = async () => adminReceipt(adminIntent(true));
  const result = await runRatingCommand(
    s.runtime,
    attempt,
    new Cancellation(),
    false,
  );
  assert.equal(result.operation, 'admin_delete_reply');
  assert.deepEqual(
    s.ratingDeletion.calls.map((c) => c.method),
    ['receipt'],
  );
  assert.equal(s.ratings.calls.length, 0);
  assert.equal(s.ratingDiscussion.calls.length, 0);
  assert.equal(targetId, adminIntent().payload.targetId);
});

test('R3A actual HTTP code/status pairing recognizes only explicit 409 context rollback', async () => {
  for (const status of [200, 403, 409, 503]) {
    const s = setup();
    s.transport.reply(
      {
        error: {
          code: 'RATING_DELETION_CONTEXT_CHANGED',
          message: 'synthetic',
          requestId,
        },
      },
      status,
    );
    await assert.rejects(
      () => s.gateway.command(adminIntent(), new Cancellation()),
      (error: unknown) => {
        assert.ok(error instanceof ClientError);
        assert.equal(error.kind, status === 409 ? 'business' : 'protocol');
        return true;
      },
    );
  }
});
