import { Cancellation } from '../src/platform/contracts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  PostLikeMutationController,
  type PostLikeMutationView,
} from '../src/community/post-like-controller';
import { PendingPostLikeStore } from '../src/community/post-like-pending';
import type {
  PostLikeIntent,
  PostLikeReceipt,
} from '../src/community/post-like-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { otherId, post, postId, requestId, setup } from './community-helpers';
const target = (liked = false) =>
  post({
    likeCount: liked ? 1 : 0,
    viewer: { ...post().viewer, isLiked: liked, canComment: false },
  });
const receipt = (intent: PostLikeIntent): PostLikeReceipt => ({
  ...intent,
  outcome: 'applied',
});
const original: PostLikeIntent = {
  requestId,
  operation: 'set_post_like',
  postId,
  liked: true,
};
function harness(loggedIn = true) {
  const s = setup(loggedIn),
    runtime = { ...s.runtime },
    views: PostLikeMutationView[] = [];
  let settled = 0;
  const controller = new PostLikeMutationController(
    runtime,
    (v) => views.push(v),
    () => settled++,
  );
  return {
    ...s,
    runtime,
    controller,
    view: () => views[views.length - 1]!,
    settled: () => settled,
  };
}
test('freeze/readback precedes dispatch; repeated/opposite taps cannot replace in-flight intent; receipt requests fresh state', async () => {
  const s = harness(),
    gate = deferred<PostLikeReceipt>();
  s.gateway.likeImpl = async (intent) => {
    assert.deepEqual(s.runtime.pendingPostLikes.load(s.accountId), {
      version: 1,
      accountId: s.accountId,
      ...intent,
    });
    return gate.promise;
  };
  const running = s.controller.setLiked(target(), true);
  await flush();
  await s.controller.setLiked(target(), true);
  await s.controller.setLiked(target(true), false);
  await s.controller.setLiked(post({ id: otherId }), true);
  assert.equal(s.gateway.calls.filter((c) => c.method === 'like').length, 1);
  assert.equal(s.view().frozen, true);
  gate.resolve(receipt(original));
  await running;
  assert.equal(s.runtime.pendingPostLikes.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  assert.equal(s.settled(), 1);
  assert.equal('liked' in s.view(), false);
  assert.equal('likeCount' in s.view(), false);
});
test('no-op, malformed intent and guest cannot send; publication/author-self restrictions do not block phone-only like request', async () => {
  const s = harness();
  await s.controller.setLiked(target(), false);
  await s.controller.setLiked(target(), 'true' as unknown as boolean);
  assert.equal(s.gateway.calls.length, 0);
  await s.controller.setLiked(target(), true);
  assert.equal(s.gateway.calls[0]?.method, 'like');
  const guest = harness(false);
  guest.controller.load();
  await guest.controller.setLiked(target(), true);
  assert.equal(guest.gateway.calls.length, 0);
});
test('response loss, restart, missing receipt, conflict and unavailable content retain the original recoverable intent', async () => {
  const s = harness();
  s.gateway.likeImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.setLiked(target(), true);
  const pending = s.runtime.pendingPostLikes.load(s.accountId)!;
  s.controller.dispose();
  let settled = 0;
  const views: PostLikeMutationView[] = [];
  const runtime = {
    ...s.runtime,
    pendingPostLikes: new PendingPostLikeStore(s.storage, 'synthetic'),
  };
  const reopened = new PostLikeMutationController(
    runtime,
    (v) => views.push(v),
    () => settled++,
  );
  reopened.load();
  assert.equal(views[views.length - 1]!.frozen, true);
  assert.equal(
    s.gateway.calls.length,
    1,
    'Restoring recovery cannot need content/phone/review reads',
  );
  for (const code of [
    'REQUEST_NOT_FOUND',
    'REQUEST_CONFLICT',
    'COMMUNITY_UNAVAILABLE',
  ]) {
    s.gateway.postLikeReceiptImpl = async () => {
      throw new ClientError('http', 'safe', {
        serverCode: code,
        httpStatus:
          code === 'REQUEST_NOT_FOUND'
            ? 404
            : code === 'REQUEST_CONFLICT'
              ? 409
              : 503,
      });
    };
    await reopened.recover();
    await reopened.setLiked(target(true), false);
    assert.deepEqual(runtime.pendingPostLikes.load(s.accountId), pending);
    assert.equal(views[views.length - 1]!.frozen, true);
  }
  const retried: PostLikeIntent[] = [];
  s.gateway.likeImpl = async (intent) => {
    retried.push(intent);
    return receipt(intent);
  };
  await reopened.recover(true);
  assert.deepEqual(retried, [original]);
  assert.equal(runtime.pendingPostLikes.load(s.accountId), null);
  assert.equal(settled, 1);
});
test('loss then independent unlike then exact replay never resurrects; genuine re-like requires a fresh request ID', async () => {
  const s = harness(),
    ledger = new Map<string, PostLikeReceipt>();
  let live = false,
    lose = true,
    effects = 0;
  s.gateway.likeImpl = async (intent) => {
    const old = ledger.get(intent.requestId);
    if (old) return old;
    live = intent.liked;
    effects++;
    const result = receipt(intent);
    ledger.set(intent.requestId, result);
    if (lose) {
      lose = false;
      throw new ClientError('network', 'lost committed response');
    }
    return result;
  };
  await s.controller.setLiked(target(), true);
  assert.equal(live, true);
  await s.gateway.like(
    { ...original, requestId: otherId, liked: false },
    new Cancellation(),
  );
  assert.equal(live, false);
  await s.controller.recover(true);
  assert.equal(live, false);
  assert.equal(effects, 2);
  assert.equal(s.settled(), 1);
  const next = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  s.runtime.newRequestId = async () => next;
  await s.controller.setLiked(target(), true);
  assert.equal(live, true);
  assert.equal(effects, 3);
  assert.ok(ledger.has(next));
  assert.equal(s.runtime.pendingPostLikes.load(s.accountId), null);
});
test('mismatched or malformed terminal receipts never clear journal; exact rejected receipt does', async () => {
  const s = harness();
  s.gateway.likeImpl = async () => {
    throw new ClientError('network', 'safe');
  };
  await s.controller.setLiked(target(), true);
  const frozen = s.runtime.pendingPostLikes.load(s.accountId);
  for (const patch of [
    { requestId: otherId },
    { postId: otherId },
    { liked: false },
    { operation: 'set_comment_like' },
    { likeCount: 1 },
    { code: 'COMMUNITY_UNAVAILABLE' },
  ]) {
    s.gateway.postLikeReceiptImpl = async () =>
      ({
        ...original,
        outcome: 'rejected',
        code: 'POST_NOT_FOUND',
        ...patch,
      }) as PostLikeReceipt;
    await s.controller.recover();
    assert.equal(s.view().frozen, true);
    assert.deepEqual(s.runtime.pendingPostLikes.load(s.accountId), frozen);
  }
  s.gateway.postLikeReceiptImpl = async () => ({
    ...original,
    outcome: 'rejected',
    code: 'POST_NOT_FOUND',
  });
  await s.controller.recover();
  assert.equal(s.runtime.pendingPostLikes.load(s.accountId), null);
  assert.equal(s.settled(), 1);
  assert.match(s.view().receiptStatus, /不存在|不可查看/);
});
for (const boundary of [
  'cancel',
  'hide',
  'root-hide',
  'same-account',
  'different-account',
] as const) {
  test(`${boundary} before secure ID persistence prevents dispatch and late write`, async () => {
    const s = harness(),
      id = deferred<string>();
    s.runtime.newRequestId = () => id.promise;
    const running = s.controller.setLiked(target(), true);
    await flush();
    if (boundary === 'cancel') s.controller.cancel();
    else if (boundary === 'hide') s.controller.dispose();
    else if (boundary === 'root-hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(boundary === 'different-account' ? { accountId: otherId } : {}),
      });
    id.resolve(requestId);
    await running;
    await flush();
    assert.equal(s.runtime.pendingPostLikes.load(s.accountId), null);
    assert.equal(s.gateway.calls.length, 0);
  });
  test(`${boundary} after dispatch preserves original journal and suppresses late receipt/reload`, async () => {
    const s = harness(),
      gate = deferred<PostLikeReceipt>();
    s.gateway.likeImpl = () => gate.promise;
    const running = s.controller.setLiked(target(), true);
    await flush();
    const a = s.runtime.pendingPostLikes.load(s.accountId);
    if (boundary === 'cancel') s.controller.cancel();
    else if (boundary === 'hide') s.controller.dispose();
    else if (boundary === 'root-hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        ...(boundary === 'different-account' ? { accountId: otherId } : {}),
      });
    gate.resolve(receipt(original));
    await running;
    await flush();
    assert.deepEqual(s.runtime.pendingPostLikes.load(s.accountId), a);
    assert.equal(s.settled(), 0);
    if (boundary !== 'cancel') assert.equal(s.view().recoveryPostId, '');
    if (boundary === 'different-account') {
      s.controller.load();
      assert.equal(s.view().frozen, false);
      assert.equal(s.view().recoveryPostId, '');
    }
  });
}
test('storage fail/readback failure never sends; failed removal keeps recovery frozen', async () => {
  const s = harness();
  s.storage.failWrite = true;
  await s.controller.setLiked(target(), true);
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(s.runtime.pendingPostLikes.load(s.accountId), null);
  s.storage.failWrite = false;
  s.controller.load();
  s.storage.failRemove = true;
  await s.controller.setLiked(target(), true);
  assert.equal(s.view().frozen, true);
  assert.ok(s.runtime.pendingPostLikes.load(s.accountId));
  assert.equal(s.settled(), 0);
  s.storage.failRemove = false;
  await s.controller.recover();
  assert.equal(s.settled(), 1);
  const dishonest = harness();
  dishonest.runtime.pendingPostLikes = new PendingPostLikeStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'synthetic',
  );
  await dishonest.controller.setLiked(target(), true);
  assert.equal(dishonest.gateway.calls.length, 0);
});
test('late old-token 401 cannot erase refreshed credentials; blocked/revoked active auth clears page but retains journal', async () => {
  const s = harness(),
    gate = deferred<PostLikeReceipt>();
  s.gateway.likeImpl = () => gate.promise;
  const running = s.controller.setLiked(target(), true);
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  gate.reject(
    new ClientError('auth-required', 'safe', {
      httpStatus: 401,
      serverCode: 'SESSION_REVOKED',
    }),
  );
  await running;
  assert.equal(
    s.sessions.snapshot().credentials?.accessToken,
    wireCredentials('b').accessToken,
  );
  assert.ok(s.runtime.pendingPostLikes.load(s.accountId));
  for (const code of ['SESSION_REVOKED', 'ACCOUNT_BLOCKED'] as const) {
    const h = harness();
    h.gateway.likeImpl = async () => {
      throw new ClientError(
        code === 'SESSION_REVOKED' ? 'auth-required' : 'forbidden',
        'safe',
        {
          httpStatus: code === 'SESSION_REVOKED' ? 401 : 403,
          serverCode: code,
        },
      );
    };
    await h.controller.setLiked(target(), true);
    assert.equal(h.sessions.snapshot().credentials, null);
    assert.equal(h.view().recoveryPostId, '');
    assert.ok(h.runtime.pendingPostLikes.load(h.accountId));
  }
});
