import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discussionBody,
  discussionBytes,
  decodeDiscussionIntent,
  decodeDiscussionPage,
  decodeDiscussionReceipt,
  decodeDiscussionNotice,
  matchDiscussionReceipt,
} from '../src/window-discussion/contract';
import { PendingWindowDiscussionStore } from '../src/window-discussion/pending';
import {
  discussionHarness,
  intent,
  like,
  item,
  page,
  receipt,
  cancelled,
  notice,
  id,
  rootId,
  replyId,
  source,
  scoreRevision,
} from './window-discussion-helpers';
test('exact UTF-8 text accepts 8000 bytes and rejects blank, surrogate, NUL and over-limit without normalization', () => {
  assert.equal(discussionBody('😀'.repeat(2000)), true);
  assert.equal(discussionBytes('😀'), 4);
  for (const b of ['', ' \n', '\ud800', '\udfff', 'a\0b', '😀'.repeat(2001)])
    assert.equal(discussionBody(b), false);
  assert.equal(
    decodeDiscussionIntent(intent(' A\n😀 ')).command.clientRequestId,
    source().clientRequestId,
  );
});
test('strict named projections reject private identity, anonymity, cross-window roots, duplicate items and impossible relationships', () => {
  assert.deepEqual(decodeDiscussionPage(page()), page());
  for (const p of [
    page({ items: [{ ...item(), accountId: id } as never] }),
    page({
      items: [
        item({ author: { ...item().author, mode: 'anonymous' } as never }),
      ],
    }),
    page({ items: [item({ windowId: replyId })] }),
    page({ items: [item(), item()] }),
    page({ items: [item({ isLiked: true })] }),
    page({ items: [item({ replyToReplyId: replyId })] }),
  ])
    assert.throws(() => decodeDiscussionPage(p));
});
test('reply target must be explicit nullable and command stays in separate W3 operation namespace', () => {
  const value = {
    operation: 'window.discussion.reply.v1',
    windowId: id,
    rootId,
    command: { ...source(), body: 'reply', replyToReplyId: null },
  };
  assert.deepEqual(decodeDiscussionIntent(value), value);
  assert.throws(() =>
    decodeDiscussionIntent({
      ...value,
      command: { ...source(), body: 'reply' },
    }),
  );
  assert.throws(() =>
    decodeDiscussionIntent({
      ...intent(),
      operation: 'course.comment.publish.v1',
    }),
  );
});
test('receipt matching pins exact operation, target, desired state and CAS including noops', () => {
  const i = like();
  assert.doesNotThrow(() => matchDiscussionReceipt(i, receipt(i)));
  assert.throws(() =>
    matchDiscussionReceipt(i, { ...receipt(i), commentId: replyId } as never),
  );
  assert.throws(() =>
    matchDiscussionReceipt(i, { ...receipt(i), active: false } as never),
  );
  assert.throws(() => decodeDiscussionReceipt({ ...receipt(i), text: 'leak' }));
  assert.throws(() =>
    matchDiscussionReceipt(i, { ...receipt(i), outcome: 'noop' } as never),
  );
  const no = like(false);
  assert.doesNotThrow(() =>
    matchDiscussionReceipt(
      no,
      decodeDiscussionReceipt({
        ...receipt(no),
        outcome: 'noop',
        membershipRevision: null,
        recordedAt: null,
      }),
    ),
  );
});
test('unavailable notices carry no preview or locator; available previews only named safe identity', () => {
  const n = notice();
  assert.deepEqual(decodeDiscussionNotice(n), n);
  assert.throws(() => decodeDiscussionNotice({ ...n, status: 'unavailable' }));
  assert.throws(() =>
    decodeDiscussionNotice({
      ...n,
      preview: {
        text: 'x',
        author: {
          mode: 'named',
          profileId: id,
          displayName: 'x',
          accountId: id,
        },
      },
    }),
  );
});
test('origin/account immutable journal survives corruption, conflicting freeze, cancellation restart and failed settlement', () => {
  const s = discussionHarness(),
    p = s.store.freeze(s.pending());
  assert.throws(() => s.store.freeze(s.pending(intent('replace'))));
  const c = s.store.beginCancellation(p);
  assert.equal(s.store.load(s.accountId)?.phase, 'cancel');
  assert.throws(() => s.store.assertOriginal(p));
  assert.equal(
    new PendingWindowDiscussionStore(s.storage, 'https://other.example').load(
      s.accountId,
    ),
    null,
  );
  s.storage.failRemove = true;
  assert.throws(() => s.store.settle(c, cancelled()));
  assert.deepEqual(s.store.load(s.accountId), c);
  s.storage.failRemove = false;
  s.store.settle(c, cancelled());
  assert.equal(s.store.load(s.accountId), null);
  const key = [...s.storage.data.keys()][0];
  if (key) s.storage.data.delete(key);
  s.storage.data.set(
    `whaleu.window-discussion.pending.v1:${s.store.origin}:${s.accountId}`,
    { invalid: true },
  );
  assert.throws(() => s.store.load(s.accountId));
});
test('settled likes retain bounded account/origin safe locators, never infer current state or persist body', () => {
  const s = discussionHarness(),
    i = like(true, scoreRevision),
    p = s.store.freeze(s.pending(i));
  s.store.settle(p, receipt(i));
  assert.deepEqual(s.store.references(s.accountId), [
    { windowId: id, commentId: rootId },
  ]);
  assert.equal(s.store.load(s.accountId), null);
  assert.equal(
    JSON.stringify([...s.storage.data.values()]).includes('合成'),
    false,
  );
});
