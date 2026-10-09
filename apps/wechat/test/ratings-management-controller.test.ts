import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { RatingManagementController } from '../src/ratings/management-controller';
import { RatingController } from '../src/ratings/controller';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  creationContext,
  creationIntent,
  creationReceipt,
  managementHarness,
} from './ratings-management-helpers';
import type { RatingTargetCreationReceipt } from '../src/ratings/management-contract';
async function ready() {
  const s = managementHarness();
  await s.controller.load(creationContext);
  s.controller.setName('Synthetic target');
  return s;
}
test('double tap persists and reads back v5 before first dispatch; receipt clears intent without claiming current content', async () => {
  const s = await ready(),
    result = deferred<RatingTargetCreationReceipt>();
  let calls = 0;
  s.gateway.command = async (intent) => {
    calls++;
    assert.deepEqual(s.pendingRatings.load(s.accountId), {
      version: 5,
      accountId: s.accountId,
      intent,
    });
    return result.promise;
  };
  const first = s.controller.create();
  const second = s.controller.create();
  await flush();
  assert.equal(s.ids.count, 1);
  assert.equal(calls, 1);
  assert.equal(s.view().frozen, true);
  s.controller.setName('replacement');
  assert.equal(s.view().name, '');
  result.resolve(creationReceipt());
  await Promise.all([first, second]);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().ready, false);
  assert.equal(s.view().needsRefresh, true);
});
test('lost commit response survives missing GET, close/reopen with invalid route, and identical-key retry', async () => {
  const s = await ready();
  const dispatched: unknown[] = [];
  s.gateway.command = async (intent) => {
    dispatched.push(intent);
    throw new ClientError('network', 'lost');
  };
  await s.controller.create();
  const original = s.pendingRatings.load(s.accountId);
  assert.equal(s.view().frozen, true);
  await s.controller.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  s.controller.dispose();
  const views: ReturnType<typeof s.view>[] = [];
  const reopened = new RatingManagementController(s.runtime, (v) =>
    views.push(v),
  );
  await reopened.load(null);
  assert.equal(views[views.length - 1]!.frozen, true);
  s.gateway.command = async (intent) => {
    dispatched.push(intent);
    return creationReceipt();
  };
  await reopened.recover(true);
  assert.deepEqual(dispatched, [creationIntent(), creationIntent()]);
  assert.equal(s.ids.count, 1);
  assert.equal(s.pendingRatings.load(s.accountId), null);
});
test('existing independent recovery page settles v5 without catalog or eligibility reads', async () => {
  const s = managementHarness();
  s.pendingRatings.freeze({
    version: 5,
    accountId: s.accountId,
    intent: creationIntent(),
  });
  s.gateway.receipt = async () => creationReceipt();
  const views: unknown[] = [];
  const recovery = new RatingController(s.runtime, 'recovery', (view) =>
    views.push(view),
  );
  await recovery.load({});
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.ratings.calls.length, 0);
});
test('storage failure prevents network dispatch; errors never manufacture terminal rejection', async () => {
  const s = await ready();
  s.storage.failWrite = true;
  await s.controller.create();
  assert.deepEqual(s.calls, []);
  s.storage.failWrite = false;
  s.gateway.command = async () => {
    throw new ClientError('business', 'review unavailable', {
      httpStatus: 503,
      serverCode: 'CONTENT_REVIEW_UNAVAILABLE',
    });
  };
  await s.controller.load(creationContext);
  s.controller.setName('Synthetic target');
  await s.controller.create();
  assert.equal(s.pendingRatings.load(s.accountId)?.version, 5);
  assert.equal(s.view().frozen, true);
});
test('cancel during UUID generation sends nothing; logout/hide clears fields and prevents late receipt settlement', async () => {
  const s = await ready(),
    id = deferred<string>();
  s.ids.next = () => id.promise;
  const before = s.controller.create();
  await flush();
  s.controller.cancel();
  id.resolve(creationIntent().payload.clientRequestId);
  await before;
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.deepEqual(s.calls, []);
  const t = await ready(),
    result = deferred<RatingTargetCreationReceipt>();
  t.gateway.command = async () => result.promise;
  const work = t.controller.create();
  await flush();
  const original = t.pendingRatings.load(t.accountId);
  t.sessions.completeLogin(t.sessions.beginLogin(), wireCredentials('b'));
  result.resolve(creationReceipt());
  await work;
  assert.equal(t.view().name, '');
  assert.equal(t.view().receiptStatus, '');
  assert.deepEqual(t.pendingRatings.load(t.accountId), original);
  const u = await ready(),
    response = deferred<RatingTargetCreationReceipt>();
  u.gateway.command = async () => response.promise;
  const inflight = u.controller.create();
  await flush();
  u.runtime.privateViews!.clear();
  response.resolve(creationReceipt());
  await inflight;
  assert.equal(u.view().receiptStatus, '');
  assert.equal(u.pendingRatings.load(u.accountId)?.version, 5);
});
test('browse/identity invalidation removes stale form context and blocks late UUID dispatch', async () => {
  const s = await ready(),
    id = deferred<string>();
  s.ids.next = () => id.promise;
  const work = s.controller.create();
  await flush();
  s.browsingScopeChanges.clear(s.accountId);
  id.resolve(creationIntent().payload.clientRequestId);
  await work;
  assert.equal(s.view().ready, false);
  assert.equal(s.view().name, '');
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.deepEqual(s.calls, []);
});
test('durable stale-context rejection releases slot and requires fresh explicit form context', async () => {
  const s = await ready();
  s.gateway.command = async () => ({
    requestId: creationIntent().payload.clientRequestId,
    operation: 'create_target',
    outcome: 'rejected',
    code: 'RATING_CREATION_CONTEXT_CHANGED',
  });
  await s.controller.create();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().ready, false);
  assert.equal(s.view().needsRefresh, true);
  const count = s.ids.count;
  await s.controller.create();
  assert.equal(s.ids.count, count);
});
test('creation cancellation needs explicit second confirmation, settles durable cancellation and preserves applied precedence', async () => {
  for (const applied of [false, true]) {
    const s = await ready();
    s.gateway.command = async () => {
      throw new ClientError('network', 'unknown');
    };
    await s.controller.create();
    await s.controller.confirmCancelCreation();
    assert.equal(s.calls.includes('cancel'), false);
    let calls = 0;
    s.gateway.cancel = async (intent) => {
      calls++;
      assert.deepEqual(intent, creationIntent());
      return applied
        ? creationReceipt()
        : {
            requestId: intent.payload.clientRequestId,
            operation: 'create_target',
            outcome: 'rejected',
            code: 'RATING_CREATION_CANCELLED',
          };
    };
    s.controller.requestCancelCreation();
    assert.equal(s.view().cancelCreationConfirmation, true);
    await s.controller.confirmCancelCreation();
    assert.equal(calls, 1);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().frozen, false);
    assert.equal(s.view().receiptStatus.includes('已撤销'), !applied);
  }
});
test('lost cancellation response preserves journal; GET missing never clears, durable cancellation GET does', async () => {
  const s = await ready();
  s.gateway.command = async () => {
    throw new ClientError('network', 'unknown');
  };
  await s.controller.create();
  const original = s.pendingRatings.load(s.accountId);
  s.gateway.cancel = async () => {
    throw new ClientError('network', 'cancel response lost');
  };
  s.controller.requestCancelCreation();
  await s.controller.confirmCancelCreation();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  await s.controller.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  s.gateway.receipt = async () => ({
    requestId: creationIntent().payload.clientRequestId,
    operation: 'create_target',
    outcome: 'rejected',
    code: 'RATING_CREATION_CANCELLED',
  });
  await s.controller.recover();
  assert.equal(s.pendingRatings.load(s.accountId), null);
});
test('late rejection/cancellation after page stop or account replacement cannot release the original slot', async () => {
  for (const replaceAccount of [false, true]) {
    const s = await ready();
    s.gateway.command = async () => {
      throw new ClientError('network', 'unknown');
    };
    await s.controller.create();
    const response = deferred<RatingTargetCreationReceipt>();
    s.gateway.cancel = async () => response.promise;
    s.controller.requestCancelCreation();
    const work = s.controller.confirmCancelCreation();
    await flush();
    const original = s.pendingRatings.load(s.accountId);
    if (replaceAccount)
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    else s.controller.cancel();
    response.resolve({
      requestId: creationIntent().payload.clientRequestId,
      operation: 'create_target',
      outcome: 'rejected',
      code: 'RATING_CREATION_CANCELLED',
    });
    await work;
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(s.view().receiptStatus, '');
  }
});
test('independent recovery settles rejected creation and requests refresh without reading current content', async () => {
  const s = managementHarness();
  s.pendingRatings.freeze({
    version: 5,
    accountId: s.accountId,
    intent: creationIntent(),
  });
  s.gateway.receipt = async () => ({
    requestId: creationIntent().payload.clientRequestId,
    operation: 'create_target',
    outcome: 'rejected',
    code: 'RATING_CREATION_CONTEXT_CHANGED',
  });
  const views: import('../src/ratings/controller').RatingView[] = [];
  const controller = new RatingController(s.runtime, 'recovery', (view) =>
    views.push(view),
  );
  await controller.load({});
  const view = views[views.length - 1]!;
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(view.frozen, false);
  assert.equal(view.needsRefresh, true);
  assert.equal(s.ratings.calls.length, 0);
});
