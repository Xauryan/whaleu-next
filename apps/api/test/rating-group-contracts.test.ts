import { committedUnitPermitCapsule } from './support/final-proof-stamp.js';
import { issueRatingGroupPermit } from '../src/notifications/rating-group/permit.js';
import { setTimeout as delay } from 'node:timers/promises';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  campaignInput,
  commandHash,
  deterministicCopy,
  digest,
  effectIdentity,
  effectKey,
  nativeLocator,
  qualifiedLiteral,
  type Command,
  type EffectIdentity,
  type Evidence,
} from '../src/ratings/group-promotion/contracts.js';
import { exactEvidence } from '../src/notifications/rating-group/repository.js';
import {
  DurableSyntheticRatingGroupPort,
  DeferredReceipt,
} from '../src/notifications/rating-group/synthetic.js';
import { waitReceipt } from '../src/notifications/rating-group/worker.js';
const binding = {
  categoryId: randomUUID(),
  categoryRevision: randomUUID(),
  catalogContext: { regionId: null },
  systemKey: 'course' as const,
  locatorMappingId: randomUUID(),
  locatorMappingRevision: randomUUID(),
  exportPolicyId: randomUUID(),
  exportPolicyRevision: randomUUID(),
};
const identity = (): EffectIdentity => ({
  effectId: randomUUID(),
  attemptId: randomUUID(),
  key: digest(randomUUID()),
  stage: 'delivery',
  profileId: 'synthetic:test',
  accountLineage: randomUUID(),
  destinationId: randomUUID(),
  inputHash: digest('input'),
  payloadHash: digest('payload'),
  fence: '1',
});
test('source faithful literal copy and canonical registered locator only', () => {
  assert.equal(deterministicCopy('course'), '同学们来给上过的课打个分吧');
  assert.equal(
    deterministicCopy('canteen'),
    '今天的饭菜合你胃口吗，来打个分吧',
  );
  assert.equal(
    nativeLocator(binding),
    `pages/rating-catalog/rating-catalog?parentId=${binding.categoryId}`,
  );
  const regionId = randomUUID();
  assert.equal(
    nativeLocator({ ...binding, catalogContext: { regionId } }),
    `pages/rating-catalog/rating-catalog?parentId=${binding.categoryId}&regionId=${regionId}`,
  );
  assert.throws(() => nativeLocator({ ...binding, categoryId: '123' }));
  for (const invalid of [
    '',
    'x'.repeat(29),
    'hello\nworld',
    '<script>',
    '@all',
    'https://example.test',
    '\u202ehello',
    'a\ud800',
    'e\u0301',
  ])
    assert.equal(qualifiedLiteral(invalid), false, invalid);
  assert.equal(qualifiedLiteral('同学们来给上过的课打个分吧'), true);
});
test('opaque server command hash independent of ticket and object field ordering', () => {
  const c: Command = {
    programId: randomUUID(),
    principalLineage: randomUUID(),
    requestId: randomUUID(),
    previewId: randomUUID(),
    type: 'course',
    mode: 'normal',
    expectedProgramRevision: randomUUID(),
    sourceBindingHash: digest(binding),
    audienceEpoch: '1',
    copyMode: 'deterministic',
    linkMode: 'native',
  };
  assert.equal(commandHash(c), commandHash({ ...c }));
  assert.notEqual(commandHash(c), commandHash({ ...c, audienceEpoch: '2' }));
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() =>
    campaignInput.parse({
      requestId: c.requestId,
      intentTicket: 'ticket',
      requestHash: commandHash(c),
      type: 'course',
    }),
  );
  assert.notEqual(
    effectKey('campaign', 'generation', 'profile', 'hash'),
    effectKey('campaign', 'shortlink', 'profile', 'hash'),
  );
});
test('exact receipt rejects wrong attempt stage destination or supplemental fields', () => {
  const i = identity(),
    e: Evidence = {
      ...i,
      kind: 'accepted',
      receiptId: 'synthetic:receipt',
      acceptedAt: 1,
      observedAt: 1,
      proofHash: '0'.repeat(64),
    };
  assert.equal(exactEvidence(i, e), true);
  assert.equal(exactEvidence(i, { ...e, attemptId: randomUUID() }), false);
  assert.equal(exactEvidence(i, { ...e, stage: 'shortlink' }), false);
  assert.equal(exactEvidence(i, { ...e, destinationId: randomUUID() }), false);
  assert.equal(
    exactEvidence(i, { ...e, unexpected: 'not metadata' } as Evidence),
    false,
  );
  assert.deepEqual(effectIdentity(e), i);
});
test('receipt timeout detaches subscription without claiming nonacceptance', async () => {
  const subscription = new DeferredReceipt();
  const wait = waitReceipt(subscription, 5);
  assert.equal(subscription.active, true);
  assert.equal(await wait, null);
  assert.equal(subscription.active, false);
});
test('durable synthetic receipt and unknown metadata survive restart, copied permits fail, and prepared locks are not stolen', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rating-group-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'registry.json'),
    domain = randomUUID(),
    secret = randomBytes(32),
    sender = new DurableSyntheticRatingGroupPort(path, domain, secret, true),
    i = identity();
  const prepared = await sender.prepare(i, {}, new AbortController().signal),
    permit = issueRatingGroupPermit(
      await committedUnitPermitCapsule(i, digest('authority')),
    );
  assert.throws(() => prepared.dispatch({ ...permit }));
  try {
    const handle = prepared.dispatch(permit);
    assert.ok(handle && 'subscribe' in handle);
    assert.ok(await waitReceipt(handle, 1000));
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(
      error.message,
      'Synthetic acceptance exceeded one millisecond; outcome remains unknown',
    );
    t.diagnostic(
      'Synchronous 1ms budget exceeded: recovering only original-attempt durable metadata, without redispatch',
    );
    const until = performance.now() + 1000;
    let recovered = await sender.reconcile(i, new AbortController().signal);
    while (!recovered && performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      recovered = await sender.reconcile(i, new AbortController().signal);
    }
    assert.ok(recovered);
    assert.deepEqual(effectIdentity(recovered), i);
  }
  const reopened = new DurableSyntheticRatingGroupPort(path, domain, secret),
    e = await reopened.reconcile(i, new AbortController().signal);
  assert.ok(e);
  assert.deepEqual(effectIdentity(e), i);
  assert.equal(reopened.authenticate(e), true);
  assert.equal(await reopened.receiptCount(), 1);
  assert.throws(() => prepared.dispatch(permit));
  assert.throws(
    () => new DurableSyntheticRatingGroupPort(path, randomUUID(), secret),
  );
  const next = {
    ...i,
    effectId: randomUUID(),
    attemptId: randomUUID(),
    key: digest('stale'),
  };
  const stale = await reopened.prepare(next, {}, new AbortController().signal);
  await assert.rejects(() =>
    reopened.prepare(
      { ...next, fence: '2', attemptId: randomUUID() },
      {},
      new AbortController().signal,
    ),
  );
  stale.dispose?.();
  await delay(10);
  const stalePermit = issueRatingGroupPermit(
    await committedUnitPermitCapsule(next, digest('a')),
  );
  assert.throws(() => stale.dispatch(stalePermit));
});
test('throwing receipt disposer cannot leave the bounded wait pending', async () => {
  assert.equal(
    await waitReceipt(
      {
        subscribe() {},
        dispose() {
          throw Error('fixture failure');
        },
      },
      5,
    ),
    null,
  );
});

test('optional output is transient and durable recovery retains authenticated metadata only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rating-group-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'registry.json'),
    domain = randomUUID(),
    secret = randomBytes(32),
    port = new DurableSyntheticRatingGroupPort(path, domain, secret, true);
  const i = {
    ...identity(),
    stage: 'generation' as const,
    destinationId: null,
    payloadHash: null,
  };
  port.setBehavior('accept', '同学们来给上过的课打个分吧');
  const prepared = await port.prepare(
    i,
    { label: '课程', type: 'course', date: '2026-10-14' },
    new AbortController().signal,
  );
  const handle = prepared.dispatch(
    issueRatingGroupPermit(
      await committedUnitPermitCapsule(i, digest('authority')),
    ),
  );
  assert.ok(handle && 'subscribe' in handle);
  const live = await waitReceipt(handle, 1000);
  assert.equal(live?.output, '同学们来给上过的课打个分吧');
  const reopened = new DurableSyntheticRatingGroupPort(path, domain, secret),
    receipt = await reopened.receipt(i);
  assert.ok(receipt);
  assert.equal(receipt.output, undefined);
  assert.equal(reopened.authenticate(receipt), true);
});

test('synthetic acceptance fixes the private tuple before asynchronous signing and preserves an old receipt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rating-group-signing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'registry.json'),
    domain = randomUUID(),
    secret = randomBytes(32);
  const port = new DurableSyntheticRatingGroupPort(path, domain, secret, true);
  const mutable = identity(),
    exact = { ...mutable };
  const prepared = await port.prepare(
    mutable,
    {},
    new AbortController().signal,
  );
  const signing = port as unknown as {
    sign(value: Omit<Evidence, 'proofHash'>): string;
  };
  const sign = signing.sign.bind(port);
  let signatures = 0;
  signing.sign = (value) => {
    signatures++;
    return sign(value);
  };
  const permit = issueRatingGroupPermit(
    await committedUnitPermitCapsule(exact, digest('authority')),
  );
  mutable.fence = '99';
  mutable.key = digest('mutated caller');
  const before = Date.now();
  const handle = prepared.dispatch(permit);
  const after = Date.now();
  assert.equal(signatures, 0, 'dispatch must not serialize or sign');
  port.setBehavior('not_accepted', 'later output must not replace fixed tuple');
  mutable.destinationId = randomUUID();
  assert.ok(handle && 'subscribe' in handle);
  const live = await waitReceipt(handle, 1000);
  assert.ok(live);
  assert.deepEqual(effectIdentity(live), exact);
  assert.equal(live.kind, 'accepted');
  assert.equal(live.output, undefined);
  assert.ok(live.acceptedAt >= before && live.acceptedAt <= after);
  assert.equal(live.observedAt, live.acceptedAt);
  assert.ok(signatures > 0);
  await delay(10);
  const old = await port.receipt(exact);
  assert.ok(old);
  const repeat = await port.prepare(exact, {}, new AbortController().signal);
  const repeated = repeat.dispatch(
    issueRatingGroupPermit(
      await committedUnitPermitCapsule(exact, digest('authority')),
    ),
  );
  assert.ok(repeated && 'subscribe' in repeated);
  assert.deepEqual(await waitReceipt(repeated, 1000), old);
  assert.equal(await port.receiptCount(), 1);
});

test('asynchronous signing failure keeps the fixed original attempt unknown without a fabricated receipt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rating-group-signing-failure-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'registry.json'),
    domain = randomUUID(),
    secret = randomBytes(32);
  const port = new DurableSyntheticRatingGroupPort(path, domain, secret, true);
  const i = identity();
  const prepared = await port.prepare(i, {}, new AbortController().signal);
  const signing = port as unknown as {
    sign(value: Omit<Evidence, 'proofHash'>): string;
  };
  let called = false;
  signing.sign = () => {
    called = true;
    throw Error('injected signature failure');
  };
  const permit = issueRatingGroupPermit(
    await committedUnitPermitCapsule(i, digest('authority')),
  );
  const handle = prepared.dispatch(permit);
  assert.equal(called, false);
  assert.ok(handle && 'subscribe' in handle);
  assert.equal(await waitReceipt(handle, 20), null);
  assert.equal(called, true);
  const restarted = new DurableSyntheticRatingGroupPort(path, domain, secret);
  assert.equal(await restarted.receipt(i), null);
  assert.equal(await restarted.receiptCount(), 0);
  assert.throws(() => prepared.dispatch(permit));
});
