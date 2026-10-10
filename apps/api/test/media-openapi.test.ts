import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  mediaAttachmentDescriptorSchema,
  mediaIdSchema,
  mediaIntentStatusSchema,
  mediaVariantSchema,
  prepareMediaSchema,
} from '../src/media/contracts.js';
import {
  mediaCancelRequestSchema,
  mediaCancelV2Schema,
  mediaGrantSchema,
  mediaRequestRecoverySchema,
  mediaStatusV2Schema,
  mediaUploadObservedSchema,
  mediaV2IdSchema,
  prepareMediaV2Schema,
} from '../src/media/contracts-v2.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';
import {
  mediaBinaryResponseHeaders,
  mediaResponseHeaders,
} from '../src/media/openapi.js';

const execute = promisify(execFile);
const probe = `import assert from 'node:assert/strict';
import net from 'node:net';
import pg from 'pg';
import {NestApplication} from '@nestjs/core';
const fail=()=>{throw new Error('Media OpenAPI attempted live work');};
net.Server.prototype.listen=fail;
net.Socket.prototype.connect=fail;
pg.Pool.prototype.connect=fail;
pg.Pool.prototype.query=fail;
globalThis.fetch=fail;
globalThis.setInterval=fail;
globalThis.setTimeout=fail;
NestApplication.prototype.init=fail;
NestApplication.prototype.listen=fail;
const {renderMediaOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');
const first=await renderMediaOpenApiDocument();
assert.equal(await renderMediaOpenApiDocument(),first);
process.stdout.write(first);`;
async function render() {
  const result = await execute(
    process.execPath,
    ['--input-type=module', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        DATABASE_URL: 'invalid:offline-only',
        NODE_ENV: 'production',
      },
    },
  );
  assert.equal(result.stderr, '');
  return result.stdout;
}
const cases = [
  ['/v1/media/upload-intents', 'post', '200'],
  ['/v1/media/upload-intents/{id}', 'get', '200'],
  ['/v1/media/upload-intents/{id}/finalize', 'post', '200'],
  ['/v1/media/upload-intents/{id}/cancel', 'post', '204'],
  ['/v1/media/bindings/{id}/{variant}', 'get', '200'],
] as const;

const v2cases = [
  [
    '/v2/media/upload-intents',
    'post',
    prepareMediaV2Schema,
    mediaStatusV2Schema,
  ],
  [
    '/v2/media/upload-requests/{id}',
    'get',
    undefined,
    mediaRequestRecoverySchema,
  ],
  [
    '/v2/media/upload-requests/{id}/cancel',
    'post',
    mediaCancelRequestSchema,
    mediaRequestRecoverySchema,
  ],
  ['/v2/media/upload-intents/{id}', 'get', undefined, mediaStatusV2Schema],
  [
    '/v2/media/upload-intents/{id}/grant',
    'post',
    z.strictObject({}),
    mediaGrantSchema,
  ],
  [
    '/v2/media/upload-intents/{id}/uploads/{grantId}',
    'post',
    undefined,
    mediaUploadObservedSchema,
  ],
  [
    '/v2/media/upload-intents/{id}/finalize',
    'post',
    z.strictObject({}),
    mediaStatusV2Schema,
  ],
  [
    '/v2/media/upload-intents/{id}/cancel',
    'post',
    z.strictObject({}),
    mediaCancelV2Schema,
  ],
] as const;

test('Media official Swagger export is offline, deterministic and artifact-current', async () => {
  assert.equal(
    await render(),
    await readFile(
      new URL('../../../docs/openapi/media.json', import.meta.url),
      'utf8',
    ),
  );
});

test('Media operations require bearer auth and private sanitized responses', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  assert.equal(doc.openapi, '3.0.3');
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    [...cases, ...v2cases].map(([p]) => p).sort(),
  );
  for (const [path, method, success] of cases) {
    assert.deepEqual(Object.keys(doc.paths[path]!), [method]);
    const operation = doc.paths[path]![method]!;
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    assert.ok(operation.operationId);
    assert.equal(operation.responses['206'], undefined);
    assert.equal(operation.responses['302'], undefined);
    for (const status of [
      success,
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '500',
      '503',
    ]) {
      const response = operation.responses[status]!;
      assert.ok(response && !('$ref' in response));
      for (const [name, value] of Object.entries(mediaResponseHeaders))
        assert.deepEqual(response.headers?.[name], value);
      if (status !== success) {
        assert.deepEqual(response.content!['application/json']!.schema, {
          $ref: '#/components/schemas/SafeErrorResponse',
        });
        assert.deepEqual(
          doc.components?.schemas?.['SafeErrorResponse'],
          z.toJSONSchema(z.strictObject(safeErrorResponseSchema.shape), {
            target: 'openapi-3.0',
            io: 'output',
          }),
        );
      }
    }
    const unavailable = operation.responses['503']!;
    assert.ok(!('$ref' in unavailable));
    assert.match(
      unavailable.description,
      /MEDIA_UNAVAILABLE.*default runtime is disabled/i,
    );
    const parameters = operation.parameters ?? [];
    assert.equal(
      parameters.some((p) => !('$ref' in p) && p.in === 'query'),
      false,
    );
    const id = parameters.find(
      (p) => !('$ref' in p) && p.in === 'path' && p.name === 'id',
    );
    if (path.includes('{id}')) {
      assert.ok(id && !('$ref' in id));
      assert.equal(id.required, true);
      assert.deepEqual(
        id.schema,
        z.toJSONSchema(mediaIdSchema, { target: 'openapi-3.0', io: 'input' }),
      );
    }
    if (method === 'get') assert.equal(operation.requestBody, undefined);
    else {
      const body = operation.requestBody;
      assert.ok(body && !('$ref' in body));
      assert.equal(body.required, true);
      assert.deepEqual(
        body.content['application/json']!.schema,
        z.toJSONSchema(
          path.endsWith('upload-intents')
            ? prepareMediaSchema
            : z.strictObject({}),
          { target: 'openapi-3.0', io: 'input' },
        ),
      );
    }
    const response = operation.responses[success]!;
    assert.ok(!('$ref' in response));
    if (success === '204') assert.equal(response.content, undefined);
    else if (!path.includes('/bindings/'))
      assert.deepEqual(
        response.content!['application/json']!.schema,
        z.toJSONSchema(mediaIntentStatusSchema, {
          target: 'openapi-3.0',
          io: 'output',
        }),
      );
  }
});

test('Media binary delivery and v1 descriptor expose no storage address or original', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  const operation = doc.paths['/v1/media/bindings/{id}/{variant}']!.get!;
  const response = operation.responses['200']!;
  assert.ok(!('$ref' in response));
  assert.deepEqual(response.headers, mediaBinaryResponseHeaders);
  assert.deepEqual(response.content, {
    'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    'image/png': { schema: { type: 'string', format: 'binary' } },
  });
  assert.match(operation.description!, /Range returns 503 MEDIA_UNAVAILABLE/);
  const variant = operation.parameters!.find(
    (p) => !('$ref' in p) && p.name === 'variant',
  );
  assert.ok(variant && !('$ref' in variant));
  assert.deepEqual(
    variant.schema,
    z.toJSONSchema(mediaVariantSchema, { target: 'openapi-3.0', io: 'input' }),
  );
  const descriptor = doc.components!.schemas!['MediaAttachmentDescriptor'];
  assert.deepEqual(
    descriptor,
    z.toJSONSchema(mediaAttachmentDescriptorSchema, {
      target: 'openapi-3.0',
      io: 'output',
    }),
  );
  assert.doesNotMatch(
    JSON.stringify(descriptor),
    /url|provider|bucket|objectKey|original/i,
  );
});

test('Media v2 exports distinct strict recovery/grant/status and actual multipart contracts', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  for (const [path, method, input, output] of v2cases) {
    const operation = doc.paths[path]![method]!;
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    assert.ok(operation.operationId);
    const response = operation.responses['200']!;
    assert.ok(!('$ref' in response));
    assert.deepEqual(response.headers, mediaResponseHeaders);
    assert.deepEqual(
      response.content!['application/json']!.schema,
      z.toJSONSchema(output, { target: 'openapi-3.0', io: 'output' }),
    );
    const parameters = operation.parameters ?? [];
    assert.equal(
      parameters.some((p) => !('$ref' in p) && p.in === 'query'),
      false,
    );
    for (const name of ['id', 'grantId'])
      if (path.includes(`{${name}}`)) {
        const parameter = parameters.find(
          (p) => !('$ref' in p) && p.in === 'path' && p.name === name,
        );
        assert.ok(parameter && !('$ref' in parameter));
        assert.equal(parameter.required, true);
        assert.deepEqual(
          parameter.schema,
          z.toJSONSchema(mediaV2IdSchema, {
            target: 'openapi-3.0',
            io: 'input',
          }),
        );
      }
    if (method === 'get') assert.equal(operation.requestBody, undefined);
    else {
      const body = operation.requestBody;
      assert.ok(body && !('$ref' in body));
      assert.equal(body.required, true);
      if (path.includes('/uploads/')) {
        assert.deepEqual(body.content['multipart/form-data']!.schema, {
          type: 'object',
          additionalProperties: false,
          required: ['file'],
          properties: { file: { type: 'string', format: 'binary' } },
        });
        assert.equal(body.content['application/json'], undefined);
      } else {
        assert.ok(input);
        assert.deepEqual(
          body.content['application/json']!.schema,
          z.toJSONSchema(input, { target: 'openapi-3.0', io: 'input' }),
        );
      }
    }
  }
});
