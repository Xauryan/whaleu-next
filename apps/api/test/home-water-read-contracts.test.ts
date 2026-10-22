import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  categorySchema,
  publishPostSchema,
  readableCategorySchema,
} from '../src/community/contracts.js';
import { hotPostViewSchema } from '../src/community/hot/response-schema.js';
import {
  searchHitSchema,
  semanticSearchHitSchema,
} from '../src/community/search/response-schema.js';
import { searchQuerySchema } from '../src/community/search/contracts.js';
import {
  categoryManagementSchema,
  reclassificationCommandSchema,
} from '../src/community/category-reclassification/contracts.js';
import { sourcePublicationOperations } from '../src/community/text-source/publication.js';
import type { Authority } from '../src/community/community-policy.js';
import type { CommunitySpace } from '../src/community/contracts.js';

const id = '00000000-0000-4000-8000-000000000001';
const space = { id, kind: 'regional', name: 'Synthetic Home scope' };
const author = {
  kind: 'anonymous',
  personaId: id,
  displayName: '匿名鲸鱼',
  avatar: null,
  isPostAuthor: true,
};
const post = {
  id,
  space,
  category: 'water',
  text: '系统归入水区的原文',
  images: [],
  author,
  publishedAt: '2026-10-22T00:00:00.000Z',
  likeCount: 0,
  commentCount: 0,
  replyCount: 0,
  discussionCount: 0,
  saveCount: 0,
  trading: null,
  component: { kind: 'none' },
  viewer: {
    isSelf: false,
    isLiked: false,
    canDelete: false,
    canComment: true,
    isSaved: false,
    canSave: true,
    canSetUpdatePreference: true,
  },
  commentsPolicy: 'open',
};
const hit = {
  kind: 'post',
  contentId: id,
  postId: id,
  rootCommentId: null,
  replyId: null,
  space,
  category: 'water',
  tradingSubtype: null,
  tradingUrgency: null,
  createdAt: '2026-10-22T00:00:00.000000Z',
  author,
  postSummary: post.text,
  snippet: {
    segments: [{ text: post.text, matched: true }],
    truncatedBefore: false,
    truncatedAfter: false,
  },
  target: { kind: 'post', postId: id },
};

test('shared post and keyword/semantic response contracts recognize only the bounded water addition', () => {
  assert.equal(hotPostViewSchema.parse(post).category, 'water');
  assert.equal(searchHitSchema.parse(hit).category, 'water');
  assert.equal(semanticSearchHitSchema.parse(hit).category, 'water');
  for (const category of ['future_category', 'Water', '', null, 9]) {
    assert.equal(readableCategorySchema.safeParse(category).success, false);
    assert.equal(
      hotPostViewSchema.safeParse({ ...post, category }).success,
      false,
    );
    assert.equal(
      searchHitSchema.safeParse({ ...hit, category }).success,
      false,
    );
  }
});

test('readable water does not authorize publishing or widen existing search filters', () => {
  const body = {
    clientRequestId: id,
    spaceId: id,
    category: 'discussion',
    text: post.text,
    authorMode: 'anonymous',
  };
  assert.equal(publishPostSchema.safeParse(body).success, true);
  assert.equal(categorySchema.safeParse('water').success, false);
  assert.equal(
    publishPostSchema.safeParse({ ...body, category: 'water' }).success,
    false,
  );
  assert.equal(
    searchQuerySchema.safeParse({ spaceId: id, category: 'water', q: '原文' })
      .success,
    false,
  );
});

test('water responses preserve anonymous projections, target binding and discussion count rules', () => {
  for (const privateField of ['accountId', 'profileId', 'campusId']) {
    const leaked = { ...author, [privateField]: id };
    assert.equal(
      hotPostViewSchema.safeParse({ ...post, author: leaked }).success,
      false,
    );
    assert.equal(
      searchHitSchema.safeParse({ ...hit, author: leaked }).success,
      false,
    );
  }
  assert.equal(
    hotPostViewSchema.safeParse({ ...post, discussionCount: 1 }).success,
    false,
  );
  assert.equal(
    searchHitSchema.safeParse({ ...hit, tradingSubtype: 'shuma' }).success,
    false,
  );
  assert.equal(
    searchHitSchema.safeParse({
      ...hit,
      target: { kind: 'post', postId: '00000000-0000-4000-8000-000000000002' },
    }).success,
    false,
  );
});

test('water category management is readable but never a client reclassification target', () => {
  const management = {
    postId: id,
    currentCategory: 'water',
    revision: 0,
    canChange: false,
    targets: [],
  };
  assert.equal(
    categoryManagementSchema.parse(management).currentCategory,
    'water',
  );
  assert.equal(
    categoryManagementSchema.safeParse({
      ...management,
      currentCategory: 'future_category',
    }).success,
    false,
  );
  assert.equal(
    reclassificationCommandSchema.safeParse({
      clientRequestId: id,
      postId: id,
      expectedRevision: 0,
      targetCategory: 'water',
    }).success,
    false,
  );
});

test('water source advisory admits ordinary children, not water post publishing or restricted author modes', () => {
  const community: CommunitySpace = {
    id,
    kind: 'regional',
    name: 'Water scope',
    isActive: true,
    operatingRegionId: id,
  };
  const authority: Authority = {
    phoneVerified: true,
    studentVerified: true,
    identityRegionId: id,
    crossRegionAllowed: true,
    unverifiedCommentsAllowed: true,
    unverifiedCategories: ['discussion'],
    restrictedActions: [],
    canManage: false,
  };
  for (const mode of ['named', 'anonymous'] as const)
    assert.deepEqual(
      sourcePublicationOperations(authority, community, 'water', mode),
      ['publish_comment', 'publish_reply'],
    );
  assert.deepEqual(
    sourcePublicationOperations(
      { ...authority, restrictedActions: ['publish_comment'] },
      community,
      'water',
      'named',
    ),
    [],
  );
  assert.deepEqual(
    sourcePublicationOperations(
      { ...authority, studentVerified: false, identityRegionId: null },
      community,
      'water',
      'anonymous',
    ),
    [],
  );
  assert.deepEqual(
    sourcePublicationOperations(
      authority,
      { ...community, kind: 'global', operatingRegionId: null },
      'water',
      'named',
    ),
    [],
  );
});
