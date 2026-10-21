import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type {
  CommentView,
  PostView,
  ReplyView,
} from '../src/community/contracts.js';
import type {
  StoredPost,
  StoredReply,
} from '../src/community/community.repository.js';
import { CommunityRepository } from '../src/community/community.repository.js';
import { CommunityAccessService } from '../src/community/community-access.service.js';
import { CommunitySerializer } from '../src/community/community-serialization.js';
import { FeedService } from '../src/community/feed.service.js';
import { TextSourceReadService } from '../src/community/text-source/read.service.js';
import type { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { ContentDefinitionRepository } from '../src/community/content-review/content-definition.repository.js';
import type { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import { reviewedTextSource } from '../src/community/text-source/protocol.js';
import type { TextSourceReadV2 } from '../src/community/reading-formatting/reader.js';
import { ReadingContentService } from '../src/community/reading-content/service.js';
import {
  readingPostDetailSchema,
  readingCommentDetailSchema,
  readingReplyDetailSchema,
  readingContextSchema,
} from '../src/community/reading-content/contracts.js';
import type { ReadingBody } from '../src/community/reading-content/contracts.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const author = {
  kind: 'anonymous' as const,
  personaId: id(9),
  displayName: 'Whale',
  avatar: null,
  isPostAuthor: false,
};
const post: PostView = {
  id: id(1),
  space: { id: id(4), kind: 'regional', name: 'School' },
  category: 'discussion',
  text: '**never guess Markdown**',
  images: [],
  author,
  publishedAt: '2026-10-01T00:00:00.000Z',
  likeCount: 0,
  commentCount: 0,
  replyCount: 0,
  discussionCount: 0,
  saveCount: 0,
  trading: null,
  component: { kind: 'none' },
  commentsPolicy: 'open',
  allowAnonymousDm: false,
  viewer: {
    isSelf: false,
    isLiked: false,
    canDelete: false,
    canComment: false,
    isSaved: false,
    canSave: false,
    canSetUpdatePreference: false,
  },
};
const reply: ReplyView = {
  id: id(3),
  postId: post.id,
  rootCommentId: id(2),
  text: 'reply',
  images: [],
  author,
  createdAt: post.publishedAt,
  likeCount: 0,
  target: { status: 'unavailable' },
  viewer: { isSelf: false, canDelete: false, isLiked: false },
};
const comment: CommentView = {
  id: id(2),
  postId: post.id,
  text: 'comment',
  images: [],
  author,
  createdAt: post.publishedAt,
  likeCount: 0,
  replyCount: 1,
  isPinned: false,
  replyPreview: { items: [reply], nextCursor: null },
  viewer: { isSelf: false, canDelete: false, isLiked: false, canPin: false },
};
function presentation(kind: 'post' | 'comment' | 'reply'): TextSourceReadV2 {
  const content = kind === 'post' ? post : kind === 'comment' ? comment : reply;
  return {
    version: 2,
    source: {
      version: 1,
      classification: 'reviewedSource',
      kind,
      id: content.id,
      postId: post.id,
      rootCommentId: kind === 'post' ? null : comment.id,
      text: content.text,
      sourceRevision: 1,
      textSource: reviewedTextSource(
        content.text,
        { version: 1, format: 'markdown' },
        kind,
      ),
      readingFormattingEligible: false,
      presentationStatus: 'ineligible',
    },
    presentation: { status: 'source' },
  };
}
const sourceBody = (kind: 'post' | 'comment' | 'reply'): ReadingBody => ({
  classification: 'reviewedSource',
  value: presentation(kind),
});
const legacy = { classification: 'legacyPlain' as const };
const commentNode = () => ({
  content: comment,
  body: sourceBody('comment'),
  replyPreviewBodies: [{ id: reply.id, body: sourceBody('reply') }],
});
const stored: StoredPost = {
  id: post.id,
  space_id: post.space.id,
  account_id: id(8),
  category: 'discussion',
  text: post.text,
  author_mode: 'anonymous',
  comments_policy: 'open',
  publication_envelope_version: 6,
  visibility: 'approved',
  deleted_at: null,
  published_at: new Date(post.publishedAt),
};
const storedReply: StoredReply = {
  id: reply.id,
  post_id: post.id,
  root_comment_id: comment.id,
  account_id: id(8),
  text: reply.text,
  author_mode: 'anonymous',
  visibility: 'approved',
  deleted_at: null,
  created_at: new Date(reply.createdAt),
  target_reply_id: null,
  sequence: '1',
};
const tx = {} as PoolClient;
test('source-aware contracts preserve legacy DTO keys and never guess Markdown', () => {
  const value = readingPostDetailSchema.parse({
    version: 2,
    content: post,
    body: legacy,
  });
  assert.deepEqual(value.content, post);
  assert.deepEqual(value.body, legacy);
  for (const field of [
    'classification',
    'textSource',
    'source',
    'reading',
    'publication_envelope_version',
  ])
    assert.equal(Object.hasOwn(value.content, field), false);
  assert.equal(
    readingPostDetailSchema.safeParse({
      version: 2,
      content: post,
      body: { ...legacy, text: post.text },
    }).success,
    false,
  );
});
test('source bodies reject kind/id/post/root/text/hash mismatches', () => {
  assert.equal(
    readingPostDetailSchema.safeParse({
      version: 2,
      content: post,
      body: sourceBody('post'),
    }).success,
    true,
  );
  assert.equal(
    readingReplyDetailSchema.safeParse({
      version: 2,
      content: reply,
      body: sourceBody('reply'),
    }).success,
    true,
  );
  for (const patch of [
    { kind: 'comment' },
    { id: id(6) },
    { postId: id(6) },
    { rootCommentId: id(6) },
    { text: 'other' },
    {
      textSource: {
        version: 1,
        format: 'markdown',
        sourceHash: '0'.repeat(64),
      },
    },
  ]) {
    const body = sourceBody('reply');
    if (body.classification !== 'reviewedSource') throw new Error();
    Object.assign(body.value.source, patch);
    assert.equal(
      readingReplyDetailSchema.safeParse({ version: 2, content: reply, body })
        .success,
      false,
      JSON.stringify(patch),
    );
  }
});
test('preview bodies are exact bijection and context cannot cross post/root', () => {
  assert.equal(
    readingCommentDetailSchema.safeParse({ version: 2, ...commentNode() })
      .success,
    true,
  );
  for (const bodies of [
    [],
    [{ id: id(5), body: legacy }],
    [...commentNode().replyPreviewBodies, ...commentNode().replyPreviewBodies],
  ])
    assert.equal(
      readingCommentDetailSchema.safeParse({
        version: 2,
        ...commentNode(),
        replyPreviewBodies: bodies,
      }).success,
      false,
    );
  const context = {
    version: 2,
    comment: commentNode(),
    reply: { content: reply, body: sourceBody('reply') },
    replies: { items: [], nextCursor: null },
  };
  assert.equal(readingContextSchema.safeParse(context).success, true);
  assert.equal(
    readingContextSchema.safeParse({
      ...context,
      reply: { content: { ...reply, rootCommentId: id(8) }, body: legacy },
    }).success,
    false,
  );
});
test('only explicit canonical v1-v5 markers take legacy branch; absent/future markers fail closed', async () => {
  const service = new ReadingContentService(
    {} as CommunityRepository,
    new TextSourceReadService(
      {} as CommunityRepository,
      {} as CommunityAccessService,
      {} as ApprovalRepository,
      {} as ContentDefinitionRepository,
      {} as TextReviewRuntime,
    ),
  );
  for (const version of [1, 2, 3, 4, 5] as const) {
    const result = await service.post(
      post,
      { ...stored, publication_envelope_version: version },
      tx,
    );
    assert.equal(result.content, post);
    assert.deepEqual(result.body, legacy);
  }
  const missing = { ...stored };
  delete missing.publication_envelope_version;
  await assert.rejects(service.post(post, missing, tx), {
    code: 'COMMUNITY_UNAVAILABLE',
  });
  for (const version of [0, 7, '6', null])
    await assert.rejects(
      service.post(
        post,
        { ...stored, publication_envelope_version: version } as StoredPost,
        tx,
      ),
      { code: 'COMMUNITY_UNAVAILABLE' },
    );
});
test('v6 source failure propagates; row/source identities cannot be swapped', async () => {
  const failure = new Error('Current source authority denied');
  const service = new ReadingContentService(
    {} as CommunityRepository,
    {
      authorizedReading: async () => {
        throw failure;
      },
    } as unknown as TextSourceReadService,
  );
  await assert.rejects(
    service.post(post, stored, tx),
    (error) => error === failure,
  );
  const swapped = new ReadingContentService(
    {} as CommunityRepository,
    {
      authorizedReading: async () => presentation('reply'),
    } as unknown as TextSourceReadService,
  );
  await assert.rejects(swapped.post(post, stored, tx), {
    code: 'COMMUNITY_UNAVAILABLE',
  });
  await assert.rejects(
    swapped.reply({ ...reply, rootCommentId: id(7) }, storedReply, tx),
    { code: 'COMMUNITY_UNAVAILABLE' },
  );
});
test('envelopes retain optional-presentation object for final proof invalidation', async () => {
  const source = presentation('post');
  const service = new ReadingContentService(
    {} as CommunityRepository,
    {
      authorizedReading: async (
        kind: string,
        row: StoredPost,
        used: PoolClient,
      ) => {
        assert.equal(kind, 'post');
        assert.equal(row, stored);
        assert.equal(used, tx);
        return source;
      },
    } as unknown as TextSourceReadService,
  );
  const result = await service.post(post, stored, tx);
  if (result.body.classification !== 'reviewedSource') throw new Error();
  assert.equal(result.body.value, source);
  source.presentation = { status: 'source' };
  assert.equal(result.body.value.presentation, source.presentation);
});
test('existing detail authority, serialization and source projection use one managed TX', async () => {
  const seen: string[] = [];
  const same = (used: PoolClient) => assert.equal(used, tx);
  const repository = {
    database: {
      transaction: async (
        fn: (used: PoolClient) => Promise<unknown>,
        options: unknown,
      ) => {
        seen.push('begin');
        assert.deepEqual(options, { isolationLevel: 'read committed' });
        startTransactionDeadlines(tx);
        try {
          const value = await fn(tx);
          seen.push('final-proof');
          return value;
        } finally {
          clearTransactionDeadlines(tx);
        }
      },
    },
  } as unknown as CommunityRepository;
  const access = {
    actor: async (_token: string, used: PoolClient) => {
      same(used);
      seen.push('actor');
      return id(8);
    },
    accessiblePost: async (_id: string, _actor: string, used: PoolClient) => {
      same(used);
      seen.push('access');
      return { post: stored, space: post.space };
    },
    advisory: async (_actor: string, _space: unknown, used: PoolClient) => {
      same(used);
      return null;
    },
  } as unknown as CommunityAccessService;
  const serializer = {
    post: async (
      _row: StoredPost,
      _space: unknown,
      _actor: string,
      _advisory: unknown,
      used: PoolClient,
    ) => {
      same(used);
      seen.push('serialize');
      return post;
    },
  } as unknown as CommunitySerializer;
  const service = new FeedService(repository, access, serializer);
  const result = await service.projectDetail(
    'token',
    post.id,
    undefined,
    async (content, row, used) => {
      same(used);
      assert.equal(row, stored);
      assert.equal(content, post);
      seen.push('source-proof');
      return { content, body: legacy };
    },
  );
  assert.equal(result.content, post);
  assert.deepEqual(seen, [
    'begin',
    'actor',
    'access',
    'serialize',
    'source-proof',
    'final-proof',
  ]);
});
