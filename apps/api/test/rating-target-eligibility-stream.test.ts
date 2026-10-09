import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
import type { RatingTargetEligibilityContext } from '../src/community/content-review/rating-content-review.facade.js';
import {
  canonicalRatingEnvelope,
  ratingApprovalDigest,
} from '../src/community/content-review/rating-contracts.js';
import type { RatingContentEnvelope } from '../src/community/content-review/rating-contracts.js';
import type {
  RatingApprovalBinding,
  RatingApprovalRow,
} from '../src/community/content-review/rating-approval-validation.js';
import type { TargetRow } from '../src/ratings/repository.js';
import { RatingCompletePoolRepository } from '../src/ratings/random/complete-pool.repository.js';
import type { RatingCompletePoolBatch } from '../src/ratings/random/complete-pool.repository.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.UTC(2026, 9, 9);
const catalogId = id(90001),
  categoryId = id(90002),
  accountId = id(90003);
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const unavailable = (error: unknown) =>
  error instanceof ApplicationError &&
  ['CONTENT_REVIEW_UNAVAILABLE', 'RATING_UNAVAILABLE'].includes(error.code);
function envelope(n: number): RatingContentEnvelope {
  return canonicalRatingEnvelope({
    version: 1,
    purpose: 'publish_rating_target',
    accountId,
    clientRequestId: id(100000 + n),
    targetId: id(n),
    targetRevision: id(200000 + n),
    categoryId,
    categoryRevision: id(90004),
    catalogRevision: id(90005),
    scope: { regionId: null },
    assetIds: [],
    name: `Synthetic target ${n}`,
    description: '',
  });
}
interface ReviewRow extends RatingApprovalRow {
  ordinal: number;
  binding: RatingApprovalBinding | null;
  account_exists: boolean;
  exact_time: boolean;
  now: Date;
}
function reviewRow(e: RatingContentEnvelope, ordinal: number): ReviewRow {
  const digest = ratingApprovalDigest(e),
    decisionId = id(300000 + Number(e.targetId.slice(-12)));
  return {
    ordinal,
    account_exists: true,
    exact_time: true,
    now: new Date(now),
    binding: {
      kind: 'target',
      subject_id: e.targetId,
      content_version: 1,
      decision_id: decisionId,
      account_id: e.accountId,
      operation: e.purpose,
      envelope_version: e.version,
      digest,
      envelope: e,
      scope: e.scope,
    },
    id: decisionId,
    account_id: e.accountId,
    operation: e.purpose,
    envelope_version: e.version,
    digest,
    envelope: e,
    policy_revision_id: id(90006),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic-review-owner',
    provenance_ref: 'synthetic-review',
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
    event_provenance_ref: 'synthetic-event',
  };
}
function fixture(count = 1) {
  const envelopes = new Map(
    Array.from({ length: count }, (_, n) => [id(n + 1), envelope(n + 1)]),
  );
  const state = {
    epoch: '0',
    bindingEpoch: '0',
    poolEpoch: '0',
    clock: now,
    final: false,
    lockFailure: false,
    isolation: 'read committed',
    alter: (_row: ReviewRow, _index: number): void => {},
    active: (_index: number) => true,
    alterTarget: (_row: TargetRow): void => {},
    incompleteRows: false,
    bindingEpochRows: null as
      null | { singleton: boolean; version: number; epoch: string }[],
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
              isolation: state.isolation,
              now: new Date(state.clock),
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
      if (sql.includes('FROM whaleu_community.rating_review_binding_epoch'))
        return {
          rows: state.bindingEpochRows ?? [
            { singleton: true, version: 1, epoch: state.bindingEpoch },
          ],
        };
      if (sql.includes('FROM whaleu_community.rating_review_epoch'))
        return { rows: [{ singleton: true, version: 1, epoch: state.epoch }] };
      if (sql.includes('FROM whaleu_ratings.random_pool_epoch'))
        return {
          rows: [{ singleton: true, version: 1, epoch: state.poolEpoch }],
        };
      if (sql.startsWith('SELECT ($1::timestamptz'))
        return { rows: [{ valid: true }] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.clock) }] };
      if (sql.includes('FROM scopes s'))
        return {
          rows: [
            {
              ordinal: 1,
              id: catalogId,
              region_id: null,
              valid: true,
              precise_until: null,
            },
          ],
        };
      if (sql.includes('WITH RECURSIVE path'))
        return {
          rows: [
            {
              catalog_id: catalogId,
              id: categoryId,
              parent_id: null,
              level: 1,
              kind: 'common',
              system_key: null,
              name: 'Synthetic category',
              description: '',
              revision: id(90004),
              ordinal: '1',
              active: true,
              hidden: false,
            },
          ],
        };
      if (sql.includes('WITH RECURSIVE instant'))
        return {
          rows: [...envelopes.values()]
            .filter(
              (e) => values[3] === null || e.targetId > (values[3] as string),
            )
            .slice(0, values[4] as number)
            .map((e) => ({
              catalog_id: catalogId,
              category_id: categoryId,
              target_id: e.targetId,
              valid_path: true,
              summary: null,
              target: (() => {
                const row: TargetRow = {
                  id: e.targetId,
                  revision: e.targetRevision,
                  category_id: e.categoryId,
                  creator_id: e.accountId,
                  region_id: null,
                  name: e.purpose === 'publish_rating_target' ? e.name : '',
                  description: '',
                  active: state.active(Number(e.targetId.slice(-12))),
                  envelope: e,
                };
                state.alterTarget(row);
                return row;
              })(),
            })),
        };
      if (
        sql.includes('SELECT w.ordinal::integer ordinal,to_jsonb(b) binding')
      ) {
        const rows = (values[0] as string[]).map((key, i) => {
          const row = reviewRow(envelopes.get(key)!, i + 1);
          state.alter(row, Number(key.slice(-12)));
          return row;
        });
        if (state.incompleteRows) rows.pop();
        return { rows };
      }
      throw new Error(`Unexpected synthetic SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  const facade = new RatingContentReviewFacade(),
    pool = new RatingCompletePoolRepository();
  async function start() {
    const handle = await pool.capture(tx),
      context = await facade.begin(tx);
    await pool.prepare(handle, [null], categoryId, tx);
    return { handle, context };
  }
  async function scan() {
    const { handle, context } = await start();
    const decisions: ('allow' | 'deny')[] = [];
    let done = false;
    while (!done) {
      const batch = await pool.next(handle, tx);
      decisions.push(...(await facade.validateBatch(batch, context, tx)));
      done = batch.done;
    }
    await pool.complete(handle, tx);
    const counts = await facade.complete(context, tx);
    return { counts, decisions, context };
  }
  return { tx, state, commands, facade, pool, start, scan };
}
for (const count of [1001, 2048])
  test(`complete ${count}-target canonical scan keeps final proof constant-size`, async () => {
    const f = fixture(count);
    f.state.alter = (row, index) => {
      if (index <= 128) row.state = 'held';
    };
    const result = await f.scan();
    assert.deepEqual(result.counts, {
      validatedCount: count,
      allowedCount: count - 128,
    });
    assert.equal(result.decisions.at(-1), 'allow');
    const before = f.commands.length;
    await checkTransactionDeadlines(f.tx);
    const final = f.commands.slice(before);
    assert.equal(
      final.filter((command) => command.sql.startsWith('LOCK TABLE')).length,
      2,
    );
    assert.ok(
      final.every(
        (command) =>
          !command.sql.includes('rating_approval_bindings') &&
          !command.sql.includes('rating_approval_decisions'),
      ),
    );
    const reads = f.commands.filter((command) =>
      command.sql.includes('to_jsonb(b) binding'),
    );
    assert.equal(reads.length, Math.ceil(count / 128));
    assert.ok(
      reads.every((command) => (command.values[0] as string[]).length <= 128),
    );
    assert.ok(
      reads.every((command) => !command.sql.includes('whaleu_ratings.')),
    );
    assert.match(
      reads[0]!.sql,
      /WITH instant AS MATERIALIZED \(SELECT clock_timestamp\(\) now\)/,
    );
    assert.match(reads[0]!.sql, /NOT false OR d.consume_until>instant.now/);
    assert.match(reads[0]!.sql, /FOR SHARE OF a/);
  });

test('a final-batch unknown invalidates the complete scope, never the first 128 prefix', async () => {
  const f = fixture(1001);
  f.state.alter = (row, index) => {
    if (index === 1001) row.binding = null;
  };
  await assert.rejects(f.scan(), errorIs('CONTENT_REVIEW_UNAVAILABLE'));
  // Pool preparation was not completed after the failed Review batch either.
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
});
const invalidRows: [string, (row: ReviewRow) => void][] = [
  [
    'missing creator',
    (row) => {
      row.account_exists = false;
    },
  ],
  [
    'wrong binding digest',
    (row) => {
      row.binding = { ...row.binding!, digest: '0'.repeat(64) };
    },
  ],
  [
    'wrong binding scope',
    (row) => {
      row.binding = { ...row.binding!, scope: { regionId: id(12345) } };
    },
  ],
  [
    'wrong binding operation',
    (row) => {
      row.binding = { ...row.binding!, operation: 'publish_rating_comment' };
    },
  ],
  [
    'missing decision',
    (row) => {
      row.id = '';
    },
  ],
  [
    'pending review',
    (row) => {
      row.result = 'pending';
    },
  ],
  [
    'missing policy',
    (row) => {
      row.policy_key = '';
    },
  ],
  [
    'missing event coverage',
    (row) => {
      row.event_coverage = '';
    },
  ],
  [
    'noncanonical envelope',
    (row) => {
      row.envelope = {
        ...(row.envelope as RatingContentEnvelope),
        unknown: true,
      };
    },
  ],
  [
    'same-millisecond future exact-time failure',
    (row) => {
      row.exact_time = false;
    },
  ],
  [
    'wrong row ordinal',
    (row) => {
      row.ordinal = 2;
    },
  ],
];
for (const [name, alter] of invalidRows)
  test(`canonical stream fails closed on ${name}`, async () => {
    const f = fixture();
    f.state.alter = alter;
    await assert.rejects(f.scan(), errorIs('CONTENT_REVIEW_UNAVAILABLE'));
  });
for (const kind of ['allow', 'deny'] as const)
  test(`${kind} visibility and policy deadlines survive streaming to the final deferred-wait check`, async () => {
    for (const deadline of ['policy', 'visibility'] as const) {
      const f = fixture();
      f.state.alter = (row) => {
        if (kind === 'deny') row.state = 'revoked';
        if (deadline === 'policy') row.policy_valid_until = new Date(now + 5);
        else {
          row.visibility_model = 'until';
          row.visibility_until = new Date(now + 5);
        }
      };
      await f.scan();
      f.state.clock = now + 5;
      await assert.rejects(
        checkTransactionDeadlines(f.tx),
        errorIs('CONTENT_REVIEW_UNAVAILABLE'),
      );
    }
  });
test('expired consumption does not expire durable ongoing target visibility', async () => {
  const f = fixture();
  f.state.alter = (row) => {
    row.consume_until = new Date(now - 1);
  };
  assert.equal((await f.scan()).counts.allowedCount, 1);
  await checkTransactionDeadlines(f.tx);
});
for (const source of ['epoch', 'bindingEpoch'] as const)
  test(`${source} change after validation invalidates fixed final proof`, async () => {
    const f = fixture();
    await f.scan();
    f.state[source] = '2';
    await assert.rejects(
      checkTransactionDeadlines(f.tx),
      errorIs('CONTENT_REVIEW_UNAVAILABLE'),
    );
  });
test('in-flight writer fails NOWAIT with no per-target fallback', async () => {
  const f = fixture();
  await f.scan();
  f.state.lockFailure = true;
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
});
test('review context rejects forgery, cross-transaction use and savepoint restore', async () => {
  const f = fixture(),
    started = await f.start(),
    batch = await f.pool.next(started.handle, f.tx);
  await assert.rejects(
    f.facade.validateBatch(batch, {} as RatingTargetEligibilityContext, f.tx),
    unavailable,
  );
  const other = fixture();
  await assert.rejects(
    f.facade.validateBatch(batch, started.context, other.tx),
    unavailable,
  );
  const checkpoint = checkpointTransactionDeadlines(f.tx);
  restoreTransactionDeadlines(f.tx, checkpoint);
  await assert.rejects(
    f.facade.validateBatch(batch, started.context, f.tx),
    unavailable,
  );
});
test('incomplete or skipped-first-batch scans cannot be completed', async () => {
  const f = fixture(129),
    started = await f.start();
  await assert.rejects(f.facade.complete(started.context, f.tx), unavailable);
  await f.pool.next(started.handle, f.tx);
  const last = await f.pool.next(started.handle, f.tx);
  assert.equal(last.done, true);
  await assert.rejects(
    f.facade.validateBatch(last, started.context, f.tx),
    unavailable,
  );
  await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
});
test('batch replay and copied batch handles are rejected', async () => {
  for (const copy of [false, true]) {
    const f = fixture(129),
      started = await f.start(),
      batch = await f.pool.next(started.handle, f.tx);
    await f.facade.validateBatch(batch, started.context, f.tx);
    await assert.rejects(
      f.facade.validateBatch(
        copy ? ({ ...batch } as RatingCompletePoolBatch) : batch,
        started.context,
        f.tx,
      ),
      unavailable,
    );
  }
});
test('empty transport batches from inactive targets still advance to complete EOF', async () => {
  const f = fixture(129);
  f.state.active = (index) => index > 128;
  assert.deepEqual((await f.scan()).counts, {
    validatedCount: 1,
    allowedCount: 1,
  });
  await checkTransactionDeadlines(f.tx);
});
test('missing/versioned/overflow binding epoch fails closed before scanning', async () => {
  for (const rows of [
    [],
    [{ singleton: true, version: 2, epoch: '0' }],
    [{ singleton: true, version: 1, epoch: '9223372036854775808' }],
  ]) {
    const f = fixture();
    f.state.bindingEpochRows = rows;
    await assert.rejects(
      f.facade.begin(f.tx),
      errorIs('CONTENT_REVIEW_UNAVAILABLE'),
    );
  }
});

test('canonical target validation compares immutable owner row content but permits lifecycle CAS revision changes', async () => {
  for (const field of [
    'name',
    'description',
    'creator_id',
    'region_id',
  ] as const) {
    const f = fixture();
    f.state.alterTarget = (row) => {
      if (field === 'name' || field === 'description')
        row[field] = 'Synthetic changed definition';
      else row[field] = id(123456);
    };
    await assert.rejects(f.scan(), unavailable);
  }
  const f = fixture();
  f.state.alterTarget = (row) => {
    row.revision = id(654321);
  };
  assert.equal((await f.scan()).counts.allowedCount, 1);
  await checkTransactionDeadlines(f.tx);
});

test('a second same-transaction source stream is rejected before it can be mixed into Review', async () => {
  const f = fixture(129),
    first = await f.start();
  await f.facade.validateBatch(
    await f.pool.next(first.handle, f.tx),
    first.context,
    f.tx,
  );
  await assert.rejects(f.pool.capture(f.tx), errorIs('RATING_UNAVAILABLE'));
});

test('a consumed EOF without explicit Review completion cannot commit', async () => {
  const f = fixture(),
    started = await f.start();
  await f.facade.validateBatch(
    await f.pool.next(started.handle, f.tx),
    started.context,
    f.tx,
  );
  await f.pool.complete(started.handle, f.tx);
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});

for (const source of ['epoch', 'bindingEpoch'] as const)
  test(`${source} changes are rejected before sampling as well as at the final fence`, async () => {
    const f = fixture(),
      started = await f.start();
    await f.facade.validateBatch(
      await f.pool.next(started.handle, f.tx),
      started.context,
      f.tx,
    );
    f.state[source] = '1';
    await assert.rejects(
      f.facade.complete(started.context, f.tx),
      errorIs('CONTENT_REVIEW_UNAVAILABLE'),
    );
  });

test('denial deadline crossed during preparation fails before sampling', async () => {
  const f = fixture();
  f.state.alter = (row) => {
    row.result = 'reject';
    row.policy_valid_until = new Date(now + 1);
  };
  const started = await f.start();
  await f.facade.validateBatch(
    await f.pool.next(started.handle, f.tx),
    started.context,
    f.tx,
  );
  f.state.clock = now + 1;
  await assert.rejects(
    f.facade.complete(started.context, f.tx),
    errorIs('CONTENT_REVIEW_UNAVAILABLE'),
  );
});

test('set-query output cardinality must match the complete input batch', async () => {
  const f = fixture(2);
  f.state.incompleteRows = true;
  await assert.rejects(f.scan(), errorIs('CONTENT_REVIEW_UNAVAILABLE'));
});
