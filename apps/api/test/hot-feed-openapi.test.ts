import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import { hotPageSchema } from '../src/community/hot/response-schema.js';
const execute = promisify(execFile);
const probe = `import assert from 'node:assert/strict';import net from 'node:net';import pg from 'pg';import {NestApplication} from '@nestjs/core';const fail=()=>{throw new Error('OpenAPI attempted live work');};net.Server.prototype.listen=fail;net.Socket.prototype.connect=fail;pg.Pool.prototype.connect=fail;pg.Pool.prototype.query=fail;globalThis.setInterval=fail;globalThis.setTimeout=fail;NestApplication.prototype.init=fail;NestApplication.prototype.listen=fail;const {renderHotOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');const first=await renderHotOpenApiDocument();assert.equal(await renderHotOpenApiDocument(),first);process.stdout.write(first);`;
test('hot official Swagger export is offline, strict and artifact-current without private inputs', async () => {
  const result = await execute(
    process.execPath,
    ['--input-type=module', '-e', probe],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        DATABASE_URL: 'invalid:offline-only',
        NODE_ENV: 'production',
      },
    },
  );
  assert.equal(result.stderr, '');
  assert.equal(
    result.stdout,
    await readFile(
      new URL('../../../docs/openapi/community-hot.json', import.meta.url),
      'utf8',
    ),
  );
  const doc = JSON.parse(result.stdout) as OpenAPIObject;
  assert.deepEqual(Object.keys(doc.paths), ['/v1/community/hot']);
  const operation = doc.paths['/v1/community/hot']!.get!;
  assert.deepEqual(operation.security, [{}, { accessToken: [] }]);
  assert.equal(operation.requestBody, undefined);
  const parameters = operation.parameters!.filter((x) => !('$ref' in x));
  assert.deepEqual(
    parameters
      .map((x) => {
        assert.ok(!('$ref' in x));
        return x.name;
      })
      .sort(),
    ['cursor', 'limit', 'range', 'spaceId'],
  );
  const response = operation.responses['200']!;
  assert.ok(!('$ref' in response));
  const expected = z.toJSONSchema(hotPageSchema, {
    target: 'openapi-3.0',
    io: 'output',
  });
  assert.deepEqual(response.content!['application/json']!.schema, {
    $ref: '#/components/schemas/HotPage',
  });
  for (const [name, schema] of Object.entries(expected['definitions'] ?? {})) {
    const normalized = JSON.parse(
      JSON.stringify(schema).replaceAll(
        '#/definitions/',
        '#/components/schemas/',
      ),
    ) as unknown;
    assert.deepEqual(doc.components!.schemas![name], normalized);
  }
  const publicSchema = JSON.stringify(doc.components!.schemas);
  for (const forbidden of [
    'certificate',
    'processedHead',
    'capturedHead',
    'numericProfile',
    'eligibleComments',
    'uniqueEligibleAccounts',
    '"score"',
    '"rank"',
    'actorId',
  ])
    assert.equal(publicSchema.includes(forbidden), false);
  for (const status of ['200', '400', '401', '403', '409', '503', '500']) {
    const item = operation.responses[status]!;
    assert.ok(!('$ref' in item));
    assert.ok(item.headers?.['cache-control']);
    assert.ok(item.headers?.['vary']);
  }
});
