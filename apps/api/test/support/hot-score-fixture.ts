/** Real component owners and PostgreSQL only; no public score surface. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import { HotScoreEvaluator } from '../../src/community/hot-score/evaluator.js';
import { HotScoreRepository } from '../../src/community/hot-score/repository.js';
import { HotScoreService } from '../../src/community/hot-score/service.js';
import { SubscriptionComponentSettlement } from '../../src/community/subscription-component/settlement.js';
import { LikeComponentSettlement } from '../../src/community/like-component/settlement.js';
import { CommentComponentSettlement } from '../../src/community/comment-component/settlement.js';
import { CommunitySubscriptionEnrollment } from '../../src/community/subscription-component/enrollment.js';
import { CommunityLikeEnrollment } from '../../src/community/like-component/enrollment.js';
import { CommunityCommentEnrollment } from '../../src/community/comment-component/enrollment.js';
import { CommunityViewEnrollment } from '../../src/community/view-component/enrollment.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { commentFixture } from './comment-component-fixture.js';
import {
  epochPath,
  reportPath,
  reportIntent,
} from './view-component-fixture.js';

export const components = ['subscription', 'like', 'comment', 'view'] as const;
export type Component = (typeof components)[number];
export async function hotScoreFixture() {
  const f = await commentFixture();
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env['TEST_DATABASE_URL']!,
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    HOT_SCORE_COMPUTATION: 'manual_only',
  });
  const repository = new HotScoreRepository();
  const evaluator = new HotScoreEvaluator();
  const database = f.app.get(DatabaseService);
  const service = new HotScoreService(config, database, repository, evaluator);
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  const like = (actor: Actor, postId: string, liked = true) =>
    request(f.app.getHttpServer())
      .put(`/v1/community/posts/${postId}/like`)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({ requestId: randomUUID(), liked })
      .expect(200);
  const view = async (actor: Actor, postIds: string[]) => {
    const epoch = await request(f.app.getHttpServer())
      .post(epochPath)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send({ version: 1 })
      .expect(200);
    return request(f.app.getHttpServer())
      .post(reportPath)
      .set('Authorization', `Bearer ${actor.accessToken}`)
      .send(reportIntent(epoch.body.epochId, postIds))
      .expect(200);
  };
  const ids = async (component: Exclude<Component, 'view'>, postId: string) => {
    if (component === 'subscription')
      return (await f.obligations(postId)).map((r) => r.id);
    return (
      await f.pool.query<{ id: string }>(
        `SELECT id FROM whaleu_post_hotness.${component}_sources WHERE post_id=$1 ORDER BY source_sequence`,
        [postId],
      )
    ).rows.map((r) => r.id);
  };
  const settle = async (
    component: Exclude<Component, 'view'>,
    postId: string,
  ) => {
    const owner =
      component === 'subscription'
        ? f.app.get(SubscriptionComponentSettlement)
        : component === 'like'
          ? f.app.get(LikeComponentSettlement)
          : f.app.get(CommentComponentSettlement);
    for (const id of await ids(component, postId)) {
      const result = await inTransaction(f.pool, (tx) =>
        owner.process(id, tx, true),
      );
      assert.ok(['applied', 'alreadyCompleted'].includes(result), result);
    }
  };
  const settleAll = async (postId: string) => {
    for (const component of ['subscription', 'like', 'comment'] as const)
      await settle(component, postId);
  };
  /** Deferred publication guards reject a committed partial publication. These
   * deliberately incomplete native facts live only in a rolled-back transaction. */
  const partialNative = async (
    tx: PoolClient,
    ownerId: string,
    omit?: Component,
    stateOnly = false,
  ) => {
    await lockSafetyPolicy(tx);
    const postId = randomUUID(),
      publicationRequestId = randomUUID();
    await tx.query(
      "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,receipt) VALUES($1,$2,$3,'publish_post',$4)",
      [
        ownerId,
        publicationRequestId,
        'a'.repeat(64),
        {
          requestId: publicationRequestId,
          operation: 'publish_post',
          outcome: 'created',
          resourceId: postId,
          createdAt: new Date().toISOString(),
        },
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic score coverage','named','open')",
      [postId, f.scope.home.spaceId, ownerId],
    );
    await tx.query(
      "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,source_request_id,provenance) VALUES('post',$1,$2,$3,'native_publication')",
      [postId, ownerId, publicationRequestId],
    );
    const owners = {
      subscription: new CommunitySubscriptionEnrollment(),
      like: new CommunityLikeEnrollment(),
      comment: new CommunityCommentEnrollment(),
      view: new CommunityViewEnrollment(),
    };
    for (const component of components) {
      if (component === omit) {
        if (stateOnly)
          await tx.query(
            `INSERT INTO whaleu_post_hotness.${component}_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)`,
            [postId, ownerId, publicationRequestId],
          );
      } else
        await owners[component].enrollPublishedPost(
          { postId, ownerId, publicationRequestId },
          tx,
        );
    }
    return postId;
  };
  return {
    ...f,
    config,
    database,
    repository,
    evaluator,
    service,
    like,
    view,
    ids,
    settle,
    settleAll,
    partialNative,
  };
}
export type HotScoreFixture = Awaited<ReturnType<typeof hotScoreFixture>>;

/** Run the unchanged service against an already-open real transaction so
 * incomplete deferred-constraint fixtures never become committed data. */
export function scoreInTransaction(f: HotScoreFixture, tx: PoolClient) {
  const database = Object.create(f.database) as DatabaseService;
  database.transaction = async (operation, options) => {
    assert.equal(options?.isolationLevel, 'read committed');
    return operation(tx);
  };
  return new HotScoreService(f.config, database, f.repository, f.evaluator);
}

export function assertComputed(
  result: Awaited<ReturnType<HotScoreService['inspect']>>,
): asserts result is Extract<
  Awaited<ReturnType<HotScoreService['inspect']>>,
  { status: 'computed' }
> {
  assert.equal(result.status, 'computed', JSON.stringify(result));
}
