import assert from 'node:assert/strict';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
};

test('owner visibility OpenAPI exposes only four authenticated strict owner routes and content-free recovery', async () => {
  const { createOwnerPostVisibilityOpenApiDocument } = (await import(
    new URL(
      '../.openapi-build/scripts/owner-post-visibility-openapi-document.js',
      import.meta.url,
    ).href
  )) as { createOwnerPostVisibilityOpenApiDocument(): Promise<OpenAPIObject> };
  const doc = await createOwnerPostVisibilityOpenApiDocument();
  const resolve = (schema: Schema | undefined): Schema => {
    assert.ok(schema);
    if (!schema.$ref) return schema;
    assert.ok(schema.$ref.startsWith('#/components/schemas/'));
    const referenced =
      doc.components?.schemas?.[
        schema.$ref.slice('#/components/schemas/'.length)
      ];
    assert.ok(referenced);
    return resolve(referenced as Schema);
  };
  const operations = [
    [
      '/v1/me/community/posts/{postId}/owner-visibility',
      'get',
      'ownerPostVisibilityManagement',
    ],
    [
      '/v1/me/community/owner-visibility-commands',
      'post',
      'ownerPostVisibilityCommand',
    ],
    [
      '/v1/me/community/owner-visibility-requests/{requestId}',
      'get',
      'ownerPostVisibilityReceipt',
    ],
    [
      '/v1/me/community/owner-visibility-requests/{requestId}/cancel',
      'post',
      'ownerPostVisibilityCancel',
    ],
  ] as const;
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    operations.map(([path]) => path).sort(),
  );
  for (const [path, method, operationId] of operations) {
    const operation = doc.paths[path]?.[method];
    assert.ok(operation, path);
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    assert.ok(operation.responses['200']);
    const pathParameters = (operation.parameters ?? []).filter(
      (parameter) => !('$ref' in parameter) && parameter.in === 'path',
    );
    if (path.includes('{postId}'))
      assert.ok(
        pathParameters.some(
          (parameter) =>
            !('$ref' in parameter) &&
            parameter.name === 'postId' &&
            parameter.required,
        ),
      );
    if (path.includes('{requestId}'))
      assert.ok(
        pathParameters.some(
          (parameter) =>
            !('$ref' in parameter) &&
            parameter.name === 'requestId' &&
            parameter.required,
        ),
      );
    if (method === 'post') {
      const body = operation.requestBody;
      assert.ok(body && !('$ref' in body));
      assert.equal(body.required, true);
      const schema = resolve(
        body.content['application/json']?.schema as Schema | undefined,
      );
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(schema.required?.slice().sort(), [
        'clientRequestId',
        'expectedVersion',
        'ownerHidden',
        'postId',
      ]);
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
        'clientRequestId',
        'expectedVersion',
        'ownerHidden',
        'postId',
      ]);
      assert.equal(schema.properties?.['ownerHidden']?.type, 'boolean');
      assert.equal(schema.properties?.['expectedVersion']?.type, 'integer');
      assert.equal(schema.properties?.['expectedVersion']?.minimum, 0);
      assert.equal(schema.properties?.['expectedVersion']?.maximum, 2147483646);
      assert.equal(schema.properties?.['clientRequestId']?.format, 'uuid');
      assert.equal(schema.properties?.['postId']?.format, 'uuid');
    }
    const response = operation.responses['200'];
    assert.ok(response && !('$ref' in response));
    const schema = resolve(
      response.content?.['application/json']?.schema as Schema | undefined,
    );
    if (operationId === 'ownerPostVisibilityManagement') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
        'canChange',
        'ownerHidden',
        'postId',
        'version',
      ]);
      assert.deepEqual(schema.required?.slice().sort(), [
        'canChange',
        'ownerHidden',
        'postId',
        'version',
      ]);
    } else {
      const variants = (schema.anyOf ?? schema.oneOf ?? []).map(resolve);
      assert.equal(variants.length, 2);
      const applied = variants.find((variant) =>
        variant.properties?.['outcome']?.enum?.includes('applied'),
      );
      const rejected = variants.find((variant) =>
        variant.properties?.['outcome']?.enum?.includes('rejected'),
      );
      assert.ok(applied && rejected);
      assert.equal(applied.additionalProperties, false);
      assert.equal(rejected.additionalProperties, false);
      assert.deepEqual(Object.keys(applied.properties ?? {}).sort(), [
        'changed',
        'expectedVersion',
        'outcome',
        'ownerHidden',
        'postId',
        'recordedAt',
        'requestId',
        'version',
      ]);
      assert.deepEqual(Object.keys(rejected.properties ?? {}).sort(), [
        'code',
        'expectedVersion',
        'outcome',
        'ownerHidden',
        'postId',
        'requestId',
      ]);
      assert.deepEqual(rejected.properties?.['code']?.enum, [
        'POST_OWNER_VISIBILITY_STALE',
        'POST_OWNER_VISIBILITY_CANCELLED',
        'POST_OWNER_VISIBILITY_UNAVAILABLE',
      ]);
    }
  }
  // No publication payload, moderation action, identity or Media capability leaks
  // into the new owner's independently generated management/recovery artifact.
  const json = JSON.stringify({
    paths: doc.paths,
    schemas: doc.components?.schemas,
  });
  for (const field of [
    'accountId',
    'actorId',
    'authorMode',
    'text',
    'imageAssetIds',
    'storageKey',
    'grantId',
    'approvalId',
    'role',
    'visibility',
    'deletedAt',
  ])
    assert.equal(json.includes(`"${field}":`), false, field);
  assert.equal(doc.paths['/v1/community/posts'], undefined);
});
