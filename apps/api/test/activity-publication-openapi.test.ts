import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
test('activity OpenAPI separates native commands/review recovery and Media11 from accepted legacy catalogs', async () => {
  const source = await import(
      pathToFileURL(
        require.resolve('../.openapi-build/scripts/activity-publication-openapi-document.js'),
      ).href
    ),
    document = await source.createActivityPublicationOpenApiDocument(),
    paths = document.paths;
  for (const path of [
    '/v1/activity-publication/organizers',
    '/v1/activity-publication/catalog',
    '/v1/activity-publication/mine',
    '/v1/activity-publication/requests/{requestId}',
  ])
    assert.ok(paths[path]?.get, path);
  assert.ok(
    paths['/v1/activity-publication/drafts/{activityId}/commands']?.post
      ?.requestBody,
  );
  assert.ok(
    paths['/v1/activity-publication/requests/{requestId}/cancel']?.post,
  );
  assert.ok(paths['/v3/media/activities/upload-intents']?.post);
  const text = JSON.stringify(document);
  for (const field of [
    'gallery8',
    'showOrganizerQr',
    'organizationRevision',
    'requestHash',
    'additionalProperties',
  ])
    assert.ok(text.includes(field), field);
  assert.equal(text.includes('managerContact'), false);
});
