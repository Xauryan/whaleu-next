import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
} from '../src/community/content-review/rating-contracts.js';
import type { RatingContentEnvelope } from '../src/community/content-review/rating-contracts.js';
import {
  validateRatingApprovalRow,
  ratingBindingMatches,
} from '../src/community/content-review/rating-approval-validation.js';
import type {
  RatingApprovalRow,
  RatingApprovalBinding,
} from '../src/community/content-review/rating-approval-validation.js';
import { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 9);
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function envelope(): RatingContentEnvelope {
  return canonicalRatingEnvelope({
    version: 1,
    accountId: id(1),
    purpose: 'publish_rating_comment',
    clientRequestId: id(2),
    targetId: id(3),
    targetRevision: id(4),
    categoryId: id(5),
    categoryRevision: id(6),
    catalogRevision: id(7),
    scope: { regionId: null },
    assetIds: [],
    authorMode: 'anonymous',
    body: 'Synthetic rating comment',
  });
}
function row(e = envelope()): RatingApprovalRow {
  return {
    id: id(8),
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: 1,
    digest: ratingApprovalDigest(e),
    envelope: e,
    policy_revision_id: id(9),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-review-owner',
    provenance_ref: 'synthetic-review-fact',
    evaluated_at: new Date(now - 1000),
    consume_until: new Date(now + 10000),
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
    event_issuer: 'synthetic-review-owner',
    event_provenance_ref: 'synthetic-review-event',
  };
}
function binding(r: RatingApprovalRow): RatingApprovalBinding {
  const e = r.envelope as RatingContentEnvelope;
  return {
    kind: 'comment',
    subject_id: id(10),
    content_version: 1,
    decision_id: r.id,
    account_id: r.account_id,
    operation: r.operation,
    envelope_version: 1,
    digest: r.digest,
    envelope: e,
    scope: e.scope,
  };
}
function fixture(
  r: RatingApprovalRow | null = row(),
  existing: RatingApprovalBinding | null = null,
) {
  const state = {
    row: r,
    binding: existing,
    exact: true,
    epoch: '0',
    candidate: r?.id ?? null,
    account: true,
    final: false,
    lockFailure: false,
  };
  const commands: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      commands.push({ sql, values });
      if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
        state.final = true;
        return { rows: [] };
      }
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
          throw Object.assign(new Error('synthetic conflict'), {
            code: '55P03',
          });
        return { rows: [] };
      }
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return { rows: [{ singleton: true, version: 1, epoch: state.epoch }] };
      if (sql.includes('SELECT id FROM whaleu_identity.accounts'))
        return { rows: state.account ? [{ id: id(1) }] : [] };
      if (
        sql.startsWith(
          'SELECT id FROM whaleu_community.rating_approval_decisions',
        )
      )
        return { rows: state.candidate ? [{ id: state.candidate }] : [] };
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_approval_heads',
        )
      )
        return { rows: state.row ? [{ decision_id: state.row.id }] : [] };
      if (sql.includes('WITH ORDINALITY r(id,consume,ordinal)'))
        return {
          rows: (values[0] as string[]).map((_v, i) => ({
            ordinal: i + 1,
            exact_time: state.row ? state.exact : false,
          })),
        };
      if (sql.includes('WITH ORDINALITY r(kind,id,ordinal)'))
        return {
          rows: (values[0] as string[]).map((_v, i) => ({
            ordinal: i + 1,
            decision_id: state.binding?.decision_id ?? null,
            digest: state.binding?.digest ?? null,
          })),
        };
      if (sql.includes('SELECT d.*'))
        return {
          rows: state.row
            ? [{ ...state.row, now: new Date(now), exact_time: state.exact }]
            : [],
        };
      if (
        sql.startsWith(
          'SELECT decision_id FROM whaleu_community.rating_approval_bindings',
        )
      )
        return {
          rows: state.binding
            ? [{ decision_id: state.binding.decision_id }]
            : [],
        };
      if (
        sql.startsWith(
          'SELECT * FROM whaleu_community.rating_approval_bindings',
        )
      )
        return { rows: state.binding ? [state.binding] : [] };
      if (
        sql.startsWith('INSERT INTO whaleu_community.rating_approval_bindings')
      ) {
        state.binding = {
          kind: values[0] as 'comment',
          subject_id: values[1] as string,
          content_version: 1,
          decision_id: values[2] as string,
          account_id: values[3] as string,
          operation: values[4] as string,
          envelope_version: 1,
          digest: values[5] as string,
          envelope: JSON.parse(values[6] as string),
          scope: JSON.parse(values[7] as string),
        };
        return { rows: [] };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(now) }] };
      assert.fail(`Unexpected synthetic review SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { tx, state, commands };
}
const facade = new RatingContentReviewFacade();
test('rating envelope is a strict discriminated immutable text-only contract', () => {
  const e = envelope();
  assert.ok(
    Object.isFrozen(e) &&
      Object.isFrozen(e.scope) &&
      Object.isFrozen(e.assetIds),
  );
  for (const patch of [
    { accountId: null },
    { purpose: 'publish_post' },
    { body: 'x', name: 'post alias' },
    { assetIds: [id(11)] },
    { scope: { regionId: null, campusId: id(12) } },
    { clientRequestId: undefined },
  ])
    assert.throws(() => canonicalRatingEnvelope({ ...e, ...patch }));
});
test('canonical text precedes digest and changes every request/content/scope reference binding', () => {
  const e = envelope();
  assert.equal(
    ratingApprovalDigest(e),
    ratingApprovalDigest(
      canonicalRatingEnvelope({
        ...e,
        body: '  Synthetic rating comment\r\n  ',
      }),
    ),
  );
  for (const key of [
    'accountId',
    'clientRequestId',
    'targetId',
    'targetRevision',
    'categoryId',
    'categoryRevision',
    'catalogRevision',
  ])
    assert.notEqual(
      ratingApprovalDigest(e),
      ratingApprovalDigest(canonicalRatingEnvelope({ ...e, [key]: id(30) })),
    );
  assert.notEqual(
    ratingApprovalDigest(e),
    ratingApprovalDigest(
      canonicalRatingEnvelope({ ...e, authorMode: 'named' }),
    ),
  );
  assert.notEqual(
    ratingApprovalDigest(e),
    ratingApprovalDigest(
      canonicalRatingEnvelope({ ...e, scope: { regionId: id(31) } }),
    ),
  );
});
test('target purpose requires target fields and never accepts a comment or post envelope', () => {
  const e = envelope();
  const shared: Record<string, unknown> = { ...e };
  delete shared['body'];
  delete shared['authorMode'];
  const t = canonicalRatingEnvelope({
    ...shared,
    purpose: 'publish_rating_target',
    name: 'Synthetic target',
    description: '',
  });
  assert.equal(t.purpose, 'publish_rating_target');
  assert.throws(() => canonicalRatingEnvelope({ ...t, body: 'extra' }));
});
test('canonical review metadata allows only exact accepted local policy coverage', () => {
  const r = row();
  assert.equal(validateRatingApprovalRow(r, true, now).decision.kind, 'allow');
  for (const patch of [
    { coverage: 'missing' },
    { policy_coverage: 'conflicting' },
    { event_provenance: 'unreconciled' },
    { account_id: id(20) },
    { digest: '0'.repeat(64) },
    { operation: 'publish_post' },
    { state: 'held' as const },
    { result: 'pending' as const },
  ])
    assert.notEqual(
      validateRatingApprovalRow({ ...r, ...patch }, true, now).decision.kind,
      'allow',
    );
});
test('same publication binding compares kind, content version, actor, entire text and all provenance references', () => {
  const r = row(),
    b = binding(r),
    e = envelope();
  assert.equal(ratingBindingMatches(b, 'comment', b.subject_id, e), true);
  for (const patch of [
    { kind: 'target' as const },
    { content_version: 2 },
    { account_id: id(15) },
    { digest: '0'.repeat(64) },
    { scope: { regionId: id(16) } },
    { envelope: { ...e, body: 'changed' } },
  ])
    assert.equal(
      ratingBindingMatches({ ...b, ...patch }, 'comment', b.subject_id, e),
      false,
    );
});
test('empty review source is unavailable, never a default allow or a real issuer invocation', async () => {
  const f = fixture(null);
  await assert.rejects(
    facade.accepted(envelope(), f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
  assert.ok(f.commands.every((c) => !c.sql.includes('whaleu_ratings.')));
});
test('latest exact pending decision cannot fall back to an older approval', async () => {
  const r = { ...row(), result: 'pending' as const },
    f = fixture(r);
  await assert.rejects(
    facade.accepted(envelope(), f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
  assert.ok(
    f.commands.some((c) =>
      c.sql.includes('ORDER BY evaluated_at DESC,id DESC LIMIT 1'),
    ),
  );
});
test('consumption binds the exact latest decision and registers complete final evidence', async () => {
  const f = fixture();
  const accepted = await facade.accepted(envelope(), f.tx);
  await facade.bind(accepted, 'comment', id(10), envelope(), f.tx);
  assert.equal(f.state.binding?.decision_id, accepted.decisionId);
  await checkTransactionDeadlines(f.tx);
  assert.ok(
    f.commands.some((c) =>
      c.sql.includes('WITH ORDINALITY r(kind,id,ordinal)'),
    ),
  );
  assert.ok(
    f.commands.some((c) =>
      c.sql.includes('WITH ORDINALITY r(id,consume,ordinal)'),
    ),
  );
  assert.ok(f.commands.every((c) => !c.sql.includes('pg_advisory_xact_lock(')));
});
test('review expiration only gates consumption; durable current binding remains readable', async () => {
  const r = { ...row(), consume_until: new Date(now - 1) },
    f = fixture(r, binding(r));
  assert.equal(
    (await facade.current('comment', id(10), envelope(), f.tx)).kind,
    'allow',
  );
  await checkTransactionDeadlines(f.tx);
});
test('same-millisecond future Review policy/event/evaluated time cannot pass JS validation alone', async () => {
  const r = {
      ...row(),
      evaluated_at: new Date(now),
      event_at: new Date(now),
      policy_valid_from: new Date(now),
    },
    f = fixture(r);
  f.state.exact = false;
  assert.equal(validateRatingApprovalRow(r, true, now).decision.kind, 'allow');
  await assert.rejects(
    facade.accepted(envelope(), f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
  assert.ok(
    f.commands.some(
      (c) =>
        c.sql.includes('d.evaluated_at<=instant.now') &&
        c.sql.includes('e.occurred_at<=instant.now'),
    ),
  );
});
test('mandatory final Review clock proof rejects an approval that expires after all ordinary reads', async () => {
  const r = row(),
    f = fixture(r, binding(r));
  assert.equal(
    (await facade.current('comment', id(10), envelope(), f.tx)).kind,
    'allow',
  );
  f.state.exact = false;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});
test('known filtered denial retains epoch and exact time proofs', async () => {
  const r = { ...row(), state: 'revoked' as const },
    f = fixture(r, binding(r));
  assert.equal(
    (await facade.current('comment', id(10), envelope(), f.tx)).kind,
    'deny',
  );
  f.state.epoch = '1';
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});
test('missing binding is not authorized; its absent-to-present change also invalidates final proof', async () => {
  const r = row(),
    f = fixture(r);
  assert.equal(
    (await facade.current('comment', id(10), envelope(), f.tx)).kind,
    'unavailable',
  );
  f.state.binding = binding(r);
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});
test('Review fingerprint changes for a previously absent decision/head transition', async () => {
  const f = fixture(null);
  const first = await facade.navigation(f.tx);
  f.state.epoch = '1';
  assert.notEqual(await facade.navigation(f.tx), first);
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});
test('Review NOWAIT conflict stays mandatory unavailable and does not retry with a blocking lock', async () => {
  const f = fixture();
  await facade.navigation(f.tx);
  f.state.lockFailure = true;
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
  assert.equal(
    f.commands.filter((c) => c.sql.startsWith('LOCK TABLE')).length,
    1,
  );
});
test('binding never accepts caller-made approval identity, wrong kind or already consumed review', async () => {
  const f = fixture();
  const approved = await facade.accepted(envelope(), f.tx);
  await assert.rejects(
    facade.bind(
      { ...approved, decisionId: id(42) },
      'comment',
      id(10),
      envelope(),
      f.tx,
    ),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
  await assert.rejects(
    facade.bind(approved, 'target', id(10), envelope(), f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
  f.state.binding = binding(f.state.row!);
  await assert.rejects(
    facade.accepted(envelope(), f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});
test('new authority migration is empty except epoch metadata, with no legacy errand base alias or old owner gate expansion', () => {
  const sql = readFileSync(
    new URL('../migrations/0043_rating_owner_authorities.sql', import.meta.url),
    'utf8',
  );
  assert.equal((sql.match(/INSERT INTO/g) ?? []).length, 1);
  assert.match(sql, /INSERT INTO whaleu_community.rating_review_epoch/);
  assert.doesNotMatch(
    sql,
    /errand_base|ON whaleu_verification.account_heads|ON whaleu_authorization.role_grants|ON whaleu_safety.blocks/,
  );
  assert.match(
    sql,
    /publication_transaction xid8 NOT NULL DEFAULT pg_current_xact_id\(\)/,
  );
  assert.match(
    sql,
    /PERFORM id FROM whaleu_identity.accounts WHERE id=decision.account_id FOR SHARE/,
  );
  assert.match(sql, /rating_review_binding_retain BEFORE TRUNCATE/);
});
