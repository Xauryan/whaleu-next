import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiClient } from '../src/api/client';
import { SessionStore } from '../src/auth/session';
import { Cancellation } from '../src/platform/contracts';
import { HttpRatingTargetOwnerEditingGateway } from '../src/ratings/target-owner-editing-gateway';
import { deferred, flush, response, ScriptedTransport } from './helpers';
import { wireCredentials } from './identity-helpers';
import { otherId, requestId, revision, targetId } from './ratings-helpers';
import {
  cancelledEditingReceipt,
  definitionRevision,
  editingContext,
  editingIntent,
  editingPreparation,
  editingReceipt,
} from './rating-owner-editing-helpers';

const prefix = '/v1/ratings/management/owner-edit';
function setup() {
  const sessions = new SessionStore(),
    transport = new ScriptedTransport();
  sessions.completeLogin(sessions.beginLogin(), wireCredentials());
  const gateway = new HttpRatingTargetOwnerEditingGateway(
    new ApiClient('https://ratings.example', transport, sessions, {
      refresh: async () =>
        sessions.rotate(sessions.snapshot(), wireCredentials('b')),
    }),
    sessions,
  );
  return { transport, sessions, gateway };
}

test('editing uses exact authenticated context, original prepare/commit, historical receipt and explicit cancellation endpoints', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(editingContext());
  assert.deepEqual(await s.gateway.context(targetId, cancel), editingContext());
  s.transport.reply(editingPreparation());
  s.transport.reply(editingReceipt());
  assert.deepEqual(
    await s.gateway.command(editingIntent(), cancel),
    editingReceipt(),
  );
  s.transport.reply(editingReceipt());
  assert.deepEqual(
    await s.gateway.receipt(requestId, cancel),
    editingReceipt(),
  );
  s.transport.reply(cancelledEditingReceipt());
  assert.deepEqual(
    await s.gateway.cancel(editingIntent(), cancel),
    cancelledEditingReceipt(),
  );
  assert.deepEqual(
    s.transport.requests.map((r) => [r.method, new URL(r.url).pathname]),
    [
      ['GET', `${prefix}/targets/${targetId}/context`],
      ['POST', `${prefix}/prepare`],
      ['POST', `${prefix}/commit`],
      ['GET', `${prefix}/requests/${requestId}`],
      ['POST', `${prefix}/cancel`],
    ],
  );
  assert.equal(s.transport.requests[0]!.body, undefined);
  assert.equal(s.transport.requests[3]!.body, undefined);
  assert.deepEqual(s.transport.requests[1]!.body, editingIntent().payload);
  assert.deepEqual(s.transport.requests[2]!.body, {
    ...editingIntent().payload,
    expectedContextRevision: editingPreparation().contextRevision,
  });
  assert.deepEqual(s.transport.requests[4]!.body, editingIntent().payload);
  for (const request of s.transport.requests) {
    assert.equal(new URL(request.url).search, '');
    assert.equal(
      request.headers.Authorization,
      `Bearer ${wireCredentials().accessToken}`,
    );
  }
});

test('invalid locator/intent never dispatches and cross-target, noncanonical or augmented context fails closed', async () => {
  const s = setup(),
    cancel = new Cancellation();
  await assert.rejects(() => s.gateway.context('invalid', cancel));
  await assert.rejects(() => s.gateway.receipt('invalid', cancel));
  await assert.rejects(() =>
    s.gateway.command(
      {
        ...editingIntent(),
        payload: {
          ...editingIntent().payload,
          expectedTargetRevision: 'invalid',
        },
      },
      cancel,
    ),
  );
  assert.equal(s.transport.requests.length, 0);
  for (const patch of [
    { targetId: otherId },
    { name: ' noncanonical ' },
    { creatorId: otherId },
    { contentVersion: 0 },
  ]) {
    s.transport.reply({ ...editingContext(), ...patch });
    await assert.rejects(() => s.gateway.context(targetId, cancel), {
      kind: 'protocol',
    });
  }
});

test('every mismatched preparation blocks commit, including unchanged revisions, version jumps and private fields', async () => {
  for (const patch of [
    { requestId: otherId },
    { targetId: otherId },
    { revision },
    { definitionRevision },
    { contentVersion: 3 },
    { contentVersion: 5 },
    { name: 'private' },
    { contextRevision: 'invalid' },
  ]) {
    const s = setup();
    s.transport.reply({ ...editingPreparation(), ...patch });
    await assert.rejects(
      () => s.gateway.command(editingIntent(), new Cancellation()),
      { kind: 'protocol' },
    );
    assert.equal(s.transport.requests.length, 1);
  }
});

test('applied commit must equal the reserved after tuple; noop must equal the original before tuple', async () => {
  for (const patch of [
    { requestId: otherId },
    { targetId: otherId },
    { revision: otherId },
    { definitionRevision: otherId },
    { contentVersion: 5 },
    { name: 'private' },
  ]) {
    const s = setup();
    s.transport.reply(editingPreparation());
    s.transport.reply({ ...editingReceipt(), ...patch });
    await assert.rejects(
      () => s.gateway.command(editingIntent(), new Cancellation()),
      { kind: 'protocol' },
    );
    assert.equal(s.transport.requests.length, 2);
  }
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(editingPreparation());
  s.transport.reply(editingReceipt('noop'));
  assert.deepEqual(
    await s.gateway.command(editingIntent(), cancel),
    editingReceipt('noop'),
  );
  for (const patch of [
    { revision: otherId },
    { definitionRevision: otherId },
    { contentVersion: 4 },
  ]) {
    s.transport.reply(editingPreparation());
    s.transport.reply({ ...editingReceipt('noop'), ...patch });
    await assert.rejects(() => s.gateway.command(editingIntent(), cancel), {
      kind: 'protocol',
    });
  }
});

test('prepare returns validated durable rejection without commit; success history stays on commit/receipt', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(cancelledEditingReceipt());
  assert.deepEqual(
    await s.gateway.prepare(editingIntent(), cancel),
    cancelledEditingReceipt(),
  );
  s.transport.reply(cancelledEditingReceipt());
  assert.deepEqual(
    await s.gateway.command(editingIntent(), cancel),
    cancelledEditingReceipt(),
  );
  assert.equal(s.transport.requests.length, 2);
  for (const value of [
    { ...cancelledEditingReceipt(), requestId: otherId },
    { ...cancelledEditingReceipt(), name: 'private' },
    { ...cancelledEditingReceipt(), code: 'RATING_UNAVAILABLE' },
    editingReceipt(),
    editingReceipt('noop'),
  ]) {
    s.transport.reply(value);
    await assert.rejects(() => s.gateway.prepare(editingIntent(), cancel), {
      kind: 'protocol',
    });
  }
  assert.equal(
    s.transport.requests.every(
      (r) => new URL(r.url).pathname === `${prefix}/prepare`,
    ),
    true,
  );
});

test('standalone preparation is never reused directly; a new session re-prepares the same key before durable context rejection', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(editingPreparation());
  await s.gateway.prepare(editingIntent(), cancel);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    sessionId: otherId,
  });
  const rejected = {
    ...cancelledEditingReceipt(),
    code: 'RATING_EDIT_CONTEXT_CHANGED' as const,
  };
  s.transport.reply(editingPreparation());
  s.transport.reply(rejected);
  assert.deepEqual(await s.gateway.command(editingIntent(), cancel), rejected);
  assert.deepEqual(
    s.transport.requests.map((r) => new URL(r.url).pathname),
    [`${prefix}/prepare`, `${prefix}/prepare`, `${prefix}/commit`],
  );
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[1]!.body,
  );
  assert.deepEqual(s.transport.requests[2]!.body, {
    ...editingIntent().payload,
    expectedContextRevision: editingPreparation().contextRevision,
  });
  assert.equal(
    s.transport.requests[1]!.headers.Authorization,
    `Bearer ${wireCredentials('b').accessToken}`,
  );
});

test('a new account, same-account login or cancellation between prepare and commit forbids old-context publication', async () => {
  for (const stop of ['account', 'same-account', 'cancel'] as const) {
    const s = setup(),
      cancel = new Cancellation();
    const prepare = s.gateway.prepare.bind(s.gateway);
    s.gateway.prepare = async (...args) => {
      const result = await prepare(...args);
      if (stop === 'cancel') cancel.cancel();
      else
        s.sessions.completeLogin(
          s.sessions.beginLogin(),
          stop === 'account'
            ? { ...wireCredentials('b'), accountId: otherId }
            : wireCredentials('b'),
        );
      return result;
    };
    s.transport.reply(editingPreparation());
    await assert.rejects(() => s.gateway.command(editingIntent(), cancel), {
      kind: stop === 'cancel' ? 'cancelled' : 'stale-session',
    });
    assert.equal(s.transport.requests.length, 1);
  }
});

test('lost prepare or commit responses re-prepare the same frozen key/text and replay its stable preparation tuple', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.steps.push(async () => {
    throw new Error('lost prepare');
  });
  await assert.rejects(() => s.gateway.command(editingIntent(), cancel));
  s.transport.reply(editingPreparation());
  s.transport.steps.push(async () => {
    throw new Error('lost commit');
  });
  await assert.rejects(() => s.gateway.command(editingIntent(), cancel));
  s.transport.reply(editingPreparation());
  s.transport.reply(editingReceipt());
  assert.deepEqual(
    await s.gateway.command(editingIntent(), cancel),
    editingReceipt(),
  );
  for (const index of [0, 1, 3])
    assert.deepEqual(
      s.transport.requests[index]!.body,
      editingIntent().payload,
    );
  assert.deepEqual(s.transport.requests[2]!.body, {
    ...editingIntent().payload,
    expectedContextRevision: editingPreparation().contextRevision,
  });
  assert.deepEqual(s.transport.requests[4]!.body, {
    ...editingIntent().payload,
    expectedContextRevision: editingPreparation().contextRevision,
  });
});

test('mutating caller text while prepare is pending cannot alter the frozen original commit payload', async () => {
  const s = setup(),
    cancel = new Cancellation(),
    result = deferred<ReturnType<typeof response>>();
  const raw = { ...editingIntent(), payload: { ...editingIntent().payload } };
  s.transport.steps.push(async () => result.promise);
  s.transport.reply(editingReceipt());
  const work = s.gateway.command(raw, cancel);
  await flush();
  raw.payload.name = 'Changed after dispatch';
  raw.payload.description = 'Changed after dispatch';
  result.resolve(response(editingPreparation()));
  await work;
  assert.deepEqual(s.transport.requests[0]!.body, editingIntent().payload);
  assert.deepEqual(s.transport.requests[1]!.body, {
    ...editingIntent().payload,
    expectedContextRevision: editingPreparation().contextRevision,
  });
});

test('HTTP business errors, unavailable sources and absent receipts never manufacture terminal outcomes', async () => {
  for (const phase of ['prepare', 'commit'] as const) {
    for (const [status, code] of [
      [404, 'RATING_NOT_FOUND'],
      [409, 'RATING_EDIT_CONTEXT_CHANGED'],
      [403, 'PHONE_VERIFICATION_REQUIRED'],
      [403, 'SAFETY_ACTION_RESTRICTED'],
      [503, 'CONTENT_REVIEW_UNAVAILABLE'],
      [503, 'VERIFICATION_UNAVAILABLE'],
      [503, 'SAFETY_UNAVAILABLE'],
      [503, 'RATING_UNAVAILABLE'],
      [500, 'INTERNAL_ERROR'],
    ] as const) {
      const s = setup();
      if (phase === 'commit') s.transport.reply(editingPreparation());
      s.transport.reply(
        { error: { code, message: 'synthetic uncertain result' } },
        status,
      );
      await assert.rejects(() =>
        s.gateway.command(editingIntent(), new Cancellation()),
      );
      assert.equal(s.transport.requests.length, phase === 'prepare' ? 1 : 2);
    }
  }
  const s = setup();
  s.transport.reply(
    { error: { code: 'REQUEST_NOT_FOUND', message: 'missing' } },
    404,
  );
  await assert.rejects(() => s.gateway.receipt(requestId, new Cancellation()));
});

test('receipt/cancel exact-key matching and explicit cancellation preserve prior applied/noop precedence', async () => {
  const s = setup(),
    cancel = new Cancellation();
  for (const result of [
    editingReceipt(),
    editingReceipt('noop'),
    cancelledEditingReceipt(),
  ]) {
    s.transport.reply(result);
    assert.deepEqual(await s.gateway.cancel(editingIntent(), cancel), result);
  }
  for (const request of s.transport.requests) {
    assert.equal(new URL(request.url).pathname, `${prefix}/cancel`);
    assert.deepEqual(request.body, editingIntent().payload);
  }
  s.transport.reply({ ...editingReceipt(), requestId: otherId });
  await assert.rejects(() => s.gateway.receipt(requestId, cancel), {
    kind: 'protocol',
  });
  s.transport.reply({ ...cancelledEditingReceipt(), requestId: otherId });
  await assert.rejects(() => s.gateway.cancel(editingIntent(), cancel), {
    kind: 'protocol',
  });
  s.transport.steps.push(async () => {
    throw new Error('lost cancellation');
  });
  await assert.rejects(() => s.gateway.cancel(editingIntent(), cancel));
  s.transport.reply(editingReceipt());
  assert.deepEqual(
    await s.gateway.cancel(editingIntent(), cancel),
    editingReceipt(),
  );
  assert.deepEqual(
    s.transport.requests[s.transport.requests.length - 2]!.body,
    s.transport.requests[s.transport.requests.length - 1]!.body,
  );
});

test('an already completed edit may replay historical success after a new same-account session prepares its stable original key', async () => {
  const s = setup(),
    cancel = new Cancellation();
  s.transport.reply(editingPreparation());
  s.transport.reply(editingReceipt());
  await s.gateway.command(editingIntent(), cancel);
  s.sessions.completeLogin(s.sessions.beginLogin(), {
    ...wireCredentials('b'),
    sessionId: otherId,
  });
  s.transport.reply(editingPreparation());
  s.transport.reply(editingReceipt());
  assert.deepEqual(
    await s.gateway.command(editingIntent(), cancel),
    editingReceipt(),
  );
  assert.deepEqual(
    s.transport.requests[0]!.body,
    s.transport.requests[2]!.body,
  );
  assert.deepEqual(
    s.transport.requests[1]!.body,
    s.transport.requests[3]!.body,
  );
  assert.equal(
    new URL(s.transport.requests[2]!.url).pathname,
    `${prefix}/prepare`,
  );
  assert.equal(
    new URL(s.transport.requests[3]!.url).pathname,
    `${prefix}/commit`,
  );
});
