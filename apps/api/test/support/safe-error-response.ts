import assert from 'node:assert/strict';

export function assertSafeErrorResponse(
  body: unknown,
  requestIdHeader: unknown,
  expected: { code: string; message: string },
): void {
  assert.ok(typeof requestIdHeader === 'string');
  assert.match(
    requestIdHeader,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  // Exact equality excludes private fields/text without scanning random IDs
  // for digits that may coincidentally match a hidden count.
  assert.deepEqual(body, {
    error: {
      code: expected.code,
      message: expected.message,
      requestId: requestIdHeader,
    },
  });
}
