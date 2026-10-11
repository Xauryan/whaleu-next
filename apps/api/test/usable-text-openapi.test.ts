import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';

const probe = `import net from 'node:net';import pg from 'pg';import {NestApplication} from '@nestjs/core';
const fail=()=>{throw new Error('OpenAPI attempted live work');};
net.Server.prototype.listen=fail;net.Socket.prototype.connect=fail;pg.Pool.prototype.connect=fail;pg.Pool.prototype.query=fail;globalThis.fetch=fail;globalThis.setInterval=fail;NestApplication.prototype.init=fail;NestApplication.prototype.listen=fail;
const {renderUsableTextOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');process.stdout.write(await renderUsableTextOpenApiDocument());`;
test('emitted non-production review and phone OpenAPI covers every owned route without live work', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', probe],
    { cwd: new URL('..', import.meta.url), maxBuffer: 1024 * 1024 },
  );
  assert.equal(
    stdout,
    await readFile(
      new URL(
        '../../../docs/openapi/usable-text-workflow.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const doc = JSON.parse(stdout) as OpenAPIObject;
  const routes = [
    ['post', '/v1/community/reviews/posts'],
    ['post', '/v1/community/reviews/posts/{id}/comments'],
    ['post', '/v1/community/reviews/comments/{id}/replies'],
    ['get', '/v1/community/reviews/requests/{requestId}'],
    ['post', '/v1/community/reviews/requests/{requestId}/cancel'],
    ['post', '/v1/me/phone-binding/requests'],
    ['get', '/v1/me/phone-binding/requests/{requestId}'],
    ['post', '/v1/me/phone-binding/requests/{requestId}/authorize'],
    ['post', '/v1/me/phone-binding/requests/{requestId}/close'],
  ] as const;
  assert.equal(
    Object.values(doc.paths).reduce(
      (n, p) => n + Number(!!p.get) + Number(!!p.post),
      0,
    ),
    9,
  );
  for (const [method, path] of routes) {
    const operation = doc.paths[path]?.[method];
    assert.ok(operation, `${method} ${path}`);
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    const response = operation.responses['200'];
    assert.ok(response && !('$ref' in response));
    assert.ok(response.content?.['application/json']?.schema);
    assert.ok(response.headers?.['cache-control']);
    if (method === 'post') {
      const body = operation.requestBody;
      assert.ok(body && !('$ref' in body));
      assert.ok(body.required);
      assert.ok(body.content['application/json']?.schema);
    }
  }
  for (const path of Object.keys(doc.paths).filter((p) =>
    p.includes('phone-binding'),
  )) {
    for (const method of ['get', 'post'] as const) {
      const response = doc.paths[path]?.[method]?.responses['200'];
      if (!response || '$ref' in response) continue;
      const schema = response.content?.['application/json']
        ?.schema as SchemaObject;
      assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
        'requestId',
        'state',
      ]);
      assert.equal(schema.additionalProperties, false);
    }
  }
});
