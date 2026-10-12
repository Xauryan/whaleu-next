import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
test('independent post pin OpenAPI retains exact command/cancel keys without widening existing feed or PostView', async () => {
  const source = await import(
    pathToFileURL(
      require.resolve('../.openapi-build/scripts/scoped-post-pins-openapi-document.js'),
    ).href
  );
  const document = await source.createScopedPostPinsOpenApiDocument();
  assert.equal(Object.keys(document.paths).length, 6);
  assert.ok(document.paths['/v1/community/post-pins']?.get);
  assert.ok(document.paths['/v1/community/post-pin-slot']?.get);
  assert.ok(document.paths['/v1/community/posts/{postId}/pin']?.get);
  assert.ok(
    document.paths['/v1/community/post-pin-commands']?.post?.requestBody,
  );
  assert.ok(
    document.paths['/v1/me/community/post-pin-requests/{requestId}/cancel']
      ?.post?.requestBody,
  );
  const json = JSON.stringify(document);
  for (const field of [
    'pinId',
    'durationHours',
    'level',
    'readState',
    'POST_PIN_CANCELLED',
  ])
    assert.ok(json.includes(field));
  assert.equal(document.paths['/v1/community/posts'], undefined);
});
