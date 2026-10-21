/** Source Page + real client/decoder/transport-spy evidence only; not Tencent/device proof. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { ClientError } from '../src/api/errors';
import { HttpSystemNoticesGateway } from '../src/community/system-notices-gateway';
import { systemClock } from '../src/platform/clock';
import type { HttpRequest, HttpResponse } from '../src/platform/contracts';
import type { NoticeExposureObserver } from '../src/notifications/notice-exposure';
import type { SocialNoticesView } from '../src/pages/social-notices/controller';
import type { SystemTimelineView } from '../src/notifications/system-timeline';
import { FakeClock, flush, response, deferred } from './helpers';
import { systemNoticesSetup, systemNotices } from './system-notices-helpers';
import {
  noticeId,
  socialPage,
  socialRead,
  socialResolution,
} from './social-updates-helpers';
import type { SocialUpdateCategory } from '../src/notifications/social-updates/contract';
import { nativeObservation } from './notice-exposure-helpers';
import { HttpCommunityGateway } from '../src/community/gateway';
import { HttpFeedbackNoticesGateway } from '../src/community/feedback-notices-gateway';
import { HttpErrandNoticesGateway } from '../src/errands/notices';
import { HttpRatingUpdatesGateway } from '../src/ratings/updates-gateway';
import { HttpRatingLikeUpdatesGateway } from '../src/ratings/like-updates-gateway';
import { HttpRatingSubscriptionUpdatesGateway } from '../src/ratings/subscription-updates-gateway';
import { HttpWindowDiscussionGateway } from '../src/window-discussion/gateway';
import { HttpMajorDiscussionGateway } from '../src/major-discussion/gateway';
import { HttpWindowDiscussionV2Gateway } from '../src/window-discussion/v2-gateway';
import { HttpMajorDiscussionV2Gateway } from '../src/major-discussion/v2-gateway';
import { WINDOW_DISCUSSION_V2 } from '../src/window-discussion/v2-contract';
import { MAJOR_DISCUSSION_V2 } from '../src/major-discussion/v2-contract';
import { SafetyChanges } from '../src/community/safety-changes';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { updates } from './updates-helpers';
import { notice as ratingNotice } from './ratings-r2a-helpers';
import { likeNotice } from './ratings-r2b-helpers';
import { subscriptionNotice } from './ratings-r2c-helpers';
import { notice as windowNotice } from './window-discussion-helpers';
import { notice as majorNotice } from './major-discussion-helpers';
import type { SocialNoticeKind } from '../src/pages/social-notices/contract';

type PageName = 'social-notices' | 'system-notices';
interface PageInstance {
  data: SocialNoticesView &
    SystemTimelineView & { showCoverage: boolean; showSources: boolean };
  onLoad?(query: unknown): void;
  onShow(): void | Promise<void>;
  onHide(): void;
  onUnload(): void;
  onCoverage(): void;
  onSources(): void;
  onOpen(event: unknown): void;
  onRead(event: unknown): void;
  onMore(event: unknown): void;
  onCancel(): void;
  renderNotices(view: unknown): void;
  noticeExposure: NoticeExposureObserver;
  controller: { snapshot(): unknown };
}
const requireNative = createRequire(__filename);
function fixture(
  name: PageName,
  observerAvailable = true,
  options: { kind?: SocialNoticeKind; allSources?: boolean; v2?: boolean } = {},
) {
  const h = systemNoticesSetup();
  const native = nativeObservation();
  const clock = new FakeClock();
  const requests: HttpRequest[] = [];
  let failRead = false;
  let readFailure: ClientError | undefined;
  let expiredRead = false;
  let verificationRead = false;
  const discussionReads = new Set<string>();
  let refreshes = 0;
  let refreshWait: ReturnType<typeof deferred<void>> | undefined;
  let refreshed = false;
  const kind = options.kind ?? 'likes';
  const receipt = {
    noticeId,
    readAt: '2026-10-20T10:05:00.123Z',
    unreadCount: 6,
  };
  const list = (items: unknown[]) => ({
    items,
    nextCursor: null,
    unreadCount: 7,
  });
  let deferredRead: ReturnType<typeof deferred<HttpResponse>> | undefined;
  let transportQueued: (() => void) | undefined;
  const api = new ApiClient(
    'https://fictional-native-exposure.example',
    {
      async send(request) {
        requests.push(request);
        const url = new URL(request.url);
        const category = url.searchParams.get(
          'category',
        ) as SocialUpdateCategory;
        if (request.method !== 'GET') {
          if (deferredRead) return deferredRead.promise;
          if (expiredRead) {
            expiredRead = false;
            return response({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401);
          }
          if (failRead)
            throw (
              readFailure ??
              new ClientError('network', 'Unknown synthetic outcome')
            );
          if (url.pathname.includes('/student-verification/')) {
            verificationRead = true;
            return response({ status: 'unavailable', target: null });
          }
          if (/\/(window|major)-discussion\//.test(url.pathname)) {
            discussionReads.add(
              url.pathname.slice(0, url.pathname.lastIndexOf(`/${noticeId}`)),
            );
            return response({ noticeId, readAt: receipt.readAt });
          }
          return response(
            url.pathname.includes('/social-updates/') ? socialRead() : receipt,
          );
        }
        if (url.pathname === '/v1/me/student-verification/notices')
          return response({
            items: options.allSources
              ? [
                  {
                    id: noticeId,
                    kind: 'auth_result',
                    outcome: 'approved',
                    createdAt: '2026-10-01T00:00:00.000Z',
                    read: verificationRead,
                    available: false,
                  },
                ]
              : [],
            page: 1,
            hasNext: false,
          });
        if (url.pathname === '/v1/me/errand-notices')
          return response(
            list([
              {
                noticeId,
                kind: 'completed',
                orderId: noticeId,
                createdAt: '2026-10-01T00:00:00.000Z',
                readAt: null,
              },
            ]),
          );
        if (url.pathname === '/v1/me/feedback-notices')
          return response(
            list([
              {
                noticeId,
                kind: 'feedback_created',
                createdAt: '2026-10-01T00:00:00.000Z',
                readAt: null,
              },
            ]),
          );
        if (url.pathname === '/v1/me/community/updates')
          return response(updates());
        if (url.pathname === '/v1/me/ratings/updates')
          return response(list([ratingNotice({ noticeId })]));
        if (url.pathname === '/v1/me/ratings/like-updates')
          return response(list([likeNotice({ noticeId })]));
        if (url.pathname === '/v1/me/ratings/subscription-updates')
          return response(list([subscriptionNotice({ noticeId })]));
        if (
          /^\/v[12]\/me\/(window|major)-discussion\/notices$/.test(url.pathname)
        ) {
          const isWindow = url.pathname.includes('window');
          const item = isWindow ? windowNotice() : majorNotice();
          assert.equal(item.status, 'available');
          if (item.status !== 'available')
            throw Error('Fixture requires available notice');
          const rows = [
            {
              ...item,
              noticeId,
              readAt: discussionReads.has(url.pathname) ? receipt.readAt : null,
              kind: kind === 'likes' ? 'like' : 'reply',
              preview: {
                ...item.preview,
                ...(options.v2 ? { thumbnail: null } : {}),
              },
            },
          ];
          return response({
            ...list(rows),
            ...(options.v2
              ? {
                  protocol: isWindow
                    ? WINDOW_DISCUSSION_V2
                    : MAJOR_DISCUSSION_V2,
                }
              : {}),
          });
        }
        if (url.pathname === '/v1/me/system-notices')
          return response(systemNotices());
        if (url.pathname.endsWith('/target'))
          return response(socialResolution(category));
        assert.equal(url.pathname, '/v1/me/social-updates');
        return response(socialPage(category));
      },
    },
    h.sessions,
    {
      async refresh(ticket) {
        refreshes++;
        assert.ok(refreshWait, 'No unconfigured credential acquisition');
        await refreshWait.promise;
        const result = h.sessions.rotate(ticket, {
          ...ticket.credentials!,
          accessToken: 'synthetic-refreshed',
        });
        refreshed = true;
        return result;
      },
    },
  );
  const originalRequest = api.request.bind(api);
  api.request = ((endpoint, options) => {
    const pending = originalRequest(endpoint, options);
    if (endpoint.method !== 'GET') transportQueued?.();
    return pending;
  }) as ApiClient['request'];
  const runtime = {
    ...h.runtime,
    systemNotices: new HttpSystemNoticesGateway(api),
    safetyChanges: new SafetyChanges(),
    browsingScopeChanges: new PrivateViewLifecycle(),
    directoryScopeChanges: new PrivateViewLifecycle(),
    ...(options.allSources
      ? {
          gateway: new HttpCommunityGateway(api),
          feedbackNotices: new HttpFeedbackNoticesGateway(api),
          errandNotices: new HttpErrandNoticesGateway(api),
          ratingUpdates: new HttpRatingUpdatesGateway(api),
          ratingLikeUpdates: new HttpRatingLikeUpdatesGateway(api),
          ratingSubscriptionUpdates: new HttpRatingSubscriptionUpdatesGateway(
            api,
          ),
          windowDiscussion: new HttpWindowDiscussionGateway(api),
          majorDiscussion: new HttpMajorDiscussionGateway(api),
          ...(options.v2
            ? {
                windowDiscussionV2: new HttpWindowDiscussionV2Gateway(api),
                majorDiscussionV2: new HttpMajorDiscussionV2Gateway(api),
              }
            : {}),
        }
      : {}),
  };
  const previous = {
    wx: Reflect.get(globalThis, 'wx'),
    Page: Reflect.get(globalThis, 'Page'),
    getApp: Reflect.get(globalThis, 'getApp'),
    now: systemClock.now,
    schedule: systemClock.schedule,
  };
  Object.assign(systemClock, {
    now: () => clock.now(),
    schedule: clock.schedule.bind(clock),
  });
  let definition: object | undefined;
  Object.assign(globalThis, {
    wx: {
      ...(observerAvailable ? native.wx : {}),
      navigateTo: (options: { success(): void }) => options.success(),
      stopPullDownRefresh() {},
    },
    Page: (value: object) => {
      definition = value;
    },
    getApp: () => ({
      community: runtime,
      identity: { sessions: h.sessions, api },
    }),
  });
  const file = path.resolve(__dirname, `../src/pages/${name}/${name}.ts`);
  delete requireNative.cache[requireNative.resolve(file)];
  requireNative(file);
  assert.ok(definition);
  const page = {
    ...definition,
    setData(this: PageInstance, patch: object, callback?: () => void) {
      Object.assign(this.data, structuredClone(patch));
      callback?.();
    },
  } as unknown as PageInstance;
  page.data = structuredClone(page.data);
  page.onLoad?.({ kind });
  const shown = page.onShow();
  const idle = async () => {
    await shown;
    for (let i = 0; i < 8; i++) await flush();
    native.tick();
  };
  const writes = () => requests.filter((r) => r.method !== 'GET');
  const target = (source: string) => {
    const matches = native.observers.filter(
      (o) => !o.disconnected && o.selector.includes(`-${source}-${noticeId}`),
    );
    return matches[matches.length - 1]!;
  };
  return {
    ...h,
    runtime,
    api,
    page,
    native,
    clock,
    requests,
    writes,
    idle,
    target,
    failRead(value: boolean) {
      failRead = value;
      readFailure = undefined;
    },
    rejectRead(error: ClientError) {
      failRead = true;
      readFailure = error;
    },
    queueHook(value: () => void) {
      transportQueued = value;
    },
    expireRead() {
      expiredRead = true;
      refreshWait = deferred<void>();
      return refreshWait;
    },
    refreshes: () => refreshes,
    refreshed: () => refreshed,
    deferRead() {
      deferredRead = deferred<HttpResponse>();
      return deferredRead;
    },
    close() {
      page.onUnload();
      Object.assign(systemClock, {
        now: previous.now,
        schedule: previous.schedule,
      });
      for (const key of ['wx', 'Page', 'getApp'] as const) {
        if (previous[key] === undefined)
          Reflect.deleteProperty(globalThis, key);
        else Reflect.set(globalThis, key, previous[key]);
      }
    },
  };
}
const event = (id: string) => ({ currentTarget: { dataset: { id } } });

for (const name of ['social-notices', 'system-notices'] as const) {
  const source = name === 'social-notices' ? 'community-like' : 'system';
  test(`${name}: actual Page commits exact namespaced row; only native dwell calls source-owned endpoint`, async () => {
    const h = fixture(name);
    try {
      await h.idle();
      assert.equal(h.writes().length, 0);
      const target = h.target(source);
      assert.ok(target);
      assert.ok(!target.selector.includes(':'));
      h.clock.advance(10000);
      await h.idle();
      assert.equal(h.writes().length, 0, 'offscreen rendering does not read');
      target.emit(1);
      h.clock.advance(999);
      await h.idle();
      assert.equal(h.writes().length, 0);
      h.clock.advance(1);
      await h.idle();
      assert.equal(h.writes().length, 1);
      const request = h.writes()[0]!;
      assert.equal(request.method, 'PUT');
      assert.deepEqual(request.body, {});
      const url = new URL(request.url);
      assert.equal(
        url.pathname,
        `/v1/me/${name === 'social-notices' ? 'social-updates' : 'system-notices'}/${noticeId}/read`,
      );
      assert.equal(
        url.searchParams.get('category'),
        name === 'social-notices' ? 'likes' : null,
      );
      if (name === 'social-notices') {
        assert.equal(
          h.page.data.rows.find((r) => r.source === 'community-like')!.unread,
          false,
        );
        assert.equal(
          h.page.data.rows.find((r) => r.source === 'community-save')!.unread,
          true,
        );
        assert.equal('unreadCount' in h.page.data, false);
      } else {
        assert.equal(h.page.data.items[0]!.readAt, '2026-10-20T10:05:00.123Z');
        assert.equal(h.page.data.unreadCount, null);
      }
    } finally {
      h.close();
    }
  });
  for (const gap of ['leaf', 'transport'] as const)
    test(`${name}: ${gap} microtask gap rechecks exposure before actual mutation dispatch`, async () => {
      const h = fixture(name);
      try {
        await h.idle();
        if (gap === 'transport')
          h.queueHook(() => h.page.noticeExposure.clear());
        h.target(source).emit(1);
        h.clock.advance(1000);
        if (gap === 'leaf') {
          await Promise.resolve();
          h.page.noticeExposure.clear();
        }
        await h.idle();
        assert.equal(h.writes().length, 0);
      } finally {
        h.close();
      }
    });
  test(`${name}: unchanged own busy render preserves qualification, changed exact row body does not`, async () => {
    const h = fixture(name);
    try {
      await h.idle();
      h.queueHook(() => {
        const view = structuredClone(
          h.page.controller.snapshot(),
        ) as SocialNoticesView & SystemTimelineView;
        h.page.renderNotices(
          name === 'social-notices'
            ? {
                ...view,
                rows: view.rows.map((r) => ({
                  ...r,
                  preview: 'changed while queued',
                })),
              }
            : {
                ...view,
                items: view.items.map((r) => ({
                  ...r,
                  summary: 'changed while queued',
                })),
              },
        );
      });
      h.target(source).emit(1);
      h.clock.advance(1000);
      await h.idle();
      assert.equal(h.writes().length, 0);
    } finally {
      h.close();
    }
  });
  test(`${name}: unknown exposure read stays unread without automatic retry; explicit fallback still reconciles`, async () => {
    const h = fixture(name);
    try {
      await h.idle();
      h.failRead(true);
      h.target(source).emit(1);
      h.clock.advance(1000);
      await h.idle();
      assert.equal(h.writes().length, 1);
      if (name === 'social-notices')
        assert.equal(
          h.page.data.rows.find((r) => r.source === source)!.unread,
          true,
        );
      else assert.equal(h.page.data.items[0]!.readAt, null);
      for (const observer of h.native.observers.filter((o) =>
        o.selector.includes(`-${source}-`),
      ))
        observer.emit(1);
      h.clock.advance(10000);
      await h.idle();
      assert.equal(h.writes().length, 1);
      h.failRead(false);
      h.page.onRead(event(`${source}:${noticeId}`));
      await h.idle();
      assert.equal(h.writes().length, 2);
    } finally {
      h.close();
    }
  });
  test(`${name}: absent native observer remains manual-only`, async () => {
    const h = fixture(name, false);
    try {
      await h.idle();
      h.clock.advance(10000);
      await h.idle();
      assert.equal(h.writes().length, 0);
      h.page.onRead(event(`${source}:${noticeId}`));
      await h.idle();
      assert.equal(h.writes().length, 1);
    } finally {
      h.close();
    }
  });
  test(`${name}: hide after send discards late receipt without pretending the mutation was rolled back`, async () => {
    const h = fixture(name);
    try {
      await h.idle();
      const pending = h.deferRead();
      h.target(source).emit(1);
      h.clock.advance(1000);
      await h.idle();
      assert.equal(h.writes().length, 1);
      h.page.onHide();
      pending.resolve(response(socialRead()));
      await flush();
      assert.equal(h.page.data.rows?.length ?? h.page.data.items.length, 0);
      assert.equal(h.writes().length, 1);
    } finally {
      h.close();
    }
  });
}

test('social open/navigation remains read-free without dwell and disclosure changes reset elapsed exposure', async () => {
  const h = fixture('social-notices');
  try {
    await h.idle();
    h.page.onOpen(event(`community-like:${noticeId}`));
    await h.idle();
    assert.equal(h.writes().length, 0);
    h.target('community-like').emit(1);
    h.clock.advance(900);
    h.page.onCoverage();
    await h.idle();
    h.clock.advance(1000);
    await h.idle();
    assert.equal(h.writes().length, 0);
    h.target('community-like').emit(1);
    h.clock.advance(1000);
    await h.idle();
    assert.equal(h.writes().length, 1);
  } finally {
    h.close();
  }
});

const sourceCases: readonly {
  source: string;
  name: PageName;
  kind?: SocialNoticeKind;
  base: string;
  category?: SocialUpdateCategory;
  v2?: boolean;
}[] = [
  {
    source: 'community-like',
    name: 'social-notices',
    kind: 'likes',
    base: '/v1/me/social-updates',
    category: 'likes',
  },
  {
    source: 'community-save',
    name: 'social-notices',
    kind: 'likes',
    base: '/v1/me/social-updates',
    category: 'saves',
  },
  {
    source: 'follower',
    name: 'social-notices',
    kind: 'followers',
    base: '/v1/me/social-updates',
    category: 'followers',
  },
  {
    source: 'community',
    name: 'social-notices',
    kind: 'comments',
    base: '/v1/me/community/updates',
  },
  {
    source: 'rating-like',
    name: 'social-notices',
    kind: 'likes',
    base: '/v1/me/ratings/like-updates',
  },
  {
    source: 'rating-reply',
    name: 'social-notices',
    kind: 'comments',
    base: '/v1/me/ratings/updates',
  },
  {
    source: 'rating-subscription',
    name: 'social-notices',
    kind: 'comments',
    base: '/v1/me/ratings/subscription-updates',
  },
  ...(['likes', 'comments'] as const).flatMap((kind) =>
    ([false, true] as const).flatMap((v2) =>
      (['window', 'major'] as const).map((source) => ({
        source,
        name: 'social-notices' as const,
        kind,
        v2,
        base: `/v${v2 ? 2 : 1}/me/${source}-discussion/notices`,
      })),
    ),
  ),
  { source: 'system', name: 'system-notices', base: '/v1/me/system-notices' },
  { source: 'errand', name: 'system-notices', base: '/v1/me/errand-notices' },
  {
    source: 'feedback',
    name: 'system-notices',
    base: '/v1/me/feedback-notices',
  },
  {
    source: 'verification',
    name: 'system-notices',
    base: '/v1/me/student-verification/notices',
  },
];
for (const item of sourceCases)
  for (const stale of [false, true])
    test(`actual Page ${item.source}/${item.kind ?? 'system'}/${item.v2 ? 'v2' : 'v1'}: ${stale ? 'queued stale lease sends nothing' : 'dwell reaches only the owning real HTTP endpoint'}`, async () => {
      const h = fixture(item.name, true, {
        allSources: true,
        ...(item.kind ? { kind: item.kind } : {}),
        ...(item.v2 ? { v2: true } : {}),
      });
      try {
        await h.idle();
        assert.equal(h.writes().length, 0);
        const target = h.target(item.source);
        assert.ok(target, JSON.stringify(h.page.data));
        if (stale) h.queueHook(() => h.page.noticeExposure.clear());
        target.emit(0.5);
        h.clock.advance(1000);
        await h.idle();
        assert.equal(h.writes().length, stale ? 0 : 1);
        if (stale) return;
        const request = h.writes()[0]!;
        assert.equal(
          new URL(request.url).pathname,
          `${item.base}/${noticeId}/read`,
        );
        assert.equal(
          new URL(request.url).searchParams.get('category'),
          item.category ?? null,
        );
        assert.equal(
          request.method,
          item.source === 'verification' ? 'POST' : 'PUT',
        );
        assert.deepEqual(request.body, {});
        assert.ok(request.headers.Authorization);
        if (item.name === 'social-notices') {
          assert.equal(
            h.page.data.rows.find((r) => r.source === item.source)?.unread,
            false,
          );
          assert.ok(
            h.page.data.rows
              .filter((r) => r.source !== item.source)
              .every((r) => r.unread),
          );
          assert.equal('unreadCount' in h.page.data, false);
        } else {
          assert.notEqual(
            h.page.data.items.find((r) => r.source === item.source)?.readAt,
            null,
          );
          assert.ok(
            h.page.data.items
              .filter((r) => r.source !== item.source)
              .every((r) => r.readAt === null),
          );
          assert.equal(h.page.data.unreadCount, null);
        }
      } finally {
        h.close();
      }
    });

for (const name of ['social-notices', 'system-notices'] as const) {
  const source = name === 'social-notices' ? 'community-like' : 'system';
  for (const boundary of [
    'loading',
    'source-error',
    'safety',
    'browse',
    'directory',
    'account',
    'hide',
    'reset',
  ] as const)
    test(`${name}: actual queued transport rejects ${boundary} boundary`, async () => {
      const h = fixture(name);
      try {
        await h.idle();
        h.queueHook(() => {
          if (boundary === 'loading' || boundary === 'source-error') {
            const view = h.page.controller.snapshot() as SocialNoticesView &
              SystemTimelineView;
            h.page.renderNotices(
              boundary === 'loading'
                ? { ...view, loaded: false, busy: true }
                : {
                    ...view,
                    sources: view.sources.map((s) => ({
                      ...s,
                      error: 'source unavailable',
                    })),
                  },
            );
          } else if (boundary === 'safety')
            h.runtime.safetyChanges.invalidate(h.accountId);
          else if (boundary === 'browse')
            h.runtime.browsingScopeChanges.clear(h.accountId);
          else if (boundary === 'directory')
            h.runtime.directoryScopeChanges.clear(h.accountId);
          else if (boundary === 'account') h.sessions.logout();
          else if (boundary === 'hide') h.page.onHide();
          else h.page.onCancel();
        });
        h.target(source).emit(1);
        h.clock.advance(1000);
        await h.idle();
        assert.equal(h.writes().length, 0);
      } finally {
        h.close();
      }
    });
  for (const boundary of [
    'valid',
    'exit-during-refresh',
    'replay-microtask',
  ] as const)
    test(`${name}: auth replay ${boundary} rechecks the exact lease in unchanged ApiClient`, async () => {
      const h = fixture(name);
      try {
        await h.idle();
        const wait = h.expireRead();
        const target = h.target(source);
        target.emit(1);
        h.clock.advance(1000);
        await h.idle();
        assert.equal(
          h.writes().length,
          1,
          'first transport returned definite authentication rejection',
        );
        assert.equal(h.refreshes(), 1);
        if (boundary === 'exit-during-refresh') target.emit(0);
        if (boundary === 'replay-microtask') {
          const assertCurrent = h.sessions.assertCurrent.bind(h.sessions);
          let queued = false;
          h.sessions.assertCurrent = (ticket) => {
            assertCurrent(ticket);
            if (h.refreshed() && !queued) {
              queued = true;
              queueMicrotask(() => target.emit(0));
            }
          };
        }
        wait.resolve(undefined);
        await h.idle();
        assert.equal(h.writes().length, boundary === 'valid' ? 2 : 1);
        assert.equal(h.refreshes(), 1);
        if (boundary === 'valid')
          assert.equal(
            h.writes()[1]!.headers.Authorization,
            'Bearer synthetic-refreshed',
          );
        else {
          target.emit(1);
          h.clock.advance(10000);
          await h.idle();
          assert.equal(
            h.writes().length,
            1,
            'invalid attempt cannot revive after reentry',
          );
        }
      } finally {
        h.close();
      }
    });
  test(`${name}: post-send viewport loss discards unproven local receipt without another mutation`, async () => {
    const h = fixture(name);
    try {
      await h.idle();
      const pending = h.deferRead();
      const target = h.target(source);
      target.emit(1);
      h.clock.advance(1000);
      await h.idle();
      assert.equal(
        h.writes().length,
        1,
        'transport already dispatched; cannot claim rollback',
      );
      target.emit(0);
      pending.resolve(
        response(
          name === 'social-notices'
            ? socialRead()
            : {
                noticeId,
                readAt: '2026-10-20T10:05:00.123Z',
                unreadCount: 6,
              },
        ),
      );
      await h.idle();
      if (name === 'social-notices')
        assert.equal(
          h.page.data.rows.find((r) => r.source === source)?.unread,
          true,
        );
      else
        assert.equal(
          h.page.data.items.find((r) => r.source === source)?.readAt,
          null,
        );
      target.emit(1);
      h.clock.advance(10000);
      await h.idle();
      assert.equal(h.writes().length, 1);
    } finally {
      h.close();
    }
  });
}

const uncertainSources = sourceCases.filter((item) =>
  [
    'verification',
    'rating-like',
    'rating-reply',
    'rating-subscription',
  ].includes(item.source),
);
for (const item of uncertainSources) {
  for (const outcome of [
    'network',
    'timeout',
    'pre-dispatch-cancelled',
    'post-send-cancelled',
  ] as const)
    test(`${item.source}: guarded ${outcome} retains exact unread row and manual fallback without replay`, async () => {
      const h = fixture(item.name, true, {
        allSources: true,
        ...(item.kind ? { kind: item.kind } : {}),
      });
      try {
        await h.idle();
        const row = () =>
          item.name === 'social-notices'
            ? h.page.data.rows.find((r) => r.source === item.source)
            : h.page.data.items.find((r) => r.source === item.source);
        const previous = structuredClone(row());
        assert.ok(previous);
        const target = h.target(item.source);
        const pending =
          outcome === 'post-send-cancelled' ? h.deferRead() : undefined;
        if (outcome === 'network' || outcome === 'timeout')
          h.rejectRead(
            new ClientError(outcome, 'Unknown synthetic transport outcome'),
          );
        if (outcome === 'pre-dispatch-cancelled')
          h.queueHook(() => target.emit(0));
        target.emit(1);
        h.clock.advance(1000);
        await h.idle();
        assert.equal(
          h.writes().length,
          outcome === 'pre-dispatch-cancelled' ? 0 : 1,
        );
        if (pending) {
          target.emit(0);
          pending.resolve(
            response(
              item.source === 'verification'
                ? { status: 'unavailable', target: null }
                : {
                    noticeId,
                    readAt: '2026-10-20T10:05:00.123Z',
                    unreadCount: 6,
                  },
            ),
          );
          await h.idle();
        }
        assert.ok(row(), 'retain manual fallback for the authorized exact row');
        const { observationId: _before, ...before } =
          previous as typeof previous & { observationId: string };
        const { observationId: _after, ...after } = row() as typeof previous & {
          observationId: string;
        };
        void _before;
        void _after;
        assert.deepEqual(
          after,
          before,
          'do not invent readAt or alter committed content',
        );
        const sources: readonly (
          | SocialNoticesView['sources'][number]
          | SystemTimelineView['sources'][number]
        )[] = h.page.data.sources;
        const source = sources.find(
          (s) => ('key' in s ? s.key : s.source) === item.source,
        );
        assert.ok(source?.loaded);
        assert.match(source.error, /未确认/);
        if (item.source === 'verification') {
          assert.equal('hasUnread' in source && source.hasUnread, true);
          assert.equal(h.page.data.unreadCount, null);
        }
        const beforeRetry = h.writes().length;
        for (const native of h.native.observers.filter((o) =>
          o.selector.includes(`-${item.source}-${noticeId}`),
        ))
          native.emit(1);
        h.clock.advance(10000);
        await h.idle();
        assert.equal(h.writes().length, beforeRetry, 'no exposure retry');
        h.failRead(false);
        h.queueHook(() => undefined);
        h.page.onRead(event(`${item.source}:${noticeId}`));
        await h.idle();
        assert.equal(
          h.writes().length,
          beforeRetry + 1,
          'manual fallback remains usable',
        );
      } finally {
        h.close();
      }
    });
  for (const denial of [
    new ClientError('auth-required', 'Owner login required'),
    new ClientError('auth-expired', 'Owner authentication expired'),
    new ClientError('forbidden', 'Denied', {
      httpStatus: 403,
      serverCode: 'AUTHORIZATION_REQUIRED',
    }),
    new ClientError('http', 'Safety denied', {
      httpStatus: 403,
      serverCode: 'SAFETY_ACCESS_SUSPENDED',
    }),
    new ClientError('protocol', 'Untrusted response'),
    new ClientError('business', 'Visibility lost', {
      httpStatus: 404,
      serverCode: 'NOTICE_NOT_FOUND',
    }),
    new ClientError('network', 'Not transport-only', {
      httpStatus: 403,
      serverCode: 'AUTHORIZATION_REQUIRED',
    }),
  ])
    test(`${item.source}: guarded ${denial.kind}/${denial.details.serverCode ?? 'malformed'} still clears denied snapshots`, async () => {
      const h = fixture(item.name, true, {
        allSources: true,
        ...(item.kind ? { kind: item.kind } : {}),
      });
      try {
        await h.idle();
        h.rejectRead(denial);
        h.target(item.source).emit(1);
        h.clock.advance(1000);
        await h.idle();
        assert.equal(h.writes().length, 1);
        assert.equal(
          item.name === 'social-notices'
            ? h.page.data.rows.some((r) => r.source === item.source)
            : h.page.data.items.some((r) => r.source === item.source),
          false,
        );
      } finally {
        h.close();
      }
    });
  test(`${item.source}: unguarded manual unknown behavior is unchanged`, async () => {
    const h = fixture(item.name, true, {
      allSources: true,
      ...(item.kind ? { kind: item.kind } : {}),
    });
    try {
      await h.idle();
      h.failRead(true);
      h.page.onRead(event(`${item.source}:${noticeId}`));
      await h.idle();
      assert.equal(h.writes().length, 1);
      assert.equal(
        item.name === 'social-notices'
          ? h.page.data.rows.some((r) => r.source === item.source)
          : h.page.data.items.some((r) => r.source === item.source),
        false,
      );
    } finally {
      h.close();
    }
  });
}
