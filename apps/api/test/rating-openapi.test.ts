import * as scoped from '../src/ratings/scoped/contracts.js';
import * as scopedRead from '../src/ratings/scoped/read.service.js';
import * as scopedRandom from '../src/ratings/scoped/random.service.js';
import * as scopedNotices from '../src/ratings/scoped/notice.service.js';
import * as scopedController from '../src/ratings/scoped/controller.js';
import * as categories from '../src/ratings/category-management/contracts.js';
import * as ownerEdit from '../src/ratings/management/target-edit/contracts.js';
import * as ownerDeletion from '../src/ratings/management/target-deletion/contracts.js';
import * as management from '../src/ratings/management/contracts.js';
import * as randomRatings from '../src/ratings/random/contracts.js';
import * as deletion from '../src/ratings/deletion/contracts.js';
import * as subscriptions from '../src/ratings/subscriptions/contracts.js';
import * as subscriptionUpdates from '../src/notifications/ratings/subscription-contracts.js';
import * as likes from '../src/ratings/likes/contracts.js';
import * as likeUpdates from '../src/notifications/ratings/like-contracts.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import * as contracts from '../src/ratings/contracts.js';
import * as discussion from '../src/ratings/discussion-contracts.js';
import * as updates from '../src/notifications/ratings/contracts.js';
const execute = promisify(execFile);
const probe = `import assert from 'node:assert/strict';import net from 'node:net';import pg from 'pg';import {NestApplication} from '@nestjs/core';const fail=()=>{throw new Error('OpenAPI attempted live work');};net.Server.prototype.listen=fail;net.Socket.prototype.connect=fail;pg.Pool.prototype.connect=fail;pg.Pool.prototype.query=fail;globalThis.setInterval=fail;globalThis.setTimeout=fail;NestApplication.prototype.init=fail;NestApplication.prototype.listen=fail;const {renderRatingsOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');const first=await renderRatingsOpenApiDocument();assert.equal(await renderRatingsOpenApiDocument(),first);process.stdout.write(first);`;
async function render() {
  const r = await execute(
    process.execPath,
    ['--input-type=module', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        DATABASE_URL: 'invalid:offline-only',
        NODE_ENV: 'production',
      },
    },
  );
  assert.equal(r.stderr, '');
  return r.stdout;
}
test('ratings OpenAPI is deterministic offline and artifact-current', async () =>
  assert.equal(
    await render(),
    await readFile(
      new URL('../../../docs/openapi/ratings.json', import.meta.url),
      'utf8',
    ),
  ));
test('all 66 legacy and 39 scoped rating operations have exact schemas and safe auth/error metadata', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  const cases = [
    [
      '/v1/ratings/category-management/context',
      'get',
      categories.ratingCategoryManagementContextSchema,
    ],
    [
      '/v1/ratings/category-management/prepare',
      'post',
      categories.ratingCategoryPrepareResultSchema,
    ],
    [
      '/v1/ratings/category-management/categories',
      'post',
      categories.ratingCategoryReceiptSchema,
    ],
    [
      '/v1/ratings/category-management/cancel',
      'post',
      categories.ratingCategoryReceiptSchema,
    ],
    [
      '/v1/ratings/category-management/requests/{requestId}',
      'get',
      categories.ratingCategoryReceiptSchema,
    ],
    [
      '/v1/ratings/management/owner-edit/targets/{targetId}/context',
      'get',
      ownerEdit.ratingTargetEditContextSchema,
    ],
    [
      '/v1/ratings/management/owner-edit/prepare',
      'post',
      ownerEdit.ratingTargetEditPrepareResultSchema,
    ],
    [
      '/v1/ratings/management/owner-edit/commit',
      'post',
      ownerEdit.ratingTargetEditReceiptSchema,
    ],
    [
      '/v1/ratings/management/owner-edit/cancel',
      'post',
      ownerEdit.ratingTargetEditReceiptSchema,
    ],
    [
      '/v1/ratings/management/owner-edit/requests/{requestId}',
      'get',
      ownerEdit.ratingTargetEditReceiptSchema,
    ],
    [
      '/v1/ratings/management/owner-deletion/targets/{targetId}/context',
      'get',
      ownerDeletion.ratingTargetOwnerDeletionContextSchema,
    ],
    [
      '/v1/ratings/management/owner-deletion/targets/{targetId}',
      'post',
      ownerDeletion.ratingTargetOwnerDeletionReceiptSchema,
    ],
    [
      '/v1/ratings/management/owner-deletion/cancel',
      'post',
      ownerDeletion.ratingTargetOwnerDeletionReceiptSchema,
    ],
    [
      '/v1/ratings/management/owner-deletion/requests/{requestId}',
      'get',
      ownerDeletion.ratingTargetOwnerDeletionReceiptSchema,
    ],
    [
      '/v1/ratings/management/prepare',
      'post',
      management.ratingTargetPreparationSchema,
    ],
    [
      '/v1/ratings/management/targets',
      'post',
      management.ratingTargetCreationReceiptSchema,
    ],
    [
      '/v1/ratings/management/cancel',
      'post',
      management.ratingTargetCreationReceiptSchema,
    ],
    [
      '/v1/ratings/management/requests/{requestId}',
      'get',
      management.ratingTargetCreationReceiptSchema,
    ],
    [
      '/v1/ratings/random-target',
      'get',
      randomRatings.ratingRandomResponseSchema,
    ],
    [
      '/v1/ratings/comments/{id}/deletion-context',
      'get',
      deletion.ratingDeletionContextSchema,
    ],
    [
      '/v1/ratings/replies/{id}/deletion-context',
      'get',
      deletion.ratingDeletionContextSchema,
    ],
    [
      '/v1/ratings/admin/comments/{id}/deletion-context',
      'get',
      deletion.ratingAdminDeletionContextSchema,
    ],
    [
      '/v1/ratings/admin/replies/{id}/deletion-context',
      'get',
      deletion.ratingAdminDeletionContextSchema,
    ],
    [
      '/v1/ratings/admin/comments/{id}',
      'delete',
      deletion.ratingAdminDeletionReceiptSchema,
    ],
    [
      '/v1/ratings/admin/replies/{id}',
      'delete',
      deletion.ratingAdminDeletionReceiptSchema,
    ],
    [
      '/v1/ratings/admin/requests/{id}',
      'get',
      deletion.ratingAdminDeletionReceiptSchema,
    ],
    [
      '/v1/ratings/targets/{id}/subscription',
      'get',
      subscriptions.ratingSubscriptionStateSchema,
    ],
    [
      '/v1/ratings/targets/{id}/subscription',
      'put',
      subscriptions.ratingSubscriptionReceiptSchema,
    ],
    [
      '/v1/ratings/subscription-states/query',
      'post',
      subscriptions.ratingSubscriptionQueryResponseSchema,
    ],
    [
      '/v1/ratings/subscription-requests/{id}',
      'get',
      subscriptions.ratingSubscriptionReceiptSchema,
    ],
    [
      '/v1/me/ratings/subscription-updates',
      'get',
      subscriptionUpdates.ratingSubscriptionUpdatesPageSchema,
    ],
    [
      '/v1/me/ratings/subscription-updates/unread-count',
      'get',
      subscriptionUpdates.ratingSubscriptionUnreadCountSchema,
    ],
    [
      '/v1/me/ratings/subscription-updates/{noticeId}/target',
      'get',
      subscriptionUpdates.ratingSubscriptionNoticeTargetSchema,
    ],
    [
      '/v1/me/ratings/subscription-updates/{noticeId}/read',
      'put',
      subscriptionUpdates.ratingSubscriptionNoticeReadSchema,
    ],
    ['/v1/ratings/comments/{id}/like', 'get', likes.ratingLikeStateSchema],
    ['/v1/ratings/replies/{id}/like', 'get', likes.ratingLikeStateSchema],
    ['/v1/ratings/comments/{id}/like', 'put', likes.ratingLikeReceiptSchema],
    ['/v1/ratings/replies/{id}/like', 'put', likes.ratingLikeReceiptSchema],
    ['/v1/ratings/like-requests/{id}', 'get', likes.ratingLikeReceiptSchema],
    [
      '/v1/me/ratings/like-updates',
      'get',
      likeUpdates.ratingLikeUpdatesPageSchema,
    ],
    [
      '/v1/me/ratings/like-updates/unread-count',
      'get',
      updates.ratingUnreadCountSchema,
    ],
    [
      '/v1/me/ratings/like-updates/{noticeId}/target',
      'get',
      likeUpdates.ratingLikeNoticeTargetSchema,
    ],
    [
      '/v1/me/ratings/like-updates/{noticeId}/read',
      'put',
      updates.ratingNoticeReadSchema,
    ],
    ['/v1/ratings/context', 'get', contracts.ratingContextSchema],
    ['/v1/ratings/categories', 'get', contracts.ratingCategoryPageSchema],
    ['/v1/ratings/targets', 'get', contracts.ratingTargetPageSchema],
    ['/v1/ratings/targets/{id}', 'get', contracts.ratingTargetSchema],
    ['/v1/ratings/targets/{id}/my-score', 'get', contracts.ratingMyScoreSchema],
    [
      '/v1/ratings/targets/{id}/score-summary',
      'get',
      contracts.ratingSummarySchema,
    ],
    [
      '/v1/ratings/targets/{id}/comments',
      'get',
      contracts.ratingCommentPageSchema,
    ],
    ['/v1/ratings/comments/{id}', 'get', contracts.ratingCommentSchema],
    ['/v1/ratings/requests/{id}', 'get', contracts.ratingReceiptSchema],
    ['/v1/ratings/targets/{id}/my-score', 'put', contracts.ratingReceiptSchema],
    [
      '/v1/ratings/targets/{id}/comments',
      'post',
      contracts.ratingReceiptSchema,
    ],
    ['/v1/ratings/comments/{id}', 'delete', contracts.ratingReceiptSchema],
    [
      '/v1/ratings/comments/{id}/discussion',
      'get',
      discussion.ratingDiscussionSchema,
    ],
    [
      '/v1/ratings/comments/{id}/replies',
      'get',
      discussion.ratingReplyPageSchema,
    ],
    ['/v1/ratings/replies/{id}', 'get', discussion.ratingReplySchema],
    [
      '/v1/ratings/replies/{id}/position',
      'get',
      discussion.ratingReplyPositionSchema,
    ],
    [
      '/v1/ratings/comments/{id}/replies',
      'post',
      discussion.ratingReplyReceiptSchema,
    ],
    ['/v1/ratings/replies/{id}', 'delete', discussion.ratingReplyReceiptSchema],
    [
      '/v1/ratings/reply-requests/{id}',
      'get',
      discussion.ratingReplyReceiptSchema,
    ],
    ['/v1/me/ratings/updates', 'get', updates.ratingUpdatesPageSchema],
    [
      '/v1/me/ratings/updates/unread-count',
      'get',
      updates.ratingUnreadCountSchema,
    ],
    [
      '/v1/me/ratings/updates/{noticeId}/target',
      'get',
      updates.ratingNoticeTargetSchema,
    ],
    [
      '/v1/me/ratings/updates/{noticeId}/read',
      'put',
      updates.ratingNoticeReadSchema,
    ],
  ] as const;
  assert.equal(cases.length, 66);
  assert.equal(
    Object.entries(doc.paths)
      .filter(([path]) => path.startsWith('/v1/'))
      .reduce((n, [, item]) => n + Object.keys(item!).length, 0),
    66,
  );
  const scopedCases = [
    [
      '/v2/ratings/contexts',
      'post',
      scoped.ratingScopedContextSchema,
      'ratingScopedCreateContext',
    ],
    [
      '/v2/ratings/locators/resolve',
      'post',
      scopedNotices.ratingScopedResolvedLocatorSchema,
      'ratingScopedResolveLocator',
    ],
    [
      '/v2/ratings/categories',
      'get',
      scopedRead.ratingScopedCategoryPageSchema,
      'ratingScopedListCategories',
    ],
    [
      '/v2/ratings/targets',
      'get',
      scopedRead.ratingScopedTargetPageSchema,
      'ratingScopedListTargets',
    ],
    [
      '/v2/ratings/targets/{id}',
      'get',
      contracts.ratingTargetSchema,
      'ratingScopedGetTarget',
    ],
    [
      '/v2/ratings/targets/{id}/my-score',
      'get',
      contracts.ratingMyScoreSchema,
      'ratingScopedGetMyScore',
    ],
    [
      '/v2/ratings/targets/{id}/score-summary',
      'get',
      contracts.ratingSummarySchema,
      'ratingScopedGetScoreSummary',
    ],
    [
      '/v2/ratings/targets/{id}/comments',
      'get',
      scopedRead.ratingScopedCommentPageSchema,
      'ratingScopedListComments',
    ],
    [
      '/v2/ratings/comments/{id}',
      'get',
      contracts.ratingCommentSchema,
      'ratingScopedGetComment',
    ],
    [
      '/v2/ratings/comments/{id}/discussion',
      'get',
      scopedRead.ratingScopedDiscussionSchema,
      'ratingScopedGetDiscussion',
    ],
    [
      '/v2/ratings/comments/{id}/replies',
      'get',
      scopedRead.ratingScopedReplyPageSchema,
      'ratingScopedListReplies',
    ],
    [
      '/v2/ratings/replies/{id}',
      'get',
      discussion.ratingReplySchema,
      'ratingScopedGetReply',
    ],
    [
      '/v2/ratings/replies/{id}/position',
      'get',
      scopedRead.ratingScopedReplyPositionSchema,
      'ratingScopedGetReplyPosition',
    ],
    [
      '/v2/ratings/comments/{id}/like',
      'get',
      likes.ratingLikeStateSchema,
      'ratingScopedGetCommentLike',
    ],
    [
      '/v2/ratings/replies/{id}/like',
      'get',
      likes.ratingLikeStateSchema,
      'ratingScopedGetReplyLike',
    ],
    [
      '/v2/ratings/targets/{id}/subscription',
      'get',
      subscriptions.ratingSubscriptionStateSchema,
      'ratingScopedGetSubscription',
    ],
    [
      '/v2/ratings/subscriptions',
      'get',
      scopedRead.ratingScopedSubscriptionPageSchema,
      'ratingScopedListSubscriptions',
    ],
    [
      '/v2/ratings/random-target',
      'get',
      scopedRandom.ratingScopedRandomResponseSchema,
      'ratingScopedGetRandomTarget',
    ],
    [
      '/v2/ratings/management/owner-edit/targets/{targetId}/context',
      'get',
      scopedController.ratingScopedEditContextSchema,
      'ratingScopedGetEditContext',
    ],
    [
      '/v2/ratings/requests/{requestId}',
      'get',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedGetRequest',
    ],
    [
      '/v2/ratings/subscription-states/query',
      'post',
      subscriptions.ratingSubscriptionQueryResponseSchema,
      'ratingScopedQuerySubscriptionStates',
    ],
    [
      '/v2/ratings/targets/{id}/my-score',
      'put',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedSetScore',
    ],
    [
      '/v2/ratings/targets/{id}/comments',
      'post',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedCreateComment',
    ],
    [
      '/v2/ratings/comments/{id}/replies',
      'post',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedCreateReply',
    ],
    [
      '/v2/ratings/comments/{id}/like',
      'put',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedSetCommentLike',
    ],
    [
      '/v2/ratings/replies/{id}/like',
      'put',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedSetReplyLike',
    ],
    [
      '/v2/ratings/targets/{id}/subscription',
      'put',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedSetSubscription',
    ],
    [
      '/v2/ratings/management/prepare',
      'post',
      scopedController.ratingScopedPrepareResponseSchema,
      'ratingScopedPrepareTarget',
    ],
    [
      '/v2/ratings/management/targets',
      'post',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedCreateTarget',
    ],
    [
      '/v2/ratings/management/cancel',
      'post',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedCancelTargetCreation',
    ],
    [
      '/v2/ratings/management/owner-edit/prepare',
      'post',
      scopedController.ratingScopedPrepareResponseSchema,
      'ratingScopedPrepareTargetEdit',
    ],
    [
      '/v2/ratings/management/owner-edit/commit',
      'post',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedCommitTargetEdit',
    ],
    [
      '/v2/ratings/management/owner-edit/cancel',
      'post',
      scoped.ratingScopedReceiptSchema,
      'ratingScopedCancelTargetEdit',
    ],
    [
      '/v2/me/ratings/updates',
      'get',
      scopedNotices.ratingScopedNoticePageSchema,
      'ratingScopedListUpdates',
    ],
    [
      '/v2/me/ratings/updates/{noticeId}/target',
      'get',
      scopedNotices.ratingScopedNoticeTargetSchema,
      'ratingScopedResolveUpdateTarget',
    ],
    [
      '/v2/me/ratings/like-updates',
      'get',
      scopedNotices.ratingScopedNoticePageSchema,
      'ratingScopedListLikeUpdates',
    ],
    [
      '/v2/me/ratings/like-updates/{noticeId}/target',
      'get',
      scopedNotices.ratingScopedNoticeTargetSchema,
      'ratingScopedResolveLikeUpdateTarget',
    ],
    [
      '/v2/me/ratings/subscription-updates',
      'get',
      scopedNotices.ratingScopedNoticePageSchema,
      'ratingScopedListSubscriptionUpdates',
    ],
    [
      '/v2/me/ratings/subscription-updates/{noticeId}/target',
      'get',
      scopedNotices.ratingScopedNoticeTargetSchema,
      'ratingScopedResolveSubscriptionUpdateTarget',
    ],
  ] as const;
  assert.equal(scopedCases.length, 39);
  for (const [path, method, , operationId] of scopedCases)
    assert.equal(doc.paths[path]![method]!.operationId, operationId);
  const allCases = [...cases, ...scopedCases] as const;
  assert.equal(
    Object.values(doc.paths).reduce((n, p) => n + Object.keys(p!).length, 0),
    allCases.length,
  );
  for (const [path, method, schema] of allCases) {
    const op = doc.paths[path]![method]!;
    assert.deepEqual(op.security, [{ accessToken: [] }]);
    assert.equal(!!op.requestBody, method !== 'get');
    const result = op.responses['200']!;
    assert.ok(!('$ref' in result));
    assert.deepEqual(
      result.content!['application/json']!.schema,
      z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'output' }),
    );
    for (const status of [
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '429',
      '500',
      '503',
    ]) {
      const response = op.responses[status]!;
      assert.ok(response && !('$ref' in response));
      assert.ok(response.headers?.['cache-control']);
      assert.ok(response.headers?.['vary']);
    }
  }
});
