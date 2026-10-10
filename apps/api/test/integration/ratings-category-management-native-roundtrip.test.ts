/** Disposable synthetic policy/registry and real owners, HTTP, Review and PostgreSQL.
 * No production provider, final-projection writes, constraint bypass or epoch reset. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import request from 'supertest';
import {
  ratingScopedFixture,
  writeRatingScopedApproval,
} from '../support/rating-scoped-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import { platformStorage } from '../support/experience-native-bridge.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import {
  ratingCategoryScopedIntentHash,
  ratingCategoryScopedIntentSchema,
  ratingCategoryScopedOperations,
  ratingCategoryScopedReceiptSchema,
  ratingCategoryScopedPreparationSchema,
  ratingManagedCategoriesSchema,
  type RatingCategoryScopedIntent,
} from '../../src/ratings/category-management/scoped-contracts.js';
import {
  ratingScopedIntentSchema,
  type RatingNavigationSelector,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import { RatingScopedCommands } from '../../src/ratings/scoped/commands.service.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';

const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  RatingCategoryScopedController,
} = require('../../../wechat/src/ratings/category-scoped-controller.ts');
const {
  RatingScopedController,
} = require('../../../wechat/src/ratings/scoped-controller.ts');
const {
  ratingCategoryScopedIntentHash: nativeCategoryHash,
} = require('../../../wechat/src/ratings/category-scoped-contract.ts');
const {
  decodeRatingScopedIntent,
} = require('../../../wechat/src/ratings/scoped-contract.ts');
const {
  decodeRatingCommandIntent,
} = require('../../../wechat/src/ratings/pending.ts');

type ManagedCategory = ReturnType<
  typeof ratingManagedCategoriesSchema.parse
>['items'][number];

interface ManagementView {
  loaded: boolean;
  frozen: boolean;
  busy: boolean;
  error: string;
  name: string;
  description: string;
  operation: string;
  systemKey: string;
  levelCount: number;
  nodes: readonly { key: string; parentKey: string | null }[];
  preview: { lines: readonly string[] } | null;
  receiptStatus: string;
  order: readonly { key: string; label: string }[];
  systemOptions: readonly { systemKey: string }[];
}
interface Pending {
  version: 10;
  accountId: string;
  intent: RatingCategoryScopedIntent;
}
interface Sent {
  method: string;
  path: string;
}
class ManagementTransport extends DirectoryHttpTransport {
  readonly sent: Sent[] = [];
  readonly responseCodes: { status: number; code: string | null }[] = [];
  beforeSend: (() => Promise<void>) | null = null;
  constructor(port: number) {
    super(port);
    this.checkResponse = (_path, status, body) => {
      const error =
        typeof body === 'object' && body !== null && 'error' in body
          ? body.error
          : null;
      const candidate =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : null;
      this.responseCodes.push({
        status,
        code:
          typeof candidate === 'string' &&
          /^[A-Z][A-Z0-9_]{1,99}$/.test(candidate)
            ? candidate
            : null,
      });
    };
  }
  diagnostics(): string {
    return JSON.stringify({
      exchanges: this.exchanges.slice(-3).map((exchange) => ({
        method: exchange.method,
        path: exchange.path.split('?')[0],
        status: exchange.status,
        authorized: exchange.authorized,
      })),
      responseCodes: this.responseCodes.slice(-3),
    });
  }
  override async send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    await this.beforeSend?.();
    const url = new URL(input.url);
    this.sent.push({
      method: input.method,
      path: url.pathname,
    });
    const response = await super.send(input);
    if (response.status === 200 && url.pathname.startsWith('/v2/ratings')) {
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['vary'], 'Authorization');
    }
    return response;
  }
}

/** New source kinds cannot be passed to the old fixture's closed union. This
 * test-local initial issuer uses its normal source digest/head constraints and
 * is called only before the first adopted release. */
async function seedManagementSource(
  tx: PoolClient,
  input: {
    kind:
      'native_scoped_category_management' | 'scoped_category_system_registry';
    key: string;
    scopeKeys: readonly string[];
    payload: Record<string, unknown>;
  },
) {
  const id = randomUUID(),
    revision = randomUUID(),
    scopeKeys = [...new Set(input.scopeKeys)].sort();
  const existing = await tx.query(
    'SELECT 1 FROM whaleu_ratings.scoped_source_heads WHERE source_kind=$1 AND source_key=$2',
    [input.kind, input.key],
  );
  assert.equal(
    existing.rowCount,
    0,
    'Initial fixture source must never overwrite a live predecessor',
  );
  const inserted = await tx.query(
    `WITH instant AS MATERIALIZED(SELECT clock_timestamp() now)
    INSERT INTO whaleu_ratings.scoped_source_attestations
    (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
    SELECT $1,$2,$3,$4,$5::text[],$6::jsonb,
      whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,'kind',$3::text,'key',$4::text,'scopeKeys',$5::text[],'payload',$6::jsonb)),
      'complete','accepted','synthetic-scoped-issuer','synthetic-native-management:'||$1::text,'synthetic-category-management-policy',instant.now,instant.now+interval '30 minutes'
    FROM instant`,
    [
      id,
      revision,
      input.kind,
      input.key,
      scopeKeys,
      canonicalJson(input.payload),
    ],
  );
  assert.equal(inserted.rowCount, 1);
  await tx.query(
    'INSERT INTO whaleu_ratings.scoped_source_heads(source_kind,source_key,source_id,source_revision) VALUES($1,$2,$3,$4)',
    [input.kind, input.key, id, revision],
  );
}

test(
  'M3C real native v10 editors → authenticated HTTP → exact Review → source release, scope exits and original cleanup recovery',
  { timeout: 600000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const actor = f.creator,
      managementGrant = await f.grant(actor, 'super_admin');
    const data = await f.seedScopedCatalogs({ different: false });
    // All issuance precedes activation. No adopted catalog is made stale by a
    // standalone seed write, and the normal full-domain compiler publishes it.
    await f.issueSource({
      kind: 'native_scoped_create',
      key: 'synthetic-native-scoped-create',
      scopeKeys: f.scopeKeys,
      payload: {
        enabled: true,
        genericKind: 'general',
        scopeKeys: f.scopeKeys,
      },
    });
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await seedManagementSource(tx, {
        kind: 'native_scoped_category_management',
        key: 'synthetic-native-category-management',
        scopeKeys: f.scopeKeys,
        payload: {
          enabled: true,
          operations: [...ratingCategoryScopedOperations],
          scopeKeys: f.scopeKeys,
        },
      });
      await seedManagementSource(tx, {
        kind: 'scoped_category_system_registry',
        key: 'synthetic-native-general-registry',
        scopeKeys: f.scopeKeys,
        payload: {
          enabled: true,
          systemKey: 'native_roundtrip_general',
          kind: 'general',
          consumer: 'ratings_general_v1',
          maximumDepth: 3,
          allowCampusOverride: true,
          allowDisable: true,
          allowChildren: true,
        },
      });
    });
    await f.publish({ activate: true });
    type Actor = typeof actor;
    const selectorA: RatingNavigationSelector = {
        kind: 'campus',
        campusId: f.campusA,
      },
      selectorB: RatingNavigationSelector = {
        kind: 'campus',
        campusId: f.campusB,
      };
    const campusSelectors: readonly RatingNavigationSelector[] = [
      selectorA,
      selectorB,
    ];
    const respectReadBudget = async () => {
      const row = (
        await f.pool.query<{ wait: number }>(
          `SELECT coalesce(max(greatest(0,extract(epoch FROM greatest(expires_at,coalesce(blocked_until,expires_at))-clock_timestamp())*1000)),0)::double precision wait FROM whaleu_runtime.request_throttle_counters WHERE total_hits>=100`,
        )
      ).rows[0]!;
      if (row.wait > 0) await delay(Math.ceil(row.wait) + 25);
    };
    const freshSession = async (owner: Actor): Promise<Actor> => {
      const identity = (
        await f.pool.query<{
          provider: 'wechat';
          app_id: string;
          subject: string;
        }>(
          'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0]!;
      const accessToken = mintToken('access'),
        refreshToken = mintToken('refresh');
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: identity.provider,
          appId: identity.app_id,
          subject: identity.subject,
        },
        { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
      );
      assert.notEqual(session.sessionId, owner.sessionId);
      return { ...owner, ...session, accessToken, refreshToken };
    };
    function native(owner: Actor = actor, device = platformStorage()) {
      const transport = new ManagementTransport(f.port),
        sessions = new SessionStore();
      transport.beforeSend = respectReadBudget;
      sessions.completeLogin(sessions.beginLogin(), owner);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error(
              'No external identity provider in a disposable fixture',
            );
          },
        },
        systemClock,
      );
      const api = new ApiClient(
          directoryNativeOrigin,
          transport,
          sessions,
          auth,
        ),
        runtime = createCommunityRuntime(
          { sessions, api },
          device,
          directoryNativeOrigin,
        );
      const views: ManagementView[] = [],
        changes: unknown[] = [];
      const controller = new RatingCategoryScopedController(
        runtime,
        (view: ManagementView) => views.push(view),
        true,
      );
      t.after(() => controller.dispose());
      runtime.ratingCatalogChanges.subscribe((change: unknown) =>
        changes.push(change),
      );
      return {
        owner,
        device,
        transport,
        sessions,
        runtime,
        controller,
        changes,
        cancel: new Cancellation(),
        view: () => views.at(-1)!,
        pending: () =>
          runtime.pendingRatings.load(owner.accountId) as Pending | null,
      };
    }
    const nativeClient = native();
    const route = (
      categoryId?: string,
      selector: RatingNavigationSelector = selectorA,
    ) => ({
      scope: selector.kind,
      ...(selector.kind === 'campus' ? { campusId: selector.campusId } : {}),
      ...(categoryId ? { categoryId } : {}),
    });
    const prepareNative = async (client: ReturnType<typeof native>) => {
      await client.controller.prepare();
      assert.equal(client.view().frozen, true, client.view().error);
      assert.ok(client.view().preview, client.view().error);
      const pending = client.pending();
      assert.ok(pending);
      assert.equal(pending.version, 10);
      const intent = ratingCategoryScopedIntentSchema.parse(pending.intent);
      assert.equal(
        nativeCategoryHash(pending.intent),
        ratingCategoryScopedIntentHash(intent),
      );
      assert.equal(
        client.transport.sent.filter(
          (row) => row.path === '/v2/ratings/category-management/commit',
        ).length,
        0,
        'Preparing a new native client must not submit a commit',
      );
      return pending;
    };
    const approveManagement = async (pending: Pending) => {
      const row = (
        await f.pool.query<{ category_plan: { envelopes: unknown[] } }>(
          "SELECT category_plan FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2 AND command_family='category'",
          [pending.accountId, pending.intent.payload.clientRequestId],
        )
      ).rows[0];
      assert.ok(
        row,
        'Exact category preparation must exist before issuing Review decisions',
      );
      const envelopes = row.category_plan.envelopes.map(
        canonicalRatingScopedEnvelope,
      );
      await withCommunityScopeWriter(f.pool, async (tx) => {
        for (const envelope of envelopes) {
          assert.equal(envelope.accountId, pending.accountId);
          await writeRatingScopedApproval(tx, envelope);
        }
      });
      return envelopes;
    };
    const receiptFor = async (pending: Pending) => {
      const response = await f.auth(
        request(f.http).get(
          `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
        ),
        actor,
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      const receipt = ratingCategoryScopedReceiptSchema.parse(response.body);
      assert.notEqual(receipt.outcome, 'closed', JSON.stringify(receipt));
      if (receipt.outcome === 'closed') assert.fail();
      return receipt;
    };
    const commitNative = async (
      client: ReturnType<typeof native>,
      pending: Pending,
    ) => {
      await client.controller.commit();
      assert.equal(
        client.pending() === null,
        true,
        `${client.view().error}; ${client.transport.diagnostics()}`,
      );
      assert.match(client.view().receiptStatus, /回执已确认/);
      return receiptFor(pending);
    };
    const readCategories = async (selector: RatingNavigationSelector) => {
      await respectReadBudget();
      const result = await f.scopedCategories(actor, selector);
      return result.page.items;
    };
    const reviewSnapshot = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'decisions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb) FROM whaleu_community.rating_approval_decisions d),
    'events',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id),'[]'::jsonb) FROM whaleu_community.rating_approval_events e),
    'bindings',(SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.source_id,b.source_revision),'[]'::jsonb) FROM whaleu_community.rating_scoped_category_source_bindings b)) state`)
      ).rows[0]!.state;
    const readManaged = async (
      client: ReturnType<typeof native>,
      selector: RatingNavigationSelector = selectorA,
    ): Promise<ManagedCategory[]> => {
      const context = await client.runtime.ratingCategoryScoped.context(
        selector,
        client.cancel,
      );
      return ratingManagedCategoriesSchema.parse(
        await client.runtime.ratingCategoryScoped.categories(
          context,
          client.cancel,
        ),
      ).items;
    };
    const mutateNative = async (
      categoryId: string | undefined,
      operation: RatingCategoryScopedIntent['operation'],
      configure: (client: ReturnType<typeof native>) => void | Promise<void>,
      expectedReviews: number,
    ) => {
      const client = native();
      await client.controller.load(route(categoryId));
      assert.equal(
        client.view().loaded,
        true,
        `${operation}: ${client.view().error}; ${client.transport.diagnostics()}`,
      );
      client.controller.selectOperation(operation);
      assert.equal(
        client.view().operation,
        operation,
        'Requested native operation must actually be available',
      );
      await configure(client);
      const pending = await prepareNative(client);
      assert.equal(pending.intent.operation, operation);
      const envelopes = await approveManagement(pending);
      assert.equal(
        envelopes.length,
        expectedReviews,
        `${operation} Review envelope count`,
      );
      const receipt = await commitNative(client, pending);
      return { client, pending, envelopes, receipt };
    };
    const requireCategory = () =>
      assert.ok(
        createdCategoryId,
        'Dependency failed: ordinary native category creation did not yield its real committed category ID',
      );
    let createdCategoryId = '';
    let creationPending!: Pending;
    let baseEditComplete = false;
    let inheritComplete = false;
    let metadataCycleComplete = false;

    await t.test(
      'ordinary native creation prepares, reviews and atomically publishes both explicit campuses; other native pages invalidate',
      async () => {
        let observerLoaded = false;
        const observer = new RatingScopedController(
          nativeClient.runtime,
          (view: { loaded: boolean }) => {
            observerLoaded = view.loaded;
          },
        );
        t.after(() => observer.dispose());
        await observer.load({
          mode: 'catalog',
          scope: 'campus',
          campusId: f.campusB,
        });
        assert.equal(observerLoaded, true);
        await nativeClient.controller.load(route());
        assert.equal(
          nativeClient.view().loaded,
          true,
          nativeClient.view().error,
        );
        assert.ok(
          nativeClient
            .view()
            .systemOptions.some(
              (option) => option.systemKey === 'native_roundtrip_general',
            ),
        );
        nativeClient.controller.selectOperation('create_categories_scoped');
        nativeClient.controller.setNodeText(
          'n0',
          'name',
          'Native managed root 🌊',
        );
        nativeClient.controller.setNodeText(
          'n0',
          'description',
          'Shared native description',
        );
        await nativeClient.controller.openCampusPicker('placement');
        await nativeClient.controller.selectCampus(f.campusB);
        nativeClient.controller.closeCampusPicker();
        creationPending = await prepareNative(nativeClient);
        assert.equal(
          creationPending.intent.operation,
          'create_categories_scoped',
        );
        if (creationPending.intent.operation === 'create_categories_scoped')
          assert.deepEqual(creationPending.intent.payload.placement, {
            kind: 'campuses',
            campusIds: [f.campusA, f.campusB].sort(),
          });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, creationPending.intent.payload.clientRequestId],
            )
          ).rowCount,
          0,
        );
        const envelopes = await approveManagement(creationPending);
        assert.equal(envelopes.length, 1);
        assert.equal(
          envelopes[0]!.purpose,
          'publish_rating_category_base_scoped',
        );
        const receipt = await commitNative(nativeClient, creationPending);
        assert.equal(receipt.outcome, 'applied');
        assert.equal(receipt.result.categoryIds.length, 1);
        createdCategoryId = receipt.result.categoryIds[0]!;
        assert.equal(
          observerLoaded,
          false,
          'Existing native view must clear after a real release event',
        );
        assert.equal(nativeClient.changes.length, 1);
        assert.match(
          nativeClient.controller.catalogPath(),
          new RegExp(f.campusA),
        );
        for (const selector of campusSelectors) {
          const row = (await readCategories(selector)).find(
            (c) => c.id === createdCategoryId,
          );
          assert.equal(row?.name, 'Native managed root 🌊');
          assert.equal(row?.description, 'Shared native description');
        }
        assert.equal(
          (await readCategories({ kind: 'global' })).some(
            (c) => c.id === createdCategoryId,
          ),
          false,
        );
        await observer.reload();
        assert.equal(observerLoaded, true);
        const actorAgain = await freshSession(actor),
          restored = native(actorAgain);
        assert.deepEqual(
          await restored.runtime.ratingCategoryScoped.receipt(
            creationPending.intent.payload.clientRequestId,
            restored.cancel,
          ),
          receipt,
        );
      },
    );

    await t.test(
      'native empty override and shared base edits issue fresh exact Review and preserve explicit campus field modes',
      async () => {
        requireCategory();
        const overrideClient = native();
        await overrideClient.controller.load(route(createdCategoryId));
        assert.equal(
          overrideClient.view().loaded,
          true,
          overrideClient.view().error,
        );
        overrideClient.controller.selectOperation(
          'set_category_override_scoped',
        );
        overrideClient.controller.choose('nameMode', 'set');
        overrideClient.controller.setText('name', 'Campus A managed name');
        overrideClient.controller.choose('descriptionMode', 'set');
        overrideClient.controller.setText('description', '');
        const pending = await prepareNative(overrideClient),
          envelopes = await approveManagement(pending);
        assert.equal(envelopes.length, 1);
        assert.equal(
          envelopes[0]!.purpose,
          'publish_rating_category_override_scoped',
        );
        await commitNative(overrideClient, pending);
        assert.equal(
          (await readCategories(selectorA)).find(
            (c) => c.id === createdCategoryId,
          )?.description,
          '',
        );
        assert.equal(
          (await readCategories(selectorB)).find(
            (c) => c.id === createdCategoryId,
          )?.description,
          'Shared native description',
        );
        const baseClient = native();
        await baseClient.controller.load(route(createdCategoryId));
        baseClient.controller.selectOperation('edit_category_base_scoped');
        baseClient.controller.setText('name', 'New shared base name');
        baseClient.controller.setText(
          'description',
          'New shared base description',
        );
        const basePending = await prepareNative(baseClient);
        // Re-read the exact original preparation through the real native gateway;
        // neither the journal nor its approval-bound preview is replaced.
        const basePreview = ratingCategoryScopedPreparationSchema.parse(
          await baseClient.runtime.ratingCategoryScoped.prepare(
            basePending.intent,
            baseClient.cancel,
          ),
        );
        const sharedChange = basePreview.changes.find(
          (change) =>
            change.categoryId === createdCategoryId &&
            change.field === 'base_body',
        );
        assert.ok(
          sharedChange,
          'Shared base edits must identify the base body independently of selected-campus overrides',
        );
        assert.equal(sharedChange.beforeStatus, 'available');
        assert.equal(sharedChange.afterStatus, 'available');
        assert.ok(sharedChange.before && sharedChange.after);
        const sharedBefore = JSON.parse(sharedChange.before) as Record<
          string,
          unknown
        >;
        const sharedAfter = JSON.parse(sharedChange.after) as Record<
          string,
          unknown
        >;
        assert.equal(sharedBefore['name'], 'Native managed root 🌊');
        assert.equal(sharedBefore['description'], 'Shared native description');
        assert.equal(sharedAfter['name'], 'New shared base name');
        assert.equal(sharedAfter['description'], 'New shared base description');
        const effectiveAfter = (campusId: string) => {
          const change = basePreview.changes.find(
            (change) =>
              change.categoryId === createdCategoryId &&
              change.field === 'effective_body' &&
              change.scopeKeys.includes(`campus:${campusId}`),
          );
          assert.ok(
            change?.after,
            'Every actual campus view needs an explicit effective-body preview',
          );
          assert.equal(change.beforeStatus, 'available');
          assert.equal(change.afterStatus, 'available');
          return JSON.parse(change.after) as Record<string, unknown>;
        };
        const previewA = effectiveAfter(f.campusA),
          previewB = effectiveAfter(f.campusB);
        assert.equal(previewA['name'], 'Campus A managed name');
        assert.equal(previewA['description'], '');
        assert.deepEqual(previewA['modes'], {
          name: { mode: 'set', value: 'Campus A managed name' },
          description: { mode: 'set', value: '' },
        });
        assert.deepEqual(previewB['modes'], {
          name: { mode: 'inherit' },
          description: { mode: 'inherit' },
        });
        assert.equal(previewB['name'], 'New shared base name');
        assert.equal(previewB['description'], 'New shared base description');
        for (const preview of [previewA, previewB]) {
          assert.equal(preview['applicable'], true);
          assert.equal(preview['hidden'], false);
        }
        assert.match(
          baseClient.view().preview!.lines.join('\n'),
          /共享基础正文/,
        );
        assert.match(
          baseClient.view().preview!.lines.join('\n'),
          /该范围实际显示正文/,
        );
        assert.match(
          baseClient.view().preview!.lines.join('\n'),
          /简介：（明确为空）/,
        );
        const baseEnvelopes = await approveManagement(basePending);
        assert.equal(
          baseEnvelopes.length,
          2,
          'Base successor and dependent campus override require exact new Review',
        );
        await commitNative(baseClient, basePending);
        const a = (await readCategories(selectorA)).find(
            (c) => c.id === createdCategoryId,
          ),
          b = (await readCategories(selectorB)).find(
            (c) => c.id === createdCategoryId,
          );
        assert.equal(a?.name, 'Campus A managed name');
        assert.equal(a?.description, '');
        assert.equal(b?.name, 'New shared base name');
        assert.equal(b?.description, 'New shared base description');
        assert.deepEqual(
          { name: a?.name, description: a?.description },
          { name: previewA['name'], description: previewA['description'] },
          'Campus A publishes exactly its empty-override preview',
        );
        assert.deepEqual(
          { name: b?.name, description: b?.description },
          { name: previewB['name'], description: previewB['description'] },
          'Campus B publishes exactly its inherited-base preview',
        );
        const historyContext =
          await baseClient.runtime.ratingCategoryScoped.context(
            selectorA,
            baseClient.cancel,
          );
        const history = await baseClient.runtime.ratingCategoryScoped.history(
          historyContext,
          createdCategoryId,
          null,
          baseClient.cancel,
        );
        assert.ok(
          history.items.some(
            (item: { requestId: string }) =>
              item.requestId === basePending.intent.payload.clientRequestId,
          ),
        );
        baseEditComplete = true;
      },
    );

    await t.test(
      'native complete sibling reorder changes public order without changing any Review bytes, decisions or bindings',
      async () => {
        requireCategory();
        const client = native();
        await client.controller.load(route(createdCategoryId));
        client.controller.selectOperation('reorder_categories_scoped');
        const before = await reviewSnapshot(),
          first = client
            .view()
            .order.findIndex((item) => item.key === createdCategoryId);
        assert.ok(first > 0);
        for (let index = 0; index < first; index++)
          client.controller.move(createdCategoryId, 'up');
        const pending = await prepareNative(client),
          row = (
            await f.pool.query<{ category_plan: { envelopes: unknown[] } }>(
              'SELECT category_plan FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, pending.intent.payload.clientRequestId],
            )
          ).rows[0]!;
        assert.deepEqual(row.category_plan.envelopes, []);
        await commitNative(client, pending);
        assert.deepEqual(
          await reviewSnapshot(),
          before,
          'Metadata ordering cannot create or replace body Review',
        );
        assert.equal(
          (await readCategories(selectorA))[0]?.id,
          createdCategoryId,
        );
        const b = await readCategories(selectorB);
        assert.equal(
          b[0]?.id,
          data.local.categoryId,
          'Campus B keeps its independent order',
        );
      },
    );

    await t.test(
      'native double-inherit removes explicit campus fields and reveals the current reviewed shared base',
      async () => {
        requireCategory();
        assert.ok(
          baseEditComplete,
          'Dependency failed: shared base edit and exact Review did not complete',
        );
        const before = await reviewSnapshot();
        const restored = await mutateNative(
          createdCategoryId,
          'set_category_override_scoped',
          (client) => {
            client.controller.resetOverride();
          },
          0,
        );
        assert.equal(
          restored.pending.intent.operation,
          'set_category_override_scoped',
        );
        if (
          restored.pending.intent.operation === 'set_category_override_scoped'
        ) {
          assert.deepEqual(restored.pending.intent.payload.name, {
            mode: 'inherit',
          });
          assert.deepEqual(restored.pending.intent.payload.description, {
            mode: 'inherit',
          });
        }
        assert.deepEqual(
          await reviewSnapshot(),
          before,
          'Removing explicit fields must not mint a new body approval',
        );
        const managed = (await readManaged(restored.client)).find(
          (row) => row.id === createdCategoryId,
        );
        assert.ok(managed);
        assert.deepEqual(managed.override, {
          name: { mode: 'inherit' },
          description: { mode: 'inherit' },
        });
        for (const selector of campusSelectors) {
          const row = (await readCategories(selector)).find(
            (row) => row.id === createdCategoryId,
          );
          assert.equal(row?.name, 'New shared base name');
          assert.equal(row?.description, 'New shared base description');
        }
        inheritComplete = true;
      },
    );

    await t.test(
      'native visibility and full lifecycle cycle preserve body Review bytes, record real history and restore public access',
      async () => {
        requireCategory();
        assert.ok(
          inheritComplete,
          'Dependency failed: double-inherit must first restore shared base visibility',
        );
        const before = await reviewSnapshot();
        const requests: string[] = [];
        for (const hidden of [true, false]) {
          const changed = await mutateNative(
            createdCategoryId,
            'set_category_visibility_scoped',
            (client) => {
              client.controller.choose(
                'visibility',
                hidden ? 'hidden' : 'shown',
              );
            },
            0,
          );
          requests.push(changed.pending.intent.payload.clientRequestId);
          const managed = (await readManaged(changed.client)).find(
            (row) => row.id === createdCategoryId,
          );
          assert.equal(managed?.hidden, hidden);
          assert.equal(
            (await readCategories(selectorA)).some(
              (row) => row.id === createdCategoryId,
            ),
            !hidden,
          );
          assert.equal(
            (await readCategories(selectorB)).some(
              (row) => row.id === createdCategoryId,
            ),
            true,
            'Visibility is confined to the explicit campus view',
          );
          assert.deepEqual(await reviewSnapshot(), before);
        }
        let lastClient: ReturnType<typeof native> | null = null;
        for (const step of [
          { action: 'disable', state: 'disabled' },
          { action: 'archive', state: 'archived' },
          { action: 'restore', state: 'disabled' },
          { action: 'enable', state: 'enabled' },
        ] as const) {
          const changed = await mutateNative(
            createdCategoryId,
            'set_category_lifecycle_scoped',
            (client) => {
              client.controller.choose('lifecycleAction', step.action);
            },
            0,
          );
          lastClient = changed.client;
          requests.push(changed.pending.intent.payload.clientRequestId);
          const intent = changed.pending.intent;
          assert.equal(intent.operation, 'set_category_lifecycle_scoped');
          if (intent.operation === 'set_category_lifecycle_scoped') {
            assert.equal(intent.payload.state, step.state);
            assert.equal(intent.payload.restore, step.action === 'restore');
          }
          for (const selector of campusSelectors) {
            const managed: ManagedCategory | undefined = (
              await readManaged(changed.client, selector)
            ).find((row) => row.id === createdCategoryId);
            assert.equal(managed?.businessState, step.state);
            assert.equal(managed?.hidden, false);
            assert.equal(
              (await readCategories(selector)).some(
                (row) => row.id === createdCategoryId,
              ),
              step.state === 'enabled',
            );
          }
          assert.deepEqual(
            await reviewSnapshot(),
            before,
            'Lifecycle metadata must never replace accepted body Review',
          );
        }
        assert.ok(lastClient);
        const context = await lastClient.runtime.ratingCategoryScoped.context(
          selectorA,
          lastClient.cancel,
        );
        const history = await lastClient.runtime.ratingCategoryScoped.history(
          context,
          createdCategoryId,
          null,
          lastClient.cancel,
        );
        for (const requestId of requests)
          assert.ok(
            history.items.some(
              (entry: { requestId: string }) => entry.requestId === requestId,
            ),
            'Every visible metadata change requires its persisted history receipt',
          );
        metadataCycleComplete = true;
      },
    );

    await t.test(
      'native registered system creation bounds depth, then atomic batches add, order, disable, restore and enable complete direct children',
      async () => {
        const system = await mutateNative(
          undefined,
          'create_system_category_scoped',
          (client) => {
            assert.ok(
              client
                .view()
                .systemOptions.some(
                  (option) => option.systemKey === 'native_roundtrip_general',
                ),
            );
            client.controller.selectSystemKey('unregistered_arbitrary_key');
            assert.equal(
              client.view().systemKey,
              '',
              'Only accepted registry options can be selected',
            );
            client.controller.selectSystemKey('native_roundtrip_general');
            client.controller.setText(
              'name',
              'Native registered two-level system',
            );
            client.controller.setText(
              'description',
              'Real consumer registry with depth two',
            );
            client.controller.choose('levelCount', '2');
            client.controller.choose('levelCount', '4');
            assert.equal(
              client.view().levelCount,
              2,
              'Invalid native depth selection must be ignored',
            );
            assert.deepEqual(
              client.view().nodes,
              [],
              'System creation only submits its registered root',
            );
          },
          1,
        );
        assert.equal(
          system.pending.intent.operation,
          'create_system_category_scoped',
        );
        if (
          system.pending.intent.operation === 'create_system_category_scoped'
        ) {
          assert.equal(system.pending.intent.payload.levelCount, 2);
          assert.equal(
            system.pending.intent.payload.systemKey,
            'native_roundtrip_general',
          );
        }
        assert.equal(system.receipt.result.categoryIds.length, 1);
        const systemId = system.receipt.result.categoryIds[0]!;
        let rows = await readManaged(system.client);
        assert.equal(
          rows.find((row) => row.id === systemId)?.systemKey,
          'native_roundtrip_general',
        );
        assert.equal(rows.filter((row) => row.parentId === systemId).length, 0);
        const added = await mutateNative(
          systemId,
          'batch_update_subcategories_scoped',
          (client) => {
            client.controller.addNode();
            client.controller.setNodeText('n1', 'name', 'Native child one');
            client.controller.addNode();
            client.controller.setNodeText('n2', 'name', 'Native child two');
            client.controller.move('n2', 'up');
          },
          2,
        );
        if (
          added.pending.intent.operation === 'batch_update_subcategories_scoped'
        ) {
          assert.deepEqual(added.pending.intent.payload.orderedChildren, [
            { kind: 'new', key: 'n2' },
            { kind: 'new', key: 'n1' },
          ]);
          assert.equal(
            added.pending.intent.payload.addNodes.every(
              (node) => node.parentKey === null,
            ),
            true,
          );
        }
        rows = await readManaged(added.client);
        const childOne = rows.find(
          (row) => row.parentId === systemId && row.name === 'Native child one',
        );
        const childTwo = rows.find(
          (row) => row.parentId === systemId && row.name === 'Native child two',
        );
        assert.ok(childOne);
        assert.ok(childTwo);
        assert.equal(childOne.level, 2);
        assert.equal(childTwo.level, 2);
        assert.ok(BigInt(childTwo.ordinal) < BigInt(childOne.ordinal));
        const mixed = await mutateNative(
          systemId,
          'batch_update_subcategories_scoped',
          (client) => {
            client.controller.batchAction(childOne.id, 'disable');
            client.controller.addNode();
            client.controller.setNodeText('n1', 'name', 'Native child three');
            client.controller.move('n1', 'up');
          },
          1,
        );
        if (
          mixed.pending.intent.operation === 'batch_update_subcategories_scoped'
        ) {
          assert.deepEqual(mixed.pending.intent.payload.disableIds, [
            childOne.id,
          ]);
          assert.deepEqual(mixed.pending.intent.payload.orderedChildren, [
            { kind: 'existing', id: childTwo.id },
            { kind: 'new', key: 'n1' },
            { kind: 'existing', id: childOne.id },
          ]);
        }
        rows = await readManaged(mixed.client);
        const childThree = rows.find(
          (row) =>
            row.parentId === systemId && row.name === 'Native child three',
        );
        assert.ok(childThree);
        assert.equal(
          rows.find((row) => row.id === childOne.id)?.businessState,
          'disabled',
        );
        const beforeMetadata = await reviewSnapshot();
        await mutateNative(
          childTwo.id,
          'set_category_lifecycle_scoped',
          (client) => {
            client.controller.choose('lifecycleAction', 'archive');
          },
          0,
        );
        const restored = await mutateNative(
          systemId,
          'batch_update_subcategories_scoped',
          (client) => {
            client.controller.batchAction(childTwo.id, 'restore');
            client.controller.batchAction(childOne.id, 'enable');
            client.controller.move(childOne.id, 'up');
          },
          0,
        );
        if (
          restored.pending.intent.operation ===
          'batch_update_subcategories_scoped'
        ) {
          assert.deepEqual(restored.pending.intent.payload.restoreIds, [
            childTwo.id,
          ]);
          assert.deepEqual(restored.pending.intent.payload.enableIds, [
            childOne.id,
          ]);
          assert.deepEqual(
            restored.pending.intent.payload.orderedChildren
              .filter((ref) => ref.kind === 'existing')
              .map((ref) => ref.id)
              .sort(),
            [childOne.id, childTwo.id, childThree.id].sort(),
          );
        }
        rows = await readManaged(restored.client);
        assert.equal(
          rows.find((row) => row.id === childTwo.id)?.businessState,
          'disabled',
          'Batch restore must stop at disabled',
        );
        assert.equal(
          rows.find((row) => row.id === childOne.id)?.businessState,
          'enabled',
        );
        const enabled = await mutateNative(
          systemId,
          'batch_update_subcategories_scoped',
          (client) => {
            client.controller.batchAction(childTwo.id, 'enable');
          },
          0,
        );
        rows = await readManaged(enabled.client);
        assert.equal(rows.filter((row) => row.parentId === systemId).length, 3);
        assert.equal(
          rows
            .filter((row) => row.parentId === systemId)
            .every((row) => row.businessState === 'enabled'),
          true,
        );
        assert.deepEqual(
          await reviewSnapshot(),
          beforeMetadata,
          'Existing child lifecycle/order changes retain all body approval bytes',
        );

        const tooDeep = native();
        await tooDeep.controller.load(route(childOne.id));
        assert.equal(tooDeep.view().loaded, true, tooDeep.view().error);
        tooDeep.controller.selectOperation('batch_update_subcategories_scoped');
        tooDeep.controller.addNode();
        tooDeep.controller.setNodeText(
          'n1',
          'name',
          'Forbidden third-level descendant',
        );
        await tooDeep.controller.prepare();
        assert.equal(
          tooDeep.view().preview,
          null,
          'Accepted system depth two must reject a third level',
        );
        assert.equal(
          tooDeep.pending()?.version,
          10,
          'Rejected preparation retains its immutable recovery request',
        );
        assert.equal(
          tooDeep.transport.exchanges.at(-1)?.status,
          409,
          tooDeep.transport.diagnostics(),
        );
        assert.equal(
          tooDeep.transport.responseCodes.at(-1)?.code,
          'RATING_SCOPED_CONTEXT_CHANGED',
          tooDeep.transport.diagnostics(),
        );
        tooDeep.controller.requestCancel();
        await tooDeep.controller.confirmCancel();
        assert.equal(
          tooDeep.pending() === null,
          true,
          `${tooDeep.view().error}; ${tooDeep.transport.diagnostics()}`,
        );
        assert.equal(
          (await readManaged(enabled.client)).some(
            (row) => row.parentId === childOne.id,
          ),
          false,
          'Rejected depth must never publish descendants',
        );
        assert.deepEqual(await reviewSnapshot(), beforeMetadata);
      },
    );

    await t.test(
      'real target/comment survives category scope exit unchanged; original author cleanup and receipts work after management grant removal',
      async () => {
        requireCategory();
        assert.ok(
          metadataCycleComplete,
          'Dependency failed: original category must return to enabled and shown before the scope-exit story',
        );
        const client = native();
        const commandContext = async (
          operation: RatingScopedIntent['operation'],
          payload: Record<string, unknown>,
        ) => {
          const purpose =
            operation === 'create_target_scoped' ? 'create_target' : 'interact';
          const context = await client.runtime.ratingScoped.context(
            { selector: selectorA, purpose, mode: 'public' },
            client.cancel,
          );
          const row = (
            await f.pool.query<{ effective_revision: string }>(
              'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
              [context.heads[0].catalogRevision, createdCategoryId],
            )
          ).rows[0]!;
          return ratingScopedIntentSchema.parse({
            protocolVersion: 2,
            operation,
            context: scopedCommandContext(context),
            payload: {
              clientRequestId: randomUUID(),
              categoryId: createdCategoryId,
              expectedCategoryRevision: row.effective_revision,
              ...payload,
            },
          });
        };
        const approveOrdinary = async (input: RatingScopedIntent) => {
          const prepared = (
            await f.pool.query<{ envelope: unknown }>(
              'SELECT envelope FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, input.payload.clientRequestId],
            )
          ).rows[0]!;
          await f.approveScoped(
            canonicalRatingScopedEnvelope(prepared.envelope),
          );
        };
        const targetIntent = await commandContext('create_target_scoped', {
          name: 'Retained native target',
          description: 'Original target placement',
          assetIds: [],
        });
        await client.runtime.ratingScoped.prepare(
          decodeRatingScopedIntent(targetIntent),
          client.cancel,
        );
        await approveOrdinary(targetIntent);
        const target = scopedSuccess(
            await client.runtime.ratingScoped.command(
              decodeRatingScopedIntent(targetIntent),
              client.cancel,
            ),
          ),
          targetId = String(target.result['targetId']),
          targetRevision = String(target.result['revision']);
        const commentIntent = await commandContext('create_comment_scoped', {
          targetId,
          expectedTargetRevision: targetRevision,
          authorMode: 'named',
          body: 'Historical native comment must survive scope removal',
          assetIds: [],
        });
        await f.app
          .get(RatingScopedCommands)
          .prepare(actor.accessToken, commentIntent);
        await approveOrdinary(commentIntent);
        const comment = scopedSuccess(
          await client.runtime.ratingScoped.command(
            decodeRatingScopedIntent(commentIntent),
            client.cancel,
          ),
        );
        const commentId = String(comment.result['subjectId']),
          commentRevision = String(comment.result['revision']);
        const scoreIntent = await commandContext('set_score_scoped', {
          targetId,
          expectedTargetRevision: targetRevision,
          expectedRevision: null,
          score: 5,
        });
        scopedSuccess(
          await client.runtime.ratingScoped.command(
            decodeRatingScopedIntent(scoreIntent),
            client.cancel,
          ),
        );
        const preserved = async () =>
          (
            await f.pool.query(
              `SELECT jsonb_build_object(
      'target',(SELECT to_jsonb(t) FROM whaleu_ratings.targets t WHERE id=$1),
      'placements',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.placement_revision) FROM whaleu_ratings.target_scope_placements p WHERE target_id=$1),
      'definitions',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.content_version) FROM whaleu_ratings.target_definition_versions d WHERE target_id=$1),
      'origins',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.revision) FROM whaleu_ratings.target_origin_sources o WHERE target_id=$1),
      'comments',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM whaleu_ratings.comments c WHERE target_id=$1),
      'scores',(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.account_id) FROM whaleu_ratings.scores s WHERE target_id=$1)) state`,
              [targetId],
            )
          ).rows[0]!.state;
        const before = await preserved();
        await client.controller.load(route(createdCategoryId));
        client.controller.selectOperation('set_category_scope_scoped');
        client.controller.choose('scopeKind', 'campuses');
        client.controller.removePlacementCampus(f.campusA);
        client.controller.choose('propagation', 'self');
        const scopePending = await prepareNative(client);
        await approveManagement(scopePending);
        const scopeReceipt = await commitNative(client, scopePending);
        assert.deepEqual(
          await preserved(),
          before,
          'Scope changes cannot move/rewrite target identity, placement, origin, definitions, scores or comments',
        );
        assert.equal(
          (await readCategories(selectorA)).some(
            (c) => c.id === createdCategoryId,
          ),
          false,
        );
        assert.equal(
          (await readCategories(selectorB)).some(
            (c) => c.id === createdCategoryId,
          ),
          true,
        );
        const publicA = await client.runtime.ratingScoped.context(
          { selector: selectorA, purpose: 'read', mode: 'public' },
          client.cancel,
        );
        await assert.rejects(() =>
          client.runtime.ratingScoped.detail(publicA, targetId, client.cancel),
        );
        const publicB = await client.runtime.ratingScoped.context(
          { selector: selectorB, purpose: 'read', mode: 'public' },
          client.cancel,
        );
        assert.equal(
          (
            await client.runtime.ratingScoped.targets(
              publicB,
              createdCategoryId,
              null,
              client.cancel,
            )
          ).items.some((item: { id: string }) => item.id === targetId),
          false,
          'Expanding a category path cannot spread targets from their original placement',
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1 AND revoked_at IS NULL',
            [managementGrant, actor.accountId],
          ),
        );
        const newOwner = await freshSession(actor),
          restored = native(newOwner);
        await assert.rejects(
          () =>
            restored.runtime.ratingCategoryScoped.context(
              selectorB,
              restored.cancel,
            ),
          'The revoked management grant must block fresh management authority',
        );
        assert.deepEqual(
          await restored.runtime.ratingCategoryScoped.receipt(
            scopePending.intent.payload.clientRequestId,
            restored.cancel,
          ),
          scopeReceipt,
          'Historical management receipt needs no current management grant',
        );
        const cleanup = decodeRatingCommandIntent({
          operation: 'delete_comment',
          commentId,
          payload: {
            clientRequestId: randomUUID(),
            regionId: f.regionId,
            targetId,
            expectedTargetRevision: targetRevision,
            expectedRevision: commentRevision,
          },
        });
        const removed = await restored.runtime.ratings.command(
          cleanup,
          restored.cancel,
        );
        assert.equal(removed.outcome, 'applied');
        assert.deepEqual(
          await restored.runtime.ratings.receipt(
            cleanup.payload.clientRequestId,
            restored.cancel,
          ),
          removed,
        );
        assert.deepEqual(
          await restored.runtime.ratings.command(cleanup, restored.cancel),
          removed,
          'Original author cleanup replays despite missing current category path and management grant',
        );
        const deletionContext =
          await restored.runtime.ratingTargetOwnerDeletion.context(
            targetId,
            restored.cancel,
          );
        const deletion = decodeRatingCommandIntent({
          operation: 'delete_target',
          payload: {
            clientRequestId: randomUUID(),
            targetId,
            expectedTargetRevision: deletionContext.revision,
          },
        });
        const deleted =
          await restored.runtime.ratingTargetOwnerDeletion.command(
            deletion,
            restored.cancel,
          );
        assert.equal(deleted.outcome, 'applied');
        assert.deepEqual(
          await restored.runtime.ratingTargetOwnerDeletion.receipt(
            deletion.payload.clientRequestId,
            restored.cancel,
          ),
          deleted,
        );
        assert.deepEqual(
          await restored.runtime.ratingTargetOwnerDeletion.command(
            deletion,
            restored.cancel,
          ),
          deleted,
        );
        const intactPlacement = (
          await f.pool.query(
            'SELECT to_jsonb(p) row FROM whaleu_ratings.target_scope_placements p WHERE target_id=$1 ORDER BY placement_revision',
            [targetId],
          )
        ).rows.map((row) => row['row']);
        assert.deepEqual(
          intactPlacement,
          before.placements,
          'Even explicit owner cleanup retains historical target placement facts',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, scopePending.intent.payload.clientRequestId],
            )
          ).rows[0]!.n,
          1,
        );
        assert.equal(
          createHash('sha256')
            .update(canonicalJson(before.placements))
            .digest('hex'),
          createHash('sha256')
            .update(canonicalJson(intactPlacement))
            .digest('hex'),
        );
      },
    );
  },
);
