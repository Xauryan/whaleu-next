import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeComment,
  decodeCommentCapabilities,
  decodePost,
  decodeReceipt,
} from '../src/community/contract';
import {
  decodeDiscussionContext,
  decodeDiscussionReceipt,
  decodeReplies,
  decodeReply,
  decodeReplyIntent,
} from '../src/community/discussion-contract';
import {
  comment,
  commentCapabilities,
  commentId,
  otherId,
  post,
  postId,
  receipt,
  reply,
  replyId,
  requestId,
} from './community-helpers';
test('discussion DTOs preserve counts and nested preview identity without private actor fields', () => {
  const root = comment({
    replyCount: 1,
    replyPreview: { items: [reply()], nextCursor: null },
  });
  assert.deepEqual(decodeComment(root), root);
  assert.deepEqual(decodeReply(reply()), reply());
  assert.equal(
    decodePost(post({ replyCount: 1, discussionCount: 2 })).discussionCount,
    2,
  );
  assert.throws(() => decodePost(post({ replyCount: 1, discussionCount: 1 })));
  assert.throws(() =>
    decodeComment({
      ...root,
      replyPreview: { items: [reply({ postId: otherId })], nextCursor: null },
    }),
  );
  assert.throws(() => decodeReply({ ...reply(), accountId: otherId }));
  assert.throws(() =>
    decodeReply({
      ...reply(),
      target: { ...reply().target, accountId: otherId },
    }),
  );
});
test('unavailable targets are status-only tombstones, no relation or author leakage', () => {
  const tombstone = reply({ target: { status: 'unavailable' } });
  assert.deepEqual(decodeReply(tombstone).target, { status: 'unavailable' });
  for (const extra of [
    { id: otherId },
    { kind: 'reply' },
    { author: reply().author },
    { text: 'hidden' },
    { images: [] },
  ])
    assert.throws(() =>
      decodeReply({
        ...tombstone,
        target: { status: 'unavailable', ...extra },
      }),
    );
  assert.throws(() =>
    decodeReply({
      ...reply(),
      target: {
        kind: 'comment',
        id: otherId,
        status: 'available',
        author: reply().author,
      },
    }),
  );
  assert.throws(() =>
    decodeReply({
      ...reply(),
      target: {
        kind: 'reply',
        id: replyId,
        status: 'available',
        author: reply().author,
      },
    }),
  );
});
test('historical discussion display preserves overlimit raw text, new writes stay strict500', () => {
  const text = '  ' + '🐳'.repeat(501) + '\r\n\u0001  ';
  assert.equal(decodeReply(reply({ text })).text, text);
  assert.equal(decodeComment(comment({ text })).text, text);
  assert.throws(() => decodeReply(reply({ text: '\ud800' })));
  assert.throws(() =>
    decodeReplyIntent({
      clientRequestId: requestId,
      text,
      imageAssetIds: [],
      authorMode: 'named',
      targetReplyId: null,
    }),
  );
  const intent = {
    clientRequestId: requestId,
    text: '🐳'.repeat(500),
    imageAssetIds: [],
    authorMode: 'anonymous',
    targetReplyId: null,
  };
  assert.equal(decodeReplyIntent(intent).text, intent.text);
  assert.throws(() =>
    decodeReplyIntent({ ...intent, targetAccountId: otherId }),
  );
  assert.throws(() =>
    decodeReplyIntent({ ...intent, text: '', imageAssetIds: [] }),
  );
  assert.equal(
    decodeReplyIntent({ ...intent, text: '', imageAssetIds: [otherId] })
      .imageAssetIds.length,
    1,
  );
});
test('reply list50 and context enforce flat same-root relationships and independent target', () => {
  const items = Array.from({ length: 50 }, (_, i) =>
    reply({
      id: `${(i + 100).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }),
  );
  assert.equal(decodeReplies({ items, nextCursor: null }).items.length, 50);
  assert.throws(() =>
    decodeReplies({ items: [...items, reply()], nextCursor: null }),
  );
  assert.throws(() =>
    decodeReplies({ items: [reply(), reply()], nextCursor: null }),
  );
  assert.equal(
    decodeDiscussionContext({
      comment: comment(),
      reply: reply(),
      replies: { items: [reply()], nextCursor: null },
    }).reply?.id,
    replyId,
  );
  assert.throws(() =>
    decodeDiscussionContext({
      comment: comment(),
      reply: reply({ rootCommentId: otherId }),
      replies: { items: [], nextCursor: null },
    }),
  );
});
test('publication, ballot and desired-state receipt operations remain disjoint', () => {
  assert.equal(
    decodeReceipt(receipt({ operation: 'publish_reply' })).operation,
    'publish_reply',
  );
  const applied = {
    requestId,
    operation: 'set_reply_like',
    outcome: 'applied',
    resourceId: replyId,
    desired: true,
  };
  assert.deepEqual(decodeDiscussionReceipt(applied), applied);
  assert.throws(() => decodeReceipt(applied));
  assert.throws(() => decodeDiscussionReceipt(receipt()));
  assert.throws(() => decodeDiscussionReceipt({ ...applied, likeCount: 1 }));
  assert.throws(() =>
    decodeDiscussionReceipt({ ...applied, operation: 'cast_poll_ballot' }),
  );
  assert.equal(
    decodeCommentCapabilities(commentCapabilities({ lastAuthorMode: 'named' }))
      .lastAuthorMode,
    'named',
  );
  assert.throws(() =>
    decodeCommentCapabilities({
      ...commentCapabilities(),
      lastAuthorMode: postId,
    }),
  );
  assert.throws(() =>
    decodeReply({ ...reply(), rootCommentId: commentId, replies: [] }),
  );
});

test('cross-table UUID reuse preserves root/reply ancestry while same-kind reply self-targets stay invalid', () => {
  const root = comment({ id: postId, postId });
  const item = reply({
    id: postId,
    postId,
    rootCommentId: postId,
    target: {
      kind: 'comment',
      id: postId,
      status: 'available',
      author: root.author,
    },
  });
  assert.deepEqual(decodeReply(item), item);
  assert.equal(
    decodeDiscussionContext({
      comment: root,
      reply: item,
      replies: { items: [item], nextCursor: null },
    }).reply?.id,
    postId,
  );
  assert.throws(() =>
    decodeReply({ ...item, target: { ...item.target, kind: 'reply' } }),
  );
  assert.throws(() =>
    decodeReply({ ...item, target: { ...item.target, id: otherId } }),
  );
  assert.throws(() =>
    decodeDiscussionContext({
      comment: root,
      reply: { ...item, postId: otherId },
      replies: { items: [], nextCursor: null },
    }),
  );
  assert.throws(() =>
    decodeDiscussionContext({
      comment: root,
      reply: {
        ...item,
        rootCommentId: otherId,
        target: { status: 'unavailable' },
      },
      replies: { items: [], nextCursor: null },
    }),
  );
});
