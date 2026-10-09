import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeConversation,
  decodeMessage,
  decodeHistory,
  decodeEvents,
  decodeIntent,
  decodeReceipt,
  matchReceipt,
  normalizeText,
  compareSequence,
  sequence,
} from '../src/messaging/contract';
import { decodePost, decodePostIntent } from '../src/community/contract';
import { namedAuthor } from './discovery-helpers';
import { post, intent } from './community-helpers';
import {
  conversation,
  message,
  history,
  sendIntent,
  receipt,
  observationId,
  otherId,
  conversationId,
} from './messaging-helpers';
test('DM normalizes only CRLF, bounds Unicode codepoints and UTF-8 bytes, rejects controls and lone surrogates', () => {
  assert.equal(normalizeText('a\r\nb'), 'a\nb');
  assert.equal(normalizeText('😀'.repeat(500)).length, 1000);
  for (const text of [
    '😀'.repeat(501),
    '\r',
    '\u0000',
    '\u007f',
    '\ud800',
    ' \n\t',
  ])
    assert.throws(() => normalizeText(text));
});
test('DM exact opaque projections never permit anonymous profile or hidden linkage fields', () => {
  assert.deepEqual(decodeConversation(conversation()), conversation());
  assert.throws(() =>
    decodeConversation({ ...conversation(), accountId: otherId }),
  );
  assert.throws(() =>
    decodeConversation(
      conversation({
        peer: { mode: 'anonymous', displayName: '分身', profileId: otherId },
      }),
    ),
  );
  assert.throws(() =>
    decodeMessage(message({ state: 'recalled', text: 'leak' })),
  );
  assert.throws(() =>
    decodeMessage({ ...message(), senderAccountId: otherId }),
  );
  assert.deepEqual(
    decodeMessage(
      message({
        sender: 'self',
        state: 'unavailable',
        text: null,
        canRecall: true,
      }),
    ),
    message({
      sender: 'self',
      state: 'unavailable',
      text: null,
      canRecall: true,
    }),
  );
});
test('DM sequence never coerces BIGINT, and history/events ordering is strict', () => {
  assert.equal(sequence('9223372036854775807'), true);
  assert.equal(sequence('9223372036854775808'), false);
  assert.equal(sequence('01'), false);
  assert.ok(compareSequence('9007199254740993', '9007199254740992') > 0);
  assert.throws(() =>
    decodeHistory(
      history({
        items: [
          message({ sequence: '2' }),
          message({ id: otherId, sequence: '1' }),
        ],
      }),
    ),
  );
  assert.throws(() =>
    decodeEvents({
      items: [],
      nextCursor: 'next',
      hasMore: true,
      observationId,
      throughSequence: '0',
    }),
  );
});
test('DM receipts match immutable operation and target, never contain body', () => {
  const original = sendIntent();
  const accepted = receipt(original);
  if (accepted.outcome === 'rejected')
    throw new Error('Expected accepted fixture');
  matchReceipt(original, decodeReceipt(receipt(original)));
  assert.throws(() => decodeReceipt({ ...receipt(original), text: 'private' }));
  assert.throws(() =>
    matchReceipt(original, { ...accepted, conversationId: otherId }),
  );
  assert.throws(() => decodeIntent({ ...original, peerAccountId: otherId }));
  assert.throws(() =>
    decodeIntent({
      operation: 'open',
      clientRequestId: original.clientRequestId,
      entry: { kind: 'reply', postId: conversationId, replyId: otherId },
      initiationMode: 'anonymous',
    }),
  );
});
test('reviewed post optin keeps absent legacy shape, supports explicit false/true named only', () => {
  const old = intent();
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      decodePostIntent(old),
      'allowAnonymousDm',
    ),
    false,
  );
  assert.equal(
    decodePostIntent({ ...old, authorMode: 'named', allowAnonymousDm: false })
      .allowAnonymousDm,
    false,
  );
  assert.equal(
    decodePostIntent({ ...old, authorMode: 'named', allowAnonymousDm: true })
      .allowAnonymousDm,
    true,
  );
  assert.throws(() =>
    decodePostIntent({
      ...old,
      authorMode: 'anonymous',
      allowAnonymousDm: false,
    }),
  );
  assert.equal(
    decodePost({ ...post({ author: namedAuthor() }), allowAnonymousDm: true })
      .allowAnonymousDm,
    true,
  );
});
