import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
test('school posting documentation exposes the original-key administrator workflow with strict bodies', async () => {
  const source = await import(
    pathToFileURL(
      require.resolve('../.openapi-build/scripts/school-posting-policy-openapi-document.js'),
    ).href
  );
  const document = await source.createSchoolPostingPolicyOpenApiDocument();
  const paths = document.paths;
  assert.ok(paths['/v1/me/school-posting-policy']?.get);
  assert.ok(
    paths['/v1/me/school-posting-policy/{regionId}']?.post?.requestBody,
  );
  assert.ok(paths['/v1/me/school-posting-policy/requests/{requestId}']?.get);
  assert.ok(
    paths['/v1/me/school-posting-policy/requests/{requestId}/cancel']?.post
      ?.requestBody,
  );
  assert.equal(Object.keys(paths).length, 4);
  const receipt = JSON.stringify(paths);
  assert.ok(receipt.includes('expectedRevision'));
  assert.ok(receipt.includes('policy_exempt'));
  assert.equal(receipt.includes('relatedSyncEnabled'), false);
});
