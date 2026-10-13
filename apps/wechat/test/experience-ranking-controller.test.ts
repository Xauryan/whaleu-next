import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { ExperienceRanking } from '../src/experience/ranking-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  rankingHarness,
  rankingItem,
  rankingPage,
} from './experience-ranking-helpers';
test('guest list retains service order and scan_limited empty never claims population exhaustion', async () => {
  const s = rankingHarness(false);
  s.behavior.ranking = async () =>
    rankingPage({ items: [rankingItem(2), rankingItem(1)] });
  await s.controller.load();
  assert.deepEqual(
    s.view().items.map((x) => x.profileId),
    [rankingItem(2).profileId, rankingItem(1).profileId],
  );
  assert.equal(s.view().hasSession, false);
  s.behavior.ranking = async () =>
    rankingPage({ items: [], selectionStatus: 'scan_limited' });
  await s.controller.load();
  assert.match(s.view().status, /未完整查看/);
  assert.equal(s.view().populationCompleteness, 'incomplete');
  s.controller.dispose();
});
test('new refresh, cancellation and dispose reject late successes/errors without retaining old cards', async () => {
  for (const finish of ['refresh', 'cancel', 'dispose'] as const) {
    const s = rankingHarness(),
      delayed = deferred<ExperienceRanking>();
    s.behavior.ranking = () => delayed.promise;
    const old = s.controller.load();
    await flush();
    if (finish === 'refresh') {
      s.behavior.ranking = async () => rankingPage({ items: [rankingItem(2)] });
      await s.controller.load();
    } else if (finish === 'cancel') s.controller.cancel();
    else s.controller.dispose();
    assert.equal(s.calls[0]![0].isCancelled, true);
    delayed.resolve(rankingPage());
    await old;
    assert.deepEqual(
      s.view().items.map((x) => x.profileId),
      finish === 'refresh' ? [rankingItem(2).profileId] : [],
    );
    s.controller.dispose();
  }
});
test('same-account re-login, account change and logout immediately clear and fence late callbacks', async () => {
  for (const transition of ['same', 'other', 'logout'] as const) {
    const s = rankingHarness();
    await s.controller.load();
    const delayed = deferred<ExperienceRanking>();
    s.behavior.ranking = () => delayed.promise;
    const old = s.controller.load();
    await flush();
    if (transition === 'logout') s.sessions.logout();
    else {
      const credential = wireCredentials();
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...credential,
        accountId:
          transition === 'other'
            ? '33333333-3333-4333-8333-333333333333'
            : credential.accountId,
      });
    }
    assert.equal(s.view().loaded, false);
    assert.deepEqual(s.view().items, []);
    delayed.reject(new Error('private account data'));
    await old;
    assert.deepEqual(s.view().items, []);
    assert.doesNotMatch(s.view().error, /private account data/);
    s.controller.dispose();
  }
});
test('network, protocol, permission and service failures clear cards and allow explicit retry', async () => {
  for (const failure of [
    new ClientError('network', 'private'),
    new ClientError('protocol', 'private'),
    new ClientError('forbidden', 'private', { httpStatus: 403 }),
    new ClientError('business', 'private', {
      httpStatus: 503,
      serverCode: 'EXPERIENCE_RANKING_UNAVAILABLE',
    }),
  ]) {
    const s = rankingHarness();
    await s.controller.load();
    s.behavior.ranking = async () => {
      throw failure;
    };
    await s.controller.load();
    assert.deepEqual(s.view().items, []);
    assert.equal(s.view().loaded, false);
    assert.doesNotMatch(s.view().error, /private/);
    s.behavior.ranking = async () => rankingPage();
    await s.controller.load();
    assert.equal(s.view().loaded, true);
    s.controller.dispose();
  }
});
test('root hide clears immediately and read-only list never touches persistence', async () => {
  const s = rankingHarness(),
    before = [...s.storage.data];
  await s.controller.load();
  s.runtime.privateViews!.clear();
  assert.deepEqual(s.view().items, []);
  assert.deepEqual([...s.storage.data], before);
  s.controller.dispose();
});

test('safety invalidation clears old cards before the fresh bounded read and ignores late pre-change success', async () => {
  const s = rankingHarness();
  await s.controller.load();
  const old = deferred<ExperienceRanking>();
  s.behavior.ranking = () => old.promise;
  const waiting = s.controller.load();
  await flush();
  const fresh = deferred<ExperienceRanking>();
  s.behavior.ranking = () => fresh.promise;
  s.runtime.safetyChanges.invalidate(s.accountId);
  assert.deepEqual(s.view().items, []);
  await flush();
  old.resolve(rankingPage());
  await waiting;
  assert.deepEqual(s.view().items, []);
  fresh.resolve(rankingPage({ items: [rankingItem(2)] }));
  await flush();
  assert.deepEqual(
    s.view().items.map((item) => item.profileId),
    [rankingItem(2).profileId],
  );
  s.controller.dispose();
});

test('safety change removes already displayed cards immediately, before an unavailable reauthorization finishes', async () => {
  const s = rankingHarness();
  await s.controller.load();
  assert.equal(s.view().items.length, 1);
  const fresh = deferred<ExperienceRanking>();
  s.behavior.ranking = () => fresh.promise;
  s.runtime.safetyChanges.invalidate(s.accountId);
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().loaded, false);
  await flush();
  fresh.reject(new ClientError('forbidden', 'Synthetic private content'));
  await flush();
  assert.deepEqual(s.view().items, []);
  assert.equal(s.view().loaded, false);
  assert.doesNotMatch(s.view().error, /private content/);
  s.controller.dispose();
});
