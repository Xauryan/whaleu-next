import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import type { Cancellation } from '../src/platform/contracts';
import {
  RatingTargetOwnerEditingController,
  initialRatingTargetOwnerEditingView,
  type RatingTargetOwnerEditingView,
} from '../src/ratings/target-owner-editing-controller';
import type { RatingTargetOwnerEditingReceipt } from '../src/ratings/target-owner-editing-contract';
import { RatingTargetOwnerDeletionController } from '../src/ratings/target-owner-deletion-controller';
import { RatingController, type RatingView } from '../src/ratings/controller';
import { RatingManagementController } from '../src/ratings/management-controller';
import { RatingDeletionController } from '../src/ratings/deletion-controller';
import {
  RatingThreadController,
  type RatingThreadView,
} from '../src/ratings/discussion-controller';
import {
  RatingRandomController,
  type RatingRandomView,
} from '../src/ratings/random-controller';
import type { RatingRandomResult } from '../src/ratings/random-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  categoryId,
  otherId,
  requestId,
  revision,
  targetId,
} from './ratings-helpers';
import { creationIntent } from './ratings-management-helpers';
import {
  FakeRatingDiscussionGateway,
  route as threadRoute,
  replyPage,
  replyId,
} from './ratings-r2a-helpers';
import { randomResult } from './rating-random-helpers';
import {
  cancelledEditingReceipt,
  editedDescription,
  editedName,
  editingContext,
  editingHarness,
  editingIntent,
  editingReceipt,
} from './rating-owner-editing-helpers';

async function ready() {
  const s = editingHarness();
  await s.controller.load({ targetId });
  s.controller.setName(editedName);
  s.controller.setDescription(editedDescription);
  return s;
}
async function unknownCommand() {
  const s = await ready();
  s.gateway.command = async () => {
    throw new ClientError('network', 'lost response');
  };
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  return s;
}

test('initial editor is private and only exact server-authorized context can fill its form', async () => {
  const initial = initialRatingTargetOwnerEditingView();
  assert.equal(initial.name, '');
  assert.equal(initial.description, '');
  assert.equal(initial.ready, false);
  assert.equal(initial.canCancelEditing, false);
  assert.equal('loaded' in initial, false);
  assert.equal('returnToCatalog' in initial, false);
  const s = editingHarness();
  s.controller.setName('not authorized');
  s.controller.setDescription('not authorized');
  assert.equal(s.view().name, '');
  await s.controller.load({ targetId });
  assert.equal(s.view().ready, true);
  assert.equal(s.view().name, editingContext().name);
  assert.equal(s.view().description, editingContext().description);
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.ratings.calls.length, 0);
  assert.equal(JSON.stringify(s.view()).includes('creatorId'), false);
  for (const raw of [
    null,
    { targetId: 'invalid' },
    { targetId, regionId: otherId },
    { targetId, name: 'injected' },
  ]) {
    const t = editingHarness();
    await t.controller.load(raw);
    assert.equal(t.view().ready, false);
    assert.equal(t.view().name, '');
    assert.deepEqual(t.calls, []);
  }
});

test('second confirmation freezes/readbacks the full normalized v7 intent once before dispatch and clears editable text', async () => {
  const s = await ready(),
    result = deferred<RatingTargetOwnerEditingReceipt>();
  await s.controller.confirmEdit();
  assert.equal(s.ids.count, 0);
  let calls = 0;
  s.gateway.command = async (intent) => {
    calls++;
    assert.deepEqual(intent, editingIntent());
    assert.deepEqual(s.pendingRatings.load(s.accountId), {
      version: 7,
      accountId: s.accountId,
      intent,
    });
    return result.promise;
  };
  s.controller.setName(` ${editedName} `);
  s.controller.setDescription(` ${editedDescription}\r\n `);
  s.controller.requestEdit();
  s.controller.setName('cannot alter confirmed text');
  assert.equal(s.view().name, ` ${editedName} `);
  const first = s.controller.confirmEdit(),
    second = s.controller.confirmEdit();
  await flush();
  assert.equal(calls, 1);
  assert.equal(s.ids.count, 1);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().name, '');
  assert.equal(s.view().description, '');
  s.controller.setName('cannot replace frozen name');
  s.controller.setDescription('cannot replace frozen description');
  assert.equal(s.view().name, '');
  assert.equal(s.view().description, '');
  result.resolve(editingReceipt());
  await Promise.all([first, second]);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().ready, false);
  assert.equal(s.view().needsRefresh, true);
  assert.equal(s.view().frozen, false);
  assert.match(s.view().receiptStatus, /历史操作/);
  assert.equal(s.calls.filter((call) => call === 'context').length, 1);
});

test('dismissing confirmation permits revision of draft; invalid Unicode/text never reaches the journal or gateway', async () => {
  const s = await ready();
  s.controller.requestEdit();
  s.controller.dismissEdit();
  await s.controller.confirmEdit();
  assert.equal(s.ids.count, 0);
  s.controller.setName('new editable draft');
  assert.equal(s.view().name, 'new editable draft');
  for (const name of ['', ' \t ', '\ud800', '🌊'.repeat(101)]) {
    const t = await ready();
    t.controller.setName(name);
    t.controller.requestEdit();
    await t.controller.confirmEdit();
    assert.deepEqual(t.calls, ['context']);
    assert.equal(t.pendingRatings.load(t.accountId), null);
    assert.equal(t.view().receiptStatus, '');
  }
});

test('full original tuple comes from canonical target context, never from browsing or route hints', async () => {
  const s = editingHarness();
  const context = {
    ...editingContext(),
    regionId: otherId,
    categoryId: otherId,
    categoryRevision: otherId,
    catalogRevision: otherId,
    contentVersion: 8,
  };
  s.gateway.context = async () => context;
  await s.controller.load({ targetId });
  s.controller.setName(editedName);
  s.controller.setDescription(editedDescription);
  let dispatched: unknown;
  s.gateway.command = async (intent) => {
    dispatched = intent;
    throw new ClientError('network', 'unknown');
  };
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  assert.deepEqual(dispatched, {
    operation: 'edit_target',
    payload: {
      ...editingIntent().payload,
      regionId: context.regionId,
      categoryId: context.categoryId,
      expectedCategoryRevision: context.categoryRevision,
      expectedCatalogRevision: context.catalogRevision,
      expectedContentVersion: context.contentVersion,
    },
  });
});

test('unknown edit survives close/reopen, missing GET, invalid and different routes without painting original text', async () => {
  const s = await unknownCommand();
  const original = s.pendingRatings.load(s.accountId);
  assert.ok(original);
  assert.equal(s.view().frozen, true);
  await s.controller.reload();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  s.controller.cancel();
  s.controller.dispose();
  for (const route of [
    null,
    { targetId: otherId },
    { targetId, name: 'route injection' },
  ]) {
    const views: RatingTargetOwnerEditingView[] = [];
    const reopened = new RatingTargetOwnerEditingController(s.runtime, (view) =>
      views.push(view),
    );
    await reopened.load(route);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(views[views.length - 1]!.frozen, true);
    assert.equal(views[views.length - 1]!.name, '');
    assert.equal(views[views.length - 1]!.description, '');
    assert.equal(JSON.stringify(views).includes(editedName), false);
    assert.equal(JSON.stringify(views).includes(editedDescription), false);
    reopened.dispose();
  }
  assert.equal(s.calls.filter((call) => call === 'context').length, 1);
  const reopened = new RatingTargetOwnerEditingController(
    s.runtime,
    () => undefined,
  );
  await reopened.load({ targetId: otherId });
  let dispatched: unknown;
  s.gateway.command = async (intent) => {
    dispatched = intent;
    return editingReceipt();
  };
  await reopened.recover(true);
  assert.deepEqual(dispatched, editingIntent());
  assert.equal(s.ids.count, 1);
  assert.equal(s.pendingRatings.load(s.accountId), null);
});

test('all recovery-capable rating pages settle v7 before invalid routes or current visibility and never render historical draft text', async () => {
  for (const outcome of ['applied', 'noop', 'rejected'] as const) {
    for (const make of [
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingController(s.runtime, 'recovery', render),
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingController(s.runtime, 'detail', render),
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingController(s.runtime, 'catalog', render),
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingManagementController(s.runtime, render),
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingDeletionController(s.runtime, render),
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingThreadController(s.runtime, render),
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingTargetOwnerDeletionController(s.runtime, render),
      (s: ReturnType<typeof editingHarness>, render: (view: unknown) => void) =>
        new RatingTargetOwnerEditingController(s.runtime, render),
    ]) {
      const s = editingHarness(),
        views: unknown[] = [];
      const runtime = s.runtime as {
        ratingManagement?: unknown;
        ratingDeletion?: unknown;
        ratingDiscussion?: unknown;
        ratingTargetOwnerDeletion?: unknown;
      };
      runtime.ratingManagement = {};
      runtime.ratingDeletion = {};
      runtime.ratingDiscussion = {};
      runtime.ratingTargetOwnerDeletion = {};
      s.pendingRatings.freeze({
        version: 7,
        accountId: s.accountId,
        intent: editingIntent(),
      });
      s.gateway.receipt = async () => {
        s.calls.push('receipt');
        return outcome === 'rejected'
          ? cancelledEditingReceipt()
          : editingReceipt(outcome);
      };
      const page = make(s, (view) => views.push(view));
      await page.load(null);
      assert.equal(s.pendingRatings.load(s.accountId), null);
      assert.deepEqual(s.calls, ['receipt']);
      assert.equal(s.ratings.calls.length, 0);
      assert.equal(JSON.stringify(views).includes(editedName), false);
      assert.equal(JSON.stringify(views).includes(editedDescription), false);
      page.dispose();
    }
  }
});

test('legacy creation recovery blocks editing without disclosing its draft or requiring current edit eligibility', async () => {
  const s = editingHarness();
  const runtime = s.runtime as { ratingManagement?: unknown };
  runtime.ratingManagement = {
    receipt: async () => {
      throw new ClientError('network', 'unknown');
    },
  };
  s.pendingRatings.freeze({
    version: 5,
    accountId: s.accountId,
    intent: creationIntent(),
  });
  await s.controller.load({ targetId });
  assert.deepEqual(s.calls, []);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().name, '');
  assert.equal(s.view().canCancelEditing, false);
  assert.equal(
    JSON.stringify(s.views).includes(creationIntent().payload.name),
    false,
  );
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  s.controller.requestCancelEditing();
  await s.controller.confirmCancelEditing();
  assert.equal(s.ids.count, 0);
  assert.deepEqual(s.calls, []);
});

test('unknown HTTP, final-proof and review failures leave recovery frozen; only durable rejection closes the slot', async () => {
  for (const code of [
    'CONTENT_REVIEW_UNAVAILABLE',
    'RATING_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'VERIFICATION_UNAVAILABLE',
    'RATING_NOT_FOUND',
    'RATING_EDIT_CONTEXT_CHANGED',
    'INTERNAL_ERROR',
  ]) {
    const s = await ready();
    s.gateway.command = async () => {
      throw new ClientError('http', 'uncertain', {
        httpStatus: 503,
        serverCode: code,
      });
    };
    s.controller.requestEdit();
    await s.controller.confirmEdit();
    const original = s.pendingRatings.load(s.accountId);
    assert.equal(original?.version, 7);
    assert.equal(s.view().frozen, true);
    await s.controller.recover();
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(s.view().receiptStatus, '');
  }
  const s = await ready();
  s.gateway.command = async () => ({
    ...cancelledEditingReceipt(),
    code: 'RATING_EDIT_CONTEXT_CHANGED',
  });
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().ready, false);
  assert.equal(s.view().name, '');
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().needsRefresh, true);
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  assert.equal(s.ids.count, 1);
});

test('mismatched or malformed context cannot expose a form, generate a new request or dispatch', async () => {
  for (const patch of [
    { targetId: otherId },
    { name: ' not canonical ' },
    { definitionRevision: 'invalid' },
    { contentVersion: 0 },
    { creatorId: otherId },
  ]) {
    const s = editingHarness();
    s.gateway.context = async () => ({ ...editingContext(), ...patch });
    await s.controller.load({ targetId });
    s.controller.requestEdit();
    await s.controller.confirmEdit();
    assert.equal(s.view().ready, false);
    assert.equal(s.view().name, '');
    assert.equal(s.view().description, '');
    assert.equal(s.ids.count, 0);
    assert.equal(s.pendingRatings.load(s.accountId), null);
  }
});

test('UUID wait cancellation, route closure, scope, target change and Safety invalidation prevent persistence and dispatch', async () => {
  for (const stop of [
    'close',
    'dismiss',
    'scope',
    'browse',
    'safety',
    'target',
  ] as const) {
    const s = await ready(),
      id = deferred<string>();
    s.ids.next = () => id.promise;
    s.controller.requestEdit();
    const work = s.controller.confirmEdit();
    await flush();
    if (stop === 'close') s.controller.cancel();
    else if (stop === 'dismiss') s.controller.dismissEdit();
    else if (stop === 'scope') s.directoryScopeChanges.clear(s.accountId);
    else if (stop === 'browse') s.browsingScopeChanges.clear(s.accountId);
    else if (stop === 'safety') s.safetyChanges.invalidate(s.accountId);
    else
      s.runtime.ratingTargetChanges!.publish({ targetId, revision: otherId });
    id.resolve(requestId);
    await work;
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.deepEqual(s.calls, ['context']);
    assert.equal(s.view().receiptStatus, '');
    if (stop !== 'dismiss') {
      assert.equal(s.view().name, '');
      assert.equal(s.view().description, '');
    }
  }
});

test('late success/noop/rejection cannot settle after account replacement, same-account login, hide, scope change or close', async () => {
  for (const result of [
    editingReceipt(),
    editingReceipt('noop'),
    cancelledEditingReceipt(),
  ]) {
    for (const stop of [
      'account',
      'same-account',
      'hide',
      'close',
      'scope',
      'browse',
      'safety',
    ] as const) {
      const s = await ready(),
        response = deferred<RatingTargetOwnerEditingReceipt>();
      s.gateway.command = async () => response.promise;
      s.controller.requestEdit();
      const work = s.controller.confirmEdit();
      await flush();
      const original = s.pendingRatings.load(s.accountId);
      if (stop === 'account' || stop === 'same-account')
        s.sessions.completeLogin(
          s.sessions.beginLogin(),
          stop === 'account'
            ? { ...wireCredentials('b'), accountId: otherId }
            : wireCredentials('b'),
        );
      else if (stop === 'hide') s.runtime.privateViews!.clear();
      else if (stop === 'close') s.controller.cancel();
      else if (stop === 'scope') s.directoryScopeChanges.clear(s.accountId);
      else if (stop === 'browse') s.browsingScopeChanges.clear(s.accountId);
      else s.safetyChanges.invalidate(s.accountId);
      response.resolve(result);
      await work;
      assert.deepEqual(s.pendingRatings.load(s.accountId), original);
      assert.equal(s.view().receiptStatus, '');
      assert.equal(s.view().name, '');
      assert.equal(s.view().description, '');
    }
  }
});

test('explicit server cancellation is separately confirmed and a prior applied/noop result wins', async () => {
  for (const result of [
    cancelledEditingReceipt(),
    editingReceipt(),
    editingReceipt('noop'),
  ]) {
    const s = await unknownCommand();
    await s.controller.confirmCancelEditing();
    assert.equal(s.calls.includes('cancel'), false);
    let calls = 0;
    s.gateway.cancel = async (intent) => {
      calls++;
      assert.deepEqual(intent, editingIntent());
      return result;
    };
    s.controller.requestCancelEditing();
    assert.equal(s.view().cancelEditingConfirmation, true);
    s.controller.dismissCancelEditing();
    await s.controller.confirmCancelEditing();
    assert.equal(calls, 0);
    s.controller.requestCancelEditing();
    await s.controller.confirmCancelEditing();
    assert.equal(calls, 1);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().canCancelEditing, false);
    assert.equal(s.view().name, '');
    assert.equal(s.view().needsRefresh, true);
    assert.equal(
      s.view().receiptStatus.includes('已撤销'),
      result.outcome === 'rejected',
    );
  }
});

test('lost cancellation and late cancellation after account switch cannot erase an uncertain edit', async () => {
  const s = await unknownCommand(),
    original = s.pendingRatings.load(s.accountId);
  s.gateway.cancel = async () => {
    throw new ClientError('network', 'lost cancel');
  };
  s.controller.requestCancelEditing();
  await s.controller.confirmCancelEditing();
  await s.controller.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  const result = deferred<RatingTargetOwnerEditingReceipt>();
  s.gateway.cancel = async () => result.promise;
  s.controller.requestCancelEditing();
  const work = s.controller.confirmCancelEditing();
  await flush();
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  result.resolve(cancelledEditingReceipt());
  await work;
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(s.view().receiptStatus, '');
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials());
  s.gateway.receipt = async () => cancelledEditingReceipt();
  await s.controller.load(null);
  assert.equal(s.pendingRatings.load(s.accountId), null);
});

test('new account cannot reveal, retry or cancel the original account editing journal', async () => {
  const s = await unknownCommand(),
    original = s.pendingRatings.load(s.accountId);
  const before = s.calls.length;
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    accountId: otherId,
  });
  assert.equal(s.view().name, '');
  assert.equal(s.view().description, '');
  assert.equal(s.view().canCancelEditing, false);
  assert.equal(s.view().recoveryOperation, '');
  assert.equal(s.pendingRatings.load(otherId), null);
  s.controller.requestCancelEditing();
  await s.controller.confirmCancelEditing();
  await s.controller.recover(true);
  assert.equal(s.calls.length, before);
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
});

test('freeze write/readback failure and malformed journal block network and never turn history into current form text', async () => {
  const s = await ready();
  s.storage.failWrite = true;
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().name, '');
  const t = editingHarness();
  t.storage.set(`whaleu.ratings.pending.v7:synthetic-ratings:${t.accountId}`, {
    version: 7,
    accountId: t.accountId,
    intent: {
      ...editingIntent(),
      payload: { ...editingIntent().payload, name: ' not canonical ' },
    },
  });
  await t.controller.load({ targetId });
  t.controller.requestEdit();
  await t.controller.confirmEdit();
  assert.deepEqual(t.calls, []);
  assert.equal(t.view().frozen, true);
  assert.equal(t.view().name, '');
  assert.equal(t.ids.count, 0);
});

test('local settlement failure preserves v7 and cannot publish a target change or historical success', async () => {
  const s = await ready(),
    changes: unknown[] = [];
  s.runtime.ratingTargetChanges!.subscribe((change) => changes.push(change));
  s.storage.failRemove = true;
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  assert.equal(s.pendingRatings.load(s.accountId)?.version, 7);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().receiptStatus, '');
  assert.deepEqual(changes, []);
  s.storage.failRemove = false;
  s.gateway.receipt = async () => editingReceipt();
  await s.controller.recover();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.deepEqual(changes, [
    { targetId, revision: editingReceipt().revision },
  ]);
});

test('changed journal or malformed historical receipt cannot settle the captured original command', async () => {
  const s = await ready(),
    result = deferred<RatingTargetOwnerEditingReceipt>();
  s.gateway.command = async () => result.promise;
  s.controller.requestEdit();
  const work = s.controller.confirmEdit();
  await flush();
  const key = `whaleu.ratings.pending.v7:synthetic-ratings:${s.accountId}`;
  const changed = {
    version: 7,
    accountId: s.accountId,
    intent: {
      ...editingIntent(),
      payload: {
        ...editingIntent().payload,
        name: 'Changed outside this command',
      },
    },
  };
  s.storage.set(key, changed);
  result.resolve(editingReceipt());
  await work;
  assert.deepEqual(s.storage.get(key), changed);
  assert.equal(s.view().receiptStatus, '');
  assert.equal(s.view().frozen, true);
  for (const result of [
    { ...editingReceipt(), targetId: otherId },
    { ...editingReceipt(), revision },
    { ...editingReceipt(), contentVersion: 5 },
    { ...editingReceipt(), name: 'private' },
  ]) {
    const t = await unknownCommand(),
      original = t.pendingRatings.load(t.accountId);
    t.gateway.receipt = async () => result;
    await t.controller.recover();
    assert.deepEqual(t.pendingRatings.load(t.accountId), original);
    assert.equal(t.view().receiptStatus, '');
  }
});

test('history confirmation never repaints edited text; explicit reload re-reads current authorization instead', async () => {
  const s = await ready();
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  assert.equal(s.view().name, '');
  assert.match(s.view().receiptStatus, /历史操作/);
  s.gateway.context = async () => {
    throw new ClientError('http', 'now hidden', {
      httpStatus: 404,
      serverCode: 'RATING_NOT_FOUND',
    });
  };
  await s.controller.reload();
  assert.equal(s.view().ready, false);
  assert.equal(s.view().name, '');
  assert.equal(s.view().description, '');
  assert.equal(s.pendingRatings.load(s.accountId), null);
});

test('successful edits emit only target/revision, clear catalog/detail snapshots and keep known-ID editing navigation minimal', async () => {
  for (const outcome of ['applied', 'noop'] as const) {
    const s = await ready(),
      details: RatingView[] = [],
      catalog: RatingView[] = [];
    const detail = new RatingController(s.runtime, 'detail', (view) =>
      details.push(view),
    );
    const list = new RatingController(s.runtime, 'catalog', (view) =>
      catalog.push(view),
    );
    await detail.load({ targetId });
    await list.load({});
    assert.ok(details[details.length - 1]!.detail);
    const changes: unknown[] = [];
    s.runtime.ratingTargetChanges!.subscribe((change) => changes.push(change));
    s.gateway.command = async () => editingReceipt(outcome);
    s.controller.requestEdit();
    await s.controller.confirmEdit();
    assert.deepEqual(changes, [
      { targetId, revision: editingReceipt(outcome).revision },
    ]);
    assert.equal(details[details.length - 1]!.detail, null);
    assert.equal(catalog[catalog.length - 1]!.categories.length, 0);
    assert.equal(details[details.length - 1]!.needsRefresh, true);
    assert.equal(
      detail.ownerEditingPath(),
      `/pages/target-owner-edit/target-owner-edit?targetId=${targetId}`,
    );
    detail.dispose();
    list.dispose();
  }
});

test('edit invalidation clears loaded thread bodies, author labels and drafts and suppresses late reply reads', async () => {
  for (const inFlight of [false, true]) {
    const s = await ready(),
      discussion = new FakeRatingDiscussionGateway();
    const response = deferred<ReturnType<typeof replyPage>>(),
      views: RatingThreadView[] = [];
    if (inFlight) discussion.repliesImpl = () => response.promise;
    const thread = new RatingThreadController(
      { ...s.runtime, ratingDiscussion: discussion },
      (view) => views.push(view),
    );
    const work = thread.load(threadRoute);
    if (inFlight) await flush();
    else {
      await work;
      assert.ok(views[views.length - 1]!.discussion);
      thread.compose(replyId);
      thread.setText('Private pending reply');
      assert.ok(views[views.length - 1]!.replyToName);
    }
    s.controller.requestEdit();
    await s.controller.confirmEdit();
    response.resolve(replyPage());
    await work;
    const view = views[views.length - 1]!;
    assert.equal(view.detail, null);
    assert.equal(view.discussion, null);
    assert.deepEqual(view.replies, []);
    assert.equal(view.replyToName, '');
    assert.equal(view.text, '');
    assert.equal(view.busy, false);
    assert.equal(view.needsRefresh, true);
    thread.dispose();
  }
});

for (const recovered of [false, true])
  for (const inFlight of [false, true])
    test(`${recovered ? 'recovered' : 'confirmed'} edit invalidates ${inFlight ? 'in-flight' : 'loaded'} complete-pool random result and stale navigation`, async () => {
      const s = editingHarness(),
        result = deferred<RatingRandomResult>(),
        views: RatingRandomView[] = [];
      let cancellation: Cancellation | undefined;
      const random = new RatingRandomController(
        {
          ...s.runtime,
          ratingRandom: {
            draw: async (_query, cancel) => {
              cancellation = cancel;
              return inFlight ? result.promise : randomResult();
            },
          },
        },
        (view) => views.push(view),
      );
      random.load({ categoryId });
      const reading = random.draw();
      if (inFlight) await flush();
      else {
        await reading;
        assert.ok(random.targetPath());
      }
      if (recovered) {
        s.pendingRatings.freeze({
          version: 7,
          accountId: s.accountId,
          intent: editingIntent(),
        });
        s.gateway.receipt = async () => editingReceipt();
        await s.controller.load(null);
      } else {
        await s.controller.load({ targetId });
        s.controller.setName(editedName);
        s.controller.setDescription(editedDescription);
        s.controller.requestEdit();
        await s.controller.confirmEdit();
      }
      assert.equal(cancellation?.isCancelled, inFlight);
      result.resolve(randomResult());
      await reading;
      const view = views[views.length - 1]!;
      assert.equal(view.loaded, false);
      assert.equal(view.result, null);
      assert.equal(view.busy, false);
      assert.equal(view.categoryId, categoryId);
      assert.equal(random.targetPath(), null);
      assert.match(view.status, /重新抽取/);
      random.dispose();
      s.controller.dispose();
    });

test('same-account new login still queries history first and never reloads old text before an explicit same-key retry', async () => {
  const s = await unknownCommand(),
    original = s.pendingRatings.load(s.accountId);
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  s.calls.length = 0;
  const views: RatingTargetOwnerEditingView[] = [];
  const reopened = new RatingTargetOwnerEditingController(s.runtime, (view) =>
    views.push(view),
  );
  await reopened.load({ targetId: otherId });
  assert.deepEqual(s.calls, ['receipt']);
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(views[views.length - 1]!.name, '');
  assert.equal(views[views.length - 1]!.description, '');
  s.gateway.command = async (intent) => {
    s.calls.push('command');
    assert.deepEqual(intent, editingIntent());
    return editingReceipt();
  };
  await reopened.recover(true);
  assert.deepEqual(s.calls, ['receipt', 'command']);
  assert.equal(s.ids.count, 1);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.name, '');
  reopened.dispose();
});

test('late context reads cannot refill a private form after login, scope, Safety or explicit close invalidates it', async () => {
  for (const stop of [
    'account',
    'same-account',
    'scope',
    'browse',
    'safety',
    'close',
  ] as const) {
    const s = editingHarness(),
      response = deferred<ReturnType<typeof editingContext>>();
    s.gateway.context = async () => response.promise;
    const work = s.controller.load({ targetId });
    await flush();
    if (stop === 'account' || stop === 'same-account')
      s.sessions.completeLogin(
        s.sessions.beginLogin(),
        stop === 'account'
          ? { ...wireCredentials('b'), accountId: otherId }
          : wireCredentials('b'),
      );
    else if (stop === 'scope') s.directoryScopeChanges.clear(s.accountId);
    else if (stop === 'browse') s.browsingScopeChanges.clear(s.accountId);
    else if (stop === 'safety') s.safetyChanges.invalidate(s.accountId);
    else s.controller.cancel();
    response.resolve(editingContext());
    await work;
    assert.equal(s.view().ready, false);
    assert.equal(s.view().name, '');
    assert.equal(s.view().description, '');
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.ids.count, 0);
  }
});

test('a failed original-journal readback stops command dispatch while preserving a recoverable v7 attempt', async () => {
  const s = await ready(),
    originalSet = s.storage.set.bind(s.storage),
    originalGet = s.storage.get.bind(s.storage);
  let failNextRead = false;
  s.storage.set = (key, value) => {
    originalSet(key, value);
    if (key.startsWith('whaleu.ratings.pending.v7:')) failNextRead = true;
  };
  s.storage.get = (key) => {
    if (failNextRead) {
      failNextRead = false;
      throw new Error('freeze readback failed');
    }
    return originalGet(key);
  };
  s.controller.requestEdit();
  await s.controller.confirmEdit();
  assert.deepEqual(s.calls, ['context']);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().name, '');
  assert.deepEqual(s.pendingRatings.load(s.accountId), {
    version: 7,
    accountId: s.accountId,
    intent: editingIntent(),
  });
  await s.controller.recover();
  assert.deepEqual(s.calls, ['context', 'receipt']);
  assert.equal(s.pendingRatings.load(s.accountId)?.version, 7);
});
