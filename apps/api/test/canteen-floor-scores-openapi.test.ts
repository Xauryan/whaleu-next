import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
test('independent floor OpenAPI is scalar number, separate history and original-key recovery without mutable or media fields', async () => {
  const source = await import(
    pathToFileURL(
      require.resolve('../.openapi-build/scripts/canteen-floor-scores-openapi-document.js'),
    ).href
  );
  const doc = await source.createCanteenFloorScoresOpenApiDocument();
  const prefix = '/v1/ratings/canteen-floors';
  assert.equal(Object.keys(doc.paths).length, 7);
  for (const path of [
    '/catalog',
    '/{id}',
    '/{id}/my-score',
    '/{id}/summary',
    '/requests/{requestId}',
  ])
    assert.ok(doc.paths[prefix + path]?.get);
  for (const path of ['/{id}/first-score', '/requests/{requestId}/cancel'])
    assert.ok(doc.paths[prefix + path]?.post?.requestBody);
  assert.equal(doc.paths[prefix + '/{id}/score'], undefined);
  const score =
    doc.paths[prefix + '/{id}/first-score'].post.requestBody.content[
      'application/json'
    ].schema.properties.score;
  assert.equal(score.type, 'number');
  assert.equal(score.minimum, 1);
  assert.equal(score.maximum, 5);
  assert.equal(score.multipleOf, undefined);
  const body = JSON.stringify(
    doc.paths[prefix + '/{id}/first-score'].post.requestBody,
  );
  assert.ok(body.includes('expectedCanteenRevision'));
  assert.equal(body.includes('expectedOwnScoreRevision'), false);
  assert.equal(body.includes('comment'), false);
  assert.equal(body.includes('images'), false);
});
