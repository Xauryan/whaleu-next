import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ActivityController,
  initialActivityView,
} from '../src/activities/controller';
import {
  ActivityVisitController,
  initialActivityVisitView,
} from '../src/activities/visit-controller';
import {
  ActivityPreferenceController,
  initialActivityPreferenceView,
} from '../src/activities/preference';
import { PendingActivityVisitStore } from '../src/activities/pending';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  activityHarness,
  activityId,
  deferred,
  detail,
  flush,
  otherRegion,
  page,
  receipt,
  regionId,
  token,
  visitIntent,
} from './activity-helpers';
const fail = (code: string, status = 503): ClientError =>
  new ClientError(status === 403 ? 'forbidden' : 'http', 'Synthetic error', {
    serverCode: code,
    httpStatus: status,
  });
test('fresh activity list requires explicit rendered callback; duplicates and detail cannot mark visits', async () => {
  const h = activityHarness();
  await Promise.all([h.controller.load(), h.controller.load()]);
  assert.equal(h.calls.filter((c) => c.method === 'list').length, 1);
  assert.equal(h.calls.filter((c) => c.method === 'visit').length, 0);
  h.controller.visible(h.view().renderKey);
  h.controller.visible(h.view().renderKey);
  await flush();
  assert.equal(h.calls.filter((c) => c.method === 'visit').length, 1);
  assert.equal(h.visit().confirmed, true);
  assert.equal(h.runtime.pendingActivityVisits.load(h.accountId), null);
  const d = activityHarness('detail');
  await d.controller.load({ regionId, activityId });
  d.controller.visible(d.view().renderKey);
  await flush();
  assert.equal(d.view().detail?.bodyText, detail().bodyText);
  assert.equal(d.calls.filter((c) => c.method === 'visit').length, 0);
  h.controller.dispose();
  h.visits.dispose();
  d.controller.dispose();
  d.visits.dispose();
});
test('unknown recommendation, denied, malformed and missing catalog do not become empty or acknowledge; explicit all is independent', async () => {
  for (const code of [
    'ACTIVITY_UNAVAILABLE',
    'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE',
    'PHONE_VERIFICATION_REQUIRED',
    'SAFETY_UNAVAILABLE',
  ]) {
    const h = activityHarness();
    h.behavior.list = async () => {
      throw fail(code);
    };
    await h.controller.load();
    h.controller.visible(h.view().renderKey);
    await flush();
    assert.equal(h.view().loaded, false);
    assert.equal(h.calls.filter((c) => c.method === 'visit').length, 0);
    assert.equal(
      h.view().entryUnavailable,
      code === 'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE',
    );
    h.behavior.list = async (_r, window) => {
      assert.equal(window, 'all');
      return page({ items: [], selection: { kind: 'all' } });
    };
    await h.controller.chooseAll();
    h.controller.visible(h.view().renderKey);
    await flush();
    assert.equal(h.view().loaded, true);
    assert.equal(h.visit().confirmed, true);
    h.controller.dispose();
    h.visits.dispose();
  }
  const h = activityHarness();
  h.behavior.list = async () => ({ ...page(), publisherId: otherRegion });
  await h.controller.load();
  assert.equal(h.view().loaded, false);
  h.controller.dispose();
  h.visits.dispose();
});
test('opaque Previous replays original first-entry selection after visit and rejects scope/selection/cursor changes', async () => {
  const h = activityHarness();
  h.behavior.list = async (_r, _w, cursor) =>
    cursor === token(2)
      ? page({ pageCursor: token(2) })
      : page({ continuation: 'more', nextCursor: token(2) });
  await h.controller.load();
  h.controller.visible(h.view().renderKey);
  await flush();
  await h.controller.next();
  assert.equal(h.view().pageNumber, 2);
  await h.controller.previous();
  assert.equal(h.view().pageNumber, 1);
  assert.deepEqual(
    h.calls.filter((c) => c.method === 'list').map((c) => c.args[2]),
    [null, token(2), token()],
  );
  assert.equal(h.view().selection?.kind, 'historical');
  h.behavior.list = async () =>
    page({ pageCursor: token(2), selection: { kind: 'all' } });
  await h.controller.next();
  assert.equal(h.view().loaded, false);
  assert.deepEqual(h.view().items, []);
  h.controller.dispose();
  h.visits.dispose();
});
test('deep link works without opener, rejects route tampering and rechecks current identity region', async () => {
  const h = activityHarness('detail');
  await h.controller.load({ regionId, activityId });
  assert.ok(h.view().detail);
  h.behavior.context = async () => ({
    regionId: otherRegion,
    visitHistory: 'visited',
  });
  await h.controller.refresh();
  assert.equal(h.view().detail, null);
  assert.match(h.view().error, /身份校区/);
  await h.controller.load({ regionId, activityId, snapshot: detail() });
  assert.equal(h.view().detail, null);
  assert.equal(h.calls.filter((c) => c.method === 'detail').length, 1);
  h.controller.dispose();
  h.visits.dispose();
});
test('hide, root hide, scope, Safety and same-account relogin invalidate late reads and render callbacks', async () => {
  for (const event of [
    'hide',
    'root',
    'scope',
    'safety',
    'relogin',
    'account',
  ]) {
    const h = activityHarness();
    await h.controller.load();
    const key = h.view().renderKey;
    const late = deferred<ReturnType<typeof page>>();
    h.behavior.list = async () => late.promise;
    const reading = h.controller.refresh();
    await flush();
    if (event === 'hide') h.controller.dispose();
    if (event === 'root') h.runtime.privateViews!.clear();
    if (event === 'scope') h.runtime.directoryScopeChanges.clear(h.accountId);
    if (event === 'safety') h.runtime.safetyChanges.invalidate(h.accountId);
    if (event === 'relogin' || event === 'account')
      h.sessions.completeLogin(h.sessions.beginLogin(), {
        ...wireCredentials(),
        ...(event === 'account' ? { accountId: otherRegion } : {}),
      });
    late.resolve(page());
    await reading;
    h.controller.visible(key);
    await flush();
    assert.equal(h.view().loaded, false, event);
    assert.deepEqual(h.view().items, [], event);
    assert.equal(h.calls.filter((c) => c.method === 'visit').length, 0, event);
    h.controller.dispose();
    h.visits.dispose();
  }
});
test('visit persists exact original intent after response loss, no content/cursor storage, explicit retry after same-account login', async () => {
  const h = activityHarness();
  h.behavior.visit = async () => {
    throw new ClientError('network', 'Lost response');
  };
  await h.controller.load();
  h.controller.visible(h.view().renderKey);
  await flush();
  assert.equal(h.visit().pending, true);
  const frozen = h.runtime.pendingActivityVisits.load(h.accountId)!;
  assert.deepEqual(Object.keys(frozen).sort(), [
    'accountId',
    'expectedCatalogRevision',
    'regionId',
    'requestId',
    'version',
  ]);
  h.controller.dispose();
  h.visits.dispose();
  h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials());
  let v = initialActivityVisitView();
  const recovery = new ActivityVisitController(h.runtime, (next) => {
    v = next;
  });
  recovery.restore();
  assert.equal(v.pending, true);
  assert.equal(h.calls.filter((c) => c.method === 'visit').length, 1);
  h.behavior.visit = async (original) => {
    assert.deepEqual(original, visitIntent());
    return receipt();
  };
  await Promise.all([recovery.retry(), recovery.retry()]);
  assert.equal(h.calls.filter((c) => c.method === 'visit').length, 2);
  assert.equal(v.confirmed, true);
  assert.equal(h.runtime.pendingActivityVisits.load(h.accountId), null);
  recovery.dispose();
});
test('visit uncertainty survives scope/hide and conflicts; definitive revision-changed settles without marking', async () => {
  for (const code of ['ACTIVITY_VISIT_CONFLICT', 'ACTIVITY_REVISION_CHANGED']) {
    const h = activityHarness();
    h.behavior.visit = async () => {
      throw fail(code, 409);
    };
    await h.controller.load();
    h.controller.visible(h.view().renderKey);
    await flush();
    assert.equal(h.visit().confirmed, false);
    assert.equal(
      !!h.runtime.pendingActivityVisits.load(h.accountId),
      code === 'ACTIVITY_VISIT_CONFLICT',
    );
    h.controller.dispose();
    h.visits.dispose();
  }
  const h = activityHarness(),
    late = deferred<ReturnType<typeof receipt>>();
  h.behavior.visit = async () => late.promise;
  await h.controller.load();
  h.controller.visible(h.view().renderKey);
  await flush();
  h.runtime.directoryScopeChanges.clear(h.accountId);
  late.resolve(receipt());
  await flush();
  assert.equal(h.visit().confirmed, false);
  assert.ok(h.runtime.pendingActivityVisits.load(h.accountId));
  h.controller.dispose();
  h.visits.dispose();
});
test('cancel before UUID completion sends nothing; another account cannot recover or inherit pending visit', async () => {
  const h = activityHarness(),
    random = deferred<string>();
  const runtime = { ...h.runtime, newRequestId: async () => random.promise };
  let v = initialActivityVisitView();
  const visits = new ActivityVisitController(runtime, (next) => {
    v = next;
  });
  const ack = visits.acknowledge(page().context);
  await flush();
  visits.dispose();
  random.resolve(visitIntent().requestId);
  await ack;
  assert.equal(h.calls.filter((c) => c.method === 'visit').length, 0);
  h.runtime.pendingActivityVisits.freeze({
    version: 1,
    accountId: h.accountId,
    ...visitIntent(),
  });
  h.sessions.completeLogin(h.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: otherRegion,
  });
  const other = new ActivityVisitController(h.runtime, (next) => {
    v = next;
  });
  other.restore();
  await other.retry();
  assert.equal(v.pending, false);
  assert.equal(h.calls.filter((c) => c.method === 'visit').length, 0);
  other.dispose();
  h.controller.dispose();
  h.visits.dispose();
});
test('visit storage verifies before dispatch and releases only exact matching receipt', () => {
  const store = new PendingActivityVisitStore(new MemoryStorage(), 'one'),
    h = activityHarness();
  const attempt = {
    version: 1 as const,
    accountId: h.accountId,
    ...visitIntent(),
  };
  store.freeze(attempt);
  assert.throws(() =>
    store.freeze({ ...attempt, expectedCatalogRevision: otherRegion }),
  );
  assert.throws(() =>
    store.settle(attempt, receipt({ regionId: otherRegion })),
  );
  assert.deepEqual(store.load(h.accountId), attempt);
  store.settle(attempt, receipt());
  assert.equal(store.load(h.accountId), null);
  h.controller.dispose();
  h.visits.dispose();
});
test('activity reminder reuses Profile revisions: save success, conflict reload, uncertainty and account clear', async () => {
  const h = activityHarness();
  let view = initialActivityPreferenceView();
  const pref = new ActivityPreferenceController(h.runtime, (next) => {
    view = next;
  });
  await pref.load();
  assert.equal(view.checked, true);
  pref.choose(false);
  await pref.save();
  assert.equal(view.checked, false);
  assert.equal(view.dirty, false);
  assert.equal(h.profiles.current.preferences.activitySubscribed, false);
  h.profiles.preferencesImpl = async () => {
    h.profiles.current = {
      ...h.profiles.current,
      revision: 9,
      preferences: {
        ...h.profiles.current.preferences,
        activitySubscribed: true,
        showHotTopic: false,
      },
    };
    throw fail('PROFILE_REVISION_CONFLICT', 409);
  };
  pref.choose(true);
  await pref.save();
  assert.equal(view.checked, true);
  assert.equal(view.dirty, false);
  assert.match(view.status, /核对/);
  assert.equal(h.profiles.current.preferences.showHotTopic, false);
  h.profiles.preferencesImpl = async () => {
    throw new ClientError('network', 'Lost save');
  };
  pref.choose(false);
  await pref.save();
  assert.equal(view.needsReload, true);
  assert.notEqual(view.status, '已保存');
  h.sessions.completeLogin(h.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: otherRegion,
  });
  assert.equal(view.loaded, false);
  assert.equal(view.checked, false);
  pref.dispose();
  h.controller.dispose();
  h.visits.dispose();
});
test('late render of old controller cannot acknowledge newer page generation', async () => {
  const h = activityHarness();
  let view = initialActivityView();
  let writes = 0;
  const controller = new ActivityController(
    h.runtime,
    'list',
    (next) => {
      view = next;
    },
    () => {
      writes++;
    },
  );
  await controller.load();
  const old = view.renderKey;
  await controller.refresh();
  controller.visible(old);
  assert.equal(writes, 0);
  controller.visible(view.renderKey);
  assert.equal(writes, 1);
  controller.dispose();
  h.controller.dispose();
  h.visits.dispose();
});
