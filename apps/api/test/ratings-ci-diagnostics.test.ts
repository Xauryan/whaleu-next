import assert, { AssertionError } from 'node:assert/strict';
import { test } from 'node:test';
import { ApplicationError } from '../src/http/application-error.js';
import {
  boundedRatingsCiSnapshot,
  RATINGS_CI_DIAGNOSTICS_MAX_BYTES,
  ratingsCiSafeError,
} from './support/ratings-ci-diagnostics.js';

type Snapshot = Parameters<typeof boundedRatingsCiSnapshot>[0];
const empty = (): Snapshot => ({
  fixture: 'ratings-scoped-random-scale',
  enabled: true,
  transactions: 0,
  attempts: [],
  aggregate: {},
  recent: [],
  failures: [],
});

test('ratings CI diagnostics cap full serialized payload and retain newest error summaries', () => {
  const snapshot = empty();
  snapshot.recent = Array.from({ length: 128 }, (_, index) => ({
    transaction: index + 1,
    attempt: 21,
    stage: 'review-epoch-capture',
    boundary: 'query',
    elapsedMs: 100.123,
    outcome: 'ok',
  }));
  snapshot.failures = Array.from({ length: 16 }, (_, index) => ({
    error: {
      transaction: index + 1,
      attempt: 21,
      stage: 'review-fence',
      boundary: 'query',
      elapsedMs: 100.123,
      outcome: 'error',
      ...ratingsCiSafeError({ code: '55P03' }),
    },
    recent: [...snapshot.recent],
  }));
  assert.ok(
    Buffer.byteLength(JSON.stringify(snapshot), 'utf8') >
      RATINGS_CI_DIAGNOSTICS_MAX_BYTES,
  );
  const result = boundedRatingsCiSnapshot(snapshot);
  assert.equal(result.serializedByteLimit, 32768);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result), 'utf8') <=
      RATINGS_CI_DIAGNOSTICS_MAX_BYTES,
  );
  assert.equal(result.truncated, true);
  assert.ok(result.dropped.failureContext > 0);
  assert.equal(result.failures.length, 16);
  assert.deepEqual(
    result.failures.at(-1)?.error,
    snapshot.failures.at(-1)?.error,
  );
  assert.equal(result.recent.at(-1)?.transaction, 128);
  assert.equal(snapshot.failures[0]!.recent.length, 128);
  assert.equal(snapshot.recent.length, 128);
});

test('ratings CI diagnostics disclose count-bound truncation independently of bytes', () => {
  const result = boundedRatingsCiSnapshot(empty(), {
    recent: 1000,
    attempts: 4,
    failures: 2,
  });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.dropped, {
    recent: 1000,
    attempts: 4,
    failures: 2,
    failureContext: 0,
    aggregate: 0,
  });
  assert.equal(boundedRatingsCiSnapshot(empty()).truncated, false);
});

test('ratings CI diagnostics emit only SQLSTATE and whitelisted error metadata', () => {
  const privateText = 'synthetic-secret-body-email-token-connection-string';
  const error = Object.assign(new Error(privateText), {
    code: '55P03',
    detail: privateText,
    hint: privateText,
    query: privateText,
    parameters: [privateText],
  });
  const result = ratingsCiSafeError(error);
  assert.deepEqual(result, {
    sqlstate: '55P03',
    exception: 'PostgresError',
    applicationCode: null,
  });
  assert.equal(JSON.stringify(result).includes(privateText), false);
  const snapshot = empty();
  snapshot.failures = [
    {
      error: {
        transaction: 1,
        attempt: 1,
        stage: 'review-fence',
        boundary: 'query',
        elapsedMs: 1,
        outcome: 'error',
        ...result,
      },
      recent: [],
    },
  ];
  const serialized = JSON.stringify(boundedRatingsCiSnapshot(snapshot));
  assert.equal(serialized.includes(privateText), false);
  for (const forbidden of [
    'message',
    'stack',
    'detail',
    'hint',
    'query',
    'parameters',
  ])
    assert.equal(Object.hasOwn(result, forbidden), false);
  for (const code of ['55P03-extra', '55p03', '1234', privateText])
    assert.deepEqual(ratingsCiSafeError({ code, message: privateText }), {
      sqlstate: null,
      exception: 'unknown',
      applicationCode: null,
    });
  assert.deepEqual(
    ratingsCiSafeError(new AssertionError({ message: privateText })),
    { sqlstate: null, exception: 'AssertionError', applicationCode: null },
  );
  assert.deepEqual(
    ratingsCiSafeError(new ApplicationError('CONTENT_REVIEW_UNAVAILABLE')),
    {
      sqlstate: null,
      exception: 'ApplicationError',
      applicationCode: 'CONTENT_REVIEW_UNAVAILABLE',
    },
  );
  assert.equal(
    ratingsCiSafeError(new ApplicationError('RATING_NOT_FOUND'))
      .applicationCode,
    'other-application-error',
  );
});
