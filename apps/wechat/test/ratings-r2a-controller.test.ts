import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import { RatingController, type RatingView } from '../src/ratings/controller';
import type {
  RatingReplyPage,
  RatingReplyReceipt,
} from '../src/ratings/discussion-contract';
import { ratingRejections } from '../src/ratings/contract';
import {
  RatingUpdatesController,
  type RatingUpdatesView,
} from '../src/ratings/updates-controller';
import type {
  RatingNoticeTarget,
  RatingUpdatesPage,
} from '../src/ratings/updates-contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  body,
  commentId,
  cursor,
  intent,
  otherId,
  receipt,
  regionId,
  revision,
  targetId,
} from './ratings-helpers';
import {
  discussion,
  locator,
  notice,
  noticeId,
  noticeTarget,
  readReceipt,
  reply,
  replyBody,
  replyId,
  replyIntent,
  replyPage,
  replyReceipt,
  route,
  r2aHarness,
  secondReplyId,
  updates,
} from './ratings-r2a-helpers';
type Harness = ReturnType<typeof r2aHarness>;
function cleared(s: Harness): void {
  const view = s.view();
  assert.equal(view.loaded, false);
  assert.equal(view.detail, null);
  assert.equal(view.discussion, null);
  assert.deepEqual(view.replies, []);
  assert.equal(view.canMore, false);
  assert.equal(view.anchorReplyId, '');
  assert.equal(view.text, '');
  assert.equal(view.textLength, 0);
  assert.equal(view.authorMode, null);
  assert.equal(view.composerOpen, false);
  assert.equal(view.replyToId, null);
  assert.equal(view.replyToName, '');
  assert.equal(view.deleteId, null);
}
function prepare(s: Harness, selected: string | null = null): void {
  s.controller.compose(selected);
  s.controller.setText(replyBody);
  s.controller.setAuthorMode('anonymous');
}
const missing = () =>
  new ClientError('http', 'Synthetic current target hidden', {
    httpStatus: 404,
    serverCode: 'RATING_NOT_FOUND',
  });
const unknown = () =>
  new ClientError('http', 'Synthetic authority unknown', {
    httpStatus: 503,
    serverCode: 'RATING_UNAVAILABLE',
  });

test('thread loads server-confirmed typed ancestry, preserves target persona and requires explicit author selection', async () => {
  const s = r2aHarness();
  await s.controller.load(route);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().discussion?.root.id, commentId);
  assert.equal(s.view().replies[0]?.author.mode, 'anonymous');
  s.controller.compose();
  s.controller.setText(replyBody);
  await s.controller.publish();
  assert.equal(s.ratingDiscussion.commands.length, 0);
  assert.equal(s.view().authorMode, null);
  s.controller.setAuthorMode('anonymous');
  await s.controller.publish();
  assert.equal(s.ratingDiscussion.commands.length, 1);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().anchorReplyId, secondReplyId);
  assert.match(s.view().receiptStatus, /已提交/);
  assert.doesNotMatch(s.view().receiptStatus, /经验.*到账|送达/);
  assert.equal(s.storage.data.size, 0);
});
test('reply to arbitrary current reply uses only server ID/revision and never account/recipient/name; quote unavailable still permits replying', async () => {
  const s = r2aHarness();
  s.ratingDiscussion.repliesImpl = async () =>
    replyPage({
      items: [reply({ replyTo: { kind: 'reply', status: 'unavailable' } })],
    });
  await s.controller.load(route);
  prepare(s, replyId);
  await s.controller.publish();
  const command = s.ratingDiscussion.commands[0]!;
  assert.equal(command.operation, 'create_reply');
  if (command.operation !== 'create_reply') throw new Error('fixture');
  assert.deepEqual(command.payload.replyTo, {
    replyId,
    expectedRevision: revision,
  });
  assert.equal(command.rootId, commentId);
  assert.equal(command.payload.targetId, targetId);
  assert.doesNotMatch(
    JSON.stringify(command),
    /recipient|profileId|personaId|displayName|reply_to_user_id/,
  );
});
test('server allowedActions independently gate root reply, row reply and own-only deletion', async () => {
  const s = r2aHarness();
  s.ratingDiscussion.repliesImpl = async () =>
    replyPage({
      items: [
        reply({
          isMine: false,
          allowedActions: { reply: false, delete: false },
        }),
      ],
    });
  await s.controller.load(route);
  s.controller.compose(replyId);
  assert.equal(s.view().composerOpen, false);
  s.controller.confirmDelete(replyId);
  await s.controller.deleteReply();
  assert.equal(s.ratingDiscussion.commands.length, 0);
  s.ratingDiscussion.discussionImpl = async () =>
    discussion({
      allowedActions: { createReply: false, authorModes: ['named'] },
    });
  await s.controller.reload();
  s.controller.compose();
  assert.equal(s.view().composerOpen, false);
});
for (const text of ['', '\uD800', '\u0000', '😀'.repeat(501), 'a'.repeat(1101)])
  test(`invalid reply text ${JSON.stringify(text.slice(0, 8))} is never journaled/dispatched`, async () => {
    const s = r2aHarness();
    await s.controller.load(route);
    prepare(s);
    s.controller.setText(text);
    await s.controller.publish();
    assert.equal(s.ratingDiscussion.commands.length, 0);
    assert.equal(s.storage.data.size, 0);
    assert.equal(s.ids.count, 0);
  });
test('double click freezes canonical text once; cancellation before UUID persistence dispatches nothing', async () => {
  const s = r2aHarness(),
    id = deferred<string>();
  s.ids.next = () => id.promise;
  await s.controller.load(route);
  prepare(s);
  const started = s.controller.publish();
  void s.controller.publish();
  await flush();
  assert.equal(s.ids.count, 1);
  s.controller.dismiss();
  cleared(s);
  id.resolve(otherId);
  await started;
  assert.equal(s.ratingDiscussion.commands.length, 0);
  assert.equal(s.storage.data.size, 0);
});
test('same-key uncertain create preserves pending on missing receipt and retry then reads current content only', async () => {
  const s = r2aHarness();
  await s.controller.load(route);
  prepare(s);
  s.ratingDiscussion.commandImpl = async () => {
    throw new ClientError('timeout', 'Synthetic committed loss');
  };
  await s.controller.publish();
  cleared(s);
  assert.equal(s.view().frozen, true);
  const pending = s.pendingRatings.load(s.accountId)!;
  assert.equal(pending.version, 2);
  assert.doesNotMatch(JSON.stringify(s.view()), new RegExp(replyBody));
  await s.controller.recover();
  assert.deepEqual(s.pendingRatings.load(s.accountId), pending);
  assert.equal(s.ratingDiscussion.commands.length, 1);
  s.ratingDiscussion.commandImpl = async (command) => replyReceipt(command);
  await s.controller.recover(true);
  assert.deepEqual(s.ratingDiscussion.commands[1], pending.intent);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.view().loaded, true);
});
for (const code of ratingRejections)
  test(`matched terminal ${code} ends only this reply intent and requires explicit refresh`, async () => {
    const s = r2aHarness();
    s.ratingDiscussion.commandImpl = async (command) => ({
      requestId: command.payload.clientRequestId,
      operation: command.operation,
      outcome: 'rejected',
      code,
    });
    await s.controller.load(route);
    prepare(s);
    await s.controller.publish();
    cleared(s);
    assert.equal(s.view().frozen, false);
    assert.equal(s.view().needsRefresh, true);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    await s.controller.publish();
    assert.equal(s.ratingDiscussion.commands.length, 1);
  });
for (const [label, patch] of Object.entries({
  wrongRoot: { rootId: otherId },
  wrongTarget: { targetId: otherId },
  wrongRequest: { requestId: otherId },
  wrongOperation: { operation: 'delete_reply' },
  createNoop: { outcome: 'noop' },
  extraBody: { body: replyBody },
  invalidRevision: { revision: 'bad' },
}))
  test(`reply ${label} receipt cannot settle journal or restore body`, async () => {
    const s = r2aHarness();
    s.ratingDiscussion.commandImpl = async (command) =>
      ({ ...replyReceipt(command), ...patch }) as RatingReplyReceipt;
    await s.controller.load(route);
    prepare(s);
    await s.controller.publish();
    assert.equal(s.view().frozen, true);
    cleared(s);
    assert.ok(s.pendingRatings.load(s.accountId));
    assert.doesNotMatch(JSON.stringify(s.view()), new RegExp(replyBody));
  });
test('delete confirms exact own row and preserves subsequent replies with unavailable quote after current refresh', async () => {
  const s = r2aHarness();
  let deleted = false;
  s.ratingDiscussion.repliesImpl = async () =>
    replyPage({
      items: deleted
        ? [
            reply({
              id: secondReplyId,
              replyTo: { kind: 'reply', status: 'unavailable' },
            }),
          ]
        : [
            reply(),
            reply({
              id: secondReplyId,
              replyTo: {
                kind: 'reply',
                status: 'available',
                replyId,
                revision,
                author: reply().author,
              },
            }),
          ],
    });
  s.ratingDiscussion.commandImpl = async (command) => {
    deleted = true;
    return replyReceipt(command);
  };
  await s.controller.load(route);
  s.controller.confirmDelete(replyId);
  assert.equal(s.view().deleteId, replyId);
  await s.controller.deleteReply();
  assert.equal(s.ratingDiscussion.commands[0]!.operation, 'delete_reply');
  assert.deepEqual(
    s.view().replies.map((item) => item.id),
    [secondReplyId],
  );
  assert.deepEqual(s.view().replies[0]?.replyTo, {
    kind: 'reply',
    status: 'unavailable',
  });
  s.controller.compose(secondReplyId);
  assert.equal(s.view().replyToId, secondReplyId);
});
test('historical applied recovery after root deletion clears journal but never rebuilds content from pending body', async () => {
  const s = r2aHarness();
  const pending = s.pendingRatings.freeze({
    version: 2,
    accountId: s.accountId,
    intent: replyIntent(),
  });
  s.ratingDiscussion.receiptImpl = async () => replyReceipt();
  s.ratingDiscussion.discussionImpl = async () => {
    throw missing();
  };
  await s.controller.load(route);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  cleared(s);
  assert.match(s.view().receiptStatus, /已提交/);
  assert.match(s.view().error, /不可查看/);
  assert.doesNotMatch(
    JSON.stringify(s.view()),
    new RegExp((pending.intent.payload as { body: string }).body),
  );
});
for (const fail of ['read', 'write', 'readback'] as const)
  test(`native reply storage ${fail} failure blocks network mutation`, async () => {
    const s = r2aHarness();
    await s.controller.load(route);
    prepare(s);
    if (fail === 'read')
      s.storage.get = () => {
        throw new Error('Synthetic storage read');
      };
    if (fail === 'write') s.storage.failWrite = true;
    if (fail === 'readback') s.storage.set = () => undefined;
    await s.controller.publish();
    assert.equal(s.ratingDiscussion.commands.length, 0);
    assert.equal(s.view().frozen, true);
    cleared(s);
  });
test('remove failure retains matching reply receipt recovery; another account and origin journal survive', async () => {
  const s = r2aHarness();
  s.pendingRatings.freeze({
    version: 2,
    accountId: otherId,
    intent: replyIntent(),
  });
  await s.controller.load(route);
  prepare(s);
  s.storage.failRemove = true;
  await s.controller.publish();
  assert.equal(s.view().frozen, true);
  assert.ok(s.pendingRatings.load(s.accountId));
  assert.ok(s.pendingRatings.load(otherId));
  s.storage.failRemove = false;
  s.ratingDiscussion.receiptImpl = async () => replyReceipt();
  await s.controller.recover();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.ok(s.pendingRatings.load(otherId));
});
test('v1 actual stored root command restores original R1 receipt route before independent v2; no third command', async () => {
  const s = r2aHarness();
  const legacy = {
      version: 1,
      accountId: s.accountId,
      intent: intent('create_comment'),
    },
    fresh = { version: 2, accountId: s.accountId, intent: replyIntent() };
  const key1 = `whaleu.ratings.pending.v1:synthetic-ratings:${s.accountId}`,
    key2 = `whaleu.ratings.pending.v2:synthetic-ratings:${s.accountId}`;
  s.storage.set(key1, legacy);
  s.storage.set(key2, fresh);
  const bytes = JSON.stringify(legacy);
  s.ratings.receiptImpl = async () => receipt(legacy.intent);
  await s.controller.load(route);
  assert.equal(s.ratings.calls.filter((c) => c.method === 'receipt').length, 1);
  assert.equal(
    s.ratingDiscussion.calls.filter((c) => c.method === 'receipt').length,
    0,
  );
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.storage.get(key2), fresh);
  assert.equal(JSON.stringify(legacy), bytes);
  prepare(s);
  await s.controller.publish();
  assert.equal(s.ratingDiscussion.commands.length, 0);
  assert.equal(s.ratings.commands.length, 0);
  s.ratingDiscussion.receiptImpl = async () => replyReceipt();
  await s.controller.recover();
  assert.equal(s.view().frozen, false);
  assert.equal(s.storage.get(key2), undefined);
  assert.equal(s.view().loaded, true);
});
test('v1 retry retains exact immutable canonical old request body/key and sends old operation, never v2 conversion', async () => {
  const s = r2aHarness(),
    legacy = {
      version: 1 as const,
      accountId: s.accountId,
      intent: intent('create_comment'),
    };
  s.storage.set(
    `whaleu.ratings.pending.v1:synthetic-ratings:${s.accountId}`,
    legacy,
  );
  await s.controller.load(route);
  assert.equal(s.view().frozen, true);
  s.ratingDiscussion.discussionImpl = async () =>
    discussion({
      root: {
        ...discussion().root,
        body: 'Current separately authorized root',
      },
    });
  await s.controller.recover(true);
  assert.deepEqual(s.ratings.commands, [legacy.intent]);
  assert.equal(s.ratingDiscussion.commands.length, 0);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.doesNotMatch(JSON.stringify(s.view()), new RegExp(body));
});
test('existing R1 detail and recovery see R2A pending and cannot dispatch a replacement score/root', async () => {
  const s = r2aHarness();
  s.pendingRatings.freeze({
    version: 2,
    accountId: s.accountId,
    intent: replyIntent(),
  });
  const views: RatingView[] = [];
  const controller = new RatingController(s.runtime, 'detail', (view) =>
    views.push(view),
  );
  await controller.load({ targetId });
  assert.equal(views[views.length - 1]?.frozen, true);
  controller.chooseScore(5);
  await controller.confirmScore();
  assert.equal(s.ratings.commands.length, 0);
  s.ratingDiscussion.receiptImpl = async () => replyReceipt();
  await controller.recover();
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(views[views.length - 1]?.loaded, true);
  controller.dispose();
});
test('hidden-only scan continues, cursor loops/foreign authority clear all content, anchor first resets independent paging', async () => {
  const s = r2aHarness();
  let phase = 0;
  s.ratingDiscussion.repliesImpl = async (_region, _root, next) => {
    if (phase === 0)
      return replyPage({ items: [], nextCursor: cursor, continuation: 'scan' });
    assert.equal(next, cursor);
    return replyPage();
  };
  await s.controller.load(route);
  assert.equal(s.view().replies.length, 0);
  assert.equal(s.view().canMore, true);
  phase = 1;
  await s.controller.more();
  assert.equal(s.view().replies[0]?.id, replyId);
  assert.equal(s.view().canMore, false);
  phase = 0;
  await s.controller.reload();
  await s.controller.more();
  cleared(s);
  assert.match(s.view().error, /格式异常/);
  phase = 1;
  s.ratingDiscussion.repliesImpl = async () => replyPage();
  await s.controller.load({ ...route, replyId });
  assert.equal(s.view().anchorReplyId, replyId);
  await s.controller.first();
  assert.equal(s.view().anchorReplyId, '');
  assert.equal(s.view().loaded, true);
});
test('collapse purges authority and quote identity; expand rereads fresh unavailable quote without cached body resurrection', async () => {
  const s = r2aHarness();
  let hidden = false;
  s.ratingDiscussion.repliesImpl = async () =>
    replyPage({
      items: [
        reply({
          replyTo: hidden
            ? { kind: 'reply', status: 'unavailable' }
            : {
                kind: 'reply',
                status: 'available',
                replyId: secondReplyId,
                revision,
                author: {
                  mode: 'named',
                  profileId: otherId,
                  displayName: 'old quote identity',
                },
              },
        }),
      ],
    });
  await s.controller.load(route);
  prepare(s, replyId);
  s.controller.collapse();
  cleared(s);
  assert.equal(s.view().collapsed, true);
  hidden = true;
  await s.controller.expand();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().collapsed, false);
  assert.doesNotMatch(JSON.stringify(s.view()), /old quote identity/);
  s.controller.compose(replyId);
  assert.equal(s.view().replyToId, replyId);
});
const boundaries = {
  hide: (s: Harness) => s.controller.dispose(),
  cancel: (s: Harness) => s.controller.cancel(),
  collapse: (s: Harness) => s.controller.collapse(),
  safety: (s: Harness) => s.safetyChanges.invalidate(s.accountId),
  scope: (s: Harness) => s.directoryScopeChanges.clear(s.accountId),
  browse: (s: Harness) => s.browsingScopeChanges.clear(s.accountId),
  rootHide: (s: Harness) => s.runtime.privateViews?.clear(),
  sameAccountLogin: (s: Harness) =>
    s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials()),
  accountSwitch: (s: Harness) =>
    s.sessions.completeLogin(s.sessions.beginLogin(), {
      ...wireCredentials(),
      accountId: otherId,
    }),
  logout: (s: Harness) => s.sessions.logout(),
};
for (const [label, boundary] of Object.entries(boundaries))
  test(`${label} clears bodies/drafts and fences late reply reads, including notice read`, async () => {
    const s = r2aHarness(),
      held = deferred<ReturnType<typeof replyPage>>();
    s.ratingDiscussion.positionImpl = async () => ({
      context: replyPage().context,
      anchorReplyId: replyId,
      page: await held.promise,
    });
    const work = s.controller.load({ ...route, replyId, noticeId });
    await flush();
    boundary(s);
    held.resolve(replyPage());
    await work;
    cleared(s);
    assert.equal(
      s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
      0,
    );
  });
for (const [label, boundary] of Object.entries(boundaries))
  test(`${label} during UUID wait cannot persist or dispatch a new reply`, async () => {
    const s = r2aHarness(),
      held = deferred<string>();
    await s.controller.load(route);
    prepare(s);
    s.ids.next = () => held.promise;
    const work = s.controller.publish();
    await flush();
    boundary(s);
    held.resolve(otherId);
    await work;
    cleared(s);
    assert.equal(s.ratingDiscussion.commands.length, 0);
    assert.equal(s.storage.data.size, 0);
  });
for (const [label, boundary] of Object.entries(boundaries))
  test(`${label} after dispatch keeps uncertain original journal and ignores late applied receipt`, async () => {
    const s = r2aHarness(),
      held = deferred<RatingReplyReceipt>();
    await s.controller.load(route);
    prepare(s);
    s.ratingDiscussion.commandImpl = () => held.promise;
    const work = s.controller.publish();
    await flush();
    assert.equal(s.ratingDiscussion.commands.length, 1);
    const original = s.pendingRatings.load(s.accountId);
    boundary(s);
    held.resolve(replyReceipt());
    await work;
    cleared(s);
    assert.deepEqual(s.pendingRatings.load(s.accountId), original);
  });
for (const [label, boundary] of Object.entries(boundaries))
  test(`${label} synchronously after position apply prevents subsequent automatic markRead`, async () => {
    let done = false;
    const s: Harness = r2aHarness((view) => {
      if (view.loaded && !done && s) {
        done = true;
        boundary(s);
      }
    });
    await s.controller.load({ ...route, replyId, noticeId });
    cleared(s);
    assert.equal(
      s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
      0,
    );
  });
test('newer route owns the page while a previous position is late', async () => {
  const s = r2aHarness(),
    held = deferred<RatingReplyPage>();
  s.ratingDiscussion.positionImpl = async () => ({
    context: replyPage().context,
    anchorReplyId: replyId,
    page: await held.promise,
  });
  const prior = s.controller.load({ ...route, replyId, noticeId });
  await flush();
  s.ratingDiscussion.repliesImpl = async () =>
    replyPage({ items: [reply({ body: 'new route fresh body' })] });
  await s.controller.load(route);
  held.resolve(replyPage());
  await prior;
  assert.equal(s.view().replies[0]?.body, 'new route fresh body');
  assert.equal(s.view().anchorReplyId, '');
  assert.equal(
    s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
    0,
  );
});
test('current thread locates and applies position before exact current notice markRead; failures never claim empty', async () => {
  const s = r2aHarness();
  let loadedAtRead = false;
  s.ratingUpdates.markReadImpl = async () => {
    loadedAtRead = s.view().loaded && s.view().replies[0]?.id === replyId;
    return readReceipt();
  };
  await s.controller.load({ ...route, replyId, noticeId });
  assert.equal(loadedAtRead, true);
  assert.deepEqual(
    s.ratingUpdates.calls.map((call) => call.method),
    ['target', 'markRead'],
  );
  assert.match(s.view().status, /已读/);
  for (const failure of [missing(), unknown()]) {
    s.ratingDiscussion.positionImpl = async () => {
      throw failure;
    };
    const previous = s.ratingUpdates.calls.filter(
      (call) => call.method === 'markRead',
    ).length;
    await s.controller.reload();
    cleared(s);
    assert.equal(
      s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
      previous,
    );
    assert.notEqual(s.view().error, '');
  }
});
test('notice locator mismatch/unavailable cannot load reply, leak old preview or acknowledge notice', async () => {
  for (const result of [
    noticeTarget({ target: locator({ targetId: otherId }) }),
    { noticeId, status: 'unavailable' } as const,
    noticeTarget({ noticeId: otherId }),
  ]) {
    const s = r2aHarness();
    s.ratingUpdates.targetImpl = async () => result;
    await s.controller.load({ ...route, replyId, noticeId });
    cleared(s);
    assert.equal(s.ratingDiscussion.calls.length, 0);
    assert.equal(
      s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
      0,
    );
  }
});
test('rating updates resolve new locator but list navigation itself never marks read', async () => {
  const s = r2aHarness();
  await s.updatesController.load();
  assert.equal(s.updateView().unreadCount, 1);
  await s.updatesController.open(noticeId);
  assert.equal(
    s.navigation[0],
    `/pages/rating-thread/rating-thread?targetId=${targetId}&rootId=${commentId}&replyId=${replyId}&noticeId=${noticeId}`,
  );
  assert.equal(
    s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
    0,
  );
  assert.equal(s.updateView().items[0]?.readAt, null);
});
test('rating updates unknown list errors retain unknown count, unavailable target is generic and explicit read remains owner-only', async () => {
  const s = r2aHarness();
  s.ratingUpdates.listImpl = async () => {
    throw unknown();
  };
  await s.updatesController.load();
  assert.equal(s.updateView().loaded, false);
  assert.equal(s.updateView().unreadCount, null);
  assert.deepEqual(s.updateView().items, []);
  s.ratingUpdates.listImpl = async () => updates();
  await s.updatesController.load();
  s.ratingUpdates.targetImpl = async () => ({
    noticeId,
    status: 'unavailable',
  });
  await s.updatesController.open(noticeId);
  assert.equal(s.navigation.length, 0);
  assert.deepEqual(s.updateView().items[0], {
    noticeId,
    createdAt: notice().createdAt,
    readAt: null,
    status: 'unavailable',
  });
  await s.updatesController.acknowledge(otherId);
  assert.equal(
    s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
    0,
  );
  await s.updatesController.acknowledge(noticeId);
  assert.equal(s.updateView().unreadCount, 0);
  assert.equal(s.updateView().items[0]?.readAt, readReceipt().readAt);
});
test('updates paging carries forward cursor and unread source, clears repeated or malformed page instead of zero', async () => {
  const s = r2aHarness();
  s.ratingUpdates.listImpl = async () => updates({ nextCursor: cursor });
  await s.updatesController.load();
  await s.updatesController.more();
  assert.equal(s.updateView().loaded, false);
  assert.equal(s.updateView().unreadCount, null);
  assert.deepEqual(s.updateView().items, []);
  s.ratingUpdates.listImpl = async (next) =>
    next
      ? updates({ items: [notice({ noticeId: otherId })], unreadCount: 2 })
      : updates({ nextCursor: cursor });
  await s.updatesController.load();
  await s.updatesController.more();
  assert.deepEqual(
    s.updateView().items.map((item) => item.noticeId),
    [noticeId, otherId],
  );
  assert.equal(s.updateView().unreadCount, 2);
});
for (const kind of ['target', 'list', 'markRead'] as const)
  for (const boundary of [
    'hide',
    'cancel',
    'scope',
    'safety',
    'account',
    'epoch',
  ] as const)
    test(`updates ${boundary} fences late ${kind} callback and keeps private previews cleared`, async () => {
      const s = r2aHarness();
      await s.updatesController.load();
      const target = deferred<RatingNoticeTarget>(),
        list = deferred<RatingUpdatesPage>(),
        read = deferred<ReturnType<typeof readReceipt>>();
      s.ratingUpdates.targetImpl = () => target.promise;
      s.ratingUpdates.listImpl = () => list.promise;
      s.ratingUpdates.markReadImpl = () => read.promise;
      const work =
        kind === 'target'
          ? s.updatesController.open(noticeId)
          : kind === 'list'
            ? s.updatesController.load()
            : s.updatesController.acknowledge(noticeId);
      await flush();
      if (boundary === 'hide') s.updatesController.dispose();
      if (boundary === 'cancel') s.updatesController.cancel();
      if (boundary === 'scope') s.directoryScopeChanges.clear(s.accountId);
      if (boundary === 'safety') s.safetyChanges.invalidate(s.accountId);
      if (boundary === 'account' || boundary === 'epoch')
        s.sessions.completeLogin(s.sessions.beginLogin(), {
          ...wireCredentials(),
          accountId: boundary === 'account' ? otherId : s.accountId,
        });
      target.resolve(noticeTarget());
      list.resolve(updates());
      read.resolve(readReceipt());
      await work;
      assert.deepEqual(s.updateView().items, []);
      assert.equal(s.updateView().unreadCount, null);
      if (kind === 'target') assert.equal(s.navigation.length, 0);
    });
test('navigation failure does not mark read and clears sensitive notice preview', async () => {
  const s = r2aHarness(),
    views: RatingUpdatesView[] = [];
  const controller = new RatingUpdatesController(
    s.runtime,
    (view) => views.push(view),
    async () => {
      throw new ClientError('network', 'Synthetic navigation failure');
    },
  );
  await controller.load();
  await controller.open(noticeId);
  assert.equal(
    s.ratingUpdates.calls.filter((call) => call.method === 'markRead').length,
    0,
  );
  assert.deepEqual(views[views.length - 1]?.items, []);
  controller.dispose();
});
test('thread rejects wrong scope/root/target page context and keeps no partially loaded author', async () => {
  for (const context of [
    { ...replyPage().context, rootId: otherId },
    { ...replyPage().context, regionId },
    { ...replyPage().context, catalogRevision: otherId },
  ]) {
    const s = r2aHarness();
    s.ratingDiscussion.repliesImpl = async () =>
      replyPage({ context, items: [] });
    await s.controller.load(route);
    cleared(s);
    assert.match(s.view().error, /格式异常/);
  }
});
