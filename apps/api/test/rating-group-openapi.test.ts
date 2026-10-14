import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';

test('promotion emitted OpenAPI preserves opaque admission, bearer authority and actual accepted status', async () => {
  const builder = (await import(
    new URL(
      '../.openapi-build/scripts/rating-group-promotion-openapi-document.js',
      import.meta.url,
    ).href
  )) as {
    renderRatingGroupPromotionOpenApiDocument(): Promise<string>;
  };
  const rendered = await builder.renderRatingGroupPromotionOpenApiDocument();
  assert.equal(
    rendered,
    await readFile(
      new URL(
        '../../../docs/openapi/rating-group-promotion.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const doc = JSON.parse(rendered) as OpenAPIObject;
  const admission =
    doc.paths['/v1/rating-group-promotion/programs/{id}/campaigns']?.post;
  assert.ok(admission);
  assert.deepEqual(admission.security, [{ accessToken: [] }]);
  assert.ok(admission.responses['202']);
  assert.equal(admission.responses['201'], undefined);
  const body = admission.requestBody;
  assert.ok(body && !('$ref' in body));
  const initial = body.content['application/json']?.schema;
  assert.ok(initial);
  const schema = (
    '$ref' in initial
      ? doc.components?.schemas?.[initial.$ref.split('/').at(-1)!]
      : initial
  ) as SchemaObject;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
    'intentTicket',
    'requestHash',
    'requestId',
  ]);
  const capabilities =
    doc.paths['/v1/rating-group-promotion/capabilities']?.get;
  assert.ok(
    capabilities?.parameters?.some(
      (p) =>
        !('$ref' in p) &&
        p.in === 'query' &&
        p.name === 'programId' &&
        p.required,
    ),
  );
  assert.ok(
    Object.keys(doc.paths).every((path) =>
      path.startsWith('/v1/rating-group-promotion/'),
    ),
  );
});
