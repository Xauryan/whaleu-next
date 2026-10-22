import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  restoreTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  homeDistributionAllowed,
  prepareHomeDistribution,
} from '../src/community/home-distribution/read-proof.js';
import {
  homeDistributionCandidateSql,
  hotCurrentWaterExcludedSql,
} from '../src/community/home-distribution/candidate-sql.js';
import type { HomeDistributionSurface } from '../src/community/home-distribution/candidate-sql.js';

function fact(patch: Record<string, unknown> = {}) {
  const postId = randomUUID();
  return {
    postId,
    accountId: randomUUID(),
    authorMode: 'named',
    version: 7,
    dispositionId: postId,
    decisionId: randomUUID(),
    digest: 'a'.repeat(64),
    result: 'short_text',
    surfaces: {
      home: true,
      hot: 'exclude_water',
      following: 'named_only_author_filter',
    },
    valid: true,
    ...patch,
  };
}
function fixture(initial = [fact()]) {
  const rows = new Map<string, ReturnType<typeof fact>>(
    initial.map((row) => [row.postId, row]),
  );
  const queries: { sql: string; values: unknown[] }[] = [];
  let blockFence = false;
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('home_post_disposition_valid(p.id)'))
        return {
          rows: (values[0] as string[]).flatMap((id) =>
            rows.has(id) ? [structuredClone(rows.get(id)!)] : [],
          ),
        };
      if (sql.startsWith('SELECT current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '1500ms',
              lock_timeout: '500ms',
            },
          ],
        };
      if (sql.startsWith('LOCK TABLE') && blockFence)
        throw Object.assign(new Error('busy'), { code: '55P03' });
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      if (/^(SELECT set_config|LOCK TABLE|SET CONSTRAINTS)/.test(sql))
        return { rows: [] };
      throw new Error(sql);
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return {
    rows,
    tx,
    queries,
    block: () => {
      blockFence = true;
    },
    reads: () =>
      queries.filter((q) =>
        q.sql.includes('home_post_disposition_valid(p.id)'),
      ),
  };
}
const surfaces: HomeDistributionSurface[] = [
  'home',
  'following',
  'hot',
  'official',
  'related_sync',
];

test('immutable Home distribution privately uses the original account, not anonymous presentation identity', async () => {
  const post = fact({ authorMode: 'anonymous', result: 'reference_only' });
  const f = fixture([post]);
  for (const viewer of [null, randomUUID()])
    for (const surface of surfaces)
      assert.equal(
        await homeDistributionAllowed(post.postId, viewer, surface, f.tx),
        false,
      );
  assert.equal(
    await homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
    true,
  );
  assert.equal(
    await homeDistributionAllowed(post.postId, post.accountId, 'hot', f.tx),
    true,
  );
  for (const surface of ['following', 'official', 'related_sync'] as const)
    assert.equal(
      await homeDistributionAllowed(post.postId, post.accountId, surface, f.tx),
      false,
    );
  assert.equal(
    f.reads().length,
    1,
    'one private batch is reused within the read epoch',
  );
  await checkTransactionDeadlines(f.tx);
  assert.equal(f.reads().length, 2, 'final proof rechecks even cached rows');
  clearTransactionDeadlines(f.tx);
});

test('Following and hot opt-outs use the exact historical accepted surface policy; ordinary and legacy rows stay unchanged', async () => {
  const included = fact();
  const excluded = fact({
    surfaces: { home: true, hot: 'disabled', following: 'excluded' },
  });
  const ordinary = fact({
    result: null,
    surfaces: { home: true, hot: 'disabled', following: 'excluded' },
  });
  const legacy = fact({
    version: 6,
    dispositionId: null,
    decisionId: null,
    digest: null,
    result: null,
    surfaces: null,
  });
  const f = fixture([included, excluded, ordinary, legacy]);
  await prepareHomeDistribution(
    [included.postId, excluded.postId, ordinary.postId, legacy.postId],
    f.tx,
  );
  assert.equal(
    await homeDistributionAllowed(
      included.postId,
      included.accountId,
      'following',
      f.tx,
    ),
    true,
  );
  assert.equal(
    await homeDistributionAllowed(
      excluded.postId,
      excluded.accountId,
      'following',
      f.tx,
    ),
    false,
  );
  assert.equal(
    await homeDistributionAllowed(
      excluded.postId,
      excluded.accountId,
      'hot',
      f.tx,
    ),
    false,
  );
  assert.equal(
    await homeDistributionAllowed(
      excluded.postId,
      excluded.accountId,
      'home',
      f.tx,
    ),
    true,
  );
  for (const post of [ordinary, legacy])
    for (const surface of surfaces)
      assert.equal(
        await homeDistributionAllowed(post.postId, null, surface, f.tx),
        true,
      );
  const sql = f.reads()[0]!.sql;
  assert.match(sql, /a.id=\(d.evidence->'admission'->>'id'\)::uuid/);
  assert.match(sql, /a.revision::text=d.evidence->'admission'->>'revision'/);
  assert.match(sql, /a.digest=d.evidence->'admission'->>'digest'/);
  assert.doesNotMatch(sql, /home_policy_head|valid_until|clock_timestamp/);
  assert.match(sql, /WHERE p.id=ANY\(\$1::uuid\[\]\)/);
  clearTransactionDeadlines(f.tx);
});

test('missing or invalid V7 disposition cannot fall back to historical unrestricted reads', async () => {
  for (const patch of [
    { valid: false },
    {
      dispositionId: null,
      decisionId: null,
      digest: null,
      result: null,
      surfaces: null,
    },
    { dispositionId: randomUUID() },
    { surfaces: null },
    { result: 'unexpected' },
    { version: 6 },
  ]) {
    const post = fact(patch),
      f = fixture([post]);
    await assert.rejects(
      homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
    );
    clearTransactionDeadlines(f.tx);
  }
  const f = fixture([]);
  await assert.rejects(
    homeDistributionAllowed(randomUUID(), null, 'home', f.tx),
  );
  clearTransactionDeadlines(f.tx);
});

test('historical-only pages add no Home final table lock or repeated proof query', async () => {
  const post = fact({
    version: 6,
    dispositionId: null,
    decisionId: null,
    digest: null,
    result: null,
    surfaces: null,
  });
  const f = fixture([post]);
  assert.equal(
    await homeDistributionAllowed(post.postId, null, 'home', f.tx),
    true,
  );
  assert.equal(f.reads().length, 1);
  f.block();
  await checkTransactionDeadlines(f.tx);
  assert.equal(f.reads().length, 1);
  assert.equal(
    f.queries.some((q) => q.sql.startsWith('LOCK TABLE')),
    false,
  );
  clearTransactionDeadlines(f.tx);
});

test('read owner batches 600 actual SQL IDs, rechecks final facts, and never issues a scalar read per row', async () => {
  const posts = Array.from({ length: 600 }, () => fact());
  const f = fixture(posts);
  await prepareHomeDistribution(
    posts.map((p) => p.postId),
    f.tx,
  );
  assert.deepEqual(
    f.reads().map((q) => (q.values[0] as string[]).length),
    [256, 256, 88],
  );
  for (const post of posts)
    assert.equal(
      await homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
      true,
    );
  assert.equal(f.reads().length, 3);
  await checkTransactionDeadlines(f.tx);
  assert.equal(f.reads().length, 6);
  assert.equal(
    f.queries.filter((q) => q.sql.startsWith('LOCK TABLE')).length,
    1,
  );
  await assert.rejects(
    prepareHomeDistribution(
      Array.from({ length: 2049 }, () => randomUUID()),
      f.tx,
    ),
  );
  clearTransactionDeadlines(f.tx);
});

test('legacy work budget is cumulative across batches and rollback, but not across reused client transactions', async () => {
  const posts = Array.from({ length: 2049 }, () =>
    fact({
      version: 6,
      dispositionId: null,
      decisionId: null,
      digest: null,
      result: null,
      surfaces: null,
    }),
  );
  const f = fixture(posts),
    before = checkpointTransactionDeadlines(f.tx);
  await prepareHomeDistribution(
    posts.slice(0, 1024).map((p) => p.postId),
    f.tx,
  );
  await prepareHomeDistribution(
    posts.slice(1024, 2048).map((p) => p.postId),
    f.tx,
  );
  assert.equal(f.reads().length, 8);
  await assert.rejects(prepareHomeDistribution([posts[2048]!.postId], f.tx), {
    code: 'COMMUNITY_UNAVAILABLE',
  });
  assert.equal(f.reads().length, 8, 'reject before reading the 2,049th fact');
  await prepareHomeDistribution([posts[0]!.postId], f.tx);
  assert.equal(f.reads().length, 8, 'cached checks do not spend read work');
  restoreTransactionDeadlines(f.tx, before);
  await assert.rejects(prepareHomeDistribution([posts[0]!.postId], f.tx), {
    code: 'COMMUNITY_UNAVAILABLE',
  });
  assert.equal(
    f.reads().length,
    8,
    'rollback cannot refund the transaction budget',
  );
  clearTransactionDeadlines(f.tx);
  startTransactionDeadlines(f.tx);
  await prepareHomeDistribution([posts[2048]!.postId], f.tx);
  assert.equal(
    f.reads().length,
    9,
    'new transaction starts a fresh work budget',
  );
  clearTransactionDeadlines(f.tx);
});

test('optional rollback and PoolClient reuse invalidate private Home caches', async () => {
  const post = fact(),
    f = fixture([post]);
  const before = checkpointTransactionDeadlines(f.tx);
  assert.equal(
    await homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
    true,
  );
  restoreTransactionDeadlines(f.tx, before);
  f.rows.set(post.postId, { ...post, accountId: randomUUID() });
  assert.equal(
    await homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
    false,
  );
  assert.equal(f.reads().length, 2);
  await checkTransactionDeadlines(f.tx);
  clearTransactionDeadlines(f.tx);
  startTransactionDeadlines(f.tx);
  f.rows.set(post.postId, post);
  assert.equal(
    await homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
    true,
  );
  assert.equal(f.reads().length, 4);
  clearTransactionDeadlines(f.tx);
  await assert.rejects(
    homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
  );
});

test('final stale binding or busy immutable owner fence fails closed', async () => {
  for (const change of ['binding', 'identity', 'fence'] as const) {
    const post = fact(),
      f = fixture([post]);
    assert.equal(
      await homeDistributionAllowed(post.postId, post.accountId, 'home', f.tx),
      true,
    );
    if (change === 'fence') f.block();
    else
      f.rows.set(
        post.postId,
        change === 'binding'
          ? { ...post, valid: false }
          : { ...post, accountId: randomUUID() },
      );
    await assert.rejects(checkTransactionDeadlines(f.tx));
    clearTransactionDeadlines(f.tx);
  }
});

test('candidate SQL gates before LIMIT, binds viewer only internally and uses indexed canonical IDs', () => {
  for (const surface of surfaces) {
    const values: unknown[] = ['existing'];
    const viewer = randomUUID();
    const sql = homeDistributionCandidateSql('p', viewer, surface, values);
    assert.match(sql, /home_disposition.post_id=p.id/);
    assert.match(sql, /result' IN \('short_text','reference_only'\)/);
    assert.match(
      sql,
      /home_admission.id=\(home_disposition.evidence->'admission'->>'id'\)::uuid/,
    );
    assert.doesNotMatch(
      sql,
      /home_policy_head|valid_until|home_post_disposition_valid|author\.id/,
    );
    if (surface === 'official' || surface === 'related_sync')
      assert.deepEqual(values, ['existing']);
    else {
      assert.deepEqual(values, ['existing', viewer]);
      assert.match(sql, /p.account_id IS DISTINCT FROM \$2::uuid/);
      assert.equal(sql.includes(viewer), false);
    }
  }
  assert.match(hotCurrentWaterExcludedSql('p'), /home_category.post_id=p.id/);
  assert.match(hotCurrentWaterExcludedSql('p'), /p.category\)<>'water'/);
  assert.throws(() =>
    homeDistributionCandidateSql('forged;DROP', null, 'home', []),
  );
});
