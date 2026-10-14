import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { approveEnvelope } from '../support/community-approval-fixtures.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { inTransaction } from '../../src/database/database.js';
import { DatabaseService } from '../../src/database/database.js';
import { ContentReviewCountFacade } from '../../src/community/content-review/count-snapshot.facade.js';
import {
  canonicalJson,
  canonicalEnvelope,
} from '../../src/community/content-review/contracts.js';
import { CurrentRatingLinkDependency } from '../../src/community/rating-target-link/dependency.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { requirePublication } from '../../src/community/community-policy.js';

/** Real HTTP + actual bounded local issuer + deferred PostgreSQL; no mocked
 * card decisions. Execution requires the disposable integration database. */
test(
  'rating cards preserve original Review/receipt/descendants across accepted same-identity successors and close all readers on deny/unknown',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingTargetLinkFixture();
    t.after(() => f.close());
    const course = await f.createLinkCategory('course', true),
      target = await f.createLinkTarget(course);
    const reader = await f.actor();
    const get = (path: string, actor = reader) =>
      f.auth(request(f.http).get(path), actor);
    const readPost = (id: string) => get(`/v1/community/posts/${id}`);
    const count = async (id: string) =>
      f.app
        .get(DatabaseService)
        .transaction(async (tx) =>
          (
            await f.app
              .get(ContentReviewCountFacade)
              .evaluatePosts([id], reader.accountId, tx)
          ).facts.get(id),
        );
    let postId = '',
      commentId = '',
      replyId = '';
    const body = await f.card(target.id);
    await t.test(
      'ordinary pending NULL, rejected and same-transaction created receipts remain compatible with the new deferred trigger',
      async () => {
        const ordinary = {
          clientRequestId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          category: 'discussion' as const,
          text: 'Ordinary receipt lifecycle regression',
          imageAssetIds: [],
          authorMode: 'named' as const,
          commentsPolicy: 'open' as const,
        };
        const queued = await f.linkCall(
          f.creator,
          '/v1/community/reviews/posts',
          ordinary,
        );
        assert.equal(queued.status, 200, JSON.stringify(queued.body));
        assert.equal(queued.body.status, 'pending');
        const pending = await f.pool.query(
          'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
          [f.creator.accountId, ordinary.clientRequestId],
        );
        assert.equal(pending.rows[0].receipt, null);
        const reviewed = await f.pool.query(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [f.creator.accountId, ordinary.clientRequestId],
        );
        await inTransaction(f.pool, (tx) =>
          f.operator.run(
            {
              command: 'decide',
              accountId: f.creator.accountId,
              requestId: ordinary.clientRequestId,
              digest: reviewed.rows[0].digest,
              decision: 'reject',
              basis: 'Explicit ordinary rejection regression',
            },
            tx,
          ),
        );
        const rejected = await f.linkCall(
          f.creator,
          '/v1/community/posts',
          ordinary,
        );
        assert.equal(
          rejected.body.outcome,
          'rejected',
          JSON.stringify(rejected.body),
        );
        assert.deepEqual(
          (await f.linkCall(f.creator, '/v1/community/posts', ordinary)).body,
          rejected.body,
        );
        const fresh = {
          ...ordinary,
          clientRequestId: randomUUID(),
          text: 'Ordinary preapproved exact content',
        };
        // Existing canonical approval fixture issues the old envelope through its
        // established owner path. The HTTP command then INSERTs its absent claim
        // and UPDATEs the created receipt in one actual publication transaction.
        await approveEnvelope(
          f.pool,
          await postApprovalEnvelope(
            f.app,
            f.pool,
            f.creator.accountId,
            publishPostSchema.parse(fresh),
          ),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
              [f.creator.accountId, fresh.clientRequestId],
            )
          ).rowCount,
          0,
        );
        const created = await f.linkCall(
          f.creator,
          '/v1/community/posts',
          fresh,
        );
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.outcome, 'created');
        assert.deepEqual(
          (await f.linkCall(f.creator, '/v1/community/posts', fresh)).body,
          created.body,
        );
      },
    );
    await t.test(
      'explicit current/root registry qualifies the full three-level path and real native capability',
      async () => {
        const reference = await f.linkReference(target.id);
        assert.equal(reference.systemKey, 'course');
        const capabilities = await get(
          '/v1/community/capabilities',
          f.creator,
        ).query({ spaceId: f.scope.home.spaceId, category: 'discussion' });
        assert.equal(
          capabilities.status,
          200,
          JSON.stringify(capabilities.body),
        );
        assert.equal(
          capabilities.body.ratingTargetLink.availability,
          'allowed',
        );
        assert.deepEqual(capabilities.body.ratingTargetLink.authorModes, [
          'named',
          'anonymous',
        ]);
        // Assert each real SQL owner predicate before the trigger combines them.
        // This catches a swallowed PL/pgSQL ambiguity as a shape failure rather
        // than letting a generic admission error hide a broken positive path.
        await f.app.get(DatabaseService).transaction(async (tx) => {
          const space = await f.app
            .get(CommunityRepository)
            .space(body.spaceId, tx);
          const authority = await f.app
            .get(CommunityAccessService)
            .authority(f.creator.accountId, space, tx, { publication: true });
          requirePublication(
            authority,
            space,
            'discussion',
            body.authorMode,
            'publish_post',
          );
          const bound = await f.app
            .get(CurrentRatingLinkDependency)
            .publication(
              f.creator.accountId,
              body.component,
              {
                spaceId: body.spaceId,
                category: 'discussion',
                authorMode: body.authorMode,
              },
              tx,
            );
          const envelope = canonicalEnvelope({
            version: 5,
            accountId: f.creator.accountId,
            purpose: 'publish_post',
            spaceId: body.spaceId,
            category: 'discussion',
            authorMode: body.authorMode,
            commentsPolicy: 'open',
            postId: null,
            rootCommentId: null,
            targetReplyId: null,
            text: body.text,
            images: [],
            component: {
              kind: 'rating_target_link',
              targetId: body.component.targetId,
              label: body.component.label,
              binding: bound.binding,
            },
            trading: null,
            scope: authority.publicationScope,
          });
          const predicates = (
            await tx.query(
              `SELECT whaleu_community.rating_target_link_binding_shape($1::jsonb->'component'->'binding') binding_shape,
            whaleu_community.rating_target_link_envelope_valid($1::jsonb) envelope_shape,
            whaleu_ratings.community_link_binding_current($1::jsonb->'component'->'binding',true) target_current,
            whaleu_community.rating_target_link_destination_current(($1::jsonb->>'accountId')::uuid,$1::jsonb->'scope',$1::jsonb->>'authorMode') destination_current,
            whaleu_community.rating_target_link_admitted($1::jsonb) admitted`,
              [canonicalJson(envelope)],
            )
          ).rows[0];
          assert.deepEqual(predicates, {
            binding_shape: true,
            envelope_shape: true,
            target_current: true,
            destination_current: true,
            admitted: true,
          });
        });
        const queued = await f.linkCall(
          f.creator,
          '/v1/community/reviews/posts',
          body,
        );
        assert.equal(queued.status, 200, JSON.stringify(queued.body));
        assert.equal(queued.body.status, 'pending');
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.post_rating_target_links',
            )
          ).rows[0].n,
          0,
        );
        const binding = (
          await f.pool.query(
            'SELECT envelope FROM whaleu_community.text_review_requests WHERE client_request_id=$1',
            [body.clientRequestId],
          )
        ).rows[0].envelope;
        assert.equal(binding.version, 5);
        assert.equal(binding.component.binding.ancestry.length, 3);
        const unapproved = await f.linkCall(
          f.creator,
          '/v1/community/posts',
          body,
        );
        assert.notEqual(unapproved.status, 201);
        const conflict = await f.linkCall(
          f.creator,
          '/v1/community/reviews/posts',
          { ...body, component: { ...body.component, label: '手动改动' } },
        );
        assert.equal(conflict.status, 409);
        await f.approveLinkCommunity(f.creator, body.clientRequestId);
        const result = await f.linkCall(f.creator, '/v1/community/posts', body);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        postId = result.body.resourceId;
        assert.deepEqual(
          (await f.linkCall(f.creator, '/v1/community/posts', body)).body,
          result.body,
        );
        const detail = await readPost(postId);
        assert.equal(detail.status, 200, JSON.stringify(detail.body));
        assert.equal(detail.body.component.kind, 'rating_target_link');
        assert.equal(detail.body.component.target.name, 'Original course');
        assert.equal(detail.body.text, body.text);
        assert.equal((await count(postId))?.decision, 'allow');
      },
    );
    await t.test(
      'actual local Review creates ordinary comments/replies under the original card',
      async () => {
        const publish = async (
          review: string,
          destination: string,
          reply = false,
        ) => {
          const input = {
            clientRequestId: randomUUID(),
            text: 'Persisted descendant wording',
            authorMode: 'named',
            imageAssetIds: [],
            ...(reply ? { targetReplyId: null } : {}),
          };
          const queued = await f.linkCall(reader, review, input);
          assert.equal(queued.status, 200, JSON.stringify(queued.body));
          await f.approveLinkCommunity(reader, input.clientRequestId);
          const result = await f.linkCall(reader, destination, input);
          assert.equal(result.status, 201, JSON.stringify(result.body));
          return String(result.body.resourceId);
        };
        commentId = await publish(
          `/v1/community/reviews/posts/${postId}/comments`,
          `/v1/community/posts/${postId}/comments`,
        );
        replyId = await publish(
          `/v1/community/reviews/comments/${commentId}/replies`,
          `/v1/community/comments/${commentId}/replies`,
          true,
        );
        assert.equal(
          (await get(`/v1/community/posts/${postId}/comments`)).status,
          200,
        );
      },
    );
    const snapshot = async () =>
      canonicalJson(
        (
          await f.pool.query(
            `SELECT jsonb_build_object('post',to_jsonb(p),'link',to_jsonb(l),'binding',to_jsonb(b),'receipt',q.receipt,'comments',(SELECT jsonb_agg(to_jsonb(c)) FROM whaleu_community.root_comments c WHERE c.post_id=p.id),'replies',(SELECT jsonb_agg(to_jsonb(r)) FROM whaleu_community.replies r WHERE r.post_id=p.id)) value FROM whaleu_community.posts p JOIN whaleu_community.post_rating_target_links l ON l.post_id=p.id JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(l.account_id,l.client_request_id) WHERE p.id=$1`,
            [postId],
          )
        ).rows[0].value,
      );
    let successor: Awaited<ReturnType<typeof f.editLinkTarget>>;
    await t.test(
      'same immutable target identity follows accepted name/description successor without rewriting published bytes',
      async () => {
        const before = await snapshot(),
          generation = (
            await f.pool.query(
              'SELECT generation FROM whaleu_community.rating_target_link_generation WHERE singleton',
            )
          ).rows[0].generation;
        successor = await f.editLinkTarget(
          target.id,
          'Accepted renamed course',
        );
        assert.equal(successor.id, target.id);
        assert.notEqual(successor.revision, target.revision);
        assert.equal(await snapshot(), before);
        assert.notEqual(
          (
            await f.pool.query(
              'SELECT generation FROM whaleu_community.rating_target_link_generation WHERE singleton',
            )
          ).rows[0].generation,
          generation,
        );
        const detail = await readPost(postId);
        assert.equal(detail.status, 200, JSON.stringify(detail.body));
        assert.equal(detail.body.text, body.text);
        assert.equal(detail.body.component.label, body.component.label);
        assert.equal(
          detail.body.component.target.name,
          'Accepted renamed course',
        );
        assert.equal((await count(postId))?.decision, 'allow');
        const comments = await get(`/v1/community/posts/${postId}/comments`);
        assert.equal(comments.status, 200);
        assert.match(JSON.stringify(comments.body), new RegExp(commentId));
        const replies = await get(
          `/v1/community/comments/${commentId}/replies`,
        );
        assert.equal(replies.status, 200);
        assert.match(JSON.stringify(replies.body), new RegExp(replyId));
        const stale = await f.linkCall(
          f.creator,
          '/v1/community/reviews/posts',
          { ...body, clientRequestId: randomUUID() },
        );
        assert.notEqual(stale.status, 200);
        const replay = await f.linkCall(f.creator, '/v1/community/posts', body);
        assert.equal(replay.body.resourceId, postId);
      },
    );
    await t.test(
      'SQL shape is total, immutable card identity and late component additions cannot bypass causal Review',
      async () => {
        const envelope = (
          await f.pool.query(
            "SELECT envelope FROM whaleu_community.content_approval_bindings WHERE content_kind='post' AND content_id=$1",
            [postId],
          )
        ).rows[0].envelope;
        for (const field of [
          'authorMode',
          'commentsPolicy',
          'category',
          'purpose',
          'text',
        ]) {
          const malformed = { ...envelope, [field]: null };
          const checked = await f.pool.query(
            'SELECT whaleu_community.rating_target_link_envelope_valid($1::jsonb) valid',
            [canonicalJson(malformed)],
          );
          assert.equal(checked.rows[0].valid, false, field);
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_community.rating_target_link_destination_current($1,$2::jsonb,NULL) valid',
              [f.creator.accountId, canonicalJson(envelope.scope)],
            )
          ).rows[0].valid,
          false,
        );
        for (const label of ['a\u2028b', 'a\u2029b']) {
          const malformed = {
            ...envelope,
            component: { ...envelope.component, label },
          };
          const checked = await f.pool.query(
            'SELECT whaleu_community.rating_target_link_envelope_valid($1::jsonb) valid',
            [canonicalJson(malformed)],
          );
          assert.equal(
            checked.rows[0].valid,
            false,
            'Single-line native label parity',
          );
        }
        const before = await snapshot();
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.post_rating_target_links SET component=jsonb_set(component,'{label}','\"forged\"') WHERE post_id=$1",
              [postId],
            ),
          ),
        );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_community.polls(id,post_id,question,selection_mode) VALUES(gen_random_uuid(),$1,'forged','single')",
              [postId],
            ),
          ),
        );
        assert.equal(await snapshot(), before);
      },
    );
    await t.test(
      'authoritative target denial removes body, label, reply paths, keyword hits and bounded count eligibility, preserving receipts',
      async () => {
        await setRatingReviewState(
          f.pool,
          successor.approval.decisionId,
          'revoked',
        );
        assert.equal((await readPost(postId)).status, 404);
        assert.equal(
          (await get(`/v1/community/posts/${postId}/comments`)).status,
          404,
        );
        assert.notEqual(
          (await get(`/v1/community/comments/${commentId}/replies`)).status,
          200,
        );
        assert.equal((await count(postId))?.decision, 'deny');
        const search = await get('/v1/community/search').query({
          spaceId: f.scope.home.spaceId,
          q: 'Persisted',
          type: 'all',
        });
        assert.equal(search.status, 200, JSON.stringify(search.body));
        assert.doesNotMatch(
          JSON.stringify(search.body),
          new RegExp(`${postId}|${commentId}|${replyId}`),
        );
        assert.equal(
          (await f.linkCall(f.creator, '/v1/community/posts', body)).body
            .resourceId,
          postId,
        );
        await setRatingReviewState(
          f.pool,
          successor.approval.decisionId,
          'allow',
        );
        assert.equal((await readPost(postId)).status, 200);
      },
    );
    await t.test(
      'incomplete target Review becomes unknown, never a fabricated empty/zero answer',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const event = randomUUID();
          await tx.query(
            "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','missing','accepted','synthetic-rating-review','synthetic-incomplete',clock_timestamp())",
            [event, successor.approval.decisionId],
          );
          await tx.query(
            'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
            [successor.approval.decisionId, event],
          );
        });
        assert.equal((await readPost(postId)).status, 503);
        assert.equal((await count(postId))?.decision, 'unknown');
        const search = await get('/v1/community/search').query({
          spaceId: f.scope.home.spaceId,
          q: 'Original',
          type: 'post',
        });
        assert.equal(search.status, 503);
        assert.doesNotMatch(
          JSON.stringify(search.body),
          /Original user-written|这门课程/,
        );
        await setRatingReviewState(
          f.pool,
          successor.approval.decisionId,
          'allow',
        );
      },
    );
    await t.test(
      'actual ancestor concealment and placement departure close the shared scalar and independent count owners',
      async () => {
        const binding = (
          await f.pool.query(
            'SELECT component FROM whaleu_community.post_rating_target_links WHERE post_id=$1',
            [postId],
          )
        ).rows[0].component.binding;
        const rootId = String(binding.ancestry[0].categoryId);
        const before = await snapshot();
        const visibility = async (hidden: boolean) => {
          const context = await f.managementContext(f.admin, f.linkSelector);
          await f.executeManagement(
            f.admin,
            f.managementIntent(context, 'set_category_visibility_scoped', {
              categoryId: rootId,
              hidden,
            }),
          );
        };
        await visibility(true);
        const hidden = await readPost(postId);
        assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
        assert.equal((await count(postId))?.decision, 'deny');
        assert.doesNotMatch(
          JSON.stringify(hidden.body),
          /Original user-written|这门课程/,
        );
        await visibility(false);
        assert.equal((await readPost(postId)).status, 200);
        assert.equal((await count(postId))?.decision, 'allow');
        const context = await f.managementContext(f.admin, f.linkSelector);
        await f.executeManagement(
          f.admin,
          f.managementIntent(context, 'set_category_scope_scoped', {
            categoryId: rootId,
            placement: { kind: 'campuses', campusIds: [f.campusB] },
            propagation: 'subtree',
          }),
        );
        const moved = await readPost(postId);
        assert.equal(moved.status, 404, JSON.stringify(moved.body));
        assert.equal((await count(postId))?.decision, 'deny');
        assert.deepEqual(
          (await f.linkCall(f.creator, '/v1/community/posts', body)).body
            .resourceId,
          postId,
        );
        assert.equal(await snapshot(), before);
      },
    );
    await t.test(
      'canteen manual anonymous card uses the same local issuer and typed persistence without generation',
      async () => {
        const category = await f.createLinkCategory('canteen'),
          canteen = await f.createLinkTarget(category, 'Accepted canteen'),
          manual = await f.card(canteen.id, 'anonymous');
        manual.component.label = '食堂体验如何？';
        const created = await f.publishCard(manual);
        const detail = await readPost(created.resourceId);
        assert.equal(detail.status, 200, JSON.stringify(detail.body));
        assert.equal(detail.body.component.target.name, 'Accepted canteen');
        assert.equal(detail.body.component.label, manual.component.label);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.assistance_requests',
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'owner-issued ordinary course name and unsupported system key expose no ask capability; issued capability cannot survive category source drift',
      async () => {
        for (const system of [false, true]) {
          const context = await f.managementContext(f.admin, f.linkSelector);
          const created = await f.executeManagement(
            f.admin,
            f.managementIntent(
              context,
              system
                ? 'create_system_category_scoped'
                : 'create_categories_scoped',
              system
                ? {
                    systemKey: 'synthetic_general',
                    name: 'unsupported course',
                    description: 'Unsupported accepted system key',
                    levelCount: 1,
                    placement: { kind: 'campuses', campusIds: [f.campusA] },
                  }
                : {
                    parentId: null,
                    nodes: [
                      {
                        key: 'root',
                        parentKey: null,
                        name: 'course',
                        description: '',
                      },
                    ],
                    placement: { kind: 'campuses', campusIds: [f.campusA] },
                  },
            ),
          );
          const ordinary = await f.createLinkTarget(
            created.receipt.result.categoryIds[0]!,
            'course',
          );
          const readContext = await f.scopedContext(f.creator, f.linkSelector);
          const detail = await f
            .auth(
              request(f.http).get(`/v2/ratings/targets/${ordinary.id}`),
              f.creator,
            )
            .query({
              contextId: readContext.id,
              contextToken: readContext.token,
            });
          assert.equal(detail.status, 200, JSON.stringify(detail.body));
          assert.equal(detail.body.ratingTargetLink, undefined);
        }
        const canteenId = String(
          (
            await f.pool.query(
              "SELECT component->>'targetId' id FROM whaleu_community.post_rating_target_links WHERE component->'binding'->>'systemKey'='canteen' LIMIT 1",
            )
          ).rows[0].id,
        );
        const issued = await f.card(canteenId);
        const before = (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_community.post_rating_target_links',
          )
        ).rows[0].n;
        const categoryId = (
          await f.pool.query(
            'SELECT category_id FROM whaleu_ratings.targets WHERE id=$1',
            [canteenId],
          )
        ).rows[0].category_id;
        const current = await f.managementContext(f.admin, f.linkSelector);
        await f.executeManagement(
          f.admin,
          f.managementIntent(current, 'edit_category_base_scoped', {
            categoryId,
            name: 'Accepted canteen successor',
            description: 'Accepted source revision after capability issue',
          }),
        );
        const changed = await f.linkCall(
          f.creator,
          '/v1/community/reviews/posts',
          issued,
        );
        assert.equal(changed.status, 409, JSON.stringify(changed.body));
        assert.equal(changed.body.error.code, 'RATING_REVISION_CONFLICT');
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.post_rating_target_links',
            )
          ).rows[0].n,
          before,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
              [f.creator.accountId, issued.clientRequestId],
            )
          ).rowCount,
          0,
        );
      },
    );
  },
);
