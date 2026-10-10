import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { ratingTargetCreateHash } from '../../src/ratings/management/service.js';
import { prepareRatingTargetSchema } from '../../src/ratings/management/contracts.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { ratingIso } from '../../src/ratings/repository.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';

/** Runs only against disposable real AppModule/PG. Accepted synthetic policies
 * precede activation; all final catalogs come from the real compiler/publisher. */
test(
  'M3B genuine legacy bridge retains original bytes and atomically advances exact old/new domains',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const actor = f.creator;
    const seeded = await f.seedScopedCatalogs({ different: false });
    await f.grant(actor, 'developer');
    const allowed = [
      'set_score',
      'create_comment',
      'create_reply',
      'set_comment_like',
      'set_reply_like',
      'set_target_subscription',
      'create_target',
      'edit_target',
      'create_categories',
    ];
    const policy = async (
      logical: string,
      enabled: boolean,
      tx?: Parameters<typeof f.issueSource>[1],
    ) => {
      const keys =
        logical === 'global'
          ? ['global']
          : f.scope.topology.assignments
              .filter((c) => c.isActive && c.regionId === logical)
              .map((c) => `campus:${c.campusId}`)
              .sort();
      return f.issueSource(
        {
          kind: 'native_v1_compat_write',
          key: logical,
          scopeKeys: keys,
          payload: {
            policyVersion: 'native-v1-compat-write-v1',
            enabled,
            logicalScopeKey: logical,
            scopeKeys: keys,
            operations: allowed,
            placementPolicy: 'exact_legacy_domain',
            categoryPolicy: 'append_native_only',
          },
        },
        tx,
      );
    };
    for (const logical of f.logicalScopeKeys) await policy(logical, true);
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const region of [null, f.regionId]) {
        const id = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until) VALUES($1,$2,'general','synthetic-bridge-native-source','synthetic-bridge-native-policy','synthetic-bridge-test',1,true,'complete','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')`,
          [id, region],
        );
        await tx.query(
          "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES($1,'general',$2)",
          [region ?? 'global', id],
        );
      }
    });
    await f.publish({ activate: true });
    const state = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'old',(SELECT jsonb_agg(to_jsonb(h) ORDER BY scope_key) FROM whaleu_ratings.catalog_heads h),
    'scoped',(SELECT jsonb_agg(to_jsonb(h) ORDER BY scope_key) FROM whaleu_ratings.scoped_catalog_heads h),
    'compat',(SELECT jsonb_agg(to_jsonb(h) ORDER BY compat_key) FROM whaleu_ratings.compat_heads h),
    'requests',(SELECT count(*) FROM whaleu_ratings.requests),
    'releases',(SELECT count(*) FROM whaleu_ratings.scoped_releases),
    'causes',(SELECT count(*) FROM whaleu_ratings.scoped_command_causes),
    'sources',(SELECT count(*) FROM whaleu_ratings.scoped_source_attestations),
    'targets',(SELECT count(*) FROM whaleu_ratings.targets),
    'sourceEpoch',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton),
    'navigationEpoch',(SELECT epoch FROM whaleu_ratings.navigation_epoch WHERE singleton),
    'randomEpoch',(SELECT epoch FROM whaleu_ratings.random_pool_epoch WHERE singleton)) state`)
      ).rows[0]!.state;
    const post = (path: string, body: object) =>
      f
        .auth(request(f.http).post(`/v1/ratings/management/${path}`), actor)
        .send(body);
    const intent = async (regionId: string | null, categoryId: string) => {
      const row = (
        await f.pool.query<{ catalog_id: string; revision: string }>(
          `SELECT h.catalog_id,c.revision FROM whaleu_ratings.catalog_heads h JOIN whaleu_ratings.categories c ON c.catalog_id=h.catalog_id WHERE h.scope_key=$1 AND c.id=$2`,
          [regionId ?? 'global', categoryId],
        )
      ).rows[0]!;
      return prepareRatingTargetSchema.parse({
        clientRequestId: randomUUID(),
        regionId,
        categoryId,
        expectedCatalogRevision: row.catalog_id,
        expectedCategoryRevision: row.revision,
        name: 'Original legacy target',
        description: 'Original v1 Review bytes',
        assetIds: [],
      });
    };
    const prepare = async (input: Awaited<ReturnType<typeof intent>>) => {
      const response = await post('prepare', input);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const p = (
        await f.pool.query<{
          envelope: unknown;
          intent_hash: string;
          bytes: string;
        }>(
          `SELECT envelope,intent_hash,whaleu_ratings.creation_canonical_json(to_jsonb(p)) bytes FROM whaleu_ratings.target_preparations p WHERE account_id=$1 AND request_id=$2`,
          [actor.accountId, input.clientRequestId],
        )
      ).rows[0]!;
      return {
        response,
        p,
        command: {
          ...input,
          expectedContextRevision: response.body.contextRevision as string,
        },
      };
    };
    let regional!: {
      id: string;
      input: Awaited<ReturnType<typeof intent>>;
      command: object;
      receipt: unknown;
    };
    await t.test(
      'legal M1 region preserves original request/hash/Review and one final old head across both campuses',
      async () => {
        const input = await intent(f.regionId, seeded.local.categoryId),
          original = JSON.stringify(input),
          prepared = await prepare(input);
        const before = await state();
        const missingReview = await post('targets', prepared.command);
        assert.equal(
          missingReview.body.error?.code,
          'CONTENT_REVIEW_UNAVAILABLE',
        );
        assert.deepEqual(await state(), before);
        await approveRating(
          f.pool,
          canonicalRatingEnvelope(prepared.p.envelope),
        );
        const response = await post('targets', prepared.command);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.outcome, 'applied');
        assert.equal(JSON.stringify(input), original);
        const rows = (
          await f.pool.query(
            `SELECT q.operation,q.intent_hash,q.receipt,p.envelope,whaleu_ratings.creation_canonical_json(to_jsonb(p)) bytes,
      e.proof,e.artifact_id FROM whaleu_ratings.requests q JOIN whaleu_ratings.target_preparations p USING(account_id,request_id)
      JOIN whaleu_ratings.scoped_command_causes e USING(account_id,request_id) WHERE q.account_id=$1 AND q.request_id=$2`,
            [actor.accountId, input.clientRequestId],
          )
        ).rows;
        assert.equal(rows.length, 1);
        assert.equal(rows[0].operation, 'create_target');
        assert.equal(rows[0].intent_hash, ratingTargetCreateHash(input));
        assert.equal(rows[0].bytes, prepared.p.bytes);
        assert.deepEqual(rows[0].envelope, prepared.p.envelope);
        assert.deepEqual(rows[0].proof.intent, input);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, input.clientRequestId],
            )
          ).rowCount,
          0,
        );
        const final = (
          await f.pool.query(
            `SELECT old.catalog_id old_catalog,v.legacy_catalog_id,r.cause_kind,
      (SELECT count(*)::int FROM whaleu_ratings.scoped_release_scopes WHERE release_id=r.id) scopes,
      (SELECT count(*)::int FROM whaleu_ratings.compat_projection_manifests WHERE release_id=r.id) projections
      FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id JOIN whaleu_ratings.scoped_releases r ON r.id=v.release_id
      JOIN whaleu_ratings.catalog_heads old ON old.scope_key=$1 WHERE h.compat_key='region_compat:'||$1`,
            [f.regionId],
          )
        ).rows[0]!;
        assert.equal(final.old_catalog, response.body.catalogRevision);
        assert.equal(final.legacy_catalog_id, response.body.catalogRevision);
        assert.equal(final.cause_kind, 'legacy_bridge');
        assert.equal(final.scopes, 2);
        assert.equal(final.projections, 0);
        for (const campus of [f.campusA, f.campusB])
          assert.equal(
            (
              await f.pool.query(
                `SELECT 1 FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_target_memberships m ON m.catalog_id=h.catalog_id WHERE h.scope_key=$1 AND m.target_id=$2`,
                [`campus:${campus}`, response.body.targetId],
              )
            ).rowCount,
            1,
          );
        regional = {
          id: response.body.targetId as string,
          input,
          command: prepared.command,
          receipt: response.body,
        };
      },
    );
    let rootComment!: { id: string; revision: string };
    let childReply!: { id: string; revision: string };
    await t.test(
      'ordinary old score, content, likes and subscription use original requests with companion proof and no catalog publication',
      async () => {
        const target = (
          await f.pool.query<{ revision: string }>(
            'SELECT revision FROM whaleu_ratings.targets WHERE id=$1',
            [regional.id],
          )
        ).rows[0]!;
        const category = await intent(f.regionId, seeded.local.categoryId);
        const before = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key',
          )
        ).rows;
        const scoreCommand = {
          clientRequestId: randomUUID(),
          regionId: f.regionId,
          expectedTargetRevision: target.revision,
          expectedRevision: null,
          score: 4,
        };
        const score = await f
          .auth(
            request(f.http).put(`/v1/ratings/targets/${regional.id}/my-score`),
            actor,
          )
          .send(scoreCommand);
        assert.equal(score.status, 200, JSON.stringify(score.body));
        assert.equal(score.body.outcome, 'applied', JSON.stringify(score.body));
        assert.deepEqual(
          (
            await f
              .auth(
                request(f.http).put(
                  `/v1/ratings/targets/${regional.id}/my-score`,
                ),
                actor,
              )
              .send(scoreCommand)
          ).body,
          score.body,
        );
        const commentCommand = {
          clientRequestId: randomUUID(),
          regionId: f.regionId,
          expectedTargetRevision: target.revision,
          authorMode: 'named' as const,
          body: 'Original legacy bridge comment',
          assetIds: [],
        };
        const envelope = {
          accountId: actor.accountId,
          clientRequestId: commentCommand.clientRequestId,
          targetId: regional.id,
          targetRevision: target.revision,
          categoryId: seeded.local.categoryId,
          categoryRevision: category.expectedCategoryRevision,
          catalogRevision: category.expectedCatalogRevision,
          scope: { regionId: f.regionId },
          authorMode: 'named',
          body: commentCommand.body,
          assetIds: [],
        };
        await approveRating(
          f.pool,
          canonicalRatingEnvelope({
            ...envelope,
            version: 1,
            purpose: 'publish_rating_comment',
          }),
        );
        const comment = await f
          .auth(
            request(f.http).post(`/v1/ratings/targets/${regional.id}/comments`),
            actor,
          )
          .send(commentCommand);
        assert.equal(comment.status, 200, JSON.stringify(comment.body));
        assert.equal(
          comment.body.outcome,
          'applied',
          JSON.stringify(comment.body),
        );
        rootComment = {
          id: comment.body.subjectId as string,
          revision: comment.body.revision as string,
        };
        const replyCommand = {
          ...commentCommand,
          clientRequestId: randomUUID(),
          targetId: regional.id,
          expectedRootRevision: rootComment.revision,
          replyTo: null,
          body: 'Original legacy bridge reply',
        };
        await approveRating(
          f.pool,
          canonicalRatingEnvelope({
            ...envelope,
            version: 2,
            purpose: 'publish_rating_reply',
            clientRequestId: replyCommand.clientRequestId,
            rootId: rootComment.id,
            rootRevision: rootComment.revision,
            replyTo: null,
            body: replyCommand.body,
          }),
        );
        const reply = await f
          .auth(
            request(f.http).post(
              `/v1/ratings/comments/${rootComment.id}/replies`,
            ),
            actor,
          )
          .send(replyCommand);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(reply.body.outcome, 'applied', JSON.stringify(reply.body));
        childReply = {
          id: reply.body.replyId as string,
          revision: reply.body.revision as string,
        };
        for (const subject of [
          { kind: 'comments', item: rootComment },
          { kind: 'replies', item: childReply },
        ]) {
          const current = await f
            .auth(
              request(f.http).get(
                `/v1/ratings/${subject.kind}/${subject.item.id}/like`,
              ),
              actor,
            )
            .query({ regionId: f.regionId });
          assert.equal(current.status, 200, JSON.stringify(current.body));
          const liked = await f
            .auth(
              request(f.http).put(
                `/v1/ratings/${subject.kind}/${subject.item.id}/like`,
              ),
              actor,
            )
            .send({
              clientRequestId: randomUUID(),
              regionId: f.regionId,
              targetId: regional.id,
              expectedTargetRevision: target.revision,
              expectedRevision: subject.item.revision,
              expectedLikeRevision: current.body.revision,
              liked: true,
              ...(subject.kind === 'replies'
                ? {
                    rootId: rootComment.id,
                    expectedRootRevision: rootComment.revision,
                  }
                : {}),
            });
          assert.equal(liked.status, 200, JSON.stringify(liked.body));
          assert.equal(
            liked.body.outcome,
            'applied',
            JSON.stringify(liked.body),
          );
        }
        const current = await f
          .auth(
            request(f.http).get(
              `/v1/ratings/targets/${regional.id}/subscription`,
            ),
            actor,
          )
          .query({ regionId: f.regionId });
        assert.equal(current.status, 200, JSON.stringify(current.body));
        const subscribed = await f
          .auth(
            request(f.http).put(
              `/v1/ratings/targets/${regional.id}/subscription`,
            ),
            actor,
          )
          .send({
            clientRequestId: randomUUID(),
            regionId: f.regionId,
            expectedTargetRevision: target.revision,
            expectedSubscriptionRevision: current.body.revision,
            subscribed: true,
          });
        assert.equal(subscribed.status, 200, JSON.stringify(subscribed.body));
        assert.equal(
          subscribed.body.outcome,
          'applied',
          JSON.stringify(subscribed.body),
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT count(*)::int n FROM whaleu_ratings.scoped_command_causes e JOIN whaleu_ratings.requests q USING(account_id,request_id) WHERE e.cause_kind='legacy_bridge' AND e.proof->'intent'->>'targetId'=$1 AND q.operation IN ('set_score','create_comment','create_reply','set_comment_like','set_reply_like','set_target_subscription')`,
              [regional.id],
            )
          ).rows[0]!.n,
          6,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key',
            )
          ).rows,
          before,
        );
      },
    );
    await t.test(
      'global M1 affects only independent global, with no inferred campus placements',
      async () => {
        const before = (
          await f.pool.query(
            "SELECT * FROM whaleu_ratings.scoped_catalog_heads WHERE scope_key<>'global' ORDER BY scope_key",
          )
        ).rows;
        const input = await intent(null, seeded.global.categoryId),
          prepared = await prepare(input);
        await approveRating(
          f.pool,
          canonicalRatingEnvelope(prepared.p.envelope),
        );
        const response = await post('targets', prepared.command);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.deepEqual(
          (
            await f.pool.query(
              "SELECT * FROM whaleu_ratings.scoped_catalog_heads WHERE scope_key<>'global' ORDER BY scope_key",
            )
          ).rows,
          before,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT scope_keys FROM whaleu_ratings.target_scope_placements WHERE target_id=$1',
              [response.body.targetId],
            )
          ).rows[0]?.scope_keys,
          ['global'],
        );
      },
    );
    await t.test(
      'deferred wait crossing original Review consume deadline rolls back all tentative old/new heads, sources and epochs',
      async () => {
        const input = await intent(null, seeded.global.categoryId),
          prepared = await prepare(input);
        await approveRating(
          f.pool,
          canonicalRatingEnvelope(prepared.p.envelope),
          { consumeUntil: new Date(Date.now() + 1500) },
        );
        const before = await state();
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(`CREATE FUNCTION whaleu_ratings.synthetic_bridge_deadline_wait() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE deadline timestamptz; BEGIN
        IF NEW.cause_kind='legacy_bridge' AND NEW.cause->>'requestId'='${input.clientRequestId}' THEN
          SELECT min(d.consume_until) INTO deadline FROM whaleu_ratings.target_preparations p JOIN whaleu_community.rating_approval_decisions d ON d.envelope=p.envelope WHERE p.account_id='${actor.accountId}' AND p.request_id='${input.clientRequestId}';
          PERFORM pg_sleep(greatest(extract(epoch FROM deadline-clock_timestamp()),0)+0.05);
        END IF;RETURN NULL;END $$;
        CREATE CONSTRAINT TRIGGER a00_synthetic_bridge_deadline_wait AFTER INSERT ON whaleu_ratings.scoped_releases DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_bridge_deadline_wait()`);
        });
        try {
          const response = await post('targets', prepared.command);
          assert.notEqual(response.status, 200, JSON.stringify(response.body));
          assert.deepEqual(await state(), before);
        } finally {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'DROP TRIGGER a00_synthetic_bridge_deadline_wait ON whaleu_ratings.scoped_releases; DROP FUNCTION whaleu_ratings.synthetic_bridge_deadline_wait()',
            ),
          );
        }
      },
    );
    await t.test(
      'M2 binds original v3 Review and after target without advancing catalogs or self-rejecting epochs',
      async () => {
        const before = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key',
          )
        ).rows;
        const edited = await f.edit(actor, regional.id, {
          name: 'Edited through genuine legacy M2',
        });
        assert.equal(edited.receipt.outcome, 'applied');
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key',
            )
          ).rows,
          before,
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT proof->>'operation' operation FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2 AND cause_kind='legacy_bridge'",
              [actor.accountId, edited.input.clientRequestId],
            )
          ).rows[0]?.operation,
          'edit_target',
        );
      },
    );
    await t.test(
      'M3A global creation advances every old and scoped domain using genuine original v4 category release',
      async () => {
        const created = await f.createCategories(actor, null, {
          nodes: [
            {
              key: 'root',
              parentKey: null,
              name: 'Bridge-native category',
              description: 'Original M3A v4 publication',
            },
          ],
        });
        const cause = (
          await f.pool.query(
            "SELECT artifact_id,proof FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2 AND cause_kind='legacy_bridge'",
            [actor.accountId, created.input.clientRequestId],
          )
        ).rows[0]!;
        assert.equal(cause.proof.domains.length, f.logicalScopeKeys.length);
        const release = (
          await f.pool.query(
            "SELECT id FROM whaleu_ratings.scoped_releases WHERE cause_kind='legacy_bridge' AND cause->>'bridgeId'=$1",
            [cause.artifact_id],
          )
        ).rows[0]!;
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.scoped_release_scopes WHERE release_id=$1',
              [release.id],
            )
          ).rows[0]?.n,
          f.scopeKeys.length,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.compat_projection_manifests WHERE release_id=$1',
              [release.id],
            )
          ).rowCount,
          0,
        );
        for (const output of created.receipt.catalogs)
          assert.equal(
            (
              await f.pool.query(
                'SELECT catalog_id FROM whaleu_ratings.catalog_heads WHERE scope_key=$1',
                [output.regionId ?? 'global'],
              )
            ).rows[0]?.catalog_id,
            output.catalogRevision,
          );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.rating_category_base_bindings WHERE release_id=$1 AND envelope_version=4',
              [created.receipt.releaseId],
            )
          ).rows[0]?.n,
          created.receipt.categories.length,
        );
      },
    );
    await t.test(
      'no-source fresh commands fail closed while replay, original conflicts and cancellation retain old behavior',
      async () => {
        const input = await intent(f.regionId, seeded.local.categoryId),
          pending = await prepare(input);
        await f.atomicChange((tx) => policy(f.regionId, false, tx));
        const before = await state();
        const denied = await post(
          'prepare',
          await intent(f.regionId, seeded.local.categoryId),
        );
        assert.equal(denied.body.error?.code, 'RATING_SCOPE_UNAVAILABLE');
        assert.deepEqual(await state(), before);
        assert.deepEqual(
          (await post('targets', regional.command)).body,
          regional.receipt,
        );
        assert.equal(
          (
            await post('targets', {
              ...regional.command,
              name: 'Changed original bytes',
            })
          ).body.error?.code,
          'REQUEST_CONFLICT',
        );
        const cancelled = await post('cancel', input);
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        assert.equal(cancelled.body.code, 'RATING_CREATION_CANCELLED');
        assert.deepEqual(
          (await post('targets', pending.command)).body,
          cancelled.body,
        );
        const target = (
          await f.pool.query<{ revision: string }>(
            'SELECT revision FROM whaleu_ratings.targets WHERE id=$1',
            [regional.id],
          )
        ).rows[0]!;
        const replyCleanup = {
          clientRequestId: randomUUID(),
          regionId: f.regionId,
          targetId: regional.id,
          rootId: rootComment.id,
          expectedTargetRevision: target.revision,
          expectedRootRevision: rootComment.revision,
          expectedRevision: childReply.revision,
        };
        const deletedReply = await f
          .auth(
            request(f.http).delete(`/v1/ratings/replies/${childReply.id}`),
            actor,
          )
          .send(replyCleanup);
        assert.equal(
          deletedReply.status,
          200,
          JSON.stringify(deletedReply.body),
        );
        const commentCleanup = {
          clientRequestId: randomUUID(),
          regionId: f.regionId,
          targetId: regional.id,
          expectedTargetRevision: target.revision,
          expectedRevision: rootComment.revision,
        };
        const deletedComment = await f
          .auth(
            request(f.http).delete(`/v1/ratings/comments/${rootComment.id}`),
            actor,
          )
          .send(commentCleanup);
        assert.equal(
          deletedComment.status,
          200,
          JSON.stringify(deletedComment.body),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=ANY($2::uuid[])',
              [
                actor.accountId,
                [replyCleanup.clientRequestId, commentCleanup.clientRequestId],
              ],
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      'raw historical bridge forgery and phantom bridge domain roll back without artifacts',
      async () => {
        const before = await state();
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            await tx.query(
              `INSERT INTO whaleu_ratings.scoped_command_causes(account_id,request_id,cause_kind,artifact_id,artifact_revision,proof)
        SELECT account_id,request_id,'legacy_bridge',gen_random_uuid(),gen_random_uuid(),proof FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2`,
              [actor.accountId, regional.input.clientRequestId],
            );
          }),
        );
        assert.deepEqual(await state(), before);
      },
    );
  },
);

test(
  'M3B every fresh old scalar command proves its original selector independently of adoption and target origin',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const actor = f.creator;
    const categoryId = randomUUID();
    const global = await f.catalog(actor, { categoryIds: [categoryId] });
    const target = global.targets[0]!;
    const regional = await f.catalog(actor, {
      regionId: f.regionId,
      categoryIds: [categoryId],
      count: 0,
      sharedTargets: [{ id: target.id, categoryId }],
    });
    const state = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
        'requests',(SELECT jsonb_agg(to_jsonb(q) ORDER BY account_id,request_id) FROM whaleu_ratings.requests q),
        'claims',(SELECT jsonb_agg(to_jsonb(q) ORDER BY account_id,request_id) FROM whaleu_ratings.command_claims q),
        'causes',(SELECT jsonb_agg(to_jsonb(q) ORDER BY account_id,request_id,cause_kind,artifact_id) FROM whaleu_ratings.scoped_command_causes q),
        'scores',(SELECT jsonb_agg(to_jsonb(q) ORDER BY target_id,account_id) FROM whaleu_ratings.scores q),
        'transitions',(SELECT jsonb_agg(to_jsonb(q) ORDER BY account_id,request_id) FROM whaleu_ratings.score_transitions q),
        'oldHeads',(SELECT jsonb_agg(to_jsonb(q) ORDER BY scope_key) FROM whaleu_ratings.catalog_heads q),
        'scopedHeads',(SELECT jsonb_agg(to_jsonb(q) ORDER BY scope_key) FROM whaleu_ratings.scoped_catalog_heads q),
        'sourceEpoch',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton),
        'protocolEpoch',(SELECT epoch FROM whaleu_ratings.scope_protocol_epoch WHERE singleton),
        'navigationEpoch',(SELECT epoch FROM whaleu_ratings.navigation_epoch WHERE singleton),
        'poolEpoch',(SELECT epoch FROM whaleu_ratings.random_pool_epoch WHERE singleton)) state`)
      ).rows[0]!.state;
    const scoreIntent = (
      regionId: string | null,
      revision: string | null,
      score = 2,
    ) => ({
      clientRequestId: randomUUID(),
      targetId: target.id,
      regionId,
      expectedTargetRevision: target.revision,
      expectedRevision: revision,
      score,
    });
    const hash = (operation: string, intent: unknown) => {
      const domain =
        operation === 'create_reply'
          ? 'rating-reply-command'
          : operation.includes('_like')
            ? 'rating-like-command'
            : operation === 'set_target_subscription'
              ? 'rating-subscription-command'
              : 'rating-command';
      return createHash('sha256')
        .update(`whaleu:${domain}:v1\n` + canonicalJson({ operation, intent }))
        .digest('hex');
    };
    const postScore = async (intent: ReturnType<typeof scoreIntent>) => {
      const { targetId, ...body } = intent;
      return f
        .auth(
          request(f.http).put(`/v1/ratings/targets/${targetId}/my-score`),
          actor,
        )
        .send(body);
    };
    const cause = async (requestId: string) =>
      (
        await f.pool.query(
          'SELECT cause_kind,proof FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, requestId],
        )
      ).rows[0]!;
    const rejectedWitness = (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23514';
    const rawScore = async (
      intent: ReturnType<typeof scoreIntent>,
      supplied?: ReturnType<typeof scoreIntent>,
    ) =>
      withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          "INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,'set_score',$3)",
          [actor.accountId, intent.clientRequestId, hash('set_score', intent)],
        );
        if (supplied)
          await tx.query(
            'SELECT whaleu_ratings.begin_legacy_boundary($1,$2,$3::jsonb)',
            [actor.accountId, intent.clientRequestId, canonicalJson(supplied)],
          );
        const revision = randomUUID();
        const row = (
          await tx.query<{ occurred_at: string }>(
            `UPDATE whaleu_ratings.scores SET score=$3,revision=$4,request_id=$5 WHERE target_id=$1 AND account_id=$2 RETURNING ${ratingIso('updated_at')} occurred_at`,
            [
              target.id,
              actor.accountId,
              intent.score,
              revision,
              intent.clientRequestId,
            ],
          )
        ).rows[0]!;
        await tx.query(
          'UPDATE whaleu_ratings.requests SET receipt=$3::jsonb WHERE account_id=$1 AND request_id=$2',
          [
            actor.accountId,
            intent.clientRequestId,
            canonicalJson({
              requestId: intent.clientRequestId,
              operation: 'set_score',
              outcome: 'applied',
              targetId: target.id,
              subjectId: target.id,
              revision,
              occurredAt: row.occurred_at,
            }),
          ],
        );
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
    let scoreRevision: string;
    await t.test(
      'with zero adopted domains, a genuine fresh HTTP score has a typed witness; raw mutation without one rolls back',
      async () => {
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.scope_protocol_heads',
            )
          ).rows[0]!.n,
          0,
        );
        const intent = scoreIntent(null, null, 1);
        const written = await postScore(intent);
        assert.equal(written.status, 200, JSON.stringify(written.body));
        assert.equal(written.body.outcome, 'applied');
        scoreRevision = written.body.revision as string;
        const observed = await cause(intent.clientRequestId);
        assert.equal(observed.cause_kind, 'legacy_boundary');
        assert.deepEqual(observed.proof.intent, intent);
        assert.equal(observed.proof.intentHash, hash('set_score', intent));
        assert.equal(observed.proof.boundary.selectedScopeKey, 'global');
        assert.ok(
          observed.proof.boundary.protocolTuples.every(
            (p: { phase: string }) => p.phase === 'legacy_only',
          ),
        );
        const before = await state();
        await assert.rejects(
          rawScore(scoreIntent(null, scoreRevision)),
          rejectedWitness,
        );
        assert.deepEqual(await state(), before);
        assert.deepEqual(
          (await postScore(intent)).body,
          written.body,
          'Historical replay adds no new witness',
        );
        assert.deepEqual(await state(), before);
      },
    );
    await t.test(
      'canonical original intent rejects missing, extra and coerced values even when the original hash is recomputed',
      async () => {
        const common = {
          clientRequestId: randomUUID(),
          targetId: target.id,
          regionId: null,
          expectedTargetRevision: target.revision,
        };
        const like = {
          ...common,
          rootId: randomUUID(),
          expectedRevision: randomUUID(),
          expectedLikeRevision: randomUUID(),
          liked: true,
        };
        const reply = {
          ...common,
          rootId: randomUUID(),
          expectedRootRevision: randomUUID(),
          replyTo: null,
          authorMode: 'named',
          body: 'Canonical body',
          assetIds: [],
        };
        const missing = {
          ...scoreIntent(null, scoreRevision!),
          score: undefined,
        };
        const attacks: { operation: string; intent: object }[] = [
          { operation: 'set_score', intent: missing },
          {
            operation: 'set_score',
            intent: { ...scoreIntent(null, scoreRevision!), extra: true },
          },
          {
            operation: 'set_score',
            intent: { ...scoreIntent(null, scoreRevision!), score: '4' },
          },
          {
            operation: 'set_score',
            intent: { ...scoreIntent(null, scoreRevision!), score: 1.5 },
          },
          {
            operation: 'set_score',
            intent: { ...scoreIntent(null, scoreRevision!), regionId: false },
          },
          {
            operation: 'set_score',
            intent: {
              ...scoreIntent(null, scoreRevision!),
              targetId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
            },
          },
          { operation: 'set_comment_like', intent: { ...like, liked: 'true' } },
          {
            operation: 'set_reply_like',
            intent: {
              ...like,
              replyId: randomUUID(),
              expectedRootRevision: randomUUID(),
              liked: 1,
            },
          },
          {
            operation: 'set_target_subscription',
            intent: {
              ...common,
              expectedSubscriptionRevision: randomUUID(),
              subscribed: 'false',
            },
          },
          {
            operation: 'create_comment',
            intent: {
              ...common,
              authorMode: 'staff',
              body: 'Text',
              assetIds: [],
            },
          },
          {
            operation: 'create_comment',
            intent: {
              ...common,
              authorMode: 'named',
              body: ' Text ',
              assetIds: [],
            },
          },
          {
            operation: 'create_comment',
            intent: {
              ...common,
              authorMode: 'named',
              body: 'Text',
              assetIds: [randomUUID()],
            },
          },
          {
            operation: 'create_reply',
            intent: {
              ...reply,
              replyTo: {
                replyId: randomUUID(),
                expectedRevision: randomUUID(),
                extra: true,
              },
            },
          },
          {
            operation: 'create_reply',
            intent: { ...reply, replyTo: { replyId: randomUUID() } },
          },
        ];
        for (const attack of attacks) {
          const intent = JSON.parse(
            JSON.stringify({ ...attack.intent, clientRequestId: randomUUID() }),
          ) as { clientRequestId: string };
          const before = await state();
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await tx.query(
                'INSERT INTO whaleu_ratings.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
                [
                  actor.accountId,
                  intent.clientRequestId,
                  attack.operation,
                  hash(attack.operation, intent),
                ],
              );
              await tx.query(
                'SELECT whaleu_ratings.begin_legacy_scoped_bridge($1,$2,$3::jsonb)',
                [
                  actor.accountId,
                  intent.clientRequestId,
                  canonicalJson(intent),
                ],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            }),
            rejectedWitness,
            canonicalJson({ operation: attack.operation, intent }),
          );
          assert.deepEqual(await state(), before);
        }
      },
    );
    const scopeKeys = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
    const adoption = await prepareSyntheticOpaqueAdoption(
      f,
      regional.catalogId,
      categoryId,
      scopeKeys,
    );
    await f.declareAll();
    for (const key of scopeKeys)
      await f.declareScope(key, {
        categoryIds: [categoryId],
        targetIds: [target.id],
        legacyCatalogIds: [regional.catalogId],
      });
    await f.capability();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await writeSyntheticOpaqueAdoption(tx, adoption);
      await f.publish(
        {
          activate: true,
          domain: { kind: 'region_compat', regionId: f.regionId },
        },
        tx,
      );
    });
    await t.test(
      'a global-origin target selected globally remains writable without a source after its regional domain is adopted',
      async () => {
        assert.equal(
          (
            await f.pool.query(
              'SELECT region_id FROM whaleu_ratings.targets WHERE id=$1',
              [target.id],
            )
          ).rows[0]!.region_id,
          null,
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int n FROM whaleu_ratings.scoped_source_heads WHERE source_kind='native_v1_compat_write'",
            )
          ).rows[0]!.n,
          0,
        );
        const intent = scoreIntent(null, scoreRevision!, 2);
        const written = await postScore(intent);
        assert.equal(written.status, 200, JSON.stringify(written.body));
        assert.equal(written.body.outcome, 'applied');
        scoreRevision = written.body.revision as string;
        const observed = await cause(intent.clientRequestId);
        assert.equal(observed.cause_kind, 'legacy_boundary');
        assert.equal(observed.proof.boundary.selectedScopeKey, 'global');
        assert.ok(
          observed.proof.boundary.protocolTuples.some(
            (p: { logicalScopeKey: string; phase: string }) =>
              p.logicalScopeKey === f.regionId && p.phase === 'adopted',
          ),
        );
        assert.ok(
          observed.proof.boundary.protocolTuples.some(
            (p: { logicalScopeKey: string; phase: string }) =>
              p.logicalScopeKey === 'global' && p.phase === 'legacy_only',
          ),
        );
      },
    );
    await t.test(
      'the same global-origin target selected regionally requires a real bridge; origin and a same-key substituted selector cannot authorize it',
      async () => {
        const intent = scoreIntent(f.regionId, scoreRevision!, 3);
        const before = await state();
        const denied = await postScore(intent);
        assert.equal(denied.body.error?.code, 'RATING_SCOPE_UNAVAILABLE');
        assert.deepEqual(await state(), before);
        await assert.rejects(rawScore(intent), rejectedWitness);
        assert.deepEqual(await state(), before);
        await assert.rejects(
          rawScore(intent, { ...intent, regionId: null }),
          rejectedWitness,
        );
        assert.deepEqual(await state(), before);
        await assert.rejects(rawScore(intent, intent), rejectedWitness);
        assert.deepEqual(await state(), before);
        await f.atomicChange(
          (tx) =>
            f.issueSource(
              {
                kind: 'native_v1_compat_write',
                key: f.regionId,
                scopeKeys,
                payload: {
                  policyVersion: 'native-v1-compat-write-v1',
                  enabled: true,
                  logicalScopeKey: f.regionId,
                  scopeKeys,
                  operations: ['set_score'],
                  placementPolicy: 'exact_legacy_domain',
                  categoryPolicy: 'append_native_only',
                },
              },
              tx,
            ),
          { domain: { kind: 'region_compat', regionId: f.regionId } },
        );
        const written = await postScore(intent);
        assert.equal(written.status, 200, JSON.stringify(written.body));
        assert.equal(written.body.outcome, 'applied');
        const observed = await cause(intent.clientRequestId);
        assert.equal(observed.cause_kind, 'legacy_bridge');
        assert.deepEqual(observed.proof.intent, intent);
        assert.equal(observed.proof.domains[0].logicalScopeKey, f.regionId);
        assert.equal(observed.proof.domains.length, 1);
      },
    );
  },
);
