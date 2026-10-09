import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { Cancellation } from '../src/platform/contracts';
import { readRatingLikeStates } from '../src/ratings/like-controller';
import { runRatingCommand } from '../src/ratings/commands';
import type {
  RatingLikeReceipt,
  RatingLikeState,
} from '../src/ratings/like-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  commentPage,
  cursor,
  intent,
  otherId,
  receipt,
  requestId,
  targetId,
} from './ratings-helpers';
import {
  noticeId,
  readReceipt,
  replyId,
  replyIntent,
  replyReceipt,
  route,
} from './ratings-r2a-helpers';
import {
  FakeRatingLikesGateway,
  likeIntent,
  likeLocator,
  likeNotice,
  likeNoticeTarget,
  likeReceipt,
  likeRevision,
  likeState,
  likeUpdates,
  r2bHarness,
} from './ratings-r2b-helpers';

type Harness = ReturnType<typeof r2bHarness>;
const timeout = () =>
  new ClientError('timeout', 'Synthetic response lost after commit');
const unavailable = () =>
  new ClientError('http', 'Synthetic inaccessible', {
    httpStatus: 404,
    serverCode: 'RATING_NOT_FOUND',
  });
const root = { targetId, rootId: commentId, replyId: null };
function cleared(s: Harness): void {
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().discussion, null);
  assert.deepEqual(s.view().replies, []);
  assert.deepEqual(s.view().likes, {});
  assert.equal(s.view().text, '');
  assert.equal(s.view().anchorReplyId, '');
}

test('R2B current like reads have exactly one inflight and complete every row of the bounded visible batch', async () => {
  const gateway = new FakeRatingLikesGateway(),
    c = new Cancellation(),
    release = deferred<void>();
  let active = 0,
    peak = 0;
  const subjects = Array.from({ length: 51 }, (_, n) => ({
    ...root,
    rootId: `${String(n).padStart(8, '0')}-dddd-4ddd-8ddd-dddddddddddd`,
  }));
  gateway.stateImpl = async (_region, subject) => {
    active++;
    peak = Math.max(peak, active);
    await release.promise;
    active--;
    return likeState(subject);
  };
  const run = readRatingLikeStates(gateway, null, subjects, c);
  await flush();
  assert.equal(gateway.calls.length, 1);
  assert.equal(peak, 1);
  release.resolve();
  const result = await run;
  assert.equal(Object.keys(result).length, 51);
  assert.equal(gateway.calls.length, 51);
  assert.equal(peak, 1);
  await assert.rejects(
    readRatingLikeStates(gateway, null, [...subjects, root], c),
  );
  await assert.rejects(readRatingLikeStates(gateway, null, [root, root], c));
});

test('R2B independent unknown likes are never false/zero and malformed/cross-subject states fail closed', async () => {
  const c = new Cancellation(),
    gateway = new FakeRatingLikesGateway();
  assert.deepEqual(await readRatingLikeStates(undefined, null, [root], c), {
    [commentId]: { status: 'unavailable' },
  });
  gateway.stateImpl = async () => {
    throw unavailable();
  };
  assert.deepEqual(await readRatingLikeStates(gateway, null, [root], c), {
    [commentId]: { status: 'unavailable' },
  });
  gateway.stateImpl = async () => likeState({ rootId: otherId });
  await assert.rejects(readRatingLikeStates(gateway, null, [root], c), {
    kind: 'protocol',
  });
  gateway.stateImpl = async () => ({ ...likeState(), accountId: otherId });
  await assert.rejects(readRatingLikeStates(gateway, null, [root], c), {
    kind: 'protocol',
  });
});

test('R2B root/reply commands take exact content and membership CAS, then independently refresh current state', async () => {
  for (const id of [commentId, replyId]) {
    const s = r2bHarness();
    await s.controller.load(route);
    assert.equal(s.view().likes[id]?.status, 'known');
    s.ratingLikes.commandImpl = async (command) => {
      // Current state can already differ from this historical applied receipt.
      s.ratingLikes.stateImpl = async (_region, subject) =>
        likeState({ ...subject, count: 9, liked: false, revision: otherId });
      return likeReceipt(command);
    };
    await s.controller.toggleLike(id);
    assert.equal(s.ratingLikes.commands.length, 1);
    assert.deepEqual(
      s.ratingLikes.commands[0],
      likeIntent(id === commentId ? 'set_comment_like' : 'set_reply_like'),
    );
    assert.equal(s.storage.data.size, 0);
    assert.equal(s.view().loaded, true);
    assert.deepEqual(
      s.view().likes[id],
      likeState({
        ...(id === replyId ? { replyId } : {}),
        count: 9,
        liked: false,
        revision: otherId,
      }),
    );
    assert.doesNotMatch(s.view().receiptStatus, /经验.*到账|送达/);
  }
});

test('R2B current known membership drives unlike and off-page/unknown subjects cannot dispatch', async () => {
  const s = r2bHarness();
  s.ratingLikes.stateImpl = async (_region, subject) =>
    subject.replyId
      ? { status: 'unavailable' }
      : likeState({ ...subject, liked: true, count: 8 });
  await s.controller.load(route);
  await s.controller.toggleLike(replyId);
  await s.controller.toggleLike(otherId);
  assert.equal(s.ids.count, 0);
  await s.controller.toggleLike(commentId);
  assert.equal(s.ratingLikes.commands[0]?.payload.liked, false);
  assert.equal(
    s.ratingLikes.commands[0]?.payload.expectedLikeRevision,
    likeRevision,
  );
});

test('R2B root-detail uses current root state and explicit sorting resets cursor without changing wire DTOs', async () => {
  const s = r2bHarness();
  s.ratings.commentsImpl = async () =>
    commentPage({ nextCursor: cursor, continuation: 'more' });
  await s.detailController.load({ targetId });
  assert.equal(s.detailView().commentSort, 'time');
  assert.equal(s.detailView().commentOrder, 'desc');
  assert.equal(
    s.ratings.calls.find((c) => c.method === 'comments')?.args[5],
    undefined,
  );
  await s.detailController.selectSort('likes', 'asc');
  const calls = s.ratings.calls.filter((c) => c.method === 'comments');
  const call = calls[calls.length - 1]!;
  assert.equal(call.args[2], null);
  assert.deepEqual(call.args[5], { sort: 'likes', order: 'asc' });
  assert.equal(s.detailView().commentSort, 'likes');
  assert.equal(s.detailView().commentOrder, 'asc');
  await s.detailController.toggleLike(commentId);
  assert.deepEqual(s.ratingLikes.commands[0], likeIntent());
  assert.equal(s.detailView().loaded, true);
});

test('R2B duplicate click mints one request, journal precedes dispatch and UUID cancellation writes nothing', async () => {
  const s = r2bHarness(),
    id = deferred<string>();
  s.ids.next = () => id.promise;
  await s.controller.load(route);
  const running = s.controller.toggleLike(replyId);
  void s.controller.toggleLike(replyId);
  await flush();
  assert.equal(s.ids.count, 1);
  s.controller.dismiss();
  id.resolve(requestId);
  await running;
  assert.equal(s.storage.data.size, 0);
  assert.equal(s.ratingLikes.commands.length, 0);
  cleared(s);
  const p = r2bHarness();
  await p.controller.load(route);
  p.ratingLikes.commandImpl = async (command) => {
    assert.deepEqual(p.pendingRatings.load(p.accountId)?.intent, command);
    throw timeout();
  };
  await p.controller.toggleLike(commentId);
  void p.controller.toggleLike(commentId);
  assert.equal(p.ratingLikes.commands.length, 1);
  assert.equal(p.ids.count, 1);
  assert.equal(p.view().frozen, true);
  cleared(p);
});

test('R2B uncertain retry and receipt recovery retain exact desired CAS/key and do not recreate a re-like', async () => {
  const s = r2bHarness();
  await s.controller.load(route);
  s.ratingLikes.commandImpl = async () => {
    throw timeout();
  };
  await s.controller.toggleLike(replyId);
  const pending = s.pendingRatings.load(s.accountId)!;
  await s.controller.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), pending);
  assert.equal(s.ratingLikes.commands.length, 1);
  s.ratingLikes.commandImpl = async (command) =>
    likeReceipt(command, { liked: false });
  await s.controller.recover(true);
  assert.deepEqual(s.pendingRatings.load(s.accountId), pending);
  assert.deepEqual(s.ratingLikes.commands[1], pending.intent);
  s.ratingLikes.receiptImpl = async () =>
    likeReceipt(likeIntent('set_reply_like'));
  s.ratingLikes.stateImpl = async (_region, subject) =>
    likeState({ ...subject, liked: false, count: 0, revision: otherId });
  await s.controller.recover();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.ratingLikes.commands.length, 2);
  assert.equal(s.view().likes[replyId]?.status, 'known');
  assert.equal(
    (s.view().likes[replyId] as Extract<RatingLikeState, { status: 'known' }>)
      .liked,
    false,
  );
});

test('R2B one pending coordinator routes legacy, reply and likes to only their own recovery/command gateway', async () => {
  for (const command of [
    intent(),
    replyIntent(),
    likeIntent(),
    likeIntent('set_reply_like'),
  ]) {
    const s = r2bHarness(),
      pending = s.pendingRatings.freeze({
        version: 2,
        accountId: s.accountId,
        intent: command,
      });
    s.ratings.receiptImpl = async () => receipt();
    s.ratingDiscussion.receiptImpl = async () => replyReceipt();
    s.ratingLikes.receiptImpl = async () =>
      likeReceipt(
        command.operation === 'set_reply_like'
          ? likeIntent('set_reply_like')
          : likeIntent(),
      );
    await runRatingCommand(s.runtime, pending, new Cancellation(), false);
    await runRatingCommand(s.runtime, pending, new Cancellation(), true);
    const expected =
      command.operation.startsWith('set_') &&
      command.operation.endsWith('_like')
        ? s.ratingLikes
        : command.operation === 'create_reply'
          ? s.ratingDiscussion
          : s.ratings;
    assert.deepEqual(
      expected.calls.map((c) => c.method),
      ['receipt', 'command'],
    );
    assert.equal(
      s.ratings.commands.length +
        s.ratingDiscussion.commands.length +
        s.ratingLikes.commands.length,
      1,
    );
  }
});

test('R2B pending reply blocks like and pending like blocks score/reply before UUID generation', async () => {
  const s = r2bHarness();
  await s.controller.load(route);
  await s.detailController.load({ targetId });
  s.pendingRatings.freeze({
    version: 2,
    accountId: s.accountId,
    intent: replyIntent(),
  });
  await s.controller.toggleLike(commentId);
  assert.equal(s.ids.count, 0);
  assert.equal(s.ratingLikes.commands.length, 0);
  const p = r2bHarness();
  await p.controller.load(route);
  await p.detailController.load({ targetId });
  p.pendingRatings.freeze({
    version: 2,
    accountId: p.accountId,
    intent: likeIntent(),
  });
  p.controller.compose();
  p.controller.setText('synthetic');
  p.controller.setAuthorMode('anonymous');
  await p.controller.publish();
  p.detailController.chooseScore(5);
  await p.detailController.confirmScore();
  assert.equal(p.ids.count, 0);
  assert.equal(p.ratingDiscussion.commands.length, 0);
  assert.equal(p.ratings.commands.length, 0);
});

for (const boundary of [
  'dismiss',
  'cancel',
  'dispose',
  'logout',
  'account',
  'same-account',
  'hide',
  'safety',
  'scope',
] as const)
  test(`R2B ${boundary} clears current likes and fences late committed receipts while preserving owner journal`, async () => {
    const s = r2bHarness(),
      result = deferred<RatingLikeReceipt>();
    await s.controller.load(route);
    s.ratingLikes.commandImpl = async () => result.promise;
    const run = s.controller.toggleLike(replyId);
    await flush();
    const original = s.pendingRatings.load(s.accountId)!;
    assert.ok(original);
    if (boundary === 'dismiss') s.controller.dismiss();
    else if (boundary === 'cancel') s.controller.cancel();
    else if (boundary === 'dispose') s.controller.dispose();
    else if (boundary === 'logout') s.runtime.sessions.logout();
    else if (boundary === 'account' || boundary === 'same-account')
      s.runtime.sessions.completeLogin(s.runtime.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: boundary === 'account' ? otherId : s.accountId,
      });
    else if (boundary === 'hide') s.runtime.privateViews?.clear();
    else if (boundary === 'safety') s.safetyChanges.invalidate(s.accountId);
    else s.browsingScopeChanges.clear(s.accountId);
    result.resolve(likeReceipt(likeIntent('set_reply_like')));
    await run;
    cleared(s);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  });

test('R2B storage failure never dispatches and current root denial after receipt never restores historical content', async () => {
  for (const failure of ['write', 'remove'] as const) {
    const s = r2bHarness();
    await s.controller.load(route);
    s.storage.failWrite = failure === 'write';
    s.storage.failRemove = failure === 'remove';
    await s.controller.toggleLike(commentId);
    assert.equal(s.view().frozen, true);
    cleared(s);
    assert.equal(s.ratingLikes.commands.length, failure === 'write' ? 0 : 1);
    if (failure === 'remove') {
      s.storage.failRemove = false;
      s.ratingLikes.receiptImpl = async () => likeReceipt();
      s.ratingDiscussion.discussionImpl = async () => {
        throw unavailable();
      };
      await s.controller.recover();
      assert.equal(s.storage.data.size, 0);
      cleared(s);
    }
  }
});

test('R2B reply and like update categories use isolated DTOs, counters and navigation without source-page read', async () => {
  const s = r2bHarness();
  await s.updatesController.load();
  assert.equal(s.updateView().category, 'reply');
  assert.equal(s.ratingLikeUpdates.calls.length, 0);
  await s.updatesController.selectCategory('like');
  assert.equal(s.updateView().category, 'like');
  assert.equal(s.updateView().items[0]?.status, 'available');
  await s.updatesController.open(noticeId);
  assert.equal(s.navigation.length, 1);
  assert.match(s.navigation[0]!, new RegExp(`likeNoticeId=${noticeId}`));
  assert.doesNotMatch(s.navigation[0]!, /[?&]replyId=|[?&]noticeId=/);
  assert.equal(
    s.ratingLikeUpdates.calls.filter((c) => c.method === 'markRead').length,
    0,
  );
  s.ratingLikeUpdates.targetImpl = async () =>
    likeNoticeTarget({ target: likeLocator({ replyId }) });
  await s.updatesController.open(noticeId);
  assert.match(s.navigation[1]!, new RegExp(`replyId=${replyId}`));
  await s.updatesController.acknowledge(noticeId);
  assert.equal(s.updateView().unreadCount, 0);
  assert.equal(s.updateView().items[0]?.readAt, readReceipt().readAt);
  assert.equal(
    s.ratingUpdates.calls.filter((c) => c.method === 'markRead').length,
    0,
  );
});

for (const replyIdOrNull of [null, replyId])
  test(`R2B receiving ${replyIdOrNull ? 'reply' : 'root'} like notice resolves, reads current content, then marks only like route read`, async () => {
    const s = r2bHarness();
    s.ratingLikeUpdates.targetImpl = async () =>
      likeNoticeTarget({ target: likeLocator({ replyId: replyIdOrNull }) });
    s.ratingLikeUpdates.markReadImpl = async () => {
      assert.equal(s.view().loaded, true);
      return readReceipt();
    };
    await s.controller.load({
      ...route,
      ...(replyIdOrNull ? { replyId: replyIdOrNull } : {}),
      likeNoticeId: noticeId,
    });
    assert.equal(s.view().loaded, true);
    assert.deepEqual(
      s.ratingLikeUpdates.calls.map((c) => c.method),
      ['target', 'markRead'],
    );
    assert.equal(s.ratingUpdates.calls.length, 0);
    assert.ok(
      s.ratingDiscussion.calls.some(
        (c) => c.method === (replyIdOrNull ? 'position' : 'replies'),
      ),
    );
  });

test('R2B unavailable/mismatched like locator and position failure never automatically mark read', async () => {
  for (const failure of ['unavailable', 'mismatch', 'position'] as const) {
    const s = r2bHarness();
    s.ratingLikeUpdates.targetImpl = async () =>
      failure === 'unavailable'
        ? { noticeId, status: 'unavailable' }
        : likeNoticeTarget({
            target: likeLocator({
              replyId,
              ...(failure === 'mismatch' ? { rootId: otherId } : {}),
            }),
          });
    if (failure === 'position')
      s.ratingDiscussion.positionImpl = async () => {
        throw unavailable();
      };
    await s.controller.load({ ...route, replyId, likeNoticeId: noticeId });
    cleared(s);
    assert.equal(
      s.ratingLikeUpdates.calls.filter((c) => c.method === 'markRead').length,
      0,
    );
  }
});

test('R2B category switch cancels stale list/locator and preserves current category from old response', async () => {
  const s = r2bHarness(),
    hold = deferred<ReturnType<typeof likeUpdates>>();
  s.ratingLikeUpdates.listImpl = async () => hold.promise;
  const loading = s.updatesController.selectCategory('like');
  await flush();
  await s.updatesController.selectCategory('reply');
  hold.resolve(likeUpdates());
  await loading;
  assert.equal(s.updateView().category, 'reply');
  const item = s.updateView().items[0];
  assert.equal(item?.status === 'available' && item.kind, 'reply');
  s.ratingLikeUpdates.listImpl = async () =>
    likeUpdates({ items: [likeNotice()] });
  await s.updatesController.selectCategory('like');
  const target = deferred<ReturnType<typeof likeNoticeTarget>>();
  s.ratingLikeUpdates.targetImpl = async () => target.promise;
  const opening = s.updatesController.open(noticeId);
  await flush();
  await s.updatesController.selectCategory('reply');
  target.resolve(likeNoticeTarget());
  await opening;
  assert.equal(s.navigation.length, 0);
});

test('R2B changed ordering clears stale pages and unknown like coverage can recover by choosing time', async () => {
  const s = r2bHarness();
  s.ratings.commentsImpl = async (
    _region,
    _target,
    cursorValue,
    _cancel,
    _limit,
    sort,
  ) => {
    if (cursorValue)
      throw new ClientError('http', 'Synthetic order head changed', {
        httpStatus: 409,
        serverCode: 'DISCOVERY_RESTART_REQUIRED',
      });
    if (sort?.sort === 'likes')
      throw new ClientError('http', 'Synthetic unknown coverage', {
        httpStatus: 503,
        serverCode: 'RATING_UNAVAILABLE',
      });
    return commentPage({ nextCursor: cursor, continuation: 'more' });
  };
  await s.detailController.load({ targetId });
  await s.detailController.more('comments');
  assert.equal(s.detailView().loaded, false);
  assert.deepEqual(s.detailView().comments, []);
  assert.deepEqual(s.detailView().likes, {});
  assert.match(s.detailView().error, /排序|重新加载/);
  await s.detailController.selectSort('likes', 'desc');
  assert.equal(s.detailView().loaded, false);
  await s.detailController.selectSort('time', 'asc');
  assert.equal(s.detailView().loaded, true);
  assert.equal(s.detailView().commentSort, 'time');
  assert.equal(s.detailView().commentOrder, 'asc');
});

for (const replyIdOrNull of [null, replyId])
  for (const boundary of [
    'dismiss',
    'cancel',
    'dispose',
    'logout',
    'account',
    'epoch',
    'scope',
    'safety',
    'route',
  ] as const)
    test(`R2B ${boundary} at ${replyIdOrNull ? 'reply' : 'root'} like-notice applied-render boundary prevents subsequent markRead`, async () => {
      let interrupted = false;
      const s: Harness = r2bHarness((view) => {
        if (!view.loaded || interrupted) return;
        interrupted = true;
        if (boundary === 'dismiss') s.controller.dismiss();
        else if (boundary === 'cancel') s.controller.cancel();
        else if (boundary === 'dispose') s.controller.dispose();
        else if (boundary === 'logout') s.sessions.logout();
        else if (boundary === 'account' || boundary === 'epoch')
          s.sessions.completeLogin(s.sessions.beginLogin(), {
            ...wireCredentials(),
            accountId: boundary === 'account' ? otherId : s.accountId,
          });
        else if (boundary === 'scope')
          s.browsingScopeChanges.clear(s.accountId);
        else if (boundary === 'safety') s.safetyChanges.invalidate(s.accountId);
        else void s.controller.load(route);
      });
      s.ratingLikeUpdates.targetImpl = async () =>
        likeNoticeTarget({ target: likeLocator({ replyId: replyIdOrNull }) });
      await s.controller.load({
        ...route,
        ...(replyIdOrNull ? { replyId: replyIdOrNull } : {}),
        likeNoticeId: noticeId,
      });
      await flush();
      assert.equal(interrupted, true);
      assert.equal(
        s.ratingLikeUpdates.calls.filter((call) => call.method === 'markRead')
          .length,
        0,
      );
      if (boundary !== 'route') cleared(s);
      else {
        assert.equal(s.view().anchorReplyId, '');
        assert.equal(s.view().loaded, true);
      }
    });

test('R2B sorted continuation carries selected order while a newer sort fences a late old page and like reads', async () => {
  const s = r2bHarness(),
    held = deferred<ReturnType<typeof commentPage>>();
  s.ratings.commentsImpl = async (
    _region,
    _target,
    after,
    _cancel,
    _limit,
    selection,
  ) => {
    if (after && selection?.sort === 'likes') return held.promise;
    return commentPage({
      nextCursor: after ? null : cursor,
      continuation: after ? 'end' : 'more',
    });
  };
  await s.detailController.load({ targetId });
  await s.detailController.selectSort('likes', 'asc');
  const more = s.detailController.more('comments');
  await flush();
  const calls = s.ratings.calls.filter((call) => call.method === 'comments');
  assert.equal(calls[calls.length - 1]!.args[2], cursor);
  assert.deepEqual(calls[calls.length - 1]!.args[5], {
    sort: 'likes',
    order: 'asc',
  });
  await s.detailController.selectSort('time', 'desc');
  const before = s.ratingLikes.calls.length;
  held.resolve(
    commentPage({ items: [{ ...commentPage().items[0]!, id: otherId }] }),
  );
  await more;
  assert.equal(s.detailView().commentSort, 'time');
  assert.equal(s.detailView().commentOrder, 'desc');
  assert.deepEqual(
    s.detailView().comments.map((item) => item.id),
    [commentId],
  );
  assert.equal(s.detailView().likes[otherId], undefined);
  assert.equal(s.ratingLikes.calls.length, before);
});

test('R2B interaction-denied like reads do not revoke separately authorized list content or enable likes', async () => {
  const s = r2bHarness();
  s.ratingLikes.stateImpl = async () => {
    throw unavailable();
  };
  await s.controller.load(route);
  assert.equal(s.view().loaded, true);
  assert.ok(s.view().discussion);
  assert.ok(s.view().replies.length);
  assert.deepEqual(s.view().likes[commentId], { status: 'unavailable' });
  assert.deepEqual(s.view().likes[replyId], { status: 'unavailable' });
  await s.controller.toggleLike(commentId);
  await s.controller.toggleLike(replyId);
  assert.equal(s.ids.count, 0);
  assert.equal(s.ratingLikes.commands.length, 0);
  // A denial from the original content reading purpose does clear its bodies.
  s.ratingDiscussion.discussionImpl = async () => {
    throw unavailable();
  };
  await s.controller.reload();
  cleared(s);
});

test('R2B cancelling a serial like batch never dispatches its queued old subjects or applies a late last read', async () => {
  for (const subjects of [[root], [root, { ...root, replyId }]]) {
    const gateway = new FakeRatingLikesGateway(),
      cancel = new Cancellation(),
      release = deferred<RatingLikeState>();
    gateway.stateImpl = async () => release.promise;
    const running = readRatingLikeStates(gateway, null, subjects, cancel);
    await flush();
    assert.equal(gateway.calls.length, 1);
    cancel.cancel();
    release.resolve(likeState());
    await assert.rejects(running, { kind: 'cancelled' });
    assert.equal(gateway.calls.length, 1);
  }
});

test('R2B a newer route cancels the old serial read queue before remaining reply reads dispatch', async () => {
  const s = r2bHarness(),
    release = deferred<RatingLikeState>();
  let first = true;
  let oldCancel: Cancellation | undefined;
  let oldDispatches = 0;
  s.ratingLikes.stateImpl = async (_region, subject, cancel) => {
    if (first) {
      first = false;
      oldCancel = cancel;
      oldDispatches++;
      return release.promise;
    }
    if (cancel === oldCancel) oldDispatches++;
    return likeState(subject);
  };
  const old = s.controller.load(route);
  await flush();
  assert.ok(oldCancel);
  const next = s.controller.load({ ...route, replyId });
  await next;
  release.resolve(likeState());
  await old;
  assert.equal(oldCancel!.isCancelled, true);
  assert.equal(oldDispatches, 1);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().anchorReplyId, replyId);
  assert.equal(s.view().likes[replyId]?.status, 'known');
});

test('R2B cancelled final serial read cannot return unknown after a late noncooperative network failure', async () => {
  const gateway = new FakeRatingLikesGateway(),
    cancel = new Cancellation(),
    release = deferred<RatingLikeState>();
  gateway.stateImpl = async () => release.promise;
  const running = readRatingLikeStates(gateway, null, [root], cancel);
  await flush();
  cancel.cancel();
  release.reject(new ClientError('network', 'Late synthetic failure'));
  await assert.rejects(running, { kind: 'cancelled' });
  assert.equal(gateway.calls.length, 1);
});
