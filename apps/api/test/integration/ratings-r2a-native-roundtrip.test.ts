import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import { platformStorage } from '../support/experience-native-bridge.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';

import type { RatingReply } from '../../src/ratings/discussion-contracts.js';
import type { RatingNotice } from '../../src/notifications/ratings/contracts.js';
interface RatingView {
  loaded: boolean;
  frozen: boolean;
  detail: unknown;
  comments: readonly unknown[];
  error: string;
}
interface RatingThreadView {
  loaded: boolean;
  frozen: boolean;
  discussion: unknown;
  replies: readonly RatingReply[];
  anchorReplyId: string;
  error: string;
}
interface RatingUpdatesView {
  unreadCount: number | null;
  items: readonly RatingNotice[];
}

// The ordinary AppModule, PostgreSQL owners, review provenance and workers are
// used without business facade replacements. Only device HTTP/storage/UUID I/O
// are bridged. All accounts, baseline facts and exact approvals are synthetic.
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
  HttpExperienceGateway,
} = require('../../../wechat/src/experience/gateway.ts');

test(
  'R2A actual native controllers through AppModule HTTP/PG recover journals, settle real experience and safely open local notices',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const R = await f.actor(),
      P = await f.actor(),
      A = await f.actor(),
      catalog = await f.catalog(R),
      target = catalog.targets[0]!;
    type Actor = typeof R;
    const native = (actor: Actor) => {
      const transport = new DirectoryHttpTransport(f.port),
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
      const ratingViews: RatingView[] = [],
        threadViews: RatingThreadView[] = [],
        updateViews: RatingUpdatesView[] = [],
        navigation: string[] = [];
      const rating = new RatingController(
        runtime,
        'detail',
        (view: RatingView) => ratingViews.push(view),
      );
      const thread = new RatingThreadController(
        runtime,
        (view: RatingThreadView) => threadViews.push(view),
      );
      const updates = new RatingUpdatesController(
        runtime,
        (view: RatingUpdatesView) => updateViews.push(view),
        async (path: string) => {
          navigation.push(path);
        },
      );
      t.after(() => {
        rating.dispose();
        thread.dispose();
        updates.dispose();
      });
      return {
        transport,
        sessions,
        device,
        api,
        runtime,
        rating,
        thread,
        updates,
        navigation,
        cancel: new Cancellation(),
        experience: new HttpExperienceGateway(api),
        ratingView: () => ratingViews.at(-1)!,
        threadView: () => threadViews.at(-1)!,
        updatesView: () => updateViews.at(-1)!,
      };
    };
    const r = native(R),
      p = native(P),
      a = native(A);
    const noIdentityLeak = (value: unknown) => {
      const json = JSON.stringify(value);
      for (const secret of [
        R.accountId,
        P.accountId,
        A.accountId,
        R.accessToken,
        P.accessToken,
        A.accessToken,
      ])
        assert.equal(json.includes(secret), false);
      assert.doesNotMatch(
        json,
        /"(?:accountId|recipient|recipientAccountId|original_user_id|from_user_id|envelope|approval|digest)"/,
      );
    };
    const unitsFor = async (requestId: string) =>
      (
        await f.pool.query<{
          id: string;
          beneficiary_id: string;
          action: string;
          event_id: string;
        }>(
          `SELECT u.id,u.beneficiary_id,u.action,g.event_id FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id JOIN whaleu_ratings.effect_events e ON e.id=g.event_id WHERE e.request_id=$1 ORDER BY u.enrollment_order,u.id`,
          [requestId],
        )
      ).rows;
    const worker = f.app.get(ExperienceWorker);
    const settlePending = async () => {
      const rows = (
        await f.pool.query<{ unit_id: string }>(
          "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=ANY($1::uuid[]) AND state<>'completed' ORDER BY enrollment_order,unit_id",
          [[R.accountId, P.accountId, A.accountId]],
        )
      ).rows;
      assert.ok(rows.length > 0);
      const result = await worker.run({
        mode: 'apply',
        unitIds: rows.map((row) => row.unit_id),
      });
      assert.equal(result.settled, rows.length, JSON.stringify(result));
      assert.equal(result.failed, 0);
      assert.equal(result.sourceUnavailable, 0);
    };
    const config = f.app.get<RuntimeConfig>(APP_CONFIG);
    const noticeWorker = new RatingUpdatesWorker(
      f.app.get(DatabaseService),
      { ...config, RATINGS_UPDATES_PROCESSING: 'manual' },
      f.app.get(RatingsUpdatesSourceFacade),
      f.app.get(RatingUpdatesProjectionFacade),
      f.app.get(RatingUpdatesRepository),
    );
    let root: { id: string; revision: string },
      prior: { id: string; revision: string },
      nested: { id: string; revision: string },
      nestedEvent = '';

    await t.test(
      'legacy v1-format bytes recover through old receipt route, then a new v2 root freezes and recovers lost response',
      async () => {
        // This is a legacy client envelope against the current disposable schema.
        // It proves journal/wire compatibility, not a pre-migration R1 source replay.
        const legacyBody = f.body(catalog, target, {
          authorMode: 'anonymous',
          body: 'Legacy immutable native root',
        });
        await approveRating(f.pool, f.envelope(R, catalog, target, legacyBody));
        const legacyIntent = {
          operation: 'create_comment',
          targetId: target.id,
          payload: legacyBody,
        };
        const legacy = r.runtime.pendingRatings.freeze({
          version: 1,
          accountId: R.accountId,
          intent: legacyIntent,
        });
        const key = `whaleu.ratings.pending.v1:${directoryNativeOrigin}:${R.accountId}`,
          bytes = JSON.stringify(r.device.storage.get(key));
        r.transport.dropSuccess = {
          path: `/v1/ratings/targets/${target.id}/comments`,
          method: 'POST',
        };
        await assert.rejects(r.runtime.ratings.command(legacyIntent, r.cancel));
        assert.equal(JSON.stringify(r.device.storage.get(key)), bytes);
        const recoveryViews: RatingView[] = [];
        const recovery = new RatingController(
          r.runtime,
          'recovery',
          (view: RatingView) => recoveryViews.push(view),
        );
        const before = r.transport.exchanges.length;
        await recovery.load({});
        assert.equal(r.runtime.pendingRatings.load(R.accountId), null);
        assert.equal(recoveryViews.at(-1)?.loaded, true);
        assert.equal(recoveryViews.at(-1)?.comments.length, 0);
        assert.doesNotMatch(
          JSON.stringify(recoveryViews),
          /Legacy immutable native root/,
        );
        assert.ok(
          r.transport.exchanges
            .slice(before)
            .every(
              (exchange) =>
                exchange.path ===
                `/v1/ratings/requests/${legacy.intent.payload.clientRequestId}`,
            ),
        );
        recovery.dispose();
        const body = f.body(catalog, target, {
          authorMode: 'anonymous',
          body: 'Current R2A native root',
        });
        await approveRating(f.pool, f.envelope(R, catalog, target, body));
        r.runtime.newRequestId = async () => body.clientRequestId;
        await r.rating.load({ targetId: target.id });
        r.rating.openComposer();
        r.rating.setText(body.body);
        r.rating.setAuthorMode(body.authorMode);
        r.transport.dropSuccess = {
          path: `/v1/ratings/targets/${target.id}/comments`,
          method: 'POST',
        };
        await r.rating.publish();
        assert.equal(r.ratingView().frozen, true);
        assert.equal(r.ratingView().detail, null);
        assert.equal(r.runtime.pendingRatings.load(R.accountId).version, 2);
        const created = await r.runtime.ratings.receipt(
          body.clientRequestId,
          r.cancel,
        );
        await r.rating.recover();
        assert.equal(r.ratingView().loaded, true, r.ratingView().error);
        assert.equal(r.runtime.pendingRatings.load(R.accountId), null);
        root = { id: created.subjectId, revision: created.revision };
        const fresh = await r.runtime.ratings.comment(null, root.id, r.cancel);
        assert.equal(fresh.body, body.body);
        assert.equal(fresh.author.mode, 'anonymous');
        noIdentityLeak(fresh);
        const legacyCurrent = await r.runtime.ratings.receipt(
          legacyBody.clientRequestId,
          r.cancel,
        );
        const old = await r.runtime.ratings.comment(
          null,
          legacyCurrent.subjectId,
          r.cancel,
        );
        assert.equal(
          old.author.personaId,
          fresh.author.personaId,
          'Same target reuses the safe persona',
        );
        // Score remains independent and survives all later root/reply changes.
        const scored = await r.runtime.ratings.command(
          {
            operation: 'set_score',
            targetId: target.id,
            payload: {
              clientRequestId: randomUUID(),
              regionId: null,
              expectedTargetRevision: target.revision,
              expectedRevision: null,
              score: 4,
            },
          },
          r.cancel,
        );
        assert.equal(scored.outcome, 'applied');
      },
    );

    await t.test(
      'root and arbitrary reply publications pass the actual strict gateway, immutable lost-result recovery and safe position',
      async () => {
        const input = f.replyBody(catalog, target, root, {
          authorMode: 'anonymous',
          body: 'Native direct reply',
        });
        await approveRating(
          f.pool,
          f.replyEnvelope(P, catalog, target, root, input),
        );
        p.runtime.newRequestId = async () => input.clientRequestId;
        await p.thread.load({ targetId: target.id, rootId: root.id });
        assert.equal(p.threadView().loaded, true, p.threadView().error);
        p.thread.compose();
        p.thread.setText(input.body);
        p.thread.setAuthorMode(input.authorMode);
        p.transport.dropSuccess = {
          path: `/v1/ratings/comments/${root.id}/replies`,
          method: 'POST',
        };
        await p.thread.publish();
        assert.equal(p.threadView().frozen, true);
        assert.deepEqual(p.threadView().replies, []);
        const original = p.runtime.pendingRatings.load(P.accountId);
        assert.equal(original.version, 2);
        assert.deepEqual(original.intent.payload, input);
        const applied = await p.runtime.ratingDiscussion.receipt(
          input.clientRequestId,
          p.cancel,
        );
        await p.thread.recover();
        assert.equal(p.threadView().loaded, true, p.threadView().error);
        assert.equal(p.threadView().anchorReplyId, applied.replyId);
        prior = { id: applied.replyId, revision: applied.revision };
        noIdentityLeak(p.threadView().replies);
        await settlePending();
        const input2 = f.replyBody(catalog, target, root, {
          authorMode: 'anonymous',
          body: 'Native nested reply 😀',
          replyTo: { replyId: prior.id, expectedRevision: prior.revision },
        });
        await approveRating(
          f.pool,
          f.replyEnvelope(A, catalog, target, root, input2),
        );
        a.runtime.newRequestId = async () => input2.clientRequestId;
        await a.thread.load({ targetId: target.id, rootId: root.id });
        a.thread.compose(prior.id);
        a.thread.setText(` \r\n${input2.body}\r\n `);
        a.thread.setAuthorMode(input2.authorMode);
        await a.thread.publish();
        assert.equal(a.threadView().frozen, false, a.threadView().error);
        assert.equal(a.threadView().loaded, true, a.threadView().error);
        const applied2 = await a.runtime.ratingDiscussion.receipt(
          input2.clientRequestId,
          a.cancel,
        );
        nested = { id: applied2.replyId, revision: applied2.revision };
        assert.deepEqual(
          (await a.runtime.ratingDiscussion.reply(null, nested.id, a.cancel))
            .replyTo.replyId,
          prior.id,
        );
        const page = await a.runtime.ratingDiscussion.position(
          null,
          nested.id,
          a.cancel,
          1,
        );
        assert.equal(page.page.items[0].id, nested.id);
        assert.equal(page.page.items.length, 1);
        noIdentityLeak(page);
        const source = await unitsFor(input2.clientRequestId);
        assert.equal(source.length, 2);
        nestedEvent = source[0]!.event_id;
        assert.deepEqual(
          source.map((unit) => `${unit.beneficiary_id}:${unit.action}`).sort(),
          [`${A.accountId}:comment`, `${P.accountId}:received_comment`].sort(),
        );
      },
    );

    await t.test(
      'real ledger and direct notice materialization are visible through strict native reads, without receipt inference',
      async () => {
        const beforeR = (await r.experience.summary(r.cancel)).balance,
          beforeP = (await p.experience.summary(p.cancel)).balance,
          beforeA = (await a.experience.summary(a.cancel)).balance;
        const pending = await f.snapshot();
        const unitIds = (
          await f.pool.query<{ id: string }>(
            'SELECT u.id FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id WHERE g.event_id=$1',
            [nestedEvent],
          )
        ).rows.map((row) => row.id);
        assert.equal((await worker.run({ unitIds })).pending, 2);
        assert.deepEqual(await f.snapshot(), pending);
        const settled = await worker.run({ mode: 'apply', unitIds });
        assert.equal(settled.settled, 2, JSON.stringify(settled));
        assert.equal(settled.failed, 0);
        assert.equal(
          (await worker.run({ mode: 'apply', unitIds })).completed,
          2,
        );
        assert.equal(
          BigInt((await a.experience.summary(a.cancel)).balance) -
            BigInt(beforeA),
          3n,
        );
        assert.equal(
          BigInt((await p.experience.summary(p.cancel)).balance) -
            BigInt(beforeP),
          3n,
        );
        assert.equal((await r.experience.summary(r.cancel)).balance, beforeR);
        const ledger = (
          await f.pool.query<{
            domain: string;
            state: string;
            delta: string;
            time_equal: boolean;
          }>(
            `SELECT su.source_domain AS domain,w.state,s.applied_delta::text AS delta,r.occurred_at=g.occurred_at AS time_equal FROM whaleu_ratings.reward_units u JOIN whaleu_ratings.reward_groups g ON g.id=u.group_id JOIN whaleu_experience.source_units su ON su.unit_id=u.id JOIN whaleu_experience.work w ON w.unit_id=u.id JOIN whaleu_experience.settlements s ON s.unit_id=u.id JOIN whaleu_experience.records r ON r.settlement_id=s.id WHERE g.event_id=$1`,
            [nestedEvent],
          )
        ).rows;
        assert.equal(ledger.length, 2);
        assert.ok(
          ledger.every(
            (row) =>
              row.domain === 'ratings' &&
              row.state === 'completed' &&
              row.delta === '3' &&
              row.time_equal,
          ),
        );
        assert.equal(
          (await a.experience.records(null, a.cancel)).items[0].action,
          'comment',
        );
        assert.equal(
          (await p.runtime.ratingUpdates.unread(p.cancel)).unreadCount,
          0,
        );
        const before = await f.snapshot();
        assert.equal(
          (await noticeWorker.run({ eventIds: [nestedEvent] })).materialized,
          2,
        );
        assert.deepEqual(await f.snapshot(), before);
        const applied = await noticeWorker.run({
          mode: 'apply',
          eventIds: [nestedEvent],
        });
        assert.equal(applied.materialized, 2, JSON.stringify(applied));
        assert.equal(applied.failed, 0);
        assert.equal(
          (await noticeWorker.run({ mode: 'apply', eventIds: [nestedEvent] }))
            .alreadyProcessed,
          1,
        );
        await p.updates.load();
        await r.updates.load();
        assert.equal(p.updatesView().unreadCount, 1);
        assert.equal(r.updatesView().unreadCount, 1);
        assert.equal(p.updatesView().items[0]?.status, 'available');
        const direct = p.updatesView().items[0]!;
        assert.equal(direct.status, 'available');
        if (direct.status !== 'available')
          throw new Error('Expected current notice');
        assert.equal(direct.reason, 'direct_reply');
        assert.equal(direct.preview.author.mode, 'anonymous');
        assert.equal(direct.target.replyId, nested.id);
        noIdentityLeak(p.updatesView().items);
        await p.updates.open(direct.noticeId);
        assert.equal(
          (await p.runtime.ratingUpdates.unread(p.cancel)).unreadCount,
          1,
          'List navigation success is not read',
        );
        const parsed = Object.fromEntries(
          new URL(p.navigation[0]!, directoryNativeOrigin).searchParams,
        );
        await p.thread.load(parsed);
        assert.equal(p.threadView().loaded, true, p.threadView().error);
        assert.equal(p.threadView().replies[0]?.id, nested.id);
        assert.equal(
          (await p.runtime.ratingUpdates.unread(p.cancel)).unreadCount,
          0,
        );
        const marked = (await p.runtime.ratingUpdates.list(null, p.cancel))
          .items[0];
        assert.ok(marked.readAt);
        assert.equal(
          (await p.runtime.ratingUpdates.markRead(direct.noticeId, p.cancel))
            .readAt,
          marked.readAt,
        );
        await assert.rejects(
          a.runtime.ratingUpdates.target(direct.noticeId, a.cancel),
        );
        await assert.rejects(
          a.runtime.ratingUpdates.markRead(direct.noticeId, a.cancel),
        );
      },
    );

    await t.test(
      'real delayed position after same-account login cannot mark a notice or reintroduce old body',
      async () => {
        const update = r.updatesView().items[0]!;
        assert.equal(update.status, 'available');
        if (update.status !== 'available') throw new Error('Expected notice');
        const gate = r.transport.holdNext(
          `/v1/ratings/replies/${nested.id}/position`,
        );
        const loading = r.thread.load({
          targetId: target.id,
          rootId: root.id,
          replyId: nested.id,
          noticeId: update.noticeId,
        });
        await gate.arrived;
        r.sessions.completeLogin(r.sessions.beginLogin(), R);
        gate.release();
        await loading;
        assert.equal(r.threadView().loaded, false);
        assert.deepEqual(r.threadView().replies, []);
        assert.equal(r.threadView().discussion, null);
        assert.equal(
          (await r.runtime.ratingUpdates.unread(r.cancel)).unreadCount,
          1,
        );
      },
    );

    await t.test(
      'single reply deletion keeps later safe quote, and root deletion still permits historical recovery without body replay',
      async () => {
        p.runtime.newRequestId = async () => randomUUID();
        await p.thread.load({ targetId: target.id, rootId: root.id });
        p.thread.confirmDelete(prior.id);
        await p.thread.deleteReply();
        assert.equal(p.threadView().loaded, true, p.threadView().error);
        assert.equal(
          p.threadView().replies.some((row) => row.id === prior.id),
          false,
        );
        const retained = p
          .threadView()
          .replies.find((row) => row.id === nested.id);
        assert.ok(retained);
        assert.deepEqual(retained.replyTo, {
          kind: 'reply',
          status: 'unavailable',
        });
        noIdentityLeak(retained);
        const input = f.replyBody(catalog, target, root, {
          authorMode: 'anonymous',
          body: 'Committed but lost before root deletion',
          replyTo: { replyId: nested.id, expectedRevision: nested.revision },
        });
        await approveRating(
          f.pool,
          f.replyEnvelope(A, catalog, target, root, input),
        );
        a.runtime.newRequestId = async () => input.clientRequestId;
        await a.thread.load({ targetId: target.id, rootId: root.id });
        a.thread.compose(nested.id);
        a.thread.setText(input.body);
        a.thread.setAuthorMode(input.authorMode);
        a.transport.dropSuccess = {
          path: `/v1/ratings/comments/${root.id}/replies`,
          method: 'POST',
        };
        await a.thread.publish();
        assert.equal(a.threadView().frozen, true);
        assert.ok(a.runtime.pendingRatings.load(A.accountId));
        await r.rating.load({ targetId: target.id });
        r.runtime.newRequestId = async () => randomUUID();
        r.rating.confirmDelete(root.id);
        await r.rating.deleteComment();
        assert.equal(r.ratingView().frozen, false, r.ratingView().error);
        assert.equal(
          (await r.runtime.ratings.myScore(null, target.id, r.cancel)).myScore
            .score,
          4,
        );
        const recoveryViews: RatingView[] = [];
        const recovery = new RatingController(
          a.runtime,
          'recovery',
          (view: RatingView) => recoveryViews.push(view),
        );
        await recovery.load({});
        assert.equal(a.runtime.pendingRatings.load(A.accountId), null);
        assert.equal(recoveryViews.at(-1)?.loaded, true);
        assert.doesNotMatch(
          JSON.stringify(recoveryViews),
          /Committed but lost before root deletion/,
        );
        recovery.dispose();
        await a.thread.reload();
        assert.equal(a.threadView().loaded, false);
        assert.deepEqual(a.threadView().replies, []);
        assert.equal(a.threadView().discussion, null);
        await r.updates.load();
        assert.equal(r.updatesView().unreadCount, 1);
        const unavailable = r.updatesView().items[0]!;
        assert.equal(unavailable.status, 'unavailable');
        assert.deepEqual(Object.keys(unavailable).sort(), [
          'createdAt',
          'noticeId',
          'readAt',
          'status',
        ]);
        await r.updates.acknowledge(unavailable.noticeId);
        assert.equal(r.updatesView().unreadCount, 0);
        assert.ok(r.updatesView().items[0]?.readAt);
        await p.updates.load();
        assert.equal(p.updatesView().items[0]?.status, 'unavailable');
        assert.equal(
          p.updatesView().unreadCount,
          0,
          'Already read remains read after lifecycle suppression',
        );
      },
    );
  },
);
