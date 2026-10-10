import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { RatingScopedContextService } from '../src/ratings/scoped/context.service.js';

test('context owner consumes the exact auth tuple from already validated route filters', async () => {
  const owner = Object.create(
    RatingScopedContextService.prototype,
  ) as RatingScopedContextService;
  let reads = 0;
  const tx = {
    query: async () => {
      reads++;
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const filtered = {
    contextId: '10000000-0000-4000-8000-000000000001',
    contextToken: 'a'.repeat(43),
    categoryId: '10000000-0000-4000-8000-000000000002',
    minimumAverage: 3,
  };
  await assert.rejects(owner.resolveRandom('session', filtered, tx), {
    code: 'RATING_SCOPED_CONTEXT_CHANGED',
  });
  assert.equal(
    reads,
    1,
    'Valid route fields must not fail the context-only schema before its lookup',
  );
});
import {
  ratingScopedCategoryPageSchema,
  ratingScopedTargetPageSchema,
  ratingScopedCommentPageSchema,
  ratingScopedDiscussionSchema,
  ratingScopedReplyPageSchema,
  ratingScopedReplyPositionSchema,
  ratingScopedSubscriptionQuerySchema,
} from '../src/ratings/scoped/read.service.js';
import { RatingScopedProjection } from '../src/ratings/scoped/projection.js';
import { canonicalRatingScopedTargetDefinition } from '../src/community/content-review/rating-scoped-contracts.js';
import type { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
import type { RatingsAccessService } from '../src/ratings/access.js';
import type { RatingsRepository } from '../src/ratings/repository.js';
import type { RatingDiscussionProjection } from '../src/ratings/discussion-projection.js';
const id = (n: number) =>
  `93000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = {
  contextId: id(1),
  selector: { kind: 'campus' as const, campusId: id(2) },
  catalogRevision: id(3),
  protocolGeneration: id(4),
};
const category = {
  id: id(5),
  parentId: null,
  level: 1,
  kind: 'general',
  systemKey: null,
  name: 'Current category',
  description: '',
  revision: id(6),
};
const target = {
  id: id(7),
  categoryId: id(5),
  name: 'Current target',
  description: '',
  revision: id(8),
  allowedActions: {
    setScore: false,
    createComment: true,
    authorModes: ['named'],
  },
};
const comment = {
  id: id(9),
  targetId: id(7),
  body: 'Current comment',
  revision: id(10),
  createdAt: '2026-10-09T20:00:00.000000Z',
  author: {
    mode: 'anonymous',
    targetId: id(7),
    personaId: id(11),
    displayName: 'Synthetic persona',
  },
  isMine: false,
  allowedActions: { delete: false },
};
const reply = {
  ...comment,
  id: id(12),
  rootId: id(9),
  allowedActions: { reply: true, delete: false },
  replyTo: { kind: 'root' },
};
test('scoped page contracts reject legacy region, cross-category items and malformed continuations', () => {
  const page = {
    context: { ...context, parentId: null },
    items: [category],
    nextCursor: null,
    continuation: 'end',
  };
  assert(ratingScopedCategoryPageSchema.safeParse(page).success);
  assert.equal(
    ratingScopedCategoryPageSchema.safeParse({
      ...page,
      context: { ...page.context, regionId: id(13) },
    }).success,
    false,
  );
  assert.equal(
    ratingScopedCategoryPageSchema.safeParse({
      ...page,
      items: [{ ...category, parentId: id(13) }],
    }).success,
    false,
  );
  assert.equal(
    ratingScopedCategoryPageSchema.safeParse({
      ...page,
      items: [category, category],
    }).success,
    false,
  );
  assert.equal(
    ratingScopedCategoryPageSchema.safeParse({ ...page, continuation: 'more' })
      .success,
    false,
  );
  assert(
    ratingScopedTargetPageSchema.safeParse({
      context: { ...context, categoryId: id(5) },
      items: [target],
      nextCursor: null,
      continuation: 'end',
    }).success,
  );
  assert.equal(
    ratingScopedTargetPageSchema.safeParse({
      context: { ...context, categoryId: id(13) },
      items: [target],
      nextCursor: null,
      continuation: 'end',
    }).success,
    false,
  );
  assert(
    ratingScopedCommentPageSchema.safeParse({
      context: { ...context, targetId: id(7) },
      items: [comment],
      nextCursor: null,
      continuation: 'end',
    }).success,
  );
});
test('discussion and reply-position contexts bind exact root and selected campus', () => {
  const thread = {
    context: { ...context, targetId: id(7), rootId: id(9) },
    root: comment,
    allowedActions: { createReply: true, authorModes: ['named'] },
  };
  assert(ratingScopedDiscussionSchema.safeParse(thread).success);
  assert.equal(
    ratingScopedDiscussionSchema.safeParse({
      ...thread,
      context: { ...thread.context, rootId: id(13) },
    }).success,
    false,
  );
  const page = {
    context: { ...thread.context, order: 'oldest' },
    items: [reply],
    nextCursor: null,
    continuation: 'end',
  };
  assert(ratingScopedReplyPageSchema.safeParse(page).success);
  const position = { context: page.context, anchorReplyId: id(12), page };
  assert(ratingScopedReplyPositionSchema.safeParse(position).success);
  assert.equal(
    ratingScopedReplyPositionSchema.safeParse({
      ...position,
      context: {
        ...page.context,
        selector: { kind: 'campus', campusId: id(13) },
      },
    }).success,
    false,
  );
  assert.equal(
    ratingScopedReplyPositionSchema.safeParse({
      ...position,
      anchorReplyId: id(13),
    }).success,
    false,
  );
});
test('subscription query stays within the existing twenty-target proof bound', () => {
  const query = {
    contextId: id(1),
    contextToken: 'a'.repeat(43),
    targets: Array.from({ length: 20 }, (_, index) => ({
      targetId: id(100 + index),
      expectedTargetRevision: id(200 + index),
    })),
  };
  assert(ratingScopedSubscriptionQuerySchema.safeParse(query).success);
  assert.equal(
    ratingScopedSubscriptionQuerySchema.safeParse({
      ...query,
      targets: [
        ...query.targets,
        { targetId: id(300), expectedTargetRevision: id(301) },
      ],
    }).success,
    false,
  );
  assert.equal(
    ratingScopedSubscriptionQuerySchema.safeParse({
      ...query,
      targets: [query.targets[0], query.targets[0]],
    }).success,
    false,
  );
});
test('management preview never confers score/comment actions or substitutes target origin', async () => {
  const hex = 'c'.repeat(64);
  const definition = canonicalRatingScopedTargetDefinition({
    targetId: id(7),
    contentVersion: 1,
    definitionRevision: id(8),
    appliedTargetRevision: id(8),
    envelope: {
      version: 5,
      purpose: 'publish_rating_target_scoped',
      accountId: id(15),
      clientRequestId: id(16),
      targetId: id(7),
      targetRevision: id(8),
      definitionRevision: id(8),
      contentVersion: 1,
      categoryId: id(5),
      categoryRevision: id(6),
      scope: {
        selector: context.selector,
        scopeKey: `campus:${id(2)}`,
        catalogRevision: id(3),
        headRevision: id(17),
        scopeRevision: hex,
        contextId: id(1),
        contextDigest: hex,
        protocolGeneration: id(4),
        sourceDigest: hex,
        topologySnapshotId: id(18),
      },
      targetOrigin: { regionId: id(19), originCampusId: id(20) },
      assetIds: [],
      name: target.name,
      description: '',
    },
  });
  let calls = 0;
  const projection = new RatingScopedProjection(
    {
      currentTargetDefinition: async () => {
        calls++;
        return { kind: 'allow' };
      },
    } as unknown as RatingContentReviewFacade,
    { authorModes: async () => ['named'] } as unknown as RatingsAccessService,
    {
      summary: async () => ({ status: 'known' }),
    } as unknown as RatingsRepository,
    {} as RatingDiscussionProjection,
  );
  const row = {
    id: id(7),
    revision: id(8),
    category_id: id(5),
    creator_id: id(15),
    region_id: id(19),
    active: true,
    name: target.name,
    description: '',
    envelope: definition.envelope,
    definition,
  };
  const result = await projection.target(
    row,
    { accountId: id(15), mode: 'admin_preview' },
    {} as PoolClient,
  );
  assert.deepEqual(result.allowedActions, {
    setScore: false,
    createComment: false,
    authorModes: ['named'],
  });
  assert.equal(calls, 1);
  await assert.rejects(() =>
    projection.target(
      { ...row, region_id: id(2) },
      { accountId: id(15), mode: 'public' },
      {} as PoolClient,
    ),
  );
});
