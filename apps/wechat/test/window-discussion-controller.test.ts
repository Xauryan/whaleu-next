import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  WindowDiscussionController,
  windowDiscussionError,
  type WindowDiscussionView,
} from '../src/window-discussion/controller';
import {
  WindowDiscussionNoticesController,
  type WindowDiscussionNoticesView,
} from '../src/window-discussion/notices-controller';
import type {
  DiscussionPage,
  DiscussionReceipt,
  DiscussionTarget,
} from '../src/window-discussion/contract';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  discussionHarness,
  item,
  page,
  intent,
  like,
  own,
  receipt,
  cancelled,
  id,
  rootId,
  replyId,
  scoreRevision,
  requestId,
  notice,
  recordedAt,
} from './window-discussion-helpers';
test('explicit named publication requires two taps, preserves Unicode original and serializes repeat submit', async () => {
  const s = discussionHarness();
  await s.controller.load(id);
  s.controller.setBody(' A\n😀 ');
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  s.controller.confirmPublish();
  s.controller.setBody('replacement');
  await Promise.all([s.controller.submit(), s.controller.submit()]);
  assert.equal(s.commands.length, 1);
  assert.deepEqual(s.commands[0], intent(' A\n😀 '));
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().body, '');
  assert.equal(s.calls.filter((c) => c === 'list').length, 2);
});
test('flat replies select only same current root and publish explicit nullable target', async () => {
  const s = discussionHarness('thread'),
    root = item(),
    reply = item({
      id: replyId,
      rootId,
      body: 'reply',
      addressedAuthor: root.author,
    });
  s.impl.list = async () => page({ root, items: [reply] });
  await s.controller.load(id, rootId);
  s.controller.chooseReply(replyId);
  s.controller.setBody('reply to reply');
  s.controller.confirmPublish();
  await s.controller.submit();
  const i = s.commands[0]!;
  assert.equal(i.operation, 'window.discussion.reply.v1');
  if (i.operation === 'window.discussion.reply.v1')
    assert.equal(i.command.replyToReplyId, replyId);
});
test('desired-state likes preserve exact membership CAS and historical receipt never installs current heart', async () => {
  const s = discussionHarness();
  await s.controller.load(id);
  s.controller.confirmLike(rootId);
  await s.controller.submit();
  assert.deepEqual(s.commands[0], like());
  assert.equal(s.view().items[0]!.isLiked, false);
  assert.match(s.view().receiptStatus, /历史回执/);
  assert.deepEqual(s.store.references(s.accountId), [
    { windowId: id, commentId: rootId },
  ]);
});
test('source-free cold recovery reads current own membership and retracts after every public eligibility loss', async () => {
  for (const serverCode of [
    'WINDOW_CATALOG_UNAVAILABLE',
    'WINDOW_NOT_FOUND',
    'PHONE_VERIFICATION_REQUIRED',
    'SAFETY_ACTION_RESTRICTED',
  ]) {
    const s = discussionHarness('recovery');
    s.impl.list = async () => {
      throw new ClientError('http', 'Unavailable', {
        httpStatus: 503,
        serverCode,
      });
    };
    await s.controller.load();
    s.controller.setOwnLocator('window', id);
    s.controller.setOwnLocator('comment', rootId);
    await s.controller.lookupOwn();
    s.controller.confirmUnlike();
    s.impl.own = async () => own(false);
    await s.controller.submit();
    assert.equal(s.calls.includes('list'), false);
    assert.deepEqual(s.commands[0], like(false, scoreRevision));
    assert.equal(s.view().own?.kind, 'recorded');
    assert.equal(s.view().canUnlike, false);
  }
});
test('unknown own state cannot become absent or enable unlike, and edited locator invalidates current proof', async () => {
  const s = discussionHarness('recovery');
  await s.controller.load();
  s.controller.setOwnLocator('window', id);
  s.controller.setOwnLocator('comment', rootId);
  s.impl.own = async () => ({ kind: 'unavailable' });
  await s.controller.lookupOwn();
  s.controller.confirmUnlike();
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  assert.equal(s.view().own?.kind, 'unavailable');
  s.impl.own = async () => own();
  await s.controller.lookupOwn();
  s.controller.setOwnLocator('comment', replyId);
  assert.equal(s.view().own, null);
  assert.equal(s.view().canUnlike, false);
});
test('missing receipt is not terminal; retry queries receipt before resending exact intent; 503 never resends', async () => {
  const s = discussionHarness('recovery'),
    p = s.store.freeze(s.pending());
  await s.controller.load();
  s.impl.receipt = async () => {
    throw new ClientError('http', 'Unavailable', {
      httpStatus: 503,
      serverCode: 'WINDOW_DISCUSSION_HISTORY_UNAVAILABLE',
    });
  };
  await s.controller.recover(true);
  assert.equal(s.commands.length, 0);
  assert.deepEqual(s.store.load(s.accountId), p);
  s.impl.receipt = async () => {
    throw new ClientError('http', 'Missing', {
      httpStatus: 404,
      serverCode: 'REQUEST_NOT_FOUND',
    });
  };
  await s.controller.recover(true);
  assert.deepEqual(s.calls.slice(-2), ['receipt', 'submit']);
  assert.deepEqual(s.commands[0], p.intent);
});
test('cancel phase is durable before dispatch and survives restart, with no accidental publish retry', async () => {
  const s = discussionHarness('recovery');
  s.store.freeze(s.pending());
  await s.controller.load();
  await s.controller.recover(false, true);
  s.impl.cancel = async () => {
    assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
    throw new ClientError('network', 'lost');
  };
  await s.controller.confirmCancellation();
  assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
  s.controller.dispose();
  const views: WindowDiscussionView[] = [];
  const cold = new WindowDiscussionController(s.runtime, 'recovery', (v) =>
    views.push(v),
  );
  await cold.load();
  s.impl.cancel = async (i) => cancelled(i);
  await cold.recover(true);
  assert.equal(s.calls.includes('submit'), false);
  assert.equal(s.calls.filter((c) => c === 'cancel').length, 2);
  assert.equal(views[views.length - 1]!.frozen, false);
});
test('journal write/readback and corruption block outbound writes without replacing original', async () => {
  const s = discussionHarness();
  await s.controller.load(id);
  s.controller.setBody('x');
  s.controller.confirmPublish();
  s.storage.failWrite = true;
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  const t = discussionHarness();
  t.storage.set(
    `whaleu.window-discussion.pending.v1:${t.store.origin}:${t.accountId}`,
    { bad: true },
  );
  await t.controller.load(id);
  t.controller.setBody('x');
  t.controller.confirmPublish();
  await t.controller.submit();
  assert.equal(t.commands.length, 0);
  assert.equal(t.view().frozen, true);
});
test('stop/hide/session switch discard late publication, reads and post-settlement reload continuations', async () => {
  for (const action of ['cancel', 'dispose', 'account'] as const) {
    const s = discussionHarness(),
      wait = deferred<DiscussionReceipt>();
    await s.controller.load(id);
    s.controller.setBody('x');
    s.controller.confirmPublish();
    s.impl.submit = async () => wait.promise;
    const job = s.controller.submit();
    await flush();
    assert.ok(s.store.load(s.accountId));
    if (action === 'account')
      s.runtime.sessions.completeLogin(s.runtime.sessions.beginLogin(), {
        ...wireCredentials('b'),
        accountId: replyId,
      });
    else s.controller[action]();
    wait.resolve(receipt(intent('x')));
    await job;
    assert.ok(s.store.load(s.accountId));
    assert.equal(s.calls.filter((c) => c === 'list').length, 1);
    assert.equal(s.view().items.length, 0);
  }
});
test('same-account login epoch and App hide fence late list callbacks', async () => {
  for (const action of ['epoch', 'hide']) {
    const s = discussionHarness(),
      wait = deferred<DiscussionPage>();
    s.impl.list = async () => wait.promise;
    const job = s.controller.load(id);
    await flush();
    if (action === 'epoch')
      s.runtime.sessions.completeLogin(
        s.runtime.sessions.beginLogin(),
        wireCredentials(),
      );
    else s.runtime.privateViews!.clear();
    wait.resolve(page());
    await job;
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().items.length, 0);
  }
});
test('changed page snapshot clears rows and forces restart instead of appending stale order', async () => {
  const s = discussionHarness();
  s.impl.list = async () =>
    page({ nextCursor: 'cursor', continuation: 'more' });
  await s.controller.load(id);
  s.impl.list = async () => page({ discussionRevision: '2' });
  await s.controller.next();
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().restartRequired, true);
  assert.equal(s.view().items.length, 0);
});
test('notice target is fetched fresh and unread status changes only on explicit exact read', async () => {
  const s = discussionHarness(),
    views: WindowDiscussionNoticesView[] = [],
    c = new WindowDiscussionNoticesController(s.runtime, (v) => views.push(v)),
    paths: string[] = [];
  await c.reload();
  await c.open(requestId, (p) => paths.push(p));
  assert.equal(paths.length, 1);
  assert.match(paths[0]!, new RegExp(`commentId=${replyId}`));
  assert.equal(s.calls.includes('read'), false);
  await c.read(requestId);
  assert.equal(views[views.length - 1]!.unreadCount, 0);
  await c.read(requestId);
  assert.equal(s.calls.filter((v) => v === 'read').length, 1);
});
test('unavailable or stale targets and late callbacks never navigate or mark notice read', async () => {
  const s = discussionHarness(),
    views: WindowDiscussionNoticesView[] = [],
    c = new WindowDiscussionNoticesController(s.runtime, (v) => views.push(v)),
    paths: string[] = [];
  await c.reload();
  const wait = deferred<DiscussionTarget>();
  s.impl.target = async () => wait.promise;
  const job = c.open(requestId, (p) => paths.push(p));
  await flush();
  c.dispose();
  wait.resolve({ windowId: id, rootId, commentId: replyId });
  await job;
  assert.deepEqual(paths, []);
  assert.equal(s.calls.includes('read'), false);
  assert.equal(views[views.length - 1]!.items.length, 0);
});

test('complete-discussion budget failure stays unavailable and distinct from empty history', async () => {
  const s = discussionHarness();
  s.impl.list = async () => {
    throw new ClientError('http', 'Budget', {
      httpStatus: 503,
      serverCode: 'WINDOW_DISCUSSION_BUDGET_UNAVAILABLE',
    });
  };
  await s.controller.load(id);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().totalCount, null);
  assert.match(s.view().error, /完整讨论当前无法核验/);
  assert.match(s.view().error, /不代表没有评论/);
  assert.match(
    windowDiscussionError(
      new ClientError('http', 'Cursor', {
        serverCode: 'DISCOVERY_RESTART_REQUIRED',
      }),
    ),
    /旧分页已清除/,
  );
  assert.match(
    windowDiscussionError(
      new ClientError('http', 'Notice', {
        serverCode: 'WINDOW_DISCUSSION_NOTICE_NOT_FOUND',
      }),
    ),
    /不属于当前账号/,
  );
});
test('explicit route replacement clears unsent draft and preserves only the immutable original uncertain intent', async () => {
  const s = discussionHarness();
  await s.controller.load(id);
  s.controller.setBody('private old draft');
  s.controller.confirmPublish();
  s.impl.list = async () =>
    page({ windowId: replyId, items: [item({ windowId: replyId })] });
  await s.controller.load(replyId);
  assert.equal(s.view().body, '');
  assert.equal(s.view().bodyBytes, 0);
  assert.equal(s.view().confirming, null);
  assert.equal(s.view().canPublish, false);
  const original = s.store.freeze(s.pending(intent('durable original')));
  s.impl.list = async () => page();
  await s.controller.load(id);
  assert.equal(s.view().body, '');
  assert.equal(s.view().frozen, true);
  assert.deepEqual(s.store.load(s.accountId), original);
});
test('notice read invalidates old cursor and obtains authoritative unread count from a fresh page', async () => {
  const s = discussionHarness(),
    views: WindowDiscussionNoticesView[] = [],
    c = new WindowDiscussionNoticesController(s.runtime, (v) => views.push(v));
  s.impl.notices = async () => ({
    items: [notice()],
    nextCursor: 'old-cursor',
    unreadCount: 9,
  });
  await c.reload();
  s.impl.read = async (noticeId) => {
    s.impl.notices = async () => ({
      items: [{ ...notice(), readAt: recordedAt }],
      nextCursor: null,
      unreadCount: 3,
    });
    return { noticeId, readAt: recordedAt };
  };
  await c.read(requestId);
  assert.deepEqual(s.calls.slice(-2), ['read', 'notices']);
  assert.equal(views[views.length - 1]!.unreadCount, 3);
  assert.equal(views[views.length - 1]!.canNext, false);
  assert.ok(
    views.some((v) => v.readStatus && v.unreadCount === null && !v.canNext),
  );
});
test('late notice read acknowledgment cannot reload or restore data after hide or new login epoch', async () => {
  for (const stop of ['hide', 'epoch']) {
    const s = discussionHarness(),
      views: WindowDiscussionNoticesView[] = [],
      c = new WindowDiscussionNoticesController(s.runtime, (v) =>
        views.push(v),
      ),
      wait = deferred<{ noticeId: string; readAt: string }>();
    await c.reload();
    s.impl.read = async () => wait.promise;
    const job = c.read(requestId);
    await flush();
    if (stop === 'hide') c.dispose();
    else
      s.runtime.sessions.completeLogin(
        s.runtime.sessions.beginLogin(),
        wireCredentials(),
      );
    wait.resolve({ noticeId: requestId, readAt: recordedAt });
    await job;
    assert.equal(s.calls.filter((v) => v === 'notices').length, 1);
    assert.equal(views[views.length - 1]!.items.length, 0);
    assert.equal(views[views.length - 1]!.readStatus, '');
  }
});
