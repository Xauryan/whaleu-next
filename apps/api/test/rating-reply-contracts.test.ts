import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  createRatingReplySchema,
  deleteRatingReplySchema,
  ratingDiscussionSchema,
  ratingReplySchema,
  ratingReplyPageSchema,
  ratingReplyPositionSchema,
  ratingReplyReceiptSchema,
} from '../src/ratings/discussion-contracts.js';
import { ratingNoticeSchema } from '../src/notifications/ratings/contracts.js';
const golden = JSON.parse(
  await readFile(
    new URL('../../../packages/fixtures/ratings-r2a.json', import.meta.url),
    'utf8',
  ),
) as Record<string, Record<string, unknown>>;
const id = '10000000-0000-4000-8000-000000000001';
test('R2A public golden contracts are strict and preserve SQL microseconds', () => {
  ratingDiscussionSchema.parse(golden['discussion']);
  ratingReplySchema.parse(golden['reply']);
  ratingReplyReceiptSchema.parse(golden['receipt']);
  ratingNoticeSchema.parse(golden['unavailableNotice']);
  for (const schema of [ratingReplySchema, ratingReplyReceiptSchema])
    assert.equal(
      schema.safeParse({
        ...golden[schema === ratingReplySchema ? 'reply' : 'receipt'],
        accountId: id,
      }).success,
      false,
    );
});
test('reply commands canonicalize text once and reject client-derived identity', () => {
  const command = {
    clientRequestId: id,
    regionId: null,
    targetId: id,
    expectedTargetRevision: id,
    expectedRootRevision: id,
    replyTo: null,
    authorMode: 'anonymous',
    body: ' \r\n😀 text\t ',
    assetIds: [],
  };
  assert.equal(createRatingReplySchema.parse(command).body, '😀 text');
  for (const patch of [
    { recipient: id },
    { username: 'name' },
    { replyTo: { replyId: id, expectedRevision: id, accountId: id } },
    { body: '\u0000' },
    { assetIds: [id] },
  ])
    assert.equal(
      createRatingReplySchema.safeParse({ ...command, ...patch }).success,
      false,
    );
  assert.equal(
    deleteRatingReplySchema.safeParse({
      clientRequestId: id,
      regionId: null,
      targetId: id,
      rootId: id,
      expectedTargetRevision: id,
      expectedRootRevision: id,
      expectedRevision: id,
    }).success,
    true,
  );
});
test('receipt never carries content and create cannot noop', () => {
  assert.equal(
    ratingReplyReceiptSchema.safeParse({
      ...golden['receipt'],
      outcome: 'noop',
    }).success,
    false,
  );
  assert.equal(
    ratingReplyReceiptSchema.safeParse({ ...golden['receipt'], body: 'stale' })
      .success,
    false,
  );
  assert.equal(
    ratingReplyReceiptSchema.safeParse({
      requestId: id,
      operation: 'delete_reply',
      outcome: 'rejected',
      code: 'CONTENT_REVIEW_UNAVAILABLE',
    }).success,
    false,
  );
});
test('typed cross-table UUID equality is allowed but same-table self quote is forbidden', () => {
  const original = golden['reply']!;
  const reply = { ...original, id, rootId: id, targetId: id };
  assert.equal(ratingReplySchema.safeParse(reply).success, true);
  assert.equal(
    ratingReplySchema.safeParse({
      ...reply,
      replyTo: {
        kind: 'reply',
        status: 'available',
        replyId: id,
        revision: id,
        author: original['author'],
      },
    }).success,
    false,
  );
});
test('page and position require exact ancestry, unique IDs and an inclusive first anchor', () => {
  const reply = golden['reply']!;
  const context = {
    ...(golden['discussion']!['context'] as object),
    order: 'oldest',
  };
  const page = {
    context,
    items: [reply],
    nextCursor: null,
    continuation: 'end',
  };
  ratingReplyPageSchema.parse(page);
  ratingReplyPositionSchema.parse({
    context,
    anchorReplyId: reply['id'],
    page,
  });
  assert.equal(
    ratingReplyPageSchema.safeParse({ ...page, items: [reply, reply] }).success,
    false,
  );
  assert.equal(
    ratingReplyPageSchema.safeParse({ ...page, nextCursor: 'A'.repeat(43) })
      .success,
    false,
  );
  assert.equal(
    ratingReplyPageSchema.safeParse({
      ...page,
      items: [{ ...reply, rootId: id }],
    }).success,
    false,
  );
  assert.equal(
    ratingReplyPositionSchema.safeParse({ context, anchorReplyId: id, page })
      .success,
    false,
  );
});
