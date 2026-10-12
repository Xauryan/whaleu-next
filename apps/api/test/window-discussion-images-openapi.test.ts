import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
test('Window images v2 OpenAPI exposes independent strict private publication, recovery and typed Media16 routes without delete/original/public URL', async () => {
  const { createWindowDiscussionImagesOpenApiDocument } = (await import(
    new URL(
      '../.openapi-build/scripts/window-discussion-images-openapi-document.js',
      import.meta.url,
    ).href
  )) as {
    createWindowDiscussionImagesOpenApiDocument(): Promise<OpenAPIObject>;
  };
  const doc = await createWindowDiscussionImagesOpenApiDocument();
  for (const [path, method] of [
    ['/v2/ratings/windows/{id}/discussion', 'get'],
    ['/v2/ratings/windows/{id}/discussion', 'post'],
    ['/v2/ratings/windows/{id}/discussion/{rootId}', 'get'],
    ['/v2/ratings/windows/{id}/discussion/{rootId}/replies', 'post'],
    ['/v2/ratings/windows/discussion-requests/{requestId}', 'get'],
    ['/v2/ratings/windows/discussion-requests/{requestId}/cancel', 'post'],
    ['/v2/me/window-discussion/notices', 'get'],
    ['/v3/media/window-discussions/upload-intents', 'post'],
    [
      '/v3/media/window-discussions/upload-intents/{id}/uploads/{grantId}',
      'post',
    ],
    [
      '/v3/media/window-discussions/windows/{windowId}/comments/{commentId}/bindings/{bindingId}',
      'get',
    ],
    [
      '/v3/media/window-discussions/windows/{windowId}/comments/{commentId}/bindings/{bindingId}/{variant}',
      'get',
    ],
  ] as const) {
    const operation = doc.paths[path]?.[method];
    assert.ok(operation, path);
    assert.ok(operation.security?.some((s) => 'accessToken' in s));
    assert.ok(operation.responses['200']);
  }
  const serialized = JSON.stringify(doc);
  assert.ok(serialized.includes('window-discussion-v2'));
  assert.ok(serialized.includes('window-discussion-media-v1'));
  assert.ok(serialized.includes('multipart/form-data'));
  for (const path of Object.keys(doc.paths)) {
    assert.equal(path.includes('/original'), false);
    assert.equal(path.includes('/delete'), false);
    assert.equal(path.startsWith('/v1/'), false);
  }
});
