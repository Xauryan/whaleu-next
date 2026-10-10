import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/auth/session';
import { decodeRatingScopedContext } from '../src/ratings/scoped-contract';
import {
  decodeRatingTargetCoverContext,
  matchRatingCoverScopePair,
  RatingTargetCoverContextLease,
} from '../src/ratings/target-cover-context';
import { RatingScopedController } from '../src/ratings/scoped-controller';
import {
  decodeRatingTargetCoverRandom,
  decodeRatingTargetCoverSubscriptions,
} from '../src/ratings/target-cover-gateway';
import type { RatingTargetCoverGateway } from '../src/ratings/target-cover-gateway';
import { RATINGS_MEDIA_PROTOCOL } from '../src/ratings/target-cover-media-contract';
import {
  scopedContext,
  scopedHarness,
  scopedPageContext,
  replyId,
  FakeScopedGateway,
} from './rating-scoped-helpers';
import { FakeClock } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  target,
  targetId,
  otherId,
  requestId,
  commentId,
  categoryId,
} from './ratings-helpers';
const request = {
  purpose: 'read',
  selector: { kind: 'global' },
  mode: 'public',
} as const;
const coverContext = (legacy = scopedContext(request)) =>
  decodeRatingTargetCoverContext({
    ...legacy,
    id: otherId,
    protocolVersion: 3,
    capabilities: [...legacy.capabilities, 'target_cover'],
  });
test('independent context3 rejects v2, mixed scope and actor-session ABA', () => {
  const legacy = scopedContext(request),
    current = coverContext(legacy);
  assert.throws(() => decodeRatingScopedContext(current));
  assert.throws(() => decodeRatingTargetCoverContext(legacy));
  assert.doesNotThrow(() => matchRatingCoverScopePair(legacy, current));
  for (const patch of [
    { id: legacy.id },
    { sourceDigest: 'f'.repeat(64) },
    { sessionGeneration: 'e'.repeat(64) },
    { actorId: requestId },
  ])
    assert.throws(() =>
      matchRatingCoverScopePair(legacy, { ...current, ...patch }),
    );
  const sessions = new SessionStore(),
    clock = new FakeClock();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const lease = new RatingTargetCoverContextLease(
    sessions,
    () => undefined,
    clock,
  );
  const generation = lease.capture(),
    original = coverContext(scopedContext(request, clock.now()));
  lease.accept(original, request, generation);
  sessions.logout();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  assert.throws(() => lease.current());
  assert.throws(() => lease.accept(original, request, generation));
  lease.dispose();
});
test('covered target auxiliary reads and every interaction retain original v2 source authority', async () => {
  const actions: Array<
    [string, string, (controller: RatingScopedController) => Promise<void>]
  > = [
    [
      'detail',
      'set_score_scoped',
      async (c) => {
        c.chooseScore(5);
        await c.confirmScore();
      },
    ],
    [
      'detail',
      'create_comment_scoped',
      async (c) => {
        c.openComposer();
        c.setAuthorMode('named');
        c.setText('Comment');
        await c.publish();
      },
    ],
    [
      'thread',
      'create_reply_scoped',
      async (c) => {
        c.openComposer(replyId);
        c.setAuthorMode('anonymous');
        c.setText('Reply');
        await c.publish();
      },
    ],
    ['detail', 'set_comment_like_scoped', async (c) => c.toggleLike(commentId)],
    ['thread', 'set_reply_like_scoped', async (c) => c.toggleLike(replyId)],
    [
      'detail',
      'set_target_subscription_scoped',
      async (c) => c.toggleSubscription(targetId),
    ],
  ];
  for (const [mode, operation, act] of actions) {
    const s = scopedHarness();
    s.controller.dispose();
    const unavailable = async (): Promise<never> => {
      throw new Error('Unexpected cover command');
    };
    const cover: RatingTargetCoverGateway = {
      context: async (input) => coverContext(scopedContext(input)),
      detail: async (context) => ({
        context: {
          ...scopedPageContext(scopedContext(request)),
          contextId: context.id,
        },
        target: target(),
        cover: {
          protocol: RATINGS_MEDIA_PROTOCOL,
          kind: 'ratings-target-media',
          contextId: context.id,
          contextToken: context.token,
          targetId,
          appearanceId: otherId,
          bindingId: requestId,
          width: 800,
          height: 600,
          variants: ['thumb-v1', 'display-v1'],
        },
      }),
      subscriptions: unavailable,
      targets: unavailable,
      random: unavailable,
      editContext: unavailable,
      prepare: unavailable,
      command: unavailable,
      cancel: unavailable,
      receipt: unavailable,
    };
    const controller = new RatingScopedController(
      { ...s.runtime, ratingTargetCover: cover },
      () => undefined,
      s.clock,
    );
    await controller.load({
      mode,
      scope: 'global',
      targetId,
      ...(mode === 'thread' ? { rootId: commentId } : {}),
    });
    await act(controller);
    assert.equal(
      s.gateway.commands[s.gateway.commands.length - 1]?.operation,
      operation,
    );
    assert.ok(s.gateway.readContexts.length > 0);
    assert.ok(
      s.gateway.readContexts.every(
        (context) => context.protocolVersion === 2 && context.id !== otherId,
      ),
    );
    assert.ok(
      s.gateway.commands.every(
        (intent) =>
          intent.protocolVersion === 2 && intent.context.id !== otherId,
      ),
    );
    assert.equal(s.gateway.calls.includes('detail'), false);
    controller.dispose();
  }
});

test('random3 and subscriptions keep complete cover projections and reject cross-scope descriptors', async () => {
  const legacy = await new FakeScopedGateway().random(
    scopedContext({
      purpose: 'random',
      selector: { kind: 'global' },
      mode: 'public',
    }),
    categoryId,
    null,
  );
  const context = coverContext(),
    descriptor = {
      protocol: RATINGS_MEDIA_PROTOCOL,
      kind: 'ratings-target-media',
      contextId: context.id,
      contextToken: context.token,
      targetId,
      appearanceId: otherId,
      bindingId: requestId,
      width: 800,
      height: 600,
      variants: ['thumb-v1', 'display-v1'],
    };
  const input = {
    ...legacy,
    item: { ...legacy.item, cover: descriptor, coverContext: context },
  };
  assert.equal(
    decodeRatingTargetCoverRandom(input).item?.cover?.targetId,
    targetId,
  );
  assert.throws(() =>
    decodeRatingTargetCoverRandom({
      ...input,
      item: { ...input.item, coverContext: { ...context, protocolVersion: 2 } },
    }),
  );
  assert.throws(() =>
    decodeRatingTargetCoverRandom({
      ...input,
      item: {
        ...input.item,
        cover: { ...descriptor, contextToken: 'x'.repeat(43) },
      },
    }),
  );
  assert.throws(() => decodeRatingTargetCoverRandom(legacy));
  const page = {
    context: { ...scopedPageContext(), contextId: context.id },
    items: [{ ...target(), cover: descriptor }],
    nextCursor: null,
    continuation: 'end',
  };
  assert.equal(
    decodeRatingTargetCoverSubscriptions(page).items[0]?.cover?.appearanceId,
    otherId,
  );
  assert.throws(() =>
    decodeRatingTargetCoverSubscriptions({ ...page, items: [target()] }),
  );
});
