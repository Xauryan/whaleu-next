import { DatabaseService } from '../../src/database/database.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { CategoryIconMediaRequiredProof } from '../../src/media/category-icon-required-proof.js';
import { RatingScopedCommands } from '../../src/ratings/scoped/commands.service.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
/** Real HTTP/PostgreSQL co-write regression. Run only under the parent's
 * exclusive disposable PostgreSQL lease. One original owner, three categories
 * and tiny registered fixture images; no fabricated current/projection rows,
 * disabled guards, widened deadlines, relaxed rates or provider access. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { configureHttp } from '../../src/http/http.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingsMediaGrantSchema,
  ratingsMediaStatusSchema,
  ratingsMediaUploadObservedSchema,
} from '../../src/media/contracts-ratings.js';
import {
  ratingsDiscussionBatchIdentitySchema,
  ratingsDiscussionBatchStatusSchema,
  ratingsDiscussionMediaGrantSchema,
  ratingsDiscussionMediaUploadObservedSchema,
  ratingsDiscussionMemberStatusSchema,
} from '../../src/media/contracts-ratings-discussion.js';
import { RATINGS_TARGET_COVER_RUNTIME } from '../../src/ratings/target-cover-media.service.js';
import { RATINGS_DISCUSSION_MEDIA_RUNTIME } from '../../src/ratings/discussion-media.service.js';
import { ratingScopedCommandContextSchema } from '../../src/ratings/scoped/contracts.js';
import { ratingScopedEditContextSchema } from '../../src/ratings/scoped/controller.js';
import {
  ratingTargetCoverContextSchema,
  ratingTargetCoverIntentSchema,
  ratingTargetCoverPreparationSchema,
  ratingTargetCoverReferenceSchema,
  ratingTargetCoverReceiptSchema,
  type RatingTargetCoverIntent,
} from '../../src/ratings/scoped/target-cover-contracts.js';
import { ratingTargetCoverUploadScopeResponseSchema } from '../../src/ratings/scoped/target-cover-controller.js';
import {
  ratingDiscussionCommandContextSchema,
  ratingDiscussionContextSchema,
  ratingDiscussionMediaIntentSchema,
  ratingDiscussionMediaPreparationSchema,
  ratingDiscussionMediaReceiptSchema,
  type RatingDiscussionMediaIntent,
} from '../../src/ratings/scoped/discussion-media-contracts.js';
import {
  categoryIconHttpOk as ok,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { setCategoryScaleAssetState } from '../support/category-icon-scale-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import {
  issueSyntheticTargetCoverCapabilities,
  writeSyntheticTargetCoverApproval,
} from '../support/media/ratings-target-runtime-fixture.js';
import {
  issueSyntheticDiscussionCapabilities,
  writeSyntheticDiscussionApproval,
} from '../support/media/ratings-discussion-runtime-fixture.js';
import { SyntheticMediaIngressStorage } from '../support/media/synthetic-ingress-storage.js';

type MediaIntent = RatingTargetCoverIntent | RatingDiscussionMediaIntent;

/** A closed request may be recorded. Everything which can publish, bind,
 * consume a prepared upload, change a definition or emit an effect must remain
 * byte-equivalent to the graph immediately before the denied command. */
async function graph(f: CategoryIconManagementFixture) {
  const icons = { ...((await f.artifacts()) as Record<string, unknown>) };
  delete icons['requests'];
  const tables = [
    'whaleu_ratings.targets',
    'whaleu_ratings.target_sources',
    'whaleu_ratings.target_creations',
    'whaleu_ratings.target_scope_placements',
    'whaleu_ratings.target_definition_versions',
    'whaleu_ratings.target_definition_heads',
    'whaleu_ratings.target_definition_lifecycles',
    'whaleu_ratings.target_state_revisions',
    'whaleu_ratings.target_cover_upload_scopes',
    'whaleu_ratings.target_cover_appearances',
    'whaleu_ratings.target_cover_cleanup',
    'whaleu_ratings.score_baselines',
    'whaleu_ratings.subscription_baselines',
    'whaleu_ratings.comments',
    'whaleu_ratings.comment_transitions',
    'whaleu_ratings.replies',
    'whaleu_ratings.like_subjects',
    'whaleu_ratings.effect_events',
    'whaleu_ratings.scoped_command_causes',
    'whaleu_ratings.scoped_command_preparations',
    'whaleu_ratings.scoped_source_attestations',
    'whaleu_ratings.scoped_source_heads',
    'whaleu_ratings.scoped_source_epoch',
    'whaleu_ratings.scoped_releases',
    'whaleu_ratings.scoped_catalog_heads',
    'whaleu_ratings.scoped_target_memberships',
    'whaleu_ratings.discussion_media_cleanup',
    'whaleu_community.rating_target_cover_definition_bindings',
    'whaleu_community.rating_discussion_media_bindings',
    'whaleu_media.assets',
    'whaleu_media.upload_intents',
    'whaleu_media.ratings_discussion_batches',
    'whaleu_media.ratings_discussion_members',
  ];
  const owners = (
    await f.pool.query<{ state: unknown }>(`SELECT jsonb_build_object(
    ${tables.map((table) => `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM ${table} r)`).join(',')},
    'acceptedOutcomes',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY account_id,request_id),'[]'::jsonb)
      FROM whaleu_ratings.scoped_command_outcomes o WHERE outcome<>'closed')) state`)
  ).rows[0]!.state;
  return { icons, owners };
}

test(
  'C1 ancestor icons coexist with original cover3 and discussion4 Media writes without weakening fresh Category8 authority',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 31, height: 23, channels: 3, background: '#367d91' },
    })
      .png()
      .toBuffer();
    const f = await categoryIconManagementFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const lifecycle: { app?: INestApplication } = {};
    t.after(async () => {
      try {
        await lifecycle.app?.close();
      } finally {
        await f.close();
      }
    });
    const owner = f.admin;
    await f.atomicChange((tx) =>
      f.issueSource(
        {
          kind: 'native_scoped_create',
          key: 'synthetic-native-scoped-create',
          scopeKeys: f.scopeKeys,
          payload: {
            enabled: true,
            genericKind: 'general',
            scopeKeys: [...f.scopeKeys].sort(),
          },
        },
        tx,
      ),
    );
    const tree = f.intent(await f.context(), 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'global' },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Media root',
          description: '',
          icon: { mode: 'clear' },
        },
        {
          key: 'middle',
          parentKey: 'root',
          name: 'Media middle',
          description: '',
          icon: { mode: 'clear' },
        },
        {
          key: 'leaf',
          parentKey: 'middle',
          name: 'Media leaf',
          description: '',
          icon: { mode: 'clear' },
        },
      ],
    });
    const icon = await f.ready(tree, { kind: 'new', key: 'middle' }, bytes);
    await f.execute(icon.input);
    const path = (
      await f.pool.query<{
        id: string;
        parent_id: string | null;
        level: number;
      }>(
        `SELECT c.category_id id,c.parent_id,c.level FROM whaleu_ratings.scoped_catalog_heads h
       JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=h.catalog_id
       WHERE h.scope_key='global' ORDER BY c.level`,
      )
    ).rows;
    assert.equal(path.length, 3);
    const [root, middle, leaf] = path;
    assert.ok(root && middle && leaf);
    assert.equal(root.parent_id, null);
    assert.equal(middle.parent_id, root.id);
    assert.equal(leaf.parent_id, middle.id);
    assert.deepEqual(
      path.map((row) => row.level),
      [1, 2, 3],
    );

    // These existing test-only issuers bind evidence to the real adopted
    // protocol/source versions. The C1 owner is neither reset nor reseeded.
    await issueSyntheticTargetCoverCapabilities(f.pool);
    await issueSyntheticDiscussionCapabilities(f.pool);
    assert.ok(f.storage && f.worker);
    const storage = f.storage,
      worker = f.worker;
    const ingressStorage = new SyntheticMediaIngressStorage(storage);
    const runtime = { planning: ingressStorage, storage, ingressStorage };
    const module = await Test.createTestingModule({
      imports: [AppModule.register(f.app.get<RuntimeConfig>(APP_CONFIG))],
    })
      .overrideProvider(RATINGS_TARGET_COVER_RUNTIME)
      .useValue(runtime)
      .overrideProvider(RATINGS_DISCUSSION_MEDIA_RUNTIME)
      .useValue(runtime)
      .compile();
    const app = module.createNestApplication({ logger: false });
    lifecycle.app = app;
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    const http = app.getHttpServer();
    const auth = (r: request.Test) => f.auth(r, owner);
    let pacedWindows = 0;
    const post = async (url: string, body: object) => {
      if (
        [
          '/v3/media/ratings-target/upload-scopes',
          '/v3/media/ratings-discussion/batches',
          '/v3/media/ratings-discussion/members',
        ].includes(url)
      ) {
        const exact = canonicalJson(body);
        const quota = (
          await f.pool.query<{
            recent: number;
            daily: number;
            wait_ms: number;
          }>(
            `
          WITH requests AS (
            SELECT actor_id,created_at FROM whaleu_media.upload_request_fences
            UNION ALL SELECT actor_id,created_at FROM whaleu_media.ratings_discussion_batch_request_fences)
          SELECT count(*)::int daily,
            count(*) FILTER(WHERE created_at>clock_timestamp()-interval '1 minute')::int recent,
            coalesce(greatest(0,extract(epoch FROM (
              min(created_at) FILTER(WHERE created_at>clock_timestamp()-interval '1 minute')+
              interval '1 minute'-clock_timestamp()))*1000),0)::float8 wait_ms
          FROM requests WHERE actor_id=$1
            AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
            [owner.accountId],
          )
        ).rows[0]!;
        assert.ok(quota.daily < 100 && quota.recent <= 10);
        if (quota.recent === 10) {
          assert.ok(quota.wait_ms >= 0 && quota.wait_ms <= 60000);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.ceil(quota.wait_ms) + 50),
          );
          pacedWindows++;
          assert.equal(
            canonicalJson(body),
            exact,
            'Rate pacing retains the exact original key, context and payload',
          );
        }
      }
      return auth(request(http).post(url)).send(body);
    };
    const get = (url: string) => auth(request(http).get(url));
    const commandContext = (
      c: ReturnType<typeof ratingTargetCoverContextSchema.parse>,
    ) =>
      ratingScopedCommandContextSchema.parse({
        id: c.id,
        token: c.token,
        tokenDigest: c.tokenDigest,
        selector: c.selector,
        scopeRevision: c.scopeRevision,
        protocolGeneration: c.protocolGeneration,
        catalogRevision: c.heads[0]!.catalogRevision,
        headRevision: c.heads[0]!.headRevision,
        sourceDigest: c.sourceDigest,
      });
    const coverDraft = async (targetId?: string) => {
      const response = await post('/v3/ratings/target-cover/contexts', {
        purpose: targetId ? 'edit_target' : 'create_target',
        selector: { kind: 'global' },
        mode: 'public',
      });
      ok(response);
      const c = ratingTargetCoverContextSchema.parse(response.body);
      const category = (
        await f.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [c.heads[0]!.catalogRevision, leaf.id],
        )
      ).rows[0];
      assert.ok(category);
      const common = {
        protocolVersion: 3,
        context: commandContext(c),
        payload: {
          clientRequestId: randomUUID(),
          categoryId: leaf.id,
          expectedCategoryRevision: category.effective_revision,
          name: 'Cover beneath a C1 ancestor',
          description: 'Original target owner and exact media',
        },
      };
      if (!targetId)
        return ratingTargetCoverIntentSchema.parse({
          ...common,
          operation: 'create_target_scoped',
          payload: { ...common.payload, cover: { action: 'clear' } },
        });
      const edit = await get(
        `/v3/ratings/target-cover/targets/${targetId}/edit-context`,
      ).query({ contextId: c.id, contextToken: c.token });
      ok(edit);
      const current = ratingScopedEditContextSchema
        .extend({
          cover: ratingTargetCoverReferenceSchema.nullable(),
        })
        .parse(edit.body);
      return ratingTargetCoverIntentSchema.parse({
        ...common,
        operation: 'edit_target_scoped',
        payload: {
          ...common.payload,
          targetId,
          expectedTargetRevision: current.revision,
          expectedDefinitionRevision: current.definitionRevision,
          expectedContentVersion: current.contentVersion,
          name: current.name,
          description: current.description,
          cover: { action: 'keep' },
        },
      });
    };
    const runWorker = async () => {
      for (const stage of ['seal', 'process', 'review'] as const)
        assert.equal(await worker.runOne(stage), true);
    };
    const coverReady = async (input: RatingTargetCoverIntent) => {
      const issued = await post('/v3/ratings/target-cover/upload-scopes', {
        protocolVersion: 3,
        context: input.context,
        clientRequestId: randomUUID(),
        commandRequestId: input.payload.clientRequestId,
        draftRevision: randomUUID(),
        categoryId: input.payload.categoryId,
        expectedCategoryRevision: input.payload.expectedCategoryRevision,
        target:
          input.operation === 'edit_target_scoped'
            ? {
                targetId: input.payload.targetId,
                expectedTargetRevision: input.payload.expectedTargetRevision,
                expectedDefinitionRevision:
                  input.payload.expectedDefinitionRevision,
                expectedContentVersion: input.payload.expectedContentVersion,
              }
            : null,
        declaration: {
          mime: 'image/png',
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      });
      ok(issued);
      const scope = ratingTargetCoverUploadScopeResponseSchema.parse(
        issued.body,
      );
      ok(await post('/v3/media/ratings-target/upload-scopes', scope.prepare));
      const url = `/v3/media/ratings-target/upload-scopes/${scope.scopeId}`;
      const granted = await post(`${url}/grant`, {});
      ok(granted);
      const grant = ratingsMediaGrantSchema.parse(granted.body);
      const uploaded = await auth(
        request(http).post(`${url}/uploads/${grant.grantId}`),
      ).attach('file', bytes, {
        filename: 'c1-cover',
        contentType: 'image/png',
      });
      ok(uploaded);
      assert.equal(
        ratingsMediaUploadObservedSchema.parse(uploaded.body).sha256,
        sha256(bytes),
      );
      ok(await post(`${url}/finalize`, {}));
      await runWorker();
      const response = await get(url);
      ok(response);
      const status = ratingsMediaStatusSchema.parse(response.body);
      if (status.status !== 'ready_unbound')
        assert.fail(JSON.stringify(status));
      return {
        assetId: status.assetId,
        intent: ratingTargetCoverIntentSchema.parse({
          ...input,
          payload: {
            ...input.payload,
            cover: {
              action: 'replace',
              assetId: status.assetId,
              uploadScopeId: scope.scopeId,
            },
          },
        }),
      };
    };
    const prepare = async (input: MediaIntent, approve = true) => {
      const prefix =
        input.protocolVersion === 3
          ? '/v3/ratings/target-cover'
          : '/v4/ratings/discussion';
      const response = await post(`${prefix}/prepare`, input);
      ok(response);
      const prepared =
        input.protocolVersion === 3
          ? ratingTargetCoverPreparationSchema.parse(response.body)
          : ratingDiscussionMediaPreparationSchema.parse(response.body);
      if (approve) {
        const row = (
          await f.pool.query<{ envelope: unknown }>(
            'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
            [owner.accountId, input.payload.clientRequestId],
          )
        ).rows[0];
        assert.ok(
          row?.envelope,
          'Approve only the actual original-owner preparation',
        );
        if (input.protocolVersion === 3)
          await writeSyntheticTargetCoverApproval(f.pool, row.envelope);
        else await writeSyntheticDiscussionApproval(f.pool, row.envelope);
      }
      return { input, prefix, contextRevision: prepared.contextRevision };
    };
    type Pending = Awaited<ReturnType<typeof prepare>>;
    const commit = (pending: Pending) =>
      post(`${pending.prefix}/commit`, {
        ...pending.input,
        preparationContextRevision: pending.contextRevision,
      });
    const recoveries: Array<{ pending: Pending; receipt: unknown }> = [];
    const executeCover = async (
      input: RatingTargetCoverIntent,
      expected: 'applied' | 'noop' = 'applied',
    ) => {
      const pending = await prepare(input, expected !== 'noop');
      const response = await commit(pending);
      ok(response);
      const receipt = ratingTargetCoverReceiptSchema.parse(response.body);
      assert.equal(receipt.outcome, expected, JSON.stringify(receipt));
      recoveries.push({ pending, receipt });
      return receipt.result as {
        targetId: string;
        revision: string;
        contentVersion?: number;
      };
    };
    const recoverApplied = async () => {
      for (const { pending, receipt } of recoveries) {
        const replay = await commit(pending);
        ok(replay);
        assert.equal(canonicalJson(replay.body), canonicalJson(receipt));
        const response = await get(
          `${pending.prefix}/receipts/${pending.input.payload.clientRequestId}`,
        );
        ok(response);
        assert.equal(canonicalJson(response.body), canonicalJson(receipt));
      }
    };
    const coverHead = async (targetId: string) =>
      (
        await f.pool.query<{
          content_version: number;
          envelope: { version: number; cover: { assetId: string } | null };
        }>(
          `SELECT h.content_version,d.envelope FROM whaleu_ratings.target_definition_heads h
       JOIN whaleu_ratings.target_definition_versions d ON
         (d.target_id,d.content_version,d.definition_revision)=(h.target_id,h.content_version,h.definition_revision)
       WHERE h.target_id=$1`,
          [targetId],
        )
      ).rows[0]!;
    const activeCovers = async (targetId: string) =>
      (
        await f.pool.query<{ count: number }>(
          `SELECT count(*)::int count FROM whaleu_ratings.target_cover_appearances a
       JOIN whaleu_media.bindings b ON b.id=a.media_binding_id
       WHERE a.target_id=$1 AND b.detached_at IS NULL`,
          [targetId],
        )
      ).rows[0]!.count;

    const first = await coverReady(await coverDraft());
    const created = await executeCover(first.intent);
    const targetId = created.targetId;
    assert.equal((await coverHead(targetId)).envelope.version, 6);
    assert.equal(
      (await coverHead(targetId)).envelope.cover?.assetId,
      first.assetId,
    );
    assert.equal(await activeCovers(targetId), 1);
    assert.equal(
      (
        await f.pool.query<{ creator_id: string }>(
          'SELECT creator_id FROM whaleu_ratings.targets WHERE id=$1',
          [targetId],
        )
      ).rows[0]!.creator_id,
      owner.accountId,
    );
    await t.test(
      'cover replacement changes one definition and genuine keep noop changes no binding',
      async () => {
        const replacement = await coverReady(await coverDraft(targetId));
        await executeCover(replacement.intent);
        assert.equal((await coverHead(targetId)).content_version, 2);
        assert.equal(
          (await coverHead(targetId)).envelope.cover?.assetId,
          replacement.assetId,
        );
        assert.equal(await activeCovers(targetId), 1);
        const bindings = (
          await f.pool.query('SELECT * FROM whaleu_media.bindings ORDER BY id')
        ).rows;
        await executeCover(await coverDraft(targetId), 'noop');
        assert.equal((await coverHead(targetId)).content_version, 2);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_media.bindings ORDER BY id',
            )
          ).rows,
          bindings,
        );
      },
    );

    const discussionDraft = async (root?: { id: string; revision: string }) => {
      const response = await post('/v4/ratings/discussion/contexts', {
        purpose: 'interact',
        selector: { kind: 'global' },
        mode: 'public',
      });
      ok(response);
      const c = ratingDiscussionContextSchema.parse(response.body);
      const head = (
        await f.pool.query<{
          revision: string;
          definition_revision: string;
          content_version: number;
          effective_revision: string;
        }>(
          `SELECT t.revision,h.definition_revision,h.content_version,c.effective_revision
         FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
         JOIN whaleu_ratings.scoped_categories c ON c.category_id=t.category_id AND c.catalog_id=$2
         WHERE t.id=$1`,
          [targetId, c.heads[0]!.catalogRevision],
        )
      ).rows[0]!;
      return ratingDiscussionMediaIntentSchema.parse({
        protocolVersion: 4,
        operation: root ? 'create_reply_scoped' : 'create_comment_scoped',
        context: ratingDiscussionCommandContextSchema.parse({
          id: c.id,
          token: c.token,
          tokenDigest: c.tokenDigest,
          selector: c.selector,
          scopeRevision: c.scopeRevision,
          protocolGeneration: c.protocolGeneration,
          catalogRevision: c.heads[0]!.catalogRevision,
          headRevision: c.heads[0]!.headRevision,
          sourceDigest: c.sourceDigest,
          discussionMedia: c.discussionMedia,
        }),
        payload: {
          clientRequestId: randomUUID(),
          categoryId: leaf.id,
          expectedCategoryRevision: head.effective_revision,
          targetId,
          expectedTargetRevision: head.revision,
          expectedDefinitionRevision: head.definition_revision,
          expectedContentVersion: head.content_version,
          draftRevision: randomUUID(),
          batchRequestId: null,
          batchId: null,
          sealedPlanDigest: null,
          body: 'Original discussion below C1',
          authorMode: 'named',
          images: [],
          ...(root
            ? {
                rootId: root.id,
                expectedRootRevision: root.revision,
                replyTo: null,
              }
            : {}),
        },
      });
    };
    const discussionReady = async (intent: RatingDiscussionMediaIntent) => {
      const batchRequestId = randomUUID();
      const identity = ratingsDiscussionBatchIdentitySchema.parse({
        protocol: 'ratings-discussion-media-v1',
        batchRequestId,
        commandRequestId: intent.payload.clientRequestId,
        draftRevision: intent.payload.draftRevision,
        categoryId: intent.payload.categoryId,
        expectedCategoryRevision: intent.payload.expectedCategoryRevision,
        context: intent.context,
        target: {
          kind: intent.operation === 'create_comment_scoped' ? 'root' : 'reply',
          targetId,
          expectedTargetRevision: intent.payload.expectedTargetRevision,
          expectedDefinitionRevision: intent.payload.expectedDefinitionRevision,
          expectedContentVersion: intent.payload.expectedContentVersion,
          ...(intent.operation === 'create_reply_scoped'
            ? {
                rootId: intent.payload.rootId,
                expectedRootRevision: intent.payload.expectedRootRevision,
                replyTo: intent.payload.replyTo,
              }
            : {}),
        },
      });
      const created = await post(
        '/v3/media/ratings-discussion/batches',
        identity,
      );
      ok(created);
      let batch = ratingsDiscussionBatchStatusSchema.parse(created.body);
      const memberId = randomUUID();
      ok(
        await post('/v3/media/ratings-discussion/members', {
          protocol: 'ratings-discussion-media-v1',
          batchId: batch.batchId,
          batchIdentityHash: batch.batchIdentityHash,
          clientRequestId: randomUUID(),
          memberId,
          sourceSlot: 0,
          declaration: {
            mime: 'image/png',
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        }),
      );
      const url = `/v3/media/ratings-discussion/members/${memberId}`;
      const granted = await post(`${url}/grant`, {});
      ok(granted);
      const grant = ratingsDiscussionMediaGrantSchema.parse(granted.body);
      const uploaded = await auth(
        request(http).post(`${url}/uploads/${grant.grantId}`),
      ).attach('file', bytes, {
        filename: 'c1-discussion',
        contentType: 'image/png',
      });
      ok(uploaded);
      assert.equal(
        ratingsDiscussionMediaUploadObservedSchema.parse(uploaded.body).sha256,
        sha256(bytes),
      );
      ok(await post(`${url}/finalize`, {}));
      await runWorker();
      const ready = await get(url);
      ok(ready);
      assert.equal(
        ratingsDiscussionMemberStatusSchema.parse(ready.body).status,
        'ready_unbound',
      );
      const current = await get(
        `/v3/media/ratings-discussion/batches/${batch.batchId}`,
      );
      ok(current);
      batch = ratingsDiscussionBatchStatusSchema.parse(current.body);
      const sealed = await post(
        `/v3/media/ratings-discussion/batches/${batch.batchId}/seal`,
        {
          protocol: 'ratings-discussion-media-v1',
          batchId: batch.batchId,
          batchIdentityHash: batch.batchIdentityHash,
          expectedRevision: batch.revision,
          orderedMemberIds: [memberId],
        },
      );
      ok(sealed);
      batch = ratingsDiscussionBatchStatusSchema.parse(sealed.body);
      assert.ok(batch.sealedPlan);
      return ratingDiscussionMediaIntentSchema.parse({
        ...intent,
        payload: {
          ...intent.payload,
          body: '',
          batchRequestId,
          batchId: batch.batchId,
          sealedPlanDigest: batch.sealedPlanDigest,
          images: batch.sealedPlan.orderedMembers.map(
            ({ ordinal, memberId, assetId }) => ({
              ordinal,
              memberId,
              assetId,
            }),
          ),
        },
      });
    };
    const executeDiscussion = async (input: RatingDiscussionMediaIntent) => {
      const pending = await prepare(input);
      const response = await commit(pending);
      ok(response);
      const receipt = ratingDiscussionMediaReceiptSchema.parse(response.body);
      if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
      recoveries.push({ pending, receipt });
      return receipt;
    };
    const comment = await executeDiscussion(
      await discussionReady(await discussionDraft()),
    );
    assert.equal(comment.operation, 'create_comment_scoped');
    if (comment.operation !== 'create_comment_scoped')
      assert.fail('Expected original comment receipt');
    const discussionRoot = {
      id: comment.result.subjectId,
      revision: comment.result.revision,
    };
    await t.test(
      'image root and reply retain exact cover6, discussion7 and ancestor8 in the same owner mutation',
      async () => {
        const reply = await executeDiscussion(
          await discussionReady(await discussionDraft(discussionRoot)),
        );
        assert.equal(reply.operation, 'create_reply_scoped');
        if (reply.operation !== 'create_reply_scoped')
          assert.fail('Expected original reply receipt');
        const ids = [discussionRoot.id, reply.result.replyId];
        const counts = (
          await f.pool.query<{
            reviews: number;
            bindings: number;
            likes: number;
            effects: number;
          }>(
            `SELECT
          (SELECT count(*)::int FROM whaleu_community.rating_discussion_media_bindings WHERE subject_id=ANY($1::uuid[])) reviews,
          (SELECT count(*)::int FROM whaleu_media.bindings WHERE owner_kind='ratings' AND resource_id=ANY($1::uuid[]) AND detached_at IS NULL) bindings,
          (SELECT count(*)::int FROM whaleu_ratings.like_subjects WHERE id=ANY($1::uuid[])) likes,
          (SELECT count(*)::int FROM whaleu_ratings.effect_events WHERE root_id=$2 AND event_kind IN ('root_created','reply_created')) effects`,
            [ids, discussionRoot.id],
          )
        ).rows[0]!;
        assert.deepEqual(counts, {
          reviews: 2,
          bindings: 2,
          likes: 2,
          effects: 2,
        });
        assert.equal(await activeCovers(targetId), 1);
        await recoverApplied();
      },
    );

    for (const changed of ['held-review8', 'unknown-media8'] as const) {
      await t.test(
        `${changed} after prepare rolls back every original media command while applied receipts still recover`,
        async () => {
          const create = await coverReady(await coverDraft());
          const replace = await coverReady(await coverDraft(targetId));
          const clear = await coverDraft(targetId);
          const pending = [
            await prepare(create.intent),
            await prepare(replace.intent),
            await prepare(
              ratingTargetCoverIntentSchema.parse({
                ...clear,
                payload: { ...clear.payload, cover: { action: 'clear' } },
              }),
            ),
            await prepare(await coverDraft(targetId), false),
            await prepare(await discussionReady(await discussionDraft())),
            await prepare(
              await discussionReady(await discussionDraft(discussionRoot)),
            ),
          ];
          const decision = (
            await f.pool.query<{ decision_id: string }>(
              `SELECT b.decision_id FROM whaleu_ratings.scoped_catalog_heads h
           JOIN whaleu_ratings.category_icon_projections p ON (p.catalog_id,p.release_id)=(h.catalog_id,h.release_id)
           JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id
           WHERE h.scope_key='global' AND p.category_id=$1`,
              [middle.id],
            )
          ).rows;
          assert.equal(decision.length, 1);
          const decisionId = decision[0]!.decision_id;
          if (changed === 'held-review8')
            await setRatingReviewState(f.pool, decisionId, 'held');
          else
            await setCategoryScaleAssetState(f, icon.status.assetId, 'unknown');
          try {
            for (const item of pending) {
              const current = (
                await f.pool.query<{ current: boolean }>(
                  'SELECT whaleu_ratings.scoped_context_current($1,$2,$3,clock_timestamp()) current',
                  [item.input.context.id, owner.accountId, owner.sessionId],
                )
              ).rows[0];
              assert.equal(
                current?.current,
                true,
                'Only the external ancestor fact changed after prepare',
              );
            }
            const before = await graph(f);
            for (const item of pending) {
              const response = await commit(item);
              let code: string;
              if (response.status === 200) {
                const receipt =
                  item.input.protocolVersion === 3
                    ? ratingTargetCoverReceiptSchema.parse(response.body)
                    : ratingDiscussionMediaReceiptSchema.parse(response.body);
                assert.equal(
                  receipt.outcome,
                  'closed',
                  JSON.stringify(receipt),
                );
                if (receipt.outcome !== 'closed')
                  assert.fail(
                    'A preparation cannot replace current Category8 authority',
                  );
                code = receipt.code;
              } else {
                assert.ok(
                  response.status >= 400,
                  JSON.stringify(response.body),
                );
                code = (response.body as { error: { code: string } }).error
                  .code;
              }
              assert.ok(
                (changed === 'held-review8'
                  ? ['RATING_NOT_FOUND', 'CONTENT_REVIEW_UNAVAILABLE']
                  : ['MEDIA_UNAVAILABLE']
                ).includes(code),
                JSON.stringify(response.body),
              );
              assert.deepEqual(
                await graph(f),
                before,
                `${item.input.operation} must not publish or consume any upload`,
              );
            }
            await recoverApplied();
            assert.deepEqual(
              await graph(f),
              before,
              'Recovery is historical and cannot bind or publish again',
            );
          } finally {
            if (changed === 'held-review8')
              await setRatingReviewState(f.pool, decisionId, 'allow');
            else
              await setCategoryScaleAssetState(f, icon.status.assetId, 'allow');
          }
          if (changed === 'unknown-media8') {
            const retry = await commit(pending[3]!);
            ok(retry);
            const receipt = ratingTargetCoverReceiptSchema.parse(retry.body);
            assert.equal(
              receipt.outcome,
              'noop',
              'Unknown media must preserve the exact preparation for real recovery',
            );
          }
          // The denied commands still own sealed batches. Close those exact
          // original batches explicitly before opening another pair; the
          // original three-live-batch admission is not bypassed or expired.
          for (const item of pending) {
            if (item.input.protocolVersion !== 4 || !item.input.payload.batchId)
              continue;
            const url = `/v3/media/ratings-discussion/batches/${item.input.payload.batchId}`;
            const response = await get(url);
            ok(response);
            const batch = ratingsDiscussionBatchStatusSchema.parse(
              response.body,
            );
            const cancelled = await post(`${url}/cancel`, {
              protocol: 'ratings-discussion-media-v1',
              batchIdentityHash: batch.batchIdentityHash,
              expectedRevision: batch.revision,
            });
            ok(cancelled);
            assert.equal(
              ratingsDiscussionBatchStatusSchema.parse(cancelled.body).state,
              'cancelled',
            );
          }
        },
      );
    }
    await t.test(
      'fresh authorized clear retires the one cover while the ancestor icon stays bound',
      async () => {
        const draft = await coverDraft(targetId);
        const pending = await prepare(
          ratingTargetCoverIntentSchema.parse({
            ...draft,
            payload: { ...draft.payload, cover: { action: 'clear' } },
          }),
        );
        const database = app!.get(DatabaseService),
          original = database.transaction;
        const before = await graph(f);
        try {
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              await new CategoryIconMediaRequiredProof().capture(tx);
              database.transaction = async (work) => work(tx);
              const receipt = await app!
                .get(RatingScopedCommands)
                .submit(
                  owner.accessToken,
                  pending.input,
                  pending.contextRevision,
                );
              assert.equal(receipt.outcome, 'applied');
            }),
            (error) =>
              error instanceof ApplicationError &&
              error.code === 'MEDIA_UNAVAILABLE',
          );
        } finally {
          database.transaction = original;
        }
        assert.deepEqual(
          await graph(f),
          before,
          'An outer independent Media8 proof survives the legitimate cover mutation',
        );
        const response = await commit(pending);
        ok(response);
        const receipt = ratingTargetCoverReceiptSchema.parse(response.body);
        assert.equal(
          receipt.outcome,
          'applied',
          'The same original prepared key succeeds after outer-proof rollback',
        );
        recoveries.push({ pending, receipt });
        assert.equal((await coverHead(targetId)).content_version, 3);
        assert.equal((await coverHead(targetId)).envelope.cover, null);
        assert.equal(await activeCovers(targetId), 0);
        assert.equal(
          (
            await f.pool.query<{ count: number }>(
              'SELECT count(*)::int count FROM whaleu_media.bindings WHERE asset_id=$1 AND detached_at IS NULL',
              [icon.status.assetId],
            )
          ).rows[0]!.count,
          1,
        );
        await recoverApplied();
      },
    );
    assert.ok(
      pacedWindows > 0,
      'The unchanged shared 10/minute request-key limit was paced in real time',
    );
  },
);
