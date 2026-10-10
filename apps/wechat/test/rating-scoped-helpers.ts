import { sha256 } from 'js-sha256';
import { ClientError } from '../src/api/errors';
import type { Cancellation } from '../src/platform/contracts';
import type { CommunityRuntime } from '../src/community/runtime';
import {
  RatingScopedController,
  type RatingScopedView,
} from '../src/ratings/scoped-controller';
import {
  decodeRatingScopedIntent,
  decodeRatingScopedReceipt,
  ratingNavigationKey,
  ratingScopedCommandContext,
  ratingScopedIntentHash,
  type RatingScopedContext,
  type RatingScopedContextRequest,
  type RatingScopedIntent,
  type RatingScopedLocator,
  type RatingScopedOperation,
  type RatingScopedReceipt,
} from '../src/ratings/scoped-contract';
import type { RatingScopedGateway } from '../src/ratings/scoped-gateway';
import type {
  RatingScopedPageContext,
  RatingScopedNoticeKind,
} from '../src/ratings/scoped-read-contract';
import { PendingRatingStore } from '../src/ratings/pending';
import { PrivateViewLifecycle } from '../src/identity-privacy/overlay';
import { RatingTargetChanges } from '../src/ratings/target-changes';
import { RatingCatalogChanges } from '../src/ratings/catalog-changes';
import { setup } from './community-helpers';
import { FakeClock } from './helpers';
import { accountId } from './identity-helpers';
import {
  category,
  categoryId,
  target,
  targetId,
  comment,
  commentId,
  revision,
  nextRevision,
  otherId,
  requestId,
  timestamp,
  summary,
  myScore,
} from './ratings-helpers';
export const scopedNow = Date.parse('2026-10-09T20:00:00.000Z');
export const token = 't'.repeat(43);
export const tokenDigest = sha256(token);
export const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const anchorGeneration = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
export const definitionRevision = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const nextDefinitionRevision = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const replyId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const contextId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const scopedContext = (
  request: RatingScopedContextRequest = {
    selector: { kind: 'global' },
    purpose: 'interact',
    mode: 'public',
  },
  now = scopedNow,
): RatingScopedContext => ({
  ...request,
  protocolVersion: 2,
  id:
    request.purpose === 'interact'
      ? contextId
      : `${request.purpose === 'read' ? '1' : request.purpose === 'create_target' ? '2' : request.purpose === 'edit_target' ? '3' : '4'}eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`,
  token,
  tokenDigest,
  actorId: accountId,
  sessionGeneration: 'a'.repeat(64),
  scopeRevision: (request.purpose === 'read' ? 'd' : 'b').repeat(64),
  protocolGeneration:
    request.purpose === 'random' &&
    request.selector.kind === 'institution_with_global'
      ? anchorGeneration
      : generation,
  heads:
    request.purpose === 'random' &&
    request.selector.kind === 'institution_with_global'
      ? [
          {
            scopeKey: `campus:${request.selector.anchorCampusId}`,
            catalogRevision: revision,
            headRevision: nextRevision,
          },
          {
            scopeKey: 'global',
            catalogRevision: revision,
            headRevision: nextRevision,
          },
        ]
      : [
          {
            scopeKey:
              request.purpose === 'random'
                ? 'global'
                : ratingNavigationKey(request.selector),
            catalogRevision: revision,
            headRevision: nextRevision,
          },
        ],
  sourceDigest: 'c'.repeat(64),
  identityCampusId: null,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 300_000).toISOString(),
  capabilities: ['navigation_v2', 'shared_recovery_v9'],
});
export function scopedIntent(
  operation: RatingScopedOperation = 'set_score_scoped',
): RatingScopedIntent {
  const common = {
    clientRequestId: requestId,
    targetId,
    expectedTargetRevision: revision,
    categoryId,
    expectedCategoryRevision: revision,
  };
  const text = {
    authorMode: 'named',
    body: 'Synthetic scoped content',
    assetIds: [],
  };
  const definition = {
    clientRequestId: requestId,
    categoryId,
    expectedCategoryRevision: revision,
    name: 'Synthetic scoped target',
    description: '',
    assetIds: [],
  };
  const payloads = {
    set_score_scoped: { ...common, expectedRevision: revision, score: 5 },
    create_comment_scoped: { ...common, ...text },
    create_reply_scoped: {
      ...common,
      ...text,
      rootId: commentId,
      expectedRootRevision: revision,
      replyTo: null,
    },
    set_comment_like_scoped: {
      ...common,
      rootId: commentId,
      expectedRevision: revision,
      expectedLikeRevision: revision,
      liked: true,
    },
    set_reply_like_scoped: {
      ...common,
      rootId: commentId,
      replyId,
      expectedRootRevision: revision,
      expectedRevision: revision,
      expectedLikeRevision: revision,
      liked: true,
    },
    set_target_subscription_scoped: {
      ...common,
      expectedSubscriptionRevision: revision,
      subscribed: true,
    },
    create_target_scoped: definition,
    edit_target_scoped: {
      ...definition,
      ...common,
      expectedDefinitionRevision: definitionRevision,
      expectedContentVersion: 1,
    },
  };
  const context = ratingScopedCommandContext(
    scopedContext({
      selector: { kind: 'global' },
      purpose:
        operation === 'create_target_scoped'
          ? 'create_target'
          : operation === 'edit_target_scoped'
            ? 'edit_target'
            : 'interact',
      mode: 'public',
    }),
  );
  return decodeRatingScopedIntent({
    protocolVersion: 2,
    operation,
    context,
    payload: payloads[operation],
  });
}
export function scopedReceipt(
  intent: RatingScopedIntent = scopedIntent(),
  outcome: 'applied' | 'noop' | 'closed' = 'applied',
): RatingScopedReceipt {
  const base = {
    protocolVersion: 2,
    requestId: intent.payload.clientRequestId,
    operation: intent.operation,
    intentHash: ratingScopedIntentHash(intent),
    outcome,
  };
  if (outcome === 'closed')
    return decodeRatingScopedReceipt({
      ...base,
      code: 'RATING_SCOPED_CONTEXT_CHANGED',
    });
  const result = {
    targetId,
    revision: outcome === 'noop' ? revision : nextRevision,
    occurredAt: timestamp,
  };
  switch (intent.operation) {
    case 'set_score_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: { ...result, subjectId: targetId },
      });
    case 'create_comment_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: { ...result, subjectId: commentId },
      });
    case 'create_reply_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: { ...result, rootId: commentId, replyId },
      });
    case 'set_comment_like_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: {
          ...result,
          rootId: commentId,
          replyId: null,
          liked: intent.payload.liked,
        },
      });
    case 'set_reply_like_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: {
          ...result,
          rootId: commentId,
          replyId,
          liked: intent.payload.liked,
        },
      });
    case 'set_target_subscription_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: { ...result, subscribed: intent.payload.subscribed },
      });
    case 'create_target_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: { ...result, catalogRevision: nextRevision },
      });
    case 'edit_target_scoped':
      return decodeRatingScopedReceipt({
        ...base,
        result: {
          ...result,
          definitionRevision:
            outcome === 'noop' ? definitionRevision : nextDefinitionRevision,
          contentVersion: outcome === 'noop' ? 1 : 2,
        },
      });
  }
}
export function scopedPageContext(
  context = scopedContext(),
): RatingScopedPageContext {
  if (context.purpose === 'random') throw new Error('Navigation fixture only');
  return {
    contextId: context.id,
    selector: context.selector,
    catalogRevision: revision,
    protocolGeneration: generation,
  };
}
export const scopedReply = () => ({
  id: replyId,
  targetId,
  rootId: commentId,
  revision,
  createdAt: timestamp,
  body: 'Synthetic reply',
  author: comment().author,
  isMine: true,
  allowedActions: { reply: true, delete: true },
  replyTo: { kind: 'root' as const },
});
export const scopedLike = (reply = false) => ({
  status: 'known' as const,
  targetId,
  rootId: commentId,
  replyId: reply ? replyId : null,
  count: 0,
  liked: false,
  revision,
  allowedActions: { setLike: true as const },
});
export const scopedSubscription = () => ({
  status: 'known' as const,
  targetId,
  subscribed: false,
  count: 0,
  revision,
  allowedActions: { setSubscription: true as const },
});
export class FakeScopedGateway implements RatingScopedGateway {
  readonly calls: string[] = [];
  readonly commands: RatingScopedIntent[] = [];
  readonly contextRequests: RatingScopedContextRequest[] = [];
  readonly issuedContexts: RatingScopedContext[] = [];
  readonly readContexts: RatingScopedContext[] = [];
  private requirePurpose(context: RatingScopedContext, purpose = 'read'): void {
    if (context.purpose !== purpose)
      throw new Error(`Expected ${purpose} context`);
    this.readContexts.push(context);
  }
  contextWork:
    | ((request: RatingScopedContextRequest) => Promise<RatingScopedContext>)
    | undefined;
  commandWork:
    ((intent: RatingScopedIntent) => Promise<RatingScopedReceipt>) | undefined;
  receiptWork:
    ((requestId: string) => Promise<RatingScopedReceipt>) | undefined;
  async context(request: RatingScopedContextRequest, _cancel: Cancellation) {
    this.calls.push('context');
    this.contextRequests.push(request);
    const context = this.contextWork
      ? await this.contextWork(request)
      : scopedContext(request);
    this.issuedContexts.push(context);
    return context;
  }
  async resolve(
    locator: RatingScopedLocator,
    purpose: 'read' | 'interact' | 'edit_target',
    _cancel: Cancellation,
  ) {
    this.calls.push('resolve');
    return {
      locator,
      context: scopedContext({
        selector: locator.selector,
        purpose,
        mode: 'public',
      }),
    };
  }
  async categories(context: RatingScopedContext, parentId: string | null) {
    this.requirePurpose(context);
    this.calls.push('categories');
    return {
      context: { ...scopedPageContext(context), parentId },
      items: parentId === null ? [category()] : [],
      nextCursor: null,
      continuation: 'end' as const,
    };
  }
  async targets(context: RatingScopedContext, categoryId: string) {
    this.requirePurpose(context);
    this.calls.push('targets');
    return {
      context: { ...scopedPageContext(context), categoryId },
      items: [target()],
      nextCursor: null,
      continuation: 'end' as const,
    };
  }
  async detail(context: RatingScopedContext) {
    this.requirePurpose(context);
    this.calls.push('detail');
    return target();
  }
  async myScore(context: RatingScopedContext) {
    this.requirePurpose(context);
    return myScore();
  }
  async summary(context: RatingScopedContext) {
    this.requirePurpose(context);
    return summary();
  }
  async comments(context: RatingScopedContext, targetId: string) {
    this.requirePurpose(context);
    return {
      context: { ...scopedPageContext(context), targetId },
      items: [comment()],
      nextCursor: null,
      continuation: 'end' as const,
    };
  }
  async comment(context: RatingScopedContext) {
    this.requirePurpose(context);
    return comment();
  }
  async discussion(context: RatingScopedContext, rootId: string) {
    this.requirePurpose(context);
    return {
      context: { ...scopedPageContext(context), targetId, rootId },
      root: comment(),
      allowedActions: {
        createReply: true,
        authorModes: ['named', 'anonymous'] as const,
      },
    };
  }
  async replies(context: RatingScopedContext, rootId: string) {
    this.requirePurpose(context);
    return {
      context: {
        ...scopedPageContext(context),
        targetId,
        rootId,
        order: 'oldest' as const,
      },
      items: [scopedReply()],
      nextCursor: null,
      continuation: 'end' as const,
    };
  }
  async reply(context: RatingScopedContext) {
    this.requirePurpose(context);
    return scopedReply();
  }
  async position(context: RatingScopedContext) {
    const page = await this.replies(context, commentId);
    return { context: page.context, anchorReplyId: replyId, page };
  }
  async commentLike(context: RatingScopedContext) {
    this.requirePurpose(context);
    return scopedLike();
  }
  async replyLike(context: RatingScopedContext) {
    this.requirePurpose(context);
    return scopedLike(true);
  }
  async subscription(context: RatingScopedContext) {
    this.requirePurpose(context);
    return scopedSubscription();
  }
  async subscriptionStates(context: RatingScopedContext) {
    this.requirePurpose(context);
    return { items: [{ targetId, state: scopedSubscription() }] };
  }
  async subscriptions(context: RatingScopedContext) {
    this.requirePurpose(context);
    return {
      context: scopedPageContext(context),
      items: [target()],
      nextCursor: null,
      continuation: 'end' as const,
    };
  }
  async random(
    context: RatingScopedContext,
    categoryId: string,
    minimumAverage: number | null,
  ) {
    this.calls.push('random');
    if (context.purpose !== 'random')
      throw new Error('Random context required');
    return {
      context: {
        contextId: context.id,
        selector: context.selector,
        protocolGeneration: context.protocolGeneration,
        categoryId,
        minimumAverage,
      },
      candidateCount: 1,
      item: {
        locator: {
          selector: { kind: 'global' as const },
          targetId,
          rootId: null,
          replyId: null,
          protocolGeneration: generation,
        },
        target: target(),
        summary: summary(),
      },
    };
  }
  async editContext(context: RatingScopedContext) {
    this.requirePurpose(context, 'edit_target');
    return {
      context: scopedPageContext(context),
      targetId,
      revision,
      definitionRevision,
      contentVersion: 1,
      categoryId,
      categoryRevision: revision,
      name: target().name,
      description: target().description,
    };
  }
  async prepare(intent: RatingScopedIntent) {
    this.calls.push('prepare');
    return {
      intent,
      contextRevision: 'p'.repeat(43),
      targetId,
      targetRevision: nextRevision,
      definitionRevision: nextDefinitionRevision,
      contentVersion: intent.operation === 'create_target_scoped' ? 1 : 2,
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  async command(intent: RatingScopedIntent) {
    this.calls.push('command');
    this.commands.push(intent);
    return this.commandWork ? this.commandWork(intent) : scopedReceipt(intent);
  }
  async cancel(intent: RatingScopedIntent) {
    this.calls.push('cancel');
    return decodeRatingScopedReceipt({
      protocolVersion: 2,
      requestId: intent.payload.clientRequestId,
      operation: intent.operation,
      intentHash: ratingScopedIntentHash(intent),
      outcome: 'closed',
      code:
        intent.operation === 'create_target_scoped'
          ? 'RATING_CREATION_CANCELLED'
          : 'RATING_EDIT_CANCELLED',
    });
  }
  async receipt(request: string) {
    this.calls.push('receipt');
    if (this.receiptWork) return this.receiptWork(request);
    throw new ClientError('business', 'No receipt', {
      serverCode: 'REQUEST_NOT_FOUND',
    });
  }
  async updates(_kind: RatingScopedNoticeKind) {
    this.calls.push('updates');
    return {
      items: [
        {
          noticeId: otherId,
          createdAt: timestamp,
          readAt: null,
          status: 'unavailable' as const,
        },
      ],
      nextCursor: null,
      unreadCount: 1,
    };
  }
  async noticeTarget(
    _kind: RatingScopedNoticeKind,
    noticeId: string,
    context: RatingScopedContext,
  ) {
    this.calls.push('noticeTarget');
    this.requirePurpose(context);
    if (context.purpose !== 'read') throw new Error('Read context required');
    return {
      noticeId,
      status: 'available' as const,
      target: {
        selector: context.selector,
        targetId,
        rootId: commentId,
        replyId,
        protocolGeneration: generation,
      },
    };
  }
}
export function scopedHarness() {
  const base = setup(),
    gateway = new FakeScopedGateway(),
    clock = new FakeClock();
  clock.advance(scopedNow - clock.now());
  const pendingRatings = new PendingRatingStore(
      base.storage,
      'scoped-synthetic',
    ),
    directoryScopeChanges = new PrivateViewLifecycle(),
    browsingScopeChanges = new PrivateViewLifecycle();
  const ids = { count: 0, next: async (): Promise<string> => requestId };
  const runtime: CommunityRuntime = {
    ...base.runtime,
    ratingScoped: gateway,
    pendingRatings,
    directoryScopeChanges,
    browsingScopeChanges,
    ratingTargetChanges: new RatingTargetChanges(),
    ratingCatalogChanges: new RatingCatalogChanges(),
    newRequestId: () => {
      ids.count++;
      return ids.next();
    },
  };
  const views: RatingScopedView[] = [],
    controller = new RatingScopedController(
      runtime,
      (view) => views.push(view),
      clock,
    );
  return {
    ...base,
    runtime,
    gateway,
    clock,
    pendingRatings,
    directoryScopeChanges,
    browsingScopeChanges,
    ids,
    controller,
    views,
    view: () => views[views.length - 1]!,
  };
}
