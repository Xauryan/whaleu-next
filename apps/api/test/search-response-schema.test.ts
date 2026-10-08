import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  searchHitSchema,
  searchPageSchema,
} from '../src/community/search/response-schema.js';
const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const hit = {
  kind: 'post',
  contentId: id,
  postId: id,
  rootCommentId: null,
  replyId: null,
  space: { id, kind: 'regional', name: 'Synthetic' },
  category: 'discussion',
  tradingSubtype: null,
  tradingUrgency: null,
  createdAt: '2026-10-08T00:00:00.123456Z',
  author: {
    kind: 'anonymous',
    personaId: id,
    displayName: '匿名鲸鱼',
    avatar: null,
    isPostAuthor: true,
  },
  postSummary: '<原文>',
  snippet: {
    segments: [{ text: '0', matched: true }],
    truncatedBefore: false,
    truncatedAfter: false,
  },
  target: { kind: 'post', postId: id },
};

test('strict lightweight response rejects full-post data, media, target mismatch, invented fields and overflow', () => {
  assert.deepEqual(searchHitSchema.parse(hit), hit);
  for (const patch of [
    { text: 'private' },
    { images: [] },
    { viewer: {} },
    { likeCount: 0 },
    { discussionCount: 0 },
    { score: 1 },
    { targetReplyAuthor: 'hidden' },
    { target: { kind: 'post', postId: other } },
    { postId: other },
    { rootCommentId: other },
    { replyId: other },
    { createdAt: '2026-10-08T00:00:00.123Z' },
    { postSummary: '😀'.repeat(81) },
    {
      author: {
        ...hit.author,
        avatar: {
          assetId: id,
          width: 1,
          height: 1,
          displayUrl: 'https://example.test/a',
          thumbnailUrl: 'https://example.test/a',
          expiresAt: null,
        },
      },
    },
    {
      snippet: {
        ...hit.snippet,
        segments: [{ text: 'x'.repeat(241), matched: true }],
      },
    },
    { snippet: { ...hit.snippet, segments: [{ text: 'x', matched: false }] } },
    { snippet: { ...hit.snippet, segments: [{ text: '', matched: true }] } },
    { tradingSubtype: 'shuma' },
    { category: 'trading' },
  ])
    assert.equal(
      searchHitSchema.safeParse({ ...hit, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    searchHitSchema.safeParse({
      ...hit,
      category: 'trading',
      tradingSubtype: 'shuma',
      tradingUrgency: 'urgent',
    }).success,
    true,
  );
});

test('page schema binds result types, uniqueness and continuation token presence without matching totals', () => {
  const page = {
    items: [hit],
    effectiveTypes: ['post'],
    nextCursor: null,
    continuation: 'end',
  };
  assert.deepEqual(searchPageSchema.parse(page), page);
  for (const patch of [
    { items: [hit, hit] },
    { effectiveTypes: ['comment'] },
    { effectiveTypes: [] },
    { effectiveTypes: ['post', 'post'] },
    { continuation: 'scan_pending' },
    { nextCursor: 'A'.repeat(43) },
    { total: 1 },
  ])
    assert.equal(
      searchPageSchema.safeParse({ ...page, ...patch }).success,
      false,
      JSON.stringify(patch),
    );
  assert.equal(
    searchPageSchema.safeParse({
      ...page,
      continuation: 'scan_pending',
      nextCursor: 'A'.repeat(43),
    }).success,
    true,
  );
});
