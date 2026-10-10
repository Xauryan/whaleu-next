/** TEST ONLY. Real AppModule, original scoped command owner, exact synthetic
 * Review and real Media processing; no trigger bypass or manufactured ready row. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../../src/app.module.js';
import { APP_CONFIG, type RuntimeConfig } from '../../../src/config/config.js';
import { configureHttp } from '../../../src/http/http.js';
import { ratingScopedCommandFixture } from '../rating-scoped-command-fixture.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';
import { canonicalJson } from '../../../src/community/content-review/contracts.js';
import {
  canonicalRatingDiscussionMediaEnvelope,
  ratingDiscussionMediaApprovalDigest,
} from '../../../src/community/content-review/rating-discussion-media-contracts.js';
import {
  RATINGS_DISCUSSION_MEDIA_RUNTIME,
  RatingDiscussionMediaService,
} from '../../../src/ratings/discussion-media.service.js';
import {
  ratingDiscussionContextSchema,
  ratingDiscussionCommandContextSchema,
  ratingDiscussionMediaIntentSchema,
  ratingDiscussionMediaPreparationSchema,
  ratingDiscussionMediaReceiptSchema,
  type RatingDiscussionMediaIntent,
} from '../../../src/ratings/scoped/discussion-media-contracts.js';
import {
  ratingsDiscussionBatchIdentitySchema,
  ratingsDiscussionBatchStatusSchema,
  ratingsDiscussionMemberStatusSchema,
  ratingsDiscussionMediaGrantSchema,
} from '../../../src/media/contracts-ratings-discussion.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import { SyntheticMediaStorage } from './synthetic-storage.js';
import { SyntheticMediaIngressStorage } from './synthetic-ingress-storage.js';
import {
  SyntheticMediaWorker,
  type RegisteredMediaFixture,
} from './synthetic-worker.js';
export function discussionHttpOk(response: {
  status: number;
  body: unknown;
}): void {
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
export async function issueSyntheticDiscussionCapabilities(
  pool: Pool,
  lifetimeMs = 20 * 60 * 1000,
): Promise<void> {
  assert.ok(
    Number.isSafeInteger(lifetimeMs) &&
      lifetimeMs > 0 &&
      lifetimeMs <= 20 * 60 * 1000,
  );
  await withCommunityScopeWriter(pool, async (tx) => {
    const versions = (
      await tx.query<{ id: string }>(
        "SELECT v.id FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE v.phase='adopted' ORDER BY v.id",
      )
    ).rows;
    assert.ok(versions.length);
    for (const version of versions)
      await tx.query(
        `WITH source AS (
      SELECT v.*,s.digest source_digest,s.valid_until source_until FROM whaleu_ratings.scope_protocol_versions v
      JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(v.capability_source_id,v.capability_source_revision) WHERE v.id=$1
    ), compatibility AS (
      SELECT source.*,whaleu_ratings.scoped_digest('discussion-media-compatibility',jsonb_build_object('commandVersion',4,'contextVersion',4,'reviewVersion',7,'mediaVersion',7,'journalVersion',12,
      'rootLimit',9,'replyLimit',3,'pureImage',true,'sourceId',capability_source_id,'sourceRevision',capability_source_revision,'sourceDigest',source_digest,'schemaDigest',$4::text,'routesDigest',$5::text,'nativeDigest',$6::text)) compatibility FROM source
    ) INSERT INTO whaleu_ratings.discussion_media_capability_sources(id,protocol_version_id,generation,source_id,source_revision,source_digest,command_version,context_version,review_version,media_version,journal_version,root_limit,reply_limit,pure_image,
      schema_digest,routes_digest,native_digest,compatibility_digest,adoption_digest,issuer,provenance_ref,valid_from,valid_until)
      SELECT $2,id,$3,capability_source_id,capability_source_revision,source_digest,4,4,7,7,12,9,3,true,$4,$5,$6,compatibility,
      whaleu_ratings.scoped_digest('discussion-media-adoption',jsonb_build_object('protocolVersionId',id,'protocolGeneration',generation,'generation',$3::uuid,'releaseId',release_id,'manifest',manifest,'compatibilityDigest',compatibility)),
      'synthetic-discussion-harness','synthetic-complete-owner-native-contract',clock_timestamp()-interval '1 second',least(source_until,clock_timestamp()+($7::integer*interval '1 millisecond')) FROM compatibility`,
        [
          version.id,
          randomUUID(),
          randomUUID(),
          '7'.repeat(64),
          '4'.repeat(64),
          'c'.repeat(64),
          lifetimeMs,
        ],
      );
  });
}
export async function writeSyntheticDiscussionApproval(
  pool: Pool,
  raw: unknown,
) {
  const envelope = canonicalRatingDiscussionMediaEnvelope(raw),
    digest = ratingDiscussionMediaApprovalDigest(envelope);
  return withCommunityScopeWriter(pool, async (tx) => {
    const policy = randomUUID(),
      decisionId = randomUUID(),
      event = randomUUID();
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
        .rows[0]!.now,
      evaluated = new Date(now.getTime() - 1000);
    await tx.query(
      "INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from) VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-discussion-review','synthetic-discussion-policy',$2)",
      [policy, new Date(evaluated.getTime() - 1000)],
    );
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model)
      VALUES($1,$2,$3,7,$4,$5::jsonb,$6,'allow','complete','accepted','synthetic-discussion-review','synthetic-exact-whole-set',$7,$8,'durable')`,
      [
        decisionId,
        envelope.accountId,
        envelope.purpose,
        digest,
        canonicalJson(envelope),
        policy,
        evaluated,
        new Date(now.getTime() + 3600000),
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','synthetic-discussion-review','synthetic-whole-set-event',$3)",
      [event, decisionId, evaluated],
    );
    await tx.query(
      'INSERT INTO whaleu_community.rating_approval_heads(decision_id,event_id) VALUES($1,$2)',
      [decisionId, event],
    );
    return { decisionId, digest, envelope };
  });
}
export async function syntheticRatingDiscussionFixture(
  fixtures: readonly RegisteredMediaFixture[],
  options: { registerCapabilities?: boolean } = {},
) {
  const base = await ratingScopedCommandFixture();
  let app: INestApplication | undefined,
    storage: SyntheticMediaStorage | undefined;
  try {
    assert.equal(base.app.get(RatingDiscussionMediaService).runtime, null);
    const target = await base.createScopedTarget();
    if (options.registerCapabilities !== false)
      await issueSyntheticDiscussionCapabilities(base.pool);
    storage = await SyntheticMediaStorage.create();
    const ingressStorage = new SyntheticMediaIngressStorage(storage);
    const module = await Test.createTestingModule({
      imports: [AppModule.register(base.app.get<RuntimeConfig>(APP_CONFIG))],
    })
      .overrideProvider(RATINGS_DISCUSSION_MEDIA_RUNTIME)
      .useValue({ planning: ingressStorage, storage, ingressStorage })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    const http = app.getHttpServer(),
      media = app.get(RatingDiscussionMediaService),
      worker = fixtures.length
        ? new SyntheticMediaWorker(base.pool, storage, fixtures)
        : null;
    type Actor = Awaited<ReturnType<typeof base.actor>>;
    const auth = (r: request.Test, actor: Actor) =>
      r.set('Authorization', `Bearer ${actor.accessToken}`);
    const context = async (actor: Actor, purpose: 'read' | 'interact') => {
      const response = await auth(
        request(http).post('/v4/ratings/discussion/contexts'),
        actor,
      ).send({ purpose, selector: { kind: 'global' }, mode: 'public' });
      discussionHttpOk(response);
      return ratingDiscussionContextSchema.parse(response.body);
    };
    const draft = async (
      actor: Actor,
      root?: { id: string; revision: string },
      replyTo: { replyId: string; expectedRevision: string } | null = null,
    ) => {
      const c = await context(actor, 'interact');
      const head = (
        await base.pool.query<{
          revision: string;
          definition_revision: string;
          content_version: number;
          category_id: string;
          effective_revision: string;
        }>(
          'SELECT t.revision,t.category_id,h.definition_revision,h.content_version,c.effective_revision FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id JOIN whaleu_ratings.scoped_categories c ON c.category_id=t.category_id AND c.catalog_id=$2 WHERE t.id=$1',
          [target.id, c.heads[0]!.catalogRevision],
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
          categoryId: head.category_id,
          expectedCategoryRevision: head.effective_revision,
          targetId: target.id,
          expectedTargetRevision: head.revision,
          expectedDefinitionRevision: head.definition_revision,
          expectedContentVersion: head.content_version,
          draftRevision: randomUUID(),
          batchRequestId: null,
          batchId: null,
          sealedPlanDigest: null,
          body: 'Synthetic discussion text',
          authorMode: 'named',
          images: [],
          ...(root
            ? { rootId: root.id, expectedRootRevision: root.revision, replyTo }
            : {}),
        },
      });
    };
    const ready = async (
      actor: Actor,
      intent: RatingDiscussionMediaIntent,
      images: readonly Buffer[],
      body = '',
      beforeFinalize?: (memberId: string) => Promise<void>,
      budgetSetupFinalize?: (
        memberId: string,
        sendOriginal: () => Promise<request.Response>,
      ) => Promise<request.Response>,
    ) => {
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
          targetId: intent.payload.targetId,
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
      let response = await auth(
        request(http).post('/v3/media/ratings-discussion/batches'),
        actor,
      ).send(identity);
      discussionHttpOk(response);
      let batch = ratingsDiscussionBatchStatusSchema.parse(response.body);
      const ordered: string[] = [];
      for (const [sourceSlot, bytes] of images.entries()) {
        const memberId = randomUUID();
        ordered.push(memberId);
        response = await auth(
          request(http).post('/v3/media/ratings-discussion/members'),
          actor,
        ).send({
          protocol: 'ratings-discussion-media-v1',
          batchId: batch.batchId,
          batchIdentityHash: batch.batchIdentityHash,
          clientRequestId: randomUUID(),
          memberId,
          sourceSlot,
          declaration: {
            mime: 'image/png',
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        });
        discussionHttpOk(response);
        response = await auth(
          request(http).post(
            `/v3/media/ratings-discussion/members/${memberId}/grant`,
          ),
          actor,
        ).send({});
        discussionHttpOk(response);
        const grant = ratingsDiscussionMediaGrantSchema.parse(response.body);
        response = await auth(
          request(http).post(
            `/v3/media/ratings-discussion/members/${memberId}/uploads/${grant.grantId}`,
          ),
          actor,
        ).attach('file', bytes, {
          filename: 'synthetic-discussion',
          contentType: 'image/png',
        });
        discussionHttpOk(response);
        await beforeFinalize?.(memberId);
        const sendOriginal = async () =>
          auth(
            request(http).post(
              `/v3/media/ratings-discussion/members/${memberId}/finalize`,
            ),
            actor,
          ).send({});
        response = budgetSetupFinalize
          ? await budgetSetupFinalize(memberId, sendOriginal)
          : await sendOriginal();
        discussionHttpOk(response);
        assert.ok(
          worker,
          'ready images require explicitly registered synthetic bytes',
        );
        for (const stage of ['seal', 'process', 'review'] as const)
          assert.equal(await worker.runOne(stage), true);
        response = await auth(
          request(http).get(`/v3/media/ratings-discussion/members/${memberId}`),
          actor,
        );
        discussionHttpOk(response);
        assert.equal(
          ratingsDiscussionMemberStatusSchema.parse(response.body).status,
          'ready_unbound',
        );
      }
      response = await auth(
        request(http).get(
          `/v3/media/ratings-discussion/batches/${batch.batchId}`,
        ),
        actor,
      );
      discussionHttpOk(response);
      batch = ratingsDiscussionBatchStatusSchema.parse(response.body);
      response = await auth(
        request(http).post(
          `/v3/media/ratings-discussion/batches/${batch.batchId}/seal`,
        ),
        actor,
      ).send({
        protocol: 'ratings-discussion-media-v1',
        batchId: batch.batchId,
        batchIdentityHash: batch.batchIdentityHash,
        expectedRevision: batch.revision,
        orderedMemberIds: ordered,
      });
      discussionHttpOk(response);
      batch = ratingsDiscussionBatchStatusSchema.parse(response.body);
      assert.ok(batch.sealedPlan);
      return {
        batch,
        identity,
        intent: ratingDiscussionMediaIntentSchema.parse({
          ...intent,
          payload: {
            ...intent.payload,
            body,
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
        }),
      };
    };
    const prepare = async (
      actor: Actor,
      intent: RatingDiscussionMediaIntent,
    ) => {
      const response = await auth(
        request(http).post('/v4/ratings/discussion/prepare'),
        actor,
      ).send(intent);
      discussionHttpOk(response);
      const prepared = ratingDiscussionMediaPreparationSchema.parse(
        response.body,
      );
      const row = (
        await base.pool.query<{ envelope: unknown }>(
          'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, intent.payload.clientRequestId],
        )
      ).rows[0]!;
      return {
        prepared,
        envelope: canonicalRatingDiscussionMediaEnvelope(row.envelope),
      };
    };
    const commit = (
      actor: Actor,
      intent: RatingDiscussionMediaIntent,
      revision: string,
    ) =>
      auth(request(http).post('/v4/ratings/discussion/commit'), actor).send({
        ...intent,
        preparationContextRevision: revision,
      });
    const execute = async (
      actor: Actor,
      intent: RatingDiscussionMediaIntent,
    ) => {
      const prepared = await prepare(actor, intent),
        approved = await writeSyntheticDiscussionApproval(
          base.pool,
          prepared.envelope,
        ),
        response = await commit(
          actor,
          intent,
          prepared.prepared.contextRevision,
        );
      discussionHttpOk(response);
      const receipt = ratingDiscussionMediaReceiptSchema.parse(response.body);
      if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
      return { ...prepared, approved, receipt };
    };
    return {
      ...base,
      baseApp: base.app,
      app,
      http,
      target,
      media,
      storage,
      worker,
      auth,
      context,
      draft,
      ready,
      prepare,
      commit,
      execute,
      close: async () => {
        await app?.close();
        await storage?.dispose();
        await base.close();
      },
    };
  } catch (error) {
    await app?.close();
    await storage?.dispose();
    await base.close();
    throw error;
  }
}
