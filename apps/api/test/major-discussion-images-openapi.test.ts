import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
test('Major images v2 OpenAPI exposes independent strict private publication, recovery and typed Media17 routes without delete/original/public URL', async () => {
  const { createMajorDiscussionImagesOpenApiDocument } = (await import(
    new URL(
      '../.openapi-build/scripts/major-discussion-images-openapi-document.js',
      import.meta.url,
    ).href
  )) as {
    createMajorDiscussionImagesOpenApiDocument(): Promise<OpenAPIObject>;
  };
  const doc = await createMajorDiscussionImagesOpenApiDocument();
  for (const [path, method] of [
    ['/v2/majors/{id}/discussion', 'get'],
    ['/v2/majors/{id}/discussion', 'post'],
    ['/v2/majors/{id}/discussion/{rootId}', 'get'],
    ['/v2/majors/{id}/discussion/{rootId}/replies', 'post'],
    ['/v2/majors/discussion-requests/{requestId}', 'get'],
    ['/v2/majors/discussion-requests/{requestId}/cancel', 'post'],
    ['/v2/me/major-discussion/notices', 'get'],
    ['/v3/media/major-discussions/upload-intents', 'post'],
    [
      '/v3/media/major-discussions/upload-intents/{id}/uploads/{grantId}',
      'post',
    ],
    [
      '/v3/media/major-discussions/majors/{majorId}/comments/{commentId}/bindings/{bindingId}',
      'get',
    ],
    [
      '/v3/media/major-discussions/majors/{majorId}/comments/{commentId}/bindings/{bindingId}/{variant}',
      'get',
    ],
  ] as const) {
    const operation = doc.paths[path]?.[method];
    assert.ok(operation, path);
    assert.ok(operation.security?.some((s) => 'accessToken' in s));
    assert.ok(operation.responses['200']);
  }
  const serialized = JSON.stringify(doc);
  assert.ok(serialized.includes('major-discussion-v2'));
  assert.ok(serialized.includes('major-discussion-media-v1'));
  assert.ok(serialized.includes('multipart/form-data'));
  for (const path of Object.keys(doc.paths)) {
    assert.equal(path.includes('/original'), false);
    assert.equal(path.includes('/delete'), false);
    assert.equal(path.startsWith('/v1/'), false);
  }
});
