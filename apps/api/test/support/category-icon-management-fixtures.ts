/** TEST ONLY. Empty original adopted catalog, explicit Category capability,
 * real HTTP/PG owners and opt-in synthetic Media DI. No provider or ready-row
 * shortcut. Source-only until run under the parent's exclusive PostgreSQL lease. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { configureHttp } from '../../src/http/http.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import {
  canonicalRatingCategoryIconEnvelope,
  ratingCategoryIconApprovalDigest,
  type RatingCategoryIconEnvelope,
} from '../../src/community/content-review/rating-category-icon-contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  categoryIconTextIntent,
  ratingCategoryIconContextSchema,
  ratingCategoryIconIntentSchema,
  ratingCategoryIconPreparationSchema,
  ratingCategoryIconReceiptSchema,
  ratingCategoryIconUploadScopeResultSchema,
  ratingCategoryIconUploadScopeSchema,
  ratingManagedCategoryIconSchema,
  ratingManagedCategoryIconsSchema,
  type RatingCategoryIconIntent,
  type RatingCategoryIconUploadScopeInput,
} from '../../src/ratings/category-management/icon-contracts.js';
import {
  ratingCategoryIconPublicContextSchema,
  ratingCategoryIconPageSchema,
} from '../../src/ratings/category-management/icon-public-contracts.js';
import type { CategoryIconPlan } from '../../src/ratings/category-management/icon-plan.js';
import type { CategoryManagementPlan } from '../../src/ratings/category-management/plan.js';
import { ratingCategoryScopedOperations } from '../../src/ratings/category-management/scoped-contracts.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';
import { RatingCategoryIconMediaService } from '../../src/ratings/category-management/icon-media.service.js';
import { RATINGS_CATEGORY_ICON_MEDIA_RUNTIME } from '../../src/ratings/category-management/icon-media-authority.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingScopedFixture,
  writeRatingScopedApproval,
} from './rating-scoped-fixture.js';
import { seedCategoryManagementSource } from './rating-category-management-fixture.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { SyntheticMediaStorage } from './media/synthetic-storage.js';
import { SyntheticMediaIngressStorage } from './media/synthetic-ingress-storage.js';
import {
  SyntheticMediaWorker,
  type RegisteredMediaFixture,
} from './media/synthetic-worker.js';
import { uploadCategoryIconViaHttp } from './media/category-icon-http-upload.js';

export const categoryIconManagementPrefix = '/v5/ratings/category-management';
export function categoryIconHttpOk(response: {
  status: number;
  body: unknown;
}) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

/** [] attests to the actual empty adoption only. Never use this registration
 * helper for a preexisting legacy/source root whose image state is unknown. */
export async function issueEmptyCategoryIconCapabilities(
  pool: Pool,
  includeGlobal = true,
) {
  await withCommunityScopeWriter(pool, async (tx) => {
    const inventory = (
      await tx.query<{ empty: boolean }>(`SELECT
      NOT EXISTS(SELECT 1 FROM whaleu_ratings.categories)
      AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_categories)
      AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_attestations
        WHERE source_kind IN ('legacy_adoption','scoped_category_base','scoped_category_override'))
      AND NOT EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_definition_heads) empty`)
    ).rows[0]!;
    assert.equal(
      inventory.empty,
      true,
      'Empty coverage cannot turn unknown legacy images into known absence',
    );
    const versions = (
      await tx.query<{ id: string }>(
        `SELECT v.id
      FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id
      WHERE v.phase='adopted' AND ($1::boolean OR v.logical_scope_key<>'global') ORDER BY v.id`,
        [includeGlobal],
      )
    ).rows;
    assert.ok(
      versions.length > 0,
      'The original owner must adopt and release its real empty catalogs first',
    );
    for (const { id } of versions) {
      await tx.query(
        `WITH source AS (
        SELECT v.*,s.digest source_digest,s.valid_until source_until,s.effective_at source_from,
          whaleu_ratings.category_icon_route_contract() routes,
          whaleu_ratings.category_icon_native_contract() native,
          whaleu_ratings.category_icon_digest('coverage-inventory','[]'::jsonb) coverage
        FROM whaleu_ratings.scope_protocol_versions v
        JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(v.capability_source_id,v.capability_source_revision)
        WHERE v.id=$1 AND v.phase='adopted' AND s.source_kind='scope_capabilities'
      ), compatibility AS (
        SELECT source.*,whaleu_ratings.category_icon_digest('compatibility',jsonb_build_object(
          'protocolVersion',5,'reviewVersion',8,'mediaVersion',8,'journalVersion',13,
          'extensionVersion','ratings-category-icon-v1','slots',ARRAY['icon'],
          'sourceId',capability_source_id,'sourceRevision',capability_source_revision,'sourceDigest',source_digest,
          'routesDigest',routes,'nativeDigest',native)) compatibility FROM source
      ) INSERT INTO whaleu_ratings.category_icon_capability_sources
        (id,protocol_version_id,source_id,source_revision,source_digest,protocol_version,review_version,media_version,journal_version,
          extension_version,slots,routes_digest,native_digest,compatibility_digest,adoption_digest,coverage_digest,coverage_inventory,
          issuer,provenance_ref,valid_from,valid_until)
        SELECT $2,id,capability_source_id,capability_source_revision,source_digest,5,8,8,13,
          'ratings-category-icon-v1',ARRAY['icon'],routes,native,compatibility,
          whaleu_ratings.category_icon_digest('adoption',jsonb_build_object('protocolVersionId',id,'generation',generation,
            'releaseId',release_id,'manifest',manifest,'compatibilityDigest',compatibility,'coverageDigest',coverage)),
          coverage,'[]'::jsonb,'ratings-category-icon-capability-owner','rating-category-icon-adoption:'||id::text||':'||capability_source_id::text||':'||capability_source_revision::text,
          greatest(source_from,clock_timestamp()-interval '1 second'),least(source_until,clock_timestamp()+interval '20 minutes') FROM compatibility`,
        [id, randomUUID()],
      );
    }
    const rows = (
      await tx.query<{ current: boolean }>(`SELECT
      whaleu_ratings.category_icon_capability_current(id,clock_timestamp()) current
      FROM whaleu_ratings.category_icon_capability_sources`)
    ).rows;
    assert.equal(rows.length, versions.length);
    assert.ok(rows.every((row) => row.current));
  });
}

/** Approval of exact persisted envelopes only; never supplies Review bindings,
 * owner definitions, projection rows or publication causes. */
async function writeCategoryIconApproval(tx: PoolClient, raw: unknown) {
  const envelope = canonicalRatingCategoryIconEnvelope(raw);
  const digest = ratingCategoryIconApprovalDigest(envelope);
  const policy = randomUUID(),
    decisionId = randomUUID(),
    eventId = randomUUID();
  const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
    .rows[0]!.now;
  const evaluatedAt = new Date(now.getTime() - 1000);
  await tx.query(
    `INSERT INTO whaleu_community.content_approval_policies
    (id,policy_key,version,coverage,provenance,issuer,provenance_ref,valid_from)
    VALUES($1,'local-explicit-v1',1,'complete','accepted','synthetic-category-icon-review','synthetic-review8-policy',$2)`,
    [policy, new Date(evaluatedAt.getTime() - 1000)],
  );
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_decisions
    (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,
      evaluated_at,consume_until,visibility_model)
    VALUES($1,$2,'publish_rating_category_icon',8,$3,$4::jsonb,$5,'allow','complete','accepted',
      'synthetic-category-icon-review','synthetic-exact-review8-envelope',$6,$7,'durable')`,
    [
      decisionId,
      envelope.accountId,
      digest,
      canonicalJson(envelope),
      policy,
      evaluatedAt,
      new Date(now.getTime() + 3600000),
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_events
    (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
    VALUES($1,$2,'allow','complete','accepted','synthetic-category-icon-review','synthetic-review8-event',$3)`,
    [eventId, decisionId, evaluatedAt],
  );
  await tx.query(
    'INSERT INTO whaleu_community.rating_approval_heads(decision_id,event_id) VALUES($1,$2)',
    [decisionId, eventId],
  );
  return { decisionId, digest, envelope };
}

export async function categoryIconManagementFixture(
  fixtures: readonly RegisteredMediaFixture[] = [],
  options: {
    runtime?: boolean;
    capabilities?: boolean;
    systemRegistry?: boolean;
    iconGlobal?: boolean;
    /** Test-only original-owner bootstrap. Each callback must issue and prove
     * actual original source/receipt lineage; no boolean coverage override. */
    bootstrap?: {
      beforeAdoption(
        base: Awaited<ReturnType<typeof ratingScopedFixture>>,
      ): Promise<void>;
      registerCapabilities(
        base: Awaited<ReturnType<typeof ratingScopedFixture>>,
      ): Promise<void>;
    };
  } = {},
) {
  const base = await ratingScopedFixture();
  let app: INestApplication | undefined,
    storage: SyntheticMediaStorage | undefined;
  try {
    const admin = base.creator;
    await base.grant(admin, 'super_admin');
    // The underlying fixture creates topology/actors, but no category/catalog.
    if (options.bootstrap) await options.bootstrap.beforeAdoption(base);
    else await base.declareAll();
    await base.capability();
    await withCommunityScopeWriter(base.pool, (tx) =>
      seedCategoryManagementSource(tx, {
        kind: 'native_scoped_category_management',
        key: 'synthetic-category-icon-management',
        scopeKeys: base.scopeKeys,
        payload: {
          enabled: true,
          operations: [...ratingCategoryScopedOperations],
        },
      }),
    );
    if (options.systemRegistry)
      await withCommunityScopeWriter(base.pool, (tx) =>
        seedCategoryManagementSource(tx, {
          kind: 'scoped_category_system_registry',
          key: 'synthetic-icon-system-registry',
          scopeKeys: base.scopeKeys,
          payload: {
            enabled: true,
            systemKey: 'synthetic_icon_general',
            kind: 'general',
            consumer: 'ratings_general_v1',
            maximumDepth: 3,
            allowChildren: true,
            allowDisable: true,
            allowCampusOverride: true,
          },
        }),
      );
    const adopted = await base.publish({ activate: true });
    if (!options.bootstrap) {
      assert.equal(
        (
          await base.pool.query(
            'SELECT 1 FROM whaleu_ratings.scoped_categories',
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await base.pool.query('SELECT 1 FROM whaleu_ratings.categories'))
          .rowCount,
        0,
      );
    }
    assert.equal(
      base.app.get(RatingCategoryIconMediaService).runtime,
      null,
      'Production composition stays unavailable',
    );
    if (options.capabilities !== false) {
      if (options.bootstrap) await options.bootstrap.registerCapabilities(base);
      else
        await issueEmptyCategoryIconCapabilities(
          base.pool,
          options.iconGlobal !== false,
        );
    }

    let worker: SyntheticMediaWorker | undefined;
    if (options.runtime !== false) {
      storage = await SyntheticMediaStorage.create();
      const ingressStorage = new SyntheticMediaIngressStorage(storage);
      const module = await Test.createTestingModule({
        imports: [AppModule.register(base.app.get<RuntimeConfig>(APP_CONFIG))],
      })
        .overrideProvider(RATINGS_CATEGORY_ICON_MEDIA_RUNTIME)
        .useValue({ planning: ingressStorage, storage, ingressStorage })
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      worker = new SyntheticMediaWorker(base.pool, storage, fixtures);
    }
    const http = (app ?? base.app).getHttpServer();
    type Actor = Awaited<ReturnType<typeof base.actor>>;
    const auth = (r: request.Test, actor: Actor = admin) =>
      r.set('Authorization', `Bearer ${actor.accessToken}`);
    const post = (route: string, body: object, actor: Actor = admin) =>
      auth(
        request(http).post(`${categoryIconManagementPrefix}/${route}`),
        actor,
      ).send(body);
    const context = async (
      selector: RatingNavigationSelector = { kind: 'global' },
      actor: Actor = admin,
    ) => {
      const response = await post('contexts', { selector }, actor);
      categoryIconHttpOk(response);
      return ratingCategoryIconContextSchema.parse(response.body);
    };
    const intent = (
      current: ReturnType<typeof ratingCategoryIconContextSchema.parse>,
      operation: RatingCategoryIconIntent['operation'],
      payload: Record<string, unknown>,
    ) =>
      ratingCategoryIconIntentSchema.parse({
        protocolVersion: 5,
        mediaSnapshot: current.mediaSnapshot,
        operation,
        context: current.commandContext,
        payload: {
          clientRequestId: randomUUID(),
          expectedSnapshot: current.snapshotRevision,
          ...payload,
        },
      });
    const prepare = async (
      input: RatingCategoryIconIntent,
      actor: Actor = admin,
    ) => {
      const response = await post('prepare', input, actor);
      categoryIconHttpOk(response);
      return ratingCategoryIconPreparationSchema.parse(response.body);
    };
    const stored = async (
      input: RatingCategoryIconIntent,
      actor: Actor = admin,
    ) => {
      const row = (
        await base.pool.query<{
          category_plan: CategoryManagementPlan;
          context_revision: string;
          outer_hash: string;
          text_hash: string;
          media_plan: {
            plan: CategoryIconPlan;
            reviewEnvelopes: RatingCategoryIconEnvelope[];
          };
        }>(
          `SELECT p.category_plan,p.context_revision,ip.outer_hash,ip.text_hash,ip.media_plan
        FROM whaleu_ratings.scoped_command_preparations p JOIN whaleu_ratings.category_icon_preparations ip
          ON (ip.actor_id,ip.request_id)=(p.account_id,p.request_id)
        WHERE p.account_id=$1 AND p.request_id=$2`,
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0];
      assert.ok(
        row,
        'Only an exact real persisted preparation may be approved',
      );
      return row;
    };
    const approveText = async (
      input: RatingCategoryIconIntent,
      actor: Actor = admin,
    ) => {
      const row = await stored(input, actor);
      return withCommunityScopeWriter(base.pool, async (tx) => {
        const decisions = [];
        for (const envelope of row.category_plan.envelopes)
          decisions.push(
            await writeRatingScopedApproval(
              tx,
              canonicalRatingScopedEnvelope(envelope),
            ),
          );
        return decisions;
      });
    };
    const approveIcons = async (
      input: RatingCategoryIconIntent,
      actor: Actor = admin,
    ) => {
      const row = await stored(input, actor);
      return withCommunityScopeWriter(base.pool, async (tx) => {
        const decisions = [];
        for (const envelope of row.media_plan.reviewEnvelopes)
          decisions.push(await writeCategoryIconApproval(tx, envelope));
        return decisions;
      });
    };
    const commit = (
      input: RatingCategoryIconIntent,
      revision: string,
      actor: Actor = admin,
    ) =>
      post(
        'commit',
        { intent: input, preparationContextRevision: revision },
        actor,
      );
    const execute = async (
      input: RatingCategoryIconIntent,
      actor: Actor = admin,
    ) => {
      const prepared = await prepare(input, actor);
      const text = await approveText(input, actor),
        icons = await approveIcons(input, actor);
      const response = await commit(input, prepared.contextRevision, actor);
      categoryIconHttpOk(response);
      const receipt = ratingCategoryIconReceiptSchema.parse(response.body);
      if (receipt.outcome === 'closed') assert.fail(JSON.stringify(receipt));
      return { input, prepared, text, icons, receipt };
    };
    const uploadDrafts = new Map<string, string>();
    const uploadDraft = (requestId: string) => {
      const prior = uploadDrafts.get(requestId);
      if (prior) return prior;
      const id = randomUUID();
      uploadDrafts.set(requestId, id);
      return id;
    };
    const scopeInput = (
      input: RatingCategoryIconIntent,
      slot: RatingCategoryIconUploadScopeInput['slot'],
      bytes: Buffer,
      mime: 'image/png' | 'image/jpeg' = 'image/png',
    ) =>
      ratingCategoryIconUploadScopeSchema.parse({
        ...categoryIconTextIntent(input),
        protocolVersion: 5,
        mediaSnapshot: input.mediaSnapshot,
        clientRequestId: randomUUID(),
        draftRevision: uploadDraft(input.payload.clientRequestId),
        slot,
        declaration: { mime, bytes: bytes.length, sha256: sha256(bytes) },
      });
    const ready = async (
      input: RatingCategoryIconIntent,
      slot: RatingCategoryIconUploadScopeInput['slot'],
      bytes: Buffer,
      mime: 'image/png' | 'image/jpeg' = 'image/png',
      actor: Actor = admin,
    ) => {
      assert.ok(
        worker,
        'Synthetic Media must be explicitly enabled for upload tests',
      );
      const scopeRequest = scopeInput(input, slot, bytes, mime);
      const response = await post('upload-scopes', scopeRequest, actor);
      categoryIconHttpOk(response);
      const scope = ratingCategoryIconUploadScopeResultSchema.parse(
        response.body,
      );
      const upload = await uploadCategoryIconViaHttp({
        http,
        accessToken: actor.accessToken,
        bytes,
        worker,
        prepare: {
          protocol: 'ratings-category-icon-media-v1',
          clientRequestId: scopeRequest.clientRequestId,
          editScopeId: scope.editScopeId,
          scopeRevision: scope.scopeRevision,
          slot: 'icon',
          declaration: scopeRequest.declaration,
        },
      });
      const replacement = {
        mode: 'replace' as const,
        assetId: upload.status.assetId,
        uploadScopeId: scope.editScopeId,
      };
      let payload: unknown;
      switch (input.operation) {
        case 'create_categories_scoped':
          assert.equal(slot.kind, 'new');
          payload = {
            ...input.payload,
            nodes: input.payload.nodes.map((node) =>
              slot.kind === 'new' && node.key === slot.key
                ? { ...node, icon: replacement }
                : node,
            ),
          };
          break;
        case 'batch_update_subcategories_scoped':
          assert.equal(slot.kind, 'new');
          payload = {
            ...input.payload,
            addNodes: input.payload.addNodes.map((node) =>
              slot.kind === 'new' && node.key === slot.key
                ? { ...node, icon: replacement }
                : node,
            ),
          };
          break;
        case 'create_system_category_scoped':
          assert.deepEqual(slot, { kind: 'new', key: 'root' });
          payload = { ...input.payload, icon: replacement };
          break;
        case 'edit_category_base_scoped':
          payload = { ...input.payload, icon: replacement };
          break;
        case 'set_category_override_scoped':
          payload = {
            ...input.payload,
            icon: { mode: 'set', value: replacement },
          };
          break;
        default:
          assert.fail(
            `Unsupported fixture upload operation: ${input.operation}`,
          );
      }
      return {
        ...upload,
        scopeRequest,
        scope,
        input: ratingCategoryIconIntentSchema.parse({ ...input, payload }),
      };
    };
    const list = async (
      selector: RatingNavigationSelector = { kind: 'global' },
      actor: Actor = admin,
    ) => {
      const c = await context(selector, actor);
      const response = await auth(
        request(http).get(`${categoryIconManagementPrefix}/categories`),
        actor,
      ).query({
        contextId: c.commandContext.id,
        contextToken: c.commandContext.token,
      });
      categoryIconHttpOk(response);
      return {
        context: c,
        page: ratingManagedCategoryIconsSchema.parse(response.body),
      };
    };
    const detail = async (
      id: string,
      selector: RatingNavigationSelector = { kind: 'global' },
      actor: Actor = admin,
    ) => {
      const c = await context(selector, actor);
      const response = await auth(
        request(http).get(`${categoryIconManagementPrefix}/categories/${id}`),
        actor,
      ).query({
        contextId: c.commandContext.id,
        contextToken: c.commandContext.token,
      });
      categoryIconHttpOk(response);
      return ratingManagedCategoryIconSchema.parse(response.body);
    };
    const publicPage = async (
      selector: RatingNavigationSelector = { kind: 'global' },
      actor: Actor = admin,
      parentId?: string,
    ) => {
      const response = await auth(
        request(http).post('/v5/ratings/contexts'),
        actor,
      ).send({ selector, purpose: 'read', mode: 'public' });
      categoryIconHttpOk(response);
      const c = ratingCategoryIconPublicContextSchema.parse(response.body);
      const page = await auth(
        request(http).get('/v5/ratings/categories'),
        actor,
      ).query({
        contextId: c.id,
        contextToken: c.token,
        limit: 50,
        ...(parentId ? { parentId } : {}),
      });
      categoryIconHttpOk(page);
      return {
        context: c,
        page: ratingCategoryIconPageSchema.parse(page.body),
      };
    };
    const artifacts = async () =>
      (
        await base.pool.query<{ value: unknown }>(`SELECT jsonb_build_object(
      'heads',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY root_key),'[]') FROM whaleu_ratings.category_icon_definition_heads h),
      'definitions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') FROM whaleu_ratings.category_icon_definitions d),
      'appearances',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM whaleu_ratings.category_icon_appearances a),
      'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY id),'[]') FROM whaleu_media.bindings b),
      'projections',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY catalog_id,category_id),'[]') FROM whaleu_ratings.category_icon_projections p),
      'releases',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY release_id),'[]') FROM whaleu_ratings.category_icon_release_manifests m),
      'retirements',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY appearance_id),'[]') FROM whaleu_ratings.category_icon_terminal_retirements r),
      'requests',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY account_id,request_id),'[]') FROM whaleu_ratings.requests r),
      'ownerEpoch',(SELECT epoch FROM whaleu_ratings.category_icon_epoch WHERE singleton),
      'mediaEpoch',(SELECT jsonb_agg(to_jsonb(s) ORDER BY slot) FROM whaleu_media.media_owner_states s)) value`)
      ).rows[0]!.value;
    const rejectSql = async (
      label: string,
      work: (tx: PoolClient) => Promise<unknown>,
    ) => {
      const before = await artifacts();
      await assert.rejects(
        withCommunityScopeWriter(base.pool, async (tx) => {
          await work(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        }),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23514',
        label,
      );
      assert.deepEqual(
        await artifacts(),
        before,
        `${label}: complete owner/Media transaction must roll back`,
      );
    };
    return {
      ...base,
      app: app ?? base.app,
      ordinaryHttp: base.http,
      http,
      admin,
      adopted,
      storage,
      worker,
      auth,
      post,
      context,
      intent,
      prepare,
      stored,
      approveText,
      approveIcons,
      commit,
      execute,
      scopeInput,
      ready,
      list,
      detail,
      publicPage,
      artifacts,
      rejectSql,
      close: async () => {
        try {
          await app?.close();
          await base.close();
        } finally {
          await storage?.dispose();
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
export type CategoryIconManagementFixture = Awaited<
  ReturnType<typeof categoryIconManagementFixture>
>;
