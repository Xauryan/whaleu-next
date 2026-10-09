import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { CommunityRuntime } from '../src/community/runtime';
import { SafetyChanges } from '../src/community/safety-changes';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import type { Cancellation } from '../src/platform/contracts';
import type { CampusPage } from '../src/profile/contract';
import {
  RatingRandomController,
  type RatingRandomView,
} from '../src/ratings/random-controller';
import type { RatingRandomGateway } from '../src/ratings/random-gateway';
import type {
  RatingRandomQuery,
  RatingRandomResult,
} from '../src/ratings/random-contract';
import { setup } from './community-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import { campus, campusId } from './profile-helpers';
import {
  categoryId,
  emptySummary,
  harness as catalogHarness,
  otherId,
  regionId,
  summary,
  target,
  targetId,
} from './ratings-helpers';
import { randomResult } from './rating-random-helpers';

function harness() {
  const s = setup(),
    views: RatingRandomView[] = [];
  const calls: { query: RatingRandomQuery; cancel: Cancellation }[] = [];
  const fake: { draw: RatingRandomGateway['draw'] } = {
    draw: async (query) => randomResult(query),
  };
  const safetyChanges = new SafetyChanges(s.runtime.privateViews),
    directoryScopeChanges = new PrivateViewLifecycle(),
    browsingScopeChanges = new PrivateViewLifecycle();
  const runtime: CommunityRuntime = {
    ...s.runtime,
    safetyChanges,
    directoryScopeChanges,
    browsingScopeChanges,
    ratingRandom: {
      draw: (query, cancel) => {
        calls.push({ query, cancel });
        return fake.draw(query, cancel);
      },
    },
  };
  const controller = new RatingRandomController(runtime, (view) =>
    views.push(view),
  );
  controller.load({ categoryId });
  return {
    ...s,
    runtime,
    controller,
    calls,
    fake,
    views,
    view: () => views[views.length - 1]!,
    safetyChanges,
    directoryScopeChanges,
    browsingScopeChanges,
  };
}

test('random category entry carries category only even from regional catalog; load explicitly global and never auto-draws or reads preferences', async () => {
  const catalog = catalogHarness('catalog');
  catalog.ratings.categoriesImpl = async (r, parentId) => ({
    context: { regionId: r, parentId, catalogRevision: otherId },
    items: [],
    nextCursor: null,
    continuation: 'end',
  });
  catalog.ratings.targetsImpl = async (r, id) => ({
    context: { regionId: r, categoryId: id, catalogRevision: otherId },
    items: [],
    nextCursor: null,
    continuation: 'end',
  });
  await catalog.controller.load({ regionId, parentId: categoryId });
  assert.equal(
    catalog.controller.randomPath(categoryId),
    `/pages/rating-random/rating-random?categoryId=${categoryId}`,
  );
  assert.equal(catalog.controller.randomPath(otherId), null);
  catalog.controller.dispose();
  const s = harness();
  assert.equal(s.view().campus, null);
  assert.match(s.view().status, /当前仅全局/);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.profiles.calls, []);
  assert.deepEqual(s.gateway.calls, []);
  await s.controller.draw();
  assert.deepEqual(s.calls[0]!.query, { categoryId });
  assert.equal(
    s.controller.targetPath(),
    `/pages/rating-detail/rating-detail?targetId=${targetId}`,
  );
  assert.equal(s.storage.data.size, 0);
  s.controller.dispose();
});

test('explicit read-only campus picker uses physical campus id, never saves preference; returned region owns detail navigation', async () => {
  const s = harness();
  s.profiles.campusesImpl = async (query) => ({
    items: [campus({ id: campusId })],
    page: query.page,
    pageSize: query.pageSize,
    total: 1,
  });
  await s.controller.openCampusPicker();
  s.controller.chooseCampus(campusId);
  s.controller.setMinimumAverage('4.1');
  s.fake.draw = async (query) =>
    randomResult(query, {
      item: { regionId: otherId, target: target(), summary: summary(5) },
    });
  await s.controller.draw();
  assert.deepEqual(s.calls[0]!.query, {
    categoryId,
    campusId,
    minimumAverage: 4.1,
  });
  assert.equal(
    s.controller.targetPath(),
    `/pages/rating-detail/rating-detail?targetId=${targetId}&regionId=${otherId}`,
  );
  assert.deepEqual(
    s.profiles.calls.map((call) => call.method),
    ['campuses'],
  );
  s.controller.selectGlobal();
  assert.equal(s.view().result, null);
  assert.equal(s.view().campus, null);
  assert.equal(s.controller.targetPath(), null);
  s.controller.dispose();
});

test('each completed click requests a fresh full pool and allows repeated results; repeated in-flight clicks are coalesced', async () => {
  const s = harness(),
    response = deferred<RatingRandomResult>();
  s.fake.draw = async () => response.promise;
  const running = s.controller.draw();
  await Promise.all([s.controller.draw(), s.controller.draw()]);
  await flush();
  assert.equal(s.calls.length, 1);
  response.resolve(randomResult());
  await running;
  s.fake.draw = async (query) => randomResult(query);
  await s.controller.draw();
  assert.equal(s.calls.length, 2);
  assert.equal(s.view().result?.candidateCount, 100);
  assert.equal(s.view().result?.item?.target.id, targetId);
  s.controller.dispose();
});

for (const summaryState of [emptySummary(), { status: 'unavailable' } as const])
  test(`unrestricted ${summaryState.status} result is retained honestly without frontend filtering`, async () => {
    const s = harness();
    s.fake.draw = async (query) =>
      randomResult(query, {
        item: {
          regionId: null,
          target: target({
            allowedActions: {
              ...target().allowedActions,
              setScore: summaryState.status === 'known',
            },
          }),
          summary: summaryState,
        },
      });
    await s.controller.draw();
    assert.deepEqual(s.view().result?.item?.summary, summaryState);
    s.controller.dispose();
  });

test('known empty is distinct from authorization or score unavailable, neither reuses a prior result', async () => {
  const s = harness();
  await s.controller.draw();
  for (const code of [
    'RATING_SCORE_UNAVAILABLE',
    'RATING_UNAVAILABLE',
    'CONTENT_REVIEW_UNAVAILABLE',
  ]) {
    s.fake.draw = async () => {
      throw new ClientError('business', 'Synthetic unavailable', {
        serverCode: code,
        httpStatus: 503,
      });
    };
    await s.controller.draw();
    assert.equal(s.view().result, null);
    assert.ok(s.view().error);
    assert.equal(s.controller.targetPath(), null);
  }
  s.fake.draw = async (query) =>
    randomResult(query, { candidateCount: 0, item: null });
  await s.controller.draw();
  assert.equal(s.view().result?.candidateCount, 0);
  assert.match(s.view().status, /没有候选/);
  assert.equal(s.view().error, '');
  s.controller.dispose();
});

test('invalid minimum and protocol context fail without preserving previous success', async () => {
  const s = harness();
  await s.controller.draw();
  for (const value of [
    '0',
    '5.1',
    '4.11',
    ' 4 ',
    '4e0',
    '+4',
    'Infinity',
    '4.',
  ]) {
    s.controller.setMinimumAverage(value);
    await s.controller.draw();
    assert.equal(s.calls.length, 1);
    assert.equal(s.view().result, null);
    assert.ok(s.view().error);
  }
  s.controller.setMinimumAverage('4');
  s.fake.draw = async () => randomResult();
  await s.controller.draw();
  assert.equal(s.view().result, null);
  assert.match(s.view().error, /格式异常/);
  s.fake.draw = async () => {
    throw new ClientError('protocol', 'Invalid unavailable response', {
      serverCode: 'RATING_SCORE_UNAVAILABLE',
      httpStatus: 200,
    });
  };
  await s.controller.draw();
  assert.equal(s.view().result, null);
  assert.match(s.view().error, /格式异常/);
  s.controller.dispose();
});

for (const boundary of [
  'cancel',
  'hide',
  'root hide',
  'logout',
  'same-account login',
  'different-account login',
  'safety',
  'directory scope',
  'browsing scope',
  'new category',
  'new filter',
] as const)
  test(`${boundary} clears result and fences a late draw callback`, async () => {
    const s = harness(),
      response = deferred<RatingRandomResult>();
    await s.controller.draw();
    s.fake.draw = async () => response.promise;
    const running = s.controller.draw();
    await flush();
    assert.equal(s.view().result, null);
    if (boundary === 'cancel') s.controller.cancel();
    if (boundary === 'hide') s.controller.dispose();
    if (boundary === 'root hide') s.runtime.privateViews!.clear();
    if (boundary === 'logout')
      s.sessions.logoutIfCurrent(s.sessions.snapshot());
    if (boundary === 'same-account login')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    if (boundary === 'different-account login')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: otherId,
      });
    if (boundary === 'safety') s.safetyChanges.invalidate(s.accountId);
    if (boundary === 'directory scope') s.directoryScopeChanges.clear();
    if (boundary === 'browsing scope') s.browsingScopeChanges.clear();
    if (boundary === 'new category') s.controller.load({ categoryId: otherId });
    if (boundary === 'new filter') s.controller.setMinimumAverage('4');
    assert.equal(s.calls[s.calls.length - 1]!.cancel.isCancelled, true);
    const count = s.views.length;
    response.resolve(randomResult());
    await running;
    await flush();
    assert.equal(s.views.length, count);
    assert.equal(s.view().result, null);
    assert.equal(s.controller.targetPath(), null);
    s.controller.dispose();
  });

test('new request supersedes a cancelled request; old completion never replaces the new selection', async () => {
  const s = harness(),
    old = deferred<RatingRandomResult>();
  s.fake.draw = async () => old.promise;
  const running = s.controller.draw();
  await flush();
  s.controller.setMinimumAverage('4');
  s.fake.draw = async (query) =>
    randomResult(query, {
      item: {
        regionId: null,
        target: target({ id: otherId }),
        summary: summary(5),
      },
    });
  await s.controller.draw();
  old.resolve(randomResult());
  await running;
  assert.equal(s.view().result?.item?.target.id, otherId);
  s.controller.dispose();
});

test('campus search rejects stale rows on edits, paginates server-side and closes without applying late results', async () => {
  const s = harness();
  s.profiles.campusesImpl = async (query) => ({
    items: [campus()],
    page: query.page,
    pageSize: query.pageSize,
    total: 41,
  });
  await s.controller.openCampusPicker();
  assert.equal(s.view().hasNextCampuses, true);
  await s.controller.nextCampuses();
  assert.equal(s.view().campusPage, 2);
  assert.equal(s.view().hasPreviousCampuses, true);
  s.controller.setCampusSearch('campusQuery', 'new campus');
  assert.deepEqual(s.view().campuses, []);
  s.controller.chooseCampus(campusId);
  assert.equal(s.view().campus, null);
  const response = deferred<CampusPage>();
  s.profiles.campusesImpl = async () => response.promise;
  const running = s.controller.searchCampuses();
  await flush();
  s.controller.closeCampusPicker();
  response.resolve({ items: [campus()], page: 1, pageSize: 20, total: 1 });
  await running;
  assert.deepEqual(s.view().campuses, []);
  assert.equal(s.view().pickerOpen, false);
  assert.equal(s.view().campus, null);
  assert.ok(s.profiles.calls.every((call) => call.method === 'campuses'));
  s.controller.dispose();
});

test('loaded tracks only a completed current draw and resets on every private-result boundary', async () => {
  const s = harness();
  assert.equal(s.view().loaded, false);
  await s.controller.draw();
  assert.equal(s.view().loaded, true);
  s.controller.setMinimumAverage('4');
  assert.equal(s.view().loaded, false);
  s.fake.draw = async (query) =>
    randomResult(query, { candidateCount: 0, item: null });
  await s.controller.draw();
  assert.equal(
    s.view().loaded,
    true,
    'a proven empty result has completed loading',
  );
  s.controller.cancel();
  assert.equal(s.view().loaded, false);
  await s.controller.draw();
  s.controller.dispose();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().result, null);
});
