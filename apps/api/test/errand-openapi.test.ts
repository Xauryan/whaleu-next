import { errandAdminPageSchema } from '../src/errands/admin-contracts.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  errandReceiptSchema,
  errandPageSchema,
  errandDetailSchema,
  errandContactHistorySchema,
} from '../src/errands/contracts.js';
import {
  errandNoticesPageSchema,
  errandNoticeReadSchema,
  errandUnreadSchema,
} from '../src/notifications/errand-contracts.js';
const execute = promisify(execFile);
const probe = `import assert from 'node:assert/strict';import net from 'node:net';import pg from 'pg';import {NestApplication} from '@nestjs/core';const fail=()=>{throw new Error('OpenAPI attempted live work');};net.Server.prototype.listen=fail;net.Socket.prototype.connect=fail;pg.Pool.prototype.connect=fail;pg.Pool.prototype.query=fail;globalThis.setInterval=fail;globalThis.setTimeout=fail;NestApplication.prototype.init=fail;NestApplication.prototype.listen=fail;const {renderErrandsOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');const first=await renderErrandsOpenApiDocument();assert.equal(await renderErrandsOpenApiDocument(),first);process.stdout.write(first);`;
async function render() {
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
  return result.stdout;
}
test('errand official Swagger is deterministic, offline and artifact-current', async () => {
  assert.equal(
    await render(),
    await readFile(
      new URL('../../../docs/openapi/errands.json', import.meta.url),
      'utf8',
    ),
  );
});
test('every errand/notice route requires auth, strict output, no-store/Vary and documented sanitized failures', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  const cases = [
    ['/v1/admin/errands', 'get', errandAdminPageSchema],
    ['/v1/errands', 'get', errandPageSchema],
    ['/v1/errands', 'post', errandReceiptSchema],
    ['/v1/errands/{orderId}', 'get', errandDetailSchema],
    ['/v1/me/errands', 'get', errandPageSchema],
    ['/v1/me/errands/contact-history', 'get', errandContactHistorySchema],
    ['/v1/me/errand-requests/{requestId}', 'get', errandReceiptSchema],
    ...['accept', 'cancel', 'complete', 'delete'].map(
      (op) =>
        [`/v1/errands/{orderId}/${op}`, 'post', errandReceiptSchema] as const,
    ),
    ['/v1/me/errand-notices', 'get', errandNoticesPageSchema],
    ['/v1/me/errand-notices/unread-count', 'get', errandUnreadSchema],
    ['/v1/me/errand-notices/{noticeId}/read', 'put', errandNoticeReadSchema],
  ] as const;
  assert.equal(
    Object.values(doc.paths).reduce(
      (n, path) => n + Object.keys(path!).length,
      0,
    ),
    cases.length,
  );
  for (const [path, method, schema] of cases) {
    const operation = doc.paths[path]![method]!;
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    if (method === 'get') assert.equal(operation.requestBody, undefined);
    else assert.ok(operation.requestBody);
    const response = operation.responses['200']!;
    assert.ok(!('$ref' in response));
    assert.deepEqual(
      response.content!['application/json']!.schema,
      z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'output' }),
    );
    for (const status of [
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '413',
      '415',
      '429',
      '500',
      '503',
    ]) {
      const item = operation.responses[status]!;
      assert.ok(item, `${method} ${path} ${status}`);
      assert.ok(!('$ref' in item));
      assert.ok(item.headers!['cache-control']);
      assert.ok(item.headers!['vary']);
    }
  }
});
test('receipt OpenAPI exposes no private body or contact schema and runtime-only effects stay offline', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  const response =
    doc.paths['/v1/me/errand-requests/{requestId}']!.get!.responses['200']!;
  assert.ok(!('$ref' in response));
  const serialized = JSON.stringify(response.content);
  for (const field of [
    'privateText',
    'publisherContacts',
    'oppositeContact',
    'accountId',
    'token',
  ])
    assert.ok(!serialized.includes(field));
});
