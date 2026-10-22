import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { INestApplication } from '@nestjs/common';
import type { PoolClient, QueryResult } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import { HotRepository } from '../src/community/hot/repository.js';
import { hotQuerySchema } from '../src/community/hot/contracts.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import { observeExactQueries } from './support/exact-discovery-counts.js';
import type { ExactQueryObservation } from './support/exact-discovery-counts.js';

const hotFields = ['id', 'spaceId', 'at', 'score'];
const space: CommunitySpace = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'global',
  name: 'Synthetic observer scope',
  isActive: true,
  operatingRegionId: null,
};

function result(fieldNames: string[]): QueryResult {
  return {
    command: 'SELECT',
    rowCount: 0,
    oid: 0,
    rows: [],
    fields: fieldNames.map((name) => ({
      name,
      tableID: 0,
      columnID: 0,
      dataTypeID: 25,
      dataTypeSize: -1,
      dataTypeModifier: -1,
      format: 'text',
    })),
  };
}

function fixture(driverResult: QueryResult | QueryResult[]) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return driverResult;
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) =>
      operation(tx),
  } as DatabaseService;
  const app = { get: () => database } as unknown as INestApplication;
  const observer = observeExactQueries(app);
  const candidates = () =>
    database.transaction((client) =>
      new HotRepository().candidates(
        space,
        hotQuerySchema.parse({ spaceId: space.id }),
        '2026-10-22T00:00:00.000000Z',
        null,
        client,
      ),
    );
  return { calls, tx, database, observer, candidates };
}

test('exact query observation reads empty-result projection metadata without rewriting Home predicates', async () => {
  const driverResult = result(hotFields);
  const f = fixture(driverResult);
  const seen: ExactQueryObservation[] = [];
  f.observer.setHook(async (event, client) => {
    assert.equal(client, f.tx);
    seen.push(event);
    assert.deepEqual(event.fieldNames, hotFields);
  });
  try {
    assert.equal(await f.candidates(), driverResult.rows);
    assert.equal(f.calls.length, 1, 'The unchanged SQL executes exactly once');
    assert.equal(seen.length, 1);
    const event = seen[0]!;
    assert.equal(event.sql, f.calls[0]!.sql);
    assert.equal(event.values, f.calls[0]!.values);
    assert.equal(event.rows, 0);
    assert.match(event.sql, /LIMIT\s+129/);
    assert.match(event.sql, /home_disposition\.post_id=p\.id/);
    assert.match(event.sql, /p\.account_id IS DISTINCT FROM \$\d+::uuid/);
    event.fieldNames.push('observer-only');
    assert.deepEqual(
      driverResult.fields.map((field) => field.name),
      hotFields,
      'Observation does not mutate driver field metadata',
    );
  } finally {
    f.observer.restore();
  }
});

for (const extra of ['account_id', 'text', 'unexpected', 'id']) {
  test(`hot projection assertion rejects returned ${extra} metadata even without rows`, async () => {
    const fieldNames = [...hotFields, extra];
    const driverResult = result(fieldNames);
    const f = fixture(driverResult);
    let observed = false;
    f.observer.setHook(async (event) => {
      observed = true;
      assert.deepEqual(event.fieldNames, fieldNames);
      // The integration assertion must reject every additional column, not
      // merely scan SQL text or infer a projection from the first result row.
      assert.deepEqual(
        event.fieldNames,
        hotFields,
        'Structural lookahead projects no content or actor',
      );
    });
    try {
      await assert.rejects(f.candidates(), (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.operator, 'deepStrictEqual');
        assert.deepEqual(error.actual, fieldNames);
        assert.deepEqual(error.expected, hotFields);
        return true;
      });
      assert.equal(observed, true);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(driverResult.rows, []);
    } finally {
      f.observer.restore();
    }
  });
}

test('exact query observation retains every multi-statement field and the original result', async () => {
  const driverResult = [result([]), result(hotFields), result(['text'])];
  const f = fixture(driverResult);
  const seen: ExactQueryObservation[] = [];
  f.observer.setHook(async (event) => {
    seen.push(event);
  });
  try {
    const returned = await f.database.transaction((client) =>
      client.query('SET LOCAL statement_timeout=3000; SELECT 1; SELECT 2'),
    );
    assert.equal(returned, driverResult);
    assert.equal(f.calls.length, 1);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]!.fieldNames, [...hotFields, 'text']);
    assert.equal(seen[0]!.rows, 0);
  } finally {
    f.observer.restore();
  }
});
