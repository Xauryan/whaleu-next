import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  RatingController,
  decodeRatingRoute,
  type RatingView,
} from '../src/ratings/controller';
import {
  ratingRejections,
  type RatingCommentPage,
  type RatingReceipt,
  type RatingTarget,
} from '../src/ratings/contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  body,
  categoryId,
  comment,
  commentId,
  commentPage,
  cursor,
  emptySummary,
  harness,
  intent,
  myScore,
  nextRevision,
  otherId,
  prepare,
  receipt,
  regionId,
  rejected,
  requestId,
  revision,
  submit,
  summary,
  target,
  targetId,
  type Harness,
} from './ratings-helpers';
const operations = ['set_score', 'create_comment', 'delete_comment'] as const;
function cleared(s: Harness): void {
  assert.equal(s.view().detail, null);
  assert.deepEqual(s.view().categories, []);
  assert.deepEqual(s.view().targets, []);
  assert.deepEqual(s.view().comments, []);
  assert.equal(s.view().myScore, null);
  assert.equal(s.view().myScoreKnown, false);
  assert.equal(s.view().summary, null);
  assert.equal(s.view().selectedScore, null);
  assert.equal(s.view().composerOpen, false);
  assert.equal(s.view().text, '');
  assert.equal(s.view().textLength, 0);
  assert.equal(s.view().authorMode, null);
  assert.equal(s.view().deleteId, null);
  assert.equal(s.view().canMoreCategories, false);
  assert.equal(s.view().canMoreTargets, false);
  assert.equal(s.view().canMoreComments, false);
}
function frozen(
  s: Harness,
  operation: (typeof operations)[number] = 'set_score',
) {
  return s.pendingRatings.freeze({
    version: 1,
    accountId: s.accountId,
    intent: intent(operation),
  });
}
function dismiss(s: Harness, operation: (typeof operations)[number]): void {
  if (operation === 'set_score') s.controller.dismissScore();
  else if (operation === 'create_comment') s.controller.closeComposer();
  else s.controller.dismissDelete();
}
for (const operation of operations) {
  test(`${operation} repeated taps mint and persist exactly one canonical command before dispatch`, async () => {
    const s = await prepare(operation),
      result = deferred<RatingReceipt>();
    s.ratings.commandImpl = async (command) => {
      assert.deepEqual(s.pendingRatings.load(s.accountId)?.intent, command);
      return result.promise;
    };
    const running = submit(s, operation);
    await Promise.all([submit(s, operation), submit(s, operation)]);
    await flush();
    assert.equal(s.ids.count, 1);
    assert.equal(s.ratings.commands.length, 1);
    assert.deepEqual(s.ratings.commands[0], intent(operation));
    assert.equal(s.view().frozen, true);
    cleared(s);
    result.resolve(receipt(s.ratings.commands[0]!));
    await running;
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().frozen, false);
    assert.equal(s.view().confirmedTargetId, targetId);
    assert.equal(s.view().loaded, true);
    s.controller.dispose();
  });
  test(`${operation} unknown commit survives restart, missing receipt and exact same-key explicit retry`, async () => {
    const s = await prepare(operation);
    s.ratings.commandImpl = async () => {
      throw new ClientError('timeout', 'Synthetic committed reply loss');
    };
    await submit(s, operation);
    const original = s.pendingRatings.load(s.accountId)!,
      bytes = JSON.stringify(original);
    s.controller.setText('Replacement text');
    s.controller.chooseScore(1);
    s.controller.setAuthorMode('named');
    await submit(s, operation);
    assert.equal(s.ratings.commands.length, 1);
    assert.equal(s.view().frozen, true);
    cleared(s);
    s.controller.dispose();
    const views: RatingView[] = [],
      reopened = new RatingController(s.runtime, 'detail', (v) =>
        views.push(v),
      );
    await reopened.load({ targetId: otherId });
    assert.equal(views[views.length - 1]!.frozen, true);
    await reopened.recover();
    assert.equal(JSON.stringify(s.pendingRatings.load(s.accountId)), bytes);
    s.ratings.commandImpl = async (command) => {
      assert.equal(JSON.stringify(command), JSON.stringify(original.intent));
      return receipt(command);
    };
    await reopened.recover(true);
    assert.equal(s.ids.count, 1);
    assert.equal(s.ratings.commands.length, 2);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(views[views.length - 1]!.detail?.id, otherId);
    reopened.dispose();
  });
  test(`${operation} dismiss during secure request ID generation prevents persistence and dispatch`, async () => {
    const s = await prepare(operation),
      id = deferred<string>();
    s.ids.next = () => id.promise;
    const running = submit(s, operation);
    await flush();
    assert.equal(s.ids.count, 1);
    dismiss(s, operation);
    cleared(s);
    id.resolve(requestId);
    await running;
    await flush();
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.ratings.commands.length, 0);
    cleared(s);
    s.controller.dispose();
  });
  test(`${operation} dismiss after dispatch preserves journal and fences late receipt`, async () => {
    const s = await prepare(operation),
      result = deferred<RatingReceipt>();
    s.ratings.commandImpl = async () => result.promise;
    const running = submit(s, operation);
    await flush();
    const original = s.pendingRatings.load(s.accountId)!;
    dismiss(s, operation);
    cleared(s);
    const count = s.views.length;
    result.resolve(receipt(original.intent));
    await running;
    await flush();
    assert.equal(s.views.length, count);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(s.view().confirmedTargetId, '');
    s.controller.dispose();
  });
}
for (const mode of ['catalog', 'detail', 'recovery'] as const)
  test(`${mode} resolves original account receipt before current context/target reads`, async () => {
    const s = harness(mode),
      original = frozen(s, 'create_comment'),
      result = deferred<RatingReceipt>();
    s.ratings.receiptImpl = async () => result.promise;
    const running = s.controller.load(mode === 'detail' ? { targetId } : {});
    await flush();
    assert.deepEqual(
      s.ratings.calls.map((c) => c.method),
      ['receipt'],
    );
    assert.deepEqual(s.profiles.calls, []);
    assert.deepEqual(s.gateway.calls, []);
    assert.equal(s.view().frozen, true);
    cleared(s);
    result.resolve(receipt(original.intent));
    await running;
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().loaded, true);
    assert.equal(s.view().confirmedTargetId, targetId);
    if (mode === 'recovery') {
      assert.deepEqual(
        s.ratings.calls.map((c) => c.method),
        ['receipt'],
      );
      assert.equal(s.view().detail, null);
      assert.equal(s.view().myScoreKnown, false);
    }
    s.controller.dispose();
  });
for (const failure of [
  'write throws',
  'write disappears',
  'read throws',
] as const)
  test(`storage ${failure} blocks first dispatch`, async () => {
    const s = await prepare('create_comment');
    if (failure === 'write throws') s.storage.failWrite = true;
    if (failure === 'write disappears') s.storage.set = () => undefined;
    if (failure === 'read throws')
      s.storage.get = () => {
        throw new Error('Synthetic storage read');
      };
    await s.controller.publish();
    assert.equal(s.ratings.commands.length, 0);
    assert.match(s.view().error, /保存失败/);
    assert.equal(s.view().frozen, true);
    assert.equal(s.view().confirmedTargetId, '');
    cleared(s);
    s.controller.dispose();
  });
test('failed journal removal keeps recovery barrier until exact receipt can settle', async () => {
  const s = await prepare();
  s.storage.failRemove = true;
  await s.controller.confirmScore();
  const original = s.pendingRatings.load(s.accountId)!;
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().confirmedTargetId, '');
  cleared(s);
  s.controller.chooseScore(1);
  await s.controller.confirmScore();
  assert.equal(s.ratings.commands.length, 1);
  s.storage.failRemove = false;
  s.ratings.receiptImpl = async () => receipt(original.intent);
  await s.controller.recover();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  s.controller.dispose();
});
for (const code of ratingRejections)
  test(`terminal ${code} settles without pretending refreshed current content or auto-reissuing`, async () => {
    const s = await prepare();
    s.ratings.commandImpl = async (command) => rejected(command, code);
    await s.controller.confirmScore();
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().frozen, false);
    assert.equal(s.view().needsRefresh, true);
    assert.equal(s.view().confirmedTargetId, '');
    assert.notEqual(s.view().receiptStatus, '');
    cleared(s);
    s.controller.chooseScore(5);
    await s.controller.confirmScore();
    assert.equal(s.ratings.commands.length, 1);
    assert.equal(s.ids.count, 1);
    s.controller.dispose();
  });
for (const failure of [
  new ClientError('network', 'Synthetic network'),
  new ClientError('timeout', 'Synthetic timeout'),
  new ClientError('http', 'Missing receipt', {
    httpStatus: 404,
    serverCode: 'REQUEST_NOT_FOUND',
  }),
  new ClientError('http', 'Transient authority', {
    httpStatus: 503,
    serverCode: 'RATING_UNAVAILABLE',
  }),
  new ClientError('http', 'Transient review', {
    httpStatus: 503,
    serverCode: 'CONTENT_REVIEW_UNAVAILABLE',
  }),
  new ClientError('http', 'Conflict without receipt', {
    httpStatus: 409,
    serverCode: 'RATING_REVISION_CONFLICT',
  }),
  new ClientError('http', 'Intent conflict', {
    httpStatus: 409,
    serverCode: 'REQUEST_CONFLICT',
  }),
])
  test(`${failure.message} retains original pending intent and blocks replacement`, async () => {
    const s = harness(),
      original = frozen(s);
    s.ratings.receiptImpl = async () => {
      throw failure;
    };
    await s.controller.load({ targetId });
    await s.controller.recover();
    assert.equal(s.view().frozen, true);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(s.ids.count, 0);
    assert.equal(s.ratings.commands.length, 0);
    cleared(s);
    s.controller.dispose();
  });
test('mismatched receipt cannot settle original journal or expose historical text and score', async () => {
  const s = harness(),
    original = frozen(s);
  s.ratings.receiptImpl = async () => ({
    ...receipt(),
    operation: 'delete_comment',
  });
  await s.controller.load({ targetId });
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  assert.equal(s.view().frozen, true);
  cleared(s);
  s.controller.dispose();
});
const interruptions = {
  'account replacement': (s: Harness) =>
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials('b'),
      accountId: otherId,
    }),
  'same-account login epoch': (s: Harness) =>
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b')),
  logout: (s: Harness) => s.sessions.logout(),
  'app hide': (s: Harness) => s.runtime.privateViews!.clear(),
  Safety: (s: Harness) => s.safetyChanges.invalidate(s.accountId),
  'identity campus': (s: Harness) => s.directoryScopeChanges.clear(s.accountId),
  'browse campus': (s: Harness) => s.browsingScopeChanges.clear(s.accountId),
  cancel: (s: Harness) => s.controller.cancel(),
  dispose: (s: Harness) => s.controller.dispose(),
};
for (const [label, interrupt] of Object.entries(interruptions)) {
  test(`${label} clears private body, score, inputs and cursors synchronously and fences late detail`, async () => {
    const s = await prepare('create_comment');
    interrupt(s);
    cleared(s);
    s.controller.dispose();
    const late = harness(),
      result = deferred<RatingTarget>();
    let cancelled = () => false;
    late.ratings.detailImpl = async (_region, _id, cancel) => {
      cancelled = () => cancel.isCancelled;
      return result.promise;
    };
    const running = late.controller.load({ targetId });
    await flush();
    interrupt(late);
    const count = late.views.length;
    assert.equal(cancelled(), true);
    cleared(late);
    result.resolve(target());
    await running;
    await flush();
    assert.equal(late.views.length, count);
    cleared(late);
    late.controller.dispose();
  });
  test(`${label} fences mutation receipt without settling its original account journal`, async () => {
    const s = await prepare('create_comment'),
      result = deferred<RatingReceipt>();
    s.ratings.commandImpl = async () => result.promise;
    const running = s.controller.publish();
    await flush();
    const original = s.pendingRatings.load(s.accountId)!;
    interrupt(s);
    const count = s.views.length;
    cleared(s);
    result.resolve(receipt(original.intent));
    await running;
    await flush();
    assert.equal(s.views.length, count);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.equal(s.view().confirmedTargetId, '');
    s.controller.dispose();
  });
  test(`${label} cancels unpersisted secure ID generation`, async () => {
    const s = await prepare(),
      id = deferred<string>();
    s.ids.next = () => id.promise;
    const running = s.controller.confirmScore();
    await flush();
    interrupt(s);
    id.resolve(requestId);
    await running;
    await flush();
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.ratings.commands.length, 0);
    cleared(s);
    s.controller.dispose();
  });
  test(`${label} invalidates startup receipt before any parent or profile read`, async () => {
    const s = harness('catalog'),
      original = frozen(s),
      result = deferred<RatingReceipt>();
    s.ratings.receiptImpl = async () => result.promise;
    const running = s.controller.load();
    await flush();
    interrupt(s);
    const count = s.views.length;
    result.resolve(receipt(original.intent));
    await running;
    await flush();
    assert.equal(s.views.length, count);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
    assert.deepEqual(
      s.ratings.calls.map((c) => c.method),
      ['receipt'],
    );
    assert.deepEqual(s.profiles.calls, []);
    cleared(s);
    s.controller.dispose();
  });
}
test('unrelated account invalidations leave current private projection and inputs intact', async () => {
  const s = await prepare('create_comment'),
    view = s.view();
  s.safetyChanges.invalidate(otherId);
  s.directoryScopeChanges.clear(otherId);
  s.browsingScopeChanges.clear(otherId);
  assert.equal(s.view(), view);
  s.controller.dispose();
});
test('switching target during delayed detail cannot transfer persona/body even after returning to original target', async () => {
  const s = harness(),
    result = deferred<RatingTarget>();
  s.ratings.detailImpl = async () => result.promise;
  const running = s.controller.load({ targetId });
  await flush();
  s.ratings.detailImpl = async (_region, id) =>
    target({ id, name: 'New authorized target' });
  await s.controller.load({ targetId: otherId });
  assert.equal(s.view().detail?.id, otherId);
  assert.equal(s.view().comments[0]!.targetId, otherId);
  await s.controller.load({ targetId });
  result.resolve(target({ name: 'Stale target title' }));
  await running;
  assert.equal(s.view().detail?.name, 'New authorized target');
  assert.equal(s.view().comments[0]!.targetId, targetId);
  s.controller.dispose();
});
test('target change before UUID resolves never persists original form or retargets original intent', async () => {
  const s = await prepare('create_comment'),
    id = deferred<string>();
  s.ids.next = () => id.promise;
  const running = s.controller.publish();
  await flush();
  await s.controller.load({ targetId: otherId });
  id.resolve(requestId);
  await running;
  await flush();
  assert.equal(s.ratings.commands.length, 0);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().detail?.id, otherId);
  assert.equal(s.view().text, '');
  s.controller.dispose();
});
test('target change after dispatch recovers original target before reading new target and old response cannot settle it', async () => {
  const s = await prepare(),
    command = deferred<RatingReceipt>();
  s.ratings.commandImpl = async () => command.promise;
  const running = s.controller.confirmScore();
  await flush();
  const original = s.pendingRatings.load(s.accountId)!,
    recovered = deferred<RatingReceipt>();
  s.ratings.receiptImpl = async () => recovered.promise;
  const switched = s.controller.load({ targetId: otherId });
  await flush();
  cleared(s);
  const count = s.views.length;
  command.resolve(receipt(original.intent));
  await running;
  assert.equal(s.views.length, count);
  assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  recovered.resolve(receipt(original.intent));
  await switched;
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().detail?.id, otherId);
  assert.equal(s.view().text, '');
  s.controller.dispose();
});
test('same-score noop sends current revision and rereads current score without inventing count or revision change', async () => {
  const s = harness();
  await s.controller.load({ targetId });
  s.controller.chooseScore(3);
  s.ratings.commandImpl = async (command) => receipt(command, 'noop');
  await s.controller.confirmScore();
  assert.equal(s.ratings.commands.length, 1);
  assert.equal(
    s.ratings.commands[0]!.operation === 'set_score' &&
      s.ratings.commands[0]!.payload.score,
    3,
  );
  assert.equal(
    s.ratings.commands[0]!.operation === 'set_score' &&
      s.ratings.commands[0]!.payload.expectedRevision,
    revision,
  );
  assert.deepEqual(s.view().myScore, myScore().myScore);
  assert.deepEqual(s.view().summary, summary());
  assert.match(s.view().receiptStatus, /未发生变更/);
  s.controller.dispose();
});
test('cross-device revision conflict requires explicit fresh read and selection, never automatic overwrite', async () => {
  const s = await prepare();
  s.ratings.commandImpl = async (command) => rejected(command);
  s.ratings.myScoreImpl = async () => ({
    myScore: { score: 1, revision: nextRevision },
  });
  await s.controller.confirmScore();
  assert.equal(s.view().needsRefresh, true);
  assert.match(s.view().receiptStatus, /刷新/);
  cleared(s);
  assert.equal(s.ratings.calls.filter((c) => c.method === 'myScore').length, 1);
  await s.controller.reload();
  assert.deepEqual(s.view().myScore, { score: 1, revision: nextRevision });
  assert.equal(s.view().selectedScore, null);
  assert.equal(s.ids.count, 1);
  assert.equal(s.ratings.commands.length, 1);
  s.controller.dispose();
});
test('historical applied receipt cannot overwrite a newer authoritative score or summary', async () => {
  const s = harness(),
    original = frozen(s);
  s.ratings.receiptImpl = async () => receipt(original.intent);
  s.ratings.myScoreImpl = async () => ({
    myScore: { score: 1, revision: otherId },
  });
  s.ratings.summaryImpl = async () => summary(1);
  await s.controller.load({ targetId });
  assert.equal(s.view().myScore?.score, 1);
  assert.equal(s.view().myScore?.revision, otherId);
  assert.deepEqual(s.view().summary, summary(1));
  assert.equal(s.view().selectedScore, null);
  assert.equal(s.ids.count, 0);
  s.controller.dispose();
});
test('deleting own root removes text on fresh read while retaining independent score and minimal receipt', async () => {
  const s = await prepare('delete_comment');
  s.ratings.commandImpl = async (command) => {
    s.ratings.commentsImpl = async () => commentPage({ items: [] });
    return receipt(command);
  };
  await s.controller.deleteComment();
  assert.deepEqual(s.view().comments, []);
  assert.deepEqual(s.view().myScore, myScore().myScore);
  assert.deepEqual(s.view().summary, summary());
  assert.equal(s.view().text, '');
  assert.equal(
    JSON.stringify(receipt(s.ratings.commands[0]!)).includes(body),
    false,
  );
  assert.equal(s.ratings.commands[0]!.operation, 'delete_comment');
  s.controller.dispose();
});
test('author eligibility and explicit author mode gate root creation; another user cannot be locally made deletable', async () => {
  const s = harness();
  s.ratings.detailImpl = async () =>
    target({
      allowedActions: {
        setScore: true,
        createComment: true,
        authorModes: ['named'],
      },
    });
  s.ratings.commentsImpl = async () =>
    commentPage({
      items: [comment({ isMine: false, allowedActions: { delete: false } })],
    });
  await s.controller.load({ targetId });
  s.controller.confirmDelete(commentId);
  assert.equal(s.view().deleteId, null);
  await s.controller.deleteComment();
  s.controller.openComposer();
  s.controller.setText(body);
  await s.controller.publish();
  s.controller.setAuthorMode('anonymous');
  await s.controller.publish();
  assert.equal(s.ratings.commands.length, 0);
  assert.equal(s.ids.count, 0);
  s.controller.setAuthorMode('named');
  await s.controller.publish();
  assert.equal(s.ratings.commands.length, 1);
  assert.equal(s.ratings.commands[0]!.operation, 'create_comment');
  s.controller.dispose();
});
test('root Unicode 500 boundary and canonical length are independent from score submission', async () => {
  const s = await prepare('create_comment');
  s.controller.setText('😀'.repeat(501));
  assert.equal(s.view().textLength, 501);
  await s.controller.publish();
  assert.equal(s.ratings.commands.length, 0);
  assert.equal(s.ids.count, 0);
  s.controller.setText(' \r\n' + '😀'.repeat(500) + '\r\n ');
  assert.equal(s.view().textLength, 500);
  await s.controller.publish();
  const command = s.ratings.commands[0]!;
  assert.equal(
    command.operation === 'create_comment' && command.payload.body,
    '😀'.repeat(500),
  );
  assert.equal(
    s.ratings.commands.some((c) => c.operation === 'set_score'),
    false,
  );
  s.controller.dispose();
});
test('unknown own score and unavailable summary do not masquerade as null/known zero or enable writes', async () => {
  const s = harness();
  s.ratings.myScoreImpl = async () => {
    throw new ClientError('http', 'Unknown score coverage', {
      httpStatus: 503,
      serverCode: 'RATING_SCORE_UNAVAILABLE',
    });
  };
  s.ratings.summaryImpl = async () => ({ status: 'unavailable' });
  await s.controller.load({ targetId });
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().myScoreKnown, false);
  assert.equal(s.view().myScore, null);
  assert.deepEqual(s.view().summary, { status: 'unavailable' });
  s.controller.chooseScore(5);
  await s.controller.confirmScore();
  assert.equal(s.ids.count, 0);
  s.ratings.myScoreImpl = async () => ({ myScore: null });
  s.ratings.summaryImpl = async () => emptySummary();
  await s.controller.reload();
  assert.equal(s.view().myScoreKnown, true);
  assert.equal(s.view().myScore, null);
  assert.deepEqual(s.view().summary, emptySummary());
  s.controller.chooseScore(1);
  await s.controller.confirmScore();
  const command = s.ratings.commands[0]!;
  assert.equal(
    command.operation === 'set_score' && command.payload.expectedRevision,
    null,
  );
  s.controller.dispose();
});
test('disabled ancestor direct access refuses target and never reads score or root comments afterward', async () => {
  const s = harness();
  s.ratings.detailImpl = async () => {
    throw new ClientError('http', 'Unavailable target', {
      httpStatus: 404,
      serverCode: 'RATING_NOT_FOUND',
    });
  };
  await s.controller.load({ targetId });
  cleared(s);
  assert.equal(s.view().loaded, false);
  assert.deepEqual(
    s.ratings.calls.map((c) => c.method),
    ['detail'],
  );
  assert.match(s.view().error, /不可查看/);
  s.controller.dispose();
});
test('empty scan pages keep a bounded continuation and exhaustion blocks extra reads', async () => {
  const s = harness();
  s.ratings.commentsImpl = async (_region, _id, next) =>
    next === null
      ? commentPage({ items: [], nextCursor: cursor, continuation: 'scan' })
      : commentPage();
  await s.controller.load({ targetId });
  assert.deepEqual(s.view().comments, []);
  assert.equal(s.view().canMoreComments, true);
  await s.controller.more('comments');
  assert.equal(s.view().comments.length, 1);
  assert.equal(s.view().canMoreComments, false);
  const count = s.ratings.calls.length;
  await s.controller.more('comments');
  assert.equal(s.ratings.calls.length, count);
  s.controller.dispose();
});
for (const failure of [
  'cursor cycle',
  'catalog changed',
  'restart',
  'late page',
] as const)
  test(`${failure} cannot restore stale comments or allow cursor reuse`, async () => {
    const s = harness();
    s.ratings.commentsImpl = async () =>
      commentPage({ nextCursor: cursor, continuation: 'more' });
    await s.controller.load({ targetId });
    s.controller.openComposer();
    s.controller.setText(body);
    if (failure === 'cursor cycle')
      s.ratings.commentsImpl = async () =>
        commentPage({ nextCursor: cursor, continuation: 'more' });
    if (failure === 'catalog changed')
      s.ratings.commentsImpl = async () =>
        commentPage({
          context: { regionId: null, targetId, catalogRevision: nextRevision },
        });
    if (failure === 'restart')
      s.ratings.commentsImpl = async () => {
        throw new ClientError('http', 'Expired cursor', {
          httpStatus: 409,
          serverCode: 'DISCOVERY_RESTART_REQUIRED',
        });
      };
    if (failure === 'late page') {
      const result = deferred<RatingCommentPage>();
      s.ratings.commentsImpl = async () => result.promise;
      const running = s.controller.more('comments');
      await flush();
      s.directoryScopeChanges.clear(s.accountId);
      const count = s.views.length;
      result.resolve(commentPage());
      await running;
      assert.equal(s.views.length, count);
    } else await s.controller.more('comments');
    cleared(s);
    const count = s.ratings.calls.length;
    await s.controller.more('comments');
    assert.equal(s.ratings.calls.length, count);
    s.controller.dispose();
  });
test('global catalog does not demand profile, phone context or invented region, and region changes start new root scope', async () => {
  const s = harness('catalog');
  s.ratings.contextImpl = async () => {
    throw new ClientError('http', 'Missing phone', {
      httpStatus: 403,
      serverCode: 'PHONE_VERIFICATION_REQUIRED',
    });
  };
  await s.controller.load();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().regionId, null);
  assert.deepEqual(
    s.ratings.calls.map((c) => c.method),
    ['categories'],
  );
  assert.deepEqual(s.profiles.calls, []);
  assert.equal(
    s.controller.categoryPath(categoryId),
    `/pages/rating-catalog/rating-catalog?parentId=${categoryId}`,
  );
  assert.equal(s.controller.categoryPath(otherId), null);
  s.ratings.contextImpl = async () => ({
    homeRegion: null,
    regions: [
      {
        id: regionId,
        label: 'Synthetic regional authority',
        relation: 'managed',
      },
    ],
  });
  await s.controller.loadRegions();
  await s.controller.selectRegion(regionId);
  assert.equal(s.view().regionId, regionId);
  assert.equal(s.view().parentId, null);
  assert.equal(s.view().regionsLoaded, false);
  assert.equal(s.view().canMoreCategories, false);
  assert.deepEqual(
    s.ratings.calls
      .filter((c) => c.method === 'categories')
      .map((c) => c.args.slice(0, 3)),
    [
      [null, null, null],
      [regionId, null, null],
    ],
  );
  s.controller.dispose();
});
test('strict routes reject hidden identities, wrong resource keys and malformed deep links', () => {
  assert.deepEqual(decodeRatingRoute({}, 'catalog'), {});
  assert.deepEqual(decodeRatingRoute({ targetId, regionId }, 'detail'), {
    targetId,
    regionId,
  });
  for (const route of [
    {},
    { targetId: 'bad' },
    { targetId, accountId: otherId },
    { targetId, score: '5' },
    { targetId, parentId: categoryId },
    { targetId, regionId: 'global' },
  ])
    assert.throws(() => decodeRatingRoute(route, 'detail'));
  assert.throws(() => decodeRatingRoute({ targetId }, 'recovery'));
  assert.throws(() => decodeRatingRoute({ targetId }, 'catalog'));
});
// Receipt and current-state authority are independent even immediately after a successful write.
test('confirmed score receipt followed by unavailable current score cannot restore the prior or submitted score', async () => {
  const s = await prepare();
  s.ratings.commandImpl = async (command) => {
    s.ratings.myScoreImpl = async () => {
      throw new ClientError('http', 'Fresh unknown coverage', {
        httpStatus: 503,
        serverCode: 'RATING_SCORE_UNAVAILABLE',
      });
    };
    s.ratings.summaryImpl = async () => ({ status: 'unavailable' });
    return receipt(command);
  };
  await s.controller.confirmScore();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().myScoreKnown, false);
  assert.equal(s.view().myScore, null);
  assert.deepEqual(s.view().summary, { status: 'unavailable' });
  assert.equal(s.view().selectedScore, null);
  assert.equal(s.ratings.commands.length, 1);
  s.controller.dispose();
});
for (const kind of ['write then throws', 'readback throws'] as const)
  test(`storage ${kind} keeps persisted original for receipt-first recovery without dispatch`, async () => {
    const s = await prepare('create_comment'),
      set = s.storage.set.bind(s.storage),
      get = s.storage.get.bind(s.storage);
    s.storage.set = (key, value) => {
      set(key, value);
      if (kind === 'write then throws') throw new Error('after write');
      s.storage.get = () => {
        throw new Error('readback failure');
      };
    };
    await s.controller.publish();
    assert.equal(s.ratings.commands.length, 0);
    assert.equal(s.view().frozen, true);
    cleared(s);
    s.storage.get = get;
    s.storage.set = set;
    const original = s.pendingRatings.load(s.accountId)!;
    assert.deepEqual(original.intent, intent('create_comment'));
    s.ratings.receiptImpl = async () => receipt(original.intent);
    await s.controller.reload();
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.ids.count, 1);
    assert.equal(s.ratings.commands.length, 0);
    assert.equal(s.view().loaded, true);
    s.controller.dispose();
  });
for (const failure of [
  new ClientError('http', 'Wrong status', {
    httpStatus: 500,
    serverCode: 'RATING_SCORE_UNAVAILABLE',
  }),
  new ClientError('protocol', 'Malformed response', {
    httpStatus: 503,
    serverCode: 'RATING_SCORE_UNAVAILABLE',
  }),
])
  test(`${failure.message} with score-unavailable label must clear the whole detail rather than downgrade`, async () => {
    const s = harness();
    s.ratings.myScoreImpl = async () => {
      throw failure;
    };
    await s.controller.load({ targetId });
    cleared(s);
    assert.equal(s.view().loaded, false);
    assert.equal(
      s.ratings.calls.some(
        (c) => c.method === 'summary' || c.method === 'comments',
      ),
      false,
    );
    s.controller.dispose();
  });
