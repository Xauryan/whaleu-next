import { configureSyntheticCommunityMedia } from './media/runtime-fixture.js';
import { SyntheticMediaStorage } from './media/synthetic-storage.js';
import { SyntheticMediaIngressStorage } from './media/synthetic-ingress-storage.js';
import { SyntheticMediaWorker } from './media/synthetic-worker.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { inTransaction } from '../../src/database/database.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import { ApprovalRepository } from '../../src/community/content-review/approval.repository.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
  type RatingNavigationSelector,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedEditContextSchema } from '../../src/ratings/scoped/controller.js';
import { ratingTargetLinkCapabilitySchema } from '../../src/community/rating-target-link/contracts.js';
import { ASSISTANCE_RUNTIME } from '../../src/ratings/assistance/contracts.js';
import type { AssistanceRuntime } from '../../src/ratings/assistance/provider.js';
import { ratingCategoryManagementFixture } from './rating-category-management-fixture.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from './rating-scoped-command-fixture.js';
import { extendLiveFixture } from './live-fixture.js';

/** Ordinary AppModule, owner-approved category/target fixtures and the actual
 * single-command local Review issuer. No card approval or publication bypass. */
export async function ratingTargetLinkFixture(
  runtime: AssistanceRuntime | null = null,
  options: {
    hot?: boolean;
    beforeActivation?: NonNullable<
      Parameters<typeof ratingCategoryManagementFixture>[0]
    >['beforeActivation'];
    media?: readonly {
      sha256: string;
      verdict: 'allow' | 'held' | 'revoked';
    }[];
  } = {},
) {
  const storage = options.media ? await SyntheticMediaStorage.create() : null;
  const ingressStorage = storage
    ? new SyntheticMediaIngressStorage(storage)
    : null;
  let local: Partial<RuntimeConfig> = {},
    config!: RuntimeConfig;
  const f = await ratingCategoryManagementFixture({
    systemKeys: ['course', 'canteen'],
    ...(options.beforeActivation
      ? { beforeActivation: options.beforeActivation }
      : {}),
    appOptions: {
      createApp: async (base, configurePolicy) => {
        config = { ...base, ...local };
        const builder = Test.createTestingModule({
          imports: [AppModule.register(config)],
        });
        builder.overrideProvider(ASSISTANCE_RUNTIME).useValue(runtime);
        if (storage && ingressStorage)
          configureSyntheticCommunityMedia(builder, storage, ingressStorage);
        await configurePolicy(builder);
        return (await builder.compile()).createNestApplication({
          logger: false,
        });
      },
    },
  }).catch(async (error: unknown) => {
    await storage?.dispose();
    throw error;
  });
  try {
    local = {
      ...(options.hot
        ? {
            HOT_FEED_PROCESSING: 'manual_only' as const,
            SUBSCRIPTION_COMPONENT_PROCESSING: 'manual_only' as const,
            LIKE_COMPONENT_PROCESSING: 'manual_only' as const,
            COMMENT_COMPONENT_PROCESSING: 'manual_only' as const,
          }
        : {}),
      COMMUNITY_TEXT_REVIEW: 'local_manual',
      COMMUNITY_TEXT_REVIEW_SPACE_ID: f.scope.home.spaceId,
      COMMUNITY_TEXT_REVIEW_REGION_ID: f.scope.home.regionId,
      COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
      COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:synthetic:rating-link',
    };
    await f.restartApp();
    // Exactly the CLI composition (no injected Nest target-owner facade).
    const operator = new TextReviewOperator(
      new TextReviewRuntime(config, new ApprovalRepository()),
      config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
    );
    await inTransaction(f.pool, (tx) =>
      operator.run(
        {
          command: 'init-policy',
          basis: 'Disposable bounded rating card acceptance',
        },
        tx,
      ),
    );
    type Actor = typeof f.creator;
    const selector: RatingNavigationSelector = {
      kind: 'campus',
      campusId: f.campusA,
    };
    const call = (actor: Actor, path: string, body: object) =>
      f.auth(request(f.http).post(path), actor).send(body);
    const createCategory = async (
      systemKey: 'course' | 'canteen',
      nested = false,
    ) => {
      const context = await f.managementContext(f.admin, selector);
      const created = await f.executeManagement(
        f.admin,
        f.managementIntent(context, 'create_system_category_scoped', {
          systemKey,
          name: `Accepted ${systemKey}`,
          description: 'Accepted registry purpose',
          placement: { kind: 'campuses', campusIds: [f.campusA] },
          levelCount: 3,
        }),
      );
      const rootId = created.receipt.result.categoryIds[0]!;
      if (!nested) return rootId;
      const next = await f.managementContext(f.admin, selector);
      const children = await f.executeManagement(
        f.admin,
        f.managementIntent(next, 'create_categories_scoped', {
          parentId: rootId,
          placement: { kind: 'campuses', campusIds: [f.campusA] },
          nodes: [
            {
              key: 'middle',
              parentKey: null,
              name: 'Middle without system key',
              description: '',
            },
            {
              key: 'leaf',
              parentKey: 'middle',
              name: 'Leaf without system key',
              description: '',
            },
          ],
        }),
      );
      // Owner receipt IDs are canonically ordered, not tree traversal order.
      const leaf = await f.pool.query<{ category_id: string }>(
        `SELECT DISTINCT category_id FROM whaleu_ratings.scoped_categories
         WHERE category_id=ANY($1::uuid[]) AND level=3`,
        [children.receipt.result.categoryIds],
      );
      assert.equal(leaf.rowCount, 1);
      return leaf.rows[0]!.category_id;
    };
    const executeTarget = async (
      actor: Actor,
      input: ReturnType<typeof ratingScopedIntentSchema.parse>,
      reviewOptions: Parameters<typeof f.approveScoped>[1] = {},
    ) => {
      const edit = input.operation === 'edit_target_scoped';
      const prepared = await call(
        actor,
        edit
          ? '/v2/ratings/management/owner-edit/prepare'
          : '/v2/ratings/management/prepare',
        input,
      );
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      const preparation = ratingScopedPreparationSchema.parse(prepared.body);
      const row = (
        await f.pool.query<{ envelope: unknown }>(
          'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0]!;
      const approval = await f.approveScoped(
        canonicalRatingScopedEnvelope(row.envelope),
        reviewOptions,
      );
      const response = await call(
        actor,
        edit
          ? '/v2/ratings/management/owner-edit/commit'
          : '/v2/ratings/management/targets',
        { ...input, preparationContextRevision: preparation.contextRevision },
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const receipt = scopedSuccess(response.body);
      return {
        receipt,
        approval,
        id: String(receipt.result['targetId']),
        revision: String(receipt.result['revision']),
      };
    };
    const createTarget = async (
      categoryId: string,
      name = 'Original course',
      actor: Actor = f.creator,
      reviewOptions: Parameters<typeof f.approveScoped>[1] = {},
    ) => {
      const context = await f.scopedContext(actor, selector, 'create_target');
      const category = (
        await f.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [context.heads[0]!.catalogRevision, categoryId],
        )
      ).rows[0]!;
      return executeTarget(
        actor,
        ratingScopedIntentSchema.parse({
          protocolVersion: 2,
          operation: 'create_target_scoped',
          context: scopedCommandContext(context),
          payload: {
            clientRequestId: randomUUID(),
            categoryId,
            expectedCategoryRevision: category.effective_revision,
            name,
            description: 'Owner-approved description',
            assetIds: [],
          },
        }),
        reviewOptions,
      );
    };
    const editTarget = async (
      targetId: string,
      name: string,
      actor: Actor = f.creator,
      description = 'Accepted successor description',
    ) => {
      const context = await f.scopedContext(actor, selector, 'edit_target');
      const response = await f
        .auth(
          request(f.http).get(
            `/v2/ratings/management/owner-edit/targets/${targetId}/context`,
          ),
          actor,
        )
        .query({ contextId: context.id, contextToken: context.token });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const current = ratingScopedEditContextSchema.parse(response.body);
      return executeTarget(
        actor,
        ratingScopedIntentSchema.parse({
          protocolVersion: 2,
          operation: 'edit_target_scoped',
          context: scopedCommandContext(context),
          payload: {
            clientRequestId: randomUUID(),
            targetId,
            expectedTargetRevision: current.revision,
            expectedDefinitionRevision: current.definitionRevision,
            expectedContentVersion: current.contentVersion,
            categoryId: current.categoryId,
            expectedCategoryRevision: current.categoryRevision,
            name,
            description,
            assetIds: [],
          },
        }),
      );
    };
    const reference = async (targetId: string, actor: Actor = f.creator) => {
      const context = await f.scopedContext(actor, selector);
      const response = await f
        .auth(request(f.http).get(`/v2/ratings/targets/${targetId}`), actor)
        .query({ contextId: context.id, contextToken: context.token });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const parsed = ratingTargetLinkCapabilitySchema.parse(
        response.body.ratingTargetLink,
      );
      const { systemKey, ...value } = parsed;
      return { value, systemKey, context };
    };
    const approveCommunity = async (actor: Actor, requestId: string) => {
      const exact = (
        await f.pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, requestId],
        )
      ).rows[0];
      assert.ok(exact);
      await inTransaction(f.pool, (tx) =>
        operator.run(
          {
            command: 'decide',
            accountId: actor.accountId,
            requestId,
            digest: exact.digest,
            decision: 'allow',
            basis: 'Explicitly inspected final exact body and card label',
          },
          tx,
        ),
      );
    };
    const card = async (
      targetId: string,
      authorMode: 'named' | 'anonymous' = 'named',
      actor: Actor = f.creator,
    ) => ({
      clientRequestId: randomUUID(),
      spaceId: f.scope.home.spaceId,
      category: 'discussion' as const,
      text: 'Original user-written body remains unchanged',
      imageAssetIds: [],
      authorMode,
      commentsPolicy: 'open' as const,
      component: {
        kind: 'rating_target_link' as const,
        label: '这门课程怎么样？',
        ...(await reference(targetId, actor)).value,
      },
    });
    const publishCard = async (
      body: Awaited<ReturnType<typeof card>>,
      actor: Actor = f.creator,
    ) => {
      const queued = await call(actor, '/v1/community/reviews/posts', body);
      assert.equal(queued.status, 200, JSON.stringify(queued.body));
      assert.equal(queued.body.status, 'pending');
      await approveCommunity(actor, body.clientRequestId);
      const published = await call(actor, '/v1/community/posts', body);
      assert.equal(published.status, 201, JSON.stringify(published.body));
      assert.equal(published.body.outcome, 'created');
      return published.body as { outcome: 'created'; resourceId: string };
    };
    return extendLiveFixture(f, {
      operator,
      storage,
      worker: storage
        ? new SyntheticMediaWorker(f.pool, storage, options.media!)
        : null,
      close: async () => {
        try {
          await f.close();
        } finally {
          await storage?.dispose();
        }
      },
      linkSelector: selector,
      linkCall: call,
      createLinkCategory: createCategory,
      createLinkTarget: createTarget,
      editLinkTarget: editTarget,
      linkReference: reference,
      approveLinkCommunity: approveCommunity,
      card,
      publishCard,
    });
  } catch (error) {
    try {
      await f.close();
    } finally {
      await storage?.dispose();
    }
    throw error;
  }
}
export type RatingTargetLinkFixture = Awaited<
  ReturnType<typeof ratingTargetLinkFixture>
>;
