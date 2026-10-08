import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { Comments } from '../src/community/contract';
import { SafetyChanges } from '../src/community/safety-changes';
import {
  ComposeController,
  type ComposeTarget,
  type ComposeView,
} from '../src/pages/community-compose/controller';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import type { Cancellation } from '../src/platform/contracts';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  comment,
  commentId,
  otherId,
  postId,
  reply,
  replyId,
  setup,
} from './community-helpers';

const last = <T>(items: readonly T[]): T => items[items.length - 1]!;

function detail(
  located: { commentId: string } | { replyId: string } | null = null,
) {
  const s = setup();
  const safetyChanges = new SafetyChanges(s.runtime.privateViews);
  const runtime = { ...s.runtime, safetyChanges };
  const views: DetailView[] = [];
  const postReads: { id: string | null; generation: number }[] = [];
  const controller = new DetailController(
    runtime,
    postId,
    (view) => views.push(view),
    (post, generation) => postReads.push({ id: post?.id ?? null, generation }),
    located,
  );
  return {
    ...s,
    runtime,
    safetyChanges,
    controller,
    postReads,
    view: () => last(views),
  };
}
const commentCursors = (s: ReturnType<typeof detail>) =>
  s.gateway.calls
    .filter((call) => call.method === 'comments')
    .map((call) => call.args[1]);
const assertCleared = (view: DetailView) => {
  assert.equal(view.post, null);
  assert.deepEqual(view.comments, []);
  assert.equal(view.locatedComment, null);
  assert.equal(view.locatedReplyId, '');
  assert.equal(view.pageNumber, 0);
  assert.equal(view.canPrevious, false);
  assert.equal(view.canLoadMore, false);
  assert.equal(view.loaded, false);
};
function twoPages(s: ReturnType<typeof detail>) {
  s.gateway.commentsImpl = async (_post, after) => ({
    items: [comment({ id: after ? otherId : commentId })],
    nextCursor: after ? null : 'page-two',
  });
}

test('root navigation replaces bounded pages rather than retaining all traversed roots', async () => {
  const s = detail();
  const roots = Array.from({ length: 45 }, (_, index) =>
    comment({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      text: `root ${index}`,
    }),
  );
  s.gateway.commentsImpl = async (_post, after) => {
    const offset = Number(after ?? 0);
    return {
      items: roots.slice(offset, offset + 10),
      nextCursor: offset + 10 < roots.length ? String(offset + 10) : null,
    };
  };
  await s.controller.load();
  for (let page = 0; page < 5; page++) {
    assert.deepEqual(s.view().comments, roots.slice(page * 10, page * 10 + 10));
    assert.ok(s.view().comments.length <= 10);
    assert.equal(s.view().pageNumber, page + 1);
    assert.equal(s.view().canPrevious, page > 0);
    if (page < 4) await s.controller.more();
  }
  assert.equal(s.view().canLoadMore, false);
  await s.controller.more();
  assert.deepEqual(commentCursors(s), [null, '10', '20', '30', '40']);
  for (let page = 3; page >= 0; page--) {
    await s.controller.previous();
    assert.deepEqual(s.view().comments, roots.slice(page * 10, page * 10 + 10));
  }
  assert.equal(s.view().canPrevious, false);
  assert.deepEqual(commentCursors(s), [
    null,
    '10',
    '20',
    '30',
    '40',
    '30',
    '20',
    '10',
    null,
  ]);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'post').length,
    9,
  );
  assert.deepEqual(
    s.postReads
      .filter((read) => read.id !== null)
      .map((read) => read.generation),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('Previous re-fetches root bodies and previews; an expanded preview is never restored', async () => {
  const s = detail();
  let revisited = false;
  s.gateway.commentsImpl = async (_post, after) =>
    after
      ? {
          items: [comment({ id: otherId })],
          nextCursor: null,
        }
      : {
          items: [
            comment({
              text: revisited ? 'fresh root' : 'old root',
              replyCount: 3,
              replyPreview: {
                items: [
                  reply({ text: revisited ? 'fresh reply' : 'old reply' }),
                ],
                nextCursor: revisited ? 'fresh-preview' : 'old-preview',
              },
            }),
          ],
          nextCursor: 'page-two',
        };
  s.gateway.repliesImpl = async () => ({
    items: [reply({ id: otherId })],
    nextCursor: null,
  });
  await s.controller.load();
  await s.controller.moreReplies(commentId);
  assert.equal(s.view().comments[0]!.replyPreview.items.length, 2);
  const next = s.controller.more();
  assertCleared(s.view());
  await next;
  assert.deepEqual(
    s.view().comments.map((item) => item.id),
    [otherId],
  );
  revisited = true;
  const previous = s.controller.previous();
  assertCleared(s.view());
  await previous;
  assert.equal(s.view().comments[0]!.text, 'fresh root');
  assert.equal(s.view().comments[0]!.replyPreview.items.length, 1);
  assert.equal(
    s.view().comments[0]!.replyPreview.items[0]!.text,
    'fresh reply',
  );
  assert.equal(s.view().comments[0]!.replyPreview.nextCursor, 'fresh-preview');
  assert.deepEqual(commentCursors(s), [null, 'page-two', null]);
});

test('Previous discards the forward cursor branch and follows the fresh page continuation', async () => {
  const s = detail();
  let fresh = false;
  s.gateway.commentsImpl = async (_post, after) => ({
    items: [comment()],
    nextCursor:
      after === null
        ? 'second'
        : after === 'second'
          ? fresh
            ? 'third-fresh'
            : 'third-old'
          : null,
  });
  await s.controller.load();
  await s.controller.more();
  await s.controller.more();
  fresh = true;
  await s.controller.previous();
  await s.controller.more();
  assert.deepEqual(commentCursors(s), [
    null,
    'second',
    'third-old',
    'second',
    'third-fresh',
  ]);
});

test('off-page deep-link context is fresh on every page and never used as the root cursor', async () => {
  const s = detail({ replyId });
  twoPages(s);
  let contextRead = 0;
  s.gateway.discussionContextImpl = async (_post, target) => {
    assert.deepEqual(target, { replyId });
    contextRead++;
    return {
      comment: comment({ text: `located ${contextRead}` }),
      reply: reply(),
      replies: { items: [reply()], nextCursor: 'context-only' },
    };
  };
  await s.controller.load();
  await s.controller.more();
  assert.equal(s.view().locatedComment?.text, 'located 2');
  assert.equal(s.view().locatedReplyId, replyId);
  assert.deepEqual(
    s.view().comments.map((item) => item.id),
    [otherId],
  );
  await s.controller.previous();
  assert.equal(s.view().locatedComment?.text, 'located 3');
  assert.deepEqual(commentCursors(s), [null, 'page-two', null]);
});

for (const failure of ['restart', 'malformed', 'network', 'cycle'] as const)
  test(`root ${failure} failure clears all pages and forbids old Previous/Next`, async () => {
    const s = detail({ commentId });
    s.gateway.commentsImpl = async (_post, after) => ({
      items: [comment()],
      nextCursor: after ? 'page-three' : 'page-two',
    });
    await s.controller.load();
    await s.controller.more();
    s.gateway.commentsImpl = async () => {
      if (failure === 'cycle')
        return { items: [comment()], nextCursor: 'page-two' };
      if (failure === 'network')
        throw new ClientError('network', 'network unavailable');
      throw new ClientError('http', 'safe', {
        httpStatus: failure === 'restart' ? 409 : 400,
        serverCode:
          failure === 'restart'
            ? 'DISCUSSION_RESTART_REQUIRED'
            : 'INVALID_REQUEST',
      });
    };
    await s.controller.more();
    assertCleared(s.view());
    const count = commentCursors(s).length;
    await s.controller.previous();
    await s.controller.more();
    assert.equal(commentCursors(s).length, count);
    if (failure === 'restart') assert.match(s.view().error, /重新加载/);
    twoPages(s);
    await s.controller.load();
    assert.equal(s.view().pageNumber, 1);
    assert.equal(s.view().canPrevious, false);
    assert.equal(last(commentCursors(s)), null);
  });

test('reload and ordering restart at page one; repeated Next/Previous taps dispatch once', async () => {
  const s = detail();
  twoPages(s);
  await s.controller.load();
  const pending = deferred<Comments>();
  s.gateway.commentsImpl = async () => pending.promise;
  const next = s.controller.more();
  await flush();
  await s.controller.more();
  await s.controller.previous();
  assert.equal(commentCursors(s).length, 2);
  pending.resolve({ items: [comment({ id: otherId })], nextCursor: null });
  await next;
  twoPages(s);
  await s.controller.setOrdering({ sort: 'time', order: 'asc' });
  assert.equal(s.view().pageNumber, 1);
  assert.equal(s.view().canPrevious, false);
  assert.deepEqual(
    last(s.gateway.calls.filter((call) => call.method === 'comments')).args[3],
    { sort: 'time', order: 'asc' },
  );
  await s.controller.more();
  await s.controller.load();
  assert.equal(s.view().pageNumber, 1);
  assert.equal(last(commentCursors(s)), null);
});

for (const lifecycle of [
  'cancel',
  'dispose',
  'app-hide',
  'same-account',
  'switch-account',
  'safety',
  'reload',
] as const)
  test(`pending root navigation cannot restore bodies/history after ${lifecycle}`, async () => {
    const s = detail({ commentId });
    twoPages(s);
    await s.controller.load();
    await s.controller.more();
    const late = deferred<Comments>();
    let cancellation: Cancellation | undefined;
    s.gateway.commentsImpl = async (_post, _after, cancel) => {
      cancellation = cancel;
      return late.promise;
    };
    const previous = s.controller.previous();
    await flush();
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else if (lifecycle === 'same-account' || lifecycle === 'switch-account')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: lifecycle === 'same-account' ? s.accountId : otherId,
      });
    else {
      twoPages(s);
      if (lifecycle === 'safety') s.safetyChanges.invalidate(s.accountId);
      else void s.controller.load();
    }
    assert.equal(cancellation?.isCancelled, true);
    assertCleared(s.view());
    await flush();
    late.resolve({
      items: [comment({ text: 'stale response' })],
      nextCursor: 'stale-cursor',
    });
    await previous;
    await flush();
    if (lifecycle === 'safety' || lifecycle === 'reload') {
      assert.equal(s.view().pageNumber, 1);
      assert.equal(s.view().canPrevious, false);
      assert.notEqual(s.view().comments[0]?.text, 'stale response');
    } else {
      assertCleared(s.view());
      const count = commentCursors(s).length;
      await s.controller.previous();
      await s.controller.more();
      assert.equal(commentCursors(s).length, count);
    }
  });

test('navigation and cancellation preserve target-specific unsent drafts without publication', async () => {
  const s = detail();
  twoPages(s);
  const target: ComposeTarget = {
    operation: 'publish_reply',
    postId,
    rootCommentId: commentId,
    targetReplyId: replyId,
  };
  const views: ComposeView[] = [];
  const compose = new ComposeController(s.runtime, target, (view) =>
    views.push(view),
  );
  await compose.load();
  compose.setText('unsent reply for the original target');
  const saved = structuredClone([...s.storage.data]);
  assert.ok(saved.length > 0);
  await s.controller.load();
  await s.controller.more();
  await s.controller.previous();
  s.controller.cancel();
  assert.deepEqual([...s.storage.data], saved);
  assert.equal(last(views).text, 'unsent reply for the original target');
  compose.dispose();
  const reopened = new ComposeController(s.runtime, target, (view) =>
    views.push(view),
  );
  await reopened.load();
  assert.equal(last(views).text, 'unsent reply for the original target');
  assert.equal(
    s.gateway.calls.some((call) => call.method.startsWith('publish')),
    false,
  );
  assert.equal(s.runtime.pending.load(s.accountId), null);
  reopened.dispose();
});
