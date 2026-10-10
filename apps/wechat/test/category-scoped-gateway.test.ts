import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingCategoryScopedGateway } from '../src/ratings/category-scoped-gateway';
import {
  ratingCategoryScopedOperations,
  ratingCategoryScopedRequestBodyBytes,
  ratingCategoryScopedCommitEnvelope,
} from '../src/ratings/category-scoped-contract';
import { deferred, ScriptedTransport, response } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  managedCampus,
  managedCategories,
  managedId,
  managedSnapshot,
  managementContext,
  managementIntent,
  managementPreparation,
  managementReceipt,
  flushManagement,
} from './category-scoped-helpers';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpRatingCategoryScopedGateway(
    new ApiClient('https://ratings.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
    sessions,
  );
  return { sessions, transport, gateway };
}
test('management context/list/detail/history/system reads use exact authenticated v2 routes and immutable context query', async () => {
  const s = setup(),
    c = new Cancellation(),
    context = managementContext();
  s.transport.reply(context);
  await s.gateway.context({ kind: 'campus', campusId: managedCampus }, c);
  s.transport.reply({
    items: managedCategories(),
    snapshotRevision: managedSnapshot,
    complete: true,
  });
  await s.gateway.categories(context, c);
  s.transport.reply(managedCategories()[0]);
  await s.gateway.category(context, managedId, c);
  s.transport.reply({ items: [], nextCursor: null });
  await s.gateway.history(context, managedId, null, c);
  s.transport.reply({ items: [] });
  await s.gateway.systemOptions(context, c);
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['POST', '/v2/ratings/category-management/contexts'],
      ['GET', '/v2/ratings/category-management/categories'],
      ['GET', `/v2/ratings/category-management/categories/${managedId}`],
      [
        'GET',
        `/v2/ratings/category-management/categories/${managedId}/history`,
      ],
      ['GET', '/v2/ratings/category-management/system-options'],
    ],
  );
  assert.deepEqual(s.transport.requests[0]!.body, {
    selector: { kind: 'campus', campusId: managedCampus },
  });
  for (const request of s.transport.requests.slice(1)) {
    assert.equal(
      new URL(request.url).searchParams.get('contextId'),
      context.commandContext.id,
    );
    assert.equal(
      new URL(request.url).searchParams.get('contextToken'),
      context.commandContext.token,
    );
  }
  for (const request of s.transport.requests)
    assert.ok(request.headers.Authorization);
});
test('all nine prepare→commit/cancel intents use the same strict boundary and historical receipt route', async () => {
  for (const operation of ratingCategoryScopedOperations) {
    const s = setup(),
      c = new Cancellation(),
      intent = managementIntent(operation),
      prepared = managementPreparation(intent);
    s.transport.reply(prepared);
    await s.gateway.prepare(intent, c);
    assert.equal(s.transport.requests.length, 1);
    s.transport.reply(managementReceipt(intent));
    await s.gateway.commit(intent, prepared, c);
    s.transport.reply(managementReceipt(intent, 'closed'));
    await s.gateway.cancel(intent, c);
    s.transport.reply(managementReceipt(intent));
    await s.gateway.receipt(intent.payload.clientRequestId, c);
    assert.deepEqual(
      s.transport.requests.map((r) => new URL(r.url).pathname),
      [
        '/v2/ratings/category-management/prepare',
        '/v2/ratings/category-management/commit',
        '/v2/ratings/category-management/cancel',
        `/v2/ratings/requests/${intent.payload.clientRequestId}`,
      ],
    );
    assert.deepEqual(s.transport.requests[0]!.body, intent);
    assert.deepEqual(
      s.transport.requests[1]!.body,
      ratingCategoryScopedCommitEnvelope(intent, prepared.contextRevision),
    );
    const sizes = ratingCategoryScopedRequestBodyBytes(intent);
    assert.equal(
      Buffer.byteLength(JSON.stringify(s.transport.requests[0]!.body), 'utf8'),
      sizes.prepare,
    );
    assert.equal(
      Buffer.byteLength(JSON.stringify(s.transport.requests[1]!.body), 'utf8'),
      sizes.commit,
    );
    assert.equal(
      Buffer.byteLength(JSON.stringify(s.transport.requests[2]!.body), 'utf8'),
      sizes.cancel,
    );
    assert.equal(s.transport.requests[3]!.body, undefined);
    assert.equal(sizes.status, 0);
    assert.deepEqual(s.transport.requests[2]!.body, intent);
  }
});
test('wrong management scope, incomplete snapshot, request/hash mismatches and stale-session results fail closed', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(managementContext({ kind: 'global' }));
  await assert.rejects(
    s.gateway.context({ kind: 'campus', campusId: managedCampus }, cancel),
    { kind: 'protocol' },
  );
  s.transport.reply({
    items: managedCategories(),
    snapshotRevision: 'f'.repeat(64),
    complete: true,
  });
  await assert.rejects(s.gateway.categories(managementContext(), cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ ...managementReceipt(), intentHash: 'f'.repeat(64) });
  await assert.rejects(
    s.gateway.commit(managementIntent(), managementPreparation(), cancel),
    { kind: 'protocol' },
  );
  const wait = deferred<ReturnType<typeof response>>();
  s.transport.steps.push(() => wait.promise);
  const work = s.gateway.prepare(managementIntent(), cancel);
  await flushManagement();
  s.sessions.completeLogin(
    s.sessions.beginLogin(),
    wireCredentials('replacement'),
  );
  wait.resolve(response(managementPreparation()));
  await assert.rejects(work, { kind: 'stale-session' });
});
