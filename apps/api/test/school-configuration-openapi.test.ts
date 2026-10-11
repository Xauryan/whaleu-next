import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
test('school configuration OpenAPI describes exact save/recovery/cancellation and guest public entry', async () => {
  const path = require.resolve('../.openapi-build/scripts/openapi-document.js');
  const { createSchoolConfigurationOpenApiDocument } = await import(
    pathToFileURL(path).href
  );
  const document = await createSchoolConfigurationOpenApiDocument();
  assert.ok(document.paths['/v1/school-services']?.get);
  assert.ok(
    document.paths['/v1/me/school-configuration/{regionId}/entries/{entryKey}']
      ?.post?.requestBody,
  );
  assert.ok(
    document.paths['/v1/me/school-configuration/requests/{requestId}/cancel']
      ?.post?.requestBody,
  );
  assert.ok(
    document.paths['/v3/media/school-configuration/entries/{key}/descriptor']
      ?.get,
  );
  const serialized = JSON.stringify(document);
  assert.ok(!serialized.includes('appSecret'));
});
