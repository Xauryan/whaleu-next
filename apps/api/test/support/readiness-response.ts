import assert from 'node:assert/strict';
import { safeErrorResponseSchema } from '../../src/http/error-contracts.js';

export function assertReadinessUnavailableResponse(
  body: unknown,
  requestId: unknown,
): void {
  const parsed = safeErrorResponseSchema.parse(body);
  assert.equal(parsed.error.code, 'NOT_READY');
  assert.equal(parsed.error.message, 'Service is not ready');
  assert.equal(parsed.error.requestId, requestId);
  // The correlation ID is opaque and may legitimately contain migration digits.
  assert.doesNotMatch(
    JSON.stringify({ code: parsed.error.code, message: parsed.error.message }),
    /whaleu_|schema_migrations|checksum|postgresql|0179|password/i,
  );
}
