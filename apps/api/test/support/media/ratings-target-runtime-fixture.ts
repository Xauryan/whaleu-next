/** TEST ONLY: current adopted Ratings sources plus real Media processing. No
 * production issuer, disabled trigger, fake ready asset, or Profile authority. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { AppModule } from '../../../src/app.module.js';
import { APP_CONFIG, type RuntimeConfig } from '../../../src/config/config.js';
import { configureHttp } from '../../../src/http/http.js';
import { ratingScopedCommandFixture } from '../rating-scoped-command-fixture.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';
import { canonicalJson } from '../../../src/community/content-review/contracts.js';
import {
  canonicalRatingTargetCoverEnvelope,
  ratingTargetCoverApprovalDigest,
} from '../../../src/community/content-review/rating-target-cover-contracts.js';
import type { RatingTargetCoverEnvelope } from '../../../src/community/content-review/rating-target-cover-contracts.js';
import {
  RATINGS_TARGET_COVER_RUNTIME,
  RatingTargetCoverMediaService,
} from '../../../src/ratings/target-cover-media.service.js';
import { RatingScopedCommands } from '../../../src/ratings/scoped/commands.service.js';
import { ratingScopedCommandContextSchema } from '../../../src/ratings/scoped/contracts.js';
import {
  ratingTargetCoverContextSchema,
  ratingTargetCoverIntentSchema,
  ratingTargetCoverPreparationSchema,
  ratingTargetCoverReceiptSchema,
} from '../../../src/ratings/scoped/target-cover-contracts.js';
import type { RatingTargetCoverIntent } from '../../../src/ratings/scoped/target-cover-contracts.js';
import {
  prepareRatingsMediaSchema,
  ratingsMediaStatusSchema,
  ratingsMediaGrantSchema,
  ratingsMediaUploadObservedSchema,
} from '../../../src/media/contracts-ratings.js';
import { sha256 } from '../../../src/media/processing/protocol.js';
import { SyntheticMediaStorage } from './synthetic-storage.js';
import { SyntheticMediaIngressStorage } from './synthetic-ingress-storage.js';
import { SyntheticMediaWorker } from './synthetic-worker.js';
import type { RegisteredMediaFixture } from './synthetic-worker.js';

export function coverHttpOk(response: { status: number; body: unknown }): void {
  assert.equal(response.status, 200, JSON.stringify(response.body));
}
/** Evidence references the real immutable adopted version and its accepted
 * capability source. Hashes describe this synthetic harness only. */
export async function issueSyntheticTargetCoverCapabilities(
  pool: Pool,
  options: { protocolVersionIds?: readonly string[]; validForMs?: number } = {},
): Promise<void> {
  await withCommunityScopeWriter(pool, async (tx) => {
    const versions = (
      await tx.query<{
        id: string;
      }>(`SELECT v.id FROM whaleu_ratings.scope_protocol_heads h
      JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE v.phase='adopted' ORDER BY v.id`)
    ).rows;
    assert.ok(versions.length > 0);
    for (const version of versions) {
      if (
        options.protocolVersionIds &&
        !options.protocolVersionIds.includes(version.id)
      )
        continue;
      const present = await tx.query(
        'SELECT 1 FROM whaleu_ratings.target_cover_capability_sources WHERE protocol_version_id=$1',
        [version.id],
      );
      if (present.rowCount) continue;
      await tx.query(
        `WITH source AS (
        SELECT v.*,s.digest source_digest,s.valid_until source_until FROM whaleu_ratings.scope_protocol_versions v
        JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(v.capability_source_id,v.capability_source_revision)
        WHERE v.id=$1 AND v.phase='adopted' AND s.source_kind='scope_capabilities'
      ), compatibility AS (
        SELECT source.*,whaleu_ratings.scoped_digest('target-cover-compatibility',jsonb_build_object('protocolVersion',3,'reviewVersion',6,'journalVersion',11,
        'sourceId',capability_source_id,'sourceRevision',capability_source_revision,'sourceDigest',source_digest,'routesDigest',$3::text,'nativeDigest',$4::text)) compatibility
        FROM source
      ) INSERT INTO whaleu_ratings.target_cover_capability_sources(id,protocol_version_id,source_id,source_revision,source_digest,protocol_version,review_version,journal_version,
        routes_digest,native_digest,compatibility_digest,adoption_digest,issuer,provenance_ref,valid_from,valid_until)
        SELECT $2,id,capability_source_id,capability_source_revision,source_digest,3,6,11,$3,$4,compatibility,
        whaleu_ratings.scoped_digest('target-cover-adoption',jsonb_build_object('protocolVersionId',id,'generation',generation,'releaseId',release_id,'manifest',manifest,'compatibilityDigest',compatibility)),
        'synthetic-ratings-target-cover','synthetic-ratings-target-cover-harness',clock_timestamp()-interval '1 second',least(source_until,clock_timestamp()+make_interval(secs=>$5::double precision/1000)) FROM compatibility`,
        [
          version.id,
          randomUUID(),
          'a'.repeat(64),
          'b'.repeat(64),
          options.validForMs ?? 1200000,
        ],
      );
    }
  });
}
export async function writeSyntheticTargetCoverApproval(
  pool: Pool,
  raw: unknown,
) {
  const envelope = canonicalRatingTargetCoverEnvelope(raw),
    digest = ratingTargetCoverApprovalDigest(envelope);
  return withCommunityScopeWriter(pool, async (tx) => {
    const policy = randomUUID(),
      decisionId = randomUUID(),
      event = randomUUID();
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    const evaluated = new Date(now.getTime() - 1000);
    await tx.query(
      `INSERT INTO whaleu_community.content_approval_policies(id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from)
      VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-ratings-cover-review','synthetic-cover-policy',$2)`,
      [policy, new Date(evaluated.getTime() - 1000)],
    );
    await tx.query(
      `INSERT INTO whaleu_community.rating_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model)
      VALUES($1,$2,$3,6,$4,$5::jsonb,$6,'allow','complete','accepted','synthetic-ratings-cover-review','synthetic-exact-cover-envelope',$7,$8,'durable')`,
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
      `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
      VALUES($1,$2,'allow','complete','accepted','synthetic-ratings-cover-review','synthetic-exact-cover-event',$3)`,
      [event, decisionId, evaluated],
    );
    await tx.query(
      'INSERT INTO whaleu_community.rating_approval_heads(decision_id,event_id) VALUES($1,$2)',
      [decisionId, event],
    );
    return { decisionId, digest, envelope };
  });
}
const uploadScopeResponse = z.strictObject({
  protocolVersion: z.literal(3),
  scopeId: z.uuid(),
  scopeRevision: z.string(),
  targetId: z.uuid(),
  expiresAt: z.string(),
  prepare: prepareRatingsMediaSchema,
});

export async function syntheticRatingTargetCoverFixture(
  fixtures: readonly RegisteredMediaFixture[],
  options: { registerCapabilities?: boolean } = {},
) {
  const base = await ratingScopedCommandFixture();
  let app: INestApplication | undefined,
    storage: SyntheticMediaStorage | undefined;
  try {
    assert.equal(base.app.get(RatingTargetCoverMediaService).runtime, null);
    if (options.registerCapabilities !== false)
      await issueSyntheticTargetCoverCapabilities(base.pool);
    storage = await SyntheticMediaStorage.create();
    const ingressStorage = new SyntheticMediaIngressStorage(storage);
    const module = await Test.createTestingModule({
      imports: [AppModule.register(base.app.get<RuntimeConfig>(APP_CONFIG))],
    })
      .overrideProvider(RATINGS_TARGET_COVER_RUNTIME)
      .useValue({ planning: ingressStorage, storage, ingressStorage })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttp(app);
    await app.listen(0, '127.0.0.1');
    const http = app.getHttpServer(),
      media = app.get(RatingTargetCoverMediaService),
      commands = app.get(RatingScopedCommands);
    const worker = new SyntheticMediaWorker(base.pool, storage, fixtures);
    type Actor = Awaited<ReturnType<typeof base.actor>>;
    const auth = (r: request.Test, actor: Actor) =>
      r.set('Authorization', `Bearer ${actor.accessToken}`);
    const context = async (
      actor: Actor,
      purpose: 'read' | 'create_target' | 'edit_target',
    ) => {
      const response = await auth(
        request(http).post('/v3/ratings/target-cover/contexts'),
        actor,
      ).send({ purpose, selector: { kind: 'global' }, mode: 'public' });
      coverHttpOk(response);
      const value = ratingTargetCoverContextSchema.parse(response.body);
      assert.ok(value.capabilities.includes('target_cover'));
      return value;
    };
    const draft = async (actor: Actor, targetId?: string) => {
      const c = await context(
        actor,
        targetId ? 'edit_target' : 'create_target',
      );
      const categoryId = base.data.global.categoryId;
      const category = (
        await base.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [c.heads[0]!.catalogRevision, categoryId],
        )
      ).rows[0]!;
      const common = {
        protocolVersion: 3 as const,
        context: ratingScopedCommandContextSchema.parse({
          id: c.id,
          token: c.token,
          tokenDigest: c.tokenDigest,
          selector: c.selector,
          scopeRevision: c.scopeRevision,
          protocolGeneration: c.protocolGeneration,
          catalogRevision: c.heads[0]!.catalogRevision,
          headRevision: c.heads[0]!.headRevision,
          sourceDigest: c.sourceDigest,
        }),
        payload: {
          clientRequestId: randomUUID(),
          categoryId,
          expectedCategoryRevision: category.effective_revision,
          name: 'Synthetic cover target',
          description: 'Exact body and cover',
        },
      };
      if (!targetId)
        return ratingTargetCoverIntentSchema.parse({
          ...common,
          operation: 'create_target_scoped',
          payload: { ...common.payload, cover: { action: 'clear' } },
        });
      const response = await auth(
        request(http).get(
          `/v3/ratings/target-cover/targets/${targetId}/edit-context`,
        ),
        actor,
      ).query({ contextId: c.id, contextToken: c.token });
      coverHttpOk(response);
      const current = response.body as {
        revision: string;
        definitionRevision: string;
        contentVersion: number;
        name: string;
        description: string;
      };
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
    const ready = async (
      actor: Actor,
      input: RatingTargetCoverIntent,
      bytes: Buffer,
      mime: 'image/jpeg' | 'image/png' = 'image/png',
    ) => {
      const scopeResponse = await auth(
        request(http).post('/v3/ratings/target-cover/upload-scopes'),
        actor,
      ).send({
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
        declaration: { mime, bytes: bytes.length, sha256: sha256(bytes) },
      });
      coverHttpOk(scopeResponse);
      const scope = uploadScopeResponse.parse(scopeResponse.body);
      const prepared = await auth(
        request(http).post('/v3/media/ratings-target/upload-scopes'),
        actor,
      ).send(scope.prepare);
      coverHttpOk(prepared);
      const pending = ratingsMediaStatusSchema.parse(prepared.body);
      assert.equal(pending.editScopeId, scope.scopeId);
      const grantResponse = await auth(
        request(http).post(
          `/v3/media/ratings-target/upload-scopes/${scope.scopeId}/grant`,
        ),
        actor,
      ).send({});
      coverHttpOk(grantResponse);
      const grant = ratingsMediaGrantSchema.parse(grantResponse.body);
      const uploaded = await auth(
        request(http).post(
          `/v3/media/ratings-target/upload-scopes/${scope.scopeId}/uploads/${grant.grantId}`,
        ),
        actor,
      ).attach('file', bytes, {
        filename: 'synthetic-cover',
        contentType: mime,
      });
      coverHttpOk(uploaded);
      assert.equal(
        ratingsMediaUploadObservedSchema.parse(uploaded.body).sha256,
        sha256(bytes),
      );
      coverHttpOk(
        await auth(
          request(http).post(
            `/v3/media/ratings-target/upload-scopes/${scope.scopeId}/finalize`,
          ),
          actor,
        ).send({}),
      );
      for (const stage of ['seal', 'process', 'review'] as const)
        assert.equal(await worker.runOne(stage), true);
      const response = await auth(
        request(http).get(
          `/v3/media/ratings-target/upload-scopes/${scope.scopeId}`,
        ),
        actor,
      );
      coverHttpOk(response);
      const status = ratingsMediaStatusSchema.parse(response.body);
      if (status.status !== 'ready_unbound')
        assert.fail(JSON.stringify(status));
      return {
        scope,
        status,
        input: ratingTargetCoverIntentSchema.parse({
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
    const prepare = async (actor: Actor, input: RatingTargetCoverIntent) => {
      const response = await auth(
        request(http).post('/v3/ratings/target-cover/prepare'),
        actor,
      ).send(input);
      coverHttpOk(response);
      const prepared = ratingTargetCoverPreparationSchema.parse(response.body);
      const row = (
        await base.pool.query<{ envelope: RatingTargetCoverEnvelope }>(
          'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0];
      assert.ok(row);
      return {
        prepared,
        approved: await writeSyntheticTargetCoverApproval(
          base.pool,
          row.envelope,
        ),
      };
    };
    const send = (
      actor: Actor,
      input: RatingTargetCoverIntent,
      revision: string,
    ) =>
      auth(request(http).post('/v3/ratings/target-cover/commit'), actor).send({
        ...input,
        preparationContextRevision: revision,
      });
    const execute = async (actor: Actor, input: RatingTargetCoverIntent) => {
      const prepared = await prepare(actor, input),
        response = await send(actor, input, prepared.prepared.contextRevision);
      coverHttpOk(response);
      const receipt = ratingTargetCoverReceiptSchema.parse(response.body);
      if (receipt.outcome !== 'applied' && receipt.outcome !== 'noop')
        assert.fail(JSON.stringify(receipt));
      return {
        ...prepared,
        receipt,
        input,
        result: receipt.result as {
          targetId: string;
          revision: string;
          definitionRevision?: string;
          contentVersion?: number;
        },
      };
    };
    const read = async (actor: Actor, targetId: string) => {
      const c = await context(actor, 'read');
      const response = await auth(
        request(http).get(`/v3/ratings/target-cover/targets/${targetId}`),
        actor,
      ).query({ contextId: c.id, contextToken: c.token });
      coverHttpOk(response);
      return response.body as {
        cover: null | {
          targetId: string;
          appearanceId: string;
          bindingId: string;
          contextId: string;
          contextToken: string;
        };
        target: { id: string };
      };
    };
    const currentApp = app,
      currentStorage = storage;
    return {
      ...base,
      app: currentApp,
      ordinaryHttp: base.app.getHttpServer(),
      http,
      storage: currentStorage,
      ingressStorage,
      worker,
      media,
      commands,
      auth,
      context,
      draft,
      ready,
      prepare,
      send,
      execute,
      read,
      close: async () => {
        try {
          await currentApp.close();
          await base.close();
        } finally {
          await currentStorage.dispose();
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
      await base.close();
    } finally {
      await storage?.dispose();
    }
    throw error;
  }
}
export type RatingTargetCoverFixture = Awaited<
  ReturnType<typeof syntheticRatingTargetCoverFixture>
>;
