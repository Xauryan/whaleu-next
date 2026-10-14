import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
type Builder = {
  createSchoolIdentityOpenApiDocument(): Promise<OpenAPIObject>;
  renderSchoolIdentityOpenApiDocument(): Promise<string>;
};
const builder = () =>
  import(
    new URL(
      '../.openapi-build/scripts/school-identity-openapi-document.js',
      import.meta.url,
    ).href
  ) as Promise<Builder>;
test('school identity/UID OpenAPI exposes strict versioned commands, independent own UID and joint public projection without private lineage', async () => {
  const tools = await builder(),
    doc = await tools.createSchoolIdentityOpenApiDocument();
  for (const path of [
    '/v1/me/school-uid',
    '/v1/admin/school-uids/lookup',
    '/v1/admin/school-identities/management',
    '/v1/admin/school-identities/commands',
    '/v1/admin/school-identities/commands/cancel',
    '/v1/admin/school-identities/requests/{requestId}',
    '/v1/profiles/{profileId}',
  ])
    assert.ok(doc.paths[path], path);
  const rendered = await tools.renderSchoolIdentityOpenApiDocument();
  assert.equal(
    await readFile(
      new URL('../../../docs/openapi/school-identity.json', import.meta.url),
      'utf8',
    ),
    rendered,
  );
  for (const key of [
    'expectedStateVersion',
    'expectedDestinationVersion',
    'schoolUidStatus',
    'formattedUid',
    'correct_school',
    'complete_uid',
  ])
    assert.ok(rendered.includes(key), key);
  for (const key of [
    'accountId',
    'assertionId',
    'allocationId',
    'tokenHash',
    'sessionId',
    'sourceDigest',
    'studentNumber',
  ])
    assert.equal(rendered.includes(`"${key}"`), false, key);
});
