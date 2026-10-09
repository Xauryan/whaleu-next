import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../src/ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../src/ratings/updates-source/subscription-projection.js';
import { RatingSubscriptionUpdatesRepository } from '../../src/notifications/ratings/subscription-repository.js';
import { RatingSubscriptionUpdatesWorker } from '../../src/notifications/ratings/subscription-worker.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import {
  platformStorage,
  protocolFailure,
} from '../support/experience-native-bridge.js';

// Real Native ApiClient/gateway/controllers -> ordinary AppModule HTTP -> PostgreSQL.
// Only device I/O is bridged; no response/current-membership/provider stub is used.
interface KnownState {
  status: 'known';
  targetId: string;
  count: number;
  subscribed: boolean;
  revision: string;
  allowedActions: { setSubscription: true };
}
type State = KnownState | { status: 'unavailable' };
interface Intent {
  operation: 'set_target_subscription';
  targetId: string;
  payload: {
    clientRequestId: string;
    regionId: string | null;
    expectedTargetRevision: string;
    expectedSubscriptionRevision: string;
    subscribed: boolean;
  };
}
interface Receipt {
  requestId: string;
  operation: 'set_target_subscription';
  outcome: 'applied' | 'noop';
  targetId: string;
  subscribed: boolean;
  revision: string;
  occurredAt: string;
}
interface RatingView {
  loaded: boolean;
  frozen: boolean;
  error: string;
  receiptStatus: string;
  targets: readonly { id: string; revision: string }[];
  subscriptions: Readonly<Record<string, State>>;
}
interface ThreadView {
  loaded: boolean;
  error: string;
  anchorReplyId: string;
}
interface UpdatesView {
  loaded: boolean;
  error: string;
  category: 'reply' | 'like' | 'subscription';
  unreadCount: number | null;
  items: readonly {
    noticeId: string;
    status: string;
    kind?: string;
    activity?: string;
    readAt: string | null;
    target?: {
      regionId: string | null;
      targetId: string;
      rootId: string;
      replyId: string | null;
    };
  }[];
}
interface Sent {
  path: string;
  method: string;
  bodyBytes?: string;
}
class ObservedSubscriptionTransport extends DirectoryHttpTransport {
  readonly sent: Sent[] = [];
  inFlight = 0;
  maximumInFlight = 0;
  beforeSend: ((sent: Sent) => void) | null = null;
  override send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    const url = new URL(input.url),
      path = url.pathname;
    const sent = {
      path: `${path}${url.search}`,
      method: input.method,
      ...(input.body === undefined
        ? {}
        : { bodyBytes: JSON.stringify(input.body) }),
    };
    this.sent.push(sent);
    this.beforeSend?.(sent);
    const statusRead =
      (input.method === 'GET' &&
        /^\/v1\/ratings\/targets\/[^/]+\/subscription$/.test(path)) ||
      (input.method === 'POST' &&
        path === '/v1/ratings/subscription-states/query');
    if (statusRead) {
      this.inFlight++;
      this.maximumInFlight = Math.max(this.maximumInFlight, this.inFlight);
    }
    return super.send(input).finally(() => {
      if (statusRead) this.inFlight--;
    });
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
  RatingController,
} = require('../../../wechat/src/ratings/controller.ts');
const {
  RatingThreadController,
} = require('../../../wechat/src/ratings/discussion-controller.ts');
const {
  RatingUpdatesController,
} = require('../../../wechat/src/ratings/updates-controller.ts');
const {
  decodeRatingSubscriptionState,
  decodeRatingSubscriptionReceipt,
  decodeRatingSubscriptionBatch,
} = require('../../../wechat/src/ratings/subscription-contract.ts');
const {
  readRatingSubscriptionStates,
} = require('../../../wechat/src/ratings/subscription-controller.ts');
const {
  decodeRatingSubscriptionUpdatesPage,
  decodeRatingSubscriptionNoticeTarget,
} = require('../../../wechat/src/ratings/subscription-updates-contract.ts');

test(
  'R2C actual native HTTP/PG subscription cards, desired state, immutable recovery and independently reread state',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      subscriber = await f.actor(),
      other = await f.actor();
    const catalog = await f.catalog(owner, { count: 50 }),
      target = catalog.targets[0]!;
    type Actor = typeof owner;
    const golden: Record<string, unknown> = {};
    function capture(name: string, body: unknown) {
      const bytes = JSON.stringify(body);
      for (const actor of [owner, subscriber, other]) {
        assert.equal(bytes.includes(actor.accountId), false);
        assert.equal(bytes.includes(actor.accessToken), false);
      }
      assert.doesNotMatch(
        bytes,
        /"(?:accountId|actorAccountId|recipientAccountId|beneficiaryId|envelope|approval|digest)"/,
      );
      golden[name] ??= structuredClone(body);
    }
    const native = (actor: Actor) => {
      const transport = new ObservedSubscriptionTransport(f.port),
        sessions = new SessionStore(),
        device = platformStorage();
      sessions.completeLogin(sessions.beginLogin(), actor);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error('No provider calls');
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
      const detailViews: RatingView[] = [],
        catalogViews: RatingView[] = [],
        threadViews: ThreadView[] = [],
        updatesViews: UpdatesView[] = [],
        navigation: string[] = [];
      const detail = new RatingController(
        runtime,
        'detail',
        (view: RatingView) => detailViews.push(view),
      );
      const directory = new RatingController(
        runtime,
        'catalog',
        (view: RatingView) => catalogViews.push(view),
      );
      const thread = new RatingThreadController(runtime, (view: ThreadView) =>
        threadViews.push(view),
      );
      const updates = new RatingUpdatesController(
        runtime,
        (view: UpdatesView) => updatesViews.push(view),
        async (path: string) => {
          navigation.push(path);
        },
      );
      t.after(() => {
        detail.dispose();
        directory.dispose();
        thread.dispose();
        updates.dispose();
      });
      transport.checkResponse = (path, status, body) => {
        if (status !== 200) return;
        const raw = body as Record<string, unknown>;
        if (path === '/v1/ratings/subscription-states/query') {
          assert.deepEqual(decodeRatingSubscriptionBatch(body), body);
          capture('subscriptionBatch', body);
        } else if (
          /^\/v1\/ratings\/targets\/[^/]+\/subscription$/.test(path) ||
          path.startsWith('/v1/ratings/subscription-requests/')
        ) {
          if (raw['status'] !== undefined) {
            assert.deepEqual(decodeRatingSubscriptionState(body), body);
            capture(
              raw['status'] === 'known'
                ? 'knownSubscription'
                : 'unavailableSubscription',
              body,
            );
            assert.throws(
              () =>
                decodeRatingSubscriptionState({
                  ...raw,
                  accountId: actor.accountId,
                }),
              protocolFailure,
            );
          } else {
            assert.deepEqual(decodeRatingSubscriptionReceipt(body), body);
            capture(`${String(raw['outcome'])}SubscriptionReceipt`, body);
            assert.throws(
              () => decodeRatingSubscriptionReceipt({ ...raw, count: 0 }),
              protocolFailure,
            );
          }
        } else if (path === '/v1/me/ratings/subscription-updates') {
          assert.deepEqual(decodeRatingSubscriptionUpdatesPage(body), body);
          capture('subscriptionUpdates', body);
        } else if (
          /^\/v1\/me\/ratings\/subscription-updates\/[^/]+\/target$/.test(path)
        ) {
          assert.deepEqual(decodeRatingSubscriptionNoticeTarget(body), body);
          capture('subscriptionNoticeTarget', body);
        }
      };
      return {
        actor,
        transport,
        device,
        runtime,
        detail,
        directory,
        thread,
        updates,
        navigation,
        cancel: new Cancellation(),
        detailView: () => detailViews.at(-1)!,
        catalogView: () => catalogViews.at(-1)!,
        threadView: () => threadViews.at(-1)!,
        updatesView: () => updatesViews.at(-1)!,
      };
    };
    const a = native(subscriber),
      second = native(subscriber),
      b = native(other),
      r = native(owner);
    type Native = ReturnType<typeof native>;
    async function known(n: Native): Promise<KnownState> {
      const state = (await n.runtime.ratingSubscriptions.state(
        catalog.regionId,
        target.id,
        n.cancel,
      )) as State;
      assert.equal(state.status, 'known', JSON.stringify(state));
      if (state.status !== 'known')
        throw new Error('Expected independent native subscription baseline');
      return state;
    }
    async function desired(n: Native, subscribed: boolean) {
      const state = await known(n);
      const intent: Intent = {
        operation: 'set_target_subscription',
        targetId: target.id,
        payload: {
          clientRequestId: randomUUID(),
          regionId: catalog.regionId,
          expectedTargetRevision: target.revision,
          expectedSubscriptionRevision: state.revision,
          subscribed,
        },
      };
      return {
        intent,
        receipt: (await n.runtime.ratingSubscriptions.command(
          intent,
          n.cancel,
        )) as Receipt,
      };
    }
    await t.test(
      '50 actual target cards retain their old DTO and complete exactly three sequential read-only batches',
      async () => {
        const page = await a.runtime.ratings.targets(
          catalog.regionId,
          catalog.categoryId,
          null,
          a.cancel,
          50,
        );
        assert.equal(page.items.length, 50);
        for (const row of page.items) {
          assert.equal('subscribed' in row, false);
          assert.equal('count' in row, false);
          assert.equal('setSubscription' in row.allowedActions, false);
        }
        const start = a.transport.sent.length;
        const states = (await readRatingSubscriptionStates(
          a.runtime.ratingSubscriptions,
          catalog.regionId,
          page.items.map((row: { id: string; revision: string }) => ({
            targetId: row.id,
            expectedTargetRevision: row.revision,
          })),
          a.cancel,
        )) as Readonly<Record<string, State>>;
        assert.equal(Object.keys(states).length, 50);
        assert.ok(
          Object.values(states).every(
            (state) =>
              state.status === 'known' &&
              state.count === 0 &&
              !state.subscribed,
          ),
        );
        const batches = a.transport.sent
          .slice(start)
          .filter(
            (sent) => sent.path === '/v1/ratings/subscription-states/query',
          );
        assert.deepEqual(
          batches.map((sent) => JSON.parse(sent.bodyBytes!).targets.length),
          [20, 20, 10],
        );
        assert.equal(a.transport.maximumInFlight, 1);
        assert.ok(batches.every((sent) => sent.method === 'POST'));
        const stale = await a.runtime.ratingSubscriptions.states(
          catalog.regionId,
          [{ targetId: target.id, expectedTargetRevision: randomUUID() }],
          a.cancel,
        );
        assert.deepEqual(stale, {
          items: [{ targetId: target.id, state: { status: 'unavailable' } }],
        });
        await a.directory.load({ parentId: catalog.categoryId });
        assert.equal(a.catalogView().loaded, true, a.catalogView().error);
        assert.ok(a.catalogView().targets.length > 0);
        assert.ok(
          a
            .catalogView()
            .targets.every(
              (row) =>
                a.catalogView().subscriptions[row.id]?.status === 'known',
            ),
        );
      },
    );
    await t.test(
      'lost committed PUT and exact retry retain v3 while recovery reflects later independent current membership',
      async () => {
        await a.detail.load({ targetId: target.id });
        assert.equal(a.detailView().loaded, true, a.detailView().error);
        const before = await known(a),
          path = `/v1/ratings/targets/${target.id}/subscription`;
        const key = `whaleu.ratings.pending.v3:${directoryNativeOrigin}:${subscriber.accountId}`;
        a.transport.beforeSend = (sent) => {
          if (sent.path !== path || sent.method !== 'PUT') return;
          const stored = a.runtime.pendingRatings.load(subscriber.accountId);
          assert.ok(stored);
          assert.equal(stored.version, 3);
          assert.equal(sent.bodyBytes, JSON.stringify(stored.intent.payload));
        };
        const start = a.transport.sent.length;
        a.transport.dropSuccess = { path, method: 'PUT' };
        await a.detail.toggleSubscription();
        const pending = a.runtime.pendingRatings.load(subscriber.accountId) as {
          version: 3;
          accountId: string;
          intent: Intent;
        };
        assert.ok(pending);
        assert.equal(pending.version, 3);
        assert.equal(
          pending.intent.payload.expectedSubscriptionRevision,
          before.revision,
        );
        const original = JSON.stringify(a.device.storage.get(key));
        assert.equal(a.detailView().frozen, true);
        assert.deepEqual(a.detailView().subscriptions, {});
        assert.equal((await known(second)).subscribed, true);
        a.transport.dropSuccess = { path, method: 'PUT' };
        await a.detail.recover(true);
        assert.equal(JSON.stringify(a.device.storage.get(key)), original);
        const puts = a.transport.sent
          .slice(start)
          .filter((sent) => sent.path === path && sent.method === 'PUT');
        assert.equal(puts.length, 2);
        assert.equal(puts[0]!.bodyBytes, puts[1]!.bodyBytes);
        assert.equal((await desired(second, false)).receipt.outcome, 'applied');
        assert.equal((await desired(b, true)).receipt.outcome, 'applied');
        const current = await known(second);
        assert.equal(current.subscribed, false);
        assert.equal(current.count, 1);
        const historical = (await second.runtime.ratingSubscriptions.receipt(
          pending.intent.payload.clientRequestId,
          second.cancel,
        )) as Receipt;
        assert.equal(historical.subscribed, true);
        const recoveryStart = a.transport.sent.length;
        await a.detail.recover();
        assert.equal(a.runtime.pendingRatings.load(subscriber.accountId), null);
        assert.equal(a.device.storage.get(key), undefined);
        assert.equal(a.detailView().loaded, true, a.detailView().error);
        assert.deepEqual(a.detailView().subscriptions[target.id], current);
        assert.doesNotMatch(a.detailView().receiptStatus, /经验.*到账|送达/);
        assert.ok(
          a.transport.sent
            .slice(recoveryStart)
            .some(
              (sent) =>
                sent.path ===
                `/v1/ratings/subscription-requests/${pending.intent.payload.clientRequestId}`,
            ),
        );
        assert.equal(
          a.transport.sent
            .slice(recoveryStart)
            .some((sent) => sent.method === 'PUT'),
          false,
        );
        assert.deepEqual(
          await second.runtime.ratingSubscriptions.command(
            pending.intent,
            second.cancel,
          ),
          historical,
        );
        assert.deepEqual(await known(second), current);
        a.transport.beforeSend = null;
        const resubscribe = await desired(second, true);
        assert.equal(resubscribe.receipt.outcome, 'applied');
        assert.notEqual(resubscribe.receipt.revision, historical.revision);
        const noop = await desired(second, true);
        assert.equal(noop.receipt.outcome, 'noop');
        assert.equal(noop.receipt.revision, resubscribe.receipt.revision);
        const staleIntent = {
          ...resubscribe.intent,
          payload: {
            ...resubscribe.intent.payload,
            clientRequestId: randomUUID(),
            subscribed: false,
          },
        };
        const stale = await second.runtime.ratingSubscriptions.command(
          staleIntent,
          second.cancel,
        );
        assert.equal(stale.outcome, 'rejected');
        assert.equal(stale.code, 'RATING_REVISION_CONFLICT');
      },
    );
    await t.test(
      'a cancelled real response stops the remaining card queue and never repopulates the old view',
      async () => {
        const path = '/v1/ratings/subscription-states/query',
          held = a.transport.holdNext(path, 'POST'),
          cancel = new Cancellation();
        const start = a.transport.sent.length;
        const running = readRatingSubscriptionStates(
          a.runtime.ratingSubscriptions,
          catalog.regionId,
          catalog.targets.map((row) => ({
            targetId: row.id,
            expectedTargetRevision: row.revision,
          })),
          cancel,
        );
        const rejected = assert.rejects(
          running,
          (error: unknown) => (error as { kind?: string }).kind === 'cancelled',
        );
        await held.arrived;
        cancel.cancel();
        held.release();
        await rejected;
        assert.equal(
          a.transport.sent.slice(start).filter((sent) => sent.path === path)
            .length,
          1,
        );
      },
    );
    await t.test(
      'actual local worker root/reply notices locate exact current content before category-owned reads, without merging direct recipients',
      async () => {
        assert.equal((await desired(r, true)).receipt.outcome, 'applied');
        const root = await f.publish(owner, catalog, target);
        const reply = await f.publishReply(other, catalog, target, root);
        const eventIds = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_ratings.effect_events WHERE request_id=ANY($1::uuid[])',
            [[root.input.clientRequestId, reply.input.clientRequestId]],
          )
        ).rows.map((row) => row.id);
        assert.equal(eventIds.length, 2);
        const config = {
          ...f.app.get<RuntimeConfig>(APP_CONFIG),
          RATINGS_UPDATES_PROCESSING: 'manual' as const,
        };
        const worker = new RatingSubscriptionUpdatesWorker(
          f.app.get(DatabaseService),
          config,
          f.app.get(RatingsSubscriptionUpdatesSourceFacade),
          f.app.get(RatingSubscriptionUpdatesProjectionFacade),
          f.app.get(RatingSubscriptionUpdatesRepository),
        );
        const result = await worker.run({ mode: 'apply', eventIds });
        assert.equal(result.failed, 0, JSON.stringify(result));
        assert.equal(result.processed, 2, JSON.stringify(result));
        assert.equal(result.materialized, 4, JSON.stringify(result));
        const repeat = await worker.run({ mode: 'apply', eventIds });
        assert.equal(repeat.materialized, 0, JSON.stringify(repeat));
        const direct = new RatingUpdatesWorker(
          f.app.get(DatabaseService),
          config,
          f.app.get(RatingsUpdatesSourceFacade),
          f.app.get(RatingUpdatesProjectionFacade),
          f.app.get(RatingUpdatesRepository),
        );
        const directResult = await direct.run({ mode: 'apply', eventIds });
        assert.equal(directResult.failed, 0, JSON.stringify(directResult));
        assert.equal(
          directResult.materialized,
          1,
          JSON.stringify(directResult),
        );
        await a.updates.selectCategory('subscription');
        assert.equal(a.updatesView().loaded, true, a.updatesView().error);
        assert.equal(a.updatesView().unreadCount, 2);
        assert.equal(a.updatesView().items.length, 2);
        for (const activity of ['root', 'reply'] as const) {
          const notice = a
            .updatesView()
            .items.find((item) => item.activity === activity)!;
          assert.ok(notice);
          assert.equal(notice.kind, 'subscription');
          assert.equal(notice.target?.rootId, root.id);
          assert.equal(
            notice.target?.replyId,
            activity === 'root' ? null : reply.id,
          );
          const start = a.transport.sent.length;
          await a.updates.open(notice.noticeId);
          const path = a.navigation.at(-1)!;
          assert.match(
            path,
            new RegExp(`subscriptionNoticeId=${notice.noticeId}`),
          );
          assert.doesNotMatch(path, /[?&](?:noticeId|likeNoticeId)=/);
          assert.equal(
            a.transport.sent.slice(start).some((sent) => sent.method === 'PUT'),
            false,
          );
          a.transport.beforeSend = (sent) => {
            if (sent.path.endsWith(`/${notice.noticeId}/read`))
              assert.equal(a.threadView().loaded, true);
          };
          await a.thread.load(
            Object.fromEntries(
              new URL(path, directoryNativeOrigin).searchParams,
            ),
          );
          assert.equal(a.threadView().loaded, true, a.threadView().error);
          assert.equal(
            a.threadView().anchorReplyId,
            activity === 'root' ? '' : reply.id,
          );
          const reads = a.transport.sent
            .slice(start)
            .filter((sent) => sent.method === 'PUT');
          assert.deepEqual(reads, [
            {
              path: `/v1/me/ratings/subscription-updates/${notice.noticeId}/read`,
              method: 'PUT',
              bodyBytes: '{}',
            },
          ]);
          a.transport.beforeSend = null;
        }
        assert.deepEqual(
          await a.runtime.ratingSubscriptionUpdates.unread(a.cancel),
          { unreadCount: 0 },
        );
        await r.updates.load();
        assert.equal(r.updatesView().category, 'reply');
        assert.equal(r.updatesView().unreadCount, 1);
        const directId = r.updatesView().items[0]!.noticeId;
        await r.updates.selectCategory('subscription');
        assert.equal(r.updatesView().unreadCount, 1);
        const subscriptionId = r.updatesView().items[0]!.noticeId;
        assert.notEqual(subscriptionId, directId);
        // Later unsubscribe preserves the existing notification and its distinct read life.
        assert.equal((await desired(r, false)).receipt.outcome, 'applied');
        await r.updates.open(subscriptionId);
        await r.thread.load(
          Object.fromEntries(
            new URL(r.navigation.at(-1)!, directoryNativeOrigin).searchParams,
          ),
        );
        assert.equal(r.threadView().loaded, true, r.threadView().error);
        assert.deepEqual(
          await r.runtime.ratingSubscriptionUpdates.unread(r.cancel),
          { unreadCount: 0 },
        );
        assert.deepEqual(await r.runtime.ratingUpdates.unread(r.cancel), {
          unreadCount: 1,
        });
        const read = await r.runtime.ratingSubscriptionUpdates.markRead(
          subscriptionId,
          r.cancel,
        );
        assert.deepEqual(
          await r.runtime.ratingSubscriptionUpdates.markRead(
            subscriptionId,
            r.cancel,
          ),
          read,
        );
        await assert.rejects(
          r.runtime.ratingUpdates.target(subscriptionId, r.cancel),
        );
        await assert.rejects(
          r.runtime.ratingSubscriptionUpdates.target(directId, r.cancel),
        );
        const lateRoot = await f.publish(owner, catalog, target);
        const lateEvent = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_ratings.effect_events WHERE request_id=$1',
            [lateRoot.input.clientRequestId],
          )
        ).rows[0]!.id;
        const lateResult = await worker.run({
          mode: 'apply',
          eventIds: [lateEvent],
        });
        assert.equal(lateResult.failed, 0, JSON.stringify(lateResult));
        assert.equal(lateResult.materialized, 2, JSON.stringify(lateResult));
        await f.deleteRoot(owner, catalog, target, lateRoot);
        await a.updates.load();
        assert.equal(a.updatesView().unreadCount, 1);
        const unavailable = a
          .updatesView()
          .items.find(
            (item) => item.status === 'unavailable' && item.readAt === null,
          )!;
        assert.ok(unavailable);
        assert.deepEqual(Object.keys(unavailable).sort(), [
          'createdAt',
          'noticeId',
          'readAt',
          'status',
        ]);
        const sent = a.transport.sent.length;
        await a.updates.open(unavailable.noticeId);
        assert.equal(
          a.transport.sent.length,
          sent,
          'Unavailable list entries cannot navigate or automatically read',
        );
        await a.updates.acknowledge(unavailable.noticeId);
        assert.equal(a.updatesView().unreadCount, 0);
      },
    );
    if (process.env['RATINGS_R2C_GOLDEN_OUTPUT'])
      await writeFile(
        process.env['RATINGS_R2C_GOLDEN_OUTPUT'],
        `${JSON.stringify({ provenance: 'Actual local AppModule HTTP/PostgreSQL with synthetic isolated identity/catalog/review fixtures; no production/provider/device claim.', ...golden }, null, 2)}\n`,
      );
  },
);
