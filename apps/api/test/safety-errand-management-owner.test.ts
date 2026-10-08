import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ErrandRestrictionReader } from '../src/safety/errand-management/reader.js';
import { ErrandRestrictionWriter } from '../src/safety/errand-management/writer.js';
import { SafetyErrandFacade } from '../src/safety/errand.facade.js';
import type { SafetyRepository } from '../src/safety/repository.js';
function client(
  run: (sql: string, values?: unknown[]) => unknown | Promise<unknown>,
) {
  return {
    query: async (sql: string, values?: unknown[]) => run(sql, values),
  } as unknown as PoolClient;
}
test('Safety recorded horizon excludes the state filter, including an initially empty expired set', async () => {
  let sql = '';
  const reader = new ErrandRestrictionReader();
  const result = await reader.restrictionHorizon(
    { checkedAt: '2026-01-01T00:00:00.000000Z' },
    client((query) => {
      sql = query;
      return { rows: [{ horizon: '2026-01-01T00:00:00.000001Z' }] };
    }),
  );
  assert.equal(result, '2026-01-01T00:00:00.000001Z');
  assert.match(sql, /d\.ends_at>\$3::timestamptz/);
  assert.doesNotMatch(sql, /\$4|expired/);
});
test('Safety scalar recorded count cancels only its savepoint, restoring ordinary transaction usability', async () => {
  const queries: string[] = [];
  const result = await new ErrandRestrictionReader().countRestrictions(
    { state: 'all', checkedAt: '2026-01-01T00:00:00.000000Z' },
    client((sql) => {
      queries.push(sql);
      if (sql.startsWith('SELECT count')) throw { code: '57014' };
      return { rows: [{ timeout: '15s' }] };
    }),
  );
  assert.deepEqual(result, { status: 'unavailable' });
  assert.ok(
    queries.includes('ROLLBACK TO SAVEPOINT safety_errand_recorded_count'),
  );
  assert.equal(
    queries.at(-1),
    'RELEASE SAVEPOINT safety_errand_recorded_count',
  );
});
test('Safety recorded count retains canonical bigint precision and does not cap historical corpus', async () => {
  const result = await new ErrandRestrictionReader().countRestrictions(
    { state: 'all', checkedAt: '2026-01-01T00:00:00.000000Z' },
    client((sql) => ({
      rows: [
        sql.startsWith('SELECT count')
          ? { count: '9007199254740993' }
          : { timeout: '15s' },
      ],
    })),
  );
  assert.deepEqual(result, { status: 'known', value: '9007199254740993' });
});
test('Safety live enforcement delegates all effect timestamps to exact SQL after locking the pointer', async () => {
  const queries: string[] = [];
  const facade = new SafetyErrandFacade({} as SafetyRepository);
  await assert.rejects(
    facade.requireFeature(
      'subject',
      'publish',
      client((sql) => {
        queries.push(sql);
        return {
          rows: [
            sql.includes('FOR SHARE')
              ? { snapshot_id: 'snapshot' }
              : { restricted: true, valid_until: null },
          ],
        };
      }),
    ),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ERRAND_ACTION_RESTRICTED',
  );
  assert.match(queries[0]!, /FOR SHARE/);
  assert.match(queries[1]!, /MATERIALIZED/);
  assert.match(queries[1]!, /require_errand_restriction_snapshot/);
  assert.match(queries[1]!, /errand_restriction_effective\(f,instant.now\)/);
});
test('Safety rejects nonsensical finite duration before any database access', () => {
  const writer = new ErrandRestrictionWriter();
  const context = {
    actorId: 'a',
    sessionId: 's',
    grantId: 'g',
    requestId: 'r',
    kind: 'global' as const,
    operation: 'issue' as const,
  };
  for (const value of [
    0,
    -1,
    1.1,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(() =>
      writer.issue(
        context,
        {
          subjectId: 'u',
          action: 'all',
          reason: 'reason',
          duration: { kind: 'finite', unit: 'days', value },
        },
        client(() => assert.fail('must not query')),
      ),
    );
});
