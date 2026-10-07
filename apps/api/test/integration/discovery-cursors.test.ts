import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BadRequestException } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
  discoveryScopeHash,
} from '../../src/community/discovery-cursors.js';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

const restart = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'DISCOVERY_RESTART_REQUIRED';
const constraint = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === '23514';
function coordinateHash(n: number) {
  return createHash('sha256')
    .update('whaleu:discovery:position:v1\0')
    .update(JSON.stringify({ n, v: 1 }))
    .digest('hex');
}

test(
  'durable discovery references: forward migration, immutable retries, quotas, expiry and bounded cleanup',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Use disposable loopback whaleu_test; no silent skips');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
    });
    const pool = new Pool(poolOptions(config));
    const repository = new DiscoveryCursorRepository();
    const tx = <T>(operation: (client: PoolClient) => Promise<T>) =>
      inTransaction(pool, operation);
    let suite: PoolClient | undefined;
    let owns = false,
      locked = false;
    const owner = randomUUID();
    const bucket = discoveryCursorBucket(owner);
    const scope = discoveryScopeHash([
      'community-liked',
      owner,
      randomUUID(),
      20,
    ]);
    async function seed(
      bucketHash: string,
      scopeHash: string,
      count: number,
      expired: boolean,
    ) {
      const now = (
        await pool.query<{ now: Date }>('SELECT clock_timestamp() AS now')
      ).rows[0]!.now.getTime();
      const records = Array.from({ length: count }, (_, n) => ({
        cursor: randomBytes(32).toString('base64url'),
        coordinate_hash: coordinateHash(n),
        position: { v: 1, n },
        created_at: new Date(
          now - (expired ? 2 * 86400000 : 600000) + n,
        ).toISOString(),
      }));
      await pool.query(
        `INSERT INTO whaleu_community.discovery_cursors(cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at)
       SELECT r.cursor,$1,$2,r.coordinate_hash,r.position,r.created_at,r.created_at+interval '24 hours'
         FROM jsonb_to_recordset($3::jsonb) AS r(cursor text,coordinate_hash text,position jsonb,created_at timestamptz)`,
        [scopeHash, bucketHash, JSON.stringify(records)],
      );
      return records;
    }
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run disposable suites serially');
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer AS v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
        'Refuse existing WhaleU schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert.equal(migrations.at(-1)!.name, '0020_discovery_cursors.sql');
      await runMigrations(pool, migrations, { mode: 'up' });
      await runMigrations(pool, migrations, { mode: 'up' });

      await t.test(
        'migration creates only metadata and supports the public profile keyset',
        async () => {
          const columns = (
            await pool.query<{ column_name: string }>(
              "SELECT column_name FROM information_schema.columns WHERE table_schema='whaleu_community' AND table_name='discovery_cursors' ORDER BY ordinal_position",
            )
          ).rows.map((row) => row.column_name);
          assert.deepEqual(columns, [
            'cursor',
            'scope_hash',
            'bucket_hash',
            'coordinate_hash',
            'position',
            'created_at',
            'expires_at',
          ]);
          const definition = (
            await pool.query<{ definition: string }>(
              "SELECT pg_get_indexdef('whaleu_community.posts_public_profile_keyset'::regclass) AS definition",
            )
          ).rows[0]!.definition;
          assert.match(
            definition,
            /account_id, \(\(category = 'trading'::text\)\), published_at DESC, id DESC/,
          );
          assert.match(definition, /author_mode = 'named'/);
          assert.match(definition, /visibility = 'approved'/);
          assert.match(definition, /deleted_at IS NULL/);
        },
      );

      await t.test(
        'new process replay retains an opaque reference and exact immutable coordinate, not a response',
        async () => {
          const coordinate = { v: 1, n: 5000 };
          const cursor = await tx((client) =>
            repository.create(scope, bucket, coordinate, client),
          );
          assert.match(cursor, /^[A-Za-z0-9_-]{43}$/);
          assert.equal(Buffer.from(cursor, 'base64url').length, 32);
          assert.deepEqual(
            await tx((client) =>
              new DiscoveryCursorRepository().get(cursor, scope, client),
            ),
            coordinate,
          );
          const before = (
            await pool.query(
              'SELECT * FROM whaleu_community.discovery_cursors WHERE cursor=$1',
              [cursor],
            )
          ).rows[0];
          const duplicate = await tx((client) =>
            repository.create(scope, bucket, { n: 5000, v: 1 }, client),
          );
          assert.equal(duplicate, cursor);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.discovery_cursors WHERE cursor=$1',
                [cursor],
              )
            ).rows[0],
            before,
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.discovery_cursors SET position=$2 WHERE cursor=$1',
              [cursor, { v: 1, n: 5001 }],
            ),
            constraint,
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.discovery_cursors SET expires_at=expires_at+interval '1 hour' WHERE cursor=$1",
              [cursor],
            ),
            constraint,
          );
          await assert.rejects(
            tx((client) => repository.get(`${cursor}=`, scope, client)),
            BadRequestException,
          );
          await assert.rejects(
            tx((client) =>
              repository.get(
                cursor,
                discoveryScopeHash(['another-session']),
                client,
              ),
            ),
            BadRequestException,
          );
          await assert.rejects(
            tx((client) =>
              repository.get(cursor, scope, client, () => {
                throw new Error('bad owner version');
              }),
            ),
            restart,
          );
          await assert.rejects(
            tx((client) =>
              repository.get(
                randomBytes(32).toString('base64url'),
                scope,
                client,
              ),
            ),
            restart,
          );
        },
      );

      await t.test(
        'concurrent retry allocates one reference under the transaction quota lock',
        async () => {
          const refs = await Promise.all(
            Array.from({ length: 24 }, () =>
              tx((client) =>
                repository.create(scope, bucket, { v: 1, n: 5001 }, client),
              ),
            ),
          );
          assert.equal(new Set(refs).size, 1);
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors WHERE scope_hash=$1 AND coordinate_hash=$2',
                [scope, coordinateHash(5001)],
              )
            ).rows[0]!.n,
            1,
          );
        },
      );

      await t.test(
        'expired same-position references never renew or reopen; corruption requires restart',
        async () => {
          const expiredScope = discoveryScopeHash(['expired', randomUUID()]);
          const [expired] = await seed(bucket.hash, expiredScope, 1, true);
          await assert.rejects(
            tx((client) =>
              repository.get(expired!.cursor, expiredScope, client),
            ),
            restart,
          );
          const replacement = await tx((client) =>
            repository.create(expiredScope, bucket, { v: 1, n: 0 }, client),
          );
          assert.notEqual(replacement, expired!.cursor);
          await assert.rejects(
            tx((client) =>
              repository.get(expired!.cursor, expiredScope, client),
            ),
            restart,
          );
          assert.deepEqual(
            await tx((client) =>
              repository.get(replacement, expiredScope, client),
            ),
            { v: 1, n: 0 },
          );
          const corrupt = randomBytes(32).toString('base64url');
          await pool.query(
            `WITH instant AS (SELECT clock_timestamp() AS now)
        INSERT INTO whaleu_community.discovery_cursors(cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at)
        SELECT $1,$2,$3,$4,'{"v":1,"n":10}'::jsonb,now,now+interval '24 hours' FROM instant`,
            [corrupt, expiredScope, bucket.hash, coordinateHash(999)],
          );
          await assert.rejects(
            tx((client) => repository.get(corrupt, expiredScope, client)),
            restart,
          );
        },
      );

      await t.test(
        'cursor expiry is rechecked after a deferred transaction wait',
        async () => {
          const deadlineScope = discoveryScopeHash(['deadline', randomUUID()]);
          const cursor = randomBytes(32).toString('base64url');
          await pool.query(
            `WITH instant AS (SELECT date_trunc('milliseconds',clock_timestamp())+interval '350 milliseconds' AS expiry)
        INSERT INTO whaleu_community.discovery_cursors(cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at)
        SELECT $1,$2,$3,$4,'{"v":1,"n":1}'::jsonb,expiry-interval '24 hours',expiry FROM instant`,
            [cursor, deadlineScope, bucket.hash, coordinateHash(1)],
          );
          await assert.rejects(
            tx(async (client) => {
              assert.deepEqual(
                await repository.get(cursor, deadlineScope, client),
                { v: 1, n: 1 },
              );
              await sleep(500);
            }),
            restart,
          );
        },
      );

      await t.test(
        'per-account cap is shared across scopes while forward traversal continues beyond the cap',
        async () => {
          const account = discoveryCursorBucket(randomUUID());
          const scopes = [
            discoveryScopeHash(['posts', randomUUID()]),
            discoveryScopeHash(['liked', randomUUID()]),
          ];
          const refs: string[] = [];
          for (let n = 0; n < 270; n++) {
            // Each request reads its input before the final quota-writing step.
            refs.push(
              await tx(async (client) => {
                if (n)
                  assert.deepEqual(
                    await repository.get(
                      refs[n - 1]!,
                      scopes[(n - 1) % 2]!,
                      client,
                    ),
                    { v: 1, n: n - 1 },
                  );
                return repository.create(
                  scopes[n % 2]!,
                  account,
                  { v: 1, n },
                  client,
                );
              }),
            );
          }
          assert.equal(new Set(refs).size, refs.length);
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1',
                [account.hash],
              )
            ).rows[0]!.n,
            256,
          );
          await assert.rejects(
            tx((client) => repository.get(refs[0]!, scopes[0]!, client)),
            restart,
          );
          assert.deepEqual(
            await tx((client) =>
              repository.get(refs.at(-1)!, scopes[1]!, client),
            ),
            { v: 1, n: 269 },
          );
          assert.ok(
            (
              await pool.query(
                'SELECT cursor FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1',
                [bucket.hash],
              )
            ).rowCount! > 0,
            'Other account remains untouched',
          );
        },
      );

      await t.test(
        'guest references share a global 1024 cap and evict oldest navigation only',
        async () => {
          const guest = discoveryCursorBucket(null);
          const guestScope = discoveryScopeHash(['guest-seed']);
          const records = await seed(guest.hash, guestScope, 1024, false);
          const nextScope = discoveryScopeHash(['guest-another-profile']);
          const next = await tx((client) =>
            repository.create(nextScope, guest, { v: 1, n: 1024 }, client),
          );
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1',
                [guest.hash],
              )
            ).rows[0]!.n,
            1024,
          );
          await assert.rejects(
            tx((client) =>
              repository.get(records[0]!.cursor, guestScope, client),
            ),
            restart,
          );
          assert.deepEqual(
            await tx((client) =>
              repository.get(records.at(-1)!.cursor, guestScope, client),
            ),
            { v: 1, n: 1023 },
          );
          assert.deepEqual(
            await tx((client) => repository.get(next, nextScope, client)),
            { v: 1, n: 1024 },
          );
          await assert.rejects(
            tx((client) => repository.get(next, scope, client)),
            BadRequestException,
          );
        },
      );

      await t.test(
        'get never holds a cursor row lock before domain work',
        async () => {
          const cursor = await tx((client) =>
            repository.create(scope, bucket, { v: 1, n: 6000 }, client),
          );
          const reader = await pool.connect();
          try {
            await reader.query('BEGIN');
            assert.deepEqual(await repository.get(cursor, scope, reader), {
              v: 1,
              n: 6000,
            });
            await tx(async (client) => {
              await client.query("SET LOCAL statement_timeout='500ms'");
              assert.equal(
                (
                  await client.query(
                    'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
                    [cursor],
                  )
                ).rowCount,
                1,
              );
            });
          } finally {
            await reader.query('ROLLBACK');
            reader.release();
          }
          await assert.rejects(
            tx((client) => repository.get(cursor, scope, client)),
            restart,
          );
        },
      );

      await t.test(
        'manual cleanup deletes a bounded expired batch, skips locked rows, and preserves valid refs',
        async () => {
          // Remove earlier expired fixtures before counting this isolated cleanup.
          while (
            await tx((client) => repository.cleanupExpired(client, 1024))
          ) {
            /* drain bounded batches */
          }
          const cleanupScope = discoveryScopeHash(['cleanup', randomUUID()]);
          const records = await seed(
            discoveryCursorBucket(randomUUID()).hash,
            cleanupScope,
            5,
            true,
          );
          const validBefore = (
            await pool.query<{ n: number }>(
              'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors WHERE expires_at>clock_timestamp()',
            )
          ).rows[0]!.n;
          const blocker = await pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT cursor FROM whaleu_community.discovery_cursors WHERE cursor=$1 FOR UPDATE',
              [records[0]!.cursor],
            );
            assert.equal(
              await tx(async (client) => {
                await client.query("SET LOCAL statement_timeout='500ms'");
                return repository.cleanupExpired(client, 2);
              }),
              2,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT cursor FROM whaleu_community.discovery_cursors WHERE scope_hash=$1',
                  [cleanupScope],
                )
              ).rowCount,
              3,
            );
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          assert.equal(
            await tx((client) => repository.cleanupExpired(client, 2)),
            2,
          );
          assert.equal(
            await tx((client) => repository.cleanupExpired(client, 2)),
            1,
          );
          assert.equal(
            await tx((client) => repository.cleanupExpired(client, 2)),
            0,
          );
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors WHERE expires_at>clock_timestamp()',
              )
            ).rows[0]!.n,
            validBefore,
          );
        },
      );
    } finally {
      try {
        if (owns)
          for (const schema of migrationSchemaNames)
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        if (locked)
          await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        suite?.release();
        await pool.end();
      }
    }
  },
);
