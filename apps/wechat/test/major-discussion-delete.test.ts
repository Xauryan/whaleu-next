import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpMajorDiscussionGateway } from '../src/major-discussion/gateway';
import { PendingMajorDiscussionStore } from '../src/major-discussion/pending';
import {
  MajorDiscussionController,
  type MajorDiscussionView,
} from '../src/major-discussion/controller';
import {
  decodeDiscussionIntent,
  decodeDiscussionReceipt,
  matchDiscussionReceipt,
  type DiscussionDeleteIntent,
} from '../src/major-discussion/operation-contract';
import {
  decodeDiscussionIntent as legacyIntent,
  decodeDiscussionReceipt as legacyReceipt,
} from '../src/major-discussion/contract';
import { ScriptedTransport, deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  discussionHarness,
  id,
  rootId,
  replyId,
  requestId,
  scoreRevision,
  item,
  page,
  receipt,
  cancelled,
  missing,
  intent,
} from './major-discussion-helpers';
const deletion = (reply = false): DiscussionDeleteIntent => ({
  operation: 'major.discussion.delete.v1',
  majorId: id,
  commentId: reply ? replyId : rootId,
  command: { clientRequestId: requestId, rootId: reply ? rootId : null },
});
test('delete codec is separate from immutable legacy v1; exact minimal receipt and subject matching', () => {
  const i = deletion();
  assert.throws(() => legacyIntent(i));
  assert.throws(() => legacyReceipt(receipt(i)));
  assert.deepEqual(decodeDiscussionIntent(i), i);
  for (const patch of [
    { body: 'leak' },
    { expectedCatalogRevision: scoreRevision },
    { rootId: rootId },
  ]) {
    if ('rootId' in patch) continue;
    assert.throws(() =>
      decodeDiscussionIntent({ ...i, command: { ...i.command, ...patch } }),
    );
  }
  assert.throws(() =>
    decodeDiscussionIntent({ ...i, command: { ...i.command, rootId } }),
  );
  assert.throws(() =>
    decodeDiscussionReceipt({ ...receipt(i), body: 'private' }),
  );
  assert.throws(() => matchDiscussionReceipt(i, receipt(deletion(true))));
  assert.deepEqual(decodeDiscussionReceipt(cancelled(i)), cancelled(i));
  assert.throws(() =>
    decodeDiscussionReceipt({ ...cancelled(i), code: 'not_recorded' }),
  );
  assert.deepEqual(decodeDiscussionIntent(intent()), legacyIntent(intent()));
});
test('production ApiClient routes delete submit receipt cancel to dedicated namespace with exact bodies', async () => {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpMajorDiscussionGateway(
    new ApiClient('https://discussion.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  const c = new Cancellation(),
    i = deletion(true);
  transport.reply(receipt(i));
  await gateway.submit(i, c);
  transport.reply(receipt(i));
  await gateway.receipt(requestId, c, i.operation);
  transport.reply(cancelled(i));
  await gateway.cancel(i, c);
  assert.deepEqual(
    transport.requests.map((r) => new URL(r.url).pathname),
    [
      `/v1/majors/${id}/discussion/${replyId}/delete`,
      `/v1/majors/discussion-delete-requests/${requestId}`,
      `/v1/majors/discussion-delete-requests/${requestId}/cancel`,
    ],
  );
  assert.deepEqual(transport.requests[0]!.body, i.command);
  assert.deepEqual(transport.requests[2]!.body, i);
  transport.reply(receipt(deletion()));
  await assert.rejects(gateway.submit(i, c));
});
test('two-tap deletion has no source/body fields and uses separate verified journal; reply keeps exact root', async () => {
  for (const reply of [false, true]) {
    const s = discussionHarness(reply ? 'thread' : 'roots');
    if (reply)
      s.impl.list = async () =>
        page({ root: item(), items: [item({ id: replyId, rootId })] });
    await s.controller.load(id, reply ? rootId : null);
    await s.controller.submit();
    assert.equal(s.commands.length, 0);
    await s.controller.inspectDeletion(reply ? replyId : rootId);
    s.controller.confirmDelete(reply ? replyId : rootId);
    assert.equal(s.view().confirming, 'delete');
    s.impl.submit = async (i) => {
      assert.ok(
        [...s.storage.data.keys()].some((k) =>
          k.includes('major-discussion-delete.pending'),
        ),
      );
      assert.ok(
        ![...s.storage.data.keys()].some((k) =>
          k.includes('major-discussion.pending'),
        ),
      );
      return receipt(i);
    };
    await Promise.all([s.controller.submit(), s.controller.submit()]);
    assert.deepEqual(s.commands, [deletion(reply)]);
    assert.equal(s.store.load(s.accountId), null);
  }
});
test('missing receipt remains frozen; durable cancellation is retried after cold restart and no public read needed', async () => {
  const s = discussionHarness('recovery'),
    i = deletion();
  s.store.freeze(s.pending(i));
  await s.controller.load();
  await s.controller.recover(false, true);
  assert.equal(s.view().frozen, true);
  assert.equal(s.view().confirming, 'cancel');
  s.impl.cancel = async () => {
    throw missing();
  };
  await s.controller.confirmCancellation();
  assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
  s.controller.dispose();
  let view: MajorDiscussionView | undefined;
  const c = new MajorDiscussionController(s.runtime, 'recovery', (v) => {
    view = v;
  });
  s.impl.cancel = async (command) => cancelled(command);
  await c.load();
  await c.recover(true);
  assert.equal(view!.frozen, false);
  assert.match(view!.receiptStatus, /确认取消/);
  assert.equal(s.calls.includes('list'), false);
  assert.deepEqual(s.commands, [i, i]);
});
test('separate account/origin journal, failed write, tampered receipt and late account response fail closed', async () => {
  const s = discussionHarness(),
    i = deletion();
  await s.controller.load(id);
  s.storage.failWrite = true;
  await s.controller.inspectDeletion(rootId);
  s.controller.confirmDelete(rootId);
  await s.controller.submit();
  assert.equal(s.commands.length, 0);
  s.storage.failWrite = false;
  await s.controller.reload();
  const d = deferred<ReturnType<typeof receipt>>();
  s.impl.submit = async () => d.promise;
  await s.controller.inspectDeletion(rootId);
  s.controller.confirmDelete(rootId);
  const running = s.controller.submit();
  await flush();
  assert.equal(
    new PendingMajorDiscussionStore(s.storage, 'https://another.example').load(
      s.accountId,
    ),
    null,
  );
  assert.equal(s.store.load(replyId), null);
  assert.throws(() => s.store.settle(s.pending(i), receipt(deletion(true))));
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('other'),
    accountId: replyId,
  });
  d.resolve(receipt(i));
  await running;
  assert.equal(s.view().items.length, 0);
  assert.equal(s.store.load(s.accountId)?.intent.operation, i.operation);
});
test('historical noop/applied wins cancellation and journal namespace corruption never creates a replacement', async () => {
  const s = discussionHarness('recovery'),
    i = deletion();
  s.store.freeze(s.pending(i));
  await s.controller.load();
  const applied = receipt(i);
  assert.equal(applied.outcome, 'applied');
  const r = { ...applied, outcome: 'noop' as const };
  s.impl.receipt = async () => r;
  await s.controller.recover(false, true);
  assert.equal(s.view().frozen, false);
  assert.equal(s.view().confirming, null);
  assert.equal(s.commands.length, 0);
  const pending = s.pending(i);
  s.storage.data.set(
    `whaleu.major-discussion.pending.v1:${s.store.origin}:${s.accountId}`,
    pending,
  );
  assert.throws(() => s.store.load(s.accountId));
  assert.throws(() => s.store.freeze(pending));
});
test('delete response after same-account epoch replacement or page hide cannot clear original journal', async () => {
  for (const hide of [false, true]) {
    const s = discussionHarness();
    await s.controller.load(id);
    const d = deferred<ReturnType<typeof receipt>>();
    s.impl.submit = async () => d.promise;
    await s.controller.inspectDeletion(rootId);
    s.controller.confirmDelete(rootId);
    const running = s.controller.submit();
    await flush();
    if (hide) s.controller.dispose();
    else
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    d.resolve(receipt(deletion()));
    await running;
    assert.equal(
      s.store.load(s.accountId)?.intent.operation,
      'major.discussion.delete.v1',
    );
    assert.equal(s.view().items.length, 0);
  }
});
test('publication receipt recovery records bounded owner locator and first withdrawal uses capability without source snapshot', async () => {
  const s = discussionHarness('recovery');
  const publication = intent('original text');
  const p = s.store.freeze(s.pending(publication));
  s.store.settle(p, receipt(publication));
  assert.deepEqual(s.store.deletionLocators(s.accountId), [
    { majorId: id, commentId: rootId, rootId: null },
  ]);
  assert.equal(
    JSON.stringify(s.store.deletionLocators(s.accountId)).includes(
      'original text',
    ),
    false,
  );
  assert.deepEqual(
    new PendingMajorDiscussionStore(
      s.storage,
      'https://elsewhere.example',
    ).deletionLocators(s.accountId),
    [],
  );
  assert.deepEqual(s.store.deletionLocators(replyId), []);
  s.impl.list = async () => {
    throw Error('No public source permitted');
  };
  await s.controller.load();
  await s.controller.inspectDeletion(rootId, true);
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().confirming, 'delete');
  await s.controller.submit();
  assert.deepEqual(s.commands, [deletion()]);
  assert.deepEqual(s.store.deletionLocators(s.accountId), []);
  assert.equal(s.calls.includes('list'), false);
});
test('capability is one explicit lookup, exact root bound, denied/error/late proof cannot enable deletion', async () => {
  for (const mode of ['false', 'failure', 'wrong-root', 'late'] as const) {
    const s = discussionHarness();
    let count = 0;
    const d = deferred<{
      majorId: string;
      commentId: string;
      rootId: string | null;
      allowed: boolean;
    }>();
    s.impl.deleteCapability = async (locator) => {
      count++;
      if (mode === 'failure') throw missing();
      if (mode === 'late') return d.promise;
      return {
        ...locator,
        rootId: mode === 'wrong-root' ? replyId : locator.rootId,
        allowed: mode !== 'false',
      };
    };
    await s.controller.load(id);
    assert.equal(count, 0);
    s.controller.confirmDelete(rootId);
    assert.equal(s.view().confirming, null);
    const work = s.controller.inspectDeletion(rootId);
    await flush();
    if (mode === 'late') {
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
      d.resolve({
        majorId: id,
        commentId: rootId,
        rootId: null,
        allowed: true,
      });
    }
    await work;
    assert.equal(count, 1);
    assert.equal(s.view().deleteTarget, null);
    s.controller.confirmDelete(rootId);
    await s.controller.submit();
    assert.equal(s.commands.length, 0);
  }
});
test('capability HTTP has exact optional root query and strict minimal response binding', async () => {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpMajorDiscussionGateway(
    new ApiClient('https://discussion.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
  );
  const cancel = new Cancellation();
  const locator = { majorId: id, commentId: replyId, rootId };
  transport.reply({ ...locator, allowed: true });
  await gateway.deleteCapability(locator, cancel);
  assert.equal(new URL(transport.requests[0]!.url).search, `?rootId=${rootId}`);
  assert.equal(
    new URL(transport.requests[0]!.url).pathname,
    `/v1/majors/${id}/discussion/${replyId}/delete-capability`,
  );
  transport.reply({ ...locator, rootId: null, allowed: true });
  await assert.rejects(gateway.deleteCapability(locator, cancel));
  transport.reply({ ...locator, allowed: true, actorId: scoreRevision });
  await assert.rejects(gateway.deleteCapability(locator, cancel));
});
test('owner locators cap, strict storage readback, cancelled deletion preservation, and expired authority', async () => {
  const s = discussionHarness('recovery');
  for (let n = 0; n < 102; n++) {
    const publication = intent();
    const p = s.store.freeze(s.pending(publication));
    s.store.settle(p, {
      requestId,
      majorId: id,
      operation: 'major.discussion.root.v1',
      outcome: 'applied',
      commentId: `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`,
      createdAt: '2026-07-01T10:00:00.000Z',
    });
  }
  assert.equal(s.store.deletionLocators(s.accountId).length, 100);
  const publication = intent();
  s.store.settle(s.store.freeze(s.pending(publication)), receipt(publication));
  const d = s.store.freeze(s.pending(deletion()));
  s.store.settle(d, cancelled(deletion()));
  assert.ok(
    s.store.deletionLocators(s.accountId).some((r) => r.commentId === rootId),
  );
  await s.controller.load();
  await s.controller.inspectDeletion(rootId, true);
  s.impl.submit = async () => {
    throw new ClientError('http', 'Expired capability', {
      httpStatus: 403,
      serverCode: 'SAFETY_ACTION_RESTRICTED',
    });
  }; // Server independently rejects an expired capability.
  await s.controller.submit();
  assert.equal(s.view().frozen, true);
  assert.ok(
    s.store.deletionLocators(s.accountId).some((r) => r.commentId === rootId),
  );
  const key = `whaleu.major-discussion.own-deletion-locators.v1:${s.store.origin}:${s.accountId}`;
  s.storage.data.set(key, [
    { majorId: id, commentId: rootId, rootId: null, body: 'forbidden' },
  ]);
  assert.throws(() => s.store.deletionLocators(s.accountId));
});
test('valid legacy receipt remains recoverable beside corrupt delete journal and corrupt auxiliary locator', async () => {
  const s = discussionHarness('recovery'),
    original = intent();
  const p = s.store.freeze(s.pending(original));
  const legacyKey = `whaleu.major-discussion.pending.v1:${s.store.origin}:${s.accountId}`;
  const deleteKey = `whaleu.major-discussion-delete.pending.v1:${s.store.origin}:${s.accountId}`;
  const locatorKey = `whaleu.major-discussion.own-deletion-locators.v1:${s.store.origin}:${s.accountId}`;
  const brokenJournal = { corrupted: 'delete' },
    brokenLocator = [{ corrupted: 'locator' }];
  s.storage.data.set(deleteKey, brokenJournal);
  s.storage.data.set(locatorKey, brokenLocator);
  assert.throws(() => s.store.load(s.accountId));
  assert.throws(() => s.store.freeze(p));
  assert.deepEqual(s.store.loadForRecovery(s.accountId), p);
  s.impl.receipt = async () => receipt(original);
  await s.controller.load();
  assert.equal(s.view().deletionLocatorUnavailable, true);
  await s.controller.recover();
  assert.ok(s.calls.includes('receipt'));
  assert.match(s.view().receiptStatus, /历史回执/);
  assert.equal(s.view().frozen, true); // Corrupt second journal still blocks admission.
  assert.equal(s.storage.data.has(legacyKey), false);
  assert.deepEqual(s.storage.data.get(deleteKey), brokenJournal);
  assert.deepEqual(s.storage.data.get(locatorKey), brokenLocator);
  assert.throws(() => s.store.freeze(s.pending(deletion())));
});
test('two valid journals explicitly recover legacy first and settle only that namespace', async () => {
  const s = discussionHarness('recovery'),
    original = intent();
  s.store.freeze(s.pending(original));
  const deleteKey = `whaleu.major-discussion-delete.pending.v1:${s.store.origin}:${s.accountId}`;
  const dp = s.pending(deletion());
  s.storage.data.set(deleteKey, dp);
  const seen: string[] = [];
  s.impl.receipt = async (_id, _cancel, operation) => {
    seen.push(operation!);
    return operation === 'major.discussion.delete.v1'
      ? receipt(deletion())
      : receipt(original);
  };
  await s.controller.load();
  assert.equal(s.view().recoveryOperation, original.operation);
  await s.controller.recover();
  assert.deepEqual(s.storage.data.get(deleteKey), dp);
  assert.equal(s.view().recoveryOperation, 'major.discussion.delete.v1');
  assert.equal(s.view().frozen, true);
  await s.controller.recover();
  assert.deepEqual(seen, [original.operation, 'major.discussion.delete.v1']);
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(s.view().frozen, false);
});
test('auxiliary locator set and readback failure cannot block matched legacy receipt settlement and shows unavailable', async () => {
  for (const failure of ['set', 'readback'] as const) {
    const s = discussionHarness('recovery'),
      original = intent();
    s.store.freeze(s.pending(original));
    const locatorKey = `whaleu.major-discussion.own-deletion-locators.v1:${s.store.origin}:${s.accountId}`;
    const write = s.storage.set.bind(s.storage);
    s.storage.set = (key, value) => {
      if (key === locatorKey) {
        if (failure === 'set') throw Error('Synthetic cache failure');
        write(key, []); // Valid but incorrect readback must not be called success.
      } else write(key, value);
    };
    s.impl.receipt = async () => receipt(original);
    await s.controller.load();
    await s.controller.recover();
    assert.equal(s.store.load(s.accountId), null);
    assert.match(s.view().receiptStatus, /历史回执/);
    assert.equal(s.view().deletionLocatorUnavailable, true);
    assert.deepEqual(s.view().deletionLocators, []);
    s.storage.set = write;
    s.store.settle(s.store.freeze(s.pending(original)), receipt(original));
    await s.controller.reload();
    assert.equal(s.view().deletionLocatorUnavailable, false);
    assert.ok(s.view().deletionLocators.some((r) => r.commentId === rootId));
  }
});
test('legacy like reference validation remains strict even though new deletion auxiliary cache is isolated', async () => {
  const s = discussionHarness('recovery');
  const original = {
    operation: 'major.discussion.like.v1' as const,
    majorId: id,
    commentId: rootId,
    command: {
      clientRequestId: requestId,
      expectedCatalogRevision: scoreRevision,
      expectedMajorRevision: scoreRevision,
      active: true,
      expectedMembershipRevision: null,
    },
  };
  const p = s.store.freeze(s.pending(original));
  s.storage.data.set(
    `whaleu.major-discussion.pending.v1:${s.store.origin}:${s.accountId}:references`,
    [{ broken: true }],
  );
  assert.throws(() => s.store.settle(p, receipt(original)));
  assert.deepEqual(s.store.loadForRecovery(s.accountId), p);
});
