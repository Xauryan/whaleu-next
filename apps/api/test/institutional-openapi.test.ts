import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
test('institutional emitted OpenAPI has exactly five strict owner routes and no fixture registration', async () => {
  const require = createRequire(import.meta.url),
    source = await import(
      pathToFileURL(
        require.resolve('../.openapi-build/scripts/institutional-sso-openapi-document.js'),
      ).href
    ),
    doc: OpenAPIObject = await source.createInstitutionalSsoOpenApiDocument();
  const prefix = '/v1/me/institutional-sso';
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    [
      `${prefix}/capability`,
      `${prefix}/requests`,
      `${prefix}/requests/{requestId}`,
      `${prefix}/requests/{requestId}/close`,
      `${prefix}/requests/{requestId}/complete`,
    ].sort(),
  );
  for (const item of Object.values(doc.paths))
    for (const key of ['get', 'post'] as const) {
      const op = item?.[key];
      if (!op) continue;
      assert.deepEqual(op.security, [{ accessToken: [] }]);
      assert.ok(op.responses['200']);
      assert.ok(op.responses['400']);
      assert.ok(op.responses['401']);
    }
  const capability = doc.paths[`${prefix}/capability`]?.get;
  assert.ok(
    capability?.parameters?.some(
      (p) =>
        'name' in p && p.name === 'campusId' && 'required' in p && p.required,
    ),
  );
  const complete = doc.paths[`${prefix}/requests/{requestId}/complete`]?.post;
  assert.ok(complete?.requestBody);
  assert.ok(!JSON.stringify(doc).includes('password'));
});
