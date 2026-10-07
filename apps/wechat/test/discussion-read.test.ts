import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ThreadController,
  type ThreadView,
} from '../src/pages/community-thread/controller';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  comment,
  commentId,
  otherId,
  post,
  postId,
  reply,
  replyId,
  setup,
} from './community-helpers';
import type { Post } from '../src/community/contract';
function thread(located: string | null = null) {
  const s = setup(),
    views: ThreadView[] = [];
  const controller = new ThreadController(
    s.runtime,
    postId,
    commentId,
    located,
    (v) => views.push(v),
  );
  return { ...s, controller, view: () => views[views.length - 1]! };
}
function detail(
  located: { commentId: string } | { replyId: string } | null = null,
) {
  const s = setup(),
    views: DetailView[] = [];
  const controller = new DetailController(
    s.runtime,
    postId,
    (v) => views.push(v),
    undefined,
    located,
  );
  return { ...s, controller, view: () => views[views.length - 1]! };
}
test('thread parent/root are checked before replies; parent failure clears dependent body/media', async () => {
  const s = thread();
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.deepEqual(
    s.gateway.calls.map((call) => call.method),
    ['post', 'comment', 'replies'],
  );
  s.gateway.postImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'POST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.load();
  assert.equal(s.view().post, null);
  assert.equal(s.view().root, null);
  assert.deepEqual(s.view().replies, []);
});
test('located reply context is separate from ordinary traversal and dedupes when reached', async () => {
  const s = thread(otherId);
  s.gateway.repliesImpl = async (_root, after) =>
    after
      ? { items: [reply({ id: otherId })], nextCursor: null }
      : { items: [reply()], nextCursor: 'next' };
  s.gateway.discussionContextImpl = async () => ({
    comment: comment(),
    reply: reply({ id: otherId }),
    replies: { items: [reply({ id: otherId })], nextCursor: 'independent' },
  });
  await s.controller.load();
  assert.equal(s.view().locatedReply?.id, otherId);
  assert.equal(s.view().contextReplies.length, 1);
  assert.deepEqual(
    s.view().replies.map((item) => item.id),
    [replyId],
  );
  await s.controller.more();
  assert.equal(s.view().locatedReply, null);
  assert.deepEqual(s.view().contextReplies, []);
  assert.deepEqual(
    s.gateway.calls
      .filter((call) => call.method === 'replies')
      .map((call) => call.args[1]),
    [null, 'next'],
  );
});
test('same-post wrong-root reply and named-parent anonymous linkage fail closed', async () => {
  const s = thread();
  s.gateway.repliesImpl = async () => ({
    items: [reply({ rootCommentId: otherId })],
    nextCursor: null,
  });
  await s.controller.load();
  assert.equal(s.view().loaded, false);
  const leak = thread();
  leak.gateway.postImpl = async () =>
    post({
      author: {
        kind: 'named',
        profileId: otherId,
        displayName: 'named',
        avatar: null,
      },
    });
  await leak.controller.load();
  assert.equal(leak.view().loaded, false);
});
test('normal roots start likes-desc, located roots time-desc; sort and continuation restart clear old pages', async () => {
  const normal = detail();
  await normal.controller.load();
  assert.equal(normal.view().sort, 'likes');
  assert.deepEqual(
    normal.gateway.calls.find((call) => call.method === 'comments')!.args[3],
    { sort: 'likes', order: 'desc' },
  );
  const s = detail({ commentId });
  s.gateway.commentsImpl = async () => ({
    items: [comment()],
    nextCursor: 'cursor',
  });
  await s.controller.load();
  assert.equal(s.view().sort, 'time');
  assert.equal(s.view().locatedComment?.id, commentId);
  s.gateway.commentsImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'DISCUSSION_RESTART_REQUIRED',
      httpStatus: 409,
    });
  };
  await s.controller.more();
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().comments, []);
  assert.equal(s.view().locatedComment, null);
  assert.match(s.view().error, /排序已变化/);
});
test('inline first-two continuation uses its cursor and default20; stable IDs dedupe', async () => {
  const s = detail();
  s.gateway.commentsImpl = async () => ({
    items: [
      comment({
        replyCount: 2,
        replyPreview: { items: [reply()], nextCursor: 'preview' },
      }),
    ],
    nextCursor: null,
  });
  s.gateway.repliesImpl = async () => ({
    items: [reply(), reply({ id: otherId })],
    nextCursor: null,
  });
  await s.controller.load();
  await s.controller.moreReplies(commentId);
  assert.equal(s.view().comments[0]!.replyPreview.items.length, 2);
  const call = s.gateway.calls.find((call) => call.method === 'replies')!;
  assert.equal(call.args[1], 'preview');
  assert.equal(call.args[3], undefined);
});
test('deleting located root clears location and preview; deleting one reply clears before authoritative reload', async () => {
  const s = detail({ commentId });
  await s.controller.load();
  s.controller.requestDelete('comment', commentId);
  await s.controller.confirmDelete();
  assert.equal(s.view().locatedComment, null);
  assert.equal(s.view().locatedReplyId, '');
  assert.deepEqual(s.view().comments, []);
  const r = thread();
  await r.controller.load();
  r.controller.requestDelete(replyId);
  r.controller.dismissDelete();
  await r.controller.confirmDelete();
  assert.equal(
    r.gateway.calls.some((call) => call.method === 'deleteReply'),
    false,
  );
  r.controller.requestDelete(replyId);
  await r.controller.confirmDelete();
  assert.equal(r.view().root, null);
  assert.deepEqual(r.view().replies, []);
  assert.equal(r.view().needsReload, true);
});
for (const lifecycle of [
  'cancel',
  'dispose',
  'app-hide',
  'same-account',
  'switch-account',
] as const)
  test(`thread ${lifecycle} cancels pending parent read and rejects stale results`, async () => {
    const s = thread(),
      pending = deferred<Post>();
    s.gateway.postImpl = async () => pending.promise;
    const loading = s.controller.load();
    await flush();
    const cancellation = s.gateway.calls[0]!.args[1] as {
      isCancelled: boolean;
    };
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: lifecycle === 'same-account' ? s.accountId : otherId,
      });
    assert.equal(cancellation.isCancelled, true);
    pending.resolve(post());
    await loading;
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().root, null);
  });
