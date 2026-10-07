import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withCommunityScopeWriter } from './support/community-scope-fixtures.js';

/** Real pg destination parsing; only the socket and query responses are mocked.
 * No remote connection, fixture mutation, container bypass or environment flag. */
function connectionFixture(
  host: string,
  peer: string | undefined,
  database = 'whaleu_test',
  version = 180006,
  serverAddress = '172.18.0.2',
) {
  const client = new Client({ host, database, user: 'synthetic-only' });
  const transport = client as Client & {
    connection: { stream: { remoteAddress?: string } };
  };
  Object.defineProperty(transport.connection.stream, 'remoteAddress', {
    configurable: true,
    value: peer,
  });
  const queries: string[] = [];
  client.query = (async (sql: string) => {
    queries.push(sql);
    return {
      rows: sql.includes('current_database()')
        ? [{ database, version, host: serverAddress }]
        : [],
      rowCount: 0,
    };
  }) as typeof client.query;
  let releases = 0;
  const pooled = Object.assign(client, {
    release: () => {
      releases++;
    },
  });
  const pool = { connect: async () => pooled } as unknown as Pool;
  let mutations = 0;
  const run = () =>
    withCommunityScopeWriter(pool, async (tx: PoolClient) => {
      assert.equal(tx, pooled);
      mutations++;
      return 'fixture-operation';
    });
  return {
    run,
    queries,
    get mutations() {
      return mutations;
    },
    get releases() {
      return releases;
    },
  };
}

test('fixture guard accepts loopback client to published service despite server-side bridge address', async () => {
  for (const [host, peer] of [
    ['127.0.0.1', '127.0.0.1'],
    ['localhost', '::1'],
    ['::1', '::1'],
    ['localhost', '::ffff:127.0.0.1'],
  ] as const) {
    const f = connectionFixture(host, peer);
    assert.equal(await f.run(), 'fixture-operation');
    assert.equal(f.mutations, 1);
    assert.equal(f.releases, 1);
    assert.ok(f.queries.some((sql) => sql.includes('pg_advisory_xact_lock')));
    assert.equal(f.queries.at(-1), 'COMMIT');
  }
});

test('nonloopback pool destination is rejected even with a loopback environment URL', async () => {
  const before = process.env['TEST_DATABASE_URL'];
  process.env['TEST_DATABASE_URL'] =
    'postgresql://synthetic@127.0.0.1/whaleu_test';
  try {
    // Even a purported loopback peer does not excuse nonlocal client configuration.
    const f = connectionFixture('203.0.113.9', '127.0.0.1');
    await assert.rejects(f.run(), /actual loopback TCP connection/);
    assert.equal(f.mutations, 0);
    assert.deepEqual(f.queries, ['BEGIN', 'ROLLBACK']);
    assert.equal(f.releases, 1);
  } finally {
    if (before === undefined) delete process.env['TEST_DATABASE_URL'];
    else process.env['TEST_DATABASE_URL'] = before;
  }
});

test('loopback configuration never accepts a nonloopback actual peer', async () => {
  for (const peer of [
    '172.18.0.2',
    '192.168.1.2',
    '203.0.113.9',
    '::ffff:172.18.0.2',
  ]) {
    const f = connectionFixture('localhost', peer);
    await assert.rejects(f.run(), /actual loopback TCP connection/);
    assert.equal(f.mutations, 0);
    assert.deepEqual(f.queries, ['BEGIN', 'ROLLBACK']);
  }
});

test('missing TCP peer and Unix-socket connections remain unavailable to fixture writers', async () => {
  for (const [host, peer] of [
    ['localhost', undefined],
    ['/tmp/pg-socket', undefined],
    ['/tmp/pg-socket', '127.0.0.1'],
  ] as const) {
    const f = connectionFixture(host, peer);
    await assert.rejects(f.run(), /actual loopback TCP connection/);
    assert.equal(f.mutations, 0);
    assert.deepEqual(f.queries, ['BEGIN', 'ROLLBACK']);
  }
});

test('loopback alone cannot authorize a different database or unsupported PostgreSQL', async () => {
  for (const [database, version] of [
    ['production', 180006],
    ['whaleu_test', 180005],
    ['whaleu_test', 190000],
  ] as const) {
    const f = connectionFixture('127.0.0.1', '127.0.0.1', database, version);
    await assert.rejects(f.run());
    assert.equal(f.mutations, 0);
    assert.equal(f.releases, 1);
    assert.ok(!f.queries.some((sql) => sql.includes('pg_advisory_xact_lock')));
    assert.equal(f.queries.at(-1), 'ROLLBACK');
  }
});
