import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  canonicalEnvelope,
  canonicalJson,
} from '../src/community/content-review/contracts.js';
import {
  canonicalErrandEnvelope,
  errandApprovalDigest,
} from '../src/community/content-review/errand-contracts.js';
import type { ErrandContentEnvelope } from '../src/community/content-review/errand-contracts.js';
import {
  errandBindingMatches,
  validateErrandApprovalRow,
} from '../src/community/content-review/errand-approval-validation.js';
import type {
  ErrandApprovalBinding,
  ErrandApprovalRow,
} from '../src/community/content-review/errand-approval-validation.js';
import { ErrandContentReviewFacade } from '../src/community/content-review/errand-content-review.facade.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const now = Date.UTC(2026, 9, 8);
function envelope(): ErrandContentEnvelope {
  return canonicalErrandEnvelope({
    version: 1,
    accountId: randomUUID(),
    purpose: 'publish_errand',
    title: 'Synthetic errand',
    publicText: 'Synthetic public content',
    privateText: 'Synthetic private content',
    expectedTimeText: 'Tomorrow morning',
    reward: '1.12345678901234567890123456789',
    publisherContacts: { wechat: 'synthetic-contact', phone: '10000000000' },
    publicAssetIds: [],
    privateAssetIds: [],
    scope: {
      targetRegionId: randomUUID(),
      sourceRegionId: randomUUID(),
      identityCampusId: randomUUID(),
      identitySelectionId: randomUUID(),
      topologySnapshotId: randomUUID(),
      affiliationAssertionId: randomUUID(),
      affiliationSnapshotId: randomUUID(),
    },
  });
}
function row(value = envelope()): ErrandApprovalRow {
  return {
    id: randomUUID(),
    account_id: value.accountId,
    operation: value.purpose,
    envelope_version: 1,
    digest: errandApprovalDigest(value),
    envelope: value,
    policy_revision_id: randomUUID(),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-issuer',
    provenance_ref: 'synthetic-review',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now + 1000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic-policy-owner',
    policy_provenance_ref: 'synthetic-policy',
    policy_valid_from: new Date(now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic-issuer',
    event_provenance_ref: 'synthetic-initial-state',
  };
}
function binding(
  value: ErrandApprovalRow,
  orderId: string = randomUUID(),
): ErrandApprovalBinding {
  const content = value.envelope as ErrandContentEnvelope;
  return {
    order_id: orderId,
    content_version: 1,
    decision_id: value.id,
    account_id: value.account_id,
    operation: value.operation,
    envelope_version: 1,
    digest: value.digest,
    envelope: content,
    scope: content.scope,
  };
}
const rejected = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const facade = new ErrandContentReviewFacade();

function fakeTx(
  fact: ErrandApprovalRow | null,
  existing: ErrandApprovalBinding | null = null,
) {
  const state = {
    now,
    fact,
    binding: existing,
    hasAccount: true,
    candidate: fact?.id ?? null,
    inserts: 0,
    duplicate: false,
    calls: [] as { sql: string; values: unknown[] }[],
  };
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      state.calls.push({ sql, values });
      if (sql.includes('FROM whaleu_identity.accounts'))
        return { rows: state.hasAccount ? [{ id: values[0] }] : [] };
      if (sql.includes('SELECT clock_timestamp()'))
        return { rows: [{ now: new Date(state.now) }] };
      if (sql.startsWith('SET CONSTRAINTS')) return { rows: [] };
      if (
        sql.includes(
          'SELECT id FROM whaleu_community.errand_approval_decisions',
        )
      )
        return { rows: state.candidate ? [{ id: state.candidate }] : [] };
      if (sql.includes('JOIN whaleu_community.content_approval_policies'))
        return { rows: state.fact ? [state.fact] : [] };
      if (
        sql.includes(
          'SELECT decision_id FROM whaleu_community.errand_approval_bindings',
        )
      )
        return {
          rows: state.binding
            ? [{ decision_id: state.binding.decision_id }]
            : [],
        };
      if (
        sql.includes('SELECT * FROM whaleu_community.errand_approval_bindings')
      )
        return { rows: state.binding ? [state.binding] : [] };
      if (
        sql.includes('INSERT INTO whaleu_community.errand_approval_bindings')
      ) {
        if (state.duplicate)
          throw Object.assign(new Error('synthetic duplicate'), {
            code: '23505',
          });
        state.inserts++;
        assert.ok(state.fact);
        state.binding = binding(state.fact, values[0] as string);
        assert.equal(values[4], canonicalJson(state.fact.envelope));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected test SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  return { state, tx };
}

test('errand canonical envelope is distinct, complete, deeply frozen, and preserves decimal precision', () => {
  const value = envelope(),
    digest = errandApprovalDigest(value);
  assert.equal(value.reward, '1.12345678901234567890123456789');
  assert.ok(
    Object.isFrozen(value) &&
      Object.isFrozen(value.scope) &&
      Object.isFrozen(value.publisherContacts),
  );
  assert.ok(
    Object.isFrozen(value.publicAssetIds) &&
      Object.isFrozen(value.privateAssetIds),
  );
  assert.throws(() => canonicalEnvelope(value));
  for (const extra of [
    { spaceId: randomUUID() },
    { category: 'discussion' },
    { postId: null },
  ])
    assert.throws(() => canonicalErrandEnvelope({ ...value, ...extra }));
  for (const key of ['publicAssetIds', 'privateAssetIds'] as const)
    assert.throws(() =>
      canonicalErrandEnvelope({ ...value, [key]: [randomUUID()] }),
    );
  const mutations: ((value: ErrandContentEnvelope) => void)[] = [
    (copy) => {
      copy.accountId = randomUUID();
    },
    ...(
      ['title', 'publicText', 'privateText', 'expectedTimeText'] as const
    ).map((key) => (copy: ErrandContentEnvelope) => {
      copy[key] += '!';
    }),
    (copy) => {
      copy.reward = '1.12345678901234567890123456788';
    },
    (copy) => {
      copy.publisherContacts.wechat += '!';
    },
    (copy) => {
      copy.publisherContacts.phone = '10000000001';
    },
    ...(
      Object.keys(value.scope) as (keyof ErrandContentEnvelope['scope'])[]
    ).map((key) => (copy: ErrandContentEnvelope) => {
      copy.scope[key] = randomUUID();
    }),
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.notEqual(errandApprovalDigest(changed), digest);
    const proof = binding(row(value));
    assert.equal(errandBindingMatches(proof, proof.order_id, changed), false);
  }
  const missing = structuredClone(value) as unknown as {
    scope: Record<string, unknown>;
  };
  delete missing.scope['affiliationAssertionId'];
  assert.throws(() => canonicalErrandEnvelope(missing));
});

test('canonical fresh normalization cannot silently repair stored or supplied reviewed definitions', async () => {
  const original = envelope();
  const noncanonical = { ...original, title: ` ${original.title} ` };
  assert.equal(canonicalErrandEnvelope(noncanonical).title, original.title);
  const { tx } = fakeTx(row(original));
  await assert.rejects(
    () => facade.accepted(noncanonical, tx),
    rejected('CONTENT_REVIEW_UNAVAILABLE'),
  );
  assert.equal(
    validateErrandApprovalRow(
      { ...row(original), envelope: noncanonical },
      false,
      now,
    ).decision.kind,
    'unavailable',
  );
  for (const malformed of [
    { ...original, reward: '1.00' },
    { ...original, privateText: '\ud800' },
    { ...original, privateText: '\u0000' },
  ]) {
    const fact = { ...row(original), envelope: malformed };
    assert.equal(
      validateErrandApprovalRow(fact, false, now).decision.kind,
      'unavailable',
    );
  }
});

test('review metadata remains fail-closed for incomplete policy, provenance, pending decisions and invalid times', () => {
  const good = row();
  assert.equal(
    validateErrandApprovalRow(good, true, now).decision.kind,
    'allow',
  );
  assert.equal(
    validateErrandApprovalRow(null, true, now).decision.kind,
    'unavailable',
  );
  const mutations: Record<string, unknown>[] = [
    { result: 'pending' },
    { result: 'failed' },
    { result: 'unknown' },
    { state: 'unknown' },
    { envelope_version: 2 },
    { operation: 'publish_post' },
    { account_id: randomUUID() },
    { id: 'invalid' },
    { policy_revision_id: 'invalid' },
    { digest: 'a'.repeat(64) },
    ...['coverage', 'policy_coverage', 'event_coverage'].map((key) => ({
      [key]: 'missing',
    })),
    ...['provenance', 'policy_provenance', 'event_provenance'].map((key) => ({
      [key]: 'unreconciled',
    })),
    ...[
      'issuer',
      'provenance_ref',
      'policy_issuer',
      'policy_provenance_ref',
      'event_issuer',
      'event_provenance_ref',
    ].map((key) => ({ [key]: ' ' })),
    { issuer: {} },
    { policy_key: 'unknown-policy' },
    { policy_version: 2 },
    { evaluated_at: new Date(now + 1) },
    { event_at: new Date(now + 1) },
    { event_at: new Date(now - 1001) },
    { policy_valid_from: new Date(now) },
    { policy_valid_until: new Date(now) },
    { policy_valid_until: undefined },
    { consume_until: new Date(now - 1000) },
    { evaluated_at: 'invalid' },
    { consume_until: new Date(NaN) },
    { visibility_model: 'unknown' },
    { visibility_until: new Date(now + 1) },
    { visibility_model: 'until', visibility_until: null },
    { visibility_model: 'until', visibility_until: new Date(now) },
  ];
  for (const change of mutations) {
    const fact = { ...good, ...change } as ErrandApprovalRow;
    assert.equal(
      validateErrandApprovalRow(fact, true, now).decision.kind,
      'unavailable',
      JSON.stringify(change),
    );
    assert.equal(
      validateErrandApprovalRow(fact, false, now).decision.kind,
      'unavailable',
      JSON.stringify(change),
    );
  }
  assert.equal(
    validateErrandApprovalRow(good, true, NaN).decision.kind,
    'unavailable',
  );
});

test('consumption, policy and visibility expirations are independent; held/revoked authority is explicit', () => {
  const good = row();
  assert.deepEqual(
    validateErrandApprovalRow(good, true, now).optionalUntil,
    now + 1000,
  );
  assert.equal(validateErrandApprovalRow(good, false, now).optionalUntil, null);
  const consumedWindow = { ...good, consume_until: new Date(now) };
  assert.equal(
    validateErrandApprovalRow(consumedWindow, true, now).decision.kind,
    'unavailable',
  );
  assert.equal(
    validateErrandApprovalRow(consumedWindow, false, now).decision.kind,
    'allow',
  );
  const bounded = {
    ...good,
    policy_valid_until: new Date(now + 800),
    visibility_model: 'until',
    visibility_until: new Date(now + 500),
  };
  assert.equal(
    validateErrandApprovalRow(bounded, true, now).optionalUntil,
    now + 500,
  );
  assert.equal(
    validateErrandApprovalRow(bounded, false, now).optionalUntil,
    now + 500,
  );
  for (const change of [
    { result: 'reject' as const },
    { state: 'revoked' as const },
  ]) {
    assert.deepEqual(
      validateErrandApprovalRow({ ...good, ...change }, true, now).decision,
      { kind: 'deny', reason: 'CONTENT_REJECTED' },
    );
    assert.deepEqual(
      validateErrandApprovalRow({ ...good, ...change }, false, now).decision,
      { kind: 'deny', reason: 'CONTENT_REJECTED' },
    );
  }
  assert.equal(
    validateErrandApprovalRow({ ...good, state: 'held' }, true, now).decision
      .kind,
    'unavailable',
  );
  assert.equal(
    validateErrandApprovalRow({ ...good, state: 'held' }, false, now).decision
      .kind,
    'deny',
  );
  assert.equal(
    validateErrandApprovalRow(
      { ...good, result: 'pending', state: 'revoked' },
      true,
      now,
    ).decision.kind,
    'unavailable',
  );
});

test('facade consumes latest exact review once and current rechecks the immutable definition without post aliases', async () => {
  const value = envelope(),
    fact = row(value),
    orderId = randomUUID();
  const { tx, state } = fakeTx(fact);
  const accepted = await facade.accepted(value, tx);
  assert.equal(accepted.decisionId, fact.id);
  await facade.bind(accepted, orderId, value, tx);
  assert.equal(state.inserts, 1);
  assert.equal((await facade.current(orderId, value, tx)).kind, 'allow');
  await assert.rejects(
    () => facade.accepted(value, tx),
    rejected('CONTENT_REVIEW_UNAVAILABLE'),
  );
  state.now = now + 2000;
  assert.equal((await facade.current(orderId, value, tx)).kind, 'allow');
  state.fact = { ...fact, state: 'held' };
  assert.equal((await facade.current(orderId, value, tx)).kind, 'deny');
  assert.equal(
    (await facade.current(orderId, { ...value, privateText: 'changed' }, tx))
      .kind,
    'unavailable',
  );
  assert.ok(
    state.calls.every(
      ({ sql }) =>
        !sql.includes('whaleu_errands.') &&
        !sql.includes('content_approval_decisions') &&
        !sql.includes('posts'),
    ),
  );
  const candidates = state.calls.filter(({ sql }) =>
    sql.includes('SELECT id FROM whaleu_community.errand_approval_decisions'),
  );
  assert.ok(
    candidates.length > 0 &&
      candidates.every(({ sql }) =>
        sql.includes('ORDER BY evaluated_at DESC,id DESC LIMIT 1'),
      ),
  );
});

test('missing account/head/binding and latest pending or rejected decisions never fall back to an earlier allow', async () => {
  const value = envelope(),
    fact = row(value);
  for (const change of [
    null,
    { ...fact, result: 'pending' as const },
    { ...fact, issuer: '' },
    { ...fact, consume_until: new Date(now) },
  ]) {
    const { tx, state } = fakeTx(change);
    state.candidate = fact.id;
    await assert.rejects(
      () => facade.accepted(value, tx),
      rejected('CONTENT_REVIEW_UNAVAILABLE'),
    );
    assert.equal(
      state.calls.filter(({ sql }) => sql.includes('ORDER BY evaluated_at'))
        .length,
      1,
    );
  }
  const rejectedFact = fakeTx({ ...fact, result: 'reject' });
  await assert.rejects(
    () => facade.accepted(value, rejectedFact.tx),
    rejected('CONTENT_REJECTED'),
  );
  const missing = fakeTx(fact);
  missing.state.hasAccount = false;
  await assert.rejects(
    () => facade.accepted(value, missing.tx),
    rejected('CONTENT_REVIEW_UNAVAILABLE'),
  );
  const unbound = fakeTx(fact);
  assert.equal(
    (await facade.current(randomUUID(), value, unbound.tx)).kind,
    'unavailable',
  );
});

test('bind rejects swapped definition, forged decision/digest, current rejection and duplicate consumption', async () => {
  const value = envelope(),
    fact = row(value),
    orderId = randomUUID();
  const initial = fakeTx(fact);
  const accepted = await facade.accepted(value, initial.tx);
  for (const changed of [
    { ...accepted, decisionId: randomUUID() },
    { ...accepted, digest: 'a'.repeat(64) },
    { ...accepted, version: 2 as 1 },
  ]) {
    const { tx, state } = fakeTx(fact);
    await assert.rejects(
      () => facade.bind(changed, orderId, value, tx),
      rejected('CONTENT_REVIEW_UNAVAILABLE'),
    );
    assert.equal(state.inserts, 0);
  }
  await assert.rejects(
    () =>
      facade.bind(
        accepted,
        orderId,
        { ...value, title: 'swapped' },
        initial.tx,
      ),
    rejected('CONTENT_REVIEW_UNAVAILABLE'),
  );
  initial.state.fact = { ...fact, state: 'revoked' };
  await assert.rejects(
    () => facade.bind(accepted, orderId, value, initial.tx),
    rejected('CONTENT_REJECTED'),
  );
  const duplicate = fakeTx(fact);
  duplicate.state.duplicate = true;
  await assert.rejects(
    () => facade.bind(accepted, orderId, value, duplicate.tx),
    rejected('CONTENT_REVIEW_UNAVAILABLE'),
  );
});

test('current compares every canonical field and binding identity, even with denied review authority', async () => {
  const value = envelope(),
    fact = row(value),
    bound = binding(fact);
  assert.equal(errandBindingMatches(bound, bound.order_id, value), true);
  const changes: Record<string, unknown>[] = [
    { order_id: randomUUID() },
    { content_version: 2 },
    { decision_id: 'bad' },
    { account_id: randomUUID() },
    { operation: 'publish_post' },
    { envelope_version: 2 },
    { digest: 'a'.repeat(64) },
    { scope: { ...value.scope, identitySelectionId: randomUUID() } },
    {
      envelope: {
        ...value,
        publisherContacts: { ...value.publisherContacts, wechat: 'changed' },
      },
    },
  ];
  for (const change of changes) {
    const { tx } = fakeTx(fact, {
      ...bound,
      ...change,
    } as ErrandApprovalBinding);
    assert.equal(
      (await facade.current(bound.order_id, value, tx)).kind,
      'unavailable',
    );
  }
  for (const key of Object.keys(
    value.scope,
  ) as (keyof ErrandContentEnvelope['scope'])[]) {
    const { tx } = fakeTx(fact, bound);
    assert.equal(
      (
        await facade.current(
          bound.order_id,
          { ...value, scope: { ...value.scope, [key]: randomUUID() } },
          tx,
        )
      ).kind,
      'unavailable',
    );
  }
  const other = envelope(),
    different = { ...row(other), id: fact.id, state: 'revoked' as const };
  const { tx } = fakeTx(different, bound);
  assert.equal(
    (await facade.current(bound.order_id, value, tx)).kind,
    'unavailable',
  );
});

test('mandatory transaction deadlines protect consume and current authority after deferred waits', async () => {
  const value = envelope(),
    fact = row(value),
    bound = binding(fact);
  const publication = fakeTx(fact);
  startTransactionDeadlines(publication.tx);
  try {
    await facade.accepted(value, publication.tx);
    publication.state.now = now + 1000;
    await assert.rejects(
      () => checkTransactionDeadlines(publication.tx),
      rejected('CONTENT_REVIEW_UNAVAILABLE'),
    );
  } finally {
    clearTransactionDeadlines(publication.tx);
  }
  const current = fakeTx(
    {
      ...fact,
      consume_until: new Date(now),
      policy_valid_until: new Date(now + 500),
    },
    bound,
  );
  startTransactionDeadlines(current.tx);
  try {
    assert.equal(
      (await facade.current(bound.order_id, value, current.tx)).kind,
      'allow',
    );
    current.state.now = now + 500;
    await assert.rejects(
      () => checkTransactionDeadlines(current.tx),
      rejected('CONTENT_REVIEW_UNAVAILABLE'),
    );
  } finally {
    clearTransactionDeadlines(current.tx);
  }
});
