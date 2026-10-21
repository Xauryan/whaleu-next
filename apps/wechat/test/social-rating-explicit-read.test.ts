/** Fictional source-only evidence for the merged timeline's explicit read boundary.
 * Independent legacy rating notice pages retain their existing behavior. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRatingThreadRoute } from '../src/ratings/discussion-controller';
import type { RatingDiscussionContext } from '../src/ratings/discussion-contract';
import { SocialNoticesController } from '../src/pages/social-notices/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { otherId } from './ratings-helpers';
import { discussion, noticeId, replyId, route } from './ratings-r2a-helpers';
import { r2cHarness } from './ratings-r2c-helpers';

const specs = [
  {
    source: 'rating-reply',
    owner: 'ratingUpdates',
    query: 'noticeId',
    kind: 'comments',
  },
  {
    source: 'rating-like',
    owner: 'ratingLikeUpdates',
    query: 'likeNoticeId',
    kind: 'likes',
  },
  {
    source: 'rating-subscription',
    owner: 'ratingSubscriptionUpdates',
    query: 'subscriptionNoticeId',
    kind: 'comments',
  },
] as const;
function setup(spec: (typeof specs)[number]) {
  const s = r2cHarness();
  const urls: string[] = [];
  const social = new SocialNoticesController(
    s.runtime,
    spec.kind,
    () => undefined,
    async (url) => {
      urls.push(url);
    },
  );
  const owner = s[spec.owner];
  const writes = () =>
    [s.ratingUpdates, s.ratingLikeUpdates, s.ratingSubscriptionUpdates].flatMap(
      (reader) => reader.calls.filter((call) => call.method === 'markRead'),
    );
  const close = () => {
    social.dispose();
    s.controller.dispose();
    s.detailController.dispose();
    s.directoryController.dispose();
    s.updatesController.dispose();
  };
  return { ...s, social, urls, owner, writes, close };
}
function explicitRoute(spec: (typeof specs)[number]) {
  return {
    ...route,
    ...(spec.source === 'rating-reply' ? { replyId } : {}),
    [spec.query]: noticeId,
    noticeRead: 'explicit',
  };
}
for (const spec of specs) {
  test(`${spec.source} merged navigation retains destination proof and positioning but only explicit owner read can settle`, async () => {
    const s = setup(spec);
    try {
      await s.social.load();
      assert.equal(s.writes().length, 0);
      const id = `${spec.source}:${noticeId}`;
      await s.social.open(id);
      assert.equal(s.writes().length, 0);
      assert.equal(s.urls.length, 1);
      const query = Object.fromEntries(
        new URL(s.urls[0]!, 'https://fictional-native.example').searchParams,
      );
      assert.equal(query[spec.query], noticeId);
      assert.equal(query.noticeRead, 'explicit');
      assert.deepEqual(
        decodeRatingThreadRoute(query),
        decodeRatingThreadRoute(explicitRoute(spec)),
      );
      await s.controller.load(query);
      assert.equal(s.view().loaded, true);
      assert.equal(
        s.owner.calls.filter((call) => call.method === 'target').length,
        2,
        'One source proof and a second destination proof both survive',
      );
      assert.ok(
        s.ratingDiscussion.calls.some((call) => call.method === 'discussion'),
      );
      assert.ok(
        s.ratingDiscussion.calls.some(
          (call) =>
            call.method ===
            (spec.source === 'rating-reply' ? 'position' : 'replies'),
        ),
      );
      assert.equal(
        s.writes().length,
        0,
        'Applying a successful target page cannot mark this merged-timeline notice',
      );
      await s.controller.reload();
      assert.equal(s.writes().length, 0, 'Reload preserves explicit read mode');
      assert.equal(
        s.social.snapshot().rows.find((row) => row.id === id)?.unread,
        true,
      );
      await s.social.acknowledge(id);
      assert.equal(s.writes().length, 1);
      assert.equal(
        s.owner.calls.filter((call) => call.method === 'markRead').length,
        1,
      );
      assert.equal(
        s.social.snapshot().rows.find((row) => row.id === id)?.unread,
        false,
      );
      assert.ok(
        s.social
          .snapshot()
          .rows.filter((row) => row.id !== id)
          .every((row) => row.unread),
        'Namespaced siblings sharing the raw ID remain untouched',
      );
    } finally {
      s.close();
    }
  });
  test(`${spec.source} explicit mode is not permission: unavailable owner target still blocks all content`, async () => {
    const s = setup(spec);
    try {
      s.owner.targetImpl = async () => ({ noticeId, status: 'unavailable' });
      await s.controller.load(explicitRoute(spec));
      assert.equal(s.view().loaded, false);
      assert.equal(s.view().discussion, null);
      assert.equal(s.ratingDiscussion.calls.length, 0);
      assert.equal(s.writes().length, 0);
    } finally {
      s.close();
    }
  });
  test(`${spec.source} explicit mode preserves exact notice ancestry proof`, async () => {
    const s = setup(spec);
    try {
      s.owner.targetImpl = async () => ({
        noticeId,
        status: 'available',
        target: {
          regionId: null,
          targetId: otherId,
          rootId: route.rootId,
          replyId,
        },
      });
      await s.controller.load(explicitRoute(spec));
      assert.equal(s.view().loaded, false);
      assert.equal(s.ratingDiscussion.calls.length, 0);
      assert.equal(s.writes().length, 0);
    } finally {
      s.close();
    }
  });
  for (const boundary of ['hide', 'logout', 'replace', 'collapse'] as const) {
    test(`${spec.source} explicit navigation cannot read or retain late content after ${boundary}`, async () => {
      const s = setup(spec);
      try {
        const held = deferred<RatingDiscussionContext>();
        s.ratingDiscussion.discussionImpl = () => held.promise;
        const work = s.controller.load(explicitRoute(spec));
        await flush();
        if (boundary === 'hide') s.runtime.privateViews!.clear();
        else if (boundary === 'logout') s.sessions.logout();
        else if (boundary === 'replace')
          s.sessions.completeLogin(s.sessions.beginLogin(), {
            ...wireCredentials('b'),
            accountId: otherId,
          });
        else s.controller.collapse();
        held.resolve(discussion());
        await work;
        assert.equal(s.view().loaded, false);
        assert.equal(s.view().discussion, null);
        assert.equal(s.writes().length, 0);
      } finally {
        s.close();
      }
    });
  }
}
test('rating explicit-read route accepts only the exact non-authorizing switch plus one valid notice ID', () => {
  for (const spec of specs)
    assert.equal(
      decodeRatingThreadRoute(explicitRoute(spec)).noticeRead,
      'explicit',
    );
  for (const noticeRead of [
    undefined,
    null,
    false,
    true,
    '',
    'auto',
    'EXPLICIT',
    ['explicit'],
    { mode: 'explicit' },
  ])
    assert.throws(
      () => decodeRatingThreadRoute({ ...explicitRoute(specs[1]), noticeRead }),
      { kind: 'protocol' },
    );
  for (const value of [
    { ...route, noticeRead: 'explicit' },
    { ...route, noticeRead: 'explicit', noticeId },
    { ...explicitRoute(specs[1]), noticeId, replyId },
    { ...explicitRoute(specs[1]), subscriptionNoticeId: noticeId },
    { ...explicitRoute(specs[1]), likeNoticeId: 'invalid' },
    { ...explicitRoute(specs[1]), accountId: otherId },
  ])
    assert.throws(() => decodeRatingThreadRoute(value), { kind: 'protocol' });
  assert.deepEqual(
    decodeRatingThreadRoute(route),
    route,
    'Ordinary non-notice deep links do not change',
  );
});
