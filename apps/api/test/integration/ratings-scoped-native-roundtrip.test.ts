import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ratingScopedCommandFixture,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import {
  platformStorage,
  protocolFailure,
} from '../support/experience-native-bridge.js';
import {
  ratingScopedIntentSchema,
  type RatingScopedIntent,
} from '../../src/ratings/scoped/contracts.js';
import { ratingScopedCommandHash } from '../../src/ratings/scoped/protocol-registry.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';

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
  RatingScopedController,
} = require('../../../wechat/src/ratings/scoped-controller.ts');
const {
  decodeRatingCommandIntent,
} = require('../../../wechat/src/ratings/pending.ts');
const {
  decodeRatingScopedContext,
  decodeRatingScopedIntent,
  decodeRatingScopedReceipt,
  ratingScopedIntentHash,
} = require('../../../wechat/src/ratings/scoped-contract.ts');
interface View {
  loaded: boolean;
  frozen: boolean;
  text: string;
  name: string;
  description: string;
  composerOpen: boolean;
  definitionConfirmation: boolean;
  canCancelPending: boolean;
  receiptStatus: string;
  error: string;
  categories: unknown[];
  targets: unknown[];
  identityCampusId: string | null;
  viewCampusId: string | null;
}
interface Pending {
  version: number;
  accountId: string;
  intent: RatingScopedIntent;
}
interface Sent {
  path: string;
  method: string;
  bodyBytes?: string;
}
class ScopedTransport extends DirectoryHttpTransport {
  readonly sent: Sent[] = [];
  beforeSend: (() => Promise<void>) | null = null;
  approve: ((input: RatingScopedIntent) => Promise<void>) | null = null;
  override async send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    await this.beforeSend?.();
    const url = new URL(input.url);
    this.sent.push({
      path: `${url.pathname}${url.search}`,
      method: input.method,
      ...(input.body === undefined
        ? {}
        : { bodyBytes: JSON.stringify(input.body) }),
    });
    const response = await super.send(input);
    if (
      response.status === 200 &&
      (url.pathname.startsWith('/v2/ratings') ||
        url.pathname.startsWith('/v2/me/ratings'))
    ) {
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['vary'], 'Authorization');
      if (
        url.pathname.endsWith('/prepare') &&
        response.body &&
        typeof response.body === 'object' &&
        !('outcome' in response.body)
      )
        await this.approve?.(ratingScopedIntentSchema.parse(input.body));
    }
    return response;
  }
}

test(
  'M3B native v9 controller/gateway -> real AppModule HTTP/PostgreSQL interruption and history recovery',
  { timeout: 600000 },
  async (t) => {
    const f = await ratingScopedCommandFixture();
    t.after(() => f.close());
    let actor = f.creator;
    const other = await f.actor();
    type Actor = typeof actor;
    const approved = new Set<string>();
    const respectReadBudget = async (threshold = 70) => {
      // Preserve the genuine 120/minute/account guard, including old sessions.
      // This matrix waits for real windows; it never resets or overrides them.
      const row = (
        await f.pool.query<{ wait: number }>(
          `SELECT coalesce(max(greatest(0,extract(epoch FROM
          greatest(expires_at,coalesce(blocked_until,expires_at))-clock_timestamp())*1000)),0)::double precision wait
         FROM whaleu_runtime.request_throttle_counters WHERE total_hits>=$1`,
          [threshold],
        )
      ).rows[0]!;
      if (row.wait > 0) await delay(Math.ceil(row.wait) + 25);
    };
    t.beforeEach(async () => {
      await respectReadBudget();
      // Independent cases must start from an actual current login. Prior cases
      // intentionally create enough sessions to evict the oldest under the real
      // ten-device policy; never revive/rewrite an evicted session or its journal.
      actor = await f.freshSession(actor);
    });
    function native(owner: Actor = actor, device = platformStorage()) {
      const transport = new ScopedTransport(f.port),
        sessions = new SessionStore();
      transport.beforeSend = () => respectReadBudget(105);
      sessions.completeLogin(sessions.beginLogin(), owner);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error('Synthetic test must not contact a provider');
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
      const controller = new RatingScopedController(runtime, (view: View) =>
        views.push(view),
      );
      t.after(() => controller.dispose());
      runtime.ratingCatalogChanges.subscribe((value: unknown) =>
        changes.push(value),
      );
      runtime.ratingTargetChanges.subscribe((value: unknown) =>
        changes.push(value),
      );
      transport.approve = async (input) => {
        if (!approved.has(input.payload.clientRequestId)) {
          await f.approveCommand(owner, input);
          approved.add(input.payload.clientRequestId);
        }
      };
      return {
        transport,
        sessions,
        runtime,
        controller,
        device,
        changes,
        gateway: runtime.ratingScoped,
        cancellation: new Cancellation(),
        view: () => views.at(-1)!,
        pending: () =>
          runtime.pendingRatings.load(owner.accountId) as Pending | null,
      };
    }
    const emptyDraft = (view: View) => {
      assert.equal(view.text, '');
      assert.equal(view.name, '');
      assert.equal(view.description, '');
      assert.equal(view.composerOpen, false);
      assert.equal(view.definitionConfirmation, false);
    };
    const createRoute = {
      mode: 'create',
      scope: 'global',
      categoryId: f.data.global.categoryId,
    };
    const fill = async (client: ReturnType<typeof native>, label: string) => {
      await client.controller.load(createRoute);
      assert.equal(client.view().loaded, true, client.view().error);
      client.controller.setDefinition('name', ` ${label} 🌊 `);
      client.controller.setDefinition(
        'description',
        ' Exact native description ',
      );
      client.controller.confirmDefinition();
      assert.equal(client.view().definitionConfirmation, true);
    };
    const requestCount = async (input: RatingScopedIntent) =>
      (
        await f.pool.query<{ n: number }>(
          'SELECT count(*)::int n FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0]!.n;
    let created!: { id: string; revision: string };

    await t.test(
      'lost prepare/commit retain exact original v9 bytes and create only once, then history wins before route/context',
      async () => {
        const device = platformStorage();
        const client = native(actor, device);
        await fill(client, 'Native scoped target');
        client.transport.dropSuccess = {
          path: '/v2/ratings/management/prepare',
          method: 'POST',
        };
        await Promise.all([
          client.controller.commitDefinition(),
          client.controller.commitDefinition(),
        ]);
        const pending = client.pending()!;
        assert.equal(pending.version, 9);
        assert.equal(pending.intent.operation, 'create_target_scoped');
        assert.equal(pending.intent.payload['name'], 'Native scoped target 🌊');
        assert.equal(
          ratingScopedIntentHash(pending.intent),
          ratingScopedCommandHash(pending.intent),
        );
        const key = `whaleu.ratings.pending.v9:${directoryNativeOrigin}:${actor.accountId}`;
        const bytes = JSON.stringify(device.storage.get(key));
        assert.equal(client.view().frozen, true);
        emptyDraft(client.view());
        assert.equal(await requestCount(pending.intent), 0);
        await client.controller.recover();
        assert.equal(JSON.stringify(device.storage.get(key)), bytes);
        client.transport.dropSuccess = {
          path: '/v2/ratings/management/targets',
          method: 'POST',
        };
        await client.controller.recover(true);
        assert.equal(await requestCount(pending.intent), 1);
        assert.equal(JSON.stringify(device.storage.get(key)), bytes);
        const receipt = scopedSuccess(
          (
            await f.pool.query(
              'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
              [actor.accountId, pending.intent.payload.clientRequestId],
            )
          ).rows[0]!.receipt,
        );
        created = {
          id: String(receipt.result['targetId']),
          revision: String(receipt.result['revision']),
        };
        const restored = native(await f.freshSession(actor), device);
        await restored.controller.load({
          invalid: 'route that must not be decoded before receipt',
        });
        assert.equal(restored.pending(), null, restored.view().error);
        assert.deepEqual(
          restored.transport.sent.map((r) => [r.method, r.path]),
          [
            [
              'GET',
              `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        emptyDraft(restored.view());
        assert.equal(await requestCount(pending.intent), 1);
        for (const row of client.transport.sent.filter(
          (r) => r.path === '/v2/ratings/management/prepare',
        ))
          assert.equal(row.bodyBytes, JSON.stringify(pending.intent));
      },
    );

    await t.test(
      'every v1–v8 pending slot blocks v9 and recovers the original route without scope issuance; reverse exclusion retains bytes',
      async () => {
        const candidate = await f.commandIntent(actor, 'create_target_scoped', {
          name: 'Blocked scoped target',
          description: '',
          assetIds: [],
        });
        const targetId = created.id,
          revision = created.revision,
          categoryId = f.data.global.categoryId,
          categoryRevision = candidate.payload.expectedCategoryRevision;
        const oldInputs = [
          {
            operation: 'set_score',
            targetId,
            payload: {
              clientRequestId: randomUUID(),
              regionId: null,
              expectedTargetRevision: revision,
              expectedRevision: null,
              score: 5,
            },
          },
          {
            operation: 'create_reply',
            rootId: randomUUID(),
            payload: {
              clientRequestId: randomUUID(),
              regionId: null,
              targetId,
              expectedTargetRevision: revision,
              expectedRootRevision: randomUUID(),
              replyTo: null,
              authorMode: 'named',
              body: 'Unsent legacy reply',
              assetIds: [],
            },
          },
          {
            operation: 'set_target_subscription',
            targetId,
            payload: {
              clientRequestId: randomUUID(),
              regionId: null,
              expectedTargetRevision: revision,
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
              expectedCatalogRevision: candidate.context.catalogRevision,
              name: 'Unsent old target',
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
              expectedDefinitionRevision: revision,
              expectedContentVersion: 1,
              categoryId,
              expectedCategoryRevision: categoryRevision,
              expectedCatalogRevision: candidate.context.catalogRevision,
              name: 'Unsent old edit',
              description: '',
              assetIds: [],
            },
          },
          {
            operation: 'create_categories',
            payload: {
              clientRequestId: randomUUID(),
              regionId: null,
              expectedCatalogRevision: candidate.context.catalogRevision,
              expectedScopeRevision: 'x'.repeat(43),
              parentId: null,
              expectedParentRevision: null,
              nodes: [
                {
                  key: 'root',
                  parentKey: null,
                  name: 'Unsent old category',
                  description: '',
                },
              ],
              assetIds: [],
            },
          },
        ];
        const prefixes = [
          '/v1/ratings/requests',
          '/v1/ratings/reply-requests',
          '/v1/ratings/subscription-requests',
          '/v1/ratings/admin/requests',
          '/v1/ratings/management/requests',
          '/v1/ratings/management/owner-deletion/requests',
          '/v1/ratings/management/owner-edit/requests',
          '/v1/ratings/category-management/requests',
        ];
        for (const [index, raw] of oldInputs.entries()) {
          const client = native(),
            version = index + 1;
          const old = client.runtime.pendingRatings.freeze({
            version,
            accountId: actor.accountId,
            intent: decodeRatingCommandIntent(raw),
          });
          const key = `whaleu.ratings.pending.v${version}:${directoryNativeOrigin}:${actor.accountId}`;
          const before = JSON.stringify(client.device.storage.get(key));
          assert.throws(() =>
            client.runtime.pendingRatings.freeze({
              version: 9,
              accountId: actor.accountId,
              intent: decodeRatingScopedIntent(candidate),
            }),
          );
          await client.controller.load({ bad: 'route' });
          assert.deepEqual(client.pending(), old);
          assert.equal(JSON.stringify(client.device.storage.get(key)), before);
          assert.deepEqual(
            client.transport.sent.map((r) => [r.method, r.path]),
            [['GET', `${prefixes[index]}/${raw.payload.clientRequestId}`]],
          );
          emptyDraft(client.view());
          const reverse = native();
          reverse.runtime.pendingRatings.freeze({
            version: 9,
            accountId: actor.accountId,
            intent: decodeRatingScopedIntent(candidate),
          });
          const key9 = `whaleu.ratings.pending.v9:${directoryNativeOrigin}:${actor.accountId}`;
          const before9 = JSON.stringify(reverse.device.storage.get(key9));
          assert.throws(() =>
            reverse.runtime.pendingRatings.freeze({
              version,
              accountId: actor.accountId,
              intent: decodeRatingCommandIntent(raw),
            }),
          );
          assert.equal(
            JSON.stringify(reverse.device.storage.get(key9)),
            before9,
          );
        }
      },
    );

    await t.test(
      'lost explicit cancellation is recovered from history in a new session and late commit cannot publish',
      async () => {
        const device = platformStorage(),
          client = native(actor, device);
        await fill(client, 'Never published cancelled target');
        client.transport.failNext = '/v2/ratings/management/targets';
        await client.controller.commitDefinition();
        const pending = client.pending()!;
        assert.equal(await requestCount(pending.intent), 0);
        const sent = client.transport.sent.length;
        await client.controller.cancelPending();
        assert.equal(
          client.transport.sent.length,
          sent,
          'Cancellation needs an explicit UI confirmation',
        );
        client.controller.requestCancelPending();
        client.controller.dismissCancelPending();
        await client.controller.cancelPending();
        assert.equal(client.transport.sent.length, sent);
        client.controller.requestCancelPending();
        client.transport.dropSuccess = {
          path: '/v2/ratings/management/cancel',
          method: 'POST',
        };
        await client.controller.cancelPending();
        assert.deepEqual(client.pending(), pending);
        assert.equal(
          client.transport.sent.at(-1)!.bodyBytes,
          JSON.stringify(pending.intent),
        );
        const restored = native(await f.freshSession(actor), device);
        await restored.controller.load(null);
        assert.equal(restored.pending(), null);
        assert.deepEqual(
          restored.transport.sent.map((r) => [r.method, r.path]),
          [
            [
              'GET',
              `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        const receipt = await restored.gateway.command(
          pending.intent,
          restored.cancellation,
        );
        assert.equal(receipt.outcome, 'closed');
        assert.equal(receipt.code, 'RATING_CREATION_CANCELLED');
        assert.equal(
          restored.transport.sent.some(
            (r) => r.path === '/v2/ratings/management/targets',
          ),
          false,
        );
        const p = (
          await f.pool.query(
            'SELECT target_id FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
            [actor.accountId, pending.intent.payload.clientRequestId],
          )
        ).rows[0]!;
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.targets WHERE id=$1',
              [p.target_id],
            )
          ).rowCount,
          0,
        );
      },
    );

    for (const boundary of [
      'account',
      'same-account-session',
      'hide',
      'back',
      'close',
      'scope',
    ] as const)
      await t.test(
        `${boundary} during a held real prepare response clears drafts, preserves original bytes and forbids late commit`,
        async () => {
          const client = native();
          await fill(client, `Boundary ${boundary}`);
          const held = client.transport.holdNext(
            '/v2/ratings/management/prepare',
            'POST',
          );
          const work = client.controller.commitDefinition();
          await held.arrived;
          const pending = client.pending()!,
            bytes = JSON.stringify(pending);
          if (boundary === 'account')
            client.sessions.completeLogin(client.sessions.beginLogin(), other);
          else if (boundary === 'same-account-session')
            client.sessions.completeLogin(
              client.sessions.beginLogin(),
              await f.freshSession(actor),
            );
          else if (boundary === 'hide') client.runtime.privateViews.clear();
          else if (boundary === 'close') client.controller.dismissDefinition();
          else
            await client.controller.load(
              boundary === 'scope'
                ? { mode: 'catalog', scope: 'campus', campusId: f.campusB }
                : { mode: 'catalog', scope: 'global' },
            );
          held.release();
          await work;
          assert.equal(JSON.stringify(client.pending()), bytes);
          emptyDraft(client.view());
          assert.equal(
            client.transport.sent.some(
              (r) => r.path === '/v2/ratings/management/targets',
            ),
            false,
          );
          assert.equal(await requestCount(pending.intent), 0);
          assert.deepEqual(client.changes, []);
          const restored = native(actor, client.device);
          await restored.controller.load(null);
          assert.deepEqual(restored.pending(), pending);
          restored.controller.requestCancelPending();
          await restored.controller.cancelPending();
          assert.equal(restored.pending(), null, restored.view().error);
        },
      );

    await t.test(
      'a held post-commit callback cannot settle another account; a new session recovers the original committed request',
      async () => {
        const client = native();
        await fill(client, 'Committed before account replacement');
        const held = client.transport.holdNext(
          '/v2/ratings/management/targets',
          'POST',
        );
        const work = client.controller.commitDefinition();
        await held.arrived;
        const pending = client.pending()!;
        assert.equal(await requestCount(pending.intent), 1);
        client.sessions.completeLogin(client.sessions.beginLogin(), other);
        held.release();
        await work;
        assert.deepEqual(client.pending(), pending);
        assert.deepEqual(client.changes, []);
        emptyDraft(client.view());
        const restored = native(await f.freshSession(actor), client.device);
        await restored.controller.load(null);
        assert.equal(restored.pending(), null, restored.view().error);
        assert.deepEqual(
          restored.transport.sent.map((r) => [r.method, r.path]),
          [
            [
              'GET',
              `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        assert.equal(await requestCount(pending.intent), 1);
      },
    );

    const definitionState = async (targetId: string) =>
      (
        await f.pool.query(
          `SELECT t.revision,h.content_version,h.definition_revision,
            (SELECT count(*)::int FROM whaleu_ratings.target_definition_versions WHERE target_id=t.id) definitions,
            (SELECT count(*)::int FROM whaleu_community.rating_scoped_target_definition_bindings WHERE target_id=t.id) bindings,
            (SELECT count(*)::int FROM whaleu_ratings.target_definition_lifecycles WHERE target_id=t.id) lifecycles
           FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id WHERE t.id=$1`,
          [targetId],
        )
      ).rows[0]!;
    const editRoute = (targetId: string) => ({
      mode: 'edit',
      scope: 'global',
      targetId,
    });
    const fillEdit = async (
      client: ReturnType<typeof native>,
      targetId: string,
      name?: string,
    ) => {
      await client.controller.load(editRoute(targetId));
      assert.equal(client.view().loaded, true, client.view().error);
      const issued = client.transport.sent
        .filter((r) => r.path === '/v2/ratings/contexts')
        .map((r) => JSON.parse(r.bodyBytes!));
      assert.deepEqual(
        issued.map((r) => r.purpose),
        ['read', 'edit_target'],
      );
      if (name !== undefined) client.controller.setDefinition('name', name);
      client.controller.confirmDefinition();
      assert.equal(client.view().definitionConfirmation, true);
    };
    const originalStorage = (client: ReturnType<typeof native>) =>
      JSON.stringify(
        client.device.storage.get(
          `whaleu.ratings.pending.v9:${directoryNativeOrigin}:${actor.accountId}`,
        ),
      );
    const persistedReceipt = async (intent: RatingScopedIntent) =>
      (
        await f.pool.query(
          'SELECT receipt FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, intent.payload.clientRequestId],
        )
      ).rows[0]!.receipt;

    await t.test(
      'M2 controller loses prepare and commit responses without replacing intent or publishing a second definition',
      async () => {
        const target = await f.createScopedTarget(
            actor,
            'M2 original definition',
          ),
          client = native(),
          before = await definitionState(target.id);
        await fillEdit(client, target.id, '  M2 exact edited definition 🌊  ');
        client.transport.dropSuccess = {
          path: '/v2/ratings/management/owner-edit/prepare',
          method: 'POST',
        };
        await Promise.all([
          client.controller.commitDefinition(),
          client.controller.commitDefinition(),
        ]);
        const pending = client.pending()!;
        assert.equal(pending.version, 9);
        assert.equal(pending.intent.operation, 'edit_target_scoped');
        assert.equal(
          pending.intent.payload['name'],
          'M2 exact edited definition 🌊',
        );
        assert.equal(
          pending.intent.payload['expectedTargetRevision'],
          before.revision,
        );
        assert.equal(
          pending.intent.payload['expectedDefinitionRevision'],
          before.definition_revision,
        );
        assert.equal(
          pending.intent.payload['expectedContentVersion'],
          before.content_version,
        );
        assert.equal(
          ratingScopedIntentHash(pending.intent),
          ratingScopedCommandHash(pending.intent),
        );
        const bytes = originalStorage(client),
          contexts = client.transport.sent.filter(
            (r) => r.path === '/v2/ratings/contexts',
          ).length;
        assert.equal(await requestCount(pending.intent), 0);
        assert.deepEqual(await definitionState(target.id), before);
        emptyDraft(client.view());
        await client.controller.recover();
        assert.equal(originalStorage(client), bytes);
        client.transport.dropSuccess = {
          path: '/v2/ratings/management/owner-edit/commit',
          method: 'POST',
        };
        await client.controller.recover(true);
        assert.equal(originalStorage(client), bytes);
        assert.equal(await requestCount(pending.intent), 1);
        assert.equal(
          client.transport.sent.filter((r) => r.path === '/v2/ratings/contexts')
            .length,
          contexts,
        );
        const receipt = scopedSuccess(await persistedReceipt(pending.intent)),
          after = await definitionState(target.id);
        assert.equal(receipt.operation, 'edit_target_scoped');
        assert.equal(after.content_version, before.content_version + 1);
        assert.equal(after.definitions, before.definitions + 1);
        assert.equal(after.bindings, before.bindings + 1);
        assert.equal(after.lifecycles, before.lifecycles + 1);
        assert.equal(after.revision, receipt.result['revision']);
        for (const sent of client.transport.sent.filter(
          (r) => r.path === '/v2/ratings/management/owner-edit/prepare',
        ))
          assert.equal(sent.bodyBytes, JSON.stringify(pending.intent));
        const restored = native(await f.freshSession(actor), client.device);
        await restored.controller.load({
          bad: 'route cannot precede original history',
        });
        assert.equal(restored.pending(), null, restored.view().error);
        assert.deepEqual(
          restored.transport.sent.map((r) => [r.method, r.path]),
          [
            [
              'GET',
              `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        assert.deepEqual(await definitionState(target.id), after);
        assert.equal(await requestCount(pending.intent), 1);
      },
    );

    await t.test(
      'M2 explicit cancel lost response settles in a new session and a late original commit stays closed',
      async () => {
        const target = await f.createScopedTarget(
            actor,
            'M2 preserved by cancellation',
          ),
          client = native(),
          before = await definitionState(target.id),
          effects = await f.scopedEffects();
        await fillEdit(client, target.id, 'M2 cancelled draft');
        client.transport.failNext = '/v2/ratings/management/owner-edit/commit';
        await client.controller.commitDefinition();
        const pending = client.pending()!,
          bytes = originalStorage(client);
        assert.equal(pending.intent.operation, 'edit_target_scoped');
        assert.equal(await requestCount(pending.intent), 0);
        const sent = client.transport.sent.length;
        await client.controller.cancelPending();
        assert.equal(client.transport.sent.length, sent);
        client.controller.requestCancelPending();
        client.controller.dismissCancelPending();
        await client.controller.cancelPending();
        assert.equal(client.transport.sent.length, sent);
        client.controller.requestCancelPending();
        client.transport.dropSuccess = {
          path: '/v2/ratings/management/owner-edit/cancel',
          method: 'POST',
        };
        await client.controller.cancelPending();
        assert.equal(originalStorage(client), bytes);
        assert.equal(
          client.transport.sent.at(-1)!.bodyBytes,
          JSON.stringify(pending.intent),
        );
        const restored = native(await f.freshSession(actor), client.device);
        await restored.controller.load(null);
        assert.equal(restored.pending(), null, restored.view().error);
        assert.deepEqual(
          restored.transport.sent.map((r) => [r.method, r.path]),
          [
            [
              'GET',
              `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        const late = await restored.gateway.command(
          pending.intent,
          restored.cancellation,
        );
        assert.equal(late.outcome, 'closed');
        assert.equal(late.code, 'RATING_EDIT_CANCELLED');
        assert.equal(
          restored.transport.sent.some(
            (r) => r.path === '/v2/ratings/management/owner-edit/commit',
          ),
          false,
        );
        assert.deepEqual(await definitionState(target.id), before);
        assert.deepEqual(await f.scopedEffects(), effects);
      },
    );

    await t.test(
      'M2 unchanged native form produces a historical noop without definition, lifecycle, binding or effect churn',
      async () => {
        const target = await f.createScopedTarget(actor, 'M2 native noop'),
          client = native(),
          before = await definitionState(target.id),
          effects = await f.scopedEffects();
        client.transport.approve = null;
        await fillEdit(client, target.id);
        client.transport.dropSuccess = {
          path: '/v2/ratings/management/owner-edit/commit',
          method: 'POST',
        };
        await client.controller.commitDefinition();
        const pending = client.pending()!,
          bytes = originalStorage(client);
        assert.equal(pending.intent.operation, 'edit_target_scoped');
        const receipt = scopedSuccess(
          await persistedReceipt(pending.intent),
          'noop',
        );
        assert.equal(receipt.result['revision'], before.revision);
        assert.equal(
          receipt.result['definitionRevision'],
          before.definition_revision,
        );
        assert.equal(receipt.result['contentVersion'], before.content_version);
        assert.deepEqual(await definitionState(target.id), before);
        assert.deepEqual(await f.scopedEffects(), effects);
        const restored = native(await f.freshSession(actor), client.device),
          held = restored.transport.holdNext(
            `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
          );
        const recovery = restored.controller.load({
          mode: 'edit',
          scope: 'campus',
          campusId: randomUUID(),
          targetId: randomUUID(),
        });
        await held.arrived;
        assert.equal(originalStorage(restored), bytes);
        held.release();
        await recovery;
        assert.equal(restored.pending(), null, restored.view().error);
        assert.deepEqual(
          restored.transport.sent.map((r) => [r.method, r.path]),
          [
            [
              'GET',
              `/v2/ratings/requests/${pending.intent.payload.clientRequestId}`,
            ],
          ],
        );
        assert.deepEqual(await definitionState(target.id), before);
        assert.deepEqual(await f.scopedEffects(), effects);
      },
    );

    for (const boundary of ['hide', 'close', 'account'] as const)
      await t.test(
        `M2 ${boundary} during a real prepared edit rejects the late callback and keeps the original bytes`,
        async () => {
          const target = await f.createScopedTarget(
              actor,
              `M2 ${boundary} before`,
            ),
            client = native(),
            before = await definitionState(target.id);
          await fillEdit(client, target.id, `M2 ${boundary} forbidden edit`);
          const held = client.transport.holdNext(
              '/v2/ratings/management/owner-edit/prepare',
              'POST',
            ),
            commit = client.controller.commitDefinition();
          await held.arrived;
          const pending = client.pending()!,
            bytes = originalStorage(client);
          assert.equal(pending.intent.operation, 'edit_target_scoped');
          if (boundary === 'hide') client.runtime.privateViews.clear();
          else if (boundary === 'close') client.controller.dismissDefinition();
          else
            client.sessions.completeLogin(client.sessions.beginLogin(), other);
          held.release();
          await commit;
          emptyDraft(client.view());
          assert.equal(originalStorage(client), bytes);
          assert.equal(
            client.transport.sent.some(
              (r) => r.path === '/v2/ratings/management/owner-edit/commit',
            ),
            false,
          );
          assert.equal(await requestCount(pending.intent), 0);
          assert.deepEqual(await definitionState(target.id), before);
          assert.deepEqual(client.changes, []);
          const restored = native(await f.freshSession(actor), client.device);
          await restored.controller.load(null);
          assert.deepEqual(restored.pending(), pending);
          restored.controller.requestCancelPending();
          await restored.controller.cancelPending();
          assert.equal(restored.pending(), null, restored.view().error);
          assert.deepEqual(await definitionState(target.id), before);
        },
      );

    await t.test(
      'real source publication between read and command issuance rejects the pair before rendering, drafting or freezing',
      async () => {
        const client = native(),
          contexts: ReturnType<typeof decodeRatingScopedContext>[] = [];
        client.transport.checkResponse = (path, status, body) => {
          if (path === '/v2/ratings/contexts' && status === 200)
            contexts.push(decodeRatingScopedContext(body));
        };
        const held = client.transport.holdNext('/v2/ratings/contexts', 'POST'),
          loading = client.controller.load({
            mode: 'create',
            scope: 'campus',
            campusId: f.campusA,
            categoryId: f.data.local.categoryId,
          });
        await held.arrived;
        try {
          await f.atomicChange((tx) =>
            f.order(f.data.local, f.campusA, '19', tx),
          );
        } finally {
          held.release();
        }
        await loading;
        assert.equal(contexts.length, 2);
        assert.equal(contexts[0]!.purpose, 'read');
        assert.equal(contexts[1]!.purpose, 'create_target');
        assert.notEqual(contexts[0]!.id, contexts[1]!.id);
        assert.notEqual(contexts[0]!.sourceDigest, contexts[1]!.sourceDigest);
        assert.notDeepEqual(contexts[0]!.heads, contexts[1]!.heads);
        assert.equal(client.view().loaded, false);
        assert.notEqual(client.view().error, '');
        emptyDraft(client.view());
        client.controller.setDefinition(
          'name',
          'Cannot draft against mixed observations',
        );
        client.controller.confirmDefinition();
        await client.controller.commitDefinition();
        assert.equal(client.pending(), null);
        emptyDraft(client.view());
        assert.deepEqual(
          client.transport.sent.map((r) => [r.method, r.path]),
          [
            ['POST', '/v2/ratings/contexts'],
            ['POST', '/v2/ratings/contexts'],
          ],
        );
        assert.deepEqual(client.changes, []);
      },
    );

    await t.test(
      'a real successful v4 cleanup receipt wins over hidden adopted content and preserves the original slot until exact history settles',
      async () => {
        await f.grant(other, 'super_admin');
        const target = await f.createScopedTarget(
            actor,
            'Hidden legacy receipt target',
          ),
          root = await f.executeCommand(
            actor,
            await f.commandIntent(actor, 'create_comment_scoped', {
              targetId: target.id,
              expectedTargetRevision: target.revision,
              authorMode: 'named',
              body: 'Native legacy successful history',
              assetIds: [],
            }),
          ),
          rootId = String(scopedSuccess(root.receipt).result['subjectId']),
          context = await f.context(other, 'comment', rootId),
          input = f.command(context),
          legacy = decodeRatingCommandIntent({
            operation: 'admin_delete_comment',
            subjectId: rootId,
            payload: input,
          }),
          client = native(other);
        client.runtime.pendingRatings.freeze({
          version: 4,
          accountId: other.accountId,
          intent: legacy,
        });
        const key = `whaleu.ratings.pending.v4:${directoryNativeOrigin}:${other.accountId}`,
          bytes = JSON.stringify(client.device.storage.get(key)),
          removed = await f.remove(other, 'comment', rootId, input);
        assert.equal(removed.status, 200, JSON.stringify(removed.body));
        assert.equal(removed.body.outcome, 'applied');
        assert.ok(target.approved);
        await setRatingReviewState(
          f.pool,
          target.approved.decisionId,
          'revoked',
        );
        const effects = await f.scopedEffects(),
          restored = native(await f.freshSession(other), client.device),
          receiptPath = `/v1/ratings/admin/requests/${input.clientRequestId}`,
          held = restored.transport.holdNext(receiptPath);
        let response: unknown;
        restored.transport.checkResponse = (path, status, body) => {
          if (path === receiptPath) {
            assert.equal(status, 200);
            response = body;
          }
        };
        const recovery = restored.controller.load({
          bad: 'invalid route, hidden target and missing selector must not precede history',
        });
        await held.arrived;
        assert.equal(JSON.stringify(restored.device.storage.get(key)), bytes);
        assert.deepEqual(restored.pending()!.intent, legacy);
        held.release();
        await recovery;
        assert.equal(restored.pending(), null, restored.view().error);
        assert.deepEqual(response, removed.body);
        assert.deepEqual(
          restored.transport.sent.map((r) => [r.method, r.path]),
          [['GET', receiptPath]],
        );
        assert.deepEqual(await f.scopedEffects(), effects);
        emptyDraft(restored.view());
      },
    );

    await t.test(
      'all eight native gateway commands decode actual server results and use the original exact wire hash',
      async () => {
        const client = native(),
          seen = new Set<string>();
        const perform = async (input: RatingScopedIntent) => {
          if (
            input.operation === 'create_comment_scoped' ||
            input.operation === 'create_reply_scoped'
          ) {
            await f.prepareCommand(actor, input);
            await f.approveCommand(actor, input);
          }
          const result = await client.gateway.command(
            decodeRatingScopedIntent(input),
            client.cancellation,
          );
          assert.deepEqual(decodeRatingScopedReceipt(result), result);
          assert.equal(result.intentHash, ratingScopedCommandHash(input));
          seen.add(input.operation);
          return scopedSuccess(result);
        };
        const creation = await perform(
          await f.commandIntent(actor, 'create_target_scoped', {
            name: 'Native eight-operation target',
            description: '',
            assetIds: [],
          }),
        );
        const targetId = String(creation.result['targetId']);
        let revision = String(creation.result['revision']);
        const target = () => ({ targetId, expectedTargetRevision: revision });
        await perform(
          await f.commandIntent(actor, 'set_score_scoped', {
            ...target(),
            expectedRevision: null,
            score: 5,
          }),
        );
        const root = await perform(
          await f.commandIntent(actor, 'create_comment_scoped', {
            ...target(),
            authorMode: 'named',
            body: 'Native exact comment',
            assetIds: [],
          }),
        );
        const rootId = String(root.result['subjectId']),
          rootRevision = String(root.result['revision']);
        const reply = await perform(
          await f.commandIntent(actor, 'create_reply_scoped', {
            ...target(),
            rootId,
            expectedRootRevision: rootRevision,
            replyTo: null,
            authorMode: 'named',
            body: 'Native exact reply',
            assetIds: [],
          }),
        );
        const replyId = String(reply.result['replyId']),
          replyRevision = String(reply.result['revision']);
        let context = await client.gateway.context(
          { purpose: 'read', mode: 'public', selector: { kind: 'global' } },
          client.cancellation,
        );
        assert.deepEqual(decodeRatingScopedContext(context), context);
        const like = await client.gateway.commentLike(
          context,
          rootId,
          client.cancellation,
        );
        await perform(
          await f.commandIntent(actor, 'set_comment_like_scoped', {
            ...target(),
            rootId,
            expectedRevision: rootRevision,
            expectedLikeRevision: like.revision,
            liked: true,
          }),
        );
        const replyLike = await client.gateway.replyLike(
          context,
          replyId,
          client.cancellation,
        );
        await perform(
          await f.commandIntent(actor, 'set_reply_like_scoped', {
            ...target(),
            rootId,
            expectedRootRevision: rootRevision,
            replyId,
            expectedRevision: replyRevision,
            expectedLikeRevision: replyLike.revision,
            liked: true,
          }),
        );
        const subscription = await client.gateway.subscription(
          context,
          targetId,
          client.cancellation,
        );
        await perform(
          await f.commandIntent(actor, 'set_target_subscription_scoped', {
            ...target(),
            expectedSubscriptionRevision: subscription.revision,
            subscribed: true,
          }),
        );
        const edited = await perform(
          await f.scopedEditIntent(actor, targetId, {
            name: 'Native edited definition',
          }),
        );
        revision = String(edited.result['revision']);
        assert.equal(seen.size, 8);
        context = await client.gateway.context(
          { purpose: 'read', mode: 'public', selector: { kind: 'global' } },
          client.cancellation,
        );
        const detail = await client.gateway.detail(
          context,
          targetId,
          client.cancellation,
        );
        assert.equal(detail.name, 'Native edited definition');
        assert.equal(detail.revision, revision);
        const before = await f.scopedEffects();
        for (const row of client.transport.sent.filter(
          (entry) => entry.bodyBytes && entry.method !== 'GET',
        )) {
          const value = JSON.parse(row.bodyBytes!);
          if (!value.operation?.endsWith('_scoped')) continue;
          const { preparationContextRevision: ignored, ...original } = value;
          void ignored;
          assert.equal(
            ratingScopedIntentHash(decodeRatingScopedIntent(original)),
            ratingScopedCommandHash(ratingScopedIntentSchema.parse(original)),
          );
        }
        assert.deepEqual(await f.scopedEffects(), before);
      },
    );

    await t.test(
      'strict native decoder rejects extra receipt fields after real commit; original key remains recoverable',
      async () => {
        const client = native();
        const input = await f.commandIntent(actor, 'create_target_scoped', {
          name: 'Decode corruption recovery',
          description: '',
          assetIds: [],
        });
        const frozen = client.runtime.pendingRatings.freeze({
          version: 9,
          accountId: actor.accountId,
          intent: decodeRatingScopedIntent(input),
        });
        client.transport.corruptNext = {
          path: '/v2/ratings/management/targets',
          transform: (body) => ({
            ...(body as object),
            secret: 'unexpected-field',
          }),
        };
        await assert.rejects(
          () => client.gateway.command(input, client.cancellation),
          protocolFailure,
        );
        assert.deepEqual(client.pending(), frozen);
        assert.equal(await requestCount(input), 1);
        await client.controller.load({ mode: 'recovery' });
        assert.equal(client.pending(), null);
        assert.equal(await requestCount(input), 1);
      },
    );
  },
);
