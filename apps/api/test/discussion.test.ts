import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  publishReplySchema,
  commentsQuerySchema,
  repliesQuerySchema,
  contextQuerySchema,
  discussionMutationSchema,
} from '../src/community/discussion/contracts.js';
import {
  replyIntent,
  replyApprovalHash,
} from '../src/community/discussion/publication.service.js';
import { publicationHash } from '../src/community/publication.repository.js';
import {
  requirePublication,
  requireAction,
} from '../src/community/community-policy.js';
import { verified } from './support/community-fixtures.js';
import {
  rootCursor,
  replyCursor,
  encodeDiscussionCursor,
} from '../src/community/discussion/cursor.js';
import { ApplicationError } from '../src/http/application-error.js';
const errorCode = (expected: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === expected;
const body = {
  clientRequestId: randomUUID(),
  text: '甲\r\n🐳',
  authorMode: 'named',
};
test('reply input is a flat strict root/optional-target intent with codepoint/media rules', () => {
  const value = publishReplySchema.parse(body);
  assert.equal(value.text, '甲\n🐳');
  assert.equal(value.targetReplyId, null);
  assert.deepEqual(value.imageAssetIds, []);
  for (const patch of [
    { rootCommentId: randomUUID() },
    { target: { kind: 'root' } },
    { targetAccountId: randomUUID() },
    { text: ' ' },
    { text: 'x\0' },
    { text: '\ud800' },
    { text: '🐳'.repeat(501) },
    { imageAssetIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] },
    { targetReplyId: 12 },
  ])
    assert.equal(
      publishReplySchema.safeParse({ ...body, ...patch }).success,
      false,
    );
  assert.equal(
    publishReplySchema.safeParse({ ...body, text: '🐳'.repeat(500) }).success,
    true,
  );
  assert.equal(
    publishReplySchema.safeParse({
      ...body,
      text: '',
      imageAssetIds: [randomUUID()],
    }).success,
    true,
  );
  const target = randomUUID();
  assert.equal(
    publishReplySchema.parse({ ...body, targetReplyId: target.toUpperCase() })
      .targetReplyId,
    target,
  );
  const asset = randomUUID();
  assert.equal(
    publishReplySchema.safeParse({
      ...body,
      imageAssetIds: [asset, asset.toUpperCase()],
    }).success,
    false,
  );
  assert.equal(
    publishReplySchema.parse({
      ...body,
      clientRequestId: body.clientRequestId.toUpperCase(),
    }).clientRequestId,
    body.clientRequestId,
  );
  const root = randomUUID(),
    post = randomUUID();
  const hash = publicationHash('publish_reply', replyIntent(root, value));
  for (const changed of [
    { ...value, targetReplyId: randomUUID() },
    { ...value, text: 'changed' },
    { ...value, authorMode: 'anonymous' as const },
    { ...value, imageAssetIds: [randomUUID()] },
  ])
    assert.notEqual(
      hash,
      publicationHash('publish_reply', replyIntent(root, changed)),
    );
  assert.notEqual(
    replyApprovalHash(post, root, value, 'named'),
    replyApprovalHash(post, root, value, 'anonymous'),
  );
  assert.notEqual(
    replyApprovalHash(post, root, value, 'named'),
    replyApprovalHash(randomUUID(), root, value, 'named'),
  );
});
test('regional unverified comments use an independent fact, never the new-post category allowlist', () => {
  const region = randomUUID();
  const space = {
    id: randomUUID(),
    kind: 'regional' as const,
    name: 'test',
    isActive: true,
    operatingRegionId: region,
  };
  const authority = {
    ...verified(region),
    studentVerified: false,
    identityRegionId: null,
    unverifiedCategories: [],
    unverifiedCommentsAllowed: true,
  };
  requirePublication(
    authority,
    space,
    'pets',
    'named',
    'publish_comment',
    'named',
  );
  assert.throws(
    () => requirePublication(authority, space, 'pets', 'named', 'publish_post'),
    errorCode('STUDENT_VERIFICATION_REQUIRED'),
  );
  assert.throws(
    () =>
      requirePublication(
        {
          ...authority,
          unverifiedCommentsAllowed: false,
          unverifiedCategories: ['pets'],
        },
        space,
        'pets',
        'named',
        'publish_comment',
        'named',
      ),
    errorCode('STUDENT_VERIFICATION_REQUIRED'),
  );
  assert.throws(
    () =>
      requirePublication(
        authority,
        space,
        'pets',
        'named',
        'publish_comment',
        'anonymous',
      ),
    errorCode('AUTHOR_MODE_NOT_ALLOWED'),
  );
  assert.throws(
    () =>
      requirePublication(
        authority,
        { ...space, kind: 'global', operatingRegionId: null },
        'discussion',
        'named',
        'publish_comment',
        'named',
      ),
    errorCode('STUDENT_VERIFICATION_REQUIRED'),
  );
  for (const action of ['like', 'pin', 'delete'] as const) {
    requireAction(authority, action);
    assert.throws(
      () =>
        requireAction({ ...authority, restrictedActions: [action] }, action),
      errorCode('COMMUNITY_ACTION_RESTRICTED'),
    );
  }
});
test('discussion reads and mutation keys reject unknown/coerced selectors and enforce bounded defaults', () => {
  assert.deepEqual(commentsQuerySchema.parse({}), {
    limit: 10,
    sort: 'likes',
    order: 'desc',
    previewLimit: 2,
  });
  assert.deepEqual(repliesQuerySchema.parse({}), { limit: 20 });
  assert.equal(repliesQuerySchema.parse({ limit: '50' }).limit, 50);
  for (const bad of [
    { previewLimit: '0' },
    { previewLimit: '6' },
    { sort: 'random' },
    { order: 'up' },
    { limit: '11' },
    { actor: randomUUID() },
  ])
    assert.equal(commentsQuerySchema.safeParse(bad).success, false);
  for (const bad of [{ limit: '51' }, { limit: 20 }, { limit: ['20', '30'] }])
    assert.equal(repliesQuerySchema.safeParse(bad).success, false);
  for (const bad of [
    {},
    { commentId: randomUUID(), replyId: randomUUID() },
    { replyId: randomUUID(), postId: randomUUID() },
  ])
    assert.equal(contextQuerySchema.safeParse(bad).success, false);
  assert.equal(
    contextQuerySchema.safeParse({ replyId: randomUUID() }).success,
    true,
  );
  assert.equal(
    discussionMutationSchema.safeParse({
      clientRequestId: randomUUID(),
      desired: true,
    }).success,
    false,
  );
});
test('discussion continuations distinguish invalid cursors from an explicit mutable root traversal restart', () => {
  const cursor = encodeDiscussionCursor({
    v: 3,
    scope: 'root-safe-scope',
    limit: 10,
    snapshot: 'a'.repeat(64),
    offset: 10,
  });
  assert.equal(rootCursor(cursor, 'root-safe-scope', 10)?.offset, 10);
  assert.throws(
    () => rootCursor(cursor, 'changed-sort', 10),
    errorCode('DISCUSSION_RESTART_REQUIRED'),
  );
  assert.throws(
    () => rootCursor(cursor, 'root-safe-scope', 5),
    errorCode('DISCUSSION_RESTART_REQUIRED'),
  );
  assert.throws(() => rootCursor('bad!', 'root-safe-scope', 10));
  assert.throws(
    () =>
      rootCursor(
        encodeDiscussionCursor({
          v: 2,
          scope: 'root-safe-scope',
          limit: 10,
          snapshot: 'a'.repeat(64),
          offset: 10,
        }),
        'root-safe-scope',
        10,
      ),
    errorCode('DISCUSSION_RESTART_REQUIRED'),
  );
  const reply = encodeDiscussionCursor({
    v: 1,
    scope: 'reply-scope',
    limit: 20,
    sequence: '123',
  });
  assert.equal(replyCursor(reply, 'reply-scope', 20), '123');
  assert.throws(() => replyCursor(reply, 'other-root', 20));
  assert.throws(() => replyCursor(reply, 'reply-scope', 2));
});
