import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  DishRecommendationController,
  type DishRecommendationView,
} from '../src/dish-recommendations/controller';
import { dishIdentity } from '../src/dish-recommendations/contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  cancelled,
  choose,
  command,
  dishHarness,
  id,
  missing,
  otherId,
  own,
  page,
  receipt,
  recommend,
  retract,
  scoreRevision,
} from './dish-recommendations-helpers';
test('explicit own lookup and confirmation, repeat tap serialization, retract/reactivate new CAS versions', async () => {
  const s = dishHarness();
  await s.controller.load(id);
  s.controller.setName('0');
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  await choose(s, '0');
  s.controller.setName('changed');
  await Promise.all([s.controller.submit(), s.controller.submit()]);
  assert.equal(s.commands.length, 1);
  assert.equal(s.commands[0]!.dishName, '0');
  assert.equal(s.view().canRecommend, false);
  assert.equal(s.view().canRetract, true);
  s.ids.next = async () => otherId;
  await choose(s, '0', 'retract');
  await s.controller.submit();
  assert.equal(s.commands[1]!.expectedMembershipRevision, scoreRevision);
  assert.equal(s.view().canRecommend, true);
  assert.equal(s.view().canRetract, false);
  await choose(s, '0');
  await s.controller.submit();
  assert.equal(s.commands[2]!.expectedMembershipRevision, otherId);
  assert.equal(s.view().canRetract, true);
});
test('retract remains reachable from historical own state after public source/phone/safety loss', async () => {
  for (const serverCode of [
    'WINDOW_CATALOG_UNAVAILABLE',
    'WINDOW_NOT_FOUND',
    'PHONE_VERIFICATION_REQUIRED',
    'SAFETY_ACTION_RESTRICTED',
    'DISH_HISTORY_UNAVAILABLE',
  ]) {
    const s = dishHarness();
    s.impl.list = async () => {
      throw new ClientError('http', 'Unavailable', {
        httpStatus: 503,
        serverCode,
      });
    };
    s.impl.own = async () => own();
    await s.controller.load(id);
    await choose(s, command().dishName, 'retract');
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().canRetract, true);
    await s.controller.submit();
    assert.equal(s.commands.length, 1);
    assert.equal(s.calls.find((c) => c.method === 'submit')!.args[1], retract);
    assert.equal(
      s.commands[0]!.expectedCatalogRevision,
      command().expectedCatalogRevision,
    );
  }
});
test('unknown own history never becomes not-recommended and invalid names never issue a read', async () => {
  const s = dishHarness();
  await s.controller.load(id);
  s.impl.own = async () => ({ kind: 'unavailable' });
  await choose(s);
  assert.equal(s.view().own?.kind, 'unavailable');
  assert.equal(s.view().canRecommend, false);
  assert.equal(s.view().canRetract, false);
  const count = s.calls.length;
  for (const name of [' ', '\ud800', 'a'.repeat(11), 'a\n']) {
    s.controller.setName(name);
    await s.controller.lookup();
  }
  assert.equal(s.calls.length, count);
});
test('durable readback precedes send and storage failure prevents transmission', async () => {
  const s = dishHarness();
  await s.controller.load(id);
  await choose(s);
  s.storage.failWrite = true;
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  const t = dishHarness();
  await t.controller.load(id);
  await choose(t);
  t.impl.submit = async (_id, _operation, input) => {
    assert.deepEqual(
      t.pendingDishRecommendations.load(t.accountId)?.command,
      input,
    );
    throw new ClientError('network', 'Lost');
  };
  await t.controller.submit();
  assert.equal(t.view().frozen, true);
});
test('restart reads original receipt before resend and historical receipt never replaces current membership', async () => {
  const s = dishHarness();
  await s.controller.load(id);
  await choose(s);
  s.impl.submit = async () => {
    throw new ClientError('network', 'Lost');
  };
  await s.controller.submit();
  const original = s.pendingDishRecommendations.load(s.accountId)!;
  s.controller.dispose();
  const views: DishRecommendationView[] = [],
    c = new DishRecommendationController(s.runtime, (view) => views.push(view));
  await c.load(id);
  await c.recover(true);
  assert.deepEqual(s.commands[1], original.command);
  assert.deepEqual(
    s.calls.slice(-2).map((call) => call.method),
    ['receipt', 'submit'],
  );
  s.impl.receipt = async () => receipt();
  s.impl.own = async () => own(false, otherId);
  await c.recover(true);
  assert.equal(s.commands.length, 2);
  assert.equal(s.pendingDishRecommendations.load(s.accountId), null);
  assert.deepEqual(views[views.length - 1]!.own, own(false, otherId));
  assert.match(views[views.length - 1]!.receiptStatus, /历史回执/);
});
test('wrong operation/name receipts cannot erase durable pending, and only genuine missing authorizes resend', async () => {
  for (const result of [
    receipt(command(), retract),
    receipt(command({ dishName: '其他' })),
  ]) {
    const s = dishHarness();
    s.pendingDishRecommendations.freeze(s.pending());
    s.impl.receipt = async () => result;
    await s.controller.load(id);
    await s.controller.recover(true);
    assert.equal(s.view().frozen, true);
    assert.ok(s.pendingDishRecommendations.load(s.accountId));
  }
  for (const error of [
    new ClientError('protocol', 'Bad', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
    new ClientError('http', 'Bad', {
      httpStatus: 503,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
    new ClientError('network', 'Lost'),
  ]) {
    const s = dishHarness();
    s.pendingDishRecommendations.freeze(s.pending());
    s.impl.receipt = async () => {
      throw error;
    };
    await s.controller.load(id);
    await s.controller.recover(true);
    assert.equal(s.commands.length, 0);
    assert.equal(s.view().frozen, true);
  }
});
test('durable cancellation survives lost response and retries only cancellation after receipt absence', async () => {
  const s = dishHarness();
  s.pendingDishRecommendations.freeze(s.pending());
  await s.controller.load(id);
  await s.controller.recover(false, true);
  assert.equal(s.view().confirming, 'cancel');
  s.impl.cancel = async () => {
    throw new ClientError('network', 'Lost');
  };
  await s.controller.confirmCancellation();
  assert.equal(s.pendingDishRecommendations.load(s.accountId)!.phase, 'cancel');
  s.impl.cancel = async () => cancelled();
  await s.controller.recover(true);
  assert.equal(s.commands.length, 0);
  assert.equal(s.pendingDishRecommendations.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /已确认取消/);
});
test('offpage revision change clears stale pagination and requires restart', async () => {
  const s = dishHarness();
  s.impl.list = async () =>
    page({
      items: [
        {
          dishName: 'a',
          dishIdentity: dishIdentity('a'),
          recommendationCount: 1,
          isRecommended: false,
          myMembershipRevision: null,
        },
      ],
      nextCursor: 'next',
      continuation: 'more',
    });
  await s.controller.load(id);
  s.impl.list = async () => page({ membershipRevision: '2' });
  await s.controller.next();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().restartRequired, true);
  assert.deepEqual(s.view().items, []);
});
test('account/session replacement, page disposal and root hide reject late private read callbacks', async () => {
  for (const action of ['login', 'dispose', 'hide']) {
    const s = dishHarness();
    await s.controller.load(id);
    const late = deferred<ReturnType<typeof own>>();
    s.impl.own = async () => late.promise;
    s.controller.setName('菜');
    const work = s.controller.lookup();
    await flush();
    if (action === 'login')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    else if (action === 'dispose') s.controller.dispose();
    else s.runtime.privateViews!.clear();
    late.resolve(own());
    await work;
    assert.equal(s.view().own, null);
    assert.equal(s.view().nameDraft, '');
  }
});
test('journal is account and origin scoped and rejects C2/score operation namespaces', () => {
  const s = dishHarness();
  const original = s.pending();
  s.pendingDishRecommendations.freeze(original);
  assert.equal(s.pendingDishRecommendations.load(otherId), null);
  assert.throws(() =>
    s.pendingDishRecommendations.freeze({
      ...original,
      operation: 'window.score.set.v1' as typeof recommend,
    }),
  );
  assert.throws(() =>
    s.pendingDishRecommendations.freeze({
      ...original,
      command: command({ dishName: 'changed' }),
    }),
  );
  assert.throws(() =>
    s.pendingDishRecommendations.settle(original, receipt(command(), retract)),
  );
  assert.ok(s.pendingDishRecommendations.load(s.accountId));
  assert.equal(missing().details.httpStatus, 404);
});
test('Stop during refresh prevents the sequence from starting a later own-membership query', async () => {
  const s = dishHarness();
  await s.controller.load(id);
  await choose(s);
  s.controller.closeConfirmation();
  const pending = deferred<ReturnType<typeof page>>();
  s.impl.list = async () => pending.promise;
  const count = s.calls.filter((call) => call.method === 'own').length;
  const work = s.controller.reload();
  await flush();
  assert.equal(s.view().busy, true);
  s.controller.cancel();
  await work;
  assert.equal(s.view().busy, false);
  assert.equal(s.calls.filter((call) => call.method === 'own').length, count);
  pending.resolve(page());
  await flush();
  assert.equal(s.view().own, null);
  assert.equal(s.view().busy, false);
});
test('cold recovery route restores original target from own journal without public catalog or phone access', async () => {
  const s = dishHarness();
  s.pendingDishRecommendations.freeze(s.pending());
  s.impl.list = async () => {
    throw new ClientError('http', 'Source unavailable', {
      httpStatus: 503,
      serverCode: 'WINDOW_CATALOG_UNAVAILABLE',
    });
  };
  await s.controller.load(null);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().recoveryWindowId, id);
  assert.equal(s.calls[0]!.args[0], id);
  s.impl.receipt = async () => receipt();
  s.impl.own = async () => own(false, otherId);
  await s.controller.recover(true);
  assert.equal(s.commands.length, 0);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().own, own(false, otherId));
  assert.equal(s.view().canRecommend, false);
  const empty = dishHarness();
  await empty.controller.load(null);
  assert.equal(empty.calls.length, 0);
  assert.equal(empty.view().frozen, false);
  assert.match(empty.view().status, /没有待确认/);
});
