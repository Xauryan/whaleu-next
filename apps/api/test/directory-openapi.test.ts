import { format } from 'prettier';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  directoryContextSchema,
  directoryCategoryPageSchema,
  directoryEntryPageSchema,
  directoryDetailSchema,
} from '../src/organizations/directory/contracts.js';
const execute = promisify(execFile);
const api = fileURLToPath(new URL('../', import.meta.url));
const probe = `import assert from 'node:assert/strict';import net from 'node:net';import pg from 'pg';import {NestApplication} from '@nestjs/core';const fail=()=>{throw new Error('OpenAPI attempted live work');};net.Server.prototype.listen=fail;net.Socket.prototype.connect=fail;pg.Pool.prototype.connect=fail;pg.Pool.prototype.query=fail;globalThis.setInterval=fail;globalThis.setTimeout=fail;NestApplication.prototype.init=fail;NestApplication.prototype.listen=fail;const {renderDirectoryOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');const first=await renderDirectoryOpenApiDocument();assert.equal(await renderDirectoryOpenApiDocument(),first);process.stdout.write(first);`;
async function render() {
  const result = await execute(
    process.execPath,
    ['--input-type=module', '-e', probe],
    {
      cwd: api,
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
test('directory official Swagger export is offline, deterministic and artifact-current', async () => {
  const first = await render();
  assert.equal(await format(first, { parser: 'json' }), first);
  assert.equal(await render(), first);
  assert.equal(
    await readFile(
      new URL(
        '../../../docs/openapi/organization-directory.json',
        import.meta.url,
      ),
      'utf8',
    ),
    first,
  );
});
test('real directory controllers export only bounded authenticated GETs and exact owner response schemas', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  assert.equal(doc.openapi, '3.0.3');
  assert.deepEqual(Object.keys(doc.paths), [
    '/v1/directory/context',
    '/v1/directory/regions/{regionId}/categories',
    '/v1/directory/regions/{regionId}/entries',
    '/v1/directory/regions/{regionId}/entries/{entryId}',
  ]);
  for (const [path, schema] of [
    ['/v1/directory/context', directoryContextSchema],
    [
      '/v1/directory/regions/{regionId}/categories',
      directoryCategoryPageSchema,
    ],
    ['/v1/directory/regions/{regionId}/entries', directoryEntryPageSchema],
    [
      '/v1/directory/regions/{regionId}/entries/{entryId}',
      directoryDetailSchema,
    ],
  ] as const) {
    const pathItem = doc.paths[path]!;
    assert.deepEqual(Object.keys(pathItem), ['get']);
    const operation = pathItem.get!;
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    assert.equal(operation.requestBody, undefined);
    const response = operation.responses['200']!;
    assert.ok(!('$ref' in response));
    const responseSchema = response.content!['application/json']!.schema;
    assert.deepEqual(
      responseSchema,
      z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'output' }),
    );
    for (const status of [
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '429',
      '500',
      '503',
    ]) {
      const result = operation.responses[status]!;
      assert.ok(result && !('$ref' in result));
      assert.deepEqual(result.headers?.['cache-control'], {
        schema: { type: 'string', enum: ['no-store'] },
      });
      assert.deepEqual(result.headers?.['vary'], {
        schema: { type: 'string', enum: ['Authorization'] },
      });
    }
  }
  const entry = doc.paths['/v1/directory/regions/{regionId}/entries']!.get!;
  assert.match(entry.description!, /Literal ASCII case-insensitive/);
  assert.match(entry.description!, /name-only/);
  const query = (entry.parameters ?? []).filter(
    (item) => !('$ref' in item) && item.in === 'query',
  );
  assert.equal(query.length, 5);
  const detail =
    doc.paths['/v1/directory/regions/{regionId}/entries/{entryId}']!.get!
      .responses['200']!;
  assert.ok(!('$ref' in detail));
  const shape = detail.content!['application/json']!.schema as SchemaObject;
  assert.equal(shape.oneOf?.length, 3);
});
