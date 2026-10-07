import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
  discoveryScopeHash,
} from '../src/community/discovery-cursors.js';
import { ApplicationError } from '../src/http/application-error.js';

const repository = new DiscoveryCursorRepository();
const scope = discoveryScopeHash(['profile', 'posts', null, 20, 'guest']);
const position = { v: 1, at: '2001-01-01T00:00:00.000Z', id: randomUUID() };
const json = JSON.stringify({ at: position.at, id: position.id, v: 1 });
const digest = createHash('sha256')
  .update('whaleu:discovery:position:v1\0')
  .update(json)
  .digest('hex');
const cursor = randomBytes(32).toString('base64url');
const now = new Date('2026-10-07T00:00:00.000Z');
const row = {
  cursor,
  scope_hash: scope,
  bucket_hash: discoveryCursorBucket(null).hash,
  coordinate_hash: digest,
  position,
  created_at: now,
  expires_at: new Date(now.getTime() + 86400000),
  now,
};
const restart = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'DISCOVERY_RESTART_REQUIRED';
function client(rows: unknown[]) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { tx, queries };
}

test('discovery scope hashes every dimension, uses stable canonical objects, and separates buckets', () => {
  assert.match(scope, /^[a-f0-9]{64}$/);
  assert.equal(
    discoveryScopeHash([{ b: 2, a: 1 }]),
    discoveryScopeHash([{ a: 1, b: 2 }]),
  );
  const dimensions = [
    'profile',
    randomUUID(),
    'posts',
    null,
    20,
    randomUUID(),
    randomUUID(),
  ];
  const expected = discoveryScopeHash(dimensions);
  for (let index = 0; index < dimensions.length; index++) {
    const changed = [...dimensions];
    changed[index] = `${String(changed[index])}-changed`;
    assert.notEqual(discoveryScopeHash(changed), expected);
  }
  const owner = randomUUID();
  assert.deepEqual(
    discoveryCursorBucket(owner),
    discoveryCursorBucket(owner.toUpperCase()),
  );
  assert.equal(discoveryCursorBucket(owner).limit, 256);
  assert.equal(discoveryCursorBucket(null).limit, 1024);
  assert.notEqual(
    discoveryCursorBucket(null).hash,
    discoveryCursorBucket(owner).hash,
  );
  assert.notEqual(
    discoveryCursorBucket(owner).hash,
    discoveryCursorBucket(randomUUID()).hash,
  );
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const invalid of [
    [undefined],
    [NaN],
    [Infinity],
    [new Date()],
    cycle,
    ['x'.repeat(4097)],
  ])
    assert.throws(() => discoveryScopeHash(invalid));
});

test('only a canonical random 32-byte reference is a wire cursor; malformed values never query storage', async () => {
  const { tx, queries } = client([]);
  const noncanonical = `${'A'.repeat(42)}B`;
  for (const value of [
    '',
    ' ',
    `${cursor}=`,
    ` ${cursor}`,
    cursor.slice(1),
    `${cursor}A`,
    noncanonical,
    Buffer.from(JSON.stringify(position)).toString('base64url'),
  ])
    await assert.rejects(repository.get(value, scope, tx), BadRequestException);
  assert.equal(queries.length, 0);
  await assert.rejects(repository.get(cursor, scope, tx), restart);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]!.values, [cursor]);
  assert.doesNotMatch(queries[0]!.sql, /FOR\s+(SHARE|UPDATE)/i);
});

test('scope errors are 400 while expired, missing, corrupt and owner-invalid coordinates require restart', async () => {
  const good = client([row]);
  assert.deepEqual(await repository.get(cursor, scope, good.tx), position);
  assert.equal(
    await repository.get(
      cursor,
      scope,
      good.tx,
      (value) => (value as typeof position).id,
    ),
    position.id,
  );
  await assert.rejects(
    repository.get(cursor, discoveryScopeHash(['other']), good.tx),
    BadRequestException,
  );
  await assert.rejects(
    repository.get(cursor, scope, good.tx, () => {
      throw new Error('private validation detail');
    }),
    restart,
  );
  for (const patch of [
    { expires_at: now },
    { now: new Date(row.expires_at) },
    { created_at: new Date(NaN) },
    { now: new Date(NaN) },
    { bucket_hash: 'raw-owner-id' },
    { coordinate_hash: '0'.repeat(64) },
    { position: { ...position, at: 'changed' } },
    { position: { v: 0 } },
    { position: { v: '1' } },
    { position: { v: 1, body: 'x'.repeat(4097) } },
    { position: null },
    { cursor: 'not-a-token' },
  ])
    await assert.rejects(
      repository.get(cursor, scope, client([{ ...row, ...patch }]).tx),
      restart,
    );
});

test('creation serializes quota after validation, persists only private metadata, and cleanup is bounded', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return sql.includes('INSERT INTO')
        ? { rows: [{ cursor: values[0] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  const token = await repository.create(
    scope,
    discoveryCursorBucket(null),
    position,
    tx,
  );
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(Buffer.from(token, 'base64url').toString('base64url'), token);
  assert.notEqual(token, cursor);
  assert.match(queries[0]!.sql, /pg_advisory_xact_lock/);
  assert.equal(queries.at(-1)!.values[4], json);
  assert.equal(queries.at(-1)!.values[3], digest);
  assert.ok(
    queries.every(
      ({ sql }) => !/whaleu_identity|whaleu_safety|\.posts\b/.test(sql),
    ),
  );
  for (const batch of [0, -1, 1025, 1.2, NaN])
    await assert.rejects(repository.cleanupExpired(tx, batch));
  const previous = queries.length;
  await repository.cleanupExpired(tx, 2);
  assert.equal(queries.length, previous + 1);
  assert.match(queries.at(-1)!.sql, /LIMIT \$1 FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(queries.at(-1)!.values, [2]);
});

test('duplicate output position reuses immutable valid token without renewal or a stored response', async () => {
  const { tx, queries } = client([row]);
  assert.equal(
    await repository.create(scope, discoveryCursorBucket(null), position, tx),
    cursor,
  );
  assert.equal(queries.length, 2);
  assert.match(queries[0]!.sql, /pg_advisory_xact_lock/);
  assert.doesNotMatch(queries[1]!.sql, /UPDATE|INSERT|DELETE/);
  const invalid = client([]);
  await assert.rejects(
    repository.create(
      scope,
      { ...discoveryCursorBucket(randomUUID()), limit: 1024 },
      position,
      invalid.tx,
    ),
  );
  await assert.rejects(
    repository.create(
      scope,
      discoveryCursorBucket(null),
      { v: 1, value: undefined },
      invalid.tx,
    ),
  );
  assert.equal(invalid.queries.length, 0);
});
