import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  MessagingDetailController,
  type DetailView,
} from '../src/messaging/detail-controller';
import {
  MessagingListController,
  type ListView,
} from '../src/messaging/list-controller';
import {
  MessagingRecoveryController,
  type RecoveryView,
} from '../src/messaging/recovery-controller';
import { deferred, flush } from './helpers';
import {
  accountId,
  conversation,
  conversationId,
  harness,
  history,
  message,
  messageId,
  observationId,
  otherId,
  receipt,
  sendIntent,
} from './messaging-helpers';
function detail() {
  const h = harness(),
    views: DetailView[] = [];
  const controller = new MessagingDetailController(
    h.runtime,
    { conversationId },
    (view, done) => {
      views.push(view);
      done?.();
    },
  );
  return { ...h, controller, views, view: () => views[views.length - 1]! };
}
test('foreground rendered history alone does not mark read; current visible message permits bounded observation ack', async () => {
  const h = detail();
  await h.controller.load();
  assert.equal(h.applied.length, 0);
  h.controller.observeMessage(messageId);
  await h.controller.load();
  assert.equal(h.applied.filter((i) => i.operation === 'read').length, 1);
  await h.controller.load();
  assert.equal(h.applied.filter((i) => i.operation === 'read').length, 1);
  h.controller.dispose();
  assert.equal(h.clock.timers, 0);
});
test('detail polls 3s only foreground, has one chain, and drops results after logout', async () => {
  const h = detail(),
    gate = deferred<ReturnType<typeof conversation>>();
  h.gateway.conversation = async () => gate.promise;
  const loading = h.controller.load();
  await flush();
  await h.controller.load();
  assert.equal(h.events.length, 0);
  h.sessions.logout();
  gate.resolve(conversation());
  await loading;
  assert.equal(h.view().messages.length, 0);
  assert.equal(h.clock.timers, 0);
  h.controller.dispose();
});
test('event drain advances oldest-first at most three batches per turn and applies old recall', async () => {
  const h = detail();
  let n = 0;
  h.gateway.events = async (_id, cursor) => {
    h.events.push(cursor);
    n++;
    return {
      items: [
        {
          sequence: String(n),
          kind: 'recalled',
          message: message({ state: 'recalled', text: null }),
        },
      ],
      nextCursor: `event_${n}`,
      hasMore: n < 4,
      observationId,
      throughSequence: '0',
    };
  };
  await h.controller.load();
  assert.deepEqual(h.events, ['initial_cursor', 'event_1', 'event_2']);
  assert.equal(h.view().messages[0]?.state, 'recalled');
  assert.equal(h.applied.length, 0);
  await h.controller.load();
  assert.equal(h.events[3], 'event_3');
  h.controller.dispose();
});
test('loaded history is revalidated and newly unavailable body is removed', async () => {
  const h = detail();
  await h.controller.load();
  assert.equal(h.view().messages[0]?.text, '本地合成私信');
  h.gateway.history = async () =>
    history({ items: [message({ state: 'unavailable', text: null })] });
  await h.controller.load();
  assert.equal(h.view().messages[0]?.text, null);
  h.controller.dispose();
});
test('lost send freezes exact text, changed draft cannot overwrite original, recovery only refetches history after receipt', async () => {
  const h = detail();
  await h.controller.load();
  h.controller.setText('原文');
  h.gateway.apply = async (intent) => {
    h.applied.push(intent);
    throw new ClientError('timeout', 'lost');
  };
  await h.controller.send();
  assert.equal(h.view().pending, true);
  h.controller.setText('不同文字');
  assert.equal(h.view().text, '原文');
  assert.equal(h.runtime.pending.load(accountId)?.intent?.operation, 'send');
  assert.equal(h.applied.length, 1);
  h.controller.dispose();
});
test('cancel during secure key creation does not dispatch or leave a queued mutation', async () => {
  const h = detail(),
    key = deferred<string>();
  await h.controller.load();
  h.controller.request('block');
  const runtime = { ...h.runtime, newRequestId: () => key.promise };
  const views: DetailView[] = [];
  const controller = new MessagingDetailController(
    runtime,
    { conversationId },
    (v, done) => {
      views.push(v);
      done?.();
    },
  );
  await controller.load();
  controller.request('block');
  const action = controller.confirm();
  await flush();
  controller.dismiss();
  key.resolve('77777777-7777-4777-8777-777777777777');
  await action;
  assert.equal(h.applied.length, 0);
  controller.dispose();
  h.controller.dispose();
});
test('earlier history preserves anchor and never replaces live event cursor', async () => {
  const h = detail();
  h.gateway.history = async (_id, cursor) =>
    cursor
      ? history({
          items: [message({ id: otherId, sequence: '0' })],
          eventCursor: 'old_snapshot',
          throughSequence: '0',
        })
      : history({ nextCursor: 'older' });
  await h.controller.load();
  await h.controller.more();
  assert.equal(h.view().anchor, `message-${otherId}`);
  assert.equal(h.view().messages[0]?.id, otherId);
  await h.controller.load();
  assert.ok(!h.events.includes('old_snapshot'));
  h.controller.dispose();
});
test('anonymous identity never exposes profile action; bilateral local block message explains permanence', async () => {
  const h = detail();
  h.gateway.conversation = async () =>
    conversation({
      self: { mode: 'anonymous', displayName: '分身一', profileId: null },
      peer: { mode: 'anonymous', displayName: '分身二', profileId: null },
      blockScope: 'conversation',
    });
  await h.controller.load();
  assert.equal(h.controller.profilePath(), null);
  h.controller.request('block');
  assert.match(h.view().confirm?.description ?? '', /双方都不能继续发送/);
  assert.match(h.view().confirm?.description ?? '', /暂不支持解除/);
  h.controller.dispose();
});
test('list uses separate count, clears stale paging, pauses 10s timer and handles hide cancel', async () => {
  const h = harness(),
    views: ListView[] = [];
  h.gateway.list = async () => ({
    items: [
      {
        conversation: conversation(),
        latest: message(),
        updatedAt: message().createdAt,
      },
    ],
    nextCursor: 'next',
    coverage: 'local',
  });
  const c = new MessagingListController(h.runtime, (v) => views.push(v));
  await c.load();
  assert.equal(views[views.length - 1]?.unread, 1);
  c.requestHide(conversationId);
  c.dismiss();
  await c.confirmHide();
  assert.equal(h.applied.length, 0);
  h.gateway.list = async () => {
    throw new ClientError('business', 'stale', {
      serverCode: 'DM_CURSOR_STALE',
    });
  };
  await c.more();
  assert.equal(views[views.length - 1]?.items.length, 0);
  c.dispose();
  assert.equal(h.clock.timers, 0);
});
test('minimal recovery shows own original pending text, successful receipt removes text and requires fresh conversation read', async () => {
  const h = harness(),
    views: RecoveryView[] = [];
  h.runtime.pending.freeze({
    version: 1,
    accountId,
    intent: sendIntent('秘密正文'),
  });
  h.gateway.receipt = async () => receipt(sendIntent('秘密正文'));
  const c = new MessagingRecoveryController(h.runtime, (v) => views.push(v));
  c.load();
  assert.equal(views[views.length - 1]?.pendingText, '秘密正文');
  await c.recover();
  assert.equal(views[views.length - 1]?.pendingText, '');
  assert.equal(views[views.length - 1]?.conversationId, conversationId);
  c.dispose();
});
test('cancel stops scheduled continuation until an explicit reload', async () => {
  const h = detail();
  await h.controller.load();
  assert.equal(h.clock.timers, 1);
  h.controller.cancel();
  assert.equal(h.clock.timers, 0);
  h.clock.advance(30000);
  await flush();
  assert.equal(h.events.length, 1);
  await h.controller.load();
  assert.equal(h.clock.timers, 1);
  h.controller.dispose();
});
test('history keeps a four-page window but continues beyond 200 older messages', async () => {
  const h = detail();
  let call = 0;
  h.gateway.history = async (_id, cursor) => {
    const page = cursor === null ? 0 : Number(cursor.slice(1));
    return history({
      items: [
        message({
          id: `${String(page + 1).padStart(8, '0')}-6666-4666-8666-666666666666`,
          sequence: String(1000 - page),
        }),
      ],
      throughSequence: String(1000 - page),
      eventCursor: `snap_${call++}`,
      nextCursor: `h${page + 1}`,
    });
  };
  await h.controller.load();
  for (let i = 0; i < 7; i++) await h.controller.more();
  assert.equal(h.view().canMore, true);
  assert.equal(h.view().browsingOlder, true);
  assert.ok(h.view().messages.some((m) => m.sequence === '993'));
  assert.ok(h.view().messages.length <= 4);
  await h.controller.latest();
  assert.equal(h.view().browsingOlder, false);
  assert.equal(h.view().messages[0]?.sequence, '1000');
  h.controller.dispose();
});
test('list polling preserves deep page and reports epoch restart rather than jumping top', async () => {
  const h = harness(),
    views: ListView[] = [],
    cursors: (string | null)[] = [];
  h.gateway.list = async (cursor) => {
    cursors.push(cursor);
    return {
      items: [
        {
          conversation: conversation(),
          latest: message(),
          updatedAt: message().createdAt,
        },
      ],
      nextCursor: cursor === null ? 'page2' : null,
      coverage: 'local',
    };
  };
  const controller = new MessagingListController(h.runtime, (v) =>
    views.push(v),
  );
  await controller.load();
  await controller.more();
  h.clock.advance(10000);
  await flush();
  assert.deepEqual(cursors, [null, 'page2', 'page2']);
  assert.equal(views[views.length - 1]?.browsingOlder, true);
  controller.dispose();
});
test('cancel before native render completion cannot emit a read acknowledgment', async () => {
  const h = harness();
  let rendered: (() => void) | undefined;
  const views: DetailView[] = [];
  const controller = new MessagingDetailController(
    h.runtime,
    { conversationId },
    (v, done) => {
      views.push(v);
      if (done) rendered = done;
    },
  );
  const loading = controller.load();
  await flush();
  controller.observeMessage(messageId);
  controller.cancel();
  rendered?.();
  await loading;
  assert.equal(h.applied.length, 0);
  assert.equal(h.clock.timers, 0);
  controller.dispose();
});
test('recall reedit remains only in account-local page memory and starts a new draft', async () => {
  const h = detail();
  h.gateway.history = async () =>
    history({
      items: [message({ sender: 'self', canRecall: true, text: '可重新编辑' })],
    });
  await h.controller.load();
  h.controller.request('recall', messageId);
  h.gateway.history = async () =>
    history({
      items: [message({ sender: 'self', state: 'recalled', text: null })],
    });
  await h.controller.confirm();
  assert.equal(h.view().canReedit, true);
  h.controller.reedit();
  assert.equal(h.view().text, '可重新编辑');
  assert.equal(h.runtime.pending.load(accountId), null);
  h.controller.dispose();
  assert.equal(h.view().text, '');
  assert.equal(h.view().canReedit, false);
});
test('recovery UI after body scrub disables retry, keeps request and permits explicit safe cancellation', async () => {
  const h = harness(),
    views: RecoveryView[] = [];
  h.runtime.pending.freeze({
    version: 1,
    accountId,
    intent: sendIntent('清除正文'),
  });
  h.runtime.pending.scrubBodies();
  const c = new MessagingRecoveryController(h.runtime, (v) => views.push(v));
  c.load();
  assert.equal(views[views.length - 1]?.pending, true);
  assert.equal(views[views.length - 1]?.pendingText, '');
  assert.equal(views[views.length - 1]?.canRetry, false);
  await c.recover(true);
  assert.equal(h.applied.length, 0);
  c.requestCancel();
  c.dismissCancel();
  await c.confirmCancel();
  assert.ok(h.runtime.pending.load(accountId));
  c.requestCancel();
  await c.confirmCancel();
  assert.equal(views[views.length - 1]?.status, '原请求已安全取消');
  assert.equal(h.runtime.pending.load(accountId), null);
  c.dispose();
});
test('cancel UI reports already committed send honestly instead of cancellation success', async () => {
  const h = harness(),
    views: RecoveryView[] = [];
  const original = sendIntent();
  h.runtime.pending.freeze({ version: 1, accountId, intent: original });
  h.runtime.pending.scrubBodies();
  h.gateway.cancel = async () => ({
    outcome: 'already_terminal',
    receipt: receipt(original),
  });
  const c = new MessagingRecoveryController(h.runtime, (v) => views.push(v));
  c.load();
  c.requestCancel();
  await c.confirmCancel();
  assert.match(
    views[views.length - 1]?.outcome ?? '',
    /原发送已完成，无法取消/,
  );
  assert.equal(views[views.length - 1]?.conversationId, conversationId);
  assert.equal(h.runtime.pending.load(accountId), null);
  c.dispose();
});

test('confirmed open route survives a current-view failure after its receipt settles', async () => {
  const h = harness(),
    views: DetailView[] = [];
  h.gateway.conversation = async () => {
    throw new ClientError('network', 'current view unavailable');
  };
  const c = new MessagingDetailController(
    h.runtime,
    { entry: { kind: 'post', postId: otherId }, initiationMode: 'named' },
    (view, done) => {
      views.push(view);
      done?.();
    },
  );
  await c.open();
  const view = views[views.length - 1]!;
  assert.equal(view.conversation, null);
  assert.equal(view.confirmedConversationId, conversationId);
  assert.equal(view.needsOpen, false);
  assert.equal(h.runtime.pending.load(accountId), null);
  assert.equal(h.applied.filter((i) => i.operation === 'open').length, 1);
  c.dispose();
});

test('cancel after send dispatch freezes pending UI and cannot change or redispatch its original', async () => {
  const h = detail(),
    waiting = deferred<ReturnType<typeof receipt>>();
  await h.controller.load();
  h.controller.setText('取消等待仍需保留的原文');
  h.gateway.apply = async (intent) => {
    h.applied.push(intent);
    return waiting.promise;
  };
  const sending = h.controller.send();
  await flush();
  assert.equal(h.applied.length, 1);
  h.controller.cancel();
  assert.equal(h.view().busy, false);
  assert.equal(h.view().pending, true);
  assert.equal(h.view().canSend, false);
  h.controller.setText('不能覆盖');
  await h.controller.send();
  assert.equal(h.view().text, '取消等待仍需保留的原文');
  assert.equal(h.applied.length, 1);
  waiting.resolve(receipt(h.applied[0]!));
  await sending;
  assert.ok(h.runtime.pending.load(accountId));
  assert.equal(h.clock.timers, 0);
  h.controller.dispose();
});

test('cancel with unreadable recovery storage stays frozen instead of enabling send', async () => {
  const h = detail();
  await h.controller.load();
  h.storage.set('whaleu.private-messages.pending.v2:synthetic', {
    invalid: true,
  });
  h.controller.cancel();
  assert.equal(h.view().pending, true);
  assert.equal(h.view().canSend, false);
  assert.match(h.view().error, /恢复记录不可读/);
  h.controller.dispose();
});

function rejectedRecovery() {
  const h = harness(),
    views: RecoveryView[] = [],
    original = sendIntent('被拒绝的原文');
  const runtime = { ...h.runtime, newRequestId: async () => otherId };
  runtime.pending.freeze({ version: 1, accountId, intent: original });
  h.gateway.receipt = async () => ({
    requestId: original.clientRequestId,
    operation: 'send',
    outcome: 'rejected',
    code: 'CONTENT_REJECTED',
  });
  const controller = new MessagingRecoveryController(runtime, (v) =>
    views.push(v),
  );
  controller.load();
  return {
    ...h,
    runtime,
    original,
    controller,
    view: () => views[views.length - 1]!,
  };
}

test('recovered rejected original can explicitly become a new reviewed draft with a different key', async () => {
  const h = rejectedRecovery();
  await h.controller.recover();
  assert.equal(h.runtime.pending.load(accountId), null);
  assert.equal(h.view().pendingText, '');
  assert.equal(h.view().canReedit, true);
  assert.ok(
    !JSON.stringify([...h.storage.data.values()]).includes('被拒绝的原文'),
  );
  await h.controller.sendDraft();
  assert.equal(h.applied.length, 0);
  h.controller.reedit();
  assert.equal(h.view().draftText, '被拒绝的原文');
  h.controller.setDraftText('明确修改后的新草稿');
  let reads = 0;
  h.gateway.conversation = async () => {
    reads++;
    return conversation();
  };
  await h.controller.sendDraft();
  assert.equal(reads, 1);
  assert.deepEqual(h.applied, [
    {
      operation: 'send',
      conversationId,
      clientRequestId: otherId,
      text: '明确修改后的新草稿',
    },
  ]);
  assert.notEqual(h.applied[0]!.clientRequestId, h.original.clientRequestId);
  assert.equal(h.view().draftText, '');
  assert.equal(h.view().canReedit, false);
  assert.equal(h.runtime.pending.load(accountId), null);
  h.controller.dispose();
});

test('rejected recovery draft is memory-only and clears on hide or session switch', async () => {
  for (const clear of ['hide', 'logout'] as const) {
    const h = rejectedRecovery();
    await h.controller.recover();
    h.controller.reedit();
    h.controller.setDraftText('只保留当前账号的草稿');
    if (clear === 'hide') h.controller.hide();
    else h.sessions.logout();
    assert.equal(h.view().draftText, '');
    assert.equal(h.view().canReedit, false);
    assert.equal(h.view().editing, false);
    h.controller.reedit();
    await h.controller.sendDraft();
    assert.equal(h.applied.length, 0);
    h.controller.dispose();
  }
});

test('recovery new draft retains text when current permission is unavailable and cancels queued key creation', async () => {
  const h = rejectedRecovery();
  await h.controller.recover();
  h.controller.reedit();
  h.gateway.conversation = async () =>
    conversation({ sendAvailability: 'unavailable' });
  await h.controller.sendDraft();
  assert.equal(h.view().editing, true);
  assert.equal(h.view().draftText, '被拒绝的原文');
  assert.equal(h.runtime.pending.load(accountId), null);
  assert.equal(h.applied.length, 0);
  h.controller.dispose();

  const q = rejectedRecovery(),
    key = deferred<string>();
  q.runtime.newRequestId = () => key.promise;
  await q.controller.recover();
  q.controller.reedit();
  const sending = q.controller.sendDraft();
  await flush();
  q.controller.cancel();
  key.resolve(otherId);
  await sending;
  assert.equal(q.applied.length, 0);
  assert.equal(q.runtime.pending.load(accountId), null);
  q.controller.dispose();
});

test('uncertain recovery new draft becomes a frozen original and stays queryable after cancel', async () => {
  const h = rejectedRecovery(),
    waiting = deferred<ReturnType<typeof receipt>>();
  await h.controller.recover();
  h.controller.reedit();
  h.controller.setDraftText('新请求的固定原文');
  h.gateway.apply = async (intent) => {
    h.applied.push(intent);
    return waiting.promise;
  };
  const sending = h.controller.sendDraft();
  await flush();
  h.controller.cancel();
  assert.equal(h.view().pending, true);
  assert.equal(h.view().editing, false);
  assert.equal(h.view().canRetry, true);
  assert.equal(h.view().pendingText, '新请求的固定原文');
  assert.equal(h.view().requestId, otherId);
  h.controller.setDraftText('不能覆盖新原文');
  await h.controller.sendDraft();
  assert.equal(h.applied.length, 1);
  waiting.resolve(receipt(h.applied[0]!));
  await sending;
  assert.equal(h.runtime.pending.load(accountId)?.requestId, otherId);
  h.gateway.receipt = async () => receipt(h.applied[0]!);
  await h.controller.recover();
  assert.equal(h.runtime.pending.load(accountId), null);
  assert.equal(h.view().pendingText, '');
  h.controller.dispose();
});
