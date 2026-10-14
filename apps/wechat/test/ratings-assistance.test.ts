import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  AssistanceController,
  initialAssistanceView,
} from '../src/ratings/assistance-controller';
import {
  ASSISTANCE_BODY_BUDGET,
  ASSISTANCE_PROFILE,
  assistanceIntentHash,
  decodeAssistanceRequest,
  decodeAssistanceResult,
  type AssistanceInput,
  type AssistanceMetadata,
  type AssistanceRequest,
  type AssistanceResult,
} from '../src/ratings/assistance-contract';
import type { AssistanceGateway } from '../src/ratings/assistance-gateway';
import {
  decodePendingAssistance,
  PendingAssistanceStore,
} from '../src/ratings/assistance-pending';
import { canonicalRatingScopedJson } from '../src/ratings/scoped-contract';
import { ratingCategoryScopedJsonByteLength } from '../src/ratings/category-scoped-contract';
import { setup } from './community-helpers';
import { categoryTestId } from './category-management-helpers';
import { managementContext, managedSnapshot } from './category-scoped-helpers';
import { deferred, FakeClock, flush } from './helpers';
import { wireCredentials } from './identity-helpers';
const description = '探索校园精彩评分分类';
export function assistanceInput(): AssistanceInput {
  const context = managementContext({ kind: 'global' }).commandContext;
  return {
    purpose: 'category_description',
    selector: context.selector,
    context,
    payload: {
      operation: 'create_categories_scoped',
      parentId: null,
      draftNodeKey: 'root',
      name: '校园评分',
      placement: { kind: 'global' },
      expectedSnapshot: managedSnapshot,
    },
  };
}
export function assistanceHarness() {
  const s = setup(),
    clock = new FakeClock(),
    calls: string[] = [],
    requests: AssistanceRequest[] = [];
  let last: AssistanceRequest | null = null,
    outcome: AssistanceMetadata['outcome'] = 'generated',
    view = initialAssistanceView(),
    adopted = '',
    id = 1400;
  const metadata = (): AssistanceMetadata => ({
    version: 1,
    requestId: last!.requestId,
    purpose: last!.purpose,
    intentHash: assistanceIntentHash(last!),
    outcome,
  });
  const result = (): AssistanceResult => ({
    status: 'available',
    version: 1,
    actorId: s.accountId,
    requestId: last!.requestId,
    purpose: last!.purpose,
    draftId: last!.draftId,
    inputRevision: last!.inputRevision,
    intentHash: assistanceIntentHash(last!),
    inputDigest: 'a'.repeat(64),
    resultId: categoryTestId(1500),
    resultDigest: createHash('sha256')
      .update(`whaleu:ratings:assistance:result:v1\n${description}`)
      .digest('hex'),
    profileRevision: ASSISTANCE_PROFILE,
    outputContract: 1,
    text: description,
    expiresAt: new Date(clock.now() + 100_000).toISOString(),
  });
  const gateway: AssistanceGateway = {
    create: async (request) => {
      calls.push('create');
      last = request;
      requests.push(request);
      return metadata();
    },
    status: async (requestId) => {
      calls.push(`status:${requestId}`);
      return metadata();
    },
    result: async (requestId) => {
      calls.push(`result:${requestId}`);
      return result();
    },
    cancel: async (request) => {
      calls.push(`cancel:${request.requestId}`);
      outcome = 'cancelled';
      return metadata();
    },
  };
  const pendingAssistance = new PendingAssistanceStore(
      s.storage,
      'assistance-synthetic',
    ),
    runtime = {
      ...s.runtime,
      pendingAssistance,
      assistance: gateway,
      newRequestId: async () => categoryTestId(id++),
    };
  const controller = new AssistanceController(
    runtime,
    (next) => {
      view = next;
    },
    () => true,
    clock,
  );
  return {
    ...s,
    clock,
    runtime,
    controller,
    gateway,
    pendingAssistance,
    calls,
    requests,
    result,
    metadata,
    view: () => view,
    adopted: () => adopted,
    adopt: () =>
      controller.adopt((text) => {
        adopted = text;
      }),
    outcome: (next: AssistanceMetadata['outcome']) => {
      outcome = next;
    },
  };
}
test('full 1000-campus exact placement fits real context plus reserve; no truncation and immutable hash domain', () => {
  const input = assistanceInput();
  assert.equal(input.purpose, 'category_description');
  const request = decodeAssistanceRequest({
    ...input,
    version: 1,
    requestId: categoryTestId(2000),
    draftId: categoryTestId(2001),
    inputRevision: 4,
    payload: {
      ...input.payload,
      placement: {
        kind: 'campuses',
        campusIds: Array.from({ length: 1000 }, (_, i) =>
          categoryTestId(i + 3000),
        ).sort(),
      },
    },
  });
  assert.ok(
    ratingCategoryScopedJsonByteLength(request) < ASSISTANCE_BODY_BUDGET,
  );
  assert.equal(
    assistanceIntentHash(request),
    createHash('sha256')
      .update(
        `whaleu:ratings:assistance:intent:v1\n${canonicalRatingScopedJson(request)}`,
      )
      .digest('hex'),
  );
  assert.throws(() =>
    decodeAssistanceRequest({ ...request, provider: 'invented' }),
  );
  for (const name of [
    ' leading',
    'x\ny',
    'x\ty',
    'x\u2028y',
    'x\u202ey',
    '\ud800',
    '界'.repeat(101),
  ])
    assert.throws(() =>
      decodeAssistanceRequest({
        ...request,
        payload: { ...request.payload, name },
      }),
    );
  assert.throws(() =>
    decodeAssistanceRequest({
      ...request,
      payload: { ...request.payload, parentId: categoryTestId(9000) },
    }),
  );
});
test('generation preview never adopts; explicit adoption rereads exact current result; metadata journal has no plaintext', async () => {
  const s = assistanceHarness();
  await s.controller.generate(assistanceInput());
  assert.equal(s.view().preview, description);
  assert.equal(s.adopted(), '');
  const pending = s.pendingAssistance.load(s.accountId)!;
  assert.equal(pending.kind, 'rating_assistance_v1');
  const saved = JSON.stringify([...s.storage.data.values()]);
  for (const forbidden of [
    description,
    '校园评分',
    'context',
    'token',
    'payload',
  ])
    assert.ok(!saved.includes(forbidden));
  assert.throws(() =>
    decodePendingAssistance({ ...pending, text: description }, s.accountId),
  );
  assert.throws(() =>
    decodePendingAssistance(
      { ...pending, metadata: { ...pending.metadata, name: 'private' } },
      s.accountId,
    ),
  );
  await s.adopt();
  assert.equal(s.adopted(), description);
  assert.equal(s.calls.filter((call) => call.startsWith('result:')).length, 2);
  assert.equal(s.pendingAssistance.load(s.accountId), null);
  s.controller.dispose();
});
test('newer typing while adoption read is pending clears plaintext and cannot overwrite the field', async () => {
  const s = assistanceHarness();
  await s.controller.generate(assistanceInput());
  const held = deferred<AssistanceResult>();
  s.gateway.result = async () => held.promise;
  const adopting = s.adopt();
  await flush();
  s.controller.invalidate();
  held.resolve(s.result());
  await adopting;
  assert.equal(s.adopted(), '');
  assert.equal(s.view().preview, '');
  assert.ok(s.pendingAssistance.load(s.accountId));
  s.controller.dispose();
});
test('create response loss preserves original key; status and cancel never allocate or resubmit a request', async () => {
  const s = assistanceHarness(),
    create = s.gateway.create;
  s.outcome('queued');
  s.gateway.create = async (request, cancel) => {
    await create(request, cancel);
    throw new ClientError('timeout', 'Response lost');
  };
  await s.controller.generate(assistanceInput());
  const original = s.pendingAssistance.load(s.accountId)!;
  await s.controller.generate(assistanceInput());
  assert.equal(s.requests.length, 1);
  await s.controller.recover();
  assert.ok(s.calls.includes(`status:${original.requestId}`));
  await s.controller.cancel();
  assert.ok(s.calls.includes(`cancel:${original.requestId}`));
  assert.equal(s.pendingAssistance.load(s.accountId)?.state, 'terminal');
  s.controller.dismiss();
  assert.equal(s.pendingAssistance.load(s.accountId), null);
  s.controller.dispose();
});
test('hide/rebuild recovers metadata without restoring plaintext or requesting an orphan result', async () => {
  const s = assistanceHarness();
  await s.controller.generate(assistanceInput());
  s.controller.dispose();
  const count = s.calls.length;
  let view = initialAssistanceView();
  const restarted = new AssistanceController(
    s.runtime,
    (value) => {
      view = value;
    },
    () => true,
    s.clock,
  );
  await restarted.recover();
  assert.equal(view.preview, '');
  assert.equal(
    s.calls.slice(count).filter((call) => call.startsWith('result:')).length,
    0,
  );
  assert.equal(view.canDismiss, true);
  restarted.dispose();
});
test('new account, relogin, expiry and malformed output all invalidate plaintext independently of publication', async () => {
  const s = assistanceHarness();
  await s.controller.generate(assistanceInput());
  const before = s.result();
  assert.equal(before.status, 'available');
  for (const bad of [
    { ...before, text: 'https://bad.invalid' },
    { ...before, resultDigest: 'f'.repeat(64) },
    { ...before, approval: true },
    { ...before, text: '不足' },
  ])
    assert.throws(() => decodeAssistanceResult(bad));
  s.clock.advance(100001);
  assert.equal(s.view().preview, '');
  s.sessions.completeLogin(s.sessions.beginLogin(), wireCredentials('b'));
  assert.equal(s.view().preview, '');
  assert.ok(s.pendingAssistance.load(s.accountId));
  s.controller.dispose();
});
test('default unavailable generation leaves manual path untouched and cannot be adopted', async () => {
  const s = assistanceHarness();
  s.outcome('unavailable');
  await s.controller.generate(assistanceInput());
  assert.equal(s.view().preview, '');
  assert.equal(s.view().canAdopt, false);
  assert.equal(s.adopted(), '');
  assert.equal(s.calls.length, 1);
  assert.equal(s.runtime.pending.load(s.accountId), null);
  s.controller.dispose();
});
test('a denied or malformed fresh adoption read immediately discards cached suggestion plaintext', async () => {
  for (const failure of [
    new ClientError('business', 'Source revoked'),
    new ClientError('protocol', 'Malformed current result'),
  ]) {
    const s = assistanceHarness();
    await s.controller.generate(assistanceInput());
    s.gateway.result = async () => {
      throw failure;
    };
    await s.adopt();
    assert.equal(s.adopted(), '');
    assert.equal(s.view().preview, '');
    assert.equal(s.view().canAdopt, false);
    assert.ok(s.pendingAssistance.load(s.accountId));
    s.controller.dispose();
  }
});
