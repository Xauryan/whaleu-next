import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createSocialUpdatesOpenApiDocument,
  renderSocialUpdatesOpenApiDocument,
} from '../scripts/social-updates-openapi-document.js';

test('local social OpenAPI preserves explicit private category and read semantics', async () => {
  const doc = createSocialUpdatesOpenApiDocument();
  assert.equal(Object.keys(doc.paths).length, 4);
  const rendered = await renderSocialUpdatesOpenApiDocument();
  assert.equal(
    await readFile(
      new URL('../../../docs/openapi/social-updates.json', import.meta.url),
      'utf8',
    ),
    rendered,
  );
  for (const item of Object.values(doc.paths)) {
    for (const method of ['get', 'put'] as const) {
      const operation = item[method];
      if (!operation) continue;
      assert.deepEqual(operation.security, [{ accessToken: [] }]);
      const category = operation.parameters?.find(
        (p) => 'name' in p && p.name === 'category',
      );
      assert.ok(
        category && 'required' in category && category.required === true,
      );
      assert.ok(operation.responses['401']);
      assert.ok(operation.responses['503']);
    }
  }
  assert.ok(doc.paths['/v1/me/social-updates/{noticeId}/read']!.put);
  assert.equal(
    doc.paths['/v1/me/social-updates/{noticeId}/read']!.get,
    undefined,
  );
  assert.match(rendered, /never acknowledge/);
  assert.match(rendered, /original read timestamp/);
  assert.match(rendered, /pending source coverage is null/);
  assert.ok(!rendered.includes('"accountId"'));
  assert.ok(!rendered.includes('"preview"'));
});
