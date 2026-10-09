import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeRatingDiscussion,
  decodeRatingReply,
  decodeRatingReplyIntent,
  decodeRatingReplyPage,
  decodeRatingReplyPosition,
  decodeRatingReplyReceipt,
  matchRatingReplyReceipt,
} from '../src/ratings/discussion-contract';
import {
  decodeRatingNotice,
  decodeRatingNoticeRead,
  decodeRatingNoticeTarget,
  decodeRatingUpdatesPage,
} from '../src/ratings/updates-contract';
import { decodeRatingThreadRoute } from '../src/ratings/discussion-controller';
import { ratingRejections } from '../src/ratings/contract';
import {
  commentId,
  otherId,
  personaId,
  revision,
  targetId,
} from './ratings-helpers';
import {
  discussion,
  locator,
  notice,
  noticeTarget,
  position,
  readReceipt,
  reply,
  replyBody,
  replyId,
  replyIntent,
  replyPage,
  replyReceipt,
  route,
  secondReplyId,
  updates,
} from './ratings-r2a-helpers';

test('R2A strict root/reply unions preserve typed same UUID ancestry and target-scoped personas', () => {
  assert.deepEqual(decodeRatingDiscussion(discussion()), discussion());
  assert.deepEqual(decodeRatingReply(reply()), reply());
  const equalIds = reply({ id: targetId, rootId: targetId });
  assert.equal(decodeRatingReply(equalIds).id, targetId);
  assert.equal(
    decodeRatingReply(
      reply({ replyTo: { kind: 'reply', status: 'unavailable' } }),
    ).allowedActions.reply,
    true,
  );
  assert.deepEqual(decodeRatingReplyPage(replyPage()), replyPage());
  assert.deepEqual(decodeRatingReplyPosition(position()), position());
});
for (const [label, raw] of Object.entries({
  rootExtra: { ...discussion(), replyCount: 0 },
  rootMismatch: discussion({
    context: { ...discussion().context, rootId: otherId },
  }),
  anonymousFirst: discussion({
    allowedActions: { createReply: true, authorModes: ['anonymous', 'named'] },
  }),
  anonymousOnly: discussion({
    allowedActions: { createReply: true, authorModes: ['anonymous'] },
  }),
  duplicateModes: discussion({
    allowedActions: { createReply: true, authorModes: ['named', 'named'] },
  }),
}))
  test(`discussion rejects ${label}`, () =>
    assert.throws(() => decodeRatingDiscussion(raw)));
for (const [label, patch] of Object.entries({
  recipient: { recipient: otherId },
  hiddenIdentity: { accountId: otherId },
  foreignRoot: { rootId: 'bad' },
  deleteOther: { isMine: false },
  extraAuthor: { author: { ...reply().author, profileId: otherId } },
  foreignPersona: {
    author: {
      mode: 'anonymous',
      targetId: otherId,
      personaId,
      displayName: 'x',
    },
  },
  unknownQuote: { replyTo: { kind: 'reply', status: 'missing' } },
  unavailableLeaksId: {
    replyTo: { kind: 'reply', status: 'unavailable', replyId: otherId },
  },
  rootLeaks: { replyTo: { kind: 'root', author: reply().author } },
  selfQuote: {
    replyTo: {
      kind: 'reply',
      status: 'available',
      replyId,
      revision,
      author: reply().author,
    },
  },
  foreignQuote: {
    replyTo: {
      kind: 'reply',
      status: 'available',
      replyId: secondReplyId,
      revision,
      author: {
        mode: 'anonymous',
        targetId: otherId,
        personaId,
        displayName: 'x',
      },
    },
  },
  bodySnapshot: {
    replyTo: {
      kind: 'reply',
      status: 'available',
      replyId: secondReplyId,
      revision,
      author: reply().author,
      body: 'snapshot',
    },
  },
  noncanonicalBody: { body: ' text ' },
  badTime: { createdAt: '2026-10-08T00:00:00+00:00' },
}))
  test(`reply rejects ${label}`, () =>
    assert.throws(() => decodeRatingReply({ ...reply(), ...patch })));
test('page and locator reject foreign ancestry, duplicate IDs, invalid cursor continuation and missing/misordered anchors', () => {
  for (const raw of [
    replyPage({ items: [reply(), reply()] }),
    replyPage({ items: [reply({ rootId: otherId })] }),
    replyPage({
      items: [
        reply({
          targetId: otherId,
          author: { mode: 'named', profileId: otherId, displayName: 'x' },
        }),
      ],
    }),
    replyPage({ nextCursor: null, continuation: 'scan' }),
    { ...replyPage(), context: { ...replyPage().context, order: 'newest' } },
    replyPage({ nextCursor: 'bad', continuation: 'more' }),
  ])
    assert.throws(() => decodeRatingReplyPage(raw));
  for (const raw of [
    position({ anchorReplyId: otherId }),
    position({ context: { ...position().context, rootId: otherId } }),
    position({
      page: replyPage({ items: [reply({ id: secondReplyId }), reply()] }),
    }),
  ])
    assert.throws(() => decodeRatingReplyPosition(raw));
  const scan = replyPage({
    items: [],
    nextCursor: 'a'.repeat(43),
    continuation: 'scan',
  });
  assert.deepEqual(decodeRatingReplyPage(scan), scan);
});
test('new reply intents normalize exactly and reject client recipients, media, wrong revision and malformed Unicode', () => {
  const original = replyIntent();
  if (original.operation !== 'create_reply') throw new Error('fixture');
  assert.deepEqual(
    decodeRatingReplyIntent({
      ...original,
      payload: { ...original.payload, body: ` \r\n${replyBody}\r\n ` },
    }),
    original,
  );
  assert.deepEqual(
    decodeRatingReplyIntent(replyIntent('delete_reply')),
    replyIntent('delete_reply'),
  );
  for (const body of [
    '',
    '\uD800',
    '\u0000',
    '\u007f',
    'a'.repeat(501),
    '😀'.repeat(501),
    ' '.repeat(1101),
  ])
    assert.throws(() =>
      decodeRatingReplyIntent({
        ...original,
        payload: { ...original.payload, body },
      }),
    );
  assert.equal(
    (
      decodeRatingReplyIntent({
        ...original,
        payload: { ...original.payload, body: '😀'.repeat(500) },
      }).payload as { body: string }
    ).body.length,
    1000,
  );
  for (const patch of [
    { recipient: otherId },
    { reply_to_user_id: otherId },
    { actorId: otherId },
    { assetIds: [otherId] },
    { rootId: otherId },
    { expectedRootRevision: 'bad' },
    {
      replyTo: {
        replyId: secondReplyId,
        expectedRevision: revision,
        username: 'hidden',
      },
    },
    { replyTo: undefined },
  ])
    assert.throws(() =>
      decodeRatingReplyIntent({
        ...original,
        payload: { ...original.payload, ...patch },
      }),
    );
});
test('reply receipts are minimal immutable history; creates cannot noop and matches enforce typed path identity', () => {
  assert.deepEqual(decodeRatingReplyReceipt(replyReceipt()), replyReceipt());
  for (const code of ratingRejections)
    assert.deepEqual(
      decodeRatingReplyReceipt({
        requestId: replyReceipt().requestId,
        operation: 'create_reply',
        outcome: 'rejected',
        code,
      }),
      {
        requestId: replyReceipt().requestId,
        operation: 'create_reply',
        outcome: 'rejected',
        code,
      },
    );
  for (const patch of [
    { outcome: 'noop' },
    { operation: 'create_comment' },
    { body: replyBody },
    { author: reply().author },
    { outcome: 'rejected', code: 'RATING_UNAVAILABLE' },
    { revision: 'bad' },
    { rootId: undefined },
  ])
    assert.throws(() =>
      decodeRatingReplyReceipt({ ...replyReceipt(), ...patch }),
    );
  for (const patch of [
    { requestId: otherId },
    { rootId: otherId },
    { targetId: otherId },
    { operation: 'delete_reply' as const },
  ])
    assert.throws(() =>
      matchRatingReplyReceipt(
        replyIntent(),
        replyReceipt(replyIntent(), patch),
      ),
    );
  assert.throws(() =>
    matchRatingReplyReceipt(
      replyIntent('delete_reply'),
      replyReceipt(replyIntent('delete_reply'), { replyId: otherId }),
    ),
  );
  assert.equal(
    decodeRatingReplyReceipt(
      replyReceipt(replyIntent('delete_reply'), { outcome: 'noop' }),
    ).outcome,
    'noop',
  );
});
test('rating notice unions never leak unavailable locators or anonymous accounts', () => {
  assert.deepEqual(decodeRatingNotice(notice()), notice());
  assert.deepEqual(decodeRatingUpdatesPage(updates()), updates());
  assert.deepEqual(decodeRatingNoticeTarget(noticeTarget()), noticeTarget());
  assert.deepEqual(decodeRatingNoticeRead(readReceipt()), readReceipt());
  const unavailable = {
    noticeId: notice().noticeId,
    createdAt: notice().createdAt,
    readAt: null,
    status: 'unavailable',
  };
  assert.deepEqual(decodeRatingNotice(unavailable), unavailable);
  for (const raw of [
    { ...unavailable, target: locator() },
    { ...notice(), domain: 'community' },
    { ...notice(), reason: 'saved' },
    {
      ...notice(),
      preview: {
        text: replyBody,
        author: { ...reply().author, accountId: otherId },
      },
    },
    { ...notice(), target: { ...locator(), targetId: otherId } },
    { ...notice(), recipient: otherId },
  ])
    assert.throws(() => decodeRatingNotice(raw));
  for (const raw of [
    { ...noticeTarget(), status: 'unavailable' },
    { ...noticeTarget(), reason: 'deleted' },
  ])
    assert.throws(() => decodeRatingNoticeTarget(raw));
  for (const unreadCount of [-1, 1.5, NaN, '0'])
    assert.throws(() => decodeRatingUpdatesPage({ ...updates(), unreadCount }));
  assert.throws(() =>
    decodeRatingUpdatesPage(updates({ items: [notice(), notice()] })),
  );
  assert.throws(() =>
    decodeRatingNoticeRead({ ...readReceipt(), readAt: null }),
  );
});
test('native thread route allows only typed IDs and requires a reply for notice navigation', () => {
  assert.deepEqual(decodeRatingThreadRoute(route), route);
  assert.deepEqual(decodeRatingThreadRoute({ ...route, rootId: targetId }), {
    ...route,
    rootId: targetId,
  });
  for (const raw of [
    null,
    {},
    { ...route, rootId: undefined },
    { ...route, replyId: 'bad' },
    { ...route, noticeId: otherId },
    { ...route, recipient: otherId },
    { ...route, regionId: null },
  ])
    assert.throws(() => decodeRatingThreadRoute(raw));
  assert.equal(
    decodeRatingThreadRoute({ ...route, replyId, noticeId: otherId }).rootId,
    commentId,
  );
});

test('native strict decoders accept the same frozen backend R2A golden JSON', () => {
  const golden = JSON.parse(
    readFileSync(
      join(__dirname, '../../../packages/fixtures/ratings-r2a.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    decodeRatingDiscussion(golden.discussion),
    golden.discussion,
  );
  assert.deepEqual(decodeRatingReply(golden.reply), golden.reply);
  assert.deepEqual(decodeRatingReplyReceipt(golden.receipt), golden.receipt);
  assert.deepEqual(
    decodeRatingNotice(golden.unavailableNotice),
    golden.unavailableNotice,
  );
  const page = {
    context: { ...golden.discussion.context, order: 'oldest' },
    items: [golden.reply],
    nextCursor: null,
    continuation: 'end',
  };
  assert.deepEqual(decodeRatingReplyPage(page), page);
  assert.deepEqual(
    decodeRatingReplyPosition({
      context: page.context,
      anchorReplyId: golden.reply.id,
      page,
    }).page,
    page,
  );
});

test('create receipt cannot claim the directly referenced reply as its own new identity', () => {
  const command = replyIntent();
  if (command.operation !== 'create_reply') throw new Error('fixture');
  assert.throws(() =>
    matchRatingReplyReceipt(
      {
        ...command,
        payload: {
          ...command.payload,
          replyTo: { replyId, expectedRevision: revision },
        },
      },
      replyReceipt(),
    ),
  );
});
