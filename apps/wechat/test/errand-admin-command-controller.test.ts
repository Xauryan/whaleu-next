import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  ErrandAdminCommandController,
  initialErrandAdminCommandView,
} from '../src/errands/admin-command-controller';
import type { ErrandAdminReceipt } from '../src/errands/admin-command-contract';
import { errandAdminAuthority } from '../src/errands/admin-authority';
import {
  authorization,
  adminRegion,
  otherAdminRegion,
  publicProfileId,
} from './errand-admin-helpers';
import {
  commandHarness,
  mutationOrder,
  scope,
  globalScope,
  restriction,
  applied,
  restrictionId,
  eventId,
} from './errand-admin-command-helpers';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';

test('native confirmations show exact order target; optional publisher restriction starts off and own deletion cannot enter the administrative branch', async () => {
  const h = commandHarness();
  h.controller.openOrder(
    { ...mutationOrder(), relation: 'publisher' },
    scope(),
    'admin_delete',
  );
  assert.equal(h.view().modal, null);
  h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
  assert.equal(h.view().modal?.regionId, adminRegion);
  assert.equal(h.view().publisherRestriction, false);
  assert.equal(h.view().durationIndex, -1);
  await h.controller.confirm();
  assert.equal(h.commands().length, 1);
  assert.equal(h.journal.load(h.accountId), null);
  assert.equal(h.settled.length, 1);
  h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
  h.controller.togglePublisherRestriction();
  await h.controller.confirm();
  assert.equal(h.commands().length, 1);
  h.controller.setReason('合成原因');
  h.controller.setDuration('10');
  await h.controller.confirm();
  assert.equal(h.commands().length, 2);
  assert.deepEqual(
    (h.commands()[1]!.args[0] as { payload: { publisherRestriction: unknown } })
      .payload.publisherRestriction,
    { kind: 'permanent' },
  );
  h.controller.dispose();
});
test('accepter defaults seven days; immutable exact intent is frozen before one send despite double tap', async () => {
  const h = commandHarness(),
    result = deferred<ErrandAdminReceipt>();
  h.gateway.commandImpl = async (intent) => {
    assert.equal(
      h.journal.load(h.accountId)?.intent.payload.clientRequestId,
      intent.payload.clientRequestId,
    );
    return result.promise;
  };
  h.controller.openOrder(mutationOrder(), scope(), 'restrict_accepter');
  assert.equal(h.view().durationIndex, 5);
  h.controller.setReason('合成接单限制');
  const pending = h.controller.confirm();
  await flush();
  await h.controller.confirm();
  assert.equal(h.commands().length, 1);
  const intent = h.journal.load(h.accountId)!.intent;
  assert.equal(intent.operation, 'restrict_accepter');
  if (intent.operation === 'restrict_accepter')
    assert.deepEqual(intent.payload.duration, {
      kind: 'finite',
      unit: 'days',
      value: 7,
    });
  result.resolve(applied(intent));
  await pending;
  assert.equal(h.journal.load(h.accountId), null);
  h.controller.dispose();
});
test('close, scope, browse, Safety, hide and same-account login during async request ID creation never send or persist stale confirmation', async () => {
  for (const boundary of [
    'close',
    'scope',
    'browse',
    'safety',
    'hide',
    'epoch',
  ]) {
    const h = commandHarness(),
      id = deferred<string>();
    const runtime = { ...h.runtime, newRequestId: () => id.promise };
    h.controller.dispose();
    let view = initialErrandAdminCommandView();
    const controller = new ErrandAdminCommandController(runtime, (next) => {
      view = next;
    });
    controller.openOrder(mutationOrder(), scope(), 'admin_delete');
    const pending = controller.confirm();
    await flush();
    if (boundary === 'close') controller.dismiss();
    if (boundary === 'scope') runtime.directoryScopeChanges!.clear(h.accountId);
    if (boundary === 'browse') runtime.browsingScopeChanges!.clear(h.accountId);
    if (boundary === 'safety') runtime.safetyChanges!.invalidate(h.accountId);
    if (boundary === 'hide') runtime.privateViews!.clear();
    if (boundary === 'epoch')
      h.sessions.completeLogin(h.sessions.beginLogin(), wireCredentials());
    id.resolve(eventId);
    await pending;
    await flush();
    assert.equal(h.commands().length, 0, boundary);
    assert.equal(h.journal.load(h.accountId), null, boundary);
    assert.equal(view.modal, null, boundary);
    controller.dispose();
  }
});
test('fresh role changes abort old modal before sending; storage write failure also blocks all sends', async () => {
  for (const auth of [
    authorization('member'),
    authorization('school_admin', [otherAdminRegion]),
    authorization('developer'),
  ]) {
    const h = commandHarness();
    h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
    h.gateway.authorizationImpl = async () => auth;
    await h.controller.confirm();
    assert.equal(h.commands().length, 0);
    assert.equal(h.view().modal, null);
    assert.equal(h.lost(), 1);
    h.controller.dispose();
  }
  const h = commandHarness();
  h.storage.failWrite = true;
  h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
  await h.controller.confirm();
  assert.equal(h.commands().length, 0);
  assert.equal(h.view().frozen, true);
  h.controller.dispose();
});
test('timeout and receipt404 keep same journal; explicit retry replays byte-equivalent intent and never mints another key', async () => {
  const h = commandHarness();
  h.gateway.commandImpl = async () => {
    throw new ClientError('timeout', 'synthetic');
  };
  h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
  await h.controller.confirm();
  const original = h.journal.load(h.accountId)!;
  assert.equal(h.view().frozen, true);
  h.controller.dismiss();
  assert.deepEqual(h.journal.load(h.accountId), original);
  h.gateway.receiptImpl = async () => {
    throw new ClientError('business', 'pending', {
      serverCode: 'REQUEST_NOT_FOUND',
      httpStatus: 404,
    });
  };
  await h.controller.recover();
  assert.deepEqual(h.journal.load(h.accountId), original);
  assert.equal(h.commands().length, 1);
  h.gateway.commandImpl = async (intent) => applied(intent);
  await h.controller.recover(true);
  assert.deepEqual(h.commands()[1]!.args[0], original.intent);
  assert.equal(h.journal.load(h.accountId), null);
  h.controller.dispose();
});
test('fresh sufficient role can recover original target after promotion/demotion; revoked or different school cannot query or replay', async () => {
  for (const originalRole of ['school_admin', 'developer'] as const) {
    const h = commandHarness();
    h.gateway.authorizationImpl = async () => authorization(originalRole);
    const original = errandAdminAuthority(
      authorization(originalRole),
      adminRegion,
    );
    h.gateway.commandImpl = async () => {
      throw new ClientError('timeout', 'synthetic');
    };
    h.controller.openOrder(mutationOrder(), original, 'admin_delete');
    await h.controller.confirm();
    const stored = h.journal.load(h.accountId)!;
    for (const next of [
      authorization('member'),
      authorization('school_admin', [otherAdminRegion]),
    ]) {
      h.gateway.authorizationImpl = async () => next;
      await h.controller.recover();
      await h.controller.recover(true);
      assert.equal(h.receipts().length, 0);
      assert.equal(h.commands().length, 1);
      assert.deepEqual(h.journal.load(h.accountId), stored);
    }
    h.gateway.authorizationImpl = async () =>
      authorization(
        originalRole === 'school_admin' ? 'developer' : 'school_admin',
      );
    await h.controller.recover();
    assert.equal(h.receipts().length, 1);
    assert.equal(h.journal.load(h.accountId), null);
    h.controller.dispose();
  }
});
test('in-flight close/hide/scope change discards old applied response while retaining original journal for authorized recovery', async () => {
  for (const boundary of ['close', 'hide', 'scope']) {
    const h = commandHarness(),
      result = deferred<ErrandAdminReceipt>();
    h.gateway.commandImpl = async () => result.promise;
    h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
    const pending = h.controller.confirm();
    await flush();
    const stored = h.journal.load(h.accountId)!;
    if (boundary === 'close') h.controller.dismiss();
    if (boundary === 'hide') h.runtime.privateViews!.clear();
    if (boundary === 'scope')
      h.runtime.directoryScopeChanges!.clear(h.accountId);
    result.resolve(applied(stored.intent));
    await pending;
    assert.deepEqual(h.journal.load(h.accountId), stored);
    assert.equal(h.settled.length, 0);
    h.controller.dispose();
  }
});
test('account replacement isolates pending intent and never queries or displays original reasons', async () => {
  const h = commandHarness();
  h.gateway.commandImpl = async () => {
    throw new ClientError('timeout', 'synthetic');
  };
  h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
  h.controller.setReason('private moderation reason');
  await h.controller.confirm();
  const stored = h.journal.load(h.accountId)!;
  h.sessions.completeLogin(h.sessions.beginLogin(), {
    ...wireCredentials(),
    accountId: publicProfileId,
  });
  await h.controller.recover(true);
  assert.equal(h.commands().length, 1);
  assert.equal(h.receipts().length, 0);
  assert.equal(
    JSON.stringify(h.view()).includes('private moderation reason'),
    false,
  );
  assert.deepEqual(h.journal.load(h.accountId), stored);
  h.controller.dispose();
});
test('global issue/release require global authority; releasing all addresses one immutable ID and keeps unrelated entries untouched', async () => {
  const h = commandHarness();
  h.controller.openIssue(scope());
  assert.equal(h.view().modal, null);
  h.gateway.authorizationImpl = async () => authorization('developer');
  h.controller.openIssue(globalScope());
  h.controller.setTargetProfileId(publicProfileId);
  h.controller.setReason('合成全局理由');
  h.controller.setDuration('0');
  h.controller.setAction('publish');
  await h.controller.confirm();
  assert.equal(h.commands().length, 1);
  h.controller.openRelease(restriction(), globalScope());
  h.controller.setReason('合成解除原因');
  await h.controller.confirm();
  assert.equal(h.commands().length, 2);
  const sent = h.commands()[1]!.args[0] as {
    restrictionId: string;
    payload: unknown;
  };
  assert.equal(sent.restrictionId, restrictionId);
  assert.deepEqual(Object.keys(sent.payload as object).sort(), [
    'clientRequestId',
    'reason',
  ]);
  h.controller.dispose();
});

test('503 authorization uncertainty clears caller management body/total/controls on command and receipt while preserving unresolved intent', async () => {
  for (const stage of ['command', 'receipt']) {
    const h = commandHarness();
    h.gateway.commandImpl = async () => {
      throw new ClientError(
        stage === 'command' ? 'http' : 'timeout',
        'synthetic',
        stage === 'command'
          ? { serverCode: 'AUTHORIZATION_UNAVAILABLE', httpStatus: 503 }
          : {},
      );
    };
    h.controller.openOrder(mutationOrder(), scope(), 'admin_delete');
    await h.controller.confirm();
    const stored = h.journal.load(h.accountId)!;
    if (stage === 'receipt') {
      h.gateway.receiptImpl = async () => {
        throw new ClientError('business', 'synthetic', {
          serverCode: 'AUTHORIZATION_UNAVAILABLE',
          httpStatus: 503,
        });
      };
      await h.controller.recover();
    }
    assert.equal(h.lost(), 1);
    assert.equal(h.view().modal, null);
    assert.deepEqual(h.journal.load(h.accountId), stored);
    h.controller.dispose();
  }
});

test('administrator publishers use E1 for own deletion but retain exact-target accepter restriction against the other stored participant', async () => {
  const h = commandHarness(),
    own = { ...mutationOrder(), relation: 'publisher' as const };
  h.controller.openOrder(own, scope(), 'admin_delete');
  assert.equal(h.view().modal, null);
  h.controller.openOrder(own, scope(), 'restrict_accepter');
  assert.equal(h.view().modal?.operation, 'restrict_accepter');
  assert.equal(h.view().publisherRestriction, false);
  h.controller.setReason('合成接单者处理');
  await h.controller.confirm();
  assert.equal(h.commands().length, 1);
  assert.equal(
    (h.commands()[0]!.args[0] as { operation: string }).operation,
    'restrict_accepter',
  );
  h.controller.dispose();
});
