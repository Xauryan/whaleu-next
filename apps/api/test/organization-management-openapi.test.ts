import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
test('organization OpenAPI exposes strict real application, review, member CAS and original-key recovery', async () => {
  const source = await import(
      pathToFileURL(
        require.resolve('../.openapi-build/scripts/organization-management-openapi-document.js'),
      ).href
    ),
    document = await source.createOrganizationManagementOpenApiDocument(),
    paths = document.paths;
  for (const path of [
    '/v1/organizations',
    '/v1/organizations/{organizationId}/content',
    '/v1/organizations/{organizationId}/review',
    '/v1/organizations/{organizationId}/members',
    '/v1/organizations/requests/{requestId}/cancel',
  ])
    assert.ok(paths[path]?.post?.requestBody, path);
  assert.ok(paths['/v3/media/organizations/upload-intents']?.post);
  assert.ok(paths['/v1/organizations/mine']?.get);
  assert.ok(paths['/v1/organizations/regions/{regionId}/entries']?.get);
  const text = JSON.stringify(document);
  assert.ok(text.includes('expectedAuthorityVersion'));
  assert.ok(text.includes('introImage8'));
  assert.ok(text.includes('managerContact'));
  assert.ok(text.includes('additionalProperties'));
});
