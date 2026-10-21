import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertPostCounts,
  assertReplyCount,
  countFinalSavepoint,
  countSourceSavepoint,
  isCountCapacityRead,
  namedReadCountGuard,
  namedRelationshipScalar,
  namedRelationshipFinalRows,
  withoutPostCounts,
  withoutReplyCount,
} from './support/named-read-count-contract.js';

const capacity = `SELECT current_setting('transaction_isolation') AS isolation,
  current_setting('max_connections')::integer +
  current_setting('max_prepared_transactions')::integer +
  current_setting('max_worker_processes')::integer +
  current_setting('max_wal_senders')::integer AS writer_capacity`;
const epochs =
  'SELECT slot,version,epoch::text FROM whaleu_safety.discovery_count_epochs ORDER BY slot';
const fence =
  'LOCK TABLE whaleu_safety.discovery_count_epochs IN SHARE MODE NOWAIT';
test('named count guard accepts only scoped source metadata and final-only fences', () => {
  const guard = namedReadCountGuard(),
    tx = {};
  guard.observe(`SAVEPOINT ${countSourceSavepoint}`, tx);
  guard.observe(capacity, tx);
  assert.equal(isCountCapacityRead(capacity), true);
  guard.observe(epochs, tx);
  guard.observe(`ROLLBACK TO SAVEPOINT ${countSourceSavepoint}`, tx);
  guard.observe(`RELEASE SAVEPOINT ${countSourceSavepoint}`, tx);
  guard.observe(namedRelationshipScalar, tx);
  guard.observe(namedRelationshipFinalRows, tx);
  guard.observe(`SAVEPOINT ${countFinalSavepoint}`, tx);
  guard.observe(fence, tx);
  guard.observe(epochs, tx);
  guard.observe(`RELEASE SAVEPOINT ${countFinalSavepoint}`, tx);
  guard.observe('COMMIT', tx);
  guard.assertHealthy();
});
test('count guard rejects unscoped, arbitrary and prematurely locking metadata, with sticky failure', () => {
  for (const [scope, sql] of [
    [null, epochs],
    [null, capacity],
    [countFinalSavepoint, capacity],
    [countSourceSavepoint, 'SELECT 1 AS writer_capacity'],
    [countSourceSavepoint, fence],
    [countFinalSavepoint, 'SELECT * FROM whaleu_safety.discovery_count_epochs'],
    [countSourceSavepoint, 'SELECT count_writer()'],
    [countSourceSavepoint, namedRelationshipScalar],
    [countFinalSavepoint, namedRelationshipFinalRows],
  ] as const) {
    const guard = namedReadCountGuard(),
      tx = {};
    if (scope) guard.observe(`SAVEPOINT ${scope}`, tx);
    assert.throws(() => guard.observe(sql, tx));
    guard.observe('ROLLBACK', tx);
    assert.throws(() => guard.assertHealthy(), /swallowed/);
  }
});
test('count guard isolates client scopes and requires release', () => {
  const guard = namedReadCountGuard(),
    tx = {};
  guard.observe(`SAVEPOINT ${countSourceSavepoint}`, tx);
  assert.throws(() => guard.assertHealthy(), /must close/);
  guard.observe(`RELEASE SAVEPOINT ${countSourceSavepoint}`, tx);
  guard.assertHealthy();
  assert.throws(() => guard.observe(epochs, {}));
});
test('nullable post counts retain exact known values and reject every mixed or malformed envelope', () => {
  const expected = { comments: 3, replies: 1 };
  assert.equal(
    assertPostCounts(
      { commentCount: 3, replyCount: 1, discussionCount: 4 },
      expected,
    ),
    'known',
  );
  assert.equal(
    assertPostCounts(
      { commentCount: null, replyCount: null, discussionCount: null },
      expected,
    ),
    'unavailable',
  );
  for (const values of [
    [null, 1, 4],
    [3, null, 4],
    [3, 1, null],
    [4, 1, 5],
    [3, 2, 5],
    [3, 1, 5],
    [undefined, null, null],
    [null, undefined, null],
    [null, null, undefined],
    [NaN, 1, 4],
  ])
    assert.throws(() =>
      assertPostCounts(
        {
          commentCount: values[0],
          replyCount: values[1],
          discussionCount: values[2],
        } as never,
        expected,
      ),
    );
  assert.equal(assertReplyCount({ replyCount: null }, 2), 'unavailable');
  assert.equal(assertReplyCount({ replyCount: 2 }, 2), 'known');
  assert.throws(() => assertReplyCount({ replyCount: 1 }, 2));
  assert.throws(() => assertReplyCount({} as never, 2));
});
test('anonymous comparison retains every non-count field and validates both envelopes first', () => {
  const before = {
    id: 'post',
    author: { kind: 'anonymous', personaId: 'stable' },
    viewer: { canDelete: false },
    commentCount: 0,
    replyCount: 0,
    discussionCount: 0,
  };
  const after = {
    ...before,
    commentCount: null,
    replyCount: null,
    discussionCount: null,
  };
  const expected = { comments: 0, replies: 0 };
  assert.deepEqual(
    withoutPostCounts(before, expected),
    withoutPostCounts(after, expected),
  );
  assert.throws(() => withoutPostCounts({ ...after, replyCount: 9 }, expected));
  assert.notDeepEqual(
    withoutPostCounts(before, expected),
    withoutPostCounts(
      { ...after, author: { kind: 'anonymous', personaId: 'leaked' } },
      expected,
    ),
  );
  assert.deepEqual(
    withoutReplyCount(
      { id: 'root', replyCount: 0, replyPreview: { items: ['named'] } },
      0,
    ),
    { id: 'root', replyPreview: { items: ['named'] } },
  );
});
