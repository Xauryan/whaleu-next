import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
test('M1 OpenAPI names independent Major roots, flat replies, reversible likes, recovery and local notices', async () => {
  const { createMajorDiscussionOpenApiDocument } = (await import(
    new URL(
      '../.openapi-build/scripts/major-discussion-openapi-document.js',
      import.meta.url,
    ).href
  )) as { createMajorDiscussionOpenApiDocument(): Promise<OpenAPIObject> };
  const doc = await createMajorDiscussionOpenApiDocument();
  for (const [path, method] of [
    ['/v1/majors', 'get'],
    ['/v1/majors/departments', 'get'],
    ['/v1/majors/{id}', 'get'],
    ['/v1/majors/{id}/related', 'get'],
    ['/v1/majors/{id}/discussion', 'get'],
    ['/v1/majors/{id}/discussion', 'post'],
    ['/v1/majors/{id}/discussion/{rootId}', 'get'],
    ['/v1/majors/{id}/discussion/{rootId}/replies', 'post'],
    ['/v1/majors/{id}/discussion/{commentId}/like', 'post'],
    ['/v1/majors/{id}/discussion/{commentId}/my-like', 'get'],
    ['/v1/majors/discussion-requests/{requestId}', 'get'],
    ['/v1/majors/discussion-requests/{requestId}/cancel', 'post'],
    ['/v1/me/major-discussion/notices', 'get'],
    ['/v1/me/major-discussion/notices/{noticeId}/target', 'get'],
    ['/v1/me/major-discussion/notices/{noticeId}/read', 'put'],
  ] as const) {
    const operation = doc.paths[path]?.[method];
    assert.ok(operation, path);
    assert.ok(operation.security?.some((s) => 'accessToken' in s));
    assert.ok(operation.responses['200']);
  }
  assert.equal(Object.keys(doc.paths).length, 14);
});
