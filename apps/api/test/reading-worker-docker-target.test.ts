import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import {
  readingWorkerDockerTarget,
  assertReadingWorkerTarget,
} from './support/reading-worker-docker-target.js';
import { createReadingWorkerRole } from './support/reading-worker-role.js';
const metadata = {
  version: 1,
  containerId: 'a'.repeat(64),
  owner: 'b'.repeat(32),
  serverAddress: '172.17.0.2',
  host: '127.0.0.1',
  port: 5423,
  database: 'whaleu_test',
};
const database = 'postgresql://whaleu_test@127.0.0.1:5423/whaleu_test';
const decode = (value: unknown = metadata, url = database) =>
  readingWorkerDockerTarget(JSON.stringify(value), url, 'password');
test('only explicit validated exact owned Docker target expands one role fixture call', () => {
  const target = decode();
  assert.ok(Object.isFrozen(target));
  assertReadingWorkerTarget(
    { database: 'whaleu_test', host: '172.17.0.2' },
    target,
  );
  for (const host of ['172.17.0.3', '127.0.0.1', '::1', null])
    assert.throws(() =>
      assertReadingWorkerTarget({ database: 'whaleu_test', host }, target),
    );
  assert.throws(() =>
    assertReadingWorkerTarget(
      { database: 'production', host: '172.17.0.2' },
      target,
    ),
  );
  assert.throws(() =>
    assertReadingWorkerTarget(
      { database: 'whaleu_test', host: '172.17.0.2' },
      { ...metadata, version: 1, host: '127.0.0.1', database: 'whaleu_test' },
    ),
  );
});
test('absent target retains exact socket and loopback admission only', () => {
  assert.equal(
    readingWorkerDockerTarget(undefined, database, 'trust'),
    undefined,
  );
  for (const host of [null, '127.0.0.1', '::1'])
    assertReadingWorkerTarget({ database: 'whaleu_test', host });
  for (const host of [
    '172.17.0.2',
    '10.0.0.1',
    '192.168.1.1',
    '127.0.0.2',
    '127.0.0.1/32',
  ])
    assert.throws(() =>
      assertReadingWorkerTarget({ database: 'whaleu_test', host }),
    );
});
test('Docker metadata in trust mode is rejected, never inferred or downgraded', () => {
  assert.throws(() =>
    readingWorkerDockerTarget(JSON.stringify(metadata), database, 'trust'),
  );
});
for (const [name, value] of Object.entries({
  empty: null,
  array: [],
  extra: { ...metadata, networks: ['bridge'] },
  missing: { ...metadata, owner: undefined },
  wrongVersion: { ...metadata, version: 2 },
  badId: { ...metadata, containerId: 'a'.repeat(12) },
  badOwner: { ...metadata, owner: 'wrong' },
  zeroAddresses: { ...metadata, serverAddress: [] },
  multipleAddresses: {
    ...metadata,
    serverAddress: ['172.17.0.2', '172.17.0.3'],
  },
  joinedAddresses: { ...metadata, serverAddress: '172.17.0.2 172.18.0.2' },
  cidr: { ...metadata, serverAddress: '172.17.0.2/16' },
  noncanonical: { ...metadata, serverAddress: '172.017.0.2' },
  hostname: { ...metadata, serverAddress: 'postgres' },
  ipv6: { ...metadata, serverAddress: '::1' },
  emptyAddress: { ...metadata, serverAddress: '' },
  remoteBinding: { ...metadata, host: '0.0.0.0' },
  portString: { ...metadata, port: '5423' },
  portZero: { ...metadata, port: 0 },
  portRange: { ...metadata, port: 65536 },
  wrongDatabase: { ...metadata, database: 'production' },
}))
  test(`reject invalid owned Docker metadata: ${name}`, () =>
    assert.throws(() => decode(value)));
test('exact URL binding rejects mismatched host/port/database and query overrides', () => {
  for (const url of [
    database.replace('127.0.0.1', 'localhost'),
    database.replace(':5423', ':5424'),
    database.replace(/\/whaleu_test$/, '/other'),
    database + '?sslmode=disable',
    database + '#fragment',
  ])
    assert.throws(() => decode(metadata, url));
  for (const raw of ['', '{', ' '.repeat(1025)])
    assert.throws(() => readingWorkerDockerTarget(raw, database, 'password'));
});
test('role helper rejects a mismatched address before creating roles and preserves exact grants on match', async () => {
  const target = decode();
  const queries: string[] = [];
  let host = '172.17.0.3';
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ database: 'whaleu_test', host }] };
    },
  } as unknown as Pool;
  await assert.rejects(createReadingWorkerRole(pool, target));
  assert.equal(queries.length, 1);
  host = '172.17.0.2';
  queries.length = 0;
  const role = await createReadingWorkerRole(pool, target);
  assert.equal(
    queries[1],
    `CREATE ROLE "${role.name}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
  );
  assert.ok(queries.slice(2).every((q) => q.startsWith('GRANT ')));
  await role.close();
  assert.deepEqual(queries.slice(-2), [
    `DROP OWNED BY "${role.name}"`,
    `DROP ROLE "${role.name}"`,
  ]);
});
