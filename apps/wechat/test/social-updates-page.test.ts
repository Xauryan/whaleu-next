import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import type { ApiClient } from '../src/api/client';
import type { Credentials, SessionStore } from '../src/auth/session';
import type { CommunityRuntime } from '../src/community/runtime';
import type {
  SocialUpdateCategory,
  SocialUpdatesPage,
} from '../src/notifications/social-updates/contract';
import type {
  SocialNoticeKind,
  SocialNoticesView,
} from '../src/pages/social-notices/controller';
import type {
  HttpRequest,
  HttpResponse,
  Transport,
} from '../src/platform/contracts';
import { deferred, flush, response } from './helpers';
import { wireCredentials } from './identity-helpers';
import { FakeRatingLikeUpdatesGateway } from './ratings-r2b-helpers';
import {
  noticeId,
  otherId,
  socialCreatedAt,
  socialCursor,
  socialNotice,
  socialPage,
  socialRead,
  socialReadAt,
  socialResolution,
} from './social-updates-helpers';
interface MountedSocialPage {
  page: {
    data: SocialNoticesView & { showCoverage: boolean };
    onLoad(query: unknown): void;
    onShow(): Promise<void>;
  };
  idle(): Promise<SocialNoticesView>;
  press(handler: string, dataset?: Record<string, string>): boolean;
  capture(
    handler: string,
    dataset?: Record<string, string>,
  ): { press(): boolean; detach(): void };
  show(): Promise<void>;
  hide(): void;
  unload(): void;
}
interface SocialJourney {
  mount(kind: SocialNoticeKind): MountedSocialPage;
  sessions: SessionStore;
  app: {
    identity: { sessions: SessionStore; api?: ApiClient };
    community: CommunityRuntime;
  };
  navigations: string[];
  storage: Map<string, unknown>;
  hideApp(): void;
  invalidateSafety(accountId: string): void;
  close(): void;
}
const { createSocialUpdatesJourney } = createRequire(__filename)(
  './social-updates-emitted-harness.mjs',
) as {
  createSocialUpdatesJourney(options: {
    dist: string;
    origin: string;
    credentials?: Credentials;
    transport: Transport;
    extension: 'ts';
  }): SocialJourney;
};
/** Fictional source-mode transport only. Real emitted/HTTP/PG acceptance supplies its own transport. */
function fixture() {
  const requests: HttpRequest[] = [];
  const pages = new Map<SocialUpdateCategory, SocialUpdatesPage>([
    ['likes', socialPage('likes', { nextCursor: socialCursor })],
    ['saves', socialPage('saves', { nextCursor: socialCursor })],
    ['followers', socialPage('followers')],
  ]);
  let override:
    ((request: HttpRequest) => Promise<HttpResponse> | undefined) | undefined;
  const transport: Transport = {
    async send(request) {
      requests.push(request);
      const overridden = override?.(request);
      if (overridden) return overridden;
      const url = new URL(request.url);
      const category = url.searchParams.get('category') as SocialUpdateCategory;
      assert.ok(
        pages.has(category),
        'Every social API request must have a real source category',
      );
      if (request.method === 'PUT') {
        assert.match(url.pathname, new RegExp(`/${noticeId}/read$`));
        assert.deepEqual(request.body, {});
        pages.set(category, {
          ...pages.get(category)!,
          items: [{ ...socialNotice(category), readAt: socialReadAt }],
        });
        return response(socialRead());
      }
      if (url.pathname.endsWith('/target'))
        return response(socialResolution(category));
      assert.equal(url.pathname, '/v1/me/social-updates');
      return response(
        url.searchParams.has('cursor')
          ? socialPage(category, { items: [socialNotice(category, otherId)] })
          : pages.get(category),
      );
    },
  };
  const journey = createSocialUpdatesJourney({
    dist: path.resolve(__dirname, '../src'),
    origin: 'https://fictional-source-social.example',
    credentials: wireCredentials(),
    transport,
    extension: 'ts',
  });
  return {
    requests,
    pages,
    journey,
    override: (value: typeof override) => {
      override = value;
    },
  };
}

test('source Page/F7 composes new like/save readers without removing rating owner or fabricating counts', async () => {
  const s = fixture();
  try {
    const rating = new FakeRatingLikeUpdatesGateway();
    Object.assign(s.journey.app.community, { ratingLikeUpdates: rating });
    const mounted = s.journey.mount('likes');
    await mounted.idle();
    assert.equal(mounted.page.data.rows.length, 3);
    assert.ok(
      mounted.page.data.rows.some((row) => row.source === 'rating-like'),
    );
    for (const source of ['community-like', 'community-save']) {
      const row = mounted.page.data.rows.find(
        (value) => value.id === `${source}:${noticeId}`,
      )!;
      assert.equal(row.unread, true);
      assert.equal(row.preview, '');
      assert.ok(!row.title.includes('虚构测试同学'), 'No invented actor label');
    }
    assert.ok(
      !mounted.page.data.coverage.includes('主题获赞与被收藏通知尚未接入'),
    );
    assert.equal('unreadCount' in mounted.page.data, false);
    assert.ok(
      mounted.page.data.sources.every((source) => !('unreadCount' in source)),
    );
    assert.equal(mounted.press('onMore', { source: 'community-like' }), true);
    await mounted.idle();
    assert.equal(
      mounted.page.data.rows.filter((row) => row.source === 'community-like')
        .length,
      2,
    );
    assert.equal(
      mounted.page.data.rows.filter((row) => row.source === 'community-save')
        .length,
      1,
    );
    assert.equal(rating.calls.length, 1);
    assert.deepEqual(
      s.requests.map((r) => new URL(r.url).searchParams.get('category')),
      ['likes', 'saves', 'likes'],
    );
    const like = `community-like:${noticeId}`;
    const save = `community-save:${noticeId}`;
    assert.equal(mounted.press('onOpen', { id: like }), true);
    await mounted.idle();
    assert.equal(s.requests.filter((r) => r.method === 'PUT').length, 0);
    assert.equal(
      mounted.page.data.rows.find((row) => row.id === like)?.unread,
      true,
    );
    assert.ok(!s.journey.navigations[0]?.includes('noticeId'));
    const read = mounted.capture('onRead', { id: save });
    assert.equal(read.press(), true);
    assert.equal(read.press(), false);
    await mounted.idle();
    assert.equal(read.press(), false);
    read.detach();
    const writes = s.requests.filter((r) => r.method === 'PUT');
    assert.equal(writes.length, 1);
    assert.equal(new URL(writes[0]!.url).searchParams.get('category'), 'saves');
    assert.equal(
      mounted.page.data.rows.find((row) => row.id === save)?.unread,
      false,
    );
    assert.equal(
      mounted.page.data.rows.find((row) => row.id === like)?.unread,
      true,
    );
    assert.equal(s.journey.storage.size, 0);
  } finally {
    s.journey.close();
  }
});
test('source Page/F7 real followers are named only by public DTO and open does not acknowledge', async () => {
  const s = fixture();
  try {
    const mounted = s.journey.mount('followers');
    await mounted.idle();
    assert.equal(mounted.page.data.unavailable, false);
    assert.equal(mounted.page.data.partial, false);
    assert.equal(mounted.page.data.rows[0]?.title, '虚构测试同学');
    assert.equal(mounted.page.data.rows[0]?.action, '关注了你');
    assert.equal(mounted.page.data.rows[0]?.preview, '');
    assert.ok(!mounted.page.data.coverage.includes('尚未接入'));
    assert.equal(mounted.press('onOpen', { id: `follower:${noticeId}` }), true);
    await mounted.idle();
    assert.deepEqual(s.journey.navigations, [
      `/pages/public-profile/public-profile?profileId=${otherId}`,
    ]);
    assert.equal(s.requests.filter((r) => r.method === 'PUT').length, 0);
    const encoded = JSON.stringify(mounted.page.data);
    for (const forbidden of [
      'accountId',
      'sessionId',
      'accessToken',
      'refreshToken',
      'profileId',
      'target',
      'actor',
      'email',
      'phone',
    ])
      assert.ok(!encoded.includes(forbidden));
    assert.equal(mounted.press('onRead', { id: `follower:${noticeId}` }), true);
    await mounted.idle();
    assert.equal(mounted.page.data.rows[0]?.unread, false);
  } finally {
    s.journey.close();
  }
});
test('source Page preserves neutral unavailable items and unknown coverage without authoritative empty/full claims', async () => {
  const s = fixture();
  try {
    s.pages.set(
      'followers',
      socialPage('followers', {
        items: [
          {
            noticeId,
            createdAt: socialCreatedAt,
            readAt: null,
            status: 'unavailable',
          },
        ],
        unreadCount: null,
        unreadCountStatus: 'unavailable',
      }),
    );
    const mounted = s.journey.mount('followers');
    await mounted.idle();
    assert.equal(mounted.page.data.partial, true);
    assert.equal(mounted.page.data.sources[0]?.coverageUnknown, true);
    assert.equal(mounted.page.data.rows[0]?.title, '消息暂不可查看');
    assert.equal(mounted.page.data.rows[0]?.action, '');
    assert.equal(
      mounted.press('onOpen', { id: `follower:${noticeId}` }),
      false,
    );
    assert.equal(mounted.press('onRead', { id: `follower:${noticeId}` }), true);
    await mounted.idle();
    assert.equal(s.requests.filter((r) => r.method === 'PUT').length, 1);
  } finally {
    s.journey.close();
  }
});
test('source Page isolates a failed social category and retains sibling success with contextual errors', async () => {
  const s = fixture();
  try {
    s.override((request) =>
      new URL(request.url).searchParams.get('category') === 'saves'
        ? Promise.resolve(
            response({ error: { code: 'SOCIAL_UPDATES_UNAVAILABLE' } }, 503),
          )
        : undefined,
    );
    const mounted = s.journey.mount('likes');
    await mounted.idle();
    assert.equal(mounted.page.data.rows.length, 1);
    assert.equal(mounted.page.data.rows[0]?.source, 'community-like');
    assert.match(
      mounted.page.data.sources.find(
        (source) => source.key === 'community-save',
      )!.error,
      /社区收藏/,
    );
    assert.match(mounted.page.data.error, /部分消息/);
  } finally {
    s.journey.close();
  }
});
for (const reason of [
  'hide',
  'unload',
  'app-hide',
  'logout',
  'same-account-login',
  'safety',
] as const) {
  test(`source Page/F7 ${reason} clears rows, stale controls and delayed HTTP`, async () => {
    const s = fixture();
    try {
      const mounted = s.journey.mount('followers');
      await mounted.idle();
      const staleRead = mounted.capture('onRead', {
        id: `follower:${noticeId}`,
      });
      const late = deferred<HttpResponse>();
      s.override(() => late.promise);
      assert.equal(mounted.press('onReload'), true);
      await flush();
      const activeRequest = s.requests[s.requests.length - 1]!;
      if (reason === 'hide') mounted.hide();
      else if (reason === 'unload') mounted.unload();
      else if (reason === 'app-hide') s.journey.hideApp();
      else if (reason === 'logout') s.journey.sessions.logout();
      else if (reason === 'same-account-login')
        s.journey.sessions.completeLogin(
          s.journey.sessions.beginLogin(),
          wireCredentials('b'),
        );
      else s.journey.invalidateSafety(wireCredentials().accountId);
      assert.equal(staleRead.press(), false);
      staleRead.detach();
      assert.equal(activeRequest.cancellation?.isCancelled, true);
      assert.deepEqual(mounted.page.data.rows, []);
      late.resolve(response(socialPage('followers')));
      await mounted.idle();
      await flush();
      assert.deepEqual(mounted.page.data.rows, []);
      assert.equal(s.requests.filter((r) => r.method === 'PUT').length, 0);
      assert.equal(s.journey.storage.size, 0);
    } finally {
      s.journey.close();
    }
  });
}
test('source Page rejects identity/community owner mismatch and guests, preserves missing-source messaging', async () => {
  for (const missing of ['api', 'mismatch', 'guest'] as const) {
    const s = fixture();
    try {
      if (missing === 'api') delete s.journey.app.identity.api;
      else if (missing === 'mismatch')
        Object.assign(s.journey.app.identity, { sessions: {} });
      else s.journey.sessions.logout();
      const mounted = s.journey.mount('followers');
      await mounted.idle();
      assert.equal(s.requests.length, 0);
      assert.equal(mounted.page.data.loaded, false);
      if (missing !== 'guest') {
        assert.equal(mounted.page.data.unavailable, true);
        assert.match(mounted.page.data.coverage, /尚未接入/);
      } else assert.equal(mounted.page.data.hasSession, false);
      assert.deepEqual(mounted.page.data.rows, []);
    } finally {
      s.journey.close();
    }
  }
});

for (const coverage of ['available', 'unavailable'] as const)
  test(`source Page/F7 preserves bounded empty scan pages with ${coverage} counts and advances only on each explicit More press`, async () => {
    const s = fixture();
    try {
      const next = 'y'.repeat(43);
      s.pages.set(
        'followers',
        socialPage('followers', {
          items: [],
          nextCursor: socialCursor,
          ...(coverage === 'available'
            ? { unreadCount: 1, unreadCountStatus: 'available' as const }
            : { unreadCount: null, unreadCountStatus: 'unavailable' as const }),
        }),
      );
      s.override((request) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        if (cursor === socialCursor)
          return Promise.resolve(
            response(
              socialPage('followers', {
                items: [],
                nextCursor: next,
                ...(coverage === 'available'
                  ? { unreadCount: 1, unreadCountStatus: 'available' as const }
                  : {
                      unreadCount: null,
                      unreadCountStatus: 'unavailable' as const,
                    }),
              }),
            ),
          );
        if (cursor === next)
          return Promise.resolve(
            response(
              socialPage('followers', {
                items: [
                  {
                    ...socialNotice('followers'),
                    createdAt: '2025-01-01T00:00:00.000001Z',
                  },
                ],
              }),
            ),
          );
        return undefined;
      });
      const mounted = s.journey.mount('followers');
      await mounted.idle();
      await flush();
      assert.deepEqual(mounted.page.data.rows, []);
      assert.equal(mounted.page.data.loaded, true);
      assert.equal(mounted.page.data.canMore, true);
      assert.equal(mounted.page.data.partial, true);
      assert.equal(
        s.requests.length,
        1,
        'Empty scan pages never trigger an automatic request loop',
      );
      assert.equal(mounted.press('onMore', { source: 'follower' }), true);
      await mounted.idle();
      await flush();
      assert.equal(s.requests.length, 2);
      assert.deepEqual(mounted.page.data.rows, []);
      assert.equal(
        mounted.page.data.partial,
        true,
        'An exact unread count does not make a bounded empty scan authoritative',
      );
      assert.equal(
        mounted.page.data.canMore,
        true,
        'An empty page with a continuation is not the end',
      );
      assert.equal(mounted.press('onMore', { source: 'follower' }), true);
      await mounted.idle();
      assert.equal(s.requests.length, 3);
      assert.equal(mounted.page.data.rows.length, 1);
      assert.equal(
        (mounted.page.data.rows as SocialNoticesView['rows'])[0]?.createdAt,
        '2025-01-01T00:00:00.000001Z',
        'Display the actual source occurrence, never a synthetic dispatch time',
      );
      assert.equal(mounted.page.data.canMore, false);
      assert.deepEqual(
        s.requests.map((request) =>
          new URL(request.url).searchParams.get('cursor'),
        ),
        [null, socialCursor, next],
      );
    } finally {
      s.journey.close();
    }
  });
