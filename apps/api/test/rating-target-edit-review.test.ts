import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
} from '../src/community/content-review/rating-contracts.js';
import type {
  RatingContentEnvelope,
  RatingTargetEditEnvelope,
} from '../src/community/content-review/rating-contracts.js';
import {
  ratingBindingMatches,
  ratingTargetDefinitionBindingMatches,
  validateRatingApprovalRow,
} from '../src/community/content-review/rating-approval-validation.js';
import type {
  RatingApprovalBinding,
  RatingApprovalRow,
  RatingTargetDefinitionBinding,
} from '../src/community/content-review/rating-approval-validation.js';
import {
  canonicalRatingTargetDefinition,
  type RatingTargetDefinitionDescriptor,
} from '../src/community/content-review/rating-target-definition-contracts.js';
import { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
import {
  checkTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 9);
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const unavailable = errorIs('CONTENT_REVIEW_UNAVAILABLE');
function edit(patch: Record<string, unknown> = {}): RatingTargetEditEnvelope {
  const result = canonicalRatingEnvelope({
    version: 3,
    purpose: 'edit_rating_target',
    accountId: id(1),
    clientRequestId: id(2),
    targetId: id(3),
    previousTargetRevision: id(4),
    targetRevision: id(5),
    previousDefinitionRevision: id(4),
    definitionRevision: id(6),
    contentVersion: 2,
    categoryId: id(7),
    categoryRevision: id(8),
    catalogRevision: id(9),
    scope: { regionId: null },
    assetIds: [],
    name: 'Synthetic edited target',
    description: 'Synthetic reviewed text',
    ...patch,
  });
  if (result.purpose !== 'edit_rating_target') assert.fail('Wrong fixture');
  return result;
}
function descriptor(e = edit()): RatingTargetDefinitionDescriptor {
  return canonicalRatingTargetDefinition({
    targetId: e.targetId,
    contentVersion: e.contentVersion,
    definitionRevision: e.definitionRevision,
    appliedTargetRevision: e.targetRevision,
    envelope: e,
  });
}
function row(
  e: RatingContentEnvelope = edit(),
  decisionId = id(10),
): RatingApprovalRow {
  return {
    id: decisionId,
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: e.version,
    digest: ratingApprovalDigest(e),
    envelope: e,
    policy_revision_id: id(11),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-rating-edit-review',
    provenance_ref: 'synthetic-rating-edit-decision',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now + 10000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-explicit-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic-rating-edit-policy',
    policy_provenance_ref: 'synthetic-rating-edit-policy',
    policy_valid_from: new Date(now - 2000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 1000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic-rating-edit-event',
    event_provenance_ref: 'synthetic-rating-edit-event',
  };
}
function binding(r = row()): RatingTargetDefinitionBinding {
  const e = r.envelope;
  const parsed = canonicalRatingEnvelope(e);
  if (parsed.purpose !== 'edit_rating_target') assert.fail('Wrong fixture');
  return {
    target_id: parsed.targetId,
    content_version: parsed.contentVersion,
    definition_revision: parsed.definitionRevision,
    decision_id: r.id,
    account_id: parsed.accountId,
    operation: parsed.purpose,
    envelope_version: parsed.version,
    digest: r.digest,
    envelope: e,
    scope: parsed.scope,
  };
}
const definitionKey = (b: RatingTargetDefinitionBinding) =>
  `${b.target_id}:${b.content_version}`;

/** Synthetic owner fixture only. The migration/integration suite owns actual
 * PostgreSQL timing, constraints and lock interleavings. */
function fixture(initial: RatingApprovalRow | null = row()) {
  const state = {
    rows: new Map(initial ? [[initial.id, initial]] : []),
    bindings: new Map<string, RatingTargetDefinitionBinding>(),
    legacy: new Map<string, RatingApprovalBinding>(),
    epoch: '0',
    exact: true,
    account: true,
    clock: now,
    finalClock: now,
    lockFailure: false,
  };
  const commands: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push({ sql, values });
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') return { rows: [] };
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '1s',
            },
          ],
        };
      if (sql.includes('set_config')) return { rows: [] };
      if (sql.startsWith('LOCK TABLE')) {
        if (state.lockFailure)
          throw Object.assign(new Error('synthetic pending writer'), {
            code: '55P03',
          });
        return { rows: [] };
      }
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return { rows: [{ singleton: true, version: 1, epoch: state.epoch }] };
      if (sql.startsWith('SELECT id FROM whaleu_identity.accounts'))
        return { rows: state.account ? [{ id: values[0] }] : [] };
      if (
        sql.startsWith(
          'SELECT id FROM whaleu_community.rating_approval_decisions',
        )
      ) {
        const candidates = [...state.rows.values()]
          .filter(
            (r) =>
              r.account_id === values[0] &&
              r.operation === values[1] &&
              r.digest === values[2] &&
              r.envelope_version === values[3],
          )
          .sort(
            (a, b) =>
              b.evaluated_at.getTime() - a.evaluated_at.getTime() ||
              b.id.localeCompare(a.id),
          );
        return { rows: candidates[0] ? [{ id: candidates[0].id }] : [] };
      }
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_approval_heads',
        )
      )
        return {
          rows: state.rows.has(values[0] as string)
            ? [{ decision_id: values[0] }]
            : [],
        };
      if (sql.includes('WITH ORDINALITY r(id,consume,ordinal)'))
        return {
          rows: (values[0] as string[]).map((key, index) => ({
            ordinal: index + 1,
            exact_time: state.rows.has(key) && state.exact,
          })),
        };
      if (sql.includes('WITH ORDINALITY r(target_id,content_version,ordinal)'))
        return {
          rows: (values[0] as string[]).map((target, index) => {
            const b = state.bindings.get(
              `${target}:${(values[1] as number[])[index]}`,
            );
            return {
              ordinal: index + 1,
              definition_revision: b?.definition_revision ?? null,
              decision_id: b?.decision_id ?? null,
              digest: b?.digest ?? null,
            };
          }),
        };
      if (sql.includes('WITH ORDINALITY r(kind,id,ordinal)'))
        return {
          rows: (values[0] as string[]).map((kind, index) => {
            const b = state.legacy.get(
              `${kind}:${(values[1] as string[])[index]}`,
            );
            return {
              ordinal: index + 1,
              decision_id: b?.decision_id ?? null,
              digest: b?.digest ?? null,
            };
          }),
        };
      if (sql.includes('SELECT d.*')) {
        const r = state.rows.get(values[0] as string);
        return {
          rows: r
            ? [{ ...r, now: new Date(state.clock), exact_time: state.exact }]
            : [],
        };
      }
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_approval_bindings',
        )
      )
        return {
          rows: [...state.legacy.values()]
            .filter((b) => b.decision_id === values[0])
            .map((b) => ({ decision_id: b.decision_id })),
        };
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_target_definition_bindings',
        )
      )
        return {
          rows: [...state.bindings.values()]
            .filter((b) => b.decision_id === values[0])
            .map((b) => ({ decision_id: b.decision_id })),
        };
      if (
        sql.startsWith(
          'SELECT * FROM whaleu_community.rating_approval_bindings',
        )
      ) {
        const b = state.legacy.get(`${values[0]}:${values[1]}`);
        return { rows: b ? [b] : [] };
      }
      if (
        sql.startsWith(
          'SELECT * FROM whaleu_community.rating_target_definition_bindings',
        )
      ) {
        const b = state.bindings.get(`${values[0]}:${values[1]}`);
        return { rows: b ? [b] : [] };
      }
      if (
        sql.startsWith(
          'INSERT INTO whaleu_community.rating_target_definition_bindings',
        )
      ) {
        const b: RatingTargetDefinitionBinding = {
          target_id: values[0] as string,
          content_version: values[1] as number,
          definition_revision: values[2] as string,
          decision_id: values[3] as string,
          account_id: values[4] as string,
          operation: 'edit_rating_target',
          envelope_version: 3,
          digest: values[5] as string,
          envelope: JSON.parse(values[6] as string),
          scope: JSON.parse(values[7] as string),
        };
        state.bindings.set(definitionKey(b), b);
        return { rows: [] };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.finalClock) }] };
      assert.fail(`Unexpected synthetic target edit Review SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state, commands, facade: new RatingContentReviewFacade() };
}

test('edit-v3 is strict, frozen and separately domain-separated from legacy protocols', () => {
  const e = edit();
  assert.equal(Object.isFrozen(e), true);
  assert.equal(Object.isFrozen(e.scope), true);
  assert.equal(Object.isFrozen(e.assetIds), true);
  assert.equal(
    ratingApprovalDigest(e),
    createHash('sha256')
      .update(`whaleu-rating-content-approval:v3\n${canonicalJson(e)}`)
      .digest('hex'),
  );
  for (const patch of [
    { version: 1 },
    { version: 2 },
    { purpose: 'publish_rating_target' },
    { contentVersion: 1 },
    { contentVersion: 2.5 },
    { contentVersion: 2147483648 },
    { previousTargetRevision: e.targetRevision },
    { previousDefinitionRevision: e.definitionRevision },
    { assetIds: [id(20)] },
    { authorMode: 'named' },
    { body: 'unrelated' },
    { previousTargetRevision: null },
    { definitionRevision: 'not-a-uuid' },
    { name: 'bad\u0001name' },
    { description: '\ud800' },
  ])
    assert.throws(() => canonicalRatingEnvelope({ ...e, ...patch }));
  assert.equal(edit({ description: '' }).description, '');
  assert.equal(
    edit({ name: ' 😀  ', description: ' a\r\nb ' }).description,
    'a\nb',
  );
});

test('every edit identity, predecessor, new definition, text and scope changes the v3 digest', () => {
  const e = edit();
  for (const key of [
    'accountId',
    'clientRequestId',
    'targetId',
    'previousTargetRevision',
    'targetRevision',
    'previousDefinitionRevision',
    'definitionRevision',
    'categoryId',
    'categoryRevision',
    'catalogRevision',
  ])
    assert.notEqual(
      ratingApprovalDigest(e),
      ratingApprovalDigest(edit({ [key]: id(99) })),
    );
  for (const patch of [
    { contentVersion: 3 },
    { name: 'Another target' },
    { description: '' },
    { scope: { regionId: id(99) } },
  ])
    assert.notEqual(ratingApprovalDigest(e), ratingApprovalDigest(edit(patch)));
});

test('descriptor validates exact immutable version and original v1 anchor, never lifecycle-current equality', () => {
  const d = descriptor();
  assert.equal(Object.isFrozen(d), true);
  for (const patch of [
    { targetId: id(99) },
    { contentVersion: 1 },
    { contentVersion: 3 },
    { definitionRevision: id(99) },
    { appliedTargetRevision: id(99) },
    { currentTargetRevision: id(99) },
  ])
    assert.throws(() => canonicalRatingTargetDefinition({ ...d, ...patch }));
  const e = canonicalRatingEnvelope({
    version: 1,
    purpose: 'publish_rating_target',
    accountId: id(1),
    clientRequestId: id(2),
    targetId: id(3),
    targetRevision: id(4),
    categoryId: id(7),
    categoryRevision: id(8),
    catalogRevision: id(9),
    scope: { regionId: null },
    assetIds: [],
    name: 'Original target',
    description: '',
  });
  const legacy = canonicalRatingTargetDefinition({
    targetId: e.targetId,
    contentVersion: 1,
    definitionRevision: e.targetRevision,
    appliedTargetRevision: e.targetRevision,
    envelope: e,
  });
  assert.equal(legacy.contentVersion, 1);
  assert.throws(() =>
    canonicalRatingTargetDefinition({ ...legacy, definitionRevision: id(99) }),
  );
});

test('edit binding checks every version and exact definition before a deny may escape', () => {
  const d = descriptor(),
    b = binding();
  assert.equal(ratingTargetDefinitionBindingMatches(b, d), true);
  for (const patch of [
    { target_id: id(99) },
    { content_version: 3 },
    { definition_revision: id(99) },
    { decision_id: 'bad' },
    { account_id: id(99) },
    { operation: 'publish_rating_target' },
    { envelope_version: 1 },
    { digest: '0'.repeat(64) },
    { scope: { regionId: id(99) } },
    { envelope: edit({ name: 'Changed body' }) },
  ])
    assert.equal(
      ratingTargetDefinitionBindingMatches({ ...b, ...patch }, d),
      false,
    );
  const r = { ...row(), result: 'reject' as const, digest: '0'.repeat(64) };
  assert.equal(
    validateRatingApprovalRow(r, false, now).decision.kind,
    'unavailable',
  );
  assert.equal(
    ratingBindingMatches(
      { ...b, kind: 'target', subject_id: b.target_id, content_version: 1 },
      'target',
      d.targetId,
      d.envelope,
    ),
    false,
  );
});

test('edit accepted/bind/current retains exact new tuple without self-invalidating binding epoch', async () => {
  const f = fixture(),
    d = descriptor();
  const accepted = await f.facade.acceptedTargetEdit(d.envelope, f.tx);
  await f.facade.bindTargetDefinition(accepted, d, f.tx);
  assert.equal((await f.facade.currentTargetDefinition(d, f.tx)).kind, 'allow');
  await checkTransactionDeadlines(f.tx);
  assert.equal(f.state.bindings.size, 1);
  assert.ok(
    f.commands.some((c) =>
      c.sql.includes('WITH ORDINALITY r(target_id,content_version,ordinal)'),
    ),
  );
  assert.ok(
    f.commands.some(
      (c) =>
        c.sql.startsWith('LOCK TABLE') &&
        c.sql.includes(
          'rating_approval_bindings,whaleu_community.rating_target_definition_bindings',
        ),
    ),
  );
  assert.ok(
    f.commands.every(
      (c) =>
        !c.sql.includes('FROM whaleu_community.rating_review_binding_epoch'),
    ),
  );
  assert.ok(
    f.commands.every(
      (c) =>
        !c.sql.includes('whaleu_ratings.') &&
        !c.sql.includes('pg_advisory_xact_lock('),
    ),
  );
});

test('legacy target binding cannot consume edit-v3, and caller-made edit approvals cannot bind', async () => {
  const f = fixture(),
    d = descriptor();
  const accepted = await f.facade.acceptedTargetEdit(d.envelope, f.tx);
  await assert.rejects(
    f.facade.bind(accepted, 'target', d.targetId, d.envelope, f.tx),
    unavailable,
  );
  assert.equal(
    (await f.facade.current('target', d.targetId, d.envelope, f.tx)).kind,
    'unavailable',
  );
  for (const patch of [
    { decisionId: id(99) },
    { digest: '0'.repeat(64) },
    { version: 1 as const },
  ])
    await assert.rejects(
      f.facade.bindTargetDefinition({ ...accepted, ...patch }, d, f.tx),
      unavailable,
    );
  assert.equal(f.state.bindings.size, 0);
});

test('latest exact pending review never falls back, and consumed decisions in either table are rejected', async () => {
  const f = fixture(),
    newer = {
      ...row(edit(), id(12)),
      evaluated_at: new Date(now - 500),
      result: 'pending' as const,
    };
  f.state.rows.set(newer.id, newer);
  await assert.rejects(f.facade.acceptedTargetEdit(edit(), f.tx), unavailable);
  f.state.rows.delete(newer.id);
  const b = binding();
  f.state.bindings.set(definitionKey(b), b);
  await assert.rejects(f.facade.acceptedTargetEdit(edit(), f.tx), unavailable);
  f.state.bindings.clear();
  f.state.legacy.set(`target:${id(3)}`, {
    ...b,
    kind: 'target',
    subject_id: id(3),
    content_version: 1,
  });
  await assert.rejects(f.facade.acceptedTargetEdit(edit(), f.tx), unavailable);
});

test('missing current edit binding never falls back to an earlier definition', async () => {
  const f = fixture(),
    e = edit({
      contentVersion: 3,
      previousTargetRevision: id(5),
      targetRevision: id(20),
      previousDefinitionRevision: id(6),
      definitionRevision: id(21),
    });
  const older = binding();
  f.state.bindings.set(definitionKey(older), older);
  assert.equal(
    (await f.facade.currentTargetDefinition(descriptor(e), f.tx)).kind,
    'unavailable',
  );
  assert.ok(
    f.commands
      .filter((c) =>
        c.sql.startsWith(
          'SELECT * FROM whaleu_community.rating_target_definition_bindings',
        ),
      )
      .every((c) => c.values[1] === 3),
  );
});

test('new binding current preserves authoritative denial but never accepts wrong-definition denial', async () => {
  const r = { ...row(), state: 'revoked' as const },
    f = fixture(r),
    b = binding(r);
  f.state.bindings.set(definitionKey(b), b);
  assert.equal(
    (await f.facade.currentTargetDefinition(descriptor(), f.tx)).kind,
    'deny',
  );
  await checkTransactionDeadlines(f.tx);
  const bad = fixture(r);
  bad.state.bindings.set(definitionKey(b), {
    ...b,
    definition_revision: id(99),
  });
  assert.equal(
    (await bad.facade.currentTargetDefinition(descriptor(), bad.tx)).kind,
    'unavailable',
  );
});

test('before and after immutable edit bindings retain two facts for the same target', async () => {
  const e2 = edit(),
    e3 = edit({
      contentVersion: 3,
      previousTargetRevision: id(5),
      targetRevision: id(20),
      previousDefinitionRevision: id(6),
      definitionRevision: id(21),
    });
  const r2 = row(e2),
    r3 = row(e3, id(22)),
    f = fixture(r2);
  f.state.rows.set(r3.id, r3);
  for (const r of [r2, r3]) {
    const b = binding(r);
    f.state.bindings.set(definitionKey(b), b);
  }
  assert.equal(
    (await f.facade.currentTargetDefinition(descriptor(e2), f.tx)).kind,
    'allow',
  );
  assert.equal(
    (await f.facade.currentTargetDefinition(descriptor(e3), f.tx)).kind,
    'allow',
  );
  await checkTransactionDeadlines(f.tx);
  const query = f.commands.find((c) =>
    c.sql.includes('WITH ORDINALITY r(target_id,content_version,ordinal)'),
  );
  assert.deepEqual(query?.values[1], [2, 3]);
});

test('new binding absence-to-presence and changed definition invalidate exact final observation', async () => {
  for (const existed of [false, true]) {
    const f = fixture(),
      b = binding();
    if (existed) f.state.bindings.set(definitionKey(b), b);
    await f.facade.currentTargetDefinition(descriptor(), f.tx);
    f.state.bindings.set(
      definitionKey(b),
      existed ? { ...b, definition_revision: id(99) } : b,
    );
    await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  }
});

test('edit exact-time and final deadlines remain mandatory after deferred waits', async () => {
  const future = fixture();
  future.state.exact = false;
  await assert.rejects(
    future.facade.acceptedTargetEdit(edit(), future.tx),
    unavailable,
  );
  const r = {
      ...row(),
      visibility_model: 'until',
      visibility_until: new Date(now + 5),
    },
    f = fixture(r),
    b = binding(r);
  f.state.bindings.set(definitionKey(b), b);
  assert.equal(
    (await f.facade.currentTargetDefinition(descriptor(), f.tx)).kind,
    'allow',
  );
  f.state.finalClock = now + 5;
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  const expired = { ...row(), consume_until: new Date(now - 1) },
    current = fixture(expired),
    existing = binding(expired);
  current.state.bindings.set(definitionKey(existing), existing);
  assert.equal(
    (await current.facade.currentTargetDefinition(descriptor(), current.tx))
      .kind,
    'allow',
  );
  await checkTransactionDeadlines(current.tx);
  const consume = fixture(expired);
  await assert.rejects(
    consume.facade.acceptedTargetEdit(edit(), consume.tx),
    unavailable,
  );
});

test('new binding pending writer fails NOWAIT once without a blocking fallback', async () => {
  const f = fixture(),
    b = binding();
  f.state.bindings.set(definitionKey(b), b);
  await f.facade.currentTargetDefinition(descriptor(), f.tx);
  f.state.lockFailure = true;
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  assert.equal(
    f.commands.filter((c) => c.sql.startsWith('LOCK TABLE')).length,
    1,
  );
});
