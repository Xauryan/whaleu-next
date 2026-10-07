import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityGateway } from '../src/community/gateway';
import {
  decodeSavedList,
  type SavedEntry,
  type SavedList,
} from '../src/community/saved-contract';
import {
  SavedController,
  type SavedView,
} from '../src/pages/community-saved/controller';
import type { Cancellation } from '../src/platform/contracts';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  createdAt,
  formationPost,
  otherId,
  pollPost,
  post,
  postId,
  requestId,
  setup,
  tradingPost,
  tradingView,
} from './community-helpers';

const entry = (id = postId, epoch = otherId, value = post()): SavedEntry => ({
  post: {
    ...value,
    id,
    component:
      value.component.kind === 'poll'
        ? { ...value.component, poll: { ...value.component.poll, postId: id } }
        : value.component.kind === 'formation'
          ? {
              ...value.component,
              formation: { ...value.component.formation, postId: id },
            }
          : value.component,
    saveCount: 1,
    viewer: {
      ...value.viewer,
      isSaved: true,
      canSave: true,
      canSetUpdatePreference: true,
    },
  },
  savedAt: createdAt,
  saveEpochId: epoch,
});
const result = (
  items: readonly SavedEntry[] = [entry()],
  nextCursor: string | null = null,
  visibleSavedCount = items.length,
): SavedList => ({ items, nextCursor, visibleSavedCount });
function harness(loggedIn = true) {
  const s = setup(loggedIn),
    views: SavedView[] = [],
    requests: { after: string | null; cancel: Cancellation }[] = [];
  const behavior: { saved: CommunityGateway['saved'] } = {
    saved: async () => result(),
  };
  const gateway = Object.assign(s.gateway, {
    saved: (...args: Parameters<CommunityGateway['saved']>) => {
      requests.push({ after: args[0], cancel: args[1] });
      return behavior.saved(...args);
    },
  });
  const controller = new SavedController({ ...s.runtime, gateway }, (view) =>
    views.push(view),
  );
  return {
    ...s,
    gateway,
    controller,
    behavior,
    requests,
    view: () => views[views.length - 1]!,
  };
}

test('Saved browsing includes readable cross-campus, urgent/resolved trading, poll and formation summaries with no contact hydration', async () => {
  const s = harness();
  const rows = [
    entry(),
    entry(
      otherId,
      requestId,
      tradingPost({
        space: { id: otherId, kind: 'regional', name: 'other entitled scope' },
        trading: tradingView({ urgency: 'urgent', resolution: 'resolved' }),
      }),
    ),
    entry(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pollPost(),
    ),
    entry(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      formationPost(),
    ),
  ];
  assert.deepEqual(decodeSavedList(result(rows)), result(rows));
  s.behavior.saved = async () => result(rows, null, 4);
  await s.controller.load();
  assert.deepEqual(s.view().items, rows);
  assert.equal(s.view().visibleSavedCount, 4);
  assert.equal(s.view().items[1]!.post.trading?.urgency, 'urgent');
  assert.equal(s.view().items[1]!.post.trading?.resolution, 'resolved');
  assert.equal(s.view().canLoadMore, false);
  assert.deepEqual(
    s.requests.map((r) => r.after),
    [null],
  );
  assert.equal(s.gateway.calls.length, 0);
  assert.equal(JSON.stringify(s.view()).includes('synthetic-wechat'), false);
  await s.controller.more();
  assert.equal(s.requests.length, 1);
});

test('Saved guest and unconfigured runtime fail closed without reading account-owned list or counts', async () => {
  const guest = harness(false);
  await guest.controller.load();
  await guest.controller.more();
  assert.equal(guest.requests.length, 0);
  assert.deepEqual(guest.view().items, []);
  assert.equal(guest.view().visibleSavedCount, 0);
  const s = setup(),
    views: SavedView[] = [];
  const unavailable = new SavedController(
    { ...s.runtime, gateway: undefined },
    (view) => views.push(view),
  );
  await unavailable.load();
  assert.equal(views[views.length - 1]!.configured, false);
  assert.equal(views[views.length - 1]!.loaded, false);
});

test('Saved pagination deduplicates re-saved posts by ID, preserves loaded order and refresh restores newest epochs', async () => {
  const s = harness(),
    first = entry();
  s.behavior.saved = async () => result([first], 'next_cursor', 2);
  await s.controller.load();
  const moved = {
      ...entry(postId, requestId),
      savedAt: '2026-10-07T01:00:00.000Z',
    },
    second = entry(otherId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  s.behavior.saved = async () => result([moved, second], null, 2);
  await s.controller.more();
  assert.deepEqual(
    s.requests.map((r) => r.after),
    [null, 'next_cursor'],
  );
  assert.deepEqual(
    s.view().items.map((item) => item.post.id),
    [postId, otherId],
  );
  assert.equal(s.view().items[0]!.saveEpochId, requestId);
  assert.equal(s.view().visibleSavedCount, 2);
  assert.equal(s.view().canLoadMore, false);
  await s.controller.more();
  assert.equal(s.requests.length, 2);
  s.behavior.saved = async () => result([second, moved]);
  await s.controller.load();
  assert.equal(s.requests[2]!.after, null);
  assert.deepEqual(
    s.view().items.map((item) => item.post.id),
    [otherId, postId],
  );
});

test('transient append failure preserves loaded cards/count/cursor and explicit retry neither loses nor duplicates rows', async () => {
  const s = harness(),
    first = entry(),
    second = entry(otherId, requestId);
  s.behavior.saved = async () => result([first], 'retry_cursor', 2);
  await s.controller.load();
  s.behavior.saved = async () => {
    throw new ClientError('timeout', 'safe');
  };
  await s.controller.more();
  assert.deepEqual(s.view().items, [first]);
  assert.equal(s.view().visibleSavedCount, 2);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().canLoadMore, true);
  assert.ok(s.view().error);
  s.behavior.saved = async () => result([first, second]);
  await s.controller.more();
  assert.deepEqual(
    s.requests.map((r) => r.after),
    [null, 'retry_cursor', 'retry_cursor'],
  );
  assert.deepEqual(s.view().items, [first, second]);
  assert.equal(s.view().error, '');
});

test('empty current result clears counts honestly; a failed refresh does not retain older private cards', async () => {
  const s = harness();
  await s.controller.load();
  assert.equal(s.view().items.length, 1);
  s.behavior.saved = async () => result([], null, 0);
  await s.controller.load();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().visibleSavedCount, 0);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().canLoadMore, false);
  s.behavior.saved = async () => {
    throw new ClientError('network', 'safe');
  };
  await s.controller.load();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().visibleSavedCount, 0);
  assert.equal(s.view().loaded, false);
});

test('append privacy and authority failures clear the entire loaded Saved window and visible count', async () => {
  for (const failure of [
    new ClientError('forbidden', 'safe', {
      httpStatus: 403,
      serverCode: 'COMMUNITY_ACTION_RESTRICTED',
    }),
    new ClientError('auth-required', 'safe', {
      httpStatus: 401,
      serverCode: 'SESSION_REVOKED',
    }),
    new ClientError('auth-expired', 'safe'),
    new ClientError('http', 'safe', {
      httpStatus: 503,
      serverCode: 'COMMUNITY_UNAVAILABLE',
    }),
    new ClientError('business', 'safe', {
      httpStatus: 409,
      serverCode: 'COMMUNITY_SCOPE_UNAVAILABLE',
    }),
  ]) {
    const s = harness();
    s.behavior.saved = async () => result([entry()], 'private_cursor', 3);
    await s.controller.load();
    s.behavior.saved = async () => {
      throw failure;
    };
    await s.controller.more();
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().visibleSavedCount, 0);
    assert.equal(s.view().canLoadMore, false);
    assert.equal(s.view().loaded, false);
    await s.controller.more();
    assert.equal(s.requests.length, 2);
  }
});

test('a replacement refresh cancels older append and ignores its late cards, totals and cursor', async () => {
  const s = harness(),
    old = deferred<SavedList>();
  s.behavior.saved = async () => result([entry()], 'old_cursor', 2);
  await s.controller.load();
  s.behavior.saved = () => old.promise;
  const appending = s.controller.more();
  await flush();
  const oldCancel = s.requests[1]!.cancel;
  const fresh = entry(otherId, requestId);
  s.behavior.saved = async () => result([fresh]);
  await s.controller.load();
  assert.equal(oldCancel.isCancelled, true);
  old.resolve(result([entry()], 'stale_cursor', 100));
  await appending;
  assert.deepEqual(s.view().items, [fresh]);
  assert.equal(s.view().visibleSavedCount, 1);
  assert.equal(s.view().canLoadMore, false);
});

test('repeated load-more never duplicates dispatch and a stalled cursor never appends unchecked data', async () => {
  const s = harness(),
    pending = deferred<SavedList>();
  s.behavior.saved = async () => result([entry()], 'same_cursor', 2);
  await s.controller.load();
  s.behavior.saved = () => pending.promise;
  const running = s.controller.more();
  await s.controller.more();
  await flush();
  assert.equal(s.requests.length, 2);
  pending.resolve(result([entry(otherId, requestId)], 'same_cursor', 2));
  await running;
  assert.deepEqual(
    s.view().items.map((item) => item.post.id),
    [postId],
  );
  assert.ok(s.view().error);
  assert.equal(s.requests.length, 2);
});

for (const lifecycle of [
  'cancel',
  'dispose',
  'app-hide',
  'logout',
  'same-account',
  'switch-account',
] as const) {
  test(`Saved list ${lifecycle} invalidates late private cards and badge counts`, async () => {
    const s = harness(),
      pending = deferred<SavedList>();
    s.behavior.saved = () => pending.promise;
    const running = s.controller.load();
    await flush();
    if (lifecycle === 'cancel') s.controller.cancel();
    else if (lifecycle === 'dispose') s.controller.dispose();
    else if (lifecycle === 'app-hide') s.runtime.privateViews!.clear();
    else if (lifecycle === 'logout') s.sessions.logout();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: lifecycle === 'same-account' ? s.accountId : otherId,
      });
    assert.equal(s.requests[0]!.cancel.isCancelled, true);
    pending.resolve(result([entry()], 'late_cursor', 44));
    await running;
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().visibleSavedCount, 0);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().canLoadMore, false);
  });
}

test('same-session token rotation preserves authorized Saved read while account switch clears an already loaded window', async () => {
  const s = harness(),
    pending = deferred<SavedList>();
  s.behavior.saved = () => pending.promise;
  const running = s.controller.load();
  await flush();
  s.sessions.rotate(s.sessions.snapshot(), wireCredentials('b'));
  pending.resolve(result());
  await running;
  assert.equal(s.view().items.length, 1);
  assert.equal(s.view().visibleSavedCount, 1);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('c'),
    accountId: otherId,
  });
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().visibleSavedCount, 0);
  assert.equal(s.view().loaded, false);
});
