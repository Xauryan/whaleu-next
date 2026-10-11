import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArgumentsHost } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ApplicationError,
  MediaRequestRateLimited,
} from '../src/http/application-error.js';
import { SafeExceptionFilter } from '../src/http/http.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';
import type { AppLogger } from '../src/observability/logger.js';
import { reserveMediaRequestKey } from '../src/media/intent-repository.js';

test('Shared Media quota keeps its limits and reports minute, daily and midnight retry windows', async () => {
  for (const value of [
    { daily: 10, recent: 10, minute: 37, day: 80000, retry: 37 },
    { daily: 100, recent: 10, minute: 37, day: 7200, retry: 7200 },
    { daily: 100, recent: 0, minute: 1, day: 86400, retry: 86400 },
    { daily: 10, recent: 10, minute: 37, day: 2, retry: 2 },
    { daily: 99, recent: 9, minute: 37, day: 80000, retry: null },
  ]) {
    let queried = 0;
    const tx = {
      async query(sql: string) {
        queried++;
        if (sql.includes('to_regclass')) return { rows: [{ present: true }] };
        assert.match(sql, /ratings_discussion_batch_request_fences/);
        assert.match(sql, /quota_clock AS MATERIALIZED/);
        assert.match(sql, /interval '1 minute'/);
        assert.match(sql, /interval '1 day'/);
        return {
          rows: [
            {
              daily: value.daily,
              recent: value.recent,
              minute_wait_seconds: value.minute,
              daily_wait_seconds: value.day,
            },
          ],
        };
      },
    } as unknown as PoolClient;
    if (value.retry === null) await reserveMediaRequestKey('actor', tx);
    else
      await assert.rejects(
        reserveMediaRequestKey('actor', tx),
        (error: unknown) => {
          assert.ok(error instanceof MediaRequestRateLimited);
          assert.equal(error.code, 'MEDIA_RATE_LIMITED');
          assert.equal(error.retryAfterSeconds, value.retry);
          return true;
        },
      );
    assert.equal(queried, 2);
  }
});

test('Only the typed Media quota controls bounded Retry-After without changing the safe body schema', () => {
  const filter = new SafeExceptionFilter({
    structured: {
      error() {
        assert.fail('No server error expected');
      },
    },
  } as unknown as AppLogger);
  for (const [exception, expected] of [
    [new MediaRequestRateLimited(37), '37'],
    [new MediaRequestRateLimited(7200), '7200'],
    [
      Object.assign(new ApplicationError('MEDIA_RATE_LIMITED'), {
        retryAfterSeconds: 999,
      }),
      '60',
    ],
    [new ApplicationError('RATE_LIMITED'), '60'],
  ] as const) {
    const headers = new Map<string, string>();
    let result: unknown;
    const response = {
      headersSent: false,
      getHeader: (key: string) => headers.get(key),
      setHeader: (key: string, value: string) => headers.set(key, value),
      status(code: number) {
        assert.equal(code, 429);
        return this;
      },
      json(body: unknown) {
        result = body;
      },
    };
    filter.catch(exception, {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost);
    assert.equal(headers.get('retry-after'), expected);
    safeErrorResponseSchema.parse(result);
    assert.deepEqual(Object.keys((result as { error: object }).error).sort(), [
      'code',
      'message',
      'requestId',
    ]);
  }
  for (const invalid of [0, -1, 1.5, 86401, Number.NaN])
    assert.throws(() => new MediaRequestRateLimited(invalid));
});
