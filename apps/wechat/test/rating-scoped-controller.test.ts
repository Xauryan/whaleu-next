import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  RatingScopedContextLease,
  matchRatingScopedContextPair,
} from '../src/ratings/scoped-context';
import { deferred, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  categoryId,
  targetId,
  commentId,
  otherId,
  requestId,
  target,
} from './ratings-helpers';
import {
  scopedHarness,
  scopedContext,
  scopedIntent,
  scopedReceipt,
  generation,
  replyId,
} from './rating-scoped-helpers';
import type {
  RatingScopedContext,
  RatingScopedReceipt,
} from '../src/ratings/scoped-contract';
const detail = { mode: 'detail', scope: 'global', targetId };
const thread = { mode: 'thread', scope: 'global', targetId, rootId: commentId };

test('scoped direct detail reads the exact category and exposes independent identity and view scopes', async () => {
  const s = scopedHarness();
  await s.controller.load(detail);
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().detail?.id, targetId);
  assert.equal(s.view().viewCampusId, null);
  assert.equal(s.view().identityCampusId, null);
  assert.equal(JSON.stringify(s.view()).includes('tokenDigest'), false);
  assert.equal(JSON.stringify(s.view()).includes('sessionGeneration'), false);
  s.controller.dispose();
  assert.equal(s.clock.timers, 0);
});
test('every scoped operation reaches v9 with exact typed intent and settles via the shared slot', async () => {
  const cases: Array<
    [
      string,
      (s: ReturnType<typeof scopedHarness>) => Promise<void>,
      Record<string, string>,
    ]
  > = [
    [
      'set_score_scoped',
      async (s) => {
        s.controller.chooseScore(5);
        await s.controller.confirmScore();
      },
      detail,
    ],
    [
      'create_comment_scoped',
      async (s) => {
        s.controller.openComposer();
        s.controller.setAuthorMode('named');
        s.controller.setText('Hello campus');
        await s.controller.publish();
      },
      detail,
    ],
    [
      'create_reply_scoped',
      async (s) => {
        s.controller.openComposer(replyId);
        s.controller.setAuthorMode('anonymous');
        s.controller.setText('A reply');
        await s.controller.publish();
      },
      thread,
    ],
    [
      'set_comment_like_scoped',
      async (s) => {
        await s.controller.toggleLike(commentId);
      },
      detail,
    ],
    [
      'set_reply_like_scoped',
      async (s) => {
        await s.controller.toggleLike(replyId);
      },
      thread,
    ],
    [
      'set_target_subscription_scoped',
      async (s) => {
        await s.controller.toggleSubscription(targetId);
      },
      detail,
    ],
    [
      'create_target_scoped',
      async (s) => {
        s.controller.setDefinition('name', 'New object');
        s.controller.confirmDefinition();
        await s.controller.commitDefinition();
      },
      { mode: 'create', scope: 'global', categoryId },
    ],
    [
      'edit_target_scoped',
      async (s) => {
        s.controller.setDefinition('name', 'Edited object');
        s.controller.confirmDefinition();
        await s.controller.commitDefinition();
      },
      { mode: 'edit', scope: 'global', targetId },
    ],
  ];
  for (const [operation, act, route] of cases) {
    const s = scopedHarness();
    await s.controller.load(route);
    const purpose =
      operation === 'create_target_scoped'
        ? 'create_target'
        : operation === 'edit_target_scoped'
          ? 'edit_target'
          : 'interact';
    assert.deepEqual(
      s.gateway.contextRequests.map((request) => request.purpose),
      ['read', purpose],
    );
    const [readContext, commandContext] = s.gateway.issuedContexts;
    assert.notEqual(readContext!.id, commandContext!.id);
    assert.ok(
      s.gateway.readContexts.every(
        (context) =>
          context.purpose === (route.mode === 'edit' ? 'edit_target' : 'read'),
      ),
    );
    await act(s);
    assert.equal(s.gateway.commands[0]?.operation, operation);
    assert.equal(s.gateway.commands[0]?.payload.categoryId, categoryId);
    assert.equal(s.gateway.commands[0]?.context.id, commandContext!.id);
    assert.equal(
      s.gateway.contextRequests.length,
      2,
      'submit must never refresh a context',
    );
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.view().needsRefresh, true);
    assert.equal(s.view().frozen, false);
    s.controller.dispose();
  }
});
test('old key recovery precedes malformed routes and failing fresh context; expired original intent is unchanged', async () => {
  const s = scopedHarness(),
    intent = scopedIntent();
  s.pendingRatings.freeze({ version: 9, accountId: s.accountId, intent });
  s.gateway.contextWork = async () => {
    throw new Error('Context must not warm up');
  };
  await s.controller.load({ arbitrary: true });
  assert.deepEqual(s.gateway.calls, ['receipt']);
  assert.equal(s.view().frozen, true);
  await s.controller.recover(true);
  assert.deepEqual(s.gateway.commands, [intent]);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  assert.equal(s.gateway.calls.includes('context'), false);
  s.controller.dispose();
});
test('same-account login, scope switch, app hide, Back and Close invalidate unsent drafts before delayed request ID', async () => {
  const invalidations = [
    (s: ReturnType<typeof scopedHarness>) => {
      s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
    },
    (s: ReturnType<typeof scopedHarness>) =>
      s.directoryScopeChanges.clear(s.accountId),
    (s: ReturnType<typeof scopedHarness>) =>
      s.browsingScopeChanges.clear(s.accountId),
    (s: ReturnType<typeof scopedHarness>) => s.runtime.privateViews!.clear(),
    (s: ReturnType<typeof scopedHarness>) => s.controller.dispose(),
    (s: ReturnType<typeof scopedHarness>) => s.controller.closeComposer(),
  ];
  for (const invalidate of invalidations) {
    const s = scopedHarness(),
      id = deferred<string>();
    await s.controller.load(detail);
    s.ids.next = () => id.promise;
    s.controller.openComposer();
    s.controller.setAuthorMode('named');
    s.controller.setText('Private draft');
    const publishing = s.controller.publish();
    await flush();
    invalidate(s);
    id.resolve(requestId);
    await publishing;
    assert.equal(s.pendingRatings.load(s.accountId), null);
    assert.equal(s.gateway.commands.length, 0);
    assert.equal(s.view().text, '');
    s.controller.dispose();
  }
});
test('hide after persisted send preserves original v9 bytes and ignores a late successful callback', async () => {
  const s = scopedHarness(),
    delayed = deferred<RatingScopedReceipt>();
  await s.controller.load(detail);
  s.gateway.commandWork = () => delayed.promise;
  s.controller.chooseScore(5);
  const publishing = s.controller.confirmScore();
  await flush();
  const pending = s.pendingRatings.load(s.accountId);
  assert.equal(pending?.version, 9);
  const bytes = JSON.stringify(pending);
  s.controller.dispose();
  delayed.resolve(scopedReceipt(s.gateway.commands[0]!));
  await publishing;
  assert.equal(JSON.stringify(s.pendingRatings.load(s.accountId)), bytes);
  assert.equal(s.view().loaded, false);
});
test('expired lease removes body and drafts without clearing persisted recovery and rejects late contexts', async () => {
  const s = scopedHarness();
  await s.controller.load(detail);
  s.controller.openComposer();
  s.controller.setText('Private draft');
  s.clock.advance(300_001);
  assert.equal(s.view().text, '');
  assert.equal(s.view().loaded, false);
  assert.equal(s.view().needsRefresh, true);
  const lease = new RatingScopedContextLease(
      s.sessions,
      () => undefined,
      s.clock,
    ),
    generation = lease.capture();
  lease.clear();
  assert.throws(() =>
    lease.accept(
      scopedContext(),
      { purpose: 'interact', mode: 'public', selector: { kind: 'global' } },
      generation,
    ),
  );
  lease.dispose();
  s.controller.dispose();
});
test('two normal context leases do not revoke each other and actor mismatch fails closed', () => {
  const s = scopedHarness(),
    first = new RatingScopedContextLease(s.sessions, () => undefined, s.clock),
    second = new RatingScopedContextLease(s.sessions, () => undefined, s.clock),
    request = {
      purpose: 'interact' as const,
      mode: 'public' as const,
      selector: { kind: 'global' as const },
    };
  first.accept(scopedContext(), request, first.capture());
  second.accept(scopedContext(), request, second.capture());
  assert.equal(first.current().id, second.current().id);
  assert.throws(() =>
    first.accept(
      { ...scopedContext(), actorId: otherId },
      request,
      first.capture(),
    ),
  );
  first.dispose();
  second.dispose();
  s.controller.dispose();
});
test('unknown fresh source leaves no journal and random is explicitly institution-with-global', async () => {
  const s = scopedHarness();
  s.gateway.contextWork = async () => {
    throw new ClientError('business', 'Unknown source', {
      serverCode: 'RATING_SCOPE_UNAVAILABLE',
    });
  };
  await s.controller.load(detail);
  assert.equal(s.view().loaded, false);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  let issued: RatingScopedContext | undefined;
  s.gateway.contextWork = async (request) => {
    issued = scopedContext(request);
    return issued;
  };
  await s.controller.load({
    mode: 'random',
    scope: 'campus',
    campusId: otherId,
    categoryId,
  });
  await s.controller.draw();
  assert.deepEqual(issued?.selector, {
    kind: 'institution_with_global',
    anchorCampusId: otherId,
  });
  assert.equal(s.view().randomResult?.candidateCount, 1);
  assert.match(s.controller.randomPath()!, /scope=global/);
  s.controller.dispose();
});
test('metadata-only notice uses explicit selector resolution and carries exact locator generation', async () => {
  const s = scopedHarness();
  await s.controller.load({
    mode: 'updates',
    scope: 'campus',
    campusId: otherId,
  });
  assert.deepEqual(s.gateway.calls, ['updates']);
  assert.equal(s.view().notices[0]?.status, 'unavailable');
  const path = await s.controller.noticePath(otherId);
  assert.ok(path?.includes(`campusId=${otherId}`));
  assert.ok(path?.includes(`protocolGeneration=${generation}`));
  assert.deepEqual(s.gateway.calls, [
    'updates',
    'context',
    'noticeTarget',
    'resolve',
  ]);
  s.controller.dispose();
});
test('M1/M2 cancel is original-intent-only without context warmup and needs explicit confirmation', async () => {
  for (const operation of [
    'create_target_scoped',
    'edit_target_scoped',
  ] as const) {
    const s = scopedHarness(),
      intent = scopedIntent(operation);
    s.pendingRatings.freeze({ version: 9, accountId: s.accountId, intent });
    await s.controller.load({});
    await s.controller.cancelPending();
    assert.equal(s.gateway.calls.includes('cancel'), false);
    s.controller.requestCancelPending();
    await s.controller.cancelPending();
    assert.deepEqual(s.gateway.calls, ['receipt', 'cancel']);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    s.controller.dispose();
  }
});

test('late unabortable detail responses cannot replace the newer page category or draft context', async () => {
  const s = scopedHarness(),
    delayed = deferred<ReturnType<typeof import('./ratings-helpers').target>>();
  const originalDetail = s.gateway.detail.bind(s.gateway);
  s.gateway.detail = () => delayed.promise;
  const first = s.controller.load(detail);
  await flush();
  s.gateway.detail = originalDetail;
  await s.controller.load({ ...detail, scope: 'campus', campusId: otherId });
  delayed.resolve({ ...target(), categoryId: otherId });
  await first;
  assert.equal(s.view().viewCampusId, otherId);
  s.controller.chooseScore(5);
  await s.controller.confirmScore();
  assert.deepEqual(s.gateway.commands[0]?.context.selector, {
    kind: 'campus',
    campusId: otherId,
  });
  assert.equal(s.gateway.commands[0]?.payload.categoryId, categoryId);
  s.controller.dispose();
});

test('reply locators cannot render a different root or target in an existing thread', async () => {
  for (const field of ['rootId', 'targetId'] as const) {
    const s = scopedHarness(),
      original = s.gateway.position.bind(s.gateway);
    s.gateway.position = async (context) => {
      const result = await original(context);
      return {
        ...result,
        page: {
          ...result.page,
          context: { ...result.page.context, [field]: otherId },
        },
      };
    };
    await s.controller.load({ ...thread, replyId });
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().replies.length, 0);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    s.controller.dispose();
  }
});

test('known likes for a different target cannot become a new scoped command', async () => {
  const s = scopedHarness(),
    original = s.gateway.commentLike.bind(s.gateway);
  s.gateway.commentLike = async (context) => ({
    ...(await original(context)),
    targetId: otherId,
  });
  await s.controller.load(detail);
  await s.controller.toggleLike(commentId);
  assert.equal(s.gateway.commands.length, 0);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  s.controller.dispose();
});

test('scope sections and native route snapshots keep the explicit selected campus without private context', async () => {
  const s = scopedHarness();
  await s.controller.load({ ...detail, scope: 'campus', campusId: otherId });
  for (const mode of ['catalog', 'updates', 'subscriptions'] as const)
    assert.match(
      s.controller.sectionPath(mode)!,
      new RegExp(`scope=campus&campusId=${otherId}`),
    );
  assert.deepEqual(s.controller.snapshotRoute(), {
    ...detail,
    scope: 'campus',
    campusId: otherId,
  });
  assert.equal(
    JSON.stringify(s.controller.snapshotRoute()).includes('token'),
    false,
  );
  await s.controller.selectCampus(null);
  assert.deepEqual(s.controller.snapshotRoute(), detail);
  s.controller.dispose();
});

test('historical recovery defers route validation without losing the requested scoped destination', async () => {
  const s = scopedHarness(),
    intent = scopedIntent();
  s.pendingRatings.freeze({ version: 9, accountId: s.accountId, intent });
  s.gateway.receiptWork = async () => scopedReceipt(intent);
  const route = { ...detail, scope: 'campus', campusId: otherId };
  await s.controller.load(route);
  assert.deepEqual(s.gateway.calls, ['receipt']);
  assert.equal(s.controller.snapshotRoute(), null);
  await s.controller.reload();
  assert.equal(s.view().loaded, true);
  assert.equal(s.view().viewCampusId, otherId);
  assert.deepEqual(s.controller.snapshotRoute(), route);
  s.controller.dispose();
});

test('random entry rejects a stale anchor generation before requesting candidates', async () => {
  const s = scopedHarness();
  await s.controller.load({
    mode: 'random',
    scope: 'campus',
    campusId: otherId,
    categoryId,
    protocolGeneration: generation,
  });
  await s.controller.draw();
  assert.deepEqual(s.gateway.calls, ['context']);
  assert.equal(s.view().randomResult, null);
  assert.match(s.view().error, /范围或来源已变化/);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  s.controller.dispose();
});

test('read and command leases accept purpose-specific revisions but require the same exact authority vector', () => {
  const read = scopedContext({
    purpose: 'read',
    selector: { kind: 'global' },
    mode: 'public',
  });
  const command = {
    ...scopedContext(),
    scopeRevision: 'e'.repeat(64),
    capabilities: ['interact'],
  };
  assert.notEqual(read.scopeRevision, command.scopeRevision);
  matchRatingScopedContextPair(read, command, 'interact');
  for (const patch of [
    { id: read.id },
    { actorId: otherId },
    { sessionGeneration: 'd'.repeat(64) },
    { identityCampusId: otherId },
    { sourceDigest: 'd'.repeat(64) },
    { protocolGeneration: otherId },
    { heads: [{ ...command.heads[0]!, headRevision: otherId }] },
    { heads: [{ ...command.heads[0]!, catalogRevision: otherId }] },
  ])
    assert.throws(() =>
      matchRatingScopedContextPair(read, { ...command, ...patch }, 'interact'),
    );
  assert.throws(() =>
    matchRatingScopedContextPair(read, command, 'create_target'),
  );
});

test('source or identity changes between separate context issuances clear the page before any read or draft commit', async () => {
  for (const field of [
    'sourceDigest',
    'identityCampusId',
    'sessionGeneration',
    'protocolGeneration',
    'headRevision',
  ] as const) {
    const s = scopedHarness();
    s.gateway.contextWork = async (request) => {
      const context = scopedContext(request);
      if (request.purpose === 'read') return context;
      if (field === 'headRevision')
        return {
          ...context,
          heads: [{ ...context.heads[0]!, headRevision: otherId }],
        };
      return {
        ...context,
        [field]:
          field === 'sourceDigest' || field === 'sessionGeneration'
            ? 'd'.repeat(64)
            : otherId,
      };
    };
    await s.controller.load({ mode: 'create', scope: 'global', categoryId });
    assert.equal(s.view().loaded, false, field);
    assert.equal(s.view().needsRefresh, true, field);
    assert.equal(s.clock.timers, 0, field);
    assert.deepEqual(s.gateway.calls, ['context', 'context']);
    s.controller.setDefinition('name', 'Must not publish');
    s.controller.confirmDefinition();
    await s.controller.commitDefinition();
    assert.equal(s.view().name, '');
    assert.equal(s.gateway.commands.length, 0);
    assert.equal(s.pendingRatings.load(s.accountId), null);
    s.controller.dispose();
  }
});

test('Close and either context deadline cancel both leases without silently reissuing either purpose', async () => {
  for (const close of ['composer', 'score', 'definition'] as const) {
    const s = scopedHarness();
    await s.controller.load(
      close === 'definition'
        ? { mode: 'create', scope: 'global', categoryId }
        : detail,
    );
    assert.equal(s.clock.timers, 2);
    if (close === 'composer') {
      s.controller.openComposer();
      s.controller.setText('Private');
      s.controller.closeComposer();
    } else if (close === 'score') {
      s.controller.chooseScore(5);
      s.controller.dismissScore();
    } else {
      s.controller.setDefinition('name', 'Private');
      s.controller.dismissDefinition();
    }
    assert.equal(s.clock.timers, 0);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().text, '');
    assert.equal(s.view().name, '');
    assert.equal(s.gateway.contextRequests.length, 2);
    s.controller.dispose();
  }
  for (const expiringPurpose of ['read', 'interact']) {
    const s = scopedHarness();
    s.gateway.contextWork = async (request) => {
      const context = scopedContext(request);
      return request.purpose === expiringPurpose
        ? {
            ...context,
            expiresAt: new Date(s.clock.now() + 1000).toISOString(),
          }
        : context;
    };
    await s.controller.load(detail);
    s.controller.openComposer();
    s.controller.setText('Private');
    s.clock.advance(1001);
    assert.equal(s.clock.timers, 0);
    assert.equal(s.view().loaded, false);
    assert.equal(s.view().text, '');
    await s.controller.publish();
    assert.equal(s.gateway.commands.length, 0);
    assert.equal(s.gateway.contextRequests.length, 2);
    s.controller.dispose();
  }
});

test('a delayed command-context issuance cannot survive Close or install a second lease later', async () => {
  const s = scopedHarness(),
    delayed = deferred<RatingScopedContext>();
  s.gateway.contextWork = async (request) =>
    request.purpose === 'read' ? scopedContext(request) : delayed.promise;
  const loading = s.controller.load(detail);
  await flush();
  assert.equal(s.clock.timers, 1);
  s.controller.cancel();
  delayed.resolve(scopedContext());
  await loading;
  assert.equal(s.clock.timers, 0);
  assert.equal(s.view().loaded, false);
  assert.equal(s.gateway.readContexts.length, 0);
  assert.equal(s.pendingRatings.load(s.accountId), null);
  s.controller.dispose();
});
