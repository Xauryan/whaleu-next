import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { RatingController, type RatingView } from '../src/ratings/controller';
import {
  RatingThreadController,
  type RatingThreadView,
} from '../src/ratings/discussion-controller';
import {
  RatingDeletionController,
  type RatingDeletionView,
} from '../src/ratings/deletion-controller';
import type {
  RatingAdminDeletionContext,
  RatingAdminDeletionReceipt,
} from '../src/ratings/deletion-contract';
import { ratingOwnerDeletionIntent } from '../src/ratings/deletion-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  targetId,
  commentId,
  otherId,
  requestId,
  nextRevision,
  regionId,
  commentPage,
  comment,
  intent,
  receipt,
} from './ratings-helpers';
import { route } from './ratings-r2a-helpers';
import {
  adminContext,
  adminIntent,
  adminReceipt,
  deletionContext,
  locator,
  r3aHarness,
  changed,
  missing,
} from './ratings-r3a-helpers';
const accountId = wireCredentials().accountId;
const unavailable = () =>
  new ClientError('http', 'Synthetic unavailable', {
    httpStatus: 404,
    serverCode: 'RATING_NOT_FOUND',
  });
const lost = () => new ClientError('timeout', 'Synthetic lost response');

for (const reply of [false, true]) {
  test(`R3A ${reply ? 'reply' : 'comment'} owner hidden-parent cleanup uses only minimal fresh context and unchanged owner command`, async () => {
    const s = r3aHarness(),
      context = deletionContext(reply, {
        regionId,
        targetRevision: nextRevision,
        rootRevision: nextRevision,
        revision: nextRevision,
      });
    s.ratings.detailImpl = async () => {
      throw unavailable();
    };
    s.ratingDiscussion.discussionImpl = async () => {
      throw unavailable();
    };
    s.ratingDeletion.contextImpl = async () => context;
    await s.deletionController.load(locator(reply));
    assert.equal(s.ratingDeletion.calls.length, 0);
    await s.deletionController.readContext('owner');
    assert.equal(s.deletionView().canConfirm, true);
    assert.equal(s.ids.count, 0);
    await s.deletionController.confirmDelete();
    const commands = reply ? s.ratingDiscussion.commands : s.ratings.commands;
    assert.deepEqual(commands, [ratingOwnerDeletionIntent(context, requestId)]);
    assert.equal(s.ratingDeletion.commands.length, 0);
    assert.equal(
      s.ratings.calls.filter((c) => c.method !== 'command').length,
      0,
    );
    assert.equal(
      s.ratingDiscussion.calls.filter((c) => c.method !== 'command').length,
      0,
    );
    assert.equal(s.pendingRatings.load(accountId), null);
    assert.equal(s.deletionView().canConfirm, false);
    assert.match(s.deletionView().receiptStatus, /历史操作/);
  });
  test(`R3A ${reply ? 'reply' : 'comment'} explicit admin context and second confirmation keep owner semantics separate`, async () => {
    const s = r3aHarness();
    await s.deletionController.load(locator(reply));
    assert.equal(s.ratingDeletion.calls.length, 0);
    await s.deletionController.readContext('admin');
    assert.equal(s.ratingDeletion.commands.length, 0);
    assert.equal(s.deletionView().authority, 'admin');
    assert.equal(
      JSON.stringify(s.deletionView()).includes('contextRevision'),
      false,
    );
    await s.deletionController.confirmDelete();
    assert.deepEqual(s.ratingDeletion.commands, [adminIntent(reply)]);
    assert.equal(
      s.ratings.commands.length + s.ratingDiscussion.commands.length,
      0,
    );
    assert.equal(s.pendingRatings.load(accountId), null);
    assert.equal(s.deletionView().canConfirm, false);
    assert.deepEqual(
      s.ratingDeletion.calls.map((c) => c.method),
      ['context', 'command', 'context'],
    );
  });
}
test('R3A ordinary user denied admin context receives no deletion action; lists never probe admin for rows', async () => {
  const s = r3aHarness();
  s.ratings.commentsImpl = async () =>
    commentPage({
      items: [comment({ isMine: false, allowedActions: { delete: false } })],
    });
  const views: RatingView[] = [],
    detail = new RatingController(s.runtime, 'detail', (v) => views.push(v));
  await detail.load({ targetId });
  assert.equal(s.ratingDeletion.calls.length, 0);
  assert.equal(
    views[views.length - 1]!.comments[0]!.allowedActions.delete,
    false,
  );
  detail.confirmDelete(commentId);
  await detail.deleteComment();
  assert.equal(s.ratings.commands.length, 0);
  assert.match(detail.deletionPath(commentId)!, /rating-deletion/);
  assert.equal(detail.deletionPath(otherId), null);
  s.ratingDeletion.contextImpl = async () => {
    throw unavailable();
  };
  await s.deletionController.load(locator());
  await s.deletionController.readContext('admin');
  await s.deletionController.confirmDelete();
  assert.equal(s.deletionView().authority, null);
  assert.equal(s.deletionView().canConfirm, false);
  assert.equal(s.ratingDeletion.commands.length, 0);
  assert.equal(s.ids.count, 0);
});
test('R3A unavailable thread retains only known route deletion locator and cannot select arbitrary subject', async () => {
  const s = r3aHarness();
  s.ratings.detailImpl = async () => {
    throw unavailable();
  };
  await s.controller.load(route);
  assert.equal(s.view().discussion, null);
  assert.match(s.controller.deletionPath()!, /rating-deletion/);
  assert.equal(s.controller.deletionPath(otherId), null);
  assert.match(s.controller.deletionPath(commentId)!, /subjectKind=comment/);
  assert.equal(s.ratingDeletion.calls.length, 0);
});
test('R3A cancellation before UUID persistence and double click preserve a single command', async () => {
  const s = r3aHarness(),
    id = deferred<string>();
  s.ids.next = () => id.promise;
  await s.deletionController.load(locator());
  await s.deletionController.readContext('admin');
  const first = s.deletionController.confirmDelete(),
    second = s.deletionController.confirmDelete();
  await flush();
  assert.equal(s.ids.count, 1);
  s.deletionController.cancel();
  id.resolve(requestId);
  await Promise.all([first, second]);
  assert.equal(s.ratingDeletion.commands.length, 0);
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.equal(s.deletionView().canConfirm, false);
  await s.deletionController.readContext('admin');
  await Promise.all([
    s.deletionController.confirmDelete(),
    s.deletionController.confirmDelete(),
  ]);
  assert.equal(s.ratingDeletion.commands.length, 1);
});
test('R3A lost response preserves exact v4 payload; missing receipt blocks new context and key; recovery reloads current metadata', async () => {
  const s = r3aHarness();
  s.ratingDeletion.commandImpl = async () => {
    throw lost();
  };
  await s.deletionController.load(locator(true));
  await s.deletionController.readContext('admin');
  await s.deletionController.confirmDelete();
  const original = s.pendingRatings.load(accountId)!;
  assert.equal(original.version, 4);
  assert.equal(s.deletionView().frozen, true);
  await s.deletionController.readContext('owner');
  await s.deletionController.confirmDelete();
  await s.deletionController.recover();
  assert.deepEqual(s.pendingRatings.load(accountId), original);
  assert.equal(s.ids.count, 1);
  assert.equal(
    s.ratingDeletion.calls.filter((c) => c.method === 'context').length,
    1,
  );
  s.ratingDeletion.receiptImpl = async () => adminReceipt(adminIntent(true));
  s.ratingDeletion.contextImpl = async () =>
    adminContext(true, { deleted: true, revision: nextRevision });
  await s.deletionController.recover();
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.equal(s.deletionView().context?.deleted, true);
  assert.equal(s.deletionView().canConfirm, false);
  assert.equal(s.ratingDeletion.commands.length, 1);
});
test('R3A revoked admin can recover minimal historical receipt; failed current context cannot restore old authority/content', async () => {
  const s = r3aHarness();
  s.pendingRatings.freeze({ version: 4, accountId, intent: adminIntent() });
  s.ratingDeletion.receiptImpl = async () => adminReceipt();
  s.ratingDeletion.contextImpl = async () => {
    throw unavailable();
  };
  await s.deletionController.load(locator());
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.match(s.deletionView().receiptStatus, /历史操作/);
  assert.equal(s.deletionView().context, null);
  assert.equal(s.deletionView().canConfirm, false);
  assert.equal(s.ratings.calls.length + s.ratingDiscussion.calls.length, 0);
});
test('R3A explicit context rollback clears pending but cannot silently refresh or create a new intent', async () => {
  const s = r3aHarness();
  s.ratingDeletion.commandImpl = async () => {
    throw changed();
  };
  await s.deletionController.load(locator());
  await s.deletionController.readContext('admin');
  await s.deletionController.confirmDelete();
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.equal(s.deletionView().frozen, false);
  assert.equal(s.deletionView().canConfirm, false);
  assert.equal(s.deletionView().needsRefresh, true);
  await s.deletionController.confirmDelete();
  assert.equal(s.ids.count, 1);
  assert.equal(
    s.ratingDeletion.calls.filter((c) => c.method === 'context').length,
    1,
  );
  s.ids.next = async () => otherId;
  s.ratingDeletion.contextImpl = async () =>
    adminContext(false, { contextRevision: 'y'.repeat(43) });
  await s.deletionController.readContext('admin');
  assert.equal(s.ids.count, 1);
  s.ratingDeletion.commandImpl = async (intent) => adminReceipt(intent);
  await s.deletionController.confirmDelete();
  assert.equal(s.ids.count, 2);
  assert.equal(s.ratingDeletion.commands[1]!.payload.clientRequestId, otherId);
  assert.equal(
    s.ratingDeletion.commands[0]!.payload.expectedContextRevision,
    'x'.repeat(43),
  );
  assert.equal(
    s.ratingDeletion.commands[1]!.payload.expectedContextRevision,
    'y'.repeat(43),
  );
});
for (const fence of [
  'cancel',
  'dispose',
  'account',
  'relogin',
  'scope',
  'safety',
  'navigation',
] as const) {
  test(`R3A ${fence} fences late context, leaves no confirmation or command`, async () => {
    const s = r3aHarness(),
      hold = deferred<RatingAdminDeletionContext>();
    s.ratingDeletion.contextImpl = async () => hold.promise;
    await s.deletionController.load(locator());
    const run = s.deletionController.readContext('admin');
    await flush();
    if (fence === 'cancel') s.deletionController.cancel();
    if (fence === 'dispose') s.deletionController.dispose();
    if (fence === 'account')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: otherId,
      });
    if (fence === 'relogin')
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    if (fence === 'scope') s.browsingScopeChanges.clear(accountId);
    if (fence === 'safety') s.safetyChanges.invalidate(accountId);
    if (fence === 'navigation') await s.deletionController.load(locator(true));
    hold.resolve(adminContext());
    await run;
    assert.equal(s.deletionView().canConfirm, false);
    assert.equal(s.deletionView().context, null);
    assert.equal(s.ratingDeletion.commands.length, 0);
  });
}
test('R3A close after dispatch fences late receipt and retains journal for same-key recovery', async () => {
  const s = r3aHarness(),
    hold = deferred<RatingAdminDeletionReceipt>();
  s.ratingDeletion.commandImpl = async () => hold.promise;
  await s.deletionController.load(locator());
  await s.deletionController.readContext('admin');
  const run = s.deletionController.confirmDelete();
  await flush();
  const original = s.pendingRatings.load(accountId)!;
  s.deletionController.dispose();
  hold.resolve(adminReceipt());
  await run;
  assert.deepEqual(s.pendingRatings.load(accountId), original);
  const views: RatingDeletionView[] = [],
    reopened = new RatingDeletionController(s.runtime, (v) => views.push(v));
  s.ratingDeletion.receiptImpl = async () => adminReceipt();
  await reopened.load(locator());
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.match(views[views.length - 1]!.receiptStatus, /历史操作/);
});
test('R3A independent recovery page accepts only matching typed admin receipt without requiring role/context', async () => {
  const s = r3aHarness(),
    views: RatingView[] = [],
    recovery = new RatingController(s.runtime, 'recovery', (v) =>
      views.push(v),
    );
  s.pendingRatings.freeze({ version: 4, accountId, intent: adminIntent() });
  s.ratingDeletion.receiptImpl = async () => ({
    ...adminReceipt(),
    targetId: otherId,
  });
  await recovery.load({});
  assert.equal(views[views.length - 1]!.frozen, true);
  assert.notEqual(s.pendingRatings.load(accountId), null);
  s.ratingDeletion.receiptImpl = async () => adminReceipt();
  await recovery.recover();
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.match(views[views.length - 1]!.receiptStatus, /管理员删除评价/);
  assert.deepEqual(
    s.ratingDeletion.calls.map((c) => c.method),
    ['receipt', 'receipt'],
  );
});
test('R3A independent recovery and thread clear explicit context rollback and require manual new confirmation', async () => {
  for (const mode of ['recovery', 'thread'] as const) {
    const s = r3aHarness(),
      views: Array<RatingView | RatingThreadView> = [];
    const controller =
      mode === 'recovery'
        ? new RatingController(s.runtime, 'recovery', (v) => views.push(v))
        : new RatingThreadController(s.runtime, (v) => views.push(v));
    s.pendingRatings.freeze({ version: 4, accountId, intent: adminIntent() });
    s.ratingDeletion.receiptImpl = async () => {
      throw missing();
    };
    await controller.load(mode === 'recovery' ? {} : route);
    s.ratingDeletion.commandImpl = async () => {
      throw changed();
    };
    await controller.recover(true);
    assert.equal(s.pendingRatings.load(accountId), null);
    assert.equal(views[views.length - 1]!.frozen, false);
    assert.equal(views[views.length - 1]!.needsRefresh, true);
    assert.equal(s.ids.count, 0);
  }
});
test('R3A preexisting owner pending prevents admin context probe and preserves original request', async () => {
  const s = r3aHarness(),
    original = s.pendingRatings.freeze({
      version: 1,
      accountId,
      intent: intent('delete_comment'),
    });
  await s.deletionController.load(locator());
  await s.deletionController.readContext('admin');
  assert.equal(s.ratingDeletion.calls.length, 0);
  assert.deepEqual(s.pendingRatings.load(accountId), original);
  s.ratings.receiptImpl = async () => receipt(intent('delete_comment'));
  await s.deletionController.recover();
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.equal(s.ratingDeletion.commands.length, 0);
});

test('R3A failed durable freeze sends nothing; failed receipt removal retains same journal and blocks new authority/context', async () => {
  const s = r3aHarness();
  await s.deletionController.load(locator());
  await s.deletionController.readContext('admin');
  s.storage.failWrite = true;
  await s.deletionController.confirmDelete();
  assert.equal(s.ratingDeletion.commands.length, 0);
  assert.equal(s.pendingRatings.load(accountId), null);
  s.storage.failWrite = false;
  await s.deletionController.readContext('admin');
  s.storage.failRemove = true;
  await s.deletionController.confirmDelete();
  const pending = s.pendingRatings.load(accountId);
  assert.ok(pending);
  assert.equal(s.deletionView().frozen, true);
  await s.deletionController.readContext('owner');
  assert.deepEqual(s.pendingRatings.load(accountId), pending);
  assert.equal(s.ratingDeletion.commands.length, 1);
  s.storage.failRemove = false;
  s.ratingDeletion.receiptImpl = async () => adminReceipt();
  await s.deletionController.recover();
  assert.equal(s.pendingRatings.load(accountId), null);
});
test('R3A rollback journal removal failure cannot mint replacement request or silently change context', async () => {
  const s = r3aHarness();
  await s.deletionController.load(locator());
  await s.deletionController.readContext('admin');
  s.ratingDeletion.commandImpl = async () => {
    throw changed();
  };
  s.storage.failRemove = true;
  await s.deletionController.confirmDelete();
  assert.ok(s.pendingRatings.load(accountId));
  assert.equal(s.deletionView().frozen, true);
  await s.deletionController.readContext('admin');
  await s.deletionController.confirmDelete();
  assert.equal(s.ids.count, 1);
  s.storage.failRemove = false;
  await s.deletionController.recover(true);
  assert.equal(s.pendingRatings.load(accountId), null);
  assert.equal(s.deletionView().canConfirm, false);
  assert.equal(s.deletionView().needsRefresh, true);
});
for (const fence of ['account', 'root-hide', 'navigation'] as const)
  test(`R3A ${fence} after dispatch retains original pending despite late success`, async () => {
    const s = r3aHarness(),
      hold = deferred<RatingAdminDeletionReceipt>();
    s.ratingDeletion.commandImpl = async () => hold.promise;
    await s.deletionController.load(locator());
    await s.deletionController.readContext('admin');
    const run = s.deletionController.confirmDelete();
    await flush();
    const original = s.pendingRatings.load(accountId)!;
    if (fence === 'account')
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: otherId,
      });
    if (fence === 'root-hide') s.runtime.privateViews!.clear();
    if (fence === 'navigation') await s.deletionController.load(locator(true));
    hold.resolve(adminReceipt());
    await run;
    assert.deepEqual(s.pendingRatings.load(accountId), original);
    assert.equal(s.pendingRatings.load(otherId), null);
    assert.equal(s.deletionView().canConfirm, false);
    assert.equal(s.deletionView().context, null);
    assert.equal(s.deletionView().receiptStatus, '');
  });
test('R3A wrong-chain or identity-bearing context cannot become confirmation data', async () => {
  for (const context of [
    { ...adminContext(), targetId: otherId },
    { ...adminContext(), body: 'private content' },
  ]) {
    const s = r3aHarness();
    s.ratingDeletion.contextImpl = async () => context;
    await s.deletionController.load(locator());
    await s.deletionController.readContext('admin');
    assert.equal(s.deletionView().context, null);
    assert.equal(s.deletionView().canConfirm, false);
    assert.equal(
      JSON.stringify(s.deletionViews).includes('private content'),
      false,
    );
    assert.equal(s.ids.count, 0);
  }
});
