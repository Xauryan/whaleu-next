import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSafeErrorResponse } from './support/safe-error-response.js';

const requestId = '10250000-0000-4000-8000-000000000000';
const expected = {
  code: 'COMMUNITY_UNAVAILABLE',
  message: 'Community is unavailable',
};
const body = { error: { ...expected, requestId } };

test('safe error assertion accepts a UUID containing a hidden count', () => {
  // The old whole-body substring check rejected this valid safe response.
  assert.equal(JSON.stringify(body).includes('1025'), true);
  assertSafeErrorResponse(body, requestId, expected);
});

test('safe error assertion rejects leaked counts and text in messages or extra fields', () => {
  for (const leaked of [
    { error: { ...body.error, message: 'Community is unavailable: 1025' } },
    {
      error: {
        ...body.error,
        message: 'Community is unavailable: Synthetic bounded scan',
      },
    },
    { ...body, total: 1025 },
    { error: { ...body.error, postCount: 1025 } },
    { ...body, text: 'Synthetic bounded scan' },
    { error: { ...body.error, text: 'Synthetic bounded scan' } },
  ]) {
    assert.throws(
      () => assertSafeErrorResponse(leaked, requestId, expected),
      assert.AssertionError,
    );
  }
});

test('safe error assertion requires the expected code and matching UUID header', () => {
  assert.throws(
    () =>
      assertSafeErrorResponse(
        { error: { ...body.error, code: 'OTHER_ERROR' } },
        requestId,
        expected,
      ),
    assert.AssertionError,
  );
  assert.throws(
    () =>
      assertSafeErrorResponse(
        body,
        '00000000-0000-4000-8000-000000000000',
        expected,
      ),
    assert.AssertionError,
  );
  for (const invalid of [undefined, 1025, '1025', 'g'.repeat(36)]) {
    assert.throws(
      () =>
        assertSafeErrorResponse(
          { error: { ...expected, requestId: invalid } },
          invalid,
          expected,
        ),
      assert.AssertionError,
    );
  }
});
