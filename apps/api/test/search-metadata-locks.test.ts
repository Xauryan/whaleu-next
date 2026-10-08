import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../src/http/application-error.js';
import {
  SearchRepository,
  SEARCH_METADATA_LOCK_LIMIT,
} from '../src/community/search/repository.js';

const uuid = (i: number) =>
  `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE';

test('metadata owner bounds each kind to window + sentinel + guard and orders locks in SQL without reading bodies', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = new SearchRepository();
  const ids = Array.from({ length: SEARCH_METADATA_LOCK_LIMIT }, (_, i) =>
    uuid(i + 1),
  );
  for (const [kind, table, alias] of [
    ['post', 'posts', 'p'],
    ['comment', 'root_comments', 'c'],
    ['reply', 'replies', 'r'],
  ] as const) {
    await repository.lockCandidates(kind, [...ids].reverse(), tx);
    const call = calls.at(-1)!;
    assert.deepEqual(call.values, [ids]);
    assert.match(
      call.sql,
      new RegExp(`FROM whaleu_community.${table} ${alias}`),
    );
    assert.ok(
      call.sql.endsWith(
        `WHERE ${alias}.id=ANY($1::uuid[]) ORDER BY ${alias}.id ASC FOR SHARE OF ${alias}`,
      ),
      'Immutable UUID ordering must precede row locking within the owner SQL',
    );
    assert.doesNotMatch(
      call.sql,
      /SELECT \*|\b(?:text|account_id|target_reply_id|visibility|deleted_at|images)\b(?!\s+AS)|ILIKE|LOWER|whaleu_(?:identity|safety)/i,
    );
  }
  assert.equal(calls.length, 3);
  await repository.lockCandidates('post', [], tx);
  assert.equal(calls.length, 3, 'No query for an empty kind');
  await repository.lockCandidates('post', [uuid(2), uuid(1), uuid(2)], tx);
  assert.deepEqual(calls.at(-1)!.values, [[uuid(1), uuid(2)]]);
  const before = calls.length;
  for (const bad of [
    [...ids, uuid(SEARCH_METADATA_LOCK_LIMIT + 1)],
    Array.from({ length: SEARCH_METADATA_LOCK_LIMIT + 1 }, () => uuid(1)),
    ['not-a-uuid'],
    [uuid(15).toUpperCase()],
  ])
    await assert.rejects(
      repository.lockCandidates('post', bad, tx),
      unavailable,
    );
  assert.equal(calls.length, before, 'Invalid owner input never executes SQL');
});
