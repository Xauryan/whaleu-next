import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingCategoryIconGateway } from '../src/ratings/category-icon-gateway';
import { HttpCategoryIconMediaGateway } from '../src/ratings/category-icon-media-gateway';
import {
  categoryIconPrepareForScope,
  decodeCategoryIconScopeInput,
} from '../src/ratings/category-icon-upload-scope';
import { ratingCategoryScopedOperations } from '../src/ratings/category-scoped-contract';
import { ScriptedTransport, deferred, response } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  managedCampus,
  managementContext,
  managementIntent,
  flushManagement,
} from './category-scoped-helpers';
import {
  iconContext,
  iconIntent,
  iconPreparation,
  iconReceipt,
  iconCategory,
  iconId,
  mediaSnapshot,
} from './category-icon-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const api = new ApiClient('https://ratings.example', transport, sessions, {
    refresh: async () =>
      sessions.rotate(sessions.snapshot(), wireCredentials('b')),
  });
  return {
    sessions,
    transport,
    gateway: new HttpRatingCategoryIconGateway(api, sessions),
    media: new HttpCategoryIconMediaGateway(api),
  };
}
test('new management entry accepts only explicit icon or proved legacy union and strict routes', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    selector = { kind: 'campus' as const, campusId: managedCampus };
  s.transport.reply({ kind: 'legacy', context: managementContext() });
  assert.equal((await s.gateway.entryContext(selector, cancel)).kind, 'legacy');
  s.transport.reply({ kind: 'icon', context: iconContext() });
  const entry = await s.gateway.entryContext(selector, cancel);
  assert.equal(entry.kind, 'icon');
  const context = iconContext();
  s.transport.reply({
    items: [iconCategory()],
    snapshotRevision: context.snapshotRevision,
    mediaSnapshot,
    complete: true,
  });
  await s.gateway.categories(context, cancel);
  assert.deepEqual(
    s.transport.requests.map((r) => new URL(r.url).pathname),
    [
      '/v5/ratings/category-management/entry-context',
      '/v5/ratings/category-management/entry-context',
      '/v5/ratings/category-management/categories',
    ],
  );
  s.transport.reply({ kind: 'legacy', context: iconContext() });
  await assert.rejects(s.gateway.entryContext(selector, cancel));
});
test('every original operation prepares commits cancels and recovers exact protocol5 without v2 replay', async () => {
  for (const operation of ratingCategoryScopedOperations) {
    const s = setup(),
      cancel = new Cancellation(),
      intent = iconIntent(operation),
      prepared = iconPreparation(intent);
    s.transport.reply(prepared);
    await s.gateway.prepare(intent, cancel);
    s.transport.reply(iconReceipt(intent));
    await s.gateway.commit(intent, prepared, cancel);
    s.transport.reply(iconReceipt(intent, 'closed'));
    await s.gateway.cancel(intent, cancel);
    s.transport.reply(iconReceipt(intent));
    await s.gateway.receipt(intent.payload.clientRequestId, cancel);
    assert.deepEqual(
      s.transport.requests.map((r) => new URL(r.url).pathname),
      [
        '/v5/ratings/category-management/prepare',
        '/v5/ratings/category-management/commit',
        '/v5/ratings/category-management/cancel',
        `/v5/ratings/requests/${intent.payload.clientRequestId}`,
      ],
    );
    assert.deepEqual(s.transport.requests[1]!.body, {
      intent,
      preparationContextRevision: prepared.contextRevision,
    });
    assert.deepEqual(s.transport.requests[2]!.body, intent);
  }
});
test('late account callback and mismatched context mediaSnapshot cannot publish state', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply({
    items: [],
    snapshotRevision: iconContext().snapshotRevision,
    mediaSnapshot: 'f'.repeat(64),
    complete: true,
  });
  await assert.rejects(s.gateway.categories(iconContext(), cancel));
  const pending = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => pending.promise);
  const work = s.gateway.prepare(iconIntent(), cancel);
  await flushManagement();
  s.sessions.completeLogin(
    s.sessions.beginLogin(),
    wireCredentials('replacement'),
  );
  pending.resolve(response(iconPreparation()));
  await assert.rejects(work, { kind: 'stale-session' });
});
test('owner scope unknown recovery and cancellation preserve independent owner hash', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    text = managementIntent(),
    input = decodeCategoryIconScopeInput({
      ...text,
      protocolVersion: 5,
      mediaSnapshot,
      clientRequestId: iconId(10),
      draftRevision: iconId(11),
      slot: {
        kind: 'base',
        categoryId:
          'categoryId' in text.payload ? text.payload.categoryId : iconId(12),
      },
      declaration: { mime: 'image/png', bytes: 4, sha256: 'a'.repeat(64) },
    }),
    scope = {
      editScopeId: iconId(13),
      scopeRevision: 'b'.repeat(64),
      categoryId:
        'categoryId' in text.payload ? text.payload.categoryId : iconId(12),
      identityId: iconId(14),
      expiresAt: iconContext().expiresAt,
    },
    session = { current: () => s.sessions.snapshot() };
  s.transport.reply(scope);
  assert.deepEqual(await s.media.scope(input, session, cancel), scope);
  assert.equal(categoryIconPrepareForScope(input, scope).slot, 'icon');
  s.transport.reply({ state: 'unknown', scope: null, recovery: null });
  assert.equal(
    (
      await s.media.recoverScope(
        input.clientRequestId,
        'c'.repeat(64),
        session,
        cancel,
      )
    ).state,
    'unknown',
  );
  s.transport.reply({ state: 'cancelled', scope: null, recovery: null });
  await s.media.cancelScope(
    input.clientRequestId,
    'c'.repeat(64),
    session,
    cancel,
  );
  assert.deepEqual(s.transport.requests[2]!.body, {
    clientRequestId: input.clientRequestId,
    requestHash: 'c'.repeat(64),
  });
  assert.equal(
    JSON.stringify(s.transport.requests[2]!.body).includes('context'),
    false,
  );
});
