import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  canonicalRatingCategoryIconEnvelope,
  canonicalRatingCategoryIconDefinition,
  ratingCategoryIconApprovalDigest,
  type AcceptedRatingCategoryIconApproval,
} from '../src/community/content-review/rating-category-icon-contracts.js';
import {
  ratingCategoryIconBindingMatches,
  validateRatingCategoryIconApprovalRow,
} from '../src/community/content-review/rating-category-icon-validation.js';
import { RatingCategoryIconReviewFacade } from '../src/community/content-review/rating-category-icon-review.facade.js';
import { categoryIconContentDigest } from '../src/ratings/category-management/icon-extension.js';
import {
  checkTransactionDeadlines,
  startTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  review8Id,
  review8Now,
  review8Envelope,
  review8Definition,
  review8ApprovalRow,
  review8Binding,
} from './support/rating-category-icon-review-fixtures.js';

test('Review8 independently seals the exact body, icon, outer request and text projection', () => {
  for (const options of [
    {},
    { image: true },
    { override: true },
    { override: true, image: true },
    { override: true, textOverride: true, image: true },
  ]) {
    const envelope = review8Envelope(options);
    assert(Object.isFrozen(envelope));
    assert(Object.isFrozen(envelope.content));
    assert.equal(
      ratingCategoryIconApprovalDigest(envelope),
      createHash('sha256')
        .update(`whaleu-rating-content-approval:v8\n${canonicalJson(envelope)}`)
        .digest('hex'),
    );
    assert.equal(envelope.version, 8);
    assert.equal(envelope.assetIds.length, options.image ? 1 : 0);
    assert.notEqual(envelope.intentHash, envelope.textHash);
    assert.equal(
      validateRatingCategoryIconApprovalRow(
        review8ApprovalRow(envelope),
        true,
        review8Now,
      ).decision.kind,
      'allow',
    );
  }
});

test('Review8 media-only override has exact base lineage and campus without fabricating a text source', () => {
  const envelope = review8Envelope({ override: true, image: true });
  assert.equal(envelope.content.overrideSource, null);
  assert.equal(envelope.content.overrideDefinitionId, review8Id(23));
  assert.equal(envelope.content.selector.kind, 'campus');
  assert.equal(
    ratingCategoryIconBindingMatches(
      review8Binding(envelope),
      review8Definition(envelope),
    ),
    true,
  );
});

test('Review8 rejects unbound, partial and client-authorized envelopes', () => {
  const envelope = review8Envelope({ image: true });
  const malformed = [
    { ...envelope, version: 5 },
    { ...envelope, purpose: 'publish_rating_category_base_scoped' },
    { ...envelope, assetIds: [] },
    { ...envelope, assetIds: [review8Id(99)] },
    { ...envelope, assetIds: [review8Id(9), review8Id(9)] },
    { ...envelope, approved: true },
    { ...envelope, url: 'https://example.invalid/image' },
    { ...envelope, definitionDigest: '0'.repeat(64) },
    { ...envelope, content: { ...envelope.content, name: 'Different body' } },
    { ...envelope, content: { ...envelope.content, icon: null } },
    { ...envelope, context: { ...envelope.context, extra: true } },
    {
      ...envelope,
      content: {
        ...envelope.content,
        baseSource: { ...envelope.content.baseSource, revision: review8Id(99) },
      },
    },
  ];
  for (const candidate of malformed)
    assert.throws(() => canonicalRatingCategoryIconEnvelope(candidate));
  const campus = review8Envelope({ override: true });
  assert.throws(() =>
    canonicalRatingCategoryIconEnvelope({
      ...campus,
      context: { ...campus.context, topologySnapshotId: null },
    }),
  );
  assert.throws(() =>
    canonicalRatingCategoryIconDefinition({
      ...review8Definition(),
      definitionId: review8Id(99),
    }),
  );
});

test('a source-only successor keeping the identical appearance changes the composite approval', () => {
  const before = review8Envelope({ image: true });
  const content = {
    ...before.content,
    baseSource: { ...before.content.baseSource, revision: review8Id(99) },
  };
  const after = canonicalRatingCategoryIconEnvelope({
    ...before,
    content,
    definitionDigest: categoryIconContentDigest(content),
  });
  assert.deepEqual(before.content.icon, after.content.icon);
  assert.notEqual(before.definitionDigest, after.definitionDigest);
  assert.notEqual(
    ratingCategoryIconApprovalDigest(before),
    ratingCategoryIconApprovalDigest(after),
  );
  assert.equal(
    ratingCategoryIconBindingMatches(
      review8Binding(before),
      review8Definition(after),
    ),
    false,
  );
});

test('Review8 latest explicit reject denies the whole content; held, revoked and unknown stay unavailable', () => {
  for (const consume of [false, true]) {
    const row = review8ApprovalRow();
    assert.equal(
      validateRatingCategoryIconApprovalRow(
        { ...row, result: 'reject' },
        consume,
        review8Now,
      ).decision.kind,
      'deny',
    );
    for (const state of ['held', 'revoked'] as const)
      assert.equal(
        validateRatingCategoryIconApprovalRow(
          { ...row, state },
          consume,
          review8Now,
        ).decision.kind,
        'unavailable',
      );
    for (const result of ['pending', 'failed'] as const)
      assert.equal(
        validateRatingCategoryIconApprovalRow(
          { ...row, result },
          consume,
          review8Now,
        ).decision.kind,
        'unavailable',
      );
    for (const patch of [
      { envelope_version: 5 },
      { coverage: 'missing' },
      { provenance: 'unknown' },
      { policy_version: 2 },
      { policy_valid_until: new Date(review8Now) },
      { event_at: new Date(review8Now + 1) },
      { evaluated_at: new Date(review8Now + 1) },
      { visibility_model: 'until', visibility_until: new Date(review8Now) },
      { digest: '0'.repeat(64) },
      { account_id: review8Id(99) },
      { operation: 'publish_rating_categories' },
    ])
      assert.equal(
        validateRatingCategoryIconApprovalRow(
          { ...row, ...patch },
          consume,
          review8Now,
        ).decision.kind,
        'unavailable',
      );
  }
});

test('Review8 distinguishes consume expiry from durable visibility and retains deadlines', () => {
  const row = review8ApprovalRow();
  assert.equal(
    validateRatingCategoryIconApprovalRow(row, true, review8Now).optionalUntil,
    review8Now + 1000,
  );
  const expired = { ...row, consume_until: new Date(review8Now) };
  assert.equal(
    validateRatingCategoryIconApprovalRow(expired, true, review8Now).decision
      .kind,
    'unavailable',
  );
  assert.equal(
    validateRatingCategoryIconApprovalRow(expired, false, review8Now).decision
      .kind,
    'allow',
  );
  const until = {
    ...row,
    visibility_model: 'until',
    visibility_until: new Date(review8Now + 500),
  };
  assert.equal(
    validateRatingCategoryIconApprovalRow(until, false, review8Now)
      .optionalUntil,
    review8Now + 500,
  );
});

test('Review8 current binding matches every immutable identity before accepting even a denial', () => {
  const definition = review8Definition(),
    binding = review8Binding();
  for (const field of [
    'id',
    'decision_id',
    'account_id',
    'request_id',
    'definition_id',
    'definition_digest',
    'approval_digest',
  ] as const) {
    const bad = {
      ...binding,
      [field]:
        field === 'id' || field === 'decision_id' ? 'invalid' : review8Id(99),
    };
    assert.equal(ratingCategoryIconBindingMatches(bad, definition), false);
  }
  const changed = canonicalRatingCategoryIconEnvelope({
    ...definition.envelope,
    intentHash: '0'.repeat(64),
  });
  assert.equal(
    ratingCategoryIconBindingMatches(
      { ...binding, envelope: changed },
      definition,
    ),
    false,
  );
});

function facadeFixture() {
  const calls: string[] = [];
  const envelope = review8Envelope(),
    definition = review8Definition(envelope);
  let externalEpoch = '1',
    bound = false,
    used = false;
  let approval = {
    ...review8ApprovalRow(envelope),
    now: new Date(review8Now),
    exact_time: true,
  };
  let binding = review8Binding(envelope);
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('SELECT singleton,version,epoch::text'))
        return {
          rows: [{ singleton: true, version: 1, epoch: externalEpoch }],
        };
      if (sql.startsWith('SELECT id FROM whaleu_identity.accounts'))
        return { rows: [{ id: envelope.accountId }] };
      if (sql.includes('candidate AS MATERIALIZED'))
        return { rows: [approval] };
      if (
        sql.includes(
          'UNION ALL SELECT 1 FROM whaleu_community.rating_target_definition_bindings',
        )
      )
        return { rows: used || bound ? [{ used: true }] : [] };
      if (
        sql.includes('INSERT INTO whaleu_ratings.category_icon_review_bindings')
      ) {
        bound = true;
        binding = { ...binding, id: values![0] as string };
        return { rows: [binding] };
      }
      if (sql.includes('wanted AS MATERIALIZED'))
        return {
          rows: [
            {
              ...approval,
              ordinal: 1,
              binding: bound ? binding : null,
              account_exists: true,
              bound_time: bound,
            },
          ],
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(review8Now) }] };
      if (
        sql.startsWith('LOCK TABLE') ||
        sql.includes('set_config(') ||
        sql === 'SET CONSTRAINTS ALL IMMEDIATE'
      )
        return { rows: [] };
      assert.fail(`Unexpected Review8 SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    tx,
    calls,
    envelope,
    definition,
    facade: new RatingCategoryIconReviewFacade(),
    mutateExternal: () => {
      externalEpoch = String(Number(externalEpoch) + 1);
    },
    markUsed: () => {
      used = true;
    },
    mutateApproval: (patch: Partial<typeof approval>) => {
      approval = { ...approval, ...patch };
    },
    mutateBinding: (patch: Partial<typeof binding>) => {
      binding = { ...binding, ...patch };
    },
  };
}

test('Review8 accepted/bind/current retain independent post-write fences and all namespace reuse checks', async () => {
  const f = facadeFixture();
  const accepted = await f.facade.accepted(f.envelope, f.tx);
  const binding = await f.facade.bind(accepted, f.definition, f.tx);
  assert.equal(binding.definition_id, f.definition.definitionId);
  assert.equal((await f.facade.current(f.definition, f.tx)).kind, 'allow');
  await checkTransactionDeadlines(f.tx);
  const namespaceRead = f.calls.find((sql) =>
    sql.includes('UNION ALL SELECT 1'),
  )!;
  for (const name of [
    'rating_approval_bindings',
    'rating_target_definition_bindings',
    'rating_category_base_bindings',
    'rating_scoped_content_bindings',
    'rating_scoped_target_definition_bindings',
    'rating_scoped_category_source_bindings',
    'rating_target_cover_definition_bindings',
    'rating_discussion_media_bindings',
    'category_icon_review_bindings',
  ])
    assert(namespaceRead.includes(name));
  const insertedAt = f.calls.findIndex((sql) => sql.includes('INSERT INTO'));
  assert(
    f.calls.findIndex((sql) => sql.includes('SET CONSTRAINTS ALL IMMEDIATE')) >
      insertedAt,
  );
  assert(
    f.calls.findIndex((sql) =>
      sql.includes('LOCK TABLE whaleu_community.rating_review_epoch'),
    ) > insertedAt,
  );
  assert(
    f.calls.some((sql) =>
      sql.includes('category_icon_review_bindings IN SHARE MODE NOWAIT'),
    ),
  );
  await assert.rejects(() => f.facade.accepted(f.envelope, f.tx));
});

test('Review8 own binding cannot erase a previous external fact; revoke/hold mutation fails at final fence', async () => {
  const f = facadeFixture();
  const accepted = await f.facade.accepted(f.envelope, f.tx);
  f.mutateExternal();
  await f.facade.bind(accepted, f.definition, f.tx);
  await assert.rejects(() => checkTransactionDeadlines(f.tx));
});

test('Review8 rollback invalidates read lifetime without deleting facts from before checkpoint', async () => {
  const f = facadeFixture();
  await f.facade.accepted(f.envelope, f.tx);
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  f.mutateExternal();
  // Mirrors restoration only after the enclosing database savepoint rolled back.
  restoreTransactionDeadlines(f.tx, checkpoint);
  await assert.rejects(() => f.facade.accepted(f.envelope, f.tx));
});

test('Review8 rejects reused and changed accepted descriptors before any binding writes', async () => {
  for (const failure of [
    'used',
    'version',
    'decision',
    'digest',
    'envelope',
  ] as const) {
    const f = facadeFixture();
    let accepted = await f.facade.accepted(f.envelope, f.tx);
    if (failure === 'used') f.markUsed();
    if (failure === 'version')
      accepted = {
        ...accepted,
        version: 5,
      } as unknown as AcceptedRatingCategoryIconApproval;
    if (failure === 'decision')
      accepted = { ...accepted, decisionId: review8Id(99) };
    if (failure === 'digest')
      accepted = { ...accepted, digest: '0'.repeat(64) };
    if (failure === 'envelope')
      accepted = {
        ...accepted,
        envelope: canonicalRatingCategoryIconEnvelope({
          ...accepted.envelope,
          intentHash: '0'.repeat(64),
        }),
      };
    await assert.rejects(() => f.facade.bind(accepted, f.definition, f.tx));
    assert.equal(
      f.calls.some((sql) => sql.includes('INSERT INTO')),
      false,
    );
  }
});

test('Review8 current fails closed for missing, held and mismatched bound content', async () => {
  const f = facadeFixture();
  assert.equal(
    (await f.facade.current(f.definition, f.tx)).kind,
    'unavailable',
  );
  const accepted = await f.facade.accepted(f.envelope, f.tx);
  await f.facade.bind(accepted, f.definition, f.tx);
  f.mutateApproval({ state: 'held' });
  assert.equal(
    (await f.facade.current(f.definition, f.tx)).kind,
    'unavailable',
  );
  f.mutateApproval({ state: 'allow', result: 'reject' });
  assert.equal((await f.facade.current(f.definition, f.tx)).kind, 'deny');
  f.mutateBinding({ definition_digest: '0'.repeat(64) });
  assert.equal(
    (await f.facade.current(f.definition, f.tx)).kind,
    'unavailable',
  );
});

test('empty Review8 batch preserves old-schema traffic and limits apply before any SQL', async () => {
  const f = facadeFixture();
  assert.deepEqual(await f.facade.currentBatch([], f.tx), []);
  await assert.rejects(() =>
    f.facade.currentBatch(
      Array.from({ length: 129 }, () => f.definition),
      f.tx,
    ),
  );
  assert.deepEqual(f.calls, []);
});

test('Review8 rejects malformed requested envelopes before registering or querying any owner', async () => {
  const f = facadeFixture();
  await assert.rejects(() =>
    f.facade.accepted({ ...f.envelope, assetIds: [review8Id(99)] }, f.tx),
  );
  assert.deepEqual(f.calls, []);
});

test('Review8 exact SQL clock and full envelope equality remain mandatory for consumption', async () => {
  for (const patch of [
    { exact_time: false },
    { envelope: review8Envelope({ image: true }) },
    { result: 'pending' as const },
    { state: 'revoked' as const },
  ]) {
    const f = facadeFixture();
    f.mutateApproval(patch);
    await assert.rejects(() => f.facade.accepted(f.envelope, f.tx));
    assert.equal(
      f.calls.some((sql) => sql.includes('INSERT INTO')),
      false,
    );
  }
});
