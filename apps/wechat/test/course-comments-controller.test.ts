import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  CourseCommentsController,
  type CourseCommentsView,
} from '../src/course-comments/controller';
import type { CourseCommentReceipt } from '../src/course-comments/contract';
import { PendingCourseCommentStore } from '../src/course-comments/pending';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  body,
  cancelled,
  choosePublish,
  commentId,
  commentsHarness,
  id,
  like,
  missing,
  otherId,
  page,
  publish,
  receipt,
  requestId,
} from './course-comments-helpers';

test('explicit preview then confirmation publishes exact text, and distinct comments remain allowed', async () => {
  const s = commentsHarness();
  await s.controller.load(id);
  s.controller.setBody(body);
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  s.controller.confirmPublish();
  assert.equal(s.view().confirming, 'publish');
  s.controller.setBody('not confirmed');
  assert.equal(s.view().body, body);
  await Promise.all([s.controller.submit(), s.controller.submit()]);
  assert.equal(s.commands.length, 1);
  assert.deepEqual(s.commands[0], publish());
  assert.equal(s.view().frozen, false);
  s.ids.next = async () => otherId;
  choosePublish(s, '第二条不同评论');
  await s.controller.submit();
  assert.equal(s.commands.length, 2);
  assert.equal(s.commands[1]!.payload.clientRequestId, otherId);
  assert.equal(s.pendingCourseComments.load(s.accountId), null);
});
test('like has separate irreversible confirmation with no unlike or author eligibility inference', async () => {
  const s = commentsHarness();
  await s.controller.load(id);
  s.controller.confirmLike(otherId);
  assert.equal(s.view().confirming, null);
  s.controller.confirmLike(commentId);
  assert.equal(s.view().confirming, 'like');
  assert.deepEqual(s.view().selectedComment, page().items[0]);
  await s.controller.submit();
  assert.deepEqual(s.commands, [like()]);
  assert.match(s.view().receiptStatus, /不能取消/);
  s.ids.next = async () => otherId;
  s.impl.submit = async (intent) => ({
    requestId: intent.payload.clientRequestId,
    courseId: id,
    operation: 'course.comment.like.v1',
    commentId,
    outcome: 'rejected',
    code: 'COURSE_COMMENT_ALREADY_LIKED',
  });
  s.controller.confirmLike(commentId);
  await s.controller.submit();
  assert.match(s.view().receiptStatus, /已经赞过/);
  assert.equal(s.pendingCourseComments.load(s.accountId), null);
});
test('journal persistence and readback precede transport; write failure cannot dispatch', async () => {
  const s = commentsHarness();
  await s.controller.load(id);
  choosePublish(s);
  s.storage.failWrite = true;
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  const t = commentsHarness();
  await t.controller.load(id);
  choosePublish(t);
  t.impl.submit = async (intent) => {
    assert.deepEqual(t.pendingCourseComments.load(t.accountId)?.intent, intent);
    assert.equal(t.view().loaded, false);
    assert.equal(t.view().items.length, 0);
    assert.equal(t.view().body, '');
    assert.equal(t.view().recoveryBody, body);
    throw new ClientError('network', 'Synthetic lost response');
  };
  await t.controller.submit();
  assert.equal(t.view().frozen, true);
});
test('lost response and restart keep original account/origin/bytes and retry must query receipt first', async () => {
  const s = commentsHarness();
  await s.controller.load(id);
  choosePublish(s);
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic response loss');
  };
  await s.controller.submit();
  const original = s.pendingCourseComments.load(s.accountId)!;
  s.controller.dispose();
  const views: CourseCommentsView[] = [],
    restarted = new CourseCommentsController(s.runtime, (value) =>
      views.push(value),
    );
  await restarted.load(id);
  assert.equal(views[views.length - 1]!.frozen, true);
  await restarted.recover(true);
  assert.deepEqual(s.commands[1], original.intent);
  assert.deepEqual(
    s.calls.slice(-2).map((call) => call.method),
    ['receipt', 'submit'],
  );
  assert.equal(s.ids.count, 1);
  s.impl.receipt = async () => receipt(original.intent);
  const before = s.commands.length;
  await restarted.recover(true);
  assert.equal(s.commands.length, before);
  assert.equal(s.pendingCourseComments.load(s.accountId), null);
  assert.equal(views[views.length - 1]!.frozen, false);
});
test('receipt-first retry never resends on unavailable/auth/review/protocol errors', async () => {
  for (const error of [
    new ClientError('http', 'Unavailable', {
      httpStatus: 503,
      serverCode: 'CONTENT_REVIEW_UNAVAILABLE',
    }),
    new ClientError('forbidden', 'Restricted', {
      httpStatus: 403,
      serverCode: 'SAFETY_ACTION_RESTRICTED',
    }),
    new ClientError('protocol', 'Bad envelope', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
    new ClientError('http', 'Wrong status', {
      httpStatus: 503,
      serverCode: 'REQUEST_NOT_FOUND',
    }),
  ]) {
    const s = commentsHarness();
    s.pendingCourseComments.freeze({
      version: 1,
      accountId: s.accountId,
      intent: publish(),
    });
    await s.controller.load();
    s.impl.receipt = async () => {
      throw error;
    };
    await s.controller.recover(true);
    assert.equal(s.commands.length, 0);
    assert.equal(s.view().frozen, true);
    assert.equal(s.view().receiptMissing, false);
    assert.ok(s.pendingCourseComments.load(s.accountId));
  }
});
test('receipt is recoverable without source/list authority and never makes old content visible', async () => {
  const s = commentsHarness();
  s.pendingCourseComments.freeze({
    version: 1,
    accountId: s.accountId,
    intent: publish(),
  });
  s.impl.list = async () => {
    throw new ClientError('http', 'Withdrawn', {
      httpStatus: 503,
      serverCode: 'COURSE_CATALOG_UNAVAILABLE',
    });
  };
  await s.controller.load(id);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().loaded, false);
  s.impl.receipt = async () => receipt();
  await s.controller.recover();
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().items, []);
  assert.match(s.view().receiptStatus, /确认发布/);
});
test('source/history/review transport failures never release the confirmed request', async () => {
  for (const [code, status] of [
    ['COURSE_CATALOG_UNAVAILABLE', 503],
    ['COURSE_COMMENT_HISTORY_UNAVAILABLE', 503],
    ['COURSE_COMMENT_BASE_REQUIRED', 403],
    ['PHONE_VERIFICATION_REQUIRED', 403],
    ['CONTENT_REVIEW_UNAVAILABLE', 503],
  ] as const) {
    const s = commentsHarness();
    await s.controller.load(id);
    choosePublish(s);
    s.impl.submit = async () => {
      throw new ClientError('http', 'Synthetic failure', {
        httpStatus: status,
        serverCode: code,
      });
    };
    await s.controller.submit();
    assert.equal(s.view().frozen, true);
    assert.deepEqual(
      s.pendingCourseComments.load(s.accountId)?.intent,
      publish(),
    );
    assert.equal(s.view().loaded, false);
  }
});
test('missing receipt cannot unlock composer; cancellation requires explicit confirmation and durable receipt', async () => {
  const s = commentsHarness();
  const original = s.pendingCourseComments.freeze({
    version: 1,
    accountId: s.accountId,
    intent: publish(),
  });
  await s.controller.load(id);
  await s.controller.recover();
  assert.equal(s.view().receiptMissing, true);
  await s.controller.confirmCancellation();
  assert.equal(s.calls.filter((call) => call.method === 'cancel').length, 0);
  await s.controller.recover(false, true);
  assert.equal(s.view().confirming, 'cancel');
  s.controller.closeConfirmation();
  assert.deepEqual(s.pendingCourseComments.load(s.accountId), original);
  await s.controller.recover(false, true);
  s.impl.cancel = async () => {
    throw new ClientError('network', 'Cancellation lost');
  };
  await s.controller.confirmCancellation();
  assert.deepEqual(s.pendingCourseComments.load(s.accountId), original);
  assert.equal(s.view().confirming, null);
  s.impl.receipt = async () => cancelled();
  await s.controller.recover();
  assert.equal(s.pendingCourseComments.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /已确认取消/);
});
test('durable cancellation racing a completed command settles the original applied result', async () => {
  const s = commentsHarness();
  s.pendingCourseComments.freeze({
    version: 1,
    accountId: s.accountId,
    intent: like(),
  });
  await s.controller.load();
  await s.controller.recover(false, true);
  s.impl.cancel = async (intent) => receipt(intent);
  await Promise.all([
    s.controller.confirmCancellation(),
    s.controller.confirmCancellation(),
  ]);
  assert.equal(s.calls.filter((call) => call.method === 'cancel').length, 1);
  assert.equal(s.pendingCourseComments.load(s.accountId), null);
  assert.match(s.view().receiptStatus, /点赞已确认成功/);
  assert.equal(s.ids.count, 0);
});
test('typed terminal rejection releases original but requires fresh read and new explicit confirmation', async () => {
  for (const code of [
    'CONTENT_REJECTED',
    'COURSE_REVISION_CONFLICT',
  ] as const) {
    const s = commentsHarness();
    await s.controller.load(id);
    choosePublish(s);
    s.impl.submit = async () => ({
      requestId,
      courseId: id,
      operation: 'course.comment.publish.v1',
      outcome: 'rejected',
      code,
    });
    await s.controller.submit();
    assert.equal(s.pendingCourseComments.load(s.accountId), null);
    assert.equal(s.view().confirming, null);
    assert.equal(s.view().body, '');
    await s.controller.submit();
    assert.equal(s.commands.length, 1);
  }
});
test('wrong operation/target receipt and failed journal deletion preserve original', async () => {
  const s = commentsHarness();
  await s.controller.load(id);
  choosePublish(s);
  s.impl.submit = async () => receipt(like());
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  assert.ok(s.pendingCourseComments.load(s.accountId));
  s.impl.receipt = async () => receipt();
  s.storage.failRemove = true;
  await s.controller.recover();
  assert.equal(s.view().frozen, true);
  assert.ok(s.pendingCourseComments.load(s.accountId));
});
test('hide, back, account replacement, same-account login and app hide fence delayed receipt callbacks', async () => {
  for (const action of [
    'hide',
    'cancel',
    'account',
    'relogin',
    'root-hide',
  ] as const) {
    const s = commentsHarness();
    await s.controller.load(id);
    choosePublish(s);
    const delayed = deferred<CourseCommentReceipt>();
    s.impl.submit = () => delayed.promise;
    const submitted = s.controller.submit();
    await flush();
    const original = s.pendingCourseComments.load(s.accountId)!;
    assert.ok(original);
    if (action === 'hide') s.controller.dispose();
    else if (action === 'cancel') s.controller.cancel();
    else if (action === 'root-hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: action === 'account' ? otherId : s.accountId,
      });
    delayed.resolve(receipt());
    await submitted;
    assert.equal(s.view().loaded, false);
    assert.deepEqual(s.view().items, []);
    assert.deepEqual(s.pendingCourseComments.load(s.accountId), original);
    if (action !== 'cancel') assert.equal(s.view().recoveryBody, '');
    assert.equal(s.pendingCourseComments.load(otherId), null);
  }
});
test('hide or session replacement while secure UUID is pending cannot persist or send', async () => {
  for (const action of ['hide', 'account'] as const) {
    const s = commentsHarness();
    await s.controller.load(id);
    choosePublish(s);
    const delayed = deferred<string>();
    s.ids.next = () => delayed.promise;
    const submitted = s.controller.submit();
    await flush();
    if (action === 'hide') s.controller.dispose();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: otherId,
      });
    delayed.resolve(requestId);
    await submitted;
    assert.equal(s.commands.length, 0);
    assert.equal(s.pendingCourseComments.load(s.accountId), null);
    assert.equal(s.pendingCourseComments.load(otherId), null);
  }
});
test('pagination is bounded replacement; revision drift clears rows and sort change restarts cursor', async () => {
  const s = commentsHarness();
  s.impl.list = async () => page({ nextCursor: 'next', continuation: 'more' });
  await s.controller.load(id);
  s.impl.list = async () => page({ commentRevision: '2' });
  await s.controller.next();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().restartRequired, true);
  assert.deepEqual(s.view().items, []);
  s.impl.list = async () => page({ items: [] });
  await s.controller.setSort('time');
  assert.equal(s.view().pageNumber, 1);
  assert.deepEqual(s.calls[s.calls.length - 1]!.args.slice(0, 3), [
    id,
    'time',
    null,
  ]);
  assert.equal(s.view().loaded, true);
  assert.match(s.view().status, /已确认没有/);
});
test('history unavailable is not empty, and storage corruption blocks new publishing and liking', async () => {
  const s = commentsHarness();
  s.impl.list = async () => {
    throw new ClientError('http', 'Unknown history', {
      httpStatus: 503,
      serverCode: 'COURSE_COMMENT_HISTORY_UNAVAILABLE',
    });
  };
  await s.controller.load(id);
  assert.equal(s.view().loaded, false);
  assert.doesNotMatch(s.view().status, /已确认没有/);
  const t = commentsHarness();
  t.storage.data.set(
    `whaleu.course-comments.pending.v1:synthetic-comment-origin:${t.accountId}`,
    { corrupt: true },
  );
  await t.controller.load(id);
  choosePublish(t);
  t.controller.confirmLike(commentId);
  await t.controller.submit();
  assert.equal(t.view().frozen, true);
  assert.equal(t.commands.length, 0);
});
test('journal rejects replacement payloads and isolates both account and API origin', () => {
  const s = commentsHarness();
  const original = s.pendingCourseComments.freeze({
    version: 1,
    accountId: s.accountId,
    intent: publish(),
  });
  assert.throws(() =>
    s.pendingCourseComments.freeze({ ...original, intent: like() }),
  );
  assert.equal(
    new PendingCourseCommentStore(s.storage, 'other-origin').load(s.accountId),
    null,
  );
  assert.equal(s.pendingCourseComments.load(otherId), null);
  assert.throws(() =>
    s.pendingCourseComments.settle(original, receipt(like())),
  );
  assert.deepEqual(s.pendingCourseComments.load(s.accountId), original);
});
test('a receipt read that was cancelled cannot dispatch the original later after absence arrives', async () => {
  const s = commentsHarness();
  s.pendingCourseComments.freeze({
    version: 1,
    accountId: s.accountId,
    intent: publish(),
  });
  await s.controller.load();
  const delayed = deferred<CourseCommentReceipt>();
  s.impl.receipt = () => delayed.promise;
  const recovery = s.controller.recover(true);
  await flush();
  s.controller.cancel();
  delayed.reject(missing());
  await recovery;
  assert.equal(s.commands.length, 0);
  assert.ok(s.pendingCourseComments.load(s.accountId));
});
