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
  serverFailure,
} from '../support/experience-native-bridge.js';
import { APP_CONFIG, type RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import {
  ratingLikeReceiptSchema,
  ratingLikeStateSchema,
  type RatingLikeReceipt,
  type RatingLikeState,
  type SetRatingCommentLike,
  type SetRatingReplyLike,
} from '../../src/ratings/likes/contracts.js';
import type { RatingComment } from '../../src/ratings/contracts.js';
import type { RatingReply } from '../../src/ratings/discussion-contracts.js';
import type { RatingNotice } from '../../src/notifications/ratings/contracts.js';
import type { RatingLikeNotice } from '../../src/notifications/ratings/like-contracts.js';

type LikeIntent =
  | {
      operation: 'set_comment_like';
      rootId: string;
      payload: SetRatingCommentLike;
    }
  | {
      operation: 'set_reply_like';
      replyId: string;
      payload: SetRatingReplyLike;
    };
interface PendingLike {
  version: 2;
  accountId: string;
  intent: LikeIntent;
}
interface RatingCommentPage {
  context: unknown;
  items: readonly RatingComment[];
  nextCursor: string | null;
  continuation: 'more' | 'scan' | 'end';
}
interface RatingView {
  loaded: boolean;
  frozen: boolean;
  error: string;
  comments: readonly RatingComment[];
  likes: Readonly<Record<string, RatingLikeState>>;
  commentSort: 'time' | 'likes';
  commentOrder: 'asc' | 'desc';
}
interface ThreadView {
  loaded: boolean;
  frozen: boolean;
  error: string;
  replies: readonly RatingReply[];
  likes: Readonly<Record<string, RatingLikeState>>;
  anchorReplyId: string;
}
interface UpdatesView {
  loaded: boolean;
  category: 'reply' | 'like';
  unreadCount: number | null;
  items: readonly (RatingNotice | RatingLikeNotice)[];
}
interface SentRequest {
  path: string;
  method: string;
  bodyBytes?: string;
}

// Only device HTTP/storage/UUID I/O is bridged. Every response, membership,
// receipt, ordering head and notice comes from the ordinary AppModule and PG.
// Request capture deliberately excludes headers and authentication secrets.
class ObservedHttpTransport extends DirectoryHttpTransport {
  readonly sent: SentRequest[] = [];
  readonly responseStatus: Array<{
    path: string;
    status: number;
    code?: string;
  }> = [];
  likeReadsInFlight = 0;
  maximumLikeReadsInFlight = 0;
  beforeSend: ((request: SentRequest) => void) | null = null;
  override send(input: Parameters<DirectoryHttpTransport['send']>[0]) {
    const url = new URL(input.url);
    const sent = {
      path: `${url.pathname}${url.search}`,
      method: input.method,
      ...(input.body === undefined
        ? {}
        : { bodyBytes: JSON.stringify(input.body) }),
    };
    this.sent.push(sent);
    this.beforeSend?.(sent);
    const likeRead =
      input.method === 'GET' &&
      /^\/v1\/ratings\/(?:comments|replies)\/[^/]+\/like$/.test(url.pathname);
    if (likeRead) {
      this.likeReadsInFlight++;
      this.maximumLikeReadsInFlight = Math.max(
        this.maximumLikeReadsInFlight,
        this.likeReadsInFlight,
      );
    }
    return super.send(input).finally(() => {
      if (likeRead) this.likeReadsInFlight--;
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
  decodeRatingLikeState,
  decodeRatingLikeReceipt,
} = require('../../../wechat/src/ratings/like-contract.ts');
const {
  decodeRatingLikeUpdatesPage,
  decodeRatingLikeNoticeTarget,
} = require('../../../wechat/src/ratings/like-updates-contract.ts');
const {
  decodeRatingCommentPage,
} = require('../../../wechat/src/ratings/contract.ts');
const {
  decodeRatingUpdatesPage,
} = require('../../../wechat/src/ratings/updates-contract.ts');

test(
  'R2B actual native controllers through AppModule HTTP/PG recover desired-state likes and keep current reads, notices and ordered cursors independent',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingDiscussionFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      replyOwner = await f.actor(),
      liker = await f.actor(),
      catalog = await f.catalog(owner, { count: 3 }),
      target = catalog.targets[0]!,
      sortTarget = catalog.targets[1]!,
      unknownTarget = catalog.targets[2]!;
    type Actor = typeof owner;
    type Content = { id: string; revision: string };
    type Subject = {
      target: typeof target;
      root: Content;
      reply: Content | null;
    };
    const root = await f.publish(owner, catalog, target),
      reply = await f.publishReply(replyOwner, catalog, target, root);
    const rootSubject: Subject = { target, root, reply: null },
      replySubject: Subject = { target, root, reply };
    const golden: Record<string, unknown> = {};
    const capture = (key: string, body: unknown) => {
      const serialized = JSON.stringify(body);
      for (const secret of [
        owner.accountId,
        replyOwner.accountId,
        liker.accountId,
        owner.accessToken,
        replyOwner.accessToken,
        liker.accessToken,
      ])
        assert.equal(serialized.includes(secret), false);
      assert.doesNotMatch(
        serialized,
        /"(?:accountId|actorAccountId|recipientAccountId|beneficiaryId|envelope|approval|digest)"/,
      );
      golden[key] ??= structuredClone(body);
    };
    const native = (actor: Actor) => {
      const transport = new ObservedHttpTransport(f.port),
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
        threadViews: ThreadView[] = [],
        updateViews: UpdatesView[] = [],
        navigation: string[] = [];
      const rating = new RatingController(
        runtime,
        'detail',
        (view: RatingView) => ratingViews.push(view),
      );
      const thread = new RatingThreadController(runtime, (view: ThreadView) =>
        threadViews.push(view),
      );
      const updates = new RatingUpdatesController(
        runtime,
        (view: UpdatesView) => updateViews.push(view),
        async (path: string) => {
          navigation.push(path);
        },
      );
      t.after(() => {
        rating.dispose();
        thread.dispose();
        updates.dispose();
      });
      transport.checkResponse = (path, status, body) => {
        const error = (body as { error?: { code?: unknown } })?.error;
        transport.responseStatus.push({
          path,
          status,
          ...(typeof error?.code === 'string' ? { code: error.code } : {}),
        });
        if (status !== 200) return;
        const raw = body as Record<string, unknown>;
        if (path === '/v1/me/ratings/like-updates') {
          assert.deepEqual(decodeRatingLikeUpdatesPage(body), body);
          capture('likeUpdatesPage', body);
        } else if (
          /^\/v1\/me\/ratings\/like-updates\/[^/]+\/target$/.test(path)
        ) {
          assert.deepEqual(decodeRatingLikeNoticeTarget(body), body);
          const locator = raw['target'] as
            { replyId: string | null } | undefined;
          if (locator)
            capture(
              locator.replyId === null
                ? 'rootLikeNoticeTarget'
                : 'replyLikeNoticeTarget',
              body,
            );
        } else if (path === `/v1/ratings/targets/${sortTarget.id}/comments`) {
          assert.deepEqual(decodeRatingCommentPage(body), body);
          capture('sortedCommentPage', body);
        }
        if (
          !/\/ratings\/(?:comments|replies)\/[^/]+\/like$|\/ratings\/like-requests\//.test(
            path,
          )
        )
          return;
        if (raw['status'] !== undefined) {
          assert.deepEqual(
            decodeRatingLikeState(body),
            ratingLikeStateSchema.parse(body),
          );
          assert.throws(
            () => decodeRatingLikeState({ ...raw, count: -1 }),
            protocolFailure,
          );
          capture(
            raw['status'] === 'unavailable'
              ? 'unavailableLikeState'
              : raw['replyId'] === null
                ? 'rootLikeState'
                : 'replyLikeState',
            body,
          );
        } else {
          assert.deepEqual(
            decodeRatingLikeReceipt(body),
            ratingLikeReceiptSchema.parse(body),
          );
          assert.throws(
            () => decodeRatingLikeReceipt({ ...raw, count: 0 }),
            protocolFailure,
          );
          capture(
            raw['replyId'] === null ? 'rootLikeReceipt' : 'replyLikeReceipt',
            body,
          );
        }
        for (const secret of [
          owner.accountId,
          replyOwner.accountId,
          liker.accountId,
          owner.accessToken,
          replyOwner.accessToken,
          liker.accessToken,
        ])
          assert.equal(JSON.stringify(body).includes(secret), false);
      };
      return {
        actor,
        transport,
        device,
        runtime,
        rating,
        thread,
        updates,
        navigation,
        cancel: new Cancellation(),
        ratingView: () => ratingViews.at(-1)!,
        threadView: () => threadViews.at(-1)!,
        updatesView: () => updateViews.at(-1)!,
      };
    };
    const a = native(liker),
      secondDevice = native(liker),
      r = native(owner),
      p = native(replyOwner);
    type Native = ReturnType<typeof native>;
    const subjectId = (s: Subject) => s.reply?.id ?? s.root.id;
    const likePath = (s: Subject) =>
      `/v1/ratings/${s.reply ? 'replies' : 'comments'}/${subjectId(s)}/like`;
    async function current(n: Native, s: Subject) {
      return (await n.runtime.ratingLikes.state(
        catalog.regionId,
        {
          targetId: s.target.id,
          rootId: s.root.id,
          replyId: s.reply?.id ?? null,
        },
        n.cancel,
      )) as RatingLikeState;
    }
    async function known(n: Native, s: Subject) {
      const state = await current(n, s);
      assert.equal(state.status, 'known', JSON.stringify(state));
      if (state.status !== 'known')
        throw new Error('Expected native publication baseline');
      return state;
    }
    async function desired(n: Native, s: Subject, liked: boolean) {
      const state = await known(n, s),
        payload = {
          clientRequestId: randomUUID(),
          regionId: catalog.regionId,
          targetId: s.target.id,
          expectedTargetRevision: s.target.revision,
          expectedRevision: (s.reply ?? s.root).revision,
          expectedLikeRevision: state.revision,
          liked,
        };
      const intent: LikeIntent = s.reply
        ? {
            operation: 'set_reply_like',
            replyId: s.reply.id,
            payload: {
              ...payload,
              rootId: s.root.id,
              expectedRootRevision: s.root.revision,
            },
          }
        : { operation: 'set_comment_like', rootId: s.root.id, payload };
      const receipt = (await n.runtime.ratingLikes.command(
        intent,
        n.cancel,
      )) as RatingLikeReceipt;
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      return { intent, receipt };
    }
    const positiveRequests: string[] = [];
    for (const subject of [rootSubject, replySubject])
      await t.test(
        `${subject.reply ? 'reply' : 'root'} lost committed responses retain exact desired state/key and historical recovery cannot restore a later unlike`,
        async () => {
          const controller = subject.reply ? a.thread : a.rating;
          const view = subject.reply ? a.threadView : a.ratingView;
          await controller.load(
            subject.reply
              ? { targetId: target.id, rootId: root.id }
              : { targetId: target.id },
          );
          assert.equal(view().loaded, true, view().error);
          const before = await known(a, subject);
          assert.equal(before.count, 0);
          assert.equal(before.liked, false);
          const path = likePath(subject),
            start = a.transport.sent.length,
            journalKey = `whaleu.ratings.pending.v2:${directoryNativeOrigin}:${liker.accountId}`;
          a.transport.beforeSend = (sent) => {
            if (sent.method !== 'PUT' || sent.path !== path) return;
            const frozen = a.runtime.pendingRatings.load(
              liker.accountId,
            ) as PendingLike;
            assert.ok(
              frozen,
              'The actual device journal is persisted before HTTP dispatch',
            );
            assert.equal(sent.bodyBytes, JSON.stringify(frozen.intent.payload));
          };
          a.transport.dropSuccess = { path, method: 'PUT' };
          await controller.toggleLike(subjectId(subject));
          const pending = a.runtime.pendingRatings.load(
              liker.accountId,
            ) as PendingLike,
            bytes = JSON.stringify(a.device.storage.get(journalKey));
          assert.ok(pending);
          assert.equal(pending.version, 2);
          assert.equal(
            pending.intent.operation,
            subject.reply ? 'set_reply_like' : 'set_comment_like',
          );
          assert.equal(pending.intent.payload.liked, true);
          assert.equal(
            pending.intent.payload.expectedLikeRevision,
            before.revision,
          );
          assert.equal(
            pending.intent.payload.expectedRevision,
            (subject.reply ?? subject.root).revision,
          );
          assert.equal(
            pending.intent.payload.expectedTargetRevision,
            target.revision,
          );
          if (pending.intent.operation === 'set_reply_like') {
            assert.equal(pending.intent.payload.rootId, root.id);
            assert.equal(
              pending.intent.payload.expectedRootRevision,
              root.revision,
            );
          }
          assert.equal(view().frozen, true);
          assert.deepEqual(view().likes, {});
          positiveRequests.push(pending.intent.payload.clientRequestId);
          const committed = await known(secondDevice, subject);
          assert.equal(committed.liked, true);
          assert.equal(committed.count, 1);

          // Retry also reaches PG, returns the original receipt, and loses its
          // response after commit. The second PUT is byte-identical to the first.
          a.transport.dropSuccess = { path, method: 'PUT' };
          await controller.recover(true);
          assert.equal(JSON.stringify(a.device.storage.get(journalKey)), bytes);
          const puts = a.transport.sent
            .slice(start)
            .filter((sent) => sent.path === path && sent.method === 'PUT');
          assert.equal(puts.length, 2);
          assert.equal(
            puts[0]!.bodyBytes,
            JSON.stringify(pending.intent.payload),
          );
          assert.equal(puts[1]!.bodyBytes, puts[0]!.bodyBytes);
          assert.equal(
            (
              await f.pool.query(
                'SELECT id FROM whaleu_ratings.like_transitions WHERE account_id=$1 AND request_id=$2',
                [liker.accountId, pending.intent.payload.clientRequestId],
              )
            ).rowCount,
            1,
          );

          // A different device changes this actor's membership; a different actor
          // leaves a nonzero count. Neither fact can be inferred from the receipt.
          await desired(secondDevice, subject, false);
          await desired(subject.reply ? r : p, subject, true);
          const now = await known(secondDevice, subject);
          assert.equal(now.liked, false);
          assert.equal(now.count, 1);
          assert.notEqual(now.revision, committed.revision);
          const receipt = (await secondDevice.runtime.ratingLikes.receipt(
            pending.intent.payload.clientRequestId,
            secondDevice.cancel,
          )) as RatingLikeReceipt;
          assert.equal(receipt.outcome, 'applied');
          assert.equal(receipt.liked, true);
          const recoveryStart = a.transport.sent.length,
            recoveryResponses = a.transport.responseStatus.length;
          await controller.recover();
          assert.equal(a.runtime.pendingRatings.load(liker.accountId), null);
          assert.equal(a.device.storage.get(journalKey), undefined);
          assert.equal(view().frozen, false);
          assert.equal(view().loaded, true, view().error);
          // Actual HTTP reads in one visible batch must not contend with each
          // other's exclusive safety final fence. No retry or fabricated state.
          assert.equal(a.transport.maximumLikeReadsInFlight, 1);
          assert.equal(a.transport.likeReadsInFlight, 0);
          assert.ok(
            Object.values(view().likes).every(
              (state) => state.status === 'known',
            ),
            JSON.stringify(a.transport.responseStatus.slice(recoveryResponses)),
          );
          if (subject.reply)
            assert.deepEqual(
              Object.keys(view().likes).sort(),
              [root.id, reply.id].sort(),
            );
          assert.deepEqual(
            view().likes[subjectId(subject)],
            now,
            JSON.stringify({
              currentReadResponses:
                a.transport.responseStatus.slice(recoveryResponses),
              sharedAccountRequests:
                a.transport.sent.length + secondDevice.transport.sent.length,
            }),
          );
          const recovery = a.transport.sent.slice(recoveryStart);
          assert.ok(
            recovery.some(
              (sent) =>
                sent.path ===
                  `/v1/ratings/like-requests/${pending.intent.payload.clientRequestId}` &&
                sent.method === 'GET' &&
                sent.bodyBytes === undefined,
            ),
          );
          assert.equal(
            recovery.some((sent) => sent.method === 'PUT'),
            false,
          );
          assert.deepEqual(
            await secondDevice.runtime.ratingLikes.command(
              pending.intent,
              secondDevice.cancel,
            ),
            receipt,
          );
          assert.deepEqual(await known(secondDevice, subject), now);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::integer n FROM whaleu_ratings.like_transitions WHERE subject_id=$1 AND account_id=$2',
                [subjectId(subject), liker.accountId],
              )
            ).rows[0]!.n,
            2,
          );
          a.transport.beforeSend = null;
        },
      );

    await t.test(
      'actual worker-projected like notices use separate strict DTOs, counters and receiving-page read endpoints',
      async () => {
        const config = f.app.get<RuntimeConfig>(APP_CONFIG);
        const worker = new RatingUpdatesWorker(
          f.app.get(DatabaseService),
          { ...config, RATINGS_UPDATES_PROCESSING: 'manual' },
          f.app.get(RatingsUpdatesSourceFacade),
          f.app.get(RatingUpdatesProjectionFacade),
          f.app.get(RatingUpdatesRepository),
        );
        const events = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_ratings.effect_events WHERE (actor_account_id=$1 AND request_id=ANY($2::uuid[])) OR (actor_account_id=$3 AND request_id=$4)',
            [
              liker.accountId,
              positiveRequests,
              replyOwner.accountId,
              reply.input.clientRequestId,
            ],
          )
        ).rows.map((row) => row.id);
        assert.equal(events.length, 3);
        const result = await worker.run({ mode: 'apply', eventIds: events });
        assert.equal(result.failed, 0, JSON.stringify(result));
        assert.equal(result.materialized, 3, JSON.stringify(result));
        await r.updates.load();
        assert.equal(r.updatesView().loaded, true);
        assert.equal(r.updatesView().category, 'reply');
        const replyNotice = r.updatesView().items[0]!;
        assert.ok(
          replyNotice.status === 'available' && replyNotice.kind === 'reply',
        );
        const replyPage = await r.runtime.ratingUpdates.list(null, r.cancel);
        assert.equal(replyPage.items.length, 1);
        assert.equal(replyPage.unreadCount, 1);
        assert.deepEqual(decodeRatingUpdatesPage(replyPage), replyPage);
        assert.throws(
          () => decodeRatingLikeUpdatesPage(replyPage),
          protocolFailure,
        );
        for (const [recipient, subject] of [
          [r, rootSubject],
          [p, replySubject],
        ] as const) {
          const start = recipient.transport.sent.length;
          await recipient.updates.selectCategory('like');
          const view = recipient.updatesView();
          assert.equal(view.loaded, true);
          assert.equal(view.category, 'like');
          assert.equal(view.unreadCount, 1);
          assert.equal(view.items.length, 1);
          const notice = view.items[0]!;
          assert.ok(notice.status === 'available' && notice.kind === 'like');
          assert.equal(notice.reason, 'like');
          assert.equal(notice.target.rootId, root.id);
          assert.equal(notice.target.replyId, subject.reply?.id ?? null);
          assert.deepEqual(Object.keys(notice.preview), ['text']);
          const page = await recipient.runtime.ratingLikeUpdates.list(
            null,
            recipient.cancel,
          );
          assert.deepEqual(decodeRatingLikeUpdatesPage(page), page);
          assert.throws(() => decodeRatingUpdatesPage(page), protocolFailure);
          assert.deepEqual(
            await recipient.runtime.ratingLikeUpdates.unread(recipient.cancel),
            { unreadCount: 1 },
          );
          await recipient.updates.open(notice.noticeId);
          const navigation = recipient.navigation.at(-1)!;
          assert.match(
            navigation,
            new RegExp(`likeNoticeId=${notice.noticeId}`),
          );
          assert.doesNotMatch(navigation, /[?&]noticeId=/);
          if (subject.reply)
            assert.match(navigation, new RegExp(`replyId=${reply.id}`));
          else assert.doesNotMatch(navigation, /[?&]replyId=/);
          assert.equal(
            recipient.transport.sent
              .slice(start)
              .some((sent) => sent.method === 'PUT'),
            false,
            'Opening the source list only resolves a locator',
          );
          recipient.transport.beforeSend = (sent) => {
            if (sent.path.endsWith(`/${notice.noticeId}/read`))
              assert.equal(
                recipient.threadView().loaded,
                true,
                'The receiving page applied current content before mark-read',
              );
          };
          const route = Object.fromEntries(
            new URL(navigation, directoryNativeOrigin).searchParams,
          );
          await recipient.thread.load(route);
          assert.equal(
            recipient.threadView().loaded,
            true,
            recipient.threadView().error,
          );
          assert.equal(
            recipient.threadView().anchorReplyId,
            subject.reply?.id ?? '',
          );
          const requests = recipient.transport.sent.slice(start);
          assert.ok(
            requests.some(
              (sent) =>
                sent.path ===
                  `/v1/me/ratings/like-updates/${notice.noticeId}/read` &&
                sent.method === 'PUT' &&
                sent.bodyBytes === '{}',
            ),
          );
          assert.equal(
            requests.some(
              (sent) =>
                sent.method === 'PUT' &&
                sent.path.startsWith('/v1/me/ratings/updates/'),
            ),
            false,
          );
          assert.deepEqual(
            await recipient.runtime.ratingLikeUpdates.unread(recipient.cancel),
            { unreadCount: 0 },
          );
          await assert.rejects(
            recipient.runtime.ratingUpdates.target(
              notice.noticeId,
              recipient.cancel,
            ),
            serverFailure('NOTICE_NOT_FOUND'),
          );
          recipient.transport.beforeSend = null;
        }
        assert.deepEqual(await r.runtime.ratingUpdates.unread(r.cancel), {
          unreadCount: 1,
        });
        await assert.rejects(
          r.runtime.ratingLikeUpdates.target(replyNotice.noticeId, r.cancel),
          serverFailure('NOTICE_NOT_FOUND'),
        );
        const currentReply = a
          .threadView()
          .replies.find((item) => item.id === reply.id)!;
        assert.ok(currentReply);
        assert.equal('likeCount' in currentReply, false);
        assert.equal('liked' in currentReply, false);
        assert.equal('setLike' in currentReply.allowedActions, false);
      },
    );

    await t.test(
      'native gateway walks all four actual sort directions, keeps legacy cursors separate and rejects changed ordering heads',
      async () => {
        const roots: Content[] = [];
        for (let i = 0; i < 4; i++)
          roots.push(
            await f.publish(
              owner,
              catalog,
              sortTarget,
              f.body(catalog, sortTarget, { body: `Native ordered root ${i}` }),
            ),
          );
        const subjects = roots.map((row) => ({
          target: sortTarget,
          root: row,
          reply: null,
        }));
        await desired(a, subjects[0]!, true);
        await desired(p, subjects[0]!, true);
        await desired(a, subjects[2]!, true);
        const comments = (
          cursor: string | null,
          selection?: { sort: 'time' | 'likes'; order: 'asc' | 'desc' },
        ) =>
          a.runtime.ratings.comments(
            catalog.regionId,
            sortTarget.id,
            cursor,
            a.cancel,
            2,
            selection,
          ) as Promise<RatingCommentPage>;
        for (const sort of ['time', 'likes'] as const)
          for (const order of ['asc', 'desc'] as const) {
            const selection = { sort, order },
              start = a.transport.sent.length;
            const first = await comments(null, selection);
            assert.ok(first.nextCursor);
            const second = await comments(first.nextCursor, selection);
            assert.equal(second.nextCursor, null);
            assert.equal(second.continuation, 'end');
            const expected =
              sort === 'time'
                ? order === 'asc'
                  ? [0, 1, 2, 3]
                  : [3, 2, 1, 0]
                : order === 'asc'
                  ? [3, 1, 2, 0]
                  : [0, 2, 3, 1];
            assert.deepEqual(
              [...first.items, ...second.items].map((item) => item.id),
              expected.map((i) => roots[i]!.id),
            );
            assert.deepEqual(
              Object.keys(first).sort(),
              ['context', 'continuation', 'items', 'nextCursor'].sort(),
            );
            for (const item of [...first.items, ...second.items]) {
              assert.equal('liked' in item, false);
              assert.equal('likeCount' in item, false);
              assert.equal('setLike' in item.allowedActions, false);
            }
            for (const sent of a.transport.sent.slice(start)) {
              const url = new URL(sent.path, directoryNativeOrigin);
              assert.equal(url.searchParams.get('sort'), sort);
              assert.equal(url.searchParams.get('order'), order);
            }
            await assert.rejects(
              comments(first.nextCursor, {
                sort,
                order: order === 'asc' ? 'desc' : 'asc',
              }),
              serverFailure('DISCOVERY_RESTART_REQUIRED'),
            );
          }
        const legacyStart = a.transport.sent.length,
          legacy = await comments(null);
        assert.ok(legacy.nextCursor);
        assert.equal((await comments(legacy.nextCursor)).nextCursor, null);
        assert.ok(
          a.transport.sent
            .slice(legacyStart)
            .every((sent) => !/[?&](?:sort|order)=/.test(sent.path)),
        );
        await assert.rejects(
          comments(legacy.nextCursor, { sort: 'time', order: 'desc' }),
          serverFailure('DISCOVERY_RESTART_REQUIRED'),
        );
        const selection = { sort: 'likes', order: 'desc' } as const,
          before = await comments(null, selection);
        assert.ok(before.nextCursor);
        await desired(p, subjects[1]!, true);
        await assert.rejects(
          comments(before.nextCursor, selection),
          serverFailure('DISCOVERY_RESTART_REQUIRED'),
        );
        const restarted = await comments(null, selection);
        assert.deepEqual(
          restarted.items.map((item) => item.id),
          [roots[0]!.id, roots[2]!.id],
        );
        await a.rating.load({ targetId: sortTarget.id });
        await a.rating.selectSort('likes', 'asc');
        assert.equal(a.ratingView().loaded, true, a.ratingView().error);
        assert.equal(a.ratingView().commentSort, 'likes');
        assert.equal(a.ratingView().commentOrder, 'asc');
        assert.deepEqual(
          a.ratingView().comments.map((item) => item.id),
          [roots[3]!.id, roots[2]!.id, roots[1]!.id, roots[0]!.id],
        );
      },
    );

    await t.test(
      'real uncovered root and reply stay unavailable rather than zero; likes ordering fails closed while time recovers',
      async () => {
        // Narrow disposable-DB fault injection models a publication absent from
        // cutover. Normal HTTP publication, review, receipt and effect guards run.
        // No business facade or HTTP response is replaced and the trigger is restored.
        await f.pool.query(
          'ALTER TABLE whaleu_community.rating_approval_bindings DISABLE TRIGGER rating_like_native_publication',
        );
        let uncoveredRoot: Content, uncoveredReply: Content;
        try {
          uncoveredRoot = await f.publish(owner, catalog, unknownTarget);
          uncoveredReply = await f.publishReply(
            replyOwner,
            catalog,
            unknownTarget,
            uncoveredRoot,
          );
        } finally {
          await f.pool.query(
            'ALTER TABLE whaleu_community.rating_approval_bindings ENABLE TRIGGER rating_like_native_publication',
          );
        }
        const uncovered: Subject = {
          target: unknownTarget,
          root: uncoveredRoot!,
          reply: null,
        };
        assert.deepEqual(await current(a, uncovered), {
          status: 'unavailable',
        });
        assert.deepEqual(
          await current(a, { ...uncovered, reply: uncoveredReply! }),
          { status: 'unavailable' },
        );
        await a.thread.load({
          targetId: unknownTarget.id,
          rootId: uncoveredRoot!.id,
        });
        assert.equal(a.threadView().loaded, true, a.threadView().error);
        assert.deepEqual(a.threadView().likes, {
          [uncoveredRoot!.id]: { status: 'unavailable' },
          [uncoveredReply!.id]: { status: 'unavailable' },
        });
        const start = a.transport.sent.length;
        await a.thread.toggleLike(uncoveredRoot!.id);
        await a.thread.toggleLike(uncoveredReply!.id);
        assert.equal(a.transport.sent.length, start);
        assert.equal(a.runtime.pendingRatings.load(liker.accountId), null);
        await assert.rejects(
          a.runtime.ratings.comments(
            catalog.regionId,
            unknownTarget.id,
            null,
            a.cancel,
            20,
            { sort: 'likes', order: 'desc' },
          ),
          serverFailure('RATING_UNAVAILABLE'),
        );
        // This controller was previously sorted by likes on another target.
        await a.rating.selectSort('time', 'asc');
        await a.rating.load({ targetId: unknownTarget.id });
        assert.equal(a.ratingView().loaded, true, a.ratingView().error);
        await a.rating.selectSort('likes', 'desc');
        assert.equal(a.ratingView().loaded, false);
        assert.deepEqual(a.ratingView().comments, []);
        assert.deepEqual(a.ratingView().likes, {});
        await a.rating.selectSort('time', 'asc');
        assert.equal(a.ratingView().loaded, true, a.ratingView().error);
        assert.deepEqual(
          a.ratingView().comments.map((item) => item.id),
          [uncoveredRoot!.id],
        );
        assert.deepEqual(a.ratingView().likes[uncoveredRoot!.id], {
          status: 'unavailable',
        });
      },
    );
    for (const key of [
      'rootLikeState',
      'replyLikeState',
      'rootLikeReceipt',
      'replyLikeReceipt',
      'unavailableLikeState',
      'likeUpdatesPage',
      'rootLikeNoticeTarget',
      'replyLikeNoticeTarget',
      'sortedCommentPage',
    ])
      assert.ok(golden[key], `Missing actual HTTP golden: ${key}`);
    // Public wire snapshots only, for independent native decoder regression.
    // No request journals, credentials, account IDs or internal effect records.
    await writeFile(
      '/tmp/whaleu-r2b-http-golden.json',
      `${JSON.stringify(golden, null, 2)}\n`,
      { mode: 0o600 },
    );
  },
);
