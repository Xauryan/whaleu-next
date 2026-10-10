import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import {
  ratingScopedCommandFixture,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';
import {
  DirectoryHttpTransport,
  directoryNativeOrigin,
} from '../support/directory-http-transport.js';
import { platformStorage } from '../support/experience-native-bridge.js';
import {
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../src/ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../src/ratings/updates-source/subscription-projection.js';
import { RatingSubscriptionUpdatesRepository } from '../../src/notifications/ratings/subscription-repository.js';
import { RatingSubscriptionUpdatesWorker } from '../../src/notifications/ratings/subscription-worker.js';
import {
  ratingScopedContextSchema,
  type RatingScopedContext,
  type RatingScopedIntent,
  type RatingNavigationSelector,
} from '../../src/ratings/scoped/contracts.js';
import {
  ratingScopedNoticePageSchema,
  ratingScopedNoticeTargetSchema,
  ratingScopedResolvedLocatorSchema,
  type RatingScopedNoticeKind,
} from '../../src/ratings/scoped/notice.service.js';

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
  ratingScopedLocatorPath,
} = require('../../../wechat/src/ratings/scoped-controller.ts');

interface NoticeView {
  loaded: boolean;
  needsRefresh: boolean;
  error: string;
  detail: { id: string } | null;
  discussion: { root: { id: string } } | null;
  replies: Array<{ id: string }>;
  notices: Array<{
    noticeId: string;
    createdAt: string;
    readAt: string | null;
    status: string;
  }>;
  unreadCount: number | null;
  identityCampusId: string | null;
  viewCampusId: string | null;
}
class NoticeTransport extends DirectoryHttpTransport {
  readonly sent: Array<{ path: string; method: string }> = [];
  readonly contexts: RatingScopedContext[] = [];
  readonly failures: Array<{ path: string; status: number; code: unknown }> =
    [];
  private readonly pending = new Set<Promise<unknown>>();
  override async send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    const path = new URL(input.url).pathname;
    this.sent.push({ path, method: input.method });
    const work = super.send(input);
    this.pending.add(work);
    try {
      const response = await work;
      if (response.status !== 200)
        this.failures.push({
          path,
          status: response.status,
          code: (response.body as { error?: { code?: unknown } })?.error?.code,
        });
      if (response.status === 200 && /^\/v[12]\/(me\/)?ratings/.test(path)) {
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['vary'], 'Authorization');
      }
      if (response.status === 200 && path === '/v2/ratings/contexts')
        this.contexts.push(ratingScopedContextSchema.parse(response.body));
      return response;
    } finally {
      this.pending.delete(work);
    }
  }
  async drained() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

// All notices originate in real scoped commands and the existing materializers.
// Native tests replace only platform HTTP/storage, never owners or wire payloads.
test(
  'M3B G6 scoped notices retain original fanout/read history and resolve explicit native locators',
  { timeout: 600000 },
  async (t) => {
    const f = await ratingScopedCommandFixture();
    t.after(() => f.close());
    const owner = f.creator,
      author = await f.actor(),
      responder = await f.actor(),
      subscriber = await f.actor(),
      outsider = await f.actor();
    type Actor = typeof owner;
    const target = await f.createScopedTarget(owner, 'Scoped notice target');
    const recorded: Array<{
      actor: Actor;
      input: RatingScopedIntent;
      receipt: unknown;
    }> = [];
    const run = async (
      actor: Actor,
      operation: RatingScopedIntent['operation'],
      payload: Record<string, unknown>,
    ) => {
      const input = await f.commandIntent(actor, operation, {
        targetId: target.id,
        expectedTargetRevision: target.revision,
        ...payload,
      });
      const done = await f.executeCommand(actor, input);
      recorded.push({ actor, input, receipt: done.receipt });
      return { ...done, receipt: scopedSuccess(done.receipt) };
    };
    const baseline = await f.scopedRead(
      subscriber,
      `/v2/ratings/targets/${target.id}/subscription`,
    );
    await run(subscriber, 'set_target_subscription_scoped', {
      expectedSubscriptionRevision: baseline.revision,
      subscribed: true,
    });
    const comment = await run(author, 'create_comment_scoped', {
      authorMode: 'anonymous',
      body: 'Private scoped notice root',
      assetIds: [],
    });
    assert.ok(comment.approved);
    const root = {
      id: String(comment.receipt.result['subjectId']),
      revision: String(comment.receipt.result['revision']),
    };
    const reply = await run(responder, 'create_reply_scoped', {
      rootId: root.id,
      expectedRootRevision: root.revision,
      replyTo: null,
      authorMode: 'named',
      body: 'Scoped notice reply',
      assetIds: [],
    });
    const like = await f.scopedRead(
      responder,
      `/v2/ratings/comments/${root.id}/like`,
    );
    const liked = await run(responder, 'set_comment_like_scoped', {
      rootId: root.id,
      expectedRevision: root.revision,
      expectedLikeRevision: like.revision,
      liked: true,
    });
    const event = async (actor: Actor, input: RatingScopedIntent) => {
      const rows = (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows;
      assert.equal(rows.length, 1, 'One captured effect per applied command');
      return rows[0]!.id;
    };
    const rootEvent = await event(author, comment.input),
      replyEvent = await event(responder, reply.input),
      likeEvent = await event(responder, liked.input);
    const config = {
      ...f.app.get<RuntimeConfig>(APP_CONFIG),
      RATINGS_UPDATES_PROCESSING: 'manual' as const,
    };
    const directWorker = new RatingUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsUpdatesSourceFacade),
      f.app.get(RatingUpdatesProjectionFacade),
      f.app.get(RatingUpdatesRepository),
    );
    const subscriptionWorker = new RatingSubscriptionUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsSubscriptionUpdatesSourceFacade),
      f.app.get(RatingSubscriptionUpdatesProjectionFacade),
      f.app.get(RatingSubscriptionUpdatesRepository),
    );
    const direct = await directWorker.run({
      mode: 'apply',
      eventIds: [replyEvent, likeEvent],
    });
    assert.equal(direct.failed, 0, JSON.stringify(direct));
    assert.equal(direct.materialized, 2, JSON.stringify(direct));
    const subscriptions = await subscriptionWorker.run({
      mode: 'apply',
      eventIds: [rootEvent, replyEvent],
    });
    assert.equal(subscriptions.failed, 0, JSON.stringify(subscriptions));
    assert.equal(subscriptions.materialized, 2, JSON.stringify(subscriptions));
    const noticeRows = async () =>
      (
        await f.pool.query<{
          notice_id: string;
          kind: RatingScopedNoticeKind;
          recipient: string;
          target_id: string;
          root_id: string;
          reply_id: string | null;
          read_at: string | null;
          event_id: string;
          ordinal: string;
          created_at: string;
        }>(
          `SELECT id notice_id,CASE kind WHEN 'like' THEN 'like-updates' ELSE 'updates' END kind,
            recipient_account_id recipient,target_id,root_id,reply_id,
            to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') read_at,
            event_id,ordinal::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at
           FROM whaleu_notifications.rating_notices
           UNION ALL
           SELECT id,'subscription-updates',recipient_account_id,target_id,root_id,reply_id,
            to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            event_id,ordinal::text,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
           FROM whaleu_notifications.rating_subscription_notices ORDER BY notice_id`,
        )
      ).rows;
    const originals = await noticeRows();
    assert.equal(originals.length, 4);
    const cases = originals.map((row) => ({
      ...row,
      actor: row.kind === 'subscription-updates' ? subscriber : author,
    }));
    for (const row of cases) {
      assert.equal(row.recipient, row.actor.accountId);
      assert.equal(row.target_id, target.id);
      assert.equal(row.root_id, root.id);
      assert.equal(row.read_at, null);
    }
    const families = (
      ['updates', 'like-updates', 'subscription-updates'] as const
    ).map((kind) => cases.find((row) => row.kind === kind)!);
    const get = (
      actor: Actor,
      kind: RatingScopedNoticeKind,
      suffix = '',
      query: Record<string, unknown> = {},
      version = 2,
    ) =>
      f
        .auth(
          request(f.http).get(`/v${version}/me/ratings/${kind}${suffix}`),
          actor,
        )
        .query(query);
    const query = (context: RatingScopedContext) => ({
      contextId: context.id,
      contextToken: context.token,
    });
    const assertMetadata = (body: unknown) => {
      const page = ratingScopedNoticePageSchema.parse(body);
      for (const item of page.items)
        assert.deepEqual(Object.keys(item).sort(), [
          'createdAt',
          'noticeId',
          'readAt',
          'status',
        ]);
      assert.doesNotMatch(
        JSON.stringify(page),
        /Private scoped notice root|Scoped notice reply|Scoped notice target|accountId|author|preview|targetId|rootId|replyId|selector|protocolGeneration/,
      );
      return page;
    };
    function native(actor: Actor) {
      const transport = new NoticeTransport(f.port),
        sessions = new SessionStore();
      sessions.completeLogin(sessions.beginLogin(), actor);
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(directoryNativeOrigin, transport, systemClock),
        {
          login: async () => {
            throw new Error('No external provider in fixture');
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
        platformStorage(),
        directoryNativeOrigin,
      );
      const views: NoticeView[] = [];
      const controller = new RatingScopedController(
        runtime,
        (view: NoticeView) => views.push(view),
      );
      t.after(() => controller.dispose());
      return {
        transport,
        sessions,
        runtime,
        controller,
        gateway: runtime.ratingScoped,
        cancellation: new Cancellation(),
        view: () => views.at(-1)!,
      };
    }
    const loadNotices = async (
      client: ReturnType<typeof native>,
      kind: RatingScopedNoticeKind,
      selector: RatingNavigationSelector = { kind: 'global' },
    ) => {
      await client.controller.load({
        mode: 'updates',
        scope: selector.kind,
        ...(selector.kind === 'campus' ? { campusId: selector.campusId } : {}),
      });
      if (kind !== 'updates') await client.controller.selectNoticeKind(kind);
      assert.equal(client.view().loaded, true, client.view().error);
    };
    const route = (path: string) =>
      Object.fromEntries(new URL(path, directoryNativeOrigin).searchParams);
    const respectReadBudget = async () => {
      // Real guards remain installed. Let their actual window expire rather
      // than resetting counters or making this large matrix a throttle test.
      const row = (
        await f.pool.query<{ wait: number }>(
          `SELECT coalesce(max(greatest(0,extract(epoch FROM
          greatest(expires_at,coalesce(blocked_until,expires_at))-clock_timestamp())*1000)),0)::double precision wait
         FROM whaleu_runtime.request_throttle_counters WHERE total_hits>=70`,
        )
      ).rows[0]!;
      if (row.wait > 0) await delay(Math.ceil(row.wait) + 25);
    };
    t.beforeEach(respectReadBudget);

    await t.test(
      'all three v2 lists expose only original metadata and never issue an implicit context',
      async () => {
        const before = (
          await f.pool.query(
            'SELECT count(*)::int n FROM whaleu_ratings.scoped_contexts',
          )
        ).rows[0]!.n;
        for (const row of families) {
          const response = await get(row.actor, row.kind);
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.equal(response.headers['vary'], 'Authorization');
          const page = assertMetadata(response.body);
          const expected = cases.filter((item) => item.kind === row.kind);
          assert.deepEqual(
            page.items.map((item) => item.noticeId).sort(),
            expected.map((item) => item.notice_id).sort(),
          );
          assert.equal(page.unreadCount, expected.length);
          assert.equal(page.nextCursor, null);
          const legacy = await get(row.actor, row.kind, '', {}, 1);
          assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
          assert.deepEqual(
            legacy.body.items
              .map((item: { noticeId: string }) => item.noticeId)
              .sort(),
            page.items.map((item) => item.noticeId).sort(),
          );
          assert.ok(
            legacy.body.items.every(
              (item: { readAt: string | null }) => item.readAt === null,
            ),
          );
          const client = native(row.actor);
          await loadNotices(client, row.kind);
          assert.deepEqual(client.view().notices, page.items);
          assert.equal(client.transport.contexts.length, 0);
          assert.ok(
            client.transport.sent.every(
              (sent) =>
                sent.method === 'GET' &&
                sent.path.startsWith('/v2/me/ratings/'),
            ),
          );
          assert.equal(
            (await get(row.actor, row.kind, '/unread-count', {}, 1)).body
              .unreadCount,
            page.unreadCount,
          );
        }
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.scoped_contexts',
            )
          ).rows[0]!.n,
          before,
        );
        assert.deepEqual(await noticeRows(), originals);
      },
    );

    await t.test(
      'metadata pagination binds owner, session, kind and limit without revealing a locator',
      async () => {
        const firstResponse = await get(
          subscriber,
          'subscription-updates',
          '',
          { limit: 1 },
        );
        assert.equal(
          firstResponse.status,
          200,
          JSON.stringify(firstResponse.body),
        );
        const first = assertMetadata(firstResponse.body);
        assert.ok(first.nextCursor);
        const next = await get(subscriber, 'subscription-updates', '', {
          limit: 1,
          cursor: first.nextCursor,
        });
        assert.equal(next.status, 200, JSON.stringify(next.body));
        const second = assertMetadata(next.body);
        assert.equal(second.nextCursor, null);
        assert.equal(
          new Set(
            [...first.items, ...second.items].map((item) => item.noticeId),
          ).size,
          2,
        );
        for (const response of [
          await get(outsider, 'subscription-updates', '', {
            limit: 1,
            cursor: first.nextCursor,
          }),
          await get(
            await f.freshSession(subscriber),
            'subscription-updates',
            '',
            { limit: 1, cursor: first.nextCursor },
          ),
          await get(subscriber, 'updates', '', {
            limit: 1,
            cursor: first.nextCursor,
          }),
          await get(subscriber, 'subscription-updates', '', {
            limit: 2,
            cursor: first.nextCursor,
          }),
        ])
          assert.equal(response.status, 409, JSON.stringify(response.body));
      },
    );

    await t.test(
      'all three target routes require an explicit exact read scope; wrong campus, owner and purpose never yield a locator',
      async () => {
        for (const row of families) {
          const context = await f.scopedContext(row.actor);
          const response = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
            query(context),
          );
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.equal(response.headers['vary'], 'Authorization');
          const result = ratingScopedNoticeTargetSchema.parse(response.body);
          assert.equal(result.status, 'available');
          if (result.status !== 'available') assert.fail();
          assert.deepEqual(result.target, {
            selector: { kind: 'global' },
            targetId: target.id,
            rootId: root.id,
            replyId: row.reply_id,
            protocolGeneration: context.protocolGeneration,
          });
          const wrong = await f.scopedContext(row.actor, {
            kind: 'campus',
            campusId: f.campusA,
          });
          const unavailable = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
            query(wrong),
          );
          assert.equal(
            unavailable.status,
            200,
            JSON.stringify(unavailable.body),
          );
          assert.deepEqual(unavailable.body, {
            noticeId: row.notice_id,
            status: 'unavailable',
          });
          const absent = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
          );
          assert.equal(absent.status, 400);
          const foreign = await f.scopedContext(outsider);
          const privateResult = await get(
            outsider,
            row.kind,
            `/${row.notice_id}/target`,
            query(foreign),
          );
          assert.equal(privateResult.status, 404);
          assert.equal(privateResult.body.error.code, 'NOTICE_NOT_FOUND');
          const foreignRead = await f
            .auth(
              request(f.http).put(
                `/v1/me/ratings/${row.kind}/${row.notice_id}/read`,
              ),
              outsider,
            )
            .send({});
          assert.equal(foreignRead.status, 404);
          const reused = await get(
            outsider,
            row.kind,
            `/${row.notice_id}/target`,
            query(context),
          );
          assert.equal(reused.status, 409);
          assert.equal(reused.body.error.code, 'RATING_SCOPED_CONTEXT_CHANGED');
          const interaction = await f.scopedContext(
            row.actor,
            { kind: 'global' },
            'interact',
          );
          const wrongPurpose = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
            query(interaction),
          );
          assert.equal(wrongPurpose.status, 409);
          assert.equal(
            wrongPurpose.body.error.code,
            'RATING_SCOPED_CONTEXT_CHANGED',
          );
          const wrongKind = row.kind === 'updates' ? 'like-updates' : 'updates';
          assert.equal(
            (
              await get(
                row.actor,
                wrongKind,
                `/${row.notice_id}/target`,
                query(context),
              )
            ).status,
            404,
          );
          const missing = await get(
            row.actor,
            row.kind,
            `/${randomUUID()}/target`,
            query(context),
          );
          assert.equal(missing.status, 404);
        }
        assert.deepEqual(
          await noticeRows(),
          originals,
          'Target resolution has no read-state side effect',
        );
      },
    );

    for (const stage of ['target', 'resolve'] as const)
      for (const boundary of [
        'hide',
        'account',
        'same-account-session',
        'scope',
        'back',
        'close',
      ] as const)
        await t.test(
          `held real ${stage} callback after ${boundary} cannot navigate or mark the original notice read`,
          async () => {
            const row = families[0]!,
              client = native(row.actor);
            await loadNotices(client, row.kind);
            const held = client.transport.holdNext(
              stage === 'target'
                ? `/v2/me/ratings/${row.kind}/${row.notice_id}/target`
                : '/v2/ratings/locators/resolve',
              stage === 'target' ? 'GET' : 'POST',
            );
            const work = client.controller.noticePath(row.notice_id);
            try {
              await Promise.race([
                held.arrived,
                work.then(() => {
                  throw new Error(
                    `Notice did not reach held ${stage}: ${client.view().error}`,
                  );
                }),
              ]);
              if (boundary === 'hide') client.runtime.privateViews.clear();
              else if (boundary === 'account')
                client.sessions.completeLogin(
                  client.sessions.beginLogin(),
                  outsider,
                );
              else if (boundary === 'same-account-session')
                client.sessions.completeLogin(
                  client.sessions.beginLogin(),
                  await f.freshSession(row.actor),
                );
              else if (boundary === 'close') client.controller.cancel();
              else
                await client.controller.load(
                  boundary === 'scope'
                    ? { mode: 'updates', scope: 'campus', campusId: f.campusB }
                    : { mode: 'catalog', scope: 'global' },
                );
            } finally {
              held.release();
            }
            assert.equal(await work, null);
            await client.transport.drained();
            assert.equal(
              client.transport.sent.some(
                (sent) => sent.path.endsWith('/read') && sent.method === 'PUT',
              ),
              false,
            );
            if (stage === 'target')
              assert.equal(
                client.transport.sent.some(
                  (sent) => sent.path === '/v2/ratings/locators/resolve',
                ),
                false,
              );
            assert.deepEqual(await noticeRows(), originals);
            assert.equal(client.view().detail, null);
            assert.equal(client.view().discussion, null);
          },
        );

    await t.test(
      'native wrong-selector navigation stays unavailable and does not mark history read',
      async () => {
        for (const row of families) {
          const client = native(row.actor);
          await loadNotices(client, row.kind, {
            kind: 'campus',
            campusId: f.campusA,
          });
          assert.equal(await client.controller.noticePath(row.notice_id), null);
          assert.ok(client.view().error);
          assert.equal(
            client.transport.sent.some(
              (sent) =>
                sent.path.endsWith('/read') ||
                sent.path === '/v2/ratings/locators/resolve',
            ),
            false,
          );
        }
        assert.deepEqual(await noticeRows(), originals);
      },
    );

    await t.test(
      'native locators load actual thread/detail with separate read and interaction leases, then preserve v1 readAt exactly',
      async () => {
        for (const row of cases) {
          await respectReadBudget();
          const client = native(row.actor);
          await loadNotices(client, row.kind);
          const path = await client.controller.noticePath(row.notice_id);
          assert.equal(typeof path, 'string', client.view().error);
          const parsed = route(path);
          assert.equal(parsed['mode'], 'thread');
          assert.equal(parsed['scope'], 'global');
          assert.equal(parsed['targetId'], target.id);
          assert.equal(parsed['rootId'], root.id);
          assert.equal(parsed['replyId'] ?? null, row.reply_id);
          assert.ok(parsed['protocolGeneration']);
          assert.doesNotMatch(path, /contextToken|contextId|regionId|NoticeId/);
          assert.deepEqual(
            client.transport.sent.filter((sent) => sent.method === 'PUT'),
            [
              {
                method: 'PUT',
                path: `/v1/me/ratings/${row.kind}/${row.notice_id}/read`,
              },
            ],
          );
          const beforePage = client.transport.contexts.length;
          await client.controller.load(parsed);
          assert.equal(
            client.view().loaded,
            true,
            JSON.stringify({
              error: client.view().error,
              failures: client.transport.failures,
              safety: (
                await f.pool.query(
                  `SELECT account_id,block_coverage,restriction_coverage,provenance,actions_allowed,valid_until FROM whaleu_safety.account_heads ORDER BY account_id`,
                )
              ).rows,
            }),
          );
          assert.equal(client.view().detail?.id, target.id);
          assert.equal(client.view().discussion?.root.id, root.id);
          if (row.reply_id)
            assert.ok(
              client.view().replies.some((item) => item.id === row.reply_id),
            );
          const pair = client.transport.contexts.slice(beforePage);
          assert.deepEqual(
            pair.map((context) => context.purpose),
            ['read', 'interact'],
          );
          assert.notEqual(pair[0]!.id, pair[1]!.id);
          for (const key of [
            'actorId',
            'sessionGeneration',
            'sourceDigest',
            'protocolGeneration',
            'selector',
            'heads',
            'identityCampusId',
          ] as const)
            assert.deepEqual(pair[0]![key], pair[1]![key], key);
          const stored = (await noticeRows()).find(
            (item) => item.notice_id === row.notice_id,
          )!;
          assert.ok(stored.read_at);
          const read = await f
            .auth(
              request(f.http).put(
                `/v1/me/ratings/${row.kind}/${row.notice_id}/read`,
              ),
              row.actor,
            )
            .send({});
          assert.equal(read.status, 200, JSON.stringify(read.body));
          assert.equal(read.body.readAt, stored.read_at);
          const again = await f
            .auth(
              request(f.http).put(
                `/v1/me/ratings/${row.kind}/${row.notice_id}/read`,
              ),
              row.actor,
            )
            .send({});
          assert.deepEqual(again.body, read.body);
          const list = assertMetadata((await get(row.actor, row.kind)).body);
          assert.equal(
            list.items.find((item) => item.noticeId === row.notice_id)!.readAt,
            stored.read_at,
          );
          const legacy = await get(row.actor, row.kind, '', {}, 1);
          assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
          assert.equal(
            legacy.body.items.find(
              (item: { noticeId: string }) => item.noticeId === row.notice_id,
            ).readAt,
            stored.read_at,
          );
          assert.equal(
            list.unreadCount,
            (await get(row.actor, row.kind, '/unread-count', {}, 1)).body
              .unreadCount,
          );
          const targetLocator = {
            selector: { kind: 'global' },
            targetId: target.id,
            rootId: null,
            replyId: null,
            protocolGeneration: parsed['protocolGeneration'],
          };
          const resolved = await client.gateway.resolve(
            targetLocator,
            'read',
            client.cancellation,
          );
          ratingScopedResolvedLocatorSchema.parse(resolved);
          await client.controller.load(
            route(ratingScopedLocatorPath(resolved.locator)),
          );
          assert.equal(client.view().loaded, true, client.view().error);
          assert.equal(client.view().detail?.id, target.id);
          assert.equal(client.view().discussion, null);
        }
        for (const row of families)
          assert.equal(
            (await get(row.actor, row.kind, '/unread-count', {}, 1)).body
              .unreadCount,
            0,
          );
      },
    );

    await t.test(
      'unknown protocol generation is rejected by real resolution and native route loading without read-state changes',
      async () => {
        const row = families[0]!,
          client = native(row.actor);
        const context = await f.scopedContext(row.actor);
        const targetResponse = await get(
          row.actor,
          row.kind,
          `/${row.notice_id}/target`,
          query(context),
        );
        const locator = {
          ...targetResponse.body.target,
          protocolGeneration: randomUUID(),
        };
        const before = await noticeRows();
        const response = await f
          .auth(request(f.http).post('/v2/ratings/locators/resolve'), row.actor)
          .send({ locator, purpose: 'read', mode: 'public' });
        assert.equal(response.status, 409, JSON.stringify(response.body));
        assert.equal(response.body.error.code, 'RATING_SCOPED_CONTEXT_CHANGED');
        await assert.rejects(
          client.gateway.resolve(locator, 'read', client.cancellation),
        );
        await client.controller.load(route(ratingScopedLocatorPath(locator)));
        assert.equal(client.view().loaded, false);
        assert.equal(client.view().detail, null);
        assert.equal(client.view().discussion, null);
        assert.ok(client.view().error);
        assert.deepEqual(await noticeRows(), before);
      },
    );

    await t.test(
      'Review denial is generic unavailable; unknown Review fails closed while metadata and original read history remain readable',
      async () => {
        const before = await noticeRows();
        await setRatingReviewState(
          f.pool,
          comment.approved!.decisionId,
          'held',
        );
        for (const row of families) {
          const context = await f.scopedContext(row.actor);
          const response = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
            query(context),
          );
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.deepEqual(response.body, {
            noticeId: row.notice_id,
            status: 'unavailable',
          });
          assertMetadata((await get(row.actor, row.kind)).body);
        }
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const eventId = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
           VALUES($1,$2,'allow','missing','accepted','synthetic-scoped-notice-review','synthetic-incomplete-notice-review',clock_timestamp())`,
            [eventId, comment.approved!.decisionId],
          );
          await tx.query(
            'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
            [comment.approved!.decisionId, eventId],
          );
        });
        for (const row of families) {
          const context = await f.scopedContext(row.actor);
          const response = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
            query(context),
          );
          assert.notEqual(response.status, 200);
          assert.equal(response.body.error.code, 'CONTENT_REVIEW_UNAVAILABLE');
          assertMetadata((await get(row.actor, row.kind)).body);
        }
        await setRatingReviewState(
          f.pool,
          comment.approved!.decisionId,
          'allow',
        );
        for (const row of families) {
          const context = await f.scopedContext(row.actor);
          assert.equal(
            (
              await get(
                row.actor,
                row.kind,
                `/${row.notice_id}/target`,
                query(context),
              )
            ).body.status,
            'available',
          );
        }
        assert.deepEqual(await noticeRows(), before);
      },
    );

    await t.test(
      'command replay and worker reruns never duplicate original notices, fanout or monotonic read state',
      async () => {
        const notices = await noticeRows(),
          effects = await f.scopedEffects();
        for (const row of recorded) {
          const response = await f.sendCommand(
            await f.freshSession(row.actor),
            row.input,
          );
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.deepEqual(response.body, row.receipt);
        }
        const repeatedDirect = await directWorker.run({
          mode: 'apply',
          eventIds: [replyEvent, likeEvent],
        });
        assert.equal(
          repeatedDirect.alreadyProcessed,
          2,
          JSON.stringify(repeatedDirect),
        );
        assert.equal(repeatedDirect.materialized, 0);
        assert.equal(repeatedDirect.failed, 0);
        const repeatedSubscriptions = await subscriptionWorker.run({
          mode: 'apply',
          eventIds: [rootEvent, replyEvent],
        });
        assert.equal(
          repeatedSubscriptions.alreadyProcessed,
          2,
          JSON.stringify(repeatedSubscriptions),
        );
        assert.equal(repeatedSubscriptions.materialized, 0);
        assert.equal(repeatedSubscriptions.failed, 0);
        assert.deepEqual(await f.scopedEffects(), effects);
        assert.deepEqual(await noticeRows(), notices);
        assert.deepEqual(
          notices.map(({ read_at: _readAt, ...row }) => row),
          originals.map(({ read_at: _readAt, ...row }) => row),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=ANY($1::uuid[])',
              [[rootEvent, replyEvent]],
            )
          ).rows[0]!.n,
          2,
        );
      },
    );

    await t.test(
      'atomic source publication rejects old contexts and generation locators while fresh navigation and historical read state survive',
      async () => {
        const contexts = await Promise.all(
          families.map((row) => f.scopedContext(row.actor)),
        );
        const locators = await Promise.all(
          families.map(async (row, index) => {
            const response = await get(
              row.actor,
              row.kind,
              `/${row.notice_id}/target`,
              query(contexts[index]!),
            );
            assert.equal(response.status, 200, JSON.stringify(response.body));
            const original = ratingScopedNoticeTargetSchema.parse(
              response.body,
            );
            assert.ok(original.status === 'available');
            assert.equal(
              original.target.protocolGeneration,
              contexts[index]!.protocolGeneration,
            );
            return original.target;
          }),
        );
        const before = await noticeRows();
        const source = (
          await f.pool.query<{ payload: Record<string, unknown> }>(
            `SELECT s.payload FROM whaleu_ratings.scoped_source_heads h
         JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
         WHERE h.source_kind='scope_absence' AND h.source_key='global'`,
          )
        ).rows[0]!;
        assert.equal(source.payload['complete'], true);
        const generation = randomUUID();
        // Adopted sources must remain complete and publish atomically. A source
        // revision invalidates contexts; a new protocol generation additionally
        // invalidates locators, which intentionally carry no catalog revision.
        await f.atomicChange(
          (tx) =>
            f.issueSource(
              {
                kind: 'scope_absence',
                key: 'global',
                scopeKeys: ['global'],
                payload: source.payload,
              },
              tx,
            ),
          { activate: true, generation, domain: { kind: 'global_compat' } },
        );
        for (const [index, row] of families.entries()) {
          await respectReadBudget();
          const response = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
            query(contexts[index]!),
          );
          assert.equal(response.status, 409, JSON.stringify(response.body));
          assert.equal(
            response.body.error.code,
            'RATING_SCOPED_CONTEXT_CHANGED',
            JSON.stringify(response.body),
          );
          const resolved = await f
            .auth(
              request(f.http).post('/v2/ratings/locators/resolve'),
              row.actor,
            )
            .send({
              locator: locators[index],
              purpose: 'read',
              mode: 'public',
            });
          assert.equal(resolved.status, 409, JSON.stringify(resolved.body));
          assert.equal(
            resolved.body.error.code,
            'RATING_SCOPED_CONTEXT_CHANGED',
            JSON.stringify(resolved.body),
          );
          const current = await f.scopedContext(row.actor);
          assert.equal(current.protocolGeneration, generation);
          assert.notEqual(
            current.protocolGeneration,
            contexts[index]!.protocolGeneration,
          );
          assert.notEqual(current.sourceDigest, contexts[index]!.sourceDigest);
          assert.notDeepEqual(current.heads, contexts[index]!.heads);
          const freshTarget = await get(
            row.actor,
            row.kind,
            `/${row.notice_id}/target`,
            query(current),
          );
          assert.equal(
            freshTarget.status,
            200,
            JSON.stringify(freshTarget.body),
          );
          const fresh = ratingScopedNoticeTargetSchema.parse(freshTarget.body);
          assert.equal(fresh.status, 'available');
          assert.ok(fresh.status === 'available');
          assert.deepEqual(fresh.target, {
            ...locators[index],
            protocolGeneration: generation,
          });
          const recovered = await f
            .auth(
              request(f.http).post('/v2/ratings/locators/resolve'),
              row.actor,
            )
            .send({ locator: fresh.target, purpose: 'read', mode: 'public' });
          assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
          const recovery = ratingScopedResolvedLocatorSchema.parse(
            recovered.body,
          );
          assert.deepEqual(recovery.locator, fresh.target);
          assert.equal(recovery.context.protocolGeneration, generation);
          const metadata = await get(row.actor, row.kind);
          assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
          assertMetadata(metadata.body);
          const read = await f
            .auth(
              request(f.http).put(
                `/v1/me/ratings/${row.kind}/${row.notice_id}/read`,
              ),
              row.actor,
            )
            .send({});
          assert.equal(read.status, 200, JSON.stringify(read.body));
          assert.equal(
            read.body.readAt,
            before.find((item) => item.notice_id === row.notice_id)!.read_at,
          );
          const client = native(row.actor);
          await client.controller.load(
            route(ratingScopedLocatorPath(locators[index])),
          );
          assert.equal(client.view().loaded, false);
          assert.ok(client.view().error);
          assert.equal(client.view().detail, null);
          assert.equal(client.view().discussion, null);
          assert.equal(
            client.transport.sent.some((sent) => sent.path.endsWith('/read')),
            false,
          );
          await loadNotices(client, row.kind);
          const path = await client.controller.noticePath(row.notice_id);
          assert.equal(typeof path, 'string', client.view().error);
          assert.equal(path, ratingScopedLocatorPath(fresh.target));
        }
        assert.deepEqual(await noticeRows(), before);
      },
    );
  },
);

test(
  'M3B divergent-campus fanout counterexample: real scoped causes use each recipient current selected campus',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedCommandFixture();
    t.after(() => f.close());
    const selector = { kind: 'campus' as const, campusId: f.campusA };
    const author = await f.actor(),
      responder = await f.actor(),
      subscriber = await f.actor();
    const target = await f.createScopedTarget(
      f.creator,
      'Campus-only notice target',
      selector,
    );
    const compat = (
      await f.pool.query<{ state: string }>(
        `SELECT v.state FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id WHERE h.compat_key=$1`,
        [`region_compat:${f.regionId}`],
      )
    ).rows[0]!;
    assert.equal(
      compat.state,
      'divergent',
      'A-only target is absent from the same-region B catalog',
    );
    const run = async (
      actor: typeof author,
      operation: RatingScopedIntent['operation'],
      payload: Record<string, unknown>,
    ) => {
      const input = await f.commandIntent(
        actor,
        operation,
        {
          targetId: target.id,
          expectedTargetRevision: target.revision,
          ...payload,
        },
        selector,
      );
      return f.executeCommand(actor, input);
    };
    const membership = await f.scopedRead(
      subscriber,
      `/v2/ratings/targets/${target.id}/subscription`,
      selector,
    );
    await run(subscriber, 'set_target_subscription_scoped', {
      expectedSubscriptionRevision: membership.revision,
      subscribed: true,
    });
    const comment = await run(author, 'create_comment_scoped', {
      authorMode: 'named',
      body: 'Campus-only root',
      assetIds: [],
    });
    const root = scopedSuccess(comment.receipt).result;
    const reply = await run(responder, 'create_reply_scoped', {
      rootId: root['subjectId'],
      expectedRootRevision: root['revision'],
      replyTo: null,
      authorMode: 'named',
      body: 'Campus-only reply',
      assetIds: [],
    });
    const likeState = await f.scopedRead(
      responder,
      `/v2/ratings/comments/${root['subjectId']}/like`,
      selector,
    );
    const like = await run(responder, 'set_comment_like_scoped', {
      rootId: root['subjectId'],
      expectedRevision: root['revision'],
      expectedLikeRevision: likeState.revision,
      liked: true,
    });
    const eventId = async (actor: typeof author, input: RatingScopedIntent) =>
      (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0]!.id;
    const rootEvent = await eventId(author, comment.input),
      replyEvent = await eventId(responder, reply.input),
      likeEvent = await eventId(responder, like.input);
    const config = {
      ...f.app.get<RuntimeConfig>(APP_CONFIG),
      RATINGS_UPDATES_PROCESSING: 'manual' as const,
    };
    const direct = new RatingUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsUpdatesSourceFacade),
      f.app.get(RatingUpdatesProjectionFacade),
      f.app.get(RatingUpdatesRepository),
    );
    const subscriptions = new RatingSubscriptionUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsSubscriptionUpdatesSourceFacade),
      f.app.get(RatingSubscriptionUpdatesProjectionFacade),
      f.app.get(RatingSubscriptionUpdatesRepository),
    );
    const materialized = await direct.run({
      mode: 'apply',
      eventIds: [replyEvent, likeEvent],
    });
    assert.equal(materialized.failed, 0, JSON.stringify(materialized));
    assert.equal(
      materialized.materialized,
      2,
      'Valid campus-A recipients must receive reply and like notices even though region_compat is divergent',
    );
    const fanout = await subscriptions.run({
      mode: 'apply',
      eventIds: [rootEvent, replyEvent],
    });
    assert.equal(fanout.failed, 0, JSON.stringify(fanout));
    assert.equal(
      fanout.materialized,
      2,
      'Valid campus-A subscriber must receive both captured activities',
    );
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object('direct',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM whaleu_notifications.rating_notices n),'subscription',(SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM whaleu_notifications.rating_subscription_notices n),'rewards',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM whaleu_ratings.reward_units r)) state`,
        )
      ).rows[0]!.state;
    const before = await snapshot();
    await direct.run({ mode: 'apply', eventIds: [replyEvent, likeEvent] });
    await subscriptions.run({
      mode: 'apply',
      eventIds: [rootEvent, replyEvent],
    });
    assert.deepEqual(
      await snapshot(),
      before,
      'Worker replay preserves original IDs, read state and Experience',
    );
    // Unknown complete-source evidence is retryable for every notice family.
    const another = async (rootAuthor: typeof author, label: string) => {
      const c = await run(rootAuthor, 'create_comment_scoped', {
        authorMode: 'named',
        body: `${label} root`,
        assetIds: [],
      });
      const cr = scopedSuccess(c.receipt).result;
      const r = await run(responder, 'create_reply_scoped', {
        rootId: cr['subjectId'],
        expectedRootRevision: cr['revision'],
        replyTo: null,
        authorMode: 'named',
        body: `${label} reply`,
        assetIds: [],
      });
      const state = await f.scopedRead(
        responder,
        `/v2/ratings/comments/${cr['subjectId']}/like`,
        selector,
      );
      const l = await run(responder, 'set_comment_like_scoped', {
        rootId: cr['subjectId'],
        expectedRevision: cr['revision'],
        expectedLikeRevision: state.revision,
        liked: true,
      });
      return {
        direct: [
          await eventId(responder, r.input),
          await eventId(responder, l.input),
        ],
        subscription: [
          await eventId(rootAuthor, c.input),
          await eventId(responder, r.input),
        ],
      };
    };
    const unknown = await another(author, 'Source temporarily unknown');
    const sourceReview = (
      await f.pool.query<{ decision_id: string; event_id: string }>(
        `SELECT b.decision_id,h.event_id FROM whaleu_community.rating_scoped_category_source_bindings b JOIN whaleu_community.rating_approval_heads h USING(decision_id) WHERE b.source_id=$1`,
        [f.data.local.source.id],
      )
    ).rows[0]!;
    await withCommunityScopeWriter(f.pool, async (tx) => {
      const event = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','missing','accepted','synthetic-notice-owner','synthetic-incomplete-source',clock_timestamp())`,
        [event, sourceReview.decision_id],
      );
      await tx.query(
        'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
        [sourceReview.decision_id, event],
      );
    });
    const beforeUnknown = await snapshot();
    const unknownDirect = await direct.run({
      mode: 'apply',
      eventIds: unknown.direct,
    });
    const unknownSubscription = await subscriptions.run({
      mode: 'apply',
      eventIds: unknown.subscription,
    });
    assert.equal(unknownDirect.failed, 0, JSON.stringify(unknownDirect));
    assert.equal(unknownDirect.retryable, 2, JSON.stringify(unknownDirect));
    assert.equal(unknownDirect.suppressed, 0);
    assert.equal(
      unknownSubscription.failed,
      0,
      JSON.stringify(unknownSubscription),
    );
    assert.equal(
      unknownSubscription.retryable,
      2,
      JSON.stringify(unknownSubscription),
    );
    assert.equal(unknownSubscription.suppressed, 0);
    assert.deepEqual(
      await snapshot(),
      beforeUnknown,
      'Unknown source must not mint or permanently suppress notices',
    );
    await setRatingReviewState(f.pool, sourceReview.decision_id, 'allow');
    const retryWait = (
      await f.pool.query<{ wait: number }>(
        `SELECT coalesce(max(greatest(0,extract(epoch FROM next_attempt_at-clock_timestamp())*1000)),0)::double precision wait FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=ANY($1::uuid[])`,
        [unknown.subscription],
      )
    ).rows[0]!.wait;
    if (retryWait > 0) await delay(Math.ceil(retryWait) + 25);
    assert.equal(
      (await direct.run({ mode: 'apply', eventIds: unknown.direct }))
        .materialized,
      2,
    );
    assert.equal(
      (
        await subscriptions.run({
          mode: 'apply',
          eventIds: unknown.subscription,
        })
      ).materialized,
      2,
    );

    // One captured reply has two different current recipient selections. The
    // root author still selects A; the reply-to author now selects B, where this
    // target is absent. Qualification must be per recipient, not per event.
    await appendIdentitySelection(
      f.pool,
      responder.accountId,
      responder.facts,
      f.scope,
      f.campusB,
    );
    const originalReply = scopedSuccess(reply.receipt).result;
    const mixed = await run(f.creator, 'create_reply_scoped', {
      rootId: root['subjectId'],
      expectedRootRevision: root['revision'],
      replyTo: {
        replyId: originalReply['replyId'],
        expectedRevision: originalReply['revision'],
      },
      authorMode: 'named',
      body: 'One reply with independently qualified campus recipients',
      assetIds: [],
    });
    const mixedEvent = await eventId(f.creator, mixed.input);
    const capturedMixedSource = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object('event',to_jsonb(e),
            'obligations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.reason) FROM whaleu_ratings.notice_obligations o WHERE o.event_id=e.id),
            'causes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.cause_kind) FROM whaleu_ratings.scoped_command_causes c WHERE (c.account_id,c.request_id)=(e.actor_account_id,e.request_id))) state
           FROM whaleu_ratings.effect_events e WHERE e.id=$1`,
          [mixedEvent],
        )
      ).rows[0]!.state;
    const mixedSource = await capturedMixedSource();
    assert.equal(mixedSource.event.expected_direct_notice_obligations, 2);
    assert.equal(
      mixedSource.event.request_id,
      mixed.input.payload.clientRequestId,
    );
    assert.deepEqual(
      mixedSource.obligations.map(
        (o: { recipient_account_id: string; reason: string }) => ({
          recipient: o.recipient_account_id,
          reason: o.reason,
        }),
      ),
      [
        { recipient: responder.accountId, reason: 'direct_reply' },
        { recipient: author.accountId, reason: 'direct_root' },
      ],
    );
    assert.ok(
      mixedSource.causes.some(
        (c: { cause_kind: string; artifact_id: string }) =>
          c.cause_kind === 'execution' &&
          c.artifact_id === mixed.input.context.id,
      ),
    );
    const mixedResult = await direct.run({
      mode: 'apply',
      eventIds: [mixedEvent],
    });
    assert.equal(mixedResult.processed, 1, JSON.stringify(mixedResult));
    assert.equal(mixedResult.materialized, 1, JSON.stringify(mixedResult));
    assert.equal(mixedResult.suppressed, 1, JSON.stringify(mixedResult));
    assert.equal(mixedResult.retryable, 0, JSON.stringify(mixedResult));
    assert.equal(mixedResult.failed, 0, JSON.stringify(mixedResult));
    assert.deepEqual(
      (
        await f.pool.query(
          `SELECT recipient_account_id,reason,outcome FROM whaleu_notifications.rating_processing_receipts WHERE event_id=$1 ORDER BY reason`,
          [mixedEvent],
        )
      ).rows,
      [
        {
          recipient_account_id: responder.accountId,
          reason: 'direct_reply',
          outcome: 'suppressed',
        },
        {
          recipient_account_id: author.accountId,
          reason: 'direct_root',
          outcome: 'materialized',
        },
      ],
    );
    assert.deepEqual(
      (
        await f.pool.query(
          `SELECT event_id,recipient_account_id,reason,target_id,root_id,reply_id FROM whaleu_notifications.rating_notices WHERE event_id=$1`,
          [mixedEvent],
        )
      ).rows,
      [
        {
          event_id: mixedEvent,
          recipient_account_id: author.accountId,
          reason: 'direct_root',
          target_id: target.id,
          root_id: root['subjectId'],
          reply_id: scopedSuccess(mixed.receipt).result['replyId'],
        },
      ],
    );
    assert.deepEqual(await capturedMixedSource(), mixedSource);
    const mixedNotices = await snapshot();
    await appendIdentitySelection(
      f.pool,
      responder.accountId,
      responder.facts,
      f.scope,
      f.campusA,
    );
    const mixedReplay = await direct.run({
      mode: 'apply',
      eventIds: [mixedEvent],
    });
    assert.equal(mixedReplay.alreadyProcessed, 1, JSON.stringify(mixedReplay));
    assert.equal(mixedReplay.materialized, 0);
    assert.equal(mixedReplay.failed, 0);
    assert.deepEqual(await capturedMixedSource(), mixedSource);
    assert.deepEqual(
      await snapshot(),
      mixedNotices,
      'Returning the denied reply-to recipient to A cannot add a later push or duplicate the root-author notice',
    );

    // Both actors explicitly browse A for commands, but their current selected
    // recipient campus is B. Sender A does not authorize delivery in B.
    const authorB = await f.actor({ campusId: f.campusB });
    await appendIdentitySelection(
      f.pool,
      subscriber.accountId,
      subscriber.facts,
      f.scope,
      f.campusB,
    );
    const denied = await another(authorB, 'Different-campus recipient');
    const deniedBefore = await snapshot();
    const deniedDirect = await direct.run({
      mode: 'apply',
      eventIds: denied.direct,
    });
    const deniedSubscription = await subscriptions.run({
      mode: 'apply',
      eventIds: denied.subscription,
    });
    assert.equal(deniedDirect.failed, 0, JSON.stringify(deniedDirect));
    assert.equal(deniedDirect.suppressed, 2, JSON.stringify(deniedDirect));
    assert.equal(deniedDirect.materialized, 0);
    assert.equal(
      deniedSubscription.failed,
      0,
      JSON.stringify(deniedSubscription),
    );
    assert.equal(
      deniedSubscription.suppressed,
      2,
      JSON.stringify(deniedSubscription),
    );
    assert.equal(deniedSubscription.materialized, 0);
    assert.deepEqual(await snapshot(), deniedBefore);
    await appendIdentitySelection(
      f.pool,
      authorB.accountId,
      authorB.facts,
      f.scope,
      f.campusA,
    );
    await appendIdentitySelection(
      f.pool,
      subscriber.accountId,
      subscriber.facts,
      f.scope,
      f.campusA,
    );
    await direct.run({ mode: 'apply', eventIds: denied.direct });
    await subscriptions.run({ mode: 'apply', eventIds: denied.subscription });
    assert.deepEqual(
      await snapshot(),
      deniedBefore,
      'An authoritative denied delivery does not become a later push after a campus change',
    );
    const beforeSelection = await snapshot();
    // Current recipient selection, not sender A or shared region, determines access.
    await appendIdentitySelection(
      f.pool,
      author.accountId,
      author.facts,
      f.scope,
      f.campusB,
    );
    const notice = (
      await f.pool.query<{ id: string }>(
        `SELECT id FROM whaleu_notifications.rating_notices WHERE recipient_account_id=$1 AND kind='reply'`,
        [author.accountId],
      )
    ).rows[0]!;
    const b = await f.scopedContext(author, {
      kind: 'campus',
      campusId: f.campusB,
    });
    const unavailable = await f
      .auth(
        request(f.http).get(`/v2/me/ratings/updates/${notice.id}/target`),
        author,
      )
      .query({ contextId: b.id, contextToken: b.token });
    assert.equal(unavailable.status, 200, JSON.stringify(unavailable.body));
    assert.equal(unavailable.body.status, 'unavailable');
    assert.deepEqual(
      await snapshot(),
      beforeSelection,
      'Click requalification does not change original history',
    );
  },
);

test(
  'M3B original v1 reply like and subscription notice IDs survive divergent adoption and explicit v2 locator recovery',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const author = f.creator,
      responder = await f.actor(),
      subscriber = await f.actor();
    const legacy = await f.catalog(author, { regionId: f.regionId, count: 1 });
    const target = legacy.targets[0]!;
    const authGet = (actor: typeof author, path: string) =>
      f.auth(request(f.http).get(path), actor).query({ regionId: f.regionId });
    const state = await authGet(
      subscriber,
      `/v1/ratings/targets/${target.id}/subscription`,
    );
    assert.equal(state.status, 200, JSON.stringify(state.body));
    const sub = await f
      .auth(
        request(f.http).put(`/v1/ratings/targets/${target.id}/subscription`),
        subscriber,
      )
      .send({
        clientRequestId: randomUUID(),
        regionId: f.regionId,
        expectedTargetRevision: target.revision,
        expectedSubscriptionRevision: state.body.revision,
        subscribed: true,
      });
    assert.equal(sub.status, 200, JSON.stringify(sub.body));
    const rootInput = f.body(legacy, target);
    await approveRating(f.pool, f.envelope(author, legacy, target, rootInput));
    const posted = await f
      .auth(
        request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
        author,
      )
      .send(rootInput);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const root = {
      id: String(posted.body.subjectId),
      revision: String(posted.body.revision),
    };
    const reply = await f.publishReply(responder, legacy, target, root);
    const likedState = await authGet(
      responder,
      `/v1/ratings/comments/${root.id}/like`,
    );
    assert.equal(likedState.status, 200, JSON.stringify(likedState.body));
    const likedId = randomUUID();
    const liked = await f
      .auth(
        request(f.http).put(`/v1/ratings/comments/${root.id}/like`),
        responder,
      )
      .send({
        clientRequestId: likedId,
        regionId: f.regionId,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        expectedRevision: root.revision,
        expectedLikeRevision: likedState.body.revision,
        liked: true,
      });
    assert.equal(liked.status, 200, JSON.stringify(liked.body));
    const event = async (requestId: string) =>
      (
        await f.pool.query<{ id: string }>(
          'SELECT id FROM whaleu_ratings.effect_events WHERE request_id=$1',
          [requestId],
        )
      ).rows[0]!.id;
    const rootEvent = await event(rootInput.clientRequestId),
      replyEvent = await event(reply.input.clientRequestId),
      likeEvent = await event(likedId);
    const config = {
      ...f.app.get<RuntimeConfig>(APP_CONFIG),
      RATINGS_UPDATES_PROCESSING: 'manual' as const,
    };
    const direct = new RatingUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsUpdatesSourceFacade),
      f.app.get(RatingUpdatesProjectionFacade),
      f.app.get(RatingUpdatesRepository),
    );
    const subscriptions = new RatingSubscriptionUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      f.app.get(RatingsSubscriptionUpdatesSourceFacade),
      f.app.get(RatingSubscriptionUpdatesProjectionFacade),
      f.app.get(RatingSubscriptionUpdatesRepository),
    );
    assert.equal(
      (await direct.run({ mode: 'apply', eventIds: [replyEvent, likeEvent] }))
        .materialized,
      2,
    );
    assert.equal(
      (
        await subscriptions.run({
          mode: 'apply',
          eventIds: [rootEvent, replyEvent],
        })
      ).materialized,
      2,
    );
    const notices = async () =>
      (
        await f.pool.query<{
          id: string;
          kind: RatingScopedNoticeKind;
          read_at: string | null;
        }>(
          `SELECT id,CASE kind WHEN 'like' THEN 'like-updates' ELSE 'updates' END kind,read_at::text FROM whaleu_notifications.rating_notices UNION ALL SELECT id,'subscription-updates',read_at::text FROM whaleu_notifications.rating_subscription_notices ORDER BY id`,
        )
      ).rows;
    const original = await notices();
    assert.equal(original.length, 4);
    const scopeKey = `campus:${f.campusA}`;
    const adoption = await prepareSyntheticOpaqueAdoption(
      f,
      legacy.catalogId,
      legacy.categoryId,
      [scopeKey],
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      writeSyntheticOpaqueAdoption(tx, adoption),
    );
    await f.declareAll();
    await f.declareScope(scopeKey, {
      categoryIds: [legacy.categoryId],
      targetIds: [target.id],
      legacyCatalogIds: [legacy.catalogId],
    });
    // Empty B still observed the full old region predecessor; its explicit
    // placement excludes these rows rather than pretending no old source exists.
    await f.declareScope(`campus:${f.campusB}`, {
      categoryIds: [],
      targetIds: [],
      legacyCatalogIds: [legacy.catalogId],
    });
    await f.capability();
    await f.publish({ activate: true });
    assert.deepEqual(
      await notices(),
      original,
      'Activation does not rewrite historical notice identities or read state',
    );
    for (const row of original) {
      const actor = row.kind === 'subscription-updates' ? subscriber : author;
      const list = await f.auth(
        request(f.http).get(`/v2/me/ratings/${row.kind}`),
        actor,
      );
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.ok(
        list.body.items.some(
          (item: { noticeId: string; status: string }) =>
            item.noticeId === row.id && item.status === 'unavailable',
        ),
      );
      const a = await f.scopedContext(actor, {
        kind: 'campus',
        campusId: f.campusA,
      });
      const resolve = await f
        .auth(
          request(f.http).get(`/v2/me/ratings/${row.kind}/${row.id}/target`),
          actor,
        )
        .query({ contextId: a.id, contextToken: a.token });
      assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
      assert.equal(resolve.body.status, 'available');
      assert.equal(resolve.body.target.targetId, target.id);
      const read = await f
        .auth(
          request(f.http).put(`/v1/me/ratings/${row.kind}/${row.id}/read`),
          actor,
        )
        .send({});
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const again = await f
        .auth(
          request(f.http).put(`/v1/me/ratings/${row.kind}/${row.id}/read`),
          actor,
        )
        .send({});
      assert.deepEqual(again.body, read.body);
      const b = await f.scopedContext(actor, {
        kind: 'campus',
        campusId: f.campusB,
      });
      const hidden = await f
        .auth(
          request(f.http).get(`/v2/me/ratings/${row.kind}/${row.id}/target`),
          actor,
        )
        .query({ contextId: b.id, contextToken: b.token });
      assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
      assert.equal(hidden.body.status, 'unavailable');
    }
    const afterRead = await notices();
    assert.deepEqual(
      afterRead.map(({ id, kind }) => ({ id, kind })),
      original.map(({ id, kind }) => ({ id, kind })),
    );
    assert.ok(afterRead.every((row) => row.read_at !== null));
    await direct.run({ mode: 'apply', eventIds: [replyEvent, likeEvent] });
    await subscriptions.run({
      mode: 'apply',
      eventIds: [rootEvent, replyEvent],
    });
    assert.deepEqual(
      await notices(),
      afterRead,
      'Historical worker replay never duplicates or revives notices',
    );
  },
);
