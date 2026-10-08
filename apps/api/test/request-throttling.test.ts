import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { ConfigurationModule, loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { configureHttp } from '../src/http/http.js';
import { SchemaValidationPipe } from '../src/http/validation.js';
import { IdentityService } from '../src/identity/identity.service.js';
import { mintToken } from '../src/identity/tokens.js';
import { ObservabilityModule } from '../src/observability/logger.js';
import { ViewRequestThrottlingModule } from '../src/request-throttling/module.js';
import { PostgresThrottlerStorage } from '../src/request-throttling/postgres-storage.js';
import { ViewRequestLimit } from '../src/request-throttling/view-request.guard.js';

function storageFixture() {
  let now = 100000;
  let row:
    | { total_hits: number; expires_at: Date; blocked_until: Date | null }
    | undefined;
  let commits = 0;
  const queries: { sql: string; values: unknown[] | undefined }[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.startsWith('INSERT') && !row)
        row = { total_hits: 0, expires_at: new Date(now), blocked_until: null };
      if (sql.startsWith('SELECT total_hits')) return { rows: [row] };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(now) }] };
      if (sql.startsWith('UPDATE')) {
        row = {
          total_hits: values![1] as number,
          expires_at: values![2] as Date,
          blocked_until: values![3] as Date | null,
        };
      }
      return {
        rows: [],
        rowCount: sql.includes('WITH expired AS MATERIALIZED') ? 3 : 0,
      };
    },
  };
  const db = {
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => {
      const result = await operation(tx as unknown as PoolClient);
      commits++;
      return result;
    },
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 3 };
    },
  };
  return {
    storage: new PostgresThrottlerStorage(db as unknown as DatabaseService),
    advance: (ms: number) => {
      now += ms;
    },
    get row() {
      return row;
    },
    get commits() {
      return commits;
    },
    queries,
  };
}

test('shared adapter commits each attempt separately and fixes window/block deadlines', async () => {
  const f = storageFixture();
  const consume = () =>
    f.storage.increment('private-actor-key', 60000, 2, 60000, 'default');
  assert.deepEqual(await consume(), {
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  });
  f.advance(1000);
  assert.equal((await consume()).totalHits, 2);
  assert.deepEqual(await consume(), {
    totalHits: 3,
    timeToExpire: 59,
    isBlocked: true,
    timeToBlockExpire: 60,
  });
  const blocked = f.row!.blocked_until!.getTime();
  f.advance(59000);
  assert.equal(
    (await consume()).isBlocked,
    true,
    'Expired counter window cannot erase a still-active block',
  );
  assert.equal(
    f.row!.blocked_until!.getTime(),
    blocked,
    'Rejected retries do not extend the block',
  );
  f.advance(1000);
  assert.deepEqual(await consume(), {
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  });
  assert.equal(f.commits, 5);
  const key = f.queries.find(({ sql }) => sql.startsWith('INSERT'))!.values![0];
  assert.match(String(key), /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(f.queries).includes('private-actor-key'));
  const lock = f.queries.findIndex(({ sql }) => sql.includes('FOR UPDATE'));
  const clock = f.queries.findIndex(
    ({ sql }) => sql === 'SELECT clock_timestamp() AS now',
  );
  assert.ok(lock < clock, 'Decision time is read after locking');
});

test('storage expiry resets a quiet key; invalid parameters never touch the database', async () => {
  const f = storageFixture();
  await f.storage.increment('key', 60000, 20, 60000, 'default');
  f.advance(60000);
  assert.equal(
    (await f.storage.increment('key', 60000, 20, 60000, 'default')).totalHits,
    1,
  );
  for (const args of [
    ['', 60000, 20, 60000, 'default'],
    ['key', 0, 20, 60000, 'default'],
    ['key', 60000, 0, 60000, 'default'],
    ['key', 60000, 20, 0, 'default'],
    ['key', 60000, 20, 60000, ''],
  ] as const)
    await assert.rejects(
      f.storage.increment(args[0], args[1], args[2], args[3], args[4]),
      /Invalid shared throttler/,
    );
  assert.equal(f.commits, 2);
  assert.equal(await f.storage.cleanup(), 3);
  assert.match(f.queries.at(-1)!.sql, /FOR UPDATE SKIP LOCKED LIMIT 256/);
});

const epochBody = z.strictObject({ version: z.literal(1) });
@Controller('test-view-throttle')
class RequestController {
  @Post('epoch')
  @HttpCode(200)
  @ViewRequestLimit('epoch')
  epoch(@Body(new SchemaValidationPipe(epochBody)) _body: { version: 1 }) {
    return { ok: true };
  }
  @Post('report')
  @HttpCode(200)
  @ViewRequestLimit('report')
  report(): never {
    throw new ApplicationError('VIEW_REPORT_CONFLICT');
  }
  @Post('unrelated')
  @HttpCode(200)
  unrelated() {
    return { ok: true };
  }
}

test('official guard authenticates account, counts invalid/rolled-back calls, and preserves safe 429s', async () => {
  const tokens = [
    mintToken('access'),
    mintToken('access'),
    mintToken('access'),
  ];
  const hits = new Map<string, number>();
  let failStorage = false;
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fixture@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
  });
  const testing = await Test.createTestingModule({
    imports: [
      ConfigurationModule.register(config),
      ObservabilityModule,
      ViewRequestThrottlingModule,
    ],
    controllers: [RequestController],
  })
    .overrideProvider(DatabaseService)
    .useValue({})
    .overrideProvider(IdentityService)
    .useValue({
      session: async (token: string) => {
        if (!tokens.includes(token))
          throw new ApplicationError('SESSION_REVOKED');
        return {
          accountId: token === tokens[2] ? 'other-account' : 'same-account',
        };
      },
    })
    .overrideProvider(PostgresThrottlerStorage)
    .useValue({
      increment: async (key: string, _ttl: number, limit: number) => {
        if (failStorage) throw new Error('private database failure');
        const totalHits = (hits.get(key) ?? 0) + 1;
        hits.set(key, totalHits);
        return {
          totalHits,
          timeToExpire: 60,
          isBlocked: totalHits > limit,
          timeToBlockExpire: 60,
        };
      },
    })
    .compile();
  const app = testing.createNestApplication();
  configureHttp(app);
  await app.init();
  try {
    const http = () => request(app.getHttpServer());
    await http()
      .post('/test-view-throttle/epoch')
      .send({ version: 1 })
      .expect(401);
    await http()
      .post('/test-view-throttle/epoch')
      .set('Authorization', `Bearer ${mintToken('access')}`)
      .send({ version: 1 })
      .expect(401);
    assert.equal(hits.size, 0, 'Unauthenticated input never creates a tracker');
    for (let i = 0; i < 20; i++)
      await http()
        .post('/test-view-throttle/epoch')
        .set('Authorization', `Bearer ${tokens[i % 2]}`)
        .set('x-forwarded-for', `2001:db8::${i}`)
        .send({ version: 1, actorId: 'untrusted' })
        .expect(400);
    const denied = await http()
      .post('/test-view-throttle/epoch')
      .set('Authorization', `Bearer ${tokens[0]}`)
      .send({ version: 1 })
      .expect(429);
    assert.equal(denied.body.error.code, 'RATE_LIMITED');
    assert.equal(denied.headers['retry-after'], '60');
    await http()
      .post('/test-view-throttle/epoch')
      .set('Authorization', `Bearer ${tokens[2]}`)
      .send({ version: 1 })
      .expect(200);
    for (let i = 0; i < 120; i++)
      await http()
        .post('/test-view-throttle/report')
        .set('Authorization', `Bearer ${tokens[0]}`)
        .expect(409);
    await http()
      .post('/test-view-throttle/report')
      .set('Authorization', `Bearer ${tokens[1]}`)
      .expect(429);
    await http().post('/test-view-throttle/unrelated').expect(200);
    assert.equal(
      hits.size,
      3,
      'Account and operation delimit all trackers; tokens/addresses do not',
    );
    failStorage = true;
    const unavailable = await http()
      .post('/test-view-throttle/epoch')
      .set('Authorization', `Bearer ${tokens[2]}`)
      .send({ version: 1 })
      .expect(503);
    assert.equal(unavailable.body.error.code, 'VIEW_REPORTING_UNAVAILABLE');
    assert.ok(
      !JSON.stringify(unavailable.body).includes('private database failure'),
    );
  } finally {
    await app.close();
  }
});
