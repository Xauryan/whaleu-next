import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
test('W3 OpenAPI names independent Window roots, flat replies, reversible likes, recovery and local notices', async () => {
  const { createWindowDiscussionOpenApiDocument } = (await import(
    new URL(
      '../.openapi-build/scripts/window-discussion-openapi-document.js',
      import.meta.url,
    ).href
  )) as { createWindowDiscussionOpenApiDocument(): Promise<OpenAPIObject> };
  const doc = await createWindowDiscussionOpenApiDocument();
  for (const [path, method] of [
    ['/v1/ratings/windows/{id}/discussion', 'get'],
    ['/v1/ratings/windows/{id}/discussion', 'post'],
    ['/v1/ratings/windows/{id}/discussion/{rootId}', 'get'],
    ['/v1/ratings/windows/{id}/discussion/{rootId}/replies', 'post'],
    ['/v1/ratings/windows/{id}/discussion/{commentId}/like', 'post'],
    ['/v1/ratings/windows/{id}/discussion/{commentId}/my-like', 'get'],
    ['/v1/ratings/windows/discussion-requests/{requestId}', 'get'],
    ['/v1/ratings/windows/discussion-requests/{requestId}/cancel', 'post'],
    ['/v1/me/window-discussion/notices', 'get'],
    ['/v1/me/window-discussion/notices/{noticeId}/target', 'get'],
    ['/v1/me/window-discussion/notices/{noticeId}/read', 'put'],
  ] as const) {
    const operation = doc.paths[path]?.[method];
    assert.ok(operation, path);
    assert.ok(operation.security?.some((s) => 'accessToken' in s));
    assert.ok(operation.responses['200']);
  }
  assert.equal(Object.keys(doc.paths).length, 10);
});
