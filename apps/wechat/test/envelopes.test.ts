import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeResponse, responseError } from '../src/api/envelopes';
import { ClientError } from '../src/api/errors';
import { response } from './helpers';

test('new backend error code and correlation ID survive without exposing server message', () => {
  const requestId = '12345678-1234-4123-8123-123456789abc';
  const error = responseError(
    response(
      {
        error: {
          code: 'NOT_READY',
          message: 'synthetic private diagnostic',
          requestId,
        },
      },
      503,
    ),
  );
  assert.equal(error?.kind, 'http');
  assert.deepEqual(error?.details, {
    httpStatus: 503,
    serverCode: 'NOT_READY',
    requestId,
  });
  assert.equal(JSON.stringify(error).includes('private diagnostic'), false);
});
test('HTTP401, forbidden and validation have explicit stable categories', () => {
  assert.equal(
    responseError(response({ error: { code: 'UNAUTHORIZED' } }, 401))?.kind,
    'auth-required',
  );
  assert.equal(
    responseError(response({ error: { code: 'ACCESS_TOKEN_EXPIRED' } }, 401))
      ?.kind,
    'auth-expired',
  );
  assert.equal(
    responseError(response({ error: { code: 'FORBIDDEN' } }, 403))?.kind,
    'forbidden',
  );
  assert.equal(
    responseError(response({ error: { code: 'BAD_REQUEST' } }, 400))?.kind,
    'business',
  );
});
test('malformed diagnostic fields never leak arbitrary text', () => {
  const error = responseError(
    response(
      {
        error: {
          code: 'https://secret.invalid/token',
          requestId: 'secret value',
          message: 'anything',
        },
      },
      500,
    ),
  );
  assert.deepEqual(error?.details, { httpStatus: 500 });
});
test('2xx error envelopes and impossible statuses are protocol failures', () => {
  assert.equal(
    responseError(response({ error: { code: 'UNAUTHORIZED' } }, 200))?.kind,
    'protocol',
  );
  for (const status of [0, NaN, 99, 600, 200.1])
    assert.equal(responseError(response({}, status))?.kind, 'protocol');
});
test('endpoint decoder verifies success DTO without assuming all 2xx bodies are valid', () => {
  const decode = (value: unknown): number => {
    if (typeof value !== 'number') throw new Error('raw payload');
    return value;
  };
  assert.equal(decodeResponse(response(42), decode), 42);
  assert.throws(() => decodeResponse(response({}), decode), {
    kind: 'protocol',
  });
});
test('domain categories stay distinct without depending on legacy numeric envelopes', () => {
  const phone = new ClientError(
    'phone-verification-required',
    'Phone verification is required',
  );
  const audit = new ClientError(
    'content-audit-rejected',
    'Content did not pass review',
  );
  assert.notEqual(phone.kind, audit.kind);
});

test('backend business whitelist preserves phone verification and content review distinction', () => {
  assert.equal(
    responseError(
      response({ error: { code: 'PHONE_VERIFICATION_REQUIRED' } }, 403),
    )?.kind,
    'phone-verification-required',
  );
  assert.equal(
    responseError(response({ error: { code: 'CONTENT_REVIEW_REJECTED' } }, 422))
      ?.kind,
    'content-audit-rejected',
  );
  assert.equal(
    responseError(response({ error: { code: 'SESSION_REVOKED' } }, 401))?.kind,
    'auth-required',
  );
});

test('recognized business code with a conflicting HTTP status is a protocol error', () => {
  for (const [code, status] of [
    ['ACCESS_TOKEN_EXPIRED', 403],
    ['SESSION_REVOKED', 422],
    ['PHONE_VERIFICATION_REQUIRED', 401],
    ['CONTENT_REVIEW_REJECTED', 403],
  ] as const) {
    assert.equal(
      responseError(response({ error: { code } }, status))?.kind,
      'protocol',
    );
  }
});
