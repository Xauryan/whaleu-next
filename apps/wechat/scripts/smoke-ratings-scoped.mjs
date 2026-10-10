import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parse, render } from './smoke-ratings.mjs';

const require = createRequire(import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};

/** Emitted native handlers, WXML model, real strict gateway and shared journal.
 * Synthetic transport only: not device rendering, provider, HTTP server or PG proof. */
export async function smokeRatingsScoped({ app, dist }) {
  const emitted = (name) => require(path.join(dist, `${name}.js`));
  const { ApiClient } = emitted('api/client');
  const { ClientError } = emitted('api/errors');
  const { SessionStore } = emitted('auth/session');
  const { Cancellation } = emitted('platform/contracts');
  const { PrivateViewLifecycle } = emitted('identity-privacy/overlay');
  const { HttpRatingScopedGateway } = emitted('ratings/scoped-gateway');
  const { PendingRatingStore } = emitted('ratings/pending');
  const {
    decodeRatingScopedIntent,
    decodeRatingScopedReceipt,
    ratingScopedCommandContext,
    ratingScopedIntentHash,
    ratingScopedOperations,
  } = emitted('ratings/scoped-contract');
  const { ratingScopedNativeRoutes } = emitted('ratings/scoped-routes');
  const { sha256 } = emitted('vendor/sha256');
  const { registerRatingScopedPage } = emitted('ratings/scoped-page');
  const oldGlobals = {
    Page: globalThis.Page,
    getApp: globalThis.getApp,
    wx: globalThis.wx,
  };
  const id = (n) => `${String(n).padStart(8, '0')}-5c09-4c09-8c09-5c095c095c09`;
  const targetId = id(1),
    categoryId = id(2),
    rootId = id(3),
    replyId = id(4),
    campusId = id(5),
    revision = id(6),
    nextRevision = id(7),
    definitionRevision = id(8),
    nextDefinitionRevision = id(9),
    globalGeneration = id(10),
    campusGeneration = id(11),
    noticeId = id(12),
    personaId = id(13);
  const token = 's'.repeat(43),
    time = '2026-10-09T20:00:00.000Z';
  const sessions = new SessionStore();
  const credentials = app.identity.sessions.snapshot().credentials;
  assert.ok(credentials, 'The synthetic parent smoke must supply a session');
  sessions.completeLogin(sessions.beginLogin(), credentials);
  const stored = new Map(),
    contexts = new Map(),
    receipts = new Map(),
    requests = [],
    pages = [],
    navigations = [];
  let counter = 100,
    loseCommand = false;
  const nextId = () => id(counter++);
  const storage = {
    get: (key) => stored.get(key),
    set: (key, value) => stored.set(key, value),
    remove: (key) => stored.delete(key),
  };
  const pendingRatings = new PendingRatingStore(
    storage,
    'emitted-scoped-synthetic',
  );
  const target = {
    id: targetId,
    categoryId,
    revision,
    name: '合成范围目标',
    description: '完整来源合成对象',
    allowedActions: {
      setScore: true,
      createComment: true,
      authorModes: ['named', 'anonymous'],
    },
  };
  const category = {
    id: categoryId,
    parentId: null,
    level: 1,
    kind: 'general',
    systemKey: null,
    name: '合成范围分类',
    description: '',
    revision,
  };
  const summary = {
    status: 'known',
    count: 1,
    sum: 5,
    average: 5,
    distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 },
    revision,
  };
  const root = {
    id: rootId,
    targetId,
    body: '合成文字评价',
    revision,
    createdAt: time,
    author: {
      mode: 'anonymous',
      targetId,
      personaId,
      displayName: '合成目标分身',
    },
    isMine: true,
    allowedActions: { delete: true },
  };
  const reply = {
    ...root,
    id: replyId,
    rootId,
    body: '合成回复',
    allowedActions: { reply: true, delete: true },
    replyTo: { kind: 'root' },
  };
  const subscription = {
    status: 'known',
    targetId,
    subscribed: false,
    count: 0,
    revision,
    allowedActions: { setSubscription: true },
  };
  const like = (isReply = false) => ({
    status: 'known',
    targetId,
    rootId,
    replyId: isReply ? replyId : null,
    liked: false,
    count: 0,
    revision,
    allowedActions: { setLike: true },
  });
  const createContext = (request) => {
    const now = Date.now();
    const random = request.purpose === 'random',
      campus = request.selector.kind !== 'global';
    const keys =
      random && campus
        ? [`campus:${request.selector.anchorCampusId}`, 'global']
        : [campus ? `campus:${request.selector.campusId}` : 'global'];
    const result = {
      ...request,
      protocolVersion: 2,
      id: nextId(),
      token,
      tokenDigest: sha256(token),
      actorId: credentials.accountId,
      sessionGeneration: 'a'.repeat(64),
      scopeRevision: sha256(request.purpose),
      protocolGeneration: campus ? campusGeneration : globalGeneration,
      heads: keys.map((scopeKey) => ({
        scopeKey,
        catalogRevision: revision,
        headRevision: nextRevision,
      })),
      sourceDigest: 'c'.repeat(64),
      identityCampusId: campusId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300000).toISOString(),
      capabilities: ['navigation_v2', 'shared_recovery_v9'],
    };
    contexts.set(result.id, result);
    return result;
  };
  const pageContext = (context) => ({
    contextId: context.id,
    selector: context.selector,
    catalogRevision: revision,
    protocolGeneration: context.protocolGeneration,
  });
  const page = (context, items) => ({
    context,
    items,
    nextCursor: null,
    continuation: 'end',
  });
  const locator = (selector = { kind: 'global' }) => ({
    selector,
    targetId,
    rootId: null,
    replyId: null,
    protocolGeneration:
      selector.kind === 'global' ? globalGeneration : campusGeneration,
  });
  const resultFor = (intent) => {
    const common = { targetId, revision: nextRevision, occurredAt: time };
    switch (intent.operation) {
      case 'set_score_scoped':
        return { ...common, subjectId: targetId };
      case 'create_comment_scoped':
        return { ...common, subjectId: rootId };
      case 'create_reply_scoped':
        return { ...common, rootId, replyId };
      case 'set_comment_like_scoped':
        return {
          ...common,
          rootId,
          replyId: null,
          liked: intent.payload.liked,
        };
      case 'set_reply_like_scoped':
        return { ...common, rootId, replyId, liked: intent.payload.liked };
      case 'set_target_subscription_scoped':
        return { ...common, subscribed: intent.payload.subscribed };
      case 'create_target_scoped':
        return { ...common, catalogRevision: nextRevision };
      case 'edit_target_scoped':
        return {
          ...common,
          definitionRevision: nextDefinitionRevision,
          contentVersion: 2,
        };
      default:
        assert.fail('Unknown synthetic scoped operation');
    }
  };
  const terminal = (intent, cancel = false) =>
    decodeRatingScopedReceipt({
      protocolVersion: 2,
      operation: intent.operation,
      requestId: intent.payload.clientRequestId,
      intentHash: ratingScopedIntentHash(intent),
      ...(cancel
        ? {
            outcome: 'closed',
            code:
              intent.operation === 'create_target_scoped'
                ? 'RATING_CREATION_CANCELLED'
                : 'RATING_EDIT_CANCELLED',
          }
        : { outcome: 'applied', result: resultFor(intent) }),
    });
  const transport = {
    send: async (request) => {
      requests.push(request);
      assert.equal(
        request.headers.Authorization,
        `Bearer ${credentials.accessToken}`,
      );
      const url = new URL(request.url),
        pathname = url.pathname;
      assert.equal(url.searchParams.has('regionId'), false);
      const ok = (body) => ({
        status: 200,
        headers: { 'cache-control': 'no-store', vary: 'Authorization' },
        body,
      });
      if (pathname === '/v2/ratings/contexts')
        return ok(createContext(request.body));
      if (pathname === '/v2/ratings/locators/resolve')
        return ok({
          locator: request.body.locator,
          context: createContext({
            selector: request.body.locator.selector,
            purpose: request.body.purpose,
            mode: 'public',
          }),
        });
      if (pathname.startsWith('/v2/ratings/requests/')) {
        const result = receipts.get(pathname.split('/').at(-1));
        if (!result)
          throw new ClientError('business', 'Receipt unknown', {
            serverCode: 'REQUEST_NOT_FOUND',
          });
        return ok(result);
      }
      if (
        request.method !== 'GET' &&
        pathname !== '/v2/ratings/subscription-states/query'
      ) {
        const { preparationContextRevision, ...raw } = request.body;
        const intent = decodeRatingScopedIntent(raw);
        const old = receipts.get(intent.payload.clientRequestId);
        if (old) return ok(old);
        if (!pathname.endsWith('/cancel')) {
          const commandContext = contexts.get(intent.context.id);
          assert.ok(
            commandContext,
            'Fresh commands need their original issued context',
          );
          assert.equal(
            commandContext.purpose,
            intent.operation === 'create_target_scoped'
              ? 'create_target'
              : intent.operation === 'edit_target_scoped'
                ? 'edit_target'
                : 'interact',
          );
        }
        if (pathname.endsWith('/prepare'))
          return ok({
            intent,
            contextRevision: 'p'.repeat(43),
            targetId,
            targetRevision: nextRevision,
            definitionRevision: nextDefinitionRevision,
            contentVersion: intent.operation === 'create_target_scoped' ? 1 : 2,
            validUntil: new Date(Date.now() + 60000).toISOString(),
          });
        if (
          intent.operation === 'create_target_scoped' ||
          intent.operation === 'edit_target_scoped'
        ) {
          if (!pathname.endsWith('/cancel'))
            assert.equal(preparationContextRevision, 'p'.repeat(43));
        }
        const result = terminal(intent, pathname.endsWith('/cancel'));
        receipts.set(intent.payload.clientRequestId, result);
        if (loseCommand) {
          loseCommand = false;
          throw new Error('Synthetic lost response after durable commit');
        }
        return ok(result);
      }
      if (
        pathname.startsWith('/v2/me/ratings/') &&
        !pathname.endsWith('/target')
      )
        return ok({
          items: [
            { noticeId, createdAt: time, readAt: null, status: 'unavailable' },
          ],
          nextCursor: null,
          unreadCount: 1,
        });
      const contextId =
        request.body?.contextId ?? url.searchParams.get('contextId');
      const context = contexts.get(contextId);
      assert.ok(context, `Missing exact context for ${pathname}`);
      assert.equal(
        context.purpose,
        pathname.endsWith('/random-target')
          ? 'random'
          : pathname.endsWith('/context')
            ? 'edit_target'
            : 'read',
        `Exact read/command purpose for ${pathname}`,
      );
      assert.equal(
        request.body?.contextToken ?? url.searchParams.get('contextToken'),
        token,
      );
      const base = pageContext(context);
      if (
        pathname.endsWith(`/updates/${noticeId}/target`) ||
        /^\/v2\/me\/ratings\/(?:like-updates|subscription-updates)\//.test(
          pathname,
        )
      )
        return ok({
          noticeId,
          status: 'available',
          target: locator(context.selector),
        });
      if (pathname === '/v2/ratings/categories')
        return ok(
          page(
            { ...base, parentId: url.searchParams.get('parentId') },
            url.searchParams.has('parentId') ? [] : [category],
          ),
        );
      if (pathname === '/v2/ratings/targets')
        return ok(page({ ...base, categoryId }, [target]));
      if (pathname === `/v2/ratings/targets/${targetId}`) return ok(target);
      if (pathname.endsWith('/my-score'))
        return ok({ myScore: { score: 3, revision } });
      if (pathname.endsWith('/score-summary')) return ok(summary);
      if (pathname === `/v2/ratings/targets/${targetId}/comments`)
        return ok(page({ ...base, targetId }, [root]));
      if (pathname === `/v2/ratings/comments/${rootId}`) return ok(root);
      if (pathname.endsWith('/discussion'))
        return ok({
          context: { ...base, targetId, rootId },
          root,
          allowedActions: {
            createReply: true,
            authorModes: ['named', 'anonymous'],
          },
        });
      const replies = page({ ...base, targetId, rootId, order: 'oldest' }, [
        reply,
      ]);
      if (pathname.endsWith('/replies')) return ok(replies);
      if (pathname === `/v2/ratings/replies/${replyId}`) return ok(reply);
      if (pathname.endsWith('/position'))
        return ok({
          context: replies.context,
          anchorReplyId: replyId,
          page: replies,
        });
      if (pathname.endsWith('/like'))
        return ok(like(pathname.includes('/replies/')));
      if (pathname.endsWith('/subscription')) return ok(subscription);
      if (pathname.endsWith('/subscription-states/query'))
        return ok({
          items: request.body.targets.map(({ targetId }) => ({
            targetId,
            state: subscription,
          })),
        });
      if (pathname.endsWith('/subscriptions')) return ok(page(base, [target]));
      if (pathname.endsWith('/random-target'))
        return ok({
          context: {
            contextId,
            selector: context.selector,
            protocolGeneration: context.protocolGeneration,
            categoryId,
            minimumAverage: null,
          },
          candidateCount: 1,
          item: { locator: locator(), target, summary },
        });
      if (pathname.endsWith('/context'))
        return ok({
          context: base,
          targetId,
          revision,
          definitionRevision,
          contentVersion: 1,
          categoryId,
          categoryRevision: revision,
          name: target.name,
          description: target.description,
        });
      assert.fail(`Unhandled scoped synthetic route ${pathname}`);
    },
  };
  const gateway = new HttpRatingScopedGateway(
    new ApiClient('https://scoped-ratings.example.test', transport, sessions, {
      refresh: async () => {
        assert.fail('Unexpected refresh');
      },
    }),
    sessions,
  );
  const runtime = {
    ...app.community,
    sessions,
    ratingScoped: gateway,
    pendingRatings,
    newRequestId: async () => nextId(),
    privateViews: new PrivateViewLifecycle(),
  };
  const localApp = { ...app, community: runtime };
  const drain = async () => {
    for (let i = 0; i < 150; i++) await Promise.resolve();
  };
  const source = readFileSync(
    path.join(dist, 'pages/rating-scoped/rating-scoped.wxml'),
    'utf8',
  );
  const tree = parse(source),
    templates = Object.fromEntries(
      ['ratings/common.wxml', 'ratings/target-cover.wxml']
        .flatMap(
          (file) => parse(readFileSync(path.join(dist, file), 'utf8')).children,
        )
        .filter((node) => typeof node !== 'string' && node.tag === 'template')
        .map((node) => [node.attrs.name, node]),
    );
  const visible = (native) =>
    JSON.stringify(render(tree.children, native.data, templates));
  const mount = (route) => {
    let native;
    globalThis.Page = (definition) => {
      native = definition;
    };
    registerRatingScopedPage();
    native.setData = (patch) => {
      native.data = { ...native.data, ...patch };
    };
    for (const [, handler] of source.matchAll(
      /bind(?:tap|input)="([A-Za-z]+)"/g,
    ))
      assert.equal(typeof native[handler], 'function', handler);
    pages.push(native);
    native.onLoad(route);
    native.onShow();
    return native;
  };
  const tap = (native, handler, dataset = {}) =>
    native[handler]({ currentTarget: { dataset } });
  try {
    globalThis.getApp = () => localApp;
    globalThis.wx = {
      ...oldGlobals.wx,
      navigateTo: ({ url, success }) => {
        navigations.push(url);
        success?.();
      },
    };
    assert.match(
      readFileSync(path.join(dist, 'ratings/scoped-contract.js'), 'utf8'),
      /require\("\.\.\/vendor\/sha256"\)/,
    );
    assert.doesNotMatch(
      readFileSync(path.join(dist, 'ratings/scoped-contract.js'), 'utf8'),
      /require\("(?:js-sha256|node:crypto)"\)/,
    );
    const native = mount({
      mode: 'detail',
      scope: 'campus',
      campusId,
      targetId,
    });
    await drain();
    assert.equal(native.data.loaded, true);
    assert.match(visible(native), /合成范围目标/);
    assert.equal(native.data.viewCampusId, campusId);
    assert.equal(JSON.stringify(native.data).includes('tokenDigest'), false);
    tap(native, 'onSection', { mode: 'subscriptions' });
    assert.match(navigations.at(-1), new RegExp(`campusId=${campusId}`));
    tap(native, 'onScore', { score: 5 });
    native.onConfirmScore();
    native.onConfirmScore();
    await drain();
    assert.equal(pendingRatings.load(credentials.accountId), null);
    assert.equal(requests.filter((r) => r.method === 'PUT').length, 1);
    native.onRefresh();
    await drain();
    tap(native, 'onCompose');
    tap(native, 'onAuthorMode', { mode: 'anonymous' });
    native.onText({ detail: { value: '不应留存的草稿' } });
    native.onCloseComposer();
    assert.equal(native.data.text, '');
    native.onRefresh();
    await drain();
    const heldId = deferred();
    runtime.newRequestId = () => heldId.promise;
    tap(native, 'onCompose');
    tap(native, 'onAuthorMode', { mode: 'named' });
    native.onText({ detail: { value: '关闭之前尚未持久化' } });
    native.onPublish();
    await drain();
    native.onCloseComposer();
    heldId.resolve(nextId());
    await drain();
    assert.equal(pendingRatings.load(credentials.accountId), null);
    runtime.newRequestId = async () => nextId();
    native.onRefresh();
    await drain();
    loseCommand = true;
    tap(native, 'onScore', { score: 4 });
    native.onConfirmScore();
    await drain();
    const original = pendingRatings.load(credentials.accountId);
    assert.equal(original.version, 9);
    const bytes = JSON.stringify([...stored.entries()]);
    native.onHide();
    assert.equal(native.data.loaded, false);
    assert.equal(JSON.stringify([...stored.entries()]), bytes);
    const beforeRecovery = requests.length;
    const recovery = mount({ mode: 'recovery', invalid: 'route-must-wait' });
    await drain();
    assert.equal(pendingRatings.load(credentials.accountId), null);
    assert.equal(requests.length, beforeRecovery + 1);
    assert.match(new URL(requests.at(-1).url).pathname, /\/requests\//);
    recovery.onUnload();
    const randomPage = mount({
      mode: 'random',
      scope: 'campus',
      campusId,
      categoryId,
      protocolGeneration: campusGeneration,
    });
    randomPage.onDraw();
    await drain();
    assert.equal(randomPage.data.randomResult.candidateCount, 1);
    assert.notEqual(
      randomPage.data.randomResult.context.protocolGeneration,
      randomPage.data.randomResult.item.locator.protocolGeneration,
    );
    randomPage.onRandomTarget();
    assert.match(
      navigations.at(-1),
      new RegExp(`scope=global.*protocolGeneration=${globalGeneration}`),
    );

    // Exercise the complete emitted HTTP registry with real strict request/response decoders.
    const cancel = new Cancellation();
    const context = await gateway.context(
      { purpose: 'read', selector: { kind: 'global' }, mode: 'public' },
      cancel,
    );
    await gateway.resolve(locator(), 'read', cancel);
    await gateway.categories(context, null, null, cancel);
    await gateway.targets(context, categoryId, null, cancel);
    await gateway.detail(context, targetId, cancel);
    await gateway.myScore(context, targetId, cancel);
    await gateway.summary(context, targetId, cancel);
    await gateway.comments(context, targetId, null, cancel);
    await gateway.comment(context, rootId, cancel);
    await gateway.discussion(context, rootId, cancel);
    await gateway.replies(context, rootId, null, cancel);
    await gateway.reply(context, replyId, cancel);
    await gateway.position(context, replyId, cancel);
    await gateway.commentLike(context, rootId, cancel);
    await gateway.replyLike(context, replyId, cancel);
    await gateway.subscription(context, targetId, cancel);
    await gateway.subscriptionStates(
      context,
      [{ targetId, expectedTargetRevision: revision }],
      cancel,
    );
    await gateway.subscriptions(context, null, cancel);
    const random = await gateway.context(
      { purpose: 'random', selector: { kind: 'global' }, mode: 'public' },
      cancel,
    );
    await gateway.random(random, categoryId, null, cancel);
    const targetContext = await gateway.context(
      { purpose: 'edit_target', selector: { kind: 'global' }, mode: 'public' },
      cancel,
    );
    await gateway.editContext(targetContext, targetId, cancel);
    for (const operation of ratingScopedOperations) {
      const base = {
        clientRequestId: nextId(),
        categoryId,
        expectedCategoryRevision: revision,
      };
      const subject = { ...base, targetId, expectedTargetRevision: revision };
      const text = {
        authorMode: 'named',
        body: '严格的新范围内容',
        assetIds: [],
      };
      const definition = {
        ...base,
        name: '合成对象',
        description: '',
        assetIds: [],
      };
      const likePayload = {
        ...subject,
        rootId,
        expectedRevision: revision,
        expectedLikeRevision: revision,
        liked: true,
      };
      const payloads = {
        set_score_scoped: { ...subject, expectedRevision: revision, score: 5 },
        create_comment_scoped: { ...subject, ...text },
        create_reply_scoped: {
          ...subject,
          ...text,
          rootId,
          expectedRootRevision: revision,
          replyTo: null,
        },
        set_comment_like_scoped: likePayload,
        set_reply_like_scoped: {
          ...likePayload,
          replyId,
          expectedRootRevision: revision,
        },
        set_target_subscription_scoped: {
          ...subject,
          expectedSubscriptionRevision: revision,
          subscribed: true,
        },
        create_target_scoped: definition,
        edit_target_scoped: {
          ...definition,
          ...subject,
          expectedDefinitionRevision: definitionRevision,
          expectedContentVersion: 1,
        },
      };
      const commandContext = await gateway.context(
        {
          purpose:
            operation === 'create_target_scoped'
              ? 'create_target'
              : operation === 'edit_target_scoped'
                ? 'edit_target'
                : 'interact',
          selector: { kind: 'global' },
          mode: 'public',
        },
        cancel,
      );
      const intent = decodeRatingScopedIntent({
        protocolVersion: 2,
        operation,
        context: ratingScopedCommandContext(commandContext),
        payload: payloads[operation],
      });
      const attempt = pendingRatings.freeze({
        version: 9,
        accountId: credentials.accountId,
        intent,
      });
      pendingRatings.settle(attempt, await gateway.command(intent, cancel));
      await gateway.receipt(intent.payload.clientRequestId, cancel);
      if (
        operation === 'create_target_scoped' ||
        operation === 'edit_target_scoped'
      ) {
        const originalCancel = decodeRatingScopedIntent({
          ...intent,
          payload: { ...intent.payload, clientRequestId: nextId() },
        });
        const cancelling = pendingRatings.freeze({
          version: 9,
          accountId: credentials.accountId,
          intent: originalCancel,
        });
        pendingRatings.settle(
          cancelling,
          await gateway.cancel(originalCancel, cancel),
        );
      }
    }
    for (const kind of ['updates', 'like-updates', 'subscription-updates']) {
      await gateway.updates(kind, null, cancel);
      await gateway.noticeTarget(kind, noticeId, context, cancel);
    }
    assert.equal(ratingScopedNativeRoutes.length, 39);
    assert.equal(
      new Set(ratingScopedNativeRoutes.map((route) => route.operationId)).size,
      39,
    );
    for (const route of ratingScopedNativeRoutes) {
      const match = new RegExp(
        `^${route.path.replace(/:[A-Za-z]+/g, '[a-f0-9-]{36}')}$`,
      );
      assert.ok(
        requests.some(
          (request) =>
            request.method === route.method &&
            match.test(new URL(request.url).pathname),
        ),
        route.operationId,
      );
    }
    for (const request of requests)
      assert.equal(
        ratingScopedNativeRoutes.filter(
          (route) =>
            route.method === request.method &&
            new RegExp(
              `^${route.path.replace(/:[A-Za-z]+/g, '[a-f0-9-]{36}')}$`,
            ).test(new URL(request.url).pathname),
        ).length,
        1,
      );
    assert.equal(pendingRatings.load(credentials.accountId), null);
  } finally {
    for (const native of pages) native.onUnload();
    sessions.logout();
    Object.assign(globalThis, oldGlobals);
  }
  console.log(
    'Scoped ratings emitted smoke passed: all 39 exact authenticated routes, eight v9 commands, real browser SHA, native/WXML detail and scope navigation, independent random anchor/locator generations, Close-before-persist, duplicate taps, lost-response hide and history-first byte-preserving recovery. Synthetic only; no device or API/PG acceptance claim.',
  );
}
