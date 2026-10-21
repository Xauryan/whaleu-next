import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createContentReferencesOpenApiDocument,
  renderContentReferencesOpenApiDocument,
} from '../scripts/content-references-openapi-document.js';

test('reference OpenAPI keeps bounded read-only authenticated navigation separate from publication and aliases', async () => {
  const doc = createContentReferencesOpenApiDocument();
  assert.equal(Object.keys(doc.paths).length, 3);
  for (const path of Object.values(doc.paths))
    for (const method of ['get', 'post'] as const) {
      const operation = path[method];
      if (!operation) continue;
      assert.deepEqual(operation.security, [{ accessToken: [] }]);
      assert.ok(operation.responses['401']);
      assert.ok(operation.responses['503']);
    }
  const rendered = await renderContentReferencesOpenApiDocument();
  assert.match(rendered, /No allocation during read/);
  assert.match(rendered, /no manager bypass/);
  assert.match(rendered, /"maxItems": 30/);
  assert.match(rendered, /"minItems": 1/);
  assert.match(rendered, /"additionalProperties": false/);
  assert.ok(
    doc.paths['/v1/community/content-references/resolve']!.post!.responses[
      '404'
    ],
  );
  assert.ok(
    doc.paths['/v1/community/content-references/lookup']!.post!.responses[
      '429'
    ],
  );
  for (const field of [
    'accountId',
    'authorId',
    'text',
    'canonicalCode',
    'isAlias',
  ])
    assert.ok(!rendered.includes(`"${field}"`));
});
