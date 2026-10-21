import assert from 'node:assert/strict';

export const namedRelationshipScalar =
  'SELECT EXISTS(SELECT 1 FROM whaleu_safety.blocks';
export const namedRelationshipFinalRows =
  'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)';
export const countSourceSavepoint = 'discovery_optional_count';
export const countFinalSavepoint = 'optional_final_count_proof';

const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const writerCapacity =
  compact(`SELECT current_setting('transaction_isolation') AS isolation,
  current_setting('max_connections')::integer +
  current_setting('max_prepared_transactions')::integer +
  current_setting('max_worker_processes')::integer +
  current_setting('max_wal_senders')::integer AS writer_capacity`);
export const isCountCapacityRead = (sql: string) =>
  compact(sql) === writerCapacity;

/** After-query observer only. Failures remain sticky even if an HTTP owner
 * catches the assertion and turns it into an unavailable response. */
export function namedReadCountGuard() {
  const phases = new WeakMap<object, 'source' | 'final'>();
  const open = new Set<object>();
  const failures: unknown[] = [];
  return {
    observe(sql: string, tx: object): 'source' | 'final' | undefined {
      try {
        const text = compact(sql);
        const phase = phases.get(tx);
        if (text === 'ROLLBACK') {
          phases.delete(tx);
          open.delete(tx);
          return undefined;
        }
        for (const [name, next] of [
          [countSourceSavepoint, 'source'],
          [countFinalSavepoint, 'final'],
        ] as const) {
          if (text === `SAVEPOINT ${name}`) {
            assert.equal(
              phase,
              undefined,
              'Optional count scopes must not overlap',
            );
            phases.set(tx, next);
            open.add(tx);
            return next;
          }
          if (
            text === `ROLLBACK TO SAVEPOINT ${name}` ||
            text === `RELEASE SAVEPOINT ${name}`
          ) {
            assert.equal(
              phase,
              next,
              'Optional count rollback/release must match its scope',
            );
            if (text.startsWith('RELEASE')) {
              phases.delete(tx);
              open.delete(tx);
            }
            return next;
          }
        }
        if (text === 'COMMIT')
          assert.equal(
            phase,
            undefined,
            'Optional savepoint must be released before commit',
          );
        if (
          text.startsWith(namedRelationshipScalar) ||
          text.includes(namedRelationshipFinalRows)
        )
          assert.equal(
            phase,
            undefined,
            'Mandatory named authorization is never an optional count dependency',
          );
        if (
          /writer_capacity|count_epochs|count_writer|146435610[123]/.test(text)
        ) {
          assert.ok(
            phase,
            'Count metadata is allowed only inside a rollbackable optional scope',
          );
          const epochRead =
            /^SELECT slot,version,epoch::text FROM whaleu_(community|safety|campus)\.discovery_count_epochs ORDER BY slot$/.test(
              text,
            );
          const epochFence =
            /^LOCK TABLE whaleu_(safety|campus)\.discovery_count_epochs IN SHARE MODE NOWAIT$/.test(
              text,
            );
          const advisoryFence =
            text ===
              'SELECT pg_try_advisory_xact_lock(1464356101,128) AS locked' ||
            text ===
              'SELECT pg_try_advisory_xact_lock_shared(1464356101,slot) AS locked FROM (SELECT generate_series(0,127) AS slot ORDER BY slot) AS slots';
          assert.ok(
            (phase === 'source' && isCountCapacityRead(text)) ||
              epochRead ||
              (phase === 'final' && (epochFence || advisoryFence)),
            `Unexpected optional count metadata operation: ${text}`,
          );
        }
        return phase;
      } catch (error) {
        failures.push(error);
        throw error;
      }
    },
    assertHealthy() {
      assert.deepEqual(
        failures,
        [],
        'No swallowed optional-count observer assertion',
      );
      assert.equal(open.size, 0, 'Every observed optional scope must close');
    },
  };
}

type PostCounts = {
  commentCount: number | null;
  replyCount: number | null;
  discussionCount: number | null;
};
/** No wire status is present: the three nulls are the unavailable discriminant.
 * Mixed null/numeric, missing, stale and arbitrary known values fail strictly. */
export function assertPostCounts(
  value: PostCounts,
  expected: { comments: number; replies: number },
): 'known' | 'unavailable' {
  if (value.commentCount === null) {
    assert.equal(value.replyCount, null);
    assert.equal(value.discussionCount, null);
    return 'unavailable';
  }
  assert.equal(value.commentCount, expected.comments);
  assert.equal(value.replyCount, expected.replies);
  assert.equal(value.discussionCount, expected.comments + expected.replies);
  return 'known';
}
export function assertReplyCount(
  value: { replyCount: number | null },
  expected: number,
): 'known' | 'unavailable' {
  if (value.replyCount === null) return 'unavailable';
  assert.equal(value.replyCount, expected);
  return 'known';
}
/** Remove only already-validated optional display fields, never author/persona,
 * membership, viewer permissions, body, previews or any other projection. */
export function withoutPostCounts<T extends PostCounts>(
  value: T,
  expected: { comments: number; replies: number },
) {
  assertPostCounts(value, expected);
  const {
    commentCount: _comments,
    replyCount: _replies,
    discussionCount: _discussion,
    ...projection
  } = value;
  void _comments;
  void _replies;
  void _discussion;
  return projection;
}
export function withoutReplyCount<T extends { replyCount: number | null }>(
  value: T,
  expected: number,
) {
  assertReplyCount(value, expected);
  const { replyCount: _replies, ...projection } = value;
  void _replies;
  return projection;
}
