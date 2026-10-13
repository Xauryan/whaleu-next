import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
type Builder = {
  createSchoolAdminManagementOpenApiDocument(): Promise<OpenAPIObject>;
  renderSchoolAdminManagementOpenApiDocument(): Promise<string>;
};
const builder = async (): Promise<Builder> =>
  import(
    new URL(
      '../.openapi-build/scripts/school-admin-management-openapi-document.js',
      import.meta.url,
    ).href
  ) as Promise<Builder>;
test('school management OpenAPI has four independently named private operations and exact checked artifact', async () => {
  const tools = await builder(),
    doc = await tools.createSchoolAdminManagementOpenApiDocument();
  assert.equal(doc.openapi, '3.0.3');
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    [
      '/v1/admin/school-administrators/management',
      '/v1/admin/school-administrators/commands',
      '/v1/admin/school-administrators/commands/cancel',
      '/v1/admin/school-administrators/requests/{requestId}',
    ].sort(),
  );
  for (const [path, method, id] of [
    ['management', 'get', 'schoolAdminManagement'],
    ['commands', 'post', 'schoolAdminManagementCommand'],
    ['commands/cancel', 'post', 'schoolAdminManagementCancel'],
    ['requests/{requestId}', 'get', 'schoolAdminManagementRecovery'],
  ] as const) {
    const operation =
      doc.paths[`/v1/admin/school-administrators/${path}`]?.[method];
    assert.ok(operation);
    assert.equal(operation.operationId, id);
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    assert.ok(operation.responses['200']);
  }
  const rendered = await tools.renderSchoolAdminManagementOpenApiDocument();
  assert.equal(
    await readFile(
      new URL(
        '../../../docs/openapi/school-admin-management.json',
        import.meta.url,
      ),
      'utf8',
    ),
    rendered,
  );
  assert.match(rendered, /targetProfileId/);
  assert.match(rendered, /expectedStateVersion/);
  assert.match(rendered, /titleGranted/);
  for (const forbidden of [
    'studentNumber',
    'openid',
    'sessionId',
    'grantId',
    'approvedBy',
  ])
    assert.equal(rendered.includes(`"${forbidden}"`), false);
});
