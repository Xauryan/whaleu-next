import { ratingScopedNativeRoutes } from '../src/ratings/scoped-routes';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingScopedGateway } from '../src/ratings/scoped-gateway';
import { ratingScopedOperations } from '../src/ratings/scoped-contract';
import { ScriptedTransport, deferred, flush, response } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  category,
  categoryId,
  comment,
  commentId,
  myScore,
  otherId,
  requestId,
  revision,
  summary,
  target,
  targetId,
  timestamp,
  nextRevision,
} from './ratings-helpers';
import {
  scopedContext,
  scopedIntent,
  scopedReceipt,
  scopedPageContext,
  scopedLike,
  scopedSubscription,
  scopedReply,
  definitionRevision,
  nextDefinitionRevision,
  generation,
  replyId,
  token,
} from './rating-scoped-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpRatingScopedGateway(
    new ApiClient('https://ratings.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
    sessions,
  );
  return { sessions, transport, gateway };
}
const preparation = (intent = scopedIntent('create_target_scoped')) => ({
  intent,
  contextRevision: 'p'.repeat(43),
  targetId,
  targetRevision: nextRevision,
  definitionRevision: nextDefinitionRevision,
  contentVersion: intent.operation === 'create_target_scoped' ? 1 : 2,
  validUntil: new Date(Date.now() + 60_000).toISOString(),
});

test('all 39 v2 endpoints use authenticated exact scoped DTOs and original eight-operation transport', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    context = scopedContext(
      { purpose: 'read', selector: { kind: 'global' }, mode: 'public' },
      Date.now(),
    ),
    page = scopedPageContext(context),
    locator = {
      selector: { kind: 'global' as const },
      targetId,
      rootId: null,
      replyId: null,
      protocolGeneration: generation,
    };
  s.transport.reply(context);
  await s.gateway.context(
    { selector: { kind: 'global' }, purpose: 'read', mode: 'public' },
    cancel,
  );
  s.transport.reply({ locator, context });
  await s.gateway.resolve(locator, 'read', cancel);
  s.transport.reply({
    context: { ...page, parentId: null },
    items: [category()],
    nextCursor: null,
    continuation: 'end',
  });
  await s.gateway.categories(context, null, null, cancel);
  s.transport.reply({
    context: { ...page, categoryId },
    items: [target()],
    nextCursor: null,
    continuation: 'end',
  });
  await s.gateway.targets(context, categoryId, null, cancel);
  s.transport.reply(target());
  await s.gateway.detail(context, targetId, cancel);
  s.transport.reply(myScore());
  await s.gateway.myScore(context, targetId, cancel);
  s.transport.reply(summary());
  await s.gateway.summary(context, targetId, cancel);
  s.transport.reply({
    context: { ...page, targetId },
    items: [comment()],
    nextCursor: null,
    continuation: 'end',
  });
  await s.gateway.comments(context, targetId, null, cancel);
  s.transport.reply(comment());
  await s.gateway.comment(context, commentId, cancel);
  s.transport.reply({
    context: { ...page, targetId, rootId: commentId },
    root: comment(),
    allowedActions: { createReply: true, authorModes: ['named'] },
  });
  await s.gateway.discussion(context, commentId, cancel);
  const replies = {
    context: { ...page, targetId, rootId: commentId, order: 'oldest' },
    items: [scopedReply()],
    nextCursor: null,
    continuation: 'end',
  };
  s.transport.reply(replies);
  await s.gateway.replies(context, commentId, null, cancel);
  s.transport.reply(scopedReply());
  await s.gateway.reply(context, replyId, cancel);
  s.transport.reply({
    context: replies.context,
    anchorReplyId: replyId,
    page: replies,
  });
  await s.gateway.position(context, replyId, cancel);
  s.transport.reply(scopedLike());
  await s.gateway.commentLike(context, commentId, cancel);
  s.transport.reply(scopedLike(true));
  await s.gateway.replyLike(context, replyId, cancel);
  s.transport.reply(scopedSubscription());
  await s.gateway.subscription(context, targetId, cancel);
  s.transport.reply({ items: [{ targetId, state: scopedSubscription() }] });
  await s.gateway.subscriptionStates(
    context,
    [{ targetId, expectedTargetRevision: revision }],
    cancel,
  );
  s.transport.reply({
    context: page,
    items: [target()],
    nextCursor: null,
    continuation: 'end',
  });
  await s.gateway.subscriptions(context, null, cancel);
  const random = scopedContext(
    { purpose: 'random', selector: { kind: 'global' }, mode: 'public' },
    Date.now(),
  );
  s.transport.reply({
    context: {
      contextId: random.id,
      selector: random.selector,
      categoryId,
      minimumAverage: null,
      protocolGeneration: random.protocolGeneration,
    },
    candidateCount: 1,
    item: { locator, target: target(), summary: summary() },
  });
  await s.gateway.random(random, categoryId, null, cancel);
  for (const operation of ratingScopedOperations) {
    const intent = scopedIntent(operation);
    if (
      operation === 'create_target_scoped' ||
      operation === 'edit_target_scoped'
    )
      s.transport.reply(preparation(intent));
    s.transport.reply(scopedReceipt(intent));
    await s.gateway.command(intent, cancel);
    if (
      operation === 'create_target_scoped' ||
      operation === 'edit_target_scoped'
    ) {
      s.transport.reply(scopedReceipt(intent, 'closed'));
      await s.gateway.cancel(intent, cancel);
    }
  }
  const editing = scopedContext({
    purpose: 'edit_target',
    selector: { kind: 'global' },
    mode: 'public',
  });
  s.transport.reply({
    context: scopedPageContext(editing),
    targetId,
    revision,
    definitionRevision,
    contentVersion: 1,
    categoryId,
    categoryRevision: revision,
    name: 'Target',
    description: '',
  });
  await s.gateway.editContext(editing, targetId, cancel);
  s.transport.reply(scopedReceipt());
  await s.gateway.receipt(requestId, cancel);
  for (const kind of [
    'updates',
    'like-updates',
    'subscription-updates',
  ] as const) {
    s.transport.reply({
      items: [
        {
          noticeId: otherId,
          createdAt: timestamp,
          readAt: null,
          status: 'unavailable',
        },
      ],
      nextCursor: null,
      unreadCount: 1,
    });
    await s.gateway.updates(kind, null, cancel);
    s.transport.reply({
      noticeId: otherId,
      status: 'available',
      target: locator,
    });
    await s.gateway.noticeTarget(kind, otherId, context, cancel);
  }
  const paths = s.transport.requests.map(
    (request) => `${request.method} ${new URL(request.url).pathname}`,
  );
  assert.equal(new Set(paths).size, 39);
  assert.equal(paths.length, 39);
  assert.equal(ratingScopedNativeRoutes.length, 39);
  assert.equal(
    new Set(ratingScopedNativeRoutes.map((route) => route.operationId)).size,
    39,
  );
  for (const route of ratingScopedNativeRoutes) {
    const pattern = new RegExp(
      '^' +
        route.method +
        ' ' +
        route.path.replace(/:[A-Za-z]+/g, '[a-f0-9-]{36}') +
        '$',
    );
    assert.equal(
      paths.filter((path) => pattern.test(path)).length,
      1,
      route.operationId,
    );
  }
  for (const request of s.transport.requests) {
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
    const url = new URL(request.url);
    assert.equal(url.searchParams.has('regionId'), false);
    if (url.searchParams.has('contextId'))
      assert.equal(url.searchParams.get('contextToken'), token);
    assert.equal(
      (JSON.stringify(request.body) ?? '').includes('regionId'),
      false,
    );
  }
  const receipt = s.transport.requests.find((request) =>
    new URL(request.url).pathname.endsWith(`/requests/${requestId}`),
  )!;
  assert.equal(new URL(receipt.url).search, '');
  assert.equal(receipt.body, undefined);
});
test('lost prepare retries the same exact original intent and never creates a refreshed context', async () => {
  const s = setup(),
    intent = scopedIntent('edit_target_scoped'),
    cancel = new Cancellation();
  s.transport.steps.push(async () => {
    throw new Error('Lost prepare response');
  });
  await assert.rejects(s.gateway.command(intent, cancel));
  s.transport.reply(preparation(intent));
  s.transport.reply(scopedReceipt(intent));
  await s.gateway.command(intent, cancel);
  assert.deepEqual(s.transport.requests[0]!.body, intent);
  assert.deepEqual(s.transport.requests[1]!.body, intent);
  assert.deepEqual(s.transport.requests[2]!.body, {
    ...intent,
    preparationContextRevision: 'p'.repeat(43),
  });
  assert.equal(
    s.transport.requests.some((request) =>
      new URL(request.url).pathname.endsWith('/contexts'),
    ),
    false,
  );
});
test('cancel/hide and same-account relogin during prepare prevent a fresh commit', async () => {
  for (const relogin of [false, true]) {
    const s = setup(),
      intent = scopedIntent('create_target_scoped'),
      cancel = new Cancellation(),
      delayed = deferred<ReturnType<typeof response>>();
    s.transport.steps.push(() => delayed.promise);
    const sending = s.gateway.command(intent, cancel);
    await flush();
    if (relogin)
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    else cancel.cancel();
    delayed.resolve(response(preparation(intent)));
    await assert.rejects(sending);
    assert.equal(s.transport.requests.length, 1);
  }
});
test('forged context/page/locator and mismatched receipt are rejected without leaking alternate scopes', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    context = scopedContext(
      { purpose: 'read', selector: { kind: 'global' }, mode: 'public' },
      Date.now(),
    );
  s.transport.reply({ ...context, actorId: otherId });
  await assert.rejects(
    s.gateway.context(
      { selector: { kind: 'global' }, purpose: 'read', mode: 'public' },
      cancel,
    ),
  );
  s.transport.reply({
    context: {
      ...scopedPageContext(context),
      parentId: null,
      selector: { kind: 'campus', campusId: otherId },
    },
    items: [category()],
    nextCursor: null,
    continuation: 'end',
  });
  await assert.rejects(s.gateway.categories(context, null, null, cancel));
  s.transport.reply({ ...scopedReceipt(), intentHash: 'f'.repeat(64) });
  await assert.rejects(s.gateway.command(scopedIntent(), cancel));
});

test('random uses an opaque real protocol generation, independently of selected path generation; resolution stays exact', async () => {
  for (const selector of [
    { kind: 'global' as const },
    { kind: 'institution_with_global' as const, anchorCampusId: otherId },
  ]) {
    const s = setup(),
      cancel = new Cancellation();
    const random = scopedContext(
      { purpose: 'random', selector, mode: 'public' },
      Date.now(),
    );
    const navigation =
      selector.kind === 'global'
        ? { kind: 'global' as const }
        : { kind: 'campus' as const, campusId: selector.anchorCampusId };
    const locator = {
      selector: navigation,
      targetId,
      rootId: null,
      replyId: null,
      protocolGeneration: generation,
    };
    s.transport.reply({
      context: {
        contextId: random.id,
        selector,
        categoryId,
        minimumAverage: null,
        protocolGeneration: random.protocolGeneration,
      },
      candidateCount: 1,
      item: { locator, target: target(), summary: summary() },
    });
    const result = await s.gateway.random(random, categoryId, null, cancel);
    assert.equal(result.item?.locator.protocolGeneration, generation);
    if (selector.kind === 'institution_with_global')
      assert.notEqual(
        result.context.protocolGeneration,
        result.item?.locator.protocolGeneration,
      );
    assert.notEqual(result.context.protocolGeneration, random.id);
    const adopted = scopedContext(
      { purpose: 'read', selector: navigation, mode: 'public' },
      Date.now(),
    );
    s.transport.reply({ locator, context: adopted });
    assert.deepEqual(
      (await s.gateway.resolve(locator, 'read', cancel)).locator,
      locator,
    );
    s.transport.reply({
      locator,
      context: { ...adopted, protocolGeneration: requestId },
    });
    await assert.rejects(() => s.gateway.resolve(locator, 'read', cancel));
  }
});

test('read transports reject command contexts and owner-edit requires its own purpose before sending', async () => {
  const s = setup(),
    cancel = new Cancellation();
  const command = scopedContext(),
    read = scopedContext({
      purpose: 'read',
      selector: { kind: 'global' },
      mode: 'public',
    });
  for (const call of [
    () => s.gateway.categories(command, null, null, cancel),
    () => s.gateway.detail(command, targetId, cancel),
    () => s.gateway.comments(command, targetId, null, cancel),
    () => s.gateway.subscriptions(command, null, cancel),
    () => s.gateway.noticeTarget('updates', otherId, command, cancel),
    () => s.gateway.editContext(read, targetId, cancel),
  ])
    await assert.rejects(async () => call());
  assert.equal(s.transport.requests.length, 0);
});
