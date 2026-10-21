import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowsingHistoryStore,
  HISTORY_LIMIT,
  HISTORY_RETENTION_MS,
} from '../src/browsing-history/store';
import {
  BrowsingHistoryController,
  type HistoryView,
} from '../src/browsing-history/controller';
import { historyObservationSink } from '../src/browsing-history/observer';
import { ViewObserver } from '../src/community/view-observer';
import { ClientError } from '../src/api/errors';
import type { WxApi } from '../src/platform/wechat';
import { setup, post, postId, otherId } from './community-helpers';
import { deferred, flush, FakeClock } from './helpers';
import { wireCredentials } from './identity-helpers';
function fixture() {
  const s = setup();
  let now = 1_800_000_000_000;
  const history = new BrowsingHistoryStore(
    s.sessions,
    s.storage,
    'synthetic-history',
    () => now,
  );
  let view: HistoryView;
  const controller = new BrowsingHistoryController(
    s.runtime,
    history,
    (next) => {
      view = next;
    },
  );
  return {
    ...s,
    history,
    controller,
    view: () => view!,
    tick: () => {
      now += 1;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test('history persists only IDs/times plus opaque session binding; reopens reorder and expiry/bounds apply', () => {
  const f = fixture(),
    owner = f.sessions.snapshot();
  assert.equal(f.history.record(postId, owner), true);
  f.tick();
  f.history.record(otherId, owner);
  f.tick();
  f.history.record(postId, owner);
  assert.deepEqual(
    f.history.list().map((e) => e.postId),
    [postId, otherId],
  );
  const saved = JSON.stringify([...f.storage.data.values()]);
  for (const secret of [
    wireCredentials().accountId,
    wireCredentials().sessionId,
    wireCredentials().accessToken,
    post().author.displayName,
    post().text,
  ])
    assert.equal(saved.includes(secret), false);
  for (let i = 0; i < 230; i++) {
    f.tick();
    f.history.record(
      `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      owner,
    );
  }
  assert.equal(f.history.list().length, HISTORY_LIMIT);
  f.advance(HISTORY_RETENTION_MS);
  assert.deepEqual(f.history.list(), []);
});
test('logout/account switch clears history and rejects old callbacks; refresh preserves it', () => {
  const f = fixture(),
    owner = f.sessions.snapshot();
  f.history.record(postId, owner);
  f.sessions.rotate(owner, wireCredentials('b'));
  assert.equal(f.history.list().length, 1);
  f.sessions.logout();
  assert.equal(f.storage.data.size, 0);
  assert.equal(f.history.record(otherId, owner), false);
  f.sessions.completeLogin(f.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: otherId,
  });
  assert.deepEqual(f.history.list(), []);
});
test('write and delete failures fail closed, no false clear success', async () => {
  const f = fixture();
  f.storage.failWrite = true;
  assert.equal(f.history.record(postId, f.sessions.snapshot()), false);
  f.storage.failWrite = false;
  f.history.record(postId, f.sessions.snapshot());
  await f.controller.load();
  f.storage.failWrite = true;
  f.storage.failRemove = true;
  f.controller.requestClear();
  f.controller.clear();
  assert.equal(f.view().items.length, 0);
  assert.match(f.view().error, /清理失败/);
  assert.throws(() => f.history.list());
  f.sessions.logout();
  f.sessions.completeLogin(f.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: otherId,
  });
  assert.throws(() => f.history.list());
  f.storage.failWrite = false;
  f.storage.failRemove = false;
  f.controller.requestClear();
  f.controller.clear();
  assert.equal(f.view().status, '本机浏览记录已清空');
});
test('current authorized summaries only; deleted and blocked targets hidden, no data cached', async () => {
  const f = fixture();
  f.history.record(postId, f.sessions.snapshot());
  f.tick();
  f.history.record(otherId, f.sessions.snapshot());
  f.gateway.postImpl = async (id) => {
    if (id === otherId)
      throw new ClientError('forbidden', 'Blocked', {
        serverCode: 'POST_BLOCKED_BY_YOU',
      });
    return post({ text: '当前可查看摘要' });
  };
  await f.controller.load();
  assert.deepEqual(
    f.view().items.map((x) => x.summary),
    ['当前可查看摘要'],
  );
  f.gateway.postImpl = async () => {
    throw new ClientError('business', 'Deleted', {
      serverCode: 'POST_DELETED',
    });
  };
  await f.controller.load();
  assert.deepEqual(f.view().items, []);
  assert.equal(
    JSON.stringify([...f.storage.data.values()]).includes('当前可查看摘要'),
    false,
  );
});
test('network failure clears displayed content and does not mark history as empty success', async () => {
  const f = fixture();
  f.history.record(postId, f.sessions.snapshot());
  await f.controller.load();
  assert.equal(f.view().items.length, 1);
  f.gateway.postImpl = async () => {
    throw new ClientError('network', 'Offline');
  };
  await f.controller.load();
  assert.equal(f.view().items.length, 0);
  assert.equal(f.view().loaded, false);
});
test('late callbacks after account switch or page hide cannot expose previews', async () => {
  for (const hide of [false, true]) {
    const f = fixture();
    f.history.record(postId, f.sessions.snapshot());
    const pending = deferred<ReturnType<typeof post>>();
    f.gateway.postImpl = async () => pending.promise;
    const loading = f.controller.load();
    await flush();
    if (hide) f.controller.dispose();
    else f.sessions.logout();
    pending.resolve(post({ text: 'must never render' }));
    await loading;
    assert.deepEqual(f.view().items, []);
  }
});
test('paginated history re-fetches current summaries on previous/reopen; clear needs explicit confirmation', async () => {
  const f = fixture();
  for (let i = 0; i < 21; i++) {
    f.tick();
    f.history.record(
      `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      f.sessions.snapshot(),
    );
  }
  f.gateway.postImpl = async (id) => post({ id });
  await f.controller.load();
  assert.equal(f.view().items.length, 20);
  assert.equal(f.view().canMore, true);
  await f.controller.more();
  assert.equal(f.view().items.length, 1);
  assert.equal(f.view().page, 2);
  await f.controller.previous();
  assert.equal(f.view().items.length, 20);
  f.controller.clear();
  assert.equal(f.history.list().length, 21);
  f.controller.requestClear();
  f.controller.dismissClear();
  f.controller.clear();
  assert.equal(f.history.list().length, 21);
  f.controller.requestClear();
  f.controller.clear();
  assert.deepEqual(f.history.list(), []);
});
test('only committed visible detail visits record; no speculative render, feed exposure, hide or stale account', () => {
  const f = fixture(),
    clock = new FakeClock();
  let visibility: ((result: { intersectionRatio: number }) => void) | undefined;
  const platform: Pick<WxApi, 'createIntersectionObserver' | 'nextTick'> = {
    nextTick: (fn) => fn(),
    createIntersectionObserver: () => ({
      relativeToViewport() {
        return this;
      },
      observe: (_selector, callback) => {
        visibility = callback;
      },
      disconnect: () => undefined,
    }),
  };
  const sink = historyObservationSink(f.sessions, f.history);
  sink.observe('list_exposure', postId, f.sessions.snapshot());
  assert.deepEqual(f.history.list(), []);
  const observer = new ViewObserver(platform, {}, clock, sink, 'detail_visit');
  const committed = observer.render([postId]);
  assert.equal(visibility, undefined);
  assert.deepEqual(f.history.list(), []);
  committed();
  visibility!({ intersectionRatio: 0 });
  assert.deepEqual(f.history.list(), []);
  visibility!({ intersectionRatio: 1 });
  assert.equal(f.history.list().length, 1);
  f.controller.requestClear();
  f.controller.clear();
  observer.dispose();
  visibility!({ intersectionRatio: 1 });
  assert.deepEqual(f.history.list(), []);
});

test('malformed local payloads are discarded, and another restored session cannot adopt old history', () => {
  const f = fixture();
  f.history.record(postId, f.sessions.snapshot());
  const key = [...f.storage.data.keys()][0]!;
  const original = f.storage.data.get(key);
  f.storage.data.set(key, {
    version: 1,
    binding: 'unknown',
    entries: [{ postId, viewedAt: 1, author: 'not allowed' }],
  });
  assert.deepEqual(f.history.list(), []);
  assert.equal(f.storage.data.size, 0);
  f.storage.data.set(key, original);
  const other = setup();
  other.sessions.logout();
  other.sessions.completeLogin(other.sessions.beginLogin(), {
    ...wireCredentials(),
    sessionId: otherId,
  });
  const restored = new BrowsingHistoryStore(
    other.sessions,
    f.storage,
    'synthetic-history',
    () => 1_800_000_000_001,
  );
  assert.deepEqual(restored.list(), []);
  assert.equal(f.storage.data.size, 0);
});
