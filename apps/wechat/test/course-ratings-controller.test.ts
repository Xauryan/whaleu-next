import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { CourseRatingController } from '../src/course-ratings/controller';
import { PendingCourseRatingStore } from '../src/course-ratings/pending';
import type { CourseReceipt } from '../src/course-ratings/contract';
import { wireCredentials } from './identity-helpers';
import { deferred, flush } from './helpers';
import {
  choose,
  course,
  courseHarness,
  detail,
  id,
  otherId,
  page,
  payload,
  receipt,
  requestId,
  recordedAt,
} from './course-ratings-helpers';

test('course first score requires all independent selections and explicit final confirmation', async () => {
  const s = courseHarness();
  await s.controller.load(id);
  s.controller.chooseScore('gradeScore', 0.5);
  s.controller.chooseScore('abilityScore', 4.5);
  assert.equal(s.view().overallScore, null);
  assert.equal(s.view().canSubmit, false);
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  s.controller.chooseScore('overallScore', 1.5);
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  s.controller.confirm();
  s.controller.closeConfirmation();
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  s.controller.confirm();
  await Promise.all([s.controller.submit(), s.controller.submit()]);
  assert.equal(s.commands.length, 1);
  assert.deepEqual(s.commands[0], payload());
  assert.equal(s.ids.count, 1);
  assert.equal(s.view().detail?.myScore.kind, 'recorded');
  assert.equal(s.view().canScore, false);
  assert.equal(
    s.pendingCourseRatings.load(s.sessions.snapshot().credentials!.accountId),
    null,
  );
});
test('unavailable own or aggregate history disables submission without labeling it not-submitted', async () => {
  for (const value of [
    detail({ myScore: { kind: 'unavailable' } }),
    detail({ course: course({ summary: { kind: 'unavailable' } }) }),
  ]) {
    const s = courseHarness();
    s.impl.detail = async () => value;
    await s.controller.load(id);
    choose(s);
    await s.controller.submit();
    assert.equal(s.view().canScore, false);
    assert.equal(s.commands.length, 0);
    assert.match(s.view().blocker, /暂不能确认/);
  }
});
test('persist/read-back occurs before network and storage failure never sends', async () => {
  const s = courseHarness();
  await s.controller.load(id);
  choose(s);
  s.storage.failWrite = true;
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  const t = courseHarness();
  await t.controller.load(id);
  choose(t);
  t.impl.submit = async (_id, command) => {
    assert.deepEqual(
      t.pendingCourseRatings.load(t.sessions.snapshot().credentials!.accountId)
        ?.payload,
      command,
    );
    throw new ClientError('network', 'Synthetic response lost');
  };
  await t.controller.submit();
  assert.equal(t.view().frozen, true);
  assert.equal(
    t.pendingCourseRatings.load(t.sessions.snapshot().credentials!.accountId)
      ?.payload.overallScore,
    1.5,
  );
});
test('lost response, restart, source withdrawal and receipt miss keep original key until exact receipt', async () => {
  const s = courseHarness();
  await s.controller.load(id);
  choose(s);
  s.impl.submit = async () => {
    throw new ClientError('timeout', 'Synthetic loss');
  };
  await s.controller.submit();
  const original = s.pendingCourseRatings.load(
    s.sessions.snapshot().credentials!.accountId,
  )!;
  s.controller.dispose();
  s.impl.detail = async () => {
    throw new ClientError('http', 'Withdrawn', {
      serverCode: 'COURSE_NOT_FOUND',
      httpStatus: 404,
    });
  };
  const views: typeof s.views = [];
  const restarted = new CourseRatingController(s.runtime, 'detail', (view) =>
    views.push(view),
  );
  await restarted.load(id);
  assert.equal(views[views.length - 1]!.frozen, true);
  await restarted.recover();
  assert.equal(views[views.length - 1]!.frozen, true);
  assert.deepEqual(s.pendingCourseRatings.load(original.accountId), original);
  await restarted.recover(true);
  assert.equal(s.ids.count, 1);
  assert.deepEqual(s.commands[1], original.payload);
  s.impl.receipt = async () => receipt(original.payload);
  await restarted.recover();
  assert.equal(s.pendingCourseRatings.load(original.accountId), null);
  assert.equal(views[views.length - 1]!.frozen, false);
  assert.equal(views[views.length - 1]!.detail, null);
  assert.match(views[views.length - 1]!.receiptStatus, /已确认成功/);
});
test('hide/root-hide and account changes cancel late callbacks without deleting original recovery', async () => {
  for (const action of ['hide', 'account'] as const) {
    const s = courseHarness();
    await s.controller.load(id);
    choose(s);
    const delayed = deferred<CourseReceipt>();
    s.impl.submit = () => delayed.promise;
    const submitting = s.controller.submit();
    await flush();
    const original = s.pendingCourseRatings.load(
      s.sessions.snapshot().credentials!.accountId,
    )!;
    assert.ok(original);
    if (action === 'hide') s.runtime.privateViews!.clear();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), {
        ...wireCredentials(),
        accountId: otherId,
      });
    delayed.resolve(receipt());
    await submitting;
    assert.equal(s.view().detail, null);
    assert.equal(s.view().recoveryScores, null);
    assert.deepEqual(s.pendingCourseRatings.load(original.accountId), original);
    assert.equal(s.pendingCourseRatings.load(otherId), null);
  }
});
test('account/hide while request UUID is pending cannot persist or dispatch', async () => {
  const s = courseHarness();
  await s.controller.load(id);
  choose(s);
  const delayed = deferred<string>();
  s.ids.next = () => delayed.promise;
  const task = s.controller.submit();
  await flush();
  s.controller.dispose();
  delayed.resolve(requestId);
  await task;
  assert.equal(s.commands.length, 0);
  assert.equal(s.storage.data.size, 0);
});
test('matching rejected receipt releases old key and refreshes; malformed or wrong tuple does not', async () => {
  for (const code of [
    'COURSE_ALREADY_RATED',
    'COURSE_REVISION_CONFLICT',
  ] as const) {
    const s = courseHarness();
    await s.controller.load(id);
    choose(s);
    s.impl.submit = async () => ({
      requestId,
      operation: 'course.first-score.v1',
      outcome: 'rejected',
      courseId: id,
      code,
    });
    await s.controller.submit();
    assert.equal(s.view().frozen, false);
    assert.match(s.view().receiptStatus, /已确认未写入/);
    assert.equal(
      s.pendingCourseRatings.load(s.sessions.snapshot().credentials!.accountId),
      null,
    );
    assert.equal(s.view().confirming, false);
  }
  const s = courseHarness();
  await s.controller.load(id);
  choose(s);
  s.impl.submit = async () => receipt(payload({ overallScore: 5 }));
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
});
test('unknown receipt cannot unlock even after own-read says not submitted', async () => {
  const s = courseHarness();
  await s.controller.load(id);
  choose(s);
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic loss');
  };
  await s.controller.submit();
  await s.controller.reload();
  assert.equal(s.view().detail?.myScore.kind, 'not_submitted');
  assert.equal(s.view().canScore, false);
  assert.equal(s.view().frozen, true);
  choose(s);
  await s.controller.submit();
  assert.equal(s.commands.length, 1);
});
test('catalog name query, mutually exclusive filters and bounded pages do not mix revisions', async () => {
  const s = courseHarness('catalog');
  await s.controller.load();
  s.controller.setDepartment(99);
  s.controller.setCategory('合成类别');
  assert.equal(s.view().departmentDraft, null);
  s.controller.setDepartment(99);
  assert.equal(s.view().categoryDraft, '');
  s.controller.setSearch('合成');
  s.controller.setSort('time');
  s.impl.list = async () =>
    page({
      items: [course({ department: 95 })],
      nextCursor: 'next',
      continuation: 'more',
    });
  await s.controller.search();
  assert.deepEqual(s.calls[s.calls.length - 1]!.args[0], {
    search: '合成',
    department: 99,
    sort: 'time',
  });
  assert.equal(s.view().canNext, true);
  s.impl.list = async () => page({ scoreRevision: '2' });
  await s.controller.next();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().items.length, 0);
  assert.equal(s.view().restartRequired, true);
  s.impl.list = async () => page({ items: [] });
  await s.controller.reload();
  assert.equal(s.view().loaded, true);
  assert.match(s.view().status, /已确认没有课程/);
  s.impl.list = async () => {
    throw new ClientError('http', 'Unavailable', {
      serverCode: 'COURSE_CATALOG_UNAVAILABLE',
      httpStatus: 503,
    });
  };
  await s.controller.reload();
  assert.equal(s.view().loaded, false);
  assert.match(s.view().error, /不代表目录为空/);
});
test('origin/account journal remains immutable and failed settle preserves recovery', () => {
  const s = courseHarness(),
    accountId = s.sessions.snapshot().credentials!.accountId;
  const original = s.pendingCourseRatings.freeze({
    version: 1,
    accountId,
    courseId: id,
    payload: payload(),
  });
  assert.throws(() =>
    s.pendingCourseRatings.freeze({
      ...original,
      payload: payload({ overallScore: 5 }),
    }),
  );
  assert.equal(
    new PendingCourseRatingStore(s.storage, 'different-origin').load(accountId),
    null,
  );
  assert.equal(s.pendingCourseRatings.load(otherId), null);
  s.storage.failRemove = true;
  assert.throws(() => s.pendingCourseRatings.settle(original, receipt()));
  assert.deepEqual(s.pendingCourseRatings.load(accountId), original);
});
test('recorded first tuple is read-only even if aggregate is unavailable', async () => {
  const s = courseHarness();
  s.impl.detail = async () =>
    detail({
      myScore: {
        kind: 'recorded',
        gradeScore: 1,
        abilityScore: 5,
        overallScore: 0.5,
        recordedAt,
      },
      course: course({ summary: { kind: 'unavailable' } }),
    });
  await s.controller.load(id);
  choose(s);
  await s.controller.submit();
  assert.equal(s.view().canScore, false);
  assert.equal(s.commands.length, 0);
  assert.equal(s.view().detail?.myScore.kind, 'recorded');
});

test('freezing clears the pre-command own status and aggregate before dispatch, preserving only the exact recovery tuple', async () => {
  const s = courseHarness();
  await s.controller.load(id);
  choose(s);
  s.impl.submit = async (_courseId, command) => {
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().detail, null);
    assert.equal(s.view().gradeScore, null);
    assert.equal(s.view().abilityScore, null);
    assert.equal(s.view().overallScore, null);
    assert.deepEqual(s.view().recoveryScores, {
      gradeScore: command.gradeScore,
      abilityScore: command.abilityScore,
      overallScore: command.overallScore,
    });
    throw new ClientError('forbidden', 'Synthetic eligibility loss', {
      httpStatus: 403,
      serverCode: 'SAFETY_ACTION_RESTRICTED',
    });
  };
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().detail, null);
  assert.equal(s.view().loaded, false);
  assert.deepEqual(s.view().recoveryScores, {
    gradeScore: 0.5,
    abilityScore: 4.5,
    overallScore: 1.5,
  });
});

test('an unavailable receipt lookup clears a newer current snapshot without dropping the original tuple', async () => {
  const s = courseHarness();
  await s.controller.load(id);
  choose(s);
  s.impl.submit = async () => {
    throw new ClientError('network', 'Synthetic loss');
  };
  await s.controller.submit();
  await s.controller.reload();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().detail?.myScore.kind, 'not_submitted');
  assert.equal(s.view().frozen, true);
  await s.controller.recover();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().detail, null);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().recoveryScores?.overallScore, 1.5);
  assert.equal(
    s.pendingCourseRatings.load(s.accountId)?.payload.clientRequestId,
    requestId,
  );
});
