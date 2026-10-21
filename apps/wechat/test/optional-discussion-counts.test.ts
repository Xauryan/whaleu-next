import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePost, decodeComment } from '../src/community/contract';
import { countsAfterRootDeletion } from '../src/community/discussion-counts';
import {
  post,
  comment,
  setup,
  postId,
  commentId,
  reply,
} from './community-helpers';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  ThreadController,
  type ThreadView,
} from '../src/pages/community-thread/controller';
import { ClientError } from '../src/api/errors';

const unknown = { commentCount: null, replyCount: null, discussionCount: null };
test('discussion count decoding accepts exact consistent numbers or all unknown, never mixed guesses', () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(unknown).map((key) => [
        key,
        (decodePost(post(unknown)) as unknown as Record<string, unknown>)[key],
      ]),
    ),
    unknown,
  );
  assert.equal(
    decodePost(
      post({ commentCount: 1025, replyCount: 2049, discussionCount: 3074 }),
    ).discussionCount,
    3074,
  );
  assert.equal(
    decodePost(
      post({
        commentCount: Number.MAX_SAFE_INTEGER,
        replyCount: 0,
        discussionCount: Number.MAX_SAFE_INTEGER,
      }),
    ).commentCount,
    Number.MAX_SAFE_INTEGER,
  );
  for (const patch of [
    { commentCount: null },
    { replyCount: null },
    { discussionCount: null },
    { ...unknown, commentCount: 0 },
    { commentCount: 1, replyCount: 2, discussionCount: 4 },
    {
      commentCount: Number.MAX_SAFE_INTEGER,
      replyCount: 1,
      discussionCount: Number.MAX_SAFE_INTEGER + 1,
    },
    { commentCount: -1 },
    { commentCount: NaN },
    { commentCount: Infinity },
    { commentCount: '0' },
    { commentCount: undefined },
  ])
    assert.throws(() => decodePost({ ...post(), ...patch }));
});
test('unknown root reply count is retained, while malformed counts remain rejected', () => {
  assert.equal(decodeComment(comment({ replyCount: null })).replyCount, null);
  for (const replyCount of [
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '0',
    undefined,
  ]) {
    assert.throws(() => decodeComment({ ...comment(), replyCount }));
  }
});
test('unknown count never relaxes reply preview bounds or parent identity', () => {
  const withPreview = (items: ReturnType<typeof reply>[]) =>
    comment({
      replyCount: null,
      replyPreview: { items, nextCursor: 'opaque-preview-continuation' },
    });
  assert.equal(
    decodeComment(withPreview([reply()])).replyPreview.items.length,
    1,
  );
  assert.throws(() =>
    decodeComment(withPreview([reply({ postId: commentId })])),
  );
  assert.throws(() =>
    decodeComment(withPreview([reply({ rootCommentId: postId })])),
  );
  assert.throws(() =>
    decodeComment(
      withPreview(
        Array.from({ length: 6 }, (_, index) =>
          reply({ id: `${index + 1}2121212-1212-4212-8212-121212121212` }),
        ),
      ),
    ),
  );
});
test('confirmed root deletion with unknown descendants preserves an unknown aggregate', async () => {
  const s = setup();
  let view: DetailView | undefined;
  s.gateway.postImpl = async () =>
    post({ commentCount: 3, replyCount: 5, discussionCount: 8 });
  s.gateway.commentsImpl = async () => ({
    items: [comment({ replyCount: null })],
    nextCursor: null,
  });
  const controller = new DetailController(s.runtime, postId, (next) => {
    view = next;
  });
  await controller.load();
  controller.requestDelete('comment', commentId);
  assert.equal(view?.deleteTarget?.id, commentId);
  await controller.confirmDelete();
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'deleteComment').length,
    1,
  );
  assert.deepEqual(view?.comments, []);
  assert.equal(view?.deleteTarget, null);
  for (const key of ['commentCount', 'replyCount', 'discussionCount'] as const)
    assert.equal(view?.post?.[key], null);
  controller.dispose();
});
test('local deletion keeps exact counts only with a known consistent deleted subtree', () => {
  const exact = { commentCount: 3, replyCount: 5, discussionCount: 8 };
  assert.deepEqual(countsAfterRootDeletion(exact, 2), {
    commentCount: 2,
    replyCount: 3,
    discussionCount: 5,
  });
  assert.deepEqual(
    countsAfterRootDeletion(
      { commentCount: 1, replyCount: 0, discussionCount: 1 },
      0,
    ),
    { commentCount: 0, replyCount: 0, discussionCount: 0 },
  );
  for (const count of [null, undefined, -1, 6, NaN])
    assert.deepEqual(countsAfterRootDeletion(exact, count), unknown);
  assert.deepEqual(countsAfterRootDeletion(unknown, 0), unknown);
  assert.deepEqual(
    countsAfterRootDeletion({ ...exact, discussionCount: 7 }, 0),
    unknown,
  );
});
test('community count displays branch on unknown without changing specialist count contracts', () => {
  for (const file of [
    'pages/community-feed/community-feed.wxml',
    'pages/community-hot/community-hot.wxml',
    'pages/community-saved/community-saved.wxml',
    'pages/community-detail/community-detail.wxml',
    'pages/community-thread/community-thread.wxml',
    'pages/public-profile/public-profile.wxml',
    'pages/feedback/feedback.wxml',
    'post-pins/feed.wxml',
  ]) {
    const source = readFileSync(path.join(__dirname, '../src', file), 'utf8');
    assert.match(
      source,
      /(?:commentCount|replyCount|discussionCount) === null \? '—'/,
      file,
    );
    assert.doesNotMatch(source, /post\.commentCount \+ post\.replyCount/, file);
    if (
      [
        'pages/community-feed/community-feed.wxml',
        'pages/community-hot/community-hot.wxml',
        'pages/community-saved/community-saved.wxml',
        'pages/public-profile/public-profile.wxml',
        'pages/feedback/feedback.wxml',
      ].includes(file)
    )
      assert.match(
        source,
        /aria-label="{{item\.(?:post\.)?(?:commentCount|discussionCount) === null \? '回复数量暂不可用'/,
        `${file}: icon-only unknown count has a meaningful accessible label`,
      );
  }
});

test('bounded empty root scan keeps continuation and restart clears stale private rows', async () => {
  const s = setup();
  let view: DetailView | undefined;
  s.gateway.postImpl = async () => post(unknown);
  s.gateway.commentsImpl = async (_id, after) =>
    after
      ? {
          items: [comment({ id: commentId, replyCount: null })],
          nextCursor: null,
        }
      : { items: [], nextCursor: 'opaque-next-scan' };
  const controller = new DetailController(s.runtime, postId, (next) => {
    view = next;
  });
  await controller.load();
  assert.equal(view?.canLoadMore, true);
  assert.deepEqual(view?.comments, []);
  await controller.more();
  assert.equal(view?.comments.length, 1);
  assert.equal(view?.post?.discussionCount, null);
  s.gateway.commentsImpl = async () => {
    throw new ClientError('http', 'restart', {
      httpStatus: 409,
      serverCode: 'DISCUSSION_RESTART_REQUIRED',
    });
  };
  await controller.previous();
  assert.equal(view?.loaded, false);
  assert.equal(view?.post, null);
  assert.equal(view?.canLoadMore, false);
  assert.match(view?.error ?? '', /重新加载/);
  controller.dispose();
});

test('bounded empty reply scan remains navigable without treating unknown count as zero', async () => {
  const s = setup();
  let view: ThreadView | undefined;
  s.gateway.postImpl = async () => post(unknown);
  s.gateway.commentImpl = async () => comment({ replyCount: null });
  s.gateway.repliesImpl = async (_id, after) =>
    after
      ? { items: [reply()], nextCursor: null }
      : { items: [], nextCursor: 'opaque-reply-scan' };
  const controller = new ThreadController(
    s.runtime,
    postId,
    commentId,
    null,
    (next) => {
      view = next;
    },
  );
  await controller.load();
  assert.equal(view?.canLoadMore, true);
  assert.equal(view?.root?.replyCount, null);
  await controller.more();
  assert.equal(view?.replies.length, 1);
  assert.equal(view?.canLoadMore, false);
  controller.dispose();
});

test('accepted Home successor changes only the exact count value and accessibility bindings', () => {
  const original = readFileSync(
    path.join(
      __dirname,
      'fixtures/optional-discussion-counts-home-before.wxml.txt',
    ),
    'utf8',
  );
  const expected = original
    .replace(
      'aria-label="{{item.commentCount}} 条根回复"',
      "aria-label=\"{{item.commentCount === null ? '回复数量暂不可用' : item.commentCount + ' 条根回复'}}\"",
    )
    .replace(
      '{{item.commentCount}}',
      "{{item.commentCount === null ? '—' : item.commentCount}}",
    );
  assert.notEqual(expected, original);
  assert.equal(
    readFileSync(
      path.join(__dirname, '../src/pages/community-feed/community-feed.wxml'),
      'utf8',
    ),
    expected,
  );
});

test('historical app configuration changes only by three explicit private timetable routes', () => {
  const before = JSON.parse(
    readFileSync(
      path.join(__dirname, 'fixtures/business-successor-v33c-before-0.txt'),
      'utf8',
    ),
  ) as { pages: string[] };
  const current = JSON.parse(
    readFileSync(path.join(__dirname, '../src/app.json'), 'utf8'),
  ) as { pages: string[] };
  const added = [
    'personal-timetable',
    'personal-timetable-term',
    'personal-timetable-entry',
  ].map((name) => `pages/${name}/${name}`);
  assert.equal(current.pages.length, before.pages.length + added.length);
  for (const route of added)
    assert.equal(current.pages.filter((value) => value === route).length, 1);
  assert.deepEqual(
    {
      ...current,
      pages: current.pages.filter((route) => !added.includes(route)),
    },
    before,
  );
});
