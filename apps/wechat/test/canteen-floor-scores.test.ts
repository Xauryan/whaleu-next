import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  FloorRatingController,
  type FloorRatingView,
} from '../src/canteen-floor-scores/controller';
import {
  decodeFloorSetScore,
  decodeFloorReceipt,
  decodeFloorSummary,
  decodeFloorDetail,
  matchFloorReceipt,
} from '../src/canteen-floor-scores/contract';
import { PendingFloorRatingStore } from '../src/canteen-floor-scores/pending';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  floorHarness,
  choose,
  command,
  detail,
  receipt,
  cancelled,
  floorId,
  canteenId,
} from './canteen-floor-scores-helpers';
test('strict scalar decoder preserves fractions and rejects coercion, extra authority, mutable or mixed-scale data', () => {
  for (const score of [1, 5, 1.25, 4.75, Math.PI, 1.0000000000000002])
    assert.equal(decodeFloorSetScore(command({ score })).score, score);
  for (const score of [-10, 0, 5.01, '4.75', true, null, Infinity, NaN])
    assert.throws(() => decodeFloorSetScore({ ...command(), score }));
  assert.throws(() =>
    decodeFloorSetScore({ ...command(), expectedOwnScoreRevision: null }),
  );
  assert.throws(() => decodeFloorReceipt({ ...receipt(), outcome: 'noop' }));
  assert.throws(() =>
    decodeFloorSummary({ kind: 'known', ratingCount: 0, mean: 0 }),
  );
  assert.throws(() =>
    decodeFloorSummary({ kind: 'unavailable', ratingCount: 0 }),
  );
  assert.throws(() => decodeFloorDetail({ ...detail(), actorId: floorId }));
  assert.throws(() =>
    matchFloorReceipt(floorId, command({ score: 1.25 }), receipt()),
  );
});
test('floor picker preserves raw identity; decimal explicit confirmation is immutable and only one active native score can be sent', async () => {
  const list = floorHarness('catalog');
  await list.controller.load();
  assert.equal(list.view().loaded, true);
  list.controller.toggleCanteen(canteenId);
  list.controller.setFloor(floorId);
  assert.equal(list.view().floorDraft, floorId);
  assert.match(list.controller.detailPath(floorId)!, /floorId=/);
  const s = floorHarness();
  await s.controller.load(floorId);
  s.controller.chooseScore(1.25);
  s.controller.chooseScore(null);
  assert.equal(s.view().selectedScore, null);
  choose(s, 1.25);
  s.controller.chooseScore(5);
  assert.equal(s.view().selectedScore, 1.25);
  await Promise.all([s.controller.submit(), s.controller.submit()]);
  assert.deepEqual(s.commands, [command({ score: 1.25 })]);
  assert.equal(s.view().canScore, false);
  choose(s, 4.75);
  await s.controller.submit();
  assert.equal(s.commands.length, 1);
});
test('journal readback precedes transport; storage failure cannot send and origin mismatch fails closed', async () => {
  const s = floorHarness();
  await s.controller.load(floorId);
  choose(s);
  s.storage.failWrite = true;
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  const t = floorHarness();
  await t.controller.load(floorId);
  choose(t);
  t.impl.submit = async (_id, c) => {
    assert.deepEqual(t.pendingFloorRatings.load(t.accountId)?.command, c);
    throw new ClientError('network', 'Lost');
  };
  await t.controller.submit();
  assert.equal(t.view().frozen, true);
  assert.equal(
    new PendingFloorRatingStore(t.storage, 'another-origin').load(t.accountId),
    null,
  );
});
test('restart receipt-first recovery preserves exact original decimal and never turns historical receipt into current state', async () => {
  const s = floorHarness();
  await s.controller.load(floorId);
  choose(s, Math.PI);
  s.impl.submit = async () => {
    throw new ClientError('network', 'Lost');
  };
  await s.controller.submit();
  s.controller.dispose();
  const views: FloorRatingView[] = [],
    restarted = new FloorRatingController(s.runtime, 'detail', (v) =>
      views.push(v),
    );
  await restarted.load(floorId);
  await restarted.recover(true);
  assert.deepEqual(s.calls.slice(-2), ['receipt', 'submit']);
  assert.equal(s.ids.count, 1);
  assert.deepEqual(s.commands[0], s.commands[1]);
  s.impl.receipt = async () => receipt(command({ score: Math.PI }));
  s.impl.detail = async () => {
    throw new ClientError('http', 'Withdrawn', {
      httpStatus: 503,
      serverCode: 'WINDOW_CATALOG_UNAVAILABLE',
    });
  };
  await restarted.recover();
  assert.equal(s.pendingFloorRatings.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.detail, null);
  assert.match(views[views.length - 1]!.receiptStatus, /历史回执/);
});
test('durable cancellation confirmation survives response loss; retry never resubmits cancelled score', async () => {
  const s = floorHarness();
  s.pendingFloorRatings.freeze(s.pending());
  await s.controller.load(floorId);
  await s.controller.confirmCancellation();
  assert.equal(s.calls.includes('cancel'), false);
  await s.controller.recover(false, true);
  assert.equal(s.view().confirming, 'cancel');
  s.impl.cancel = async () => {
    throw new ClientError('network', 'Lost cancellation');
  };
  await s.controller.confirmCancellation();
  assert.equal(s.pendingFloorRatings.load(s.accountId)!.phase, 'cancel');
  s.controller.dispose();
  const restarted = new FloorRatingController(s.runtime, 'detail', () => {});
  await restarted.load(floorId);
  s.impl.cancel = async () => cancelled();
  await restarted.recover(true);
  assert.equal(s.commands.length, 0);
  assert.equal(s.pendingFloorRatings.load(s.accountId), null);
});
test('unknown source and own history do not unlock fresh writes; only genuine missing receipt permits exact retry', async () => {
  const s = floorHarness();
  s.impl.detail = async () =>
    detail({
      myScore: { kind: 'unavailable' },
      floor: { ...detail().floor, summary: { kind: 'unavailable' } },
    });
  await s.controller.load(floorId);
  assert.equal(s.view().canScore, false);
  for (const error of [
    new ClientError('protocol', 'Bad', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
    new ClientError('http', 'Unavailable', {
      httpStatus: 503,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
  ]) {
    const t = floorHarness();
    t.pendingFloorRatings.freeze(t.pending());
    await t.controller.load(floorId);
    t.impl.receipt = async () => {
      throw error;
    };
    await t.controller.recover(true);
    assert.equal(t.commands.length, 0);
    assert.equal(t.view().frozen, true);
  }
});
test('hide/account change and late reads cannot expose old private floor state', async () => {
  const s = floorHarness(),
    held = deferred<ReturnType<typeof detail>>();
  s.impl.detail = () => held.promise;
  const loading = s.controller.load(floorId);
  await flush();
  s.controller.dispose();
  held.resolve(detail());
  await loading;
  assert.equal(s.view().detail, null);
  const t = floorHarness();
  await t.controller.load(floorId);
  choose(t);
  t.sessions.completeLogin(t.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: '66666666-6666-4666-8666-666666666666',
  });
  assert.equal(t.view().detail, null);
  await t.controller.submit();
  assert.equal(t.commands.length, 0);
});
