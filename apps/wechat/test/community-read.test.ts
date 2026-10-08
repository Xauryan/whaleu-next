import { publicExperienceDisplay } from './community-helpers';
import { PostLikeMutationController } from '../src/community/post-like-controller';
import type { PostLikeReceipt } from '../src/community/post-like-contract';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { Feed, Post, Spaces } from '../src/community/contract';
import {
  FeedController,
  type FeedView,
} from '../src/pages/community-feed/controller';
import {
  DetailController,
  type DetailView,
} from '../src/pages/community-detail/controller';
import {
  MineController,
  type MineView,
} from '../src/pages/community-mine/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { campus, campusId } from './profile-helpers';
import {
  commentId,
  otherId,
  post,
  postId,
  requestId,
  setup,
  space,
} from './community-helpers';
function feed(loggedIn = true) {
  const s = setup(loggedIn),
    views: FeedView[] = [];
  const controller = new FeedController(s.runtime, (view) => views.push(view));
  return { ...s, controller, views, view: () => views[views.length - 1]! };
}
function detail() {
  const s = setup(),
    views: DetailView[] = [];
  const controller = new DetailController(s.runtime, postId, (view) =>
    views.push(view),
  );
  return { ...s, controller, views, view: () => views[views.length - 1]! };
}
test('selected physical campus resolves explicit region/space; missing mapping never falls back to global', async () => {
  const s = feed();
  s.gateway.spacesImpl = async () => ({
    regional: null,
    global: [space({ id: otherId, kind: 'global', operatingRegionId: null })],
  });
  await s.controller.load();
  assert.equal(s.view().space, null);
  assert.equal(s.view().posts.length, 0);
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'feed'),
    false,
  );
  assert.equal(
    s.gateway.calls.find((call) => call.method === 'spaces')!.args[0],
    campusId,
  );
  await s.controller.chooseGlobal(otherId);
  assert.equal(s.view().space?.kind, 'global');
  assert.equal(
    (
      s.gateway.calls.find((call) => call.method === 'feed')!.args[0] as {
        spaceId: string;
      }
    ).spaceId,
    otherId,
  );
  const disabled = feed();
  disabled.gateway.spacesImpl = async () => ({
    regional: space({ isActive: false }),
    global: [],
  });
  await disabled.controller.load();
  assert.equal(disabled.view().space, null);
  assert.equal(
    disabled.gateway.calls.some((call) => call.method === 'feed'),
    false,
  );
});
test('guest explicitly selects campus and sees only first-ten/login state; phone-blocked has no continuation', async () => {
  for (const loggedIn of [false, true]) {
    const s = feed(loggedIn);
    s.gateway.feedImpl = async () => ({
      items: [post()],
      nextCursor: null,
      continuation: loggedIn ? 'phone_verification_required' : 'login_required',
    });
    await s.controller.load();
    if (!loggedIn) {
      assert.equal(
        s.gateway.calls.some((call) => call.method === 'feed'),
        false,
      );
      await s.controller.chooseCampus(campusId);
    }
    assert.equal(s.view().canLoadMore, false);
    await s.controller.more();
    assert.equal(
      s.gateway.calls.filter((call) => call.method === 'feed').length,
      1,
    );
    assert.equal(
      s.view().continuation,
      loggedIn ? 'phone_verification_required' : 'login_required',
    );
  }
});
test('late campus resolution, category page and login generations cannot append old context', async () => {
  const s = feed();
  await s.controller.load();
  s.profiles.campusesImpl = async (query) => ({
    items: [campus(), campus({ id: otherId, fullName: '另一个合成校区' })],
    page: query.page,
    pageSize: query.pageSize,
    total: 2,
  });
  await s.controller.search();
  const late = deferred<Spaces>();
  s.gateway.spacesImpl = async (id) =>
    id === campusId
      ? late.promise
      : { regional: space({ id: otherId }), global: [] };
  const first = s.controller.chooseCampus(campusId);
  await flush();
  await s.controller.chooseCampus(otherId);
  late.resolve({ regional: space(), global: [] });
  await first;
  assert.equal(s.view().space?.id, otherId);
  assert.equal(s.view().posts[0]?.space.id, otherId);
  const page = deferred<Feed>();
  s.gateway.feedImpl = () => page.promise;
  const old = s.controller.setCategory('pets');
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  assert.equal(s.view().posts.length, 0);
  page.resolve({
    items: [post({ category: 'pets' })],
    nextCursor: null,
    continuation: 'end',
  });
  await old;
  assert.equal(s.view().posts.length, 0);
  assert.equal(s.view().loaded, false);
});
test('feed load-more deduplicates IDs and rejects nonadvancing cursors', async () => {
  const s = feed();
  s.gateway.feedImpl = async () => ({
    items: [post()],
    nextCursor: 'next',
    continuation: 'available',
  });
  await s.controller.load();
  s.gateway.feedImpl = async () => ({
    items: [post(), post({ id: otherId })],
    nextCursor: null,
    continuation: 'end',
  });
  await s.controller.more();
  assert.equal(s.view().posts.length, 2);
  await s.controller.refresh();
  assert.equal(s.view().posts.length, 2);
});
test('detail parent visibility gates comments and any later hidden/deleted outcome clears dependent content', async () => {
  const s = detail();
  s.gateway.postImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'POST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.load();
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'comments'),
    false,
  );
  assert.equal(s.view().post, null);
  s.gateway.postImpl = async () => post();
  await s.controller.load();
  assert.equal(s.view().comments.length, 1);
  s.gateway.postImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'POST_DELETED',
      httpStatus: 410,
    });
  };
  const pending = s.controller.load();
  assert.equal(s.view().post, null);
  assert.equal(s.view().comments.length, 0);
  await pending;
  assert.equal(s.view().loaded, false);
});
test('hidden parent during comment reads and stale detail completion never restore text or media', async () => {
  const s = detail();
  s.gateway.commentsImpl = async () => {
    throw new ClientError('http', 'safe', {
      serverCode: 'POST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await s.controller.load();
  assert.equal(s.view().post, null);
  assert.equal(s.view().comments.length, 0);
  const late = deferred<Post>();
  s.gateway.postImpl = () => late.promise;
  const pending = s.controller.load();
  await flush();
  s.controller.dispose();
  late.resolve(post());
  await pending;
  assert.equal(s.view().post, null);
  assert.equal(s.view().comments.length, 0);
});
test('durable like receipt triggers authoritative detail reconciliation without projecting historical state', async () => {
  const s = detail();
  await s.controller.load();
  let refresh: Promise<void> | undefined;
  const likes = new PostLikeMutationController(
    s.runtime,
    () => undefined,
    () => {
      refresh = s.controller.load();
    },
  );
  const late = deferred<PostLikeReceipt>();
  s.gateway.likeImpl = () => late.promise;
  const first = likes.setLiked(s.view().post!, true);
  await flush();
  await likes.setLiked(s.view().post!, true);
  await likes.setLiked(
    post({ viewer: { ...post().viewer, isLiked: true } }),
    false,
  );
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'like').length,
    1,
  );
  assert.equal(s.view().post?.viewer.isLiked, false);
  late.resolve({
    requestId,
    operation: 'set_post_like',
    postId,
    liked: true,
    outcome: 'applied',
  });
  await first;
  await refresh;
  // Current state has since changed; the old like receipt cannot resurrect it.
  assert.equal(s.view().post?.viewer.isLiked, false);
  assert.equal(s.view().post?.likeCount, 0);
  s.gateway.likeImpl = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await likes.setLiked(s.view().post!, true);
  assert.ok(s.runtime.pendingPostLikes.load(s.accountId));
  assert.equal(s.view().post?.viewer.isLiked, false);
  likes.dispose();
});
test('own deletion requires explicit confirmation and updates only after a known success', async () => {
  const s = detail();
  await s.controller.load();
  s.controller.requestDelete('comment', commentId);
  s.controller.dismissDelete();
  await s.controller.confirmDelete();
  assert.equal(
    s.gateway.calls.some((call) => call.method === 'deleteComment'),
    false,
  );
  const late = deferred<void>();
  s.gateway.deleteCommentImpl = () => late.promise;
  s.controller.requestDelete('comment', commentId);
  const pending = s.controller.confirmDelete();
  await flush();
  await s.controller.confirmDelete();
  assert.equal(s.view().comments.length, 1);
  late.resolve();
  await pending;
  assert.equal(s.view().comments.length, 0);
  assert.equal(s.view().post?.commentCount, 0);
  assert.equal(
    s.gateway.calls.filter((call) => call.method === 'deleteComment').length,
    1,
  );
  s.controller.requestDelete('post', postId);
  await s.controller.confirmDelete();
  assert.equal(s.view().post, null);
  assert.equal(s.view().comments.length, 0);
  assert.equal(s.view().status, '帖子已删除');
});
test('delete cancellation never claims success; auth terminal and account changes clear all private detail state', async () => {
  const s = detail();
  await s.controller.load();
  const late = deferred<void>();
  s.gateway.deletePostImpl = () => late.promise;
  s.controller.requestDelete('post', postId);
  const pending = s.controller.confirmDelete();
  await flush();
  s.controller.cancel();
  await pending;
  assert.equal(s.view().needsReload, true);
  assert.notEqual(s.view().status, '帖子已删除');
  late.resolve();
  await flush();
  assert.equal(s.view().post, null);
  await s.controller.load();
  s.gateway.likeImpl = async () => {
    throw new ClientError('forbidden', 'safe', {
      serverCode: 'ACCOUNT_BLOCKED',
      httpStatus: 403,
    });
  };
  const likes = new PostLikeMutationController(s.runtime, () => undefined);
  await likes.setLiked(s.view().post!, true);
  likes.dispose();
  assert.equal(s.view().post, null);
  assert.equal(s.sessions.snapshot().credentials, null);
});
test('own recovery list never fetches body/media and clears on account changes', async () => {
  const s = setup(),
    views: MineView[] = [];
  const controller = new MineController(s.runtime, (view) => views.push(view));
  await controller.load();
  assert.equal(views[views.length - 1]!.publications.length, 1);
  assert.equal(s.gateway.calls[0]?.method, 'mine');
  assert.equal(
    /text|images|author|accountId/.test(
      JSON.stringify(views[views.length - 1]!.publications),
    ),
    false,
  );
  s.sessions.logout();
  assert.equal(views[views.length - 1]!.publications.length, 0);
});
test('anonymous comment cannot expose its author through a named-parent isPostAuthor badge', async () => {
  const s = detail();
  s.gateway.postImpl = async () =>
    post({
      author: {
        kind: 'named',
        experienceDisplay: publicExperienceDisplay(),
        profileId: otherId,
        displayName: '合成公开作者',
        avatar: null,
      },
    });
  await s.controller.load();
  assert.equal(s.view().post, null);
  assert.equal(s.view().comments.length, 0);
  assert.equal(s.view().loaded, false);
});
test('resolved region remains visible before feed completion and unavailable feed does not erase explicit global choices', async () => {
  const s = feed(),
    late = deferred<Feed>();
  s.gateway.spacesImpl = async () => ({
    regional: space(),
    global: [space({ id: otherId, kind: 'global', operatingRegionId: null })],
  });
  s.gateway.feedImpl = () => late.promise;
  const pending = s.controller.load();
  await flush();
  assert.equal(s.view().space?.id, space().id);
  assert.equal(s.view().globalSpaces.length, 1);
  assert.equal(s.view().posts.length, 0);
  late.reject(
    new ClientError('http', 'safe', {
      serverCode: 'COMMUNITY_UNAVAILABLE',
      httpStatus: 503,
    }),
  );
  await pending;
  assert.equal(s.view().space?.id, space().id);
  assert.equal(s.view().globalSpaces.length, 1);
  assert.equal(s.view().posts.length, 0);
});
