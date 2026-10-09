import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  ratingCategoryFixture,
  ratingCategoryPrefix as prefix,
} from '../support/rating-category-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import {
  platformStorage,
  protocolFailure,
  serverFailure,
} from '../support/experience-native-bridge.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import type {
  PrepareRatingCategories,
  RatingCategoryReceipt,
} from '../../src/ratings/category-management/contracts.js';

// Native page controllers/runtime/strict decoder -> platform-only HTTPS bridge ->
// actual AppModule -> disposable PostgreSQL. Approval consumes the exact persisted
// preparation envelope. No authorization, Review or publication port is replaced.
interface Pending {
  version: 8;
  accountId: string;
  intent: { operation: 'create_categories'; payload: PrepareRatingCategories };
}
interface View {
  ready: boolean;
  regionId: string | null;
  campusIds: string[];
  parents: Array<{ id: string; revision: string; name: string; level: number }>;
  nodes: Array<{
    key: string;
    parentKey: string | null;
    name: string;
    description: string;
    level: number;
  }>;
  frozen: boolean;
  creationConfirmation: boolean;
  canCancelCategoryCreation: boolean;
  cancelCategoryCreationConfirmation: boolean;
  receiptStatus: string;
  recoveryOperation: string;
  needsRefresh: boolean;
  error: string;
}
interface Sent {
  path: string;
  method: string;
  bodyBytes?: string;
}
class ObservedCategoryTransport extends DirectoryHttpTransport {
  readonly sent: Sent[] = [];
  approvePreparation:
    ((input: PrepareRatingCategories) => Promise<void>) | null = null;
  override async send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    const url = new URL(input.url);
    this.sent.push({
      path: `${url.pathname}${url.search}`,
      method: input.method,
      ...(input.body === undefined
        ? {}
        : { bodyBytes: JSON.stringify(input.body) }),
    });
    const response = await super.send(input);
    if (response.status === 200 && url.pathname.startsWith(prefix)) {
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['vary'], 'Authorization');
      if (
        url.pathname === `${prefix}/prepare` &&
        response.body !== null &&
        typeof response.body === 'object' &&
        !('outcome' in response.body)
      )
        await this.approvePreparation?.(input.body as PrepareRatingCategories);
    }
    return response;
  }
}
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
  RatingCategoryManagementController,
} = require('../../../wechat/src/ratings/category-management-controller.ts');
const {
  RatingController,
} = require('../../../wechat/src/ratings/controller.ts');
const {
  decodeRatingCategoryManagementContext,
  decodeRatingCategoryCreationIntent,
  decodeRatingCategoryPrepared,
  decodeRatingCategoryCreationReceipt,
} = require('../../../wechat/src/ratings/category-management-contract.ts');
const {
  decodeRatingCommandIntent,
} = require('../../../wechat/src/ratings/pending.ts');

test(
  'M3A real native tree creation, exact durable v8 recovery and session/lifecycle fences through AppModule HTTP/PG',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingCategoryFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      regional = await f.actor(),
      ordinary = await f.actor();
    await f.grant(admin, 'super_admin');
    await f.grant(regional, 'school_admin', f.scope.home.regionId);
    // Start from a real, canonical native release rather than an opaque historical fixture.
    const seed = await f.createCategories(admin, null, {
      nodes: [
        {
          key: 'seed',
          parentKey: null,
          name: 'Previously reviewed native root',
          description: '',
        },
      ],
    });
    type Actor = typeof admin;
    const approved = new Map<string, string>();
    function native(actor: Actor, device = platformStorage()) {
      const transport = new ObservedCategoryTransport(f.port),
        sessions = new SessionStore();
      sessions.completeLogin(sessions.beginLogin(), actor);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error('No real provider calls');
          },
        },
        systemClock,
      );
      const api = new ApiClient(
        directoryNativeOrigin,
        transport,
        sessions,
        auth,
      );
      const runtime = createCommunityRuntime(
        { sessions, api },
        device,
        directoryNativeOrigin,
      );
      const views: View[] = [],
        changes: unknown[] = [];
      const controller = new RatingCategoryManagementController(
        runtime,
        (view: View) => views.push(view),
      );
      t.after(() => controller.dispose());
      runtime.ratingCatalogChanges.subscribe((change: unknown) =>
        changes.push(change),
      );
      transport.approvePreparation = async (input) => {
        if (!approved.has(input.clientRequestId)) {
          const review = await f.approveCategories(actor, input);
          approved.set(input.clientRequestId, review.decisionId);
        }
      };
      transport.checkResponse = (path, status, body) => {
        if (status !== 200 || !path.startsWith(prefix)) return;
        const bytes = JSON.stringify(body);
        for (const person of [admin, regional, ordinary]) {
          assert.equal(bytes.includes(person.accountId), false);
          assert.equal(bytes.includes(person.accessToken), false);
        }
        assert.doesNotMatch(
          bytes,
          /"(?:creatorId|actorId|accountId|envelope|review|authority|sessionId)"/,
        );
        const decode = path.endsWith('/context')
          ? decodeRatingCategoryManagementContext
          : path.endsWith('/prepare')
            ? decodeRatingCategoryPrepared
            : decodeRatingCategoryCreationReceipt;
        assert.deepEqual(decode(body), body);
        assert.throws(
          () => decode({ ...(body as object), actorId: admin.accountId }),
          protocolFailure,
        );
        if (!path.endsWith('/context'))
          assert.doesNotMatch(bytes, /"(?:name|description)"/);
      };
      return {
        transport,
        sessions,
        runtime,
        controller,
        device,
        views,
        changes,
        cancellation: new Cancellation(),
        view: () => views[views.length - 1]!,
        pending: () =>
          runtime.pendingRatings.load(actor.accountId) as Pending | null,
      };
    }
    const noDraft = (view: View) => {
      assert.deepEqual(view.nodes, []);
      assert.deepEqual(view.parents, []);
      assert.deepEqual(view.campusIds, []);
    };
    const fill = (
      client: ReturnType<typeof native>,
      levels = 3,
      label = 'Native tree',
    ) => {
      for (let i = 1; i < levels; i++) client.controller.addChild(`n${i - 1}`);
      for (let i = 0; i < levels; i++) {
        client.controller.setNodeText(
          `n${i}`,
          'name',
          `  ${label} level ${i + 1} 🌊  `,
        );
        client.controller.setNodeText(
          `n${i}`,
          'description',
          ` Exact level ${i + 1} description `,
        );
      }
    };
    const transitionCount = async (actorId: string, requestId: string) =>
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.category_command_transitions WHERE actor_account_id=$1 AND request_id=$2',
          [actorId, requestId],
        )
      ).rows[0]!.n;
    const freshSession = async (actor: Actor): Promise<Actor> => {
      const identity = (
        await f.pool.query<{
          provider: 'wechat';
          app_id: string;
          subject: string;
        }>(
          'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [actor.accountId],
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
      assert.notEqual(session.sessionId, actor.sessionId);
      return { ...actor, ...session, accessToken, refreshToken };
    };
    const effects = async () => ({
      notices: (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_notices',
        )
      ).rows[0].n,
      subscriptions: (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_notifications.rating_subscription_notices',
        )
      ).rows[0].n,
      obligations: (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.notice_obligations',
        )
      ).rows[0].n,
      rewardGroups: (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.reward_groups',
        )
      ).rows[0].n,
      rewardUnits: (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.reward_units',
        )
      ).rows[0].n,
    });
    const originalEffects = await effects();
    const device = platformStorage(),
      own = native(admin, device);

    await t.test(
      'the real context exposes complete exact scope and native parents only to authorized managers',
      async () => {
        await own.controller.load({});
        assert.equal(own.view().ready, true, own.view().error);
        assert.equal(own.view().regionId, null);
        assert.deepEqual(
          own.view().campusIds,
          [
            f.scope.home.campusId,
            f.scope.related.campusId,
            f.scope.foreign.campusId,
          ].sort(),
        );
        assert.ok(
          own
            .view()
            .parents.some(
              (parent) => parent.id === seed.receipt.categories[0]!.id,
            ),
        );
        assert.equal('loaded' in own.view(), false);
        const local = native(regional);
        await local.controller.load({ regionId: f.scope.home.regionId });
        assert.equal(local.view().ready, true, local.view().error);
        assert.deepEqual(local.view().campusIds, [f.scope.home.campusId]);
        assert.deepEqual(
          local.view().parents,
          [],
          'Global native parents are not local-source parents',
        );
        for (const client of [native(ordinary), native(regional)]) {
          await client.controller.load({});
          assert.equal(client.view().ready, false);
          noDraft(client.view());
          client.controller.requestCreate();
          await client.controller.confirmCreate();
          assert.equal(client.pending(), null);
          assert.ok(client.transport.sent.every((row) => row.method === 'GET'));
          const visible = await client.runtime.ratings.categories(
            null,
            null,
            null,
            client.cancellation,
          );
          assert.equal(
            visible.items[0].id,
            seed.receipt.categories[0]!.id,
            'Management denial does not break ordinary directory reading',
          );
        }
      },
    );

    await t.test(
      'each v1–v7 journal blocks v8 and recovers its exact historical route without fetching management context',
      async () => {
        const current = await f.categoryContext(admin),
          candidate = decodeRatingCategoryCreationIntent({
            operation: 'create_categories',
            payload: f.categoryIntent(current),
          });
        const targetId = randomUUID(),
          revision = randomUUID(),
          categoryId = seed.receipt.categories[0]!.id,
          categoryRevision = seed.receipt.categories[0]!.revision;
        const base = {
          clientRequestId: randomUUID(),
          regionId: null,
          expectedTargetRevision: revision,
        };
        const inputs = [
          {
            operation: 'set_score',
            targetId,
            payload: { ...base, expectedRevision: null, score: 5 },
          },
          {
            operation: 'create_comment',
            targetId,
            payload: {
              ...base,
              clientRequestId: randomUUID(),
              authorMode: 'named',
              body: 'Unsent original evaluation',
              assetIds: [],
            },
          },
          {
            operation: 'set_target_subscription',
            targetId,
            payload: {
              ...base,
              clientRequestId: randomUUID(),
              expectedSubscriptionRevision: randomUUID(),
              subscribed: true,
            },
          },
          {
            operation: 'admin_delete_comment',
            subjectId: randomUUID(),
            payload: {
              clientRequestId: randomUUID(),
              targetId,
              expectedTargetRevision: revision,
              expectedRevision: randomUUID(),
              expectedContextRevision: 'x'.repeat(43),
            },
          },
          {
            operation: 'create_target',
            payload: {
              clientRequestId: randomUUID(),
              regionId: null,
              categoryId,
              expectedCategoryRevision: categoryRevision,
              expectedCatalogRevision: current.catalogRevision,
              name: 'Unsent target',
              description: '',
              assetIds: [],
            },
          },
          {
            operation: 'delete_target',
            payload: {
              clientRequestId: randomUUID(),
              targetId,
              expectedTargetRevision: revision,
            },
          },
          {
            operation: 'edit_target',
            payload: {
              clientRequestId: randomUUID(),
              targetId,
              regionId: null,
              expectedTargetRevision: revision,
              expectedDefinitionRevision: randomUUID(),
              expectedContentVersion: 1,
              categoryId,
              expectedCategoryRevision: categoryRevision,
              expectedCatalogRevision: current.catalogRevision,
              name: 'Unsent edit',
              description: '',
              assetIds: [],
            },
          },
        ];
        const receiptPrefixes = [
          '/v1/ratings/requests',
          '/v1/ratings/requests',
          '/v1/ratings/subscription-requests',
          '/v1/ratings/admin/requests',
          '/v1/ratings/management/requests',
          '/v1/ratings/management/owner-deletion/requests',
          '/v1/ratings/management/owner-edit/requests',
        ];
        for (const [index, raw] of inputs.entries()) {
          const client = native(admin),
            version = index + 1;
          const old = client.runtime.pendingRatings.freeze({
            version,
            accountId: admin.accountId,
            intent: decodeRatingCommandIntent(raw),
          });
          const key = `whaleu.ratings.pending.v${version}:${directoryNativeOrigin}:${admin.accountId}`,
            bytes = JSON.stringify(client.device.storage.get(key));
          assert.throws(() =>
            client.runtime.pendingRatings.freeze({
              version: 8,
              accountId: admin.accountId,
              intent: candidate,
            }),
          );
          await client.controller.load({ regionId: randomUUID() });
          assert.equal(client.view().frozen, true);
          noDraft(client.view());
          assert.equal(client.view().canCancelCategoryCreation, false);
          assert.deepEqual(
            client.runtime.pendingRatings.load(admin.accountId),
            old,
          );
          assert.equal(JSON.stringify(client.device.storage.get(key)), bytes);
          assert.deepEqual(
            client.transport.sent.map((row) => [row.method, row.path]),
            [
              [
                'GET',
                `${receiptPrefixes[index]}/${raw.payload.clientRequestId}`,
              ],
            ],
          );
        }
      },
    );

    let original!: Pending,
      applied!: Extract<RatingCategoryReceipt, { outcome: 'applied' }>;
    const catalogViews: Array<{
      loaded: boolean;
      categories: Array<{ id: string }>;
      error: string;
    }> = [];
    const catalog = new RatingController(
      own.runtime,
      'catalog',
      (view: (typeof catalogViews)[number]) => catalogViews.push(view),
    );
    t.after(() => catalog.dispose());
    await t.test(
      'a real three-level native tree survives lost prepare and commit while publishing exactly once',
      async () => {
        await catalog.load({});
        assert.equal(
          catalogViews.at(-1)!.loaded,
          true,
          catalogViews.at(-1)!.error,
        );
        await own.controller.load({});
        fill(own);
        const before = own.transport.sent.length;
        await own.controller.confirmCreate();
        assert.equal(own.transport.sent.length, before);
        own.controller.requestCreate();
        assert.equal(own.view().creationConfirmation, true);
        assert.deepEqual(
          own.view().nodes.map((node) => node.level),
          [1, 2, 3],
        );
        own.transport.dropSuccess = {
          path: `${prefix}/prepare`,
          method: 'POST',
        };
        await Promise.all([
          own.controller.confirmCreate(),
          own.controller.confirmCreate(),
        ]);
        original = own.pending()!;
        assert.equal(original.version, 8);
        assert.equal(
          original.intent.payload.nodes[0]!.name,
          'Native tree level 1 🌊',
        );
        assert.equal(own.view().frozen, true);
        noDraft(own.view());
        assert.equal(
          await transitionCount(
            admin.accountId,
            original.intent.payload.clientRequestId,
          ),
          0,
        );
        await own.controller.recover();
        assert.deepEqual(own.pending(), original);
        own.transport.dropSuccess = {
          path: `${prefix}/categories`,
          method: 'POST',
        };
        await own.controller.recover(true);
        assert.deepEqual(own.pending(), original);
        assert.equal(own.changes.length, 0);
        assert.equal(
          await transitionCount(
            admin.accountId,
            original.intent.payload.clientRequestId,
          ),
          1,
        );
        const receipt = await own.runtime.ratingCategoryManagement.receipt(
          original.intent.payload.clientRequestId,
          own.cancellation,
        );
        assert.equal(receipt.outcome, 'applied');
        applied = receipt;
        assert.deepEqual(
          applied.categories.map((node) => node.level),
          [1, 2, 3],
        );
        assert.equal(applied.catalogs.length, 4);
        const prepareRows = own.transport.sent
          .slice(before)
          .filter((row) => row.path === `${prefix}/prepare`);
        assert.equal(prepareRows.length, 2);
        for (const row of prepareRows)
          assert.equal(row.bodyBytes, JSON.stringify(original.intent.payload));
        const stored = (
          await f.pool.query<{ context_revision: string }>(
            'SELECT context_revision FROM whaleu_ratings.category_command_preparations WHERE account_id=$1 AND request_id=$2',
            [admin.accountId, original.intent.payload.clientRequestId],
          )
        ).rows[0]!;
        assert.deepEqual(
          JSON.parse(
            own.transport.sent.find(
              (row) => row.path === `${prefix}/categories`,
            )!.bodyBytes!,
          ),
          {
            ...original.intent.payload,
            expectedContextRevision: stored.context_revision,
          },
        );
        assert.deepEqual(
          await own.runtime.ratingCategoryManagement.cancel(
            original.intent,
            own.cancellation,
          ),
          applied,
          'Applied history wins cancellation',
        );
        assert.deepEqual(
          own.pending(),
          original,
          'Direct receipt reads do not settle the original journal',
        );
      },
    );

    await t.test(
      'independent native recovery settles history first and invalidates the loaded catalog before fresh traversal',
      async () => {
        assert.equal(catalogViews.at(-1)!.loaded, true);
        const before = own.transport.sent.length,
          recoveryViews: Array<{
            receiptStatus: string;
            confirmedTargetId: string;
          }> = [];
        const recovery = new RatingController(
          own.runtime,
          'recovery',
          (view: (typeof recoveryViews)[number]) => recoveryViews.push(view),
        );
        t.after(() => recovery.dispose());
        await recovery.load(null);
        assert.equal(own.pending(), null);
        assert.equal(catalogViews.at(-1)!.loaded, false);
        assert.deepEqual(catalogViews.at(-1)!.categories, []);
        assert.equal(recoveryViews.at(-1)!.confirmedTargetId, '');
        assert.match(recoveryViews.at(-1)!.receiptStatus, /当前状态需重新读取/);
        assert.deepEqual(
          own.transport.sent.slice(before).map((row) => [row.method, row.path]),
          [
            [
              'GET',
              `${prefix}/requests/${original.intent.payload.clientRequestId}`,
            ],
          ],
        );
        assert.deepEqual(own.changes, [
          { releaseId: applied.releaseId, catalogs: applied.catalogs },
        ]);
        await catalog.reload();
        assert.equal(
          catalogViews.at(-1)!.loaded,
          true,
          catalogViews.at(-1)!.error,
        );
        const fresh = await own.runtime.ratingCategoryManagement.context(
          null,
          own.cancellation,
        );
        assert.notEqual(
          fresh.scopeRevision,
          original.intent.payload.expectedScopeRevision,
        );
        assert.equal(
          fresh.catalogRevision,
          applied.catalogs.find((entry) => entry.regionId === null)!
            .catalogRevision,
        );
        assert.ok(
          fresh.parents.some(
            (entry: { id: string }) => entry.id === applied.categories[0]!.id,
          ),
        );
        assert.ok(
          fresh.parents.some(
            (entry: { id: string }) => entry.id === applied.categories[1]!.id,
          ),
        );
        assert.equal(
          fresh.parents.some(
            (entry: { id: string }) => entry.id === applied.categories[2]!.id,
          ),
          false,
        );
        assert.ok(
          catalogViews
            .at(-1)!
            .categories.some((node) => node.id === applied.categories[0]!.id),
        );
        for (let level = 0; level < 3; level++) {
          const parentId =
            level === 0 ? null : applied.categories[level - 1]!.id;
          const page = await own.runtime.ratings.categories(
            null,
            parentId,
            null,
            own.cancellation,
          );
          assert.ok(
            page.items.some(
              (node: { id: string }) =>
                node.id === applied.categories[level]!.id,
            ),
          );
          assert.equal(
            page.context.catalogRevision,
            applied.catalogs.find((entry) => entry.regionId === null)!
              .catalogRevision,
          );
        }
      },
    );

    await t.test(
      'regional native tree uses the complete local campus set and optional exact same-source parent',
      async () => {
        const local = native(regional);
        await local.controller.load({ regionId: f.scope.home.regionId });
        assert.equal(local.view().ready, true, local.view().error);
        assert.deepEqual(local.view().campusIds, [f.scope.home.campusId]);
        fill(local, 2, 'Regional tree');
        local.controller.requestCreate();
        await local.controller.confirmCreate();
        assert.equal(local.pending(), null);
        assert.match(local.view().receiptStatus, /历史操作/);
        noDraft(local.view());
        const sent = local.transport.sent.find(
          (row) => row.path === `${prefix}/prepare`,
        )!;
        const input = JSON.parse(sent.bodyBytes!) as PrepareRatingCategories;
        const receipt = (await local.runtime.ratingCategoryManagement.receipt(
          input.clientRequestId,
          local.cancellation,
        )) as Extract<RatingCategoryReceipt, { outcome: 'applied' }>;
        assert.equal(receipt.outcome, 'applied');
        assert.deepEqual(
          receipt.catalogs.map((row) => row.regionId),
          [f.scope.home.regionId],
        );
        const parent = receipt.categories[0]!;
        await local.controller.load({ regionId: f.scope.home.regionId });
        assert.ok(local.view().parents.some((entry) => entry.id === parent.id));
        assert.equal(
          local
            .view()
            .parents.some((entry) => entry.id === applied.categories[0]!.id),
          false,
        );
        local.controller.selectParent(parent.id);
        fill(local, 2, 'Under local parent');
        assert.deepEqual(
          local.view().nodes.map((node) => node.level),
          [2, 3],
        );
        local.controller.requestCreate();
        await local.controller.confirmCreate();
        assert.equal(local.pending(), null, local.view().error);
        const parented = JSON.parse(
          local.transport.sent
            .filter((row) => row.path === `${prefix}/prepare`)
            .at(-1)!.bodyBytes!,
        ) as PrepareRatingCategories;
        assert.equal(parented.parentId, parent.id);
        assert.equal(parented.expectedParentRevision, parent.revision);
        const under = await local.runtime.ratingCategoryManagement.receipt(
          parented.clientRequestId,
          local.cancellation,
        );
        assert.equal(under.categories[0].parentId, parent.id);
        assert.deepEqual(
          under.categories.map((node: { level: number }) => node.level),
          [2, 3],
        );
      },
    );

    await t.test(
      'unknown actual Review remains unresolved, then exact persisted-envelope approval completes the same bytes',
      async () => {
        const client = native(admin);
        client.transport.approvePreparation = null;
        await client.controller.load({});
        fill(client, 1, 'Awaiting category Review');
        client.controller.requestCreate();
        await client.controller.confirmCreate();
        const pending = client.pending()!;
        assert.equal(pending.version, 8);
        assert.equal(client.view().receiptStatus, '');
        noDraft(client.view());
        assert.equal(
          await transitionCount(
            admin.accountId,
            pending.intent.payload.clientRequestId,
          ),
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
              [admin.accountId, pending.intent.payload.clientRequestId],
            )
          ).rowCount,
          0,
        );
        await client.controller.recover();
        assert.deepEqual(client.pending(), pending);
        await f.approveCategories(admin, pending.intent.payload);
        await client.controller.recover(true);
        assert.equal(client.pending(), null, client.view().error);
        noDraft(client.view());
        assert.equal(
          await transitionCount(
            admin.accountId,
            pending.intent.payload.clientRequestId,
          ),
          1,
        );
        for (const row of client.transport.sent.filter(
          (entry) => entry.path === `${prefix}/prepare`,
        ))
          assert.equal(row.bodyBytes, JSON.stringify(pending.intent.payload));
      },
    );

    await t.test(
      'explicit cancel retains the exact old intent through response loss and can never late-publish it',
      async () => {
        const cancelDevice = platformStorage();
        let client = native(admin, cancelDevice);
        await client.controller.load({});
        fill(client, 2, 'Never published cancellation');
        client.transport.failNext = `${prefix}/categories`;
        client.controller.requestCreate();
        await client.controller.confirmCreate();
        const pending = client.pending()!;
        assert.equal(
          await transitionCount(
            admin.accountId,
            pending.intent.payload.clientRequestId,
          ),
          0,
        );
        const before = client.transport.sent.length;
        await client.controller.confirmCancelCategoryCreation();
        assert.equal(client.transport.sent.length, before);
        client.controller.requestCancelCategoryCreation();
        client.controller.dismissCancelCategoryCreation();
        await client.controller.confirmCancelCategoryCreation();
        assert.equal(client.transport.sent.length, before);
        client.controller.requestCancelCategoryCreation();
        client.transport.dropSuccess = {
          path: `${prefix}/cancel`,
          method: 'POST',
        };
        await client.controller.confirmCancelCategoryCreation();
        assert.deepEqual(client.pending(), pending);
        assert.equal(
          client.transport.sent.at(-1)!.bodyBytes,
          JSON.stringify(pending.intent.payload),
        );
        client.controller.dispose();
        client = native(admin, cancelDevice);
        await client.controller.load({ invalid: 'route' });
        assert.equal(client.pending(), null);
        assert.match(client.view().receiptStatus, /已撤销/);
        noDraft(client.view());
        assert.deepEqual(
          client.transport.sent.map((row) => [row.method, row.path]),
          [
            [
              'GET',
              `${prefix}/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        const closed = await client.runtime.ratingCategoryManagement.command(
          pending.intent,
          client.cancellation,
        );
        assert.deepEqual(closed, {
          requestId: pending.intent.payload.clientRequestId,
          operation: 'create_categories',
          outcome: 'rejected',
          code: 'RATING_CATEGORY_CANCELLED',
        });
        assert.equal(
          await transitionCount(
            admin.accountId,
            pending.intent.payload.clientRequestId,
          ),
          0,
        );
        assert.equal(
          client.transport.sent.some(
            (row) => row.path === `${prefix}/categories`,
          ),
          false,
        );
      },
    );

    for (const boundary of [
      'account',
      'same-account-session',
      'root-hide',
    ] as const)
      await t.test(
        `${boundary} before a real prepared callback prevents commit, preserves v8 and permits original-session recovery`,
        async () => {
          const isolationDevice = platformStorage(),
            client = native(admin, isolationDevice);
          await client.controller.load({});
          fill(client, 1, `Fenced ${boundary}`);
          client.controller.requestCreate();
          const held = client.transport.holdNext(`${prefix}/prepare`, 'POST');
          const work = client.controller.confirmCreate();
          await held.arrived;
          const pending = client.pending()!,
            bytes = JSON.stringify(pending);
          if (boundary === 'root-hide') client.runtime.privateViews.clear();
          else
            client.sessions.completeLogin(
              client.sessions.beginLogin(),
              boundary === 'account' ? ordinary : await freshSession(admin),
            );
          held.release();
          await work;
          assert.equal(JSON.stringify(client.pending()), bytes);
          noDraft(client.view());
          assert.equal(
            client.transport.sent.some(
              (row) => row.path === `${prefix}/categories`,
            ),
            false,
          );
          assert.equal(
            await transitionCount(
              admin.accountId,
              pending.intent.payload.clientRequestId,
            ),
            0,
          );
          assert.deepEqual(client.changes, []);
          if (boundary === 'account') {
            const outsider = native(ordinary, isolationDevice);
            await outsider.controller.load({});
            noDraft(outsider.view());
            assert.equal(outsider.pending(), null);
            await assert.rejects(
              () =>
                outsider.runtime.ratingCategoryManagement.receipt(
                  pending.intent.payload.clientRequestId,
                  outsider.cancellation,
                ),
              serverFailure('REQUEST_NOT_FOUND'),
            );
            assert.equal(JSON.stringify(client.pending()), bytes);
          }
          const restored = native(admin, isolationDevice);
          await restored.controller.load(null);
          assert.deepEqual(restored.pending(), pending);
          noDraft(restored.view());
          restored.controller.requestCancelCategoryCreation();
          await restored.controller.confirmCancelCategoryCreation();
          assert.equal(restored.pending(), null, restored.view().error);
          assert.match(restored.view().receiptStatus, /已撤销/);
        },
      );

    await t.test(
      'account replacement after real commit cannot settle or emit late success, and new owner session recovers history only',
      async () => {
        const lateDevice = platformStorage(),
          client = native(admin, lateDevice);
        await client.controller.load({});
        fill(client, 1, 'Committed before account switch');
        client.controller.requestCreate();
        const held = client.transport.holdNext(`${prefix}/categories`, 'POST');
        const work = client.controller.confirmCreate();
        await held.arrived;
        const pending = client.pending()!;
        assert.equal(
          await transitionCount(
            admin.accountId,
            pending.intent.payload.clientRequestId,
          ),
          1,
        );
        client.sessions.completeLogin(client.sessions.beginLogin(), ordinary);
        held.release();
        await work;
        assert.deepEqual(client.pending(), pending);
        assert.deepEqual(client.changes, []);
        noDraft(client.view());
        const restored = native(await freshSession(admin), lateDevice);
        await restored.controller.load(null);
        assert.equal(restored.pending(), null);
        assert.match(restored.view().receiptStatus, /历史操作/);
        noDraft(restored.view());
        assert.deepEqual(
          restored.transport.sent.map((row) => [row.method, row.path]),
          [
            [
              'GET',
              `${prefix}/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        assert.equal(
          await transitionCount(
            admin.accountId,
            pending.intent.payload.clientRequestId,
          ),
          1,
        );
      },
    );
    assert.deepEqual(
      await effects(),
      originalEffects,
      'Category management creates no rewards, notice kinds or subscriptions',
    );
  },
);
