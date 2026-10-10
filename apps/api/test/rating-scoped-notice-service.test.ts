import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RatingScopedNoticeService,
  ratingScopedNoticePageSchema,
  ratingScopedResolvedLocatorSchema,
} from '../src/ratings/scoped/notice.service.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  scopedTestContext,
  scopedTestId as id,
  scopedTestTarget,
  scopedTestTime,
  scopedTestToken,
} from './rating-scoped-service-helpers.js';

type Dependencies = ConstructorParameters<typeof RatingScopedNoticeService>;
function fixture(
  options: {
    originalRegion?: string | null;
    targetRegion?: string | null;
    denied?: boolean;
    unknown?: boolean;
    wrongGeneration?: boolean;
    substitutedLocator?: boolean;
    likeDenied?: boolean;
  } = {},
) {
  const calls: string[] = [],
    context = scopedTestContext(),
    tx = {};
  const scope = {
    actor: id(3),
    context,
    selector: context.selector,
    protocolGeneration: options.wrongGeneration
      ? id(98)
      : context.protocolGeneration,
  };
  const target = scopedTestTarget(id(10), options.targetRegion ?? null);
  const root = { id: id(40), account_id: id(3) },
    reply = { id: id(41), account_id: id(3) };
  const base = {
    id: id(50),
    event_id: id(51),
    recipient_account_id: id(3),
    region_id: options.originalRegion ?? null,
    target_id: target.id,
    root_id: root.id,
    reply_id: reply.id,
    ordinal: '1',
    created_at: scopedTestTime,
    read_at: null,
  };
  const row = (kind = 'reply') =>
    kind === 'like'
      ? { ...base, kind, reason: 'like', like_actor_account_id: id(52) }
      : {
          ...base,
          kind,
          reason:
            kind === 'subscription' ? 'target_subscription' : 'direct_reply',
          epoch_id: id(53),
          activity: 'reply',
        };
  const repo = (subscription: boolean) => ({
    page: async (
      _actor: string,
      _limit: number,
      _before: string | null,
      _tx: object,
      kind?: string,
    ) => {
      calls.push('page');
      return [row(subscription ? 'subscription' : kind)];
    },
    own: async (_actor: string, _id: string, _tx: object, kind?: string) => {
      calls.push('own');
      return row(subscription ? 'subscription' : kind);
    },
    owner: async () => {
      calls.push('notice-owner');
    },
    states: async () => {
      calls.push('states');
      return new Map([[base.id, null]]);
    },
    count: async () => 1,
  });
  const locator = {
    selector: { kind: 'campus' as const, campusId: id(2) },
    targetId: target.id,
    rootId: root.id,
    replyId: reply.id,
    protocolGeneration: context.protocolGeneration,
  };
  const service = new RatingScopedNoticeService(
    {
      transaction: async (fn: (tx: object) => Promise<unknown>) => fn(tx),
    } as unknown as Dependencies[0],
    {
      session: async () => {
        calls.push('session');
        return { accountId: id(3), sessionId: id(60) };
      },
    } as unknown as Dependencies[1],
    {
      resolve: async (_token: string, _query: unknown, actual: object) => {
        assert.equal(actual, tx);
        calls.push('resolve');
        return scope;
      },
      resolveLocator: async (
        _token: string,
        requested: typeof locator,
        purpose: string,
        actual: object,
      ) => {
        assert.equal(actual, tx);
        assert.equal(purpose, 'read');
        calls.push('resolve-locator');
        return {
          context,
          locator: options.substitutedLocator
            ? { ...requested, targetId: id(99) }
            : requested,
        };
      },
    } as unknown as Dependencies[2],
    {
      enable() {},
      target: async (_scope: unknown, targetId: string) => {
        assert.equal(targetId, target.id);
        calls.push('target');
        return { row: target };
      },
      retainAfter: async () => {
        calls.push('retain');
      },
    } as unknown as Dependencies[3],
    {
      enable() {},
      comment: async (rootId: string, targetId: string) => {
        assert.equal(rootId, root.id);
        assert.equal(targetId, target.id);
        calls.push('root');
        return root;
      },
    } as unknown as Dependencies[4],
    {
      reply: async (replyId: string, rootId: string, targetId: string) => {
        assert.equal(replyId, reply.id);
        assert.equal(rootId, root.id);
        assert.equal(targetId, target.id);
        calls.push('reply');
        return reply;
      },
    } as unknown as Dependencies[5],
    {
      qualifyTarget: async () => {
        calls.push('review');
        if (options.unknown)
          throw new ApplicationError('CONTENT_REVIEW_UNAVAILABLE');
        if (options.denied) throw new ApplicationError('RATING_NOT_FOUND');
      },
      content: async () => true,
    } as unknown as Dependencies[6],
    {
      recheck: async () => {
        calls.push('recheck');
      },
    } as unknown as Dependencies[7],
    repo(false) as unknown as Dependencies[8],
    repo(true) as unknown as Dependencies[9],
    {
      get: async () => '0',
      create: async () => 'c'.repeat(43),
    } as unknown as Dependencies[10],
    {
      get: async () => '0',
      create: async () => 'c'.repeat(43),
    } as unknown as Dependencies[11],
    {
      named: async () => ({ kind: options.likeDenied ? 'deny' : 'allow' }),
    } as unknown as Dependencies[12],
    {
      findRatingPublic: async () => ({ displayName: 'Synthetic author' }),
    } as unknown as Dependencies[13],
  );
  return {
    service,
    calls,
    context,
    locator,
    query: { contextId: context.id, contextToken: scopedTestToken },
    noticeId: base.id,
  };
}
test('all scoped notice lists stay metadata-only and share existing IDs and owner read-state', async () => {
  for (const kind of [
    'updates',
    'like-updates',
    'subscription-updates',
  ] as const) {
    const f = fixture(),
      page = await f.service.list('session', kind, { limit: 20 });
    assert.deepEqual(page, {
      items: [
        {
          noticeId: f.noticeId,
          createdAt: scopedTestTime,
          readAt: null,
          status: 'unavailable',
        },
      ],
      nextCursor: null,
      unreadCount: 1,
    });
    assert.equal(f.calls.includes('resolve'), false);
    assert.equal(f.calls.includes('target'), false);
    assert(f.calls.includes('notice-owner'));
    assert.equal(
      ratingScopedNoticePageSchema.safeParse({
        ...page,
        items: [{ ...page.items[0], preview: { text: 'leak' } }],
      }).success,
      false,
    );
  }
});
test('explicit selected path resolves captured notice with original global target region unchanged', async () => {
  const f = fixture(),
    result = await f.service.target('session', 'updates', f.noticeId, f.query);
  assert.deepEqual(result, {
    noticeId: f.noticeId,
    status: 'available',
    target: f.locator,
  });
  assert(f.calls.indexOf('retain') < f.calls.indexOf('notice-owner'));
  assert(f.calls.includes('root'));
  assert(f.calls.includes('reply'));
});
test('notice resolution rejects changed target origin rather than converting region to selected campus', async () => {
  const f = fixture({ originalRegion: id(70), targetRegion: id(2) });
  await assert.rejects(
    () => f.service.target('session', 'updates', f.noticeId, f.query),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'RATING_UNAVAILABLE',
  );
  assert.equal(f.calls.includes('notice-owner'), false);
});
test('explicit Review deny becomes unavailable metadata; missing Review proof fails closed', async () => {
  const denied = fixture({ denied: true });
  assert.deepEqual(
    await denied.service.target(
      'session',
      'updates',
      denied.noticeId,
      denied.query,
    ),
    { noticeId: denied.noticeId, status: 'unavailable' },
  );
  const unknown = fixture({ unknown: true });
  await assert.rejects(
    () =>
      unknown.service.target(
        'session',
        'updates',
        unknown.noticeId,
        unknown.query,
      ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
});
test('like notice uses existing named-author safety before exposing its exact locator', async () => {
  const f = fixture({ likeDenied: true });
  assert.deepEqual(
    await f.service.target('session', 'like-updates', f.noticeId, f.query),
    { noticeId: f.noticeId, status: 'unavailable' },
  );
});
test('locator resolution adopts exact selected path generation in one transaction and qualifies root/reply ancestry', async () => {
  const f = fixture(),
    response = await f.service.resolveLocator('session', {
      locator: f.locator,
      purpose: 'read',
      mode: 'public',
    });
  assert.deepEqual(response.locator, f.locator);
  assert.equal(
    response.context.protocolGeneration,
    f.locator.protocolGeneration,
  );
  assert.deepEqual(f.calls, [
    'resolve-locator',
    'resolve',
    'target',
    'review',
    'root',
    'reply',
    'recheck',
    'retain',
  ]);
  assert.equal(
    ratingScopedResolvedLocatorSchema.safeParse({
      ...response,
      context: { ...response.context, protocolGeneration: id(99) },
    }).success,
    false,
  );
  assert.equal(
    ratingScopedResolvedLocatorSchema.safeParse({
      ...response,
      context: {
        ...response.context,
        selector: { kind: 'global' },
        heads: [{ ...response.context.heads[0], scopeKey: 'global' }],
      },
    }).success,
    false,
  );
});
test('locator cannot be rebased to another generation or substitute another target silently', async () => {
  for (const options of [
    { wrongGeneration: true },
    { substitutedLocator: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(
      () =>
        f.service.resolveLocator('session', {
          locator: f.locator,
          purpose: 'read',
          mode: 'public',
        }),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'RATING_SCOPED_CONTEXT_CHANGED',
    );
    assert.equal(f.calls.includes('target'), false);
  }
});
