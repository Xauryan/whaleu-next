/** Canonical synthetic facts; real normal AppModule and HTTP publication/save. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import type { PublishPost } from '../../src/community/contracts.js';
import { maintenanceFixture } from './title-maintenance-fixture.js';
import {
  createRuntimeActor,
  postApprovalEnvelope,
  setRuntimeVerification,
} from './community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  seedCommunityScope,
  withCommunityScopeWriter,
} from './community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from './community-approval-fixtures.js';

export async function subscriptionFixture() {
  const f = await maintenanceFixture();
  try {
    const scope = await seedCommunityScope(f.pool);
    await seedReviewPolicy(f.pool);
    const actor = async () => {
      const a = await createRuntimeActor(f.app);
      const facts = await setRuntimeVerification(
        f.pool,
        a.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        f.pool,
        a.accountId,
        facts,
        scope,
        scope.home.campusId,
      );
      return a;
    };
    type Actor = Awaited<ReturnType<typeof actor>>;
    const intent = (
      text = 'Synthetic subscription publication',
    ): PublishPost => ({
      clientRequestId: randomUUID(),
      spaceId: scope.home.spaceId,
      category: 'discussion',
      text,
      imageAssetIds: [],
      authorMode: 'named',
      commentsPolicy: 'open',
    });
    const approve = async (
      a: Actor,
      body: PublishPost,
      result: 'allow' | 'reject' = 'allow',
    ) =>
      approveEnvelope(
        f.pool,
        await postApprovalEnvelope(f.app, f.pool, a.accountId, body),
        { result },
      );
    const rawUnknown = async (a: Actor) => {
      const body = intent('Synthetic legacy raw unknown'),
        id = randomUUID();
      const accepted = await approve(a, body);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          'INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            id,
            body.spaceId,
            a.accountId,
            body.category,
            body.text,
            body.authorMode,
            body.commentsPolicy,
          ],
        );
        await f.app.get(ApprovalRepository).bind(accepted, 'post', id, tx);
      });
      return id;
    };
    const publication = (a: Actor, body: PublishPost) =>
      request(f.app.getHttpServer())
        .post('/v1/community/posts')
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send(body);
    const publish = async (a: Actor, body = intent()) => {
      await approve(a, body);
      const response = await publication(a, body).expect(201);
      assert.equal(
        response.body.outcome,
        'created',
        JSON.stringify(response.body),
      );
      return {
        id: response.body.resourceId as string,
        body,
        receipt: response.body,
      };
    };
    const save = async (
      a: Actor,
      postId: string,
      desired = true,
      cleanup = false,
    ) => {
      const path = cleanup
        ? `/v1/me/community/saved/${postId}`
        : `/v1/community/posts/${postId}/save`;
      const client = request(f.app.getHttpServer());
      const response = await (desired ? client.put(path) : client.delete(path))
        .set('Authorization', `Bearer ${a.accessToken}`)
        .send({ clientRequestId: randomUUID() })
        .expect(200);
      assert.equal(
        response.body.outcome,
        'applied',
        JSON.stringify(response.body),
      );
      return response.body;
    };
    const deletePost = (a: Actor, postId: string) =>
      request(f.app.getHttpServer())
        .delete(`/v1/community/posts/${postId}`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .expect(204);
    const obligations = async (postId: string) =>
      (
        await f.pool.query<{
          id: string;
          transition: string;
          source_sequence: string;
        }>(
          `SELECT o.id,o.transition,CASE WHEN o.transition='saved' THEN e.started_sequence ELSE e.ended_sequence END AS source_sequence FROM whaleu_community.saved_obligations o JOIN whaleu_community.saved_epochs e ON e.id=o.epoch_id WHERE e.post_id=$1 AND o.action='save_ranking' ORDER BY CASE WHEN o.transition='saved' THEN e.started_sequence ELSE e.ended_sequence END`,
          [postId],
        )
      ).rows;
    const snapshot = async () => {
      const tables = (
        await f.pool.query<{ table_schema: string; table_name: string }>(
          "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema LIKE 'whaleu\\_%' ESCAPE '\\' AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
        )
      ).rows;
      const result: Record<string, unknown> = {};
      for (const { table_schema, table_name } of tables) {
        assert.match(table_schema, /^[a-z_]+$/);
        assert.match(table_name, /^[a-z_]+$/);
        result[`${table_schema}.${table_name}`] = (
          await f.pool.query(
            `SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) AS rows FROM (SELECT to_jsonb(t) row FROM ${table_schema}.${table_name} t) s`,
          )
        ).rows[0]!.rows;
      }
      const sequences = (
        await f.pool.query<{ schemaname: string; sequencename: string }>(
          "SELECT schemaname,sequencename FROM pg_sequences WHERE schemaname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY schemaname,sequencename",
        )
      ).rows;
      for (const { schemaname, sequencename } of sequences) {
        assert.match(schemaname, /^[a-z_]+$/);
        assert.match(sequencename, /^[a-z_]+$/);
        result[`${schemaname}.${sequencename}`] = (
          await f.pool.query(
            `SELECT last_value,is_called FROM ${schemaname}.${sequencename}`,
          )
        ).rows;
      }
      return result;
    };
    return {
      ...f,
      scope,
      actor,
      intent,
      approve,
      rawUnknown,
      publication,
      publish,
      save,
      obligations,
      deletePost,
      snapshot,
    };
  } catch (e) {
    await f.close();
    throw e;
  }
}
