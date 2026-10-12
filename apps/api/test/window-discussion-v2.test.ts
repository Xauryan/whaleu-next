import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  windowRootPublishV2Schema,
  windowReplyPublishV2Schema,
  windowDiscussionIntentHashV2,
  windowDiscussionCancelV2Schema,
  windowDiscussionNoticeV2Schema,
} from '../src/ratings/windows/discussion/contracts-v2.js';
import {
  windowRootPublishSchema,
  windowDiscussionReceiptSchema,
} from '../src/ratings/windows/discussion/contracts.js';
import { windowDiscussionIntentHash } from '../src/ratings/windows/discussion/service.js';
import { windowDiscussionReviewDigest } from '../src/community/content-review/window-discussion-review.facade.js';
import { windowDiscussionMediaReviewDigest } from '../src/community/content-review/window-discussion-media-review.facade.js';
const ids = Array.from(
    { length: 9 },
    (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  ),
  actor = ids[0]!,
  windowId = ids[1]!,
  key = ids[2]!,
  catalog = ids[3]!,
  revision = ids[4]!;
const image = { assetId: ids[5]!, manifestDigest: 'a'.repeat(64) },
  q = {
    protocol: 'window-discussion-v2' as const,
    clientRequestId: key,
    expectedCatalogRevision: catalog,
    expectedWindowRevision: revision,
    body: '',
    images: [image],
  };
test('W3 v2 has its own bounded image-only root/reply policy and exact Unicode text', () => {
  assert.deepEqual(windowRootPublishV2Schema.parse(q), q);
  assert.ok(
    windowReplyPublishV2Schema.safeParse({ ...q, replyToReplyId: null })
      .success,
  );
  for (const images of [
    [],
    [image, image],
    [
      image,
      { ...image, assetId: ids[6]! },
      { ...image, assetId: ids[7]! },
      { ...image, assetId: ids[8]! },
    ],
    ['https://example.test/image'],
    ['[]'],
    {},
    null,
  ])
    assert.equal(
      windowRootPublishV2Schema.safeParse({ ...q, images }).success,
      false,
    );
  for (const body of ['0', ' é ', '🍱'.repeat(2000)])
    assert.equal(
      windowRootPublishV2Schema.parse({ ...q, body, images: [] }).body,
      body,
    );
  for (const body of [' ', '\u0000', '\ud800', '🍱'.repeat(2001)])
    assert.equal(
      windowRootPublishV2Schema.safeParse({ ...q, body }).success,
      false,
    );
  for (const fields of [
    { anonymous: true },
    { actorId: actor },
    { imageUrls: [] },
  ])
    assert.equal(
      windowRootPublishV2Schema.safeParse({ ...q, ...fields }).success,
      false,
    );
});
test('W3 v1 fixed byte-domain goldens do not acquire images or v2 purpose', () => {
  const text = {
    clientRequestId: key,
    expectedCatalogRevision: catalog,
    expectedWindowRevision: revision,
    body: ' é ',
  };
  assert.equal(
    windowDiscussionIntentHash(
      actor,
      windowId,
      null,
      'window.discussion.root.v1',
      text,
    ),
    '87d38101bcc62ff865fe6fe18a70cd1d15bf1532e0216d004dc7947a93ae9d24',
  );
  const envelope = {
    version: 1 as const,
    purpose: 'window.discussion.root.v1' as const,
    actorId: actor,
    requestId: key,
    windowId,
    catalogRevision: catalog,
    windowRevision: revision,
    body: text.body,
    rootId: null,
    replyToReplyId: null,
    replyToActorId: null,
  };
  assert.equal(
    windowDiscussionReviewDigest(envelope),
    'c389c026bcaf22516fac3d461ad9ffa3e0f9df2222c45abf5101a0d6c0fca3e0',
  );
  assert.equal(
    windowRootPublishSchema.safeParse({ ...text, images: [] }).success,
    false,
  );
  assert.equal(
    windowRootPublishSchema.safeParse({ ...text, body: '' }).success,
    false,
  );
  assert.equal(
    windowDiscussionReceiptSchema.safeParse({
      requestId: key,
      windowId,
      operation: 'window.discussion.root.v2',
      outcome: 'applied',
      commentId: ids[6],
      createdAt: '2026-10-12T00:00:00.000Z',
    }).success,
    false,
  );
  assert.notEqual(
    windowDiscussionMediaReviewDigest({
      ...envelope,
      version: 2,
      purpose: 'window.discussion.root.v2',
      images: [],
    }),
    windowDiscussionReviewDigest(envelope),
  );
});
test('W3 v2 command and Review bind ordered exact set, purpose and all owner coordinates', () => {
  const images = [image, { assetId: ids[6]!, manifestDigest: 'b'.repeat(64) }],
    command = { ...q, images },
    hash = windowDiscussionIntentHashV2(
      actor,
      windowId,
      null,
      'window.discussion.root.v2',
      command,
    );
  for (const changed of [
    { ...command, images: [...images].reverse() },
    { ...command, body: '0' },
    { ...command, expectedWindowRevision: ids[8]! },
  ])
    assert.notEqual(
      windowDiscussionIntentHashV2(
        actor,
        windowId,
        null,
        'window.discussion.root.v2',
        changed,
      ),
      hash,
    );
  const e = {
      version: 2 as const,
      purpose: 'window.discussion.root.v2' as const,
      actorId: actor,
      requestId: key,
      windowId,
      catalogRevision: catalog,
      windowRevision: revision,
      body: '',
      rootId: null,
      replyToReplyId: null,
      replyToActorId: null,
      images,
    },
    digest = windowDiscussionMediaReviewDigest(e);
  assert.notEqual(
    windowDiscussionMediaReviewDigest({ ...e, images: [...images].reverse() }),
    digest,
  );
  assert.notEqual(
    windowDiscussionMediaReviewDigest({
      ...e,
      purpose: 'window.discussion.reply.v2',
      rootId: ids[7]!,
    }),
    digest,
  );
});
test('W3 v2 cold cancel stores only original metadata/hash and like notices cannot acquire thumbnails', () => {
  const cancel = {
    protocol: 'window-discussion-v2',
    operation: 'window.discussion.root.v2',
    windowId,
    intentHash: null,
  };
  assert.deepEqual(windowDiscussionCancelV2Schema.parse(cancel), cancel);
  for (const extra of [
    { body: 'private draft' },
    { images: [image] },
    { descriptor: {} },
    { path: '/tmp/photo' },
    { bytes: [1, 2] },
  ])
    assert.equal(
      windowDiscussionCancelV2Schema.safeParse({ ...cancel, ...extra }).success,
      false,
    );
  const notice = {
    noticeId: ids[7],
    createdAt: '2026-10-12T00:00:00.000Z',
    readAt: null,
    status: 'available',
    kind: 'like',
    preview: {
      text: '',
      author: { mode: 'named', profileId: ids[8], displayName: 'User' },
      thumbnail: null,
    },
    target: { windowId, rootId: ids[6], commentId: ids[6] },
  };
  assert.ok(windowDiscussionNoticeV2Schema.safeParse(notice).success);
  assert.equal(
    windowDiscussionNoticeV2Schema.safeParse({
      ...notice,
      preview: {
        ...notice.preview,
        thumbnail: {
          windowId,
          commentId: ids[6],
          bindingId: ids[5],
          ordinal: 0,
        },
      },
    }).success,
    false,
  );
});
