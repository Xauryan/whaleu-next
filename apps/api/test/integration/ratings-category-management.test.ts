import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingCategoryFixture,
  ratingFixtureUuid,
  ratingCategoryPrefix as prefix,
} from '../support/rating-category-fixture.js';
import {
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { ratingCategoryReceiptSchema } from '../../src/ratings/category-management/contracts.js';

test(
  'M3A explicit management, full native release and ordinary M1/M2 history-preserving chain',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      developer = await f.actor(),
      school = await f.actor(),
      ordinary = await f.actor(),
      other = await f.actor();
    const adminGrant = await f.grant(admin, 'super_admin');
    await f.grant(developer, 'developer');
    await f.grant(school, 'school_admin', f.scope.home.regionId);
    const post = (route: string, body: object, actor = admin) =>
      f.auth(request(f.http).post(`${prefix}/${route}`), actor).send(body);
    const get = (route: string, actor = admin) =>
      f.auth(request(f.http).get(`${prefix}/${route}`), actor);
    const noTerminal = async (key: string, actor = admin) =>
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, key],
          )
        ).rowCount,
        0,
      );
    await t.test(
      'only explicit current grants authorize exact complete native campus sets',
      async () => {
        assert.equal(
          (await get('context', ordinary)).body.error.code,
          'RATING_NOT_FOUND',
        );
        assert.equal(
          (await get('context', school)).body.error.code,
          'RATING_NOT_FOUND',
        );
        assert.equal(
          (
            await get('context', school).query({
              regionId: f.scope.foreign.regionId,
            })
          ).body.error.code,
          'RATING_NOT_FOUND',
        );
        const local = await f.categoryContext(school, f.scope.home.regionId);
        assert.deepEqual(local.campusIds, [f.scope.home.campusId]);
        assert.equal(local.catalogRevision, null);
        const global = await f.categoryContext(developer);
        assert.deepEqual(
          global.campusIds,
          [
            f.scope.home.campusId,
            f.scope.related.campusId,
            f.scope.foreign.campusId,
          ].sort(),
        );
        const response = await get('context');
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.match(response.headers['vary'] ?? '', /Authorization/i);
        assert.equal(
          (await get('context').query({ campusId: f.scope.home.campusId }))
            .status,
          400,
        );
        const input = f.categoryIntent(response.body);
        for (const extra of [
          { role: 'super_admin' },
          { isSystem: true },
          { kind: 'course' },
          { campusIds: [] },
          { accepted: true },
          { sourceReference: 'claim' },
          { reviewDecisionId: randomUUID() },
        ]) {
          const body = { ...input, clientRequestId: randomUUID(), ...extra };
          assert.equal((await post('prepare', body)).status, 400);
          await noTerminal(body.clientRequestId);
        }
      },
    );
    let release: Awaited<ReturnType<typeof f.createCategories>>;
    await t.test(
      'exact reviewed three-level tree releases global and every mapped region atomically',
      async () => {
        const before = await f.categoryContext(admin),
          input = f.categoryIntent(before, {
            nodes: [
              {
                key: 'root',
                parentKey: null,
                name: 'Global native root',
                description: '',
              },
              {
                key: 'child',
                parentKey: 'root',
                name: 'Global native child',
                description: 'Child description',
              },
              {
                key: 'leaf',
                parentKey: 'child',
                name: 'Global native leaf',
                description: 'Leaf description',
              },
            ],
          });
        const prepared = await f.prepareCategories(admin, input);
        assert.deepEqual((await post('prepare', input)).body, prepared);
        assert.equal(
          (
            await post('prepare', {
              ...input,
              nodes: [
                { ...input.nodes[0]!, name: 'Different intent' },
                ...input.nodes.slice(1),
              ],
            })
          ).body.error.code,
          'REQUEST_CONFLICT',
        );
        const unknown = await f.commitCategories(
          admin,
          input,
          prepared.contextRevision,
        );
        assert.equal(unknown.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
        await noTerminal(input.clientRequestId);
        const reviewed = await f.approveCategories(admin, input);
        const [first, replay] = await Promise.all([
          f.commitCategories(admin, input, prepared.contextRevision),
          f.commitCategories(admin, input, prepared.contextRevision),
        ]);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.deepEqual(replay.body, first.body);
        const receipt = ratingCategoryReceiptSchema.parse(first.body);
        if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
        release = { before, input, prepared, reviewed, receipt };
        assert.equal(receipt.catalogs.length, 4);
        assert.equal(receipt.categories.length, 3);
        for (const published of receipt.catalogs) {
          const rows = (
            await f.pool.query(
              'SELECT id,revision,parent_id,level,name,description FROM whaleu_ratings.categories WHERE catalog_id=$1 ORDER BY level',
              [published.catalogRevision],
            )
          ).rows;
          assert.equal(rows.length, 3);
          assert.deepEqual(
            rows.map((row) => row.id),
            receipt.categories.map((row) => row.id),
          );
          let response = f.auth(
            request(f.http).get('/v1/ratings/categories'),
            ordinary,
          );
          if (published.regionId)
            response = response.query({ regionId: published.regionId });
          // Ordinary affiliation authorizes global/home/related, not unrelated region.
          const result = await response;
          if (published.regionId === f.scope.foreign.regionId)
            assert.equal(result.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
          else {
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(result.body.items[0].id, receipt.categories[0]!.id);
          }
        }
        assert.equal(
          (await get(`requests/${input.clientRequestId}`, other)).status,
          404,
        );
        assert.deepEqual(
          (await get(`requests/${input.clientRequestId}`)).body,
          receipt,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer n FROM whaleu_community.rating_category_base_bindings WHERE decision_id=$1',
              [reviewed.decisionId],
            )
          ).rows[0].n,
          3,
        );
      },
    );
    await t.test(
      'ordinary target creation copies every lineage and retains scores/comments through owner edit and hidden cleanup',
      async () => {
        const leaf = release.receipt.categories[2]!,
          global = release.receipt.catalogs.find(
            (row) => row.regionId === null,
          )!;
        const policy = randomUUID();
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            "INSERT INTO whaleu_ratings.native_create_policies(id,region_id,generic_kind,source_reference,policy_reference,issuer,revision,enabled,coverage,provenance,effective_at,valid_until) VALUES($1,NULL,'general','synthetic-category-target-source','synthetic-category-target-policy','synthetic-category-test',1,true,'complete','accepted',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')",
            [policy],
          );
          await tx.query(
            "INSERT INTO whaleu_ratings.native_create_policy_heads VALUES('global','general',$1)",
            [policy],
          );
        });
        const targetIntent = {
          clientRequestId: randomUUID(),
          regionId: null,
          categoryId: leaf.id,
          expectedCategoryRevision: leaf.revision,
          expectedCatalogRevision: global.catalogRevision,
          name: 'Ordinary target under managed category',
          description: 'Exact native body',
          assetIds: [],
        };
        const prepared = await f
          .auth(
            request(f.http).post('/v1/ratings/management/prepare'),
            ordinary,
          )
          .send(targetIntent);
        assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
        const p = (
          await f.pool.query<{ envelope: unknown }>(
            'SELECT envelope FROM whaleu_ratings.target_preparations WHERE account_id=$1 AND request_id=$2',
            [ordinary.accountId, targetIntent.clientRequestId],
          )
        ).rows[0]!;
        const approval = await approveRating(
          f.pool,
          canonicalRatingEnvelope(p.envelope),
        );
        const created = await f
          .auth(
            request(f.http).post('/v1/ratings/management/targets'),
            ordinary,
          )
          .send({
            ...targetIntent,
            expectedContextRevision: prepared.body.contextRevision,
          });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        assert.equal(created.body.outcome, 'applied');
        const target = {
          id: ratingFixtureUuid(created.body.targetId),
          revision: ratingFixtureUuid(created.body.revision),
          approval,
        };
        const lineage = async (id: string) =>
          (
            await f.pool.query(
              "SELECT to_jsonb(l)-'catalog_id' value FROM whaleu_ratings.catalog_category_lineage l WHERE catalog_id=$1 ORDER BY category_id",
              [id],
            )
          ).rows;
        assert.deepEqual(
          await lineage(created.body.catalogRevision),
          await lineage(global.catalogRevision),
        );
        const c = {
          catalogId: ratingFixtureUuid(created.body.catalogRevision),
          categoryId: leaf.id,
          categoryRevision: ratingFixtureUuid(leaf.revision),
          rootId: release.receipt.categories[0]!.id,
          categoryIds: release.receipt.categories.map((row) => row.id),
          categoryRevisions: release.receipt.categories.map((row) =>
            ratingFixtureUuid(row.revision),
          ),
          regionId: null,
          targets: [target],
        };
        const score = await f
          .auth(
            request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
            ordinary,
          )
          .send({
            clientRequestId: randomUUID(),
            regionId: null,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: 5,
          });
        assert.equal(score.status, 200, JSON.stringify(score.body));
        const comment = await f.publish(ordinary, c, target);
        const navigationEpoch = async () =>
          (
            await f.pool.query<{ epoch: string }>(
              'SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1',
            )
          ).rows[0]!.epoch;
        const beforeEditEpoch = await navigationEpoch();
        const observer = observeDirectoryQueries(f.app);
        t.after(() => observer.restore());
        let deferredFlushed = false;
        const finalStates: {
          contentVersion: number;
          compatible: boolean;
          ancestry: boolean;
        }[] = [];
        observer.setHook(async ({ sql }, tx) => {
          if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') deferredFlushed = true;
          if (
            sql.includes(
              'JOIN whaleu_ratings.target_definition_lifecycles l',
            ) &&
            sql.includes('pe.epoch=$11::bigint')
          ) {
            assert.ok(
              deferredFlushed,
              'Owner edit final proof follows the real deferred flush',
            );
            assert.ok(sql.includes('category_catalog_compat_current(c.id)'));
            assert.ok(
              sql.includes('category_ancestry_current(c.id,t.category_id)'),
            );
            const row = (
              await tx.query<{
                contentVersion: number;
                compatible: boolean;
                ancestry: boolean;
              }>(
                `SELECT h.content_version "contentVersion",whaleu_ratings.category_catalog_compat_current(c.catalog_id) compatible,
               whaleu_ratings.category_ancestry_current(c.catalog_id,t.category_id) ancestry
               FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
               JOIN whaleu_ratings.catalog_heads c ON c.scope_key=coalesce(t.region_id::text,'global') WHERE t.id=$1`,
                [target.id],
              )
            ).rows[0];
            assert.ok(row);
            finalStates.push(row);
          }
        });
        const edited = await f.edit(ordinary, target.id, {
          name: 'Current edited target definition',
          description: 'Exact second version',
        });
        observer.restore();
        assert.deepEqual(finalStates.at(-1), {
          contentVersion: 2,
          compatible: true,
          ancestry: true,
        });
        assert.ok(
          finalStates.some((row) => row.contentVersion === 1),
          'Prepare retains the original current tuple',
        );
        assert.ok(
          BigInt(await navigationEpoch()) > BigInt(beforeEditEpoch),
          'The writer really advances its own navigation epoch; only the after-state may be retained',
        );
        assert.equal(edited.receipt.contentVersion, 2);
        const retained = async () => ({
          scores: (
            await f.pool.query(
              'SELECT to_jsonb(s) value FROM whaleu_ratings.scores s WHERE target_id=$1',
              [target.id],
            )
          ).rows,
          comments: (
            await f.pool.query(
              'SELECT to_jsonb(c) value FROM whaleu_ratings.comments c WHERE id=$1',
              [comment.id],
            )
          ).rows,
        });
        const before = await retained();
        await setRatingReviewState(
          f.pool,
          release.reviewed.decisionId,
          'revoked',
        );
        const hidden = await f.auth(
          request(f.http).get(`/v1/ratings/targets/${target.id}`),
          ordinary,
        );
        assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
        const cleanup = await f
          .auth(
            request(f.http).post(
              `/v1/ratings/management/owner-deletion/targets/${target.id}`,
            ),
            ordinary,
          )
          .send({
            clientRequestId: randomUUID(),
            expectedTargetRevision: edited.receipt.revision,
          });
        assert.equal(cleanup.status, 200, JSON.stringify(cleanup.body));
        assert.equal(cleanup.body.outcome, 'applied');
        assert.deepEqual(await retained(), before);
        assert.deepEqual(
          (await get(`requests/${release.input.clientRequestId}`)).body,
          release.receipt,
        );
        await setRatingReviewState(
          f.pool,
          release.reviewed.decisionId,
          'allow',
        );
      },
    );
    await t.test(
      'CAS before publication, exact rejection, independent cancel and shared old namespace',
      async () => {
        const before = await f.categoryContext(admin),
          stale = f.categoryIntent(before),
          prepared = await f.prepareCategories(admin, stale);
        await f.approveCategories(admin, stale);
        const winner = await f.createCategories(developer, null, {
          nodes: [
            {
              key: 'root',
              parentKey: null,
              name: 'Next native root',
              description: '',
            },
          ],
        });
        assert.equal(winner.receipt.outcome, 'applied');
        const changed = await f.commitCategories(
          admin,
          stale,
          prepared.contextRevision,
        );
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        assert.equal(changed.body.code, 'RATING_CATEGORY_CONTEXT_CHANGED');
        const current = await f.categoryContext(admin),
          cancelled = f.categoryIntent(current),
          pending = await f.prepareCategories(admin, cancelled);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
            [adminGrant, admin.accountId],
          ),
        );
        const cancel = await post('cancel', cancelled);
        assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
        assert.equal(cancel.body.code, 'RATING_CATEGORY_CANCELLED');
        assert.deepEqual(
          (await f.commitCategories(admin, cancelled, pending.contextRevision))
            .body,
          cancel.body,
        );
        assert.deepEqual(
          (await get(`requests/${cancelled.clientRequestId}`)).body,
          cancel.body,
        );
        const namespace = await f
          .auth(request(f.http).post('/v1/ratings/management/cancel'), admin)
          .send({
            clientRequestId: cancelled.clientRequestId,
            regionId: null,
            categoryId: release.receipt.categories[0]!.id,
            expectedCategoryRevision: release.receipt.categories[0]!.revision,
            expectedCatalogRevision: current.catalogRevision,
            name: 'Conflict',
            description: '',
            assetIds: [],
          });
        assert.equal(namespace.body.error.code, 'REQUEST_CONFLICT');
        assert.equal(
          (await get('context')).body.error.code,
          'RATING_NOT_FOUND',
        );
        assert.deepEqual(
          (await get(`requests/${release.input.clientRequestId}`)).body,
          release.receipt,
        );
      },
    );
  },
);
