/** Actual disposable-role helper with SQL-result fixtures, not PostgreSQL role
 * execution. The independent PG diagnostic proves host(inet_server_addr()). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createReadingWorkerRole } from './support/reading-worker-role.js';

const targetQuery =
  'SELECT current_database() database,host(inet_server_addr()) host';
function fixture(database: string, host: string | null) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (queries.length === 1) {
        // Do not let a future broad query or client-side address rewrite pass.
        assert.equal(sql, targetQuery);
        return { rows: [{ database, host }] };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}
for (const host of ['127.0.0.1', '::1', null]) {
  test(`canonical disposable target permits only whaleu_test at ${host ?? 'Unix socket'}`, async () => {
    const f = fixture('whaleu_test', host);
    const role = await createReadingWorkerRole(f.pool);
    assert.equal(f.queries[0], targetQuery);
    assert.match(role.name, /^reading_test_[a-f0-9]{32}$/);
    assert.equal(
      f.queries[1],
      `CREATE ROLE "${role.name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
    );
    assert.equal(
      f.queries.filter((q) => q.startsWith('CREATE ROLE ')).length,
      1,
    );
    assert.ok(f.queries.slice(2).every((q) => q.startsWith('GRANT ')));
    await role.close();
    assert.deepEqual(f.queries.slice(-2), [
      `DROP OWNED BY "${role.name}"`,
      `DROP ROLE "${role.name}"`,
    ]);
  });
}
for (const host of [
  '192.0.2.1',
  '10.0.0.1',
  '2001:db8::1',
  '127.0.0.2',
  '::ffff:127.0.0.1',
  'localhost',
  '127.0.0.1/32',
  '::1/128',
  ' 127.0.0.1',
  '',
]) {
  test(`noncanonical or non-admitted host ${JSON.stringify(host)} rejects before role/grant writes`, async () => {
    const f = fixture('whaleu_test', host);
    await assert.rejects(
      createReadingWorkerRole(f.pool),
      assert.AssertionError,
    );
    assert.deepEqual(f.queries, [targetQuery]);
  });
}
for (const database of ['postgres', 'whaleu_test_copy']) {
  for (const host of ['127.0.0.1', '::1', null]) {
    test(`loopback/socket cannot admit a different database ${database}/${host}`, async () => {
      const f = fixture(database, host);
      await assert.rejects(
        createReadingWorkerRole(f.pool),
        assert.AssertionError,
      );
      assert.deepEqual(f.queries, [targetQuery]);
    });
  }
}
