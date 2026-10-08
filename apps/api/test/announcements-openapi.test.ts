import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  announcementPageSchema,
  announcementDetailSchema,
  announcementPublicPopupSchema,
  announcementOwnerPopupSchema,
  announcementChangesSchema,
  announcementAckReceiptSchema,
} from '../src/announcements/contracts.js';
const execute = promisify(execFile);
const probe = `import assert from 'node:assert/strict';import net from 'node:net';import pg from 'pg';import {NestApplication} from '@nestjs/core';const fail=()=>{throw new Error('OpenAPI attempted live work');};net.Server.prototype.listen=fail;net.Socket.prototype.connect=fail;pg.Pool.prototype.connect=fail;pg.Pool.prototype.query=fail;globalThis.setInterval=fail;globalThis.setTimeout=fail;NestApplication.prototype.init=fail;NestApplication.prototype.listen=fail;const {renderAnnouncementsOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');const first=await renderAnnouncementsOpenApiDocument();assert.equal(await renderAnnouncementsOpenApiDocument(),first);process.stdout.write(first);`;
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
test('announcement official Swagger document is offline, deterministic and artifact-current', async () => {
  const first = await render();
  assert.equal(
    first,
    await readFile(
      new URL('../../../docs/openapi/announcements.json', import.meta.url),
      'utf8',
    ),
  );
});
test('announcement OpenAPI distinguishes optional-auth public reads and required owner state/command', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  const cases = [
    ['/v1/announcements', 'get', announcementPageSchema],
    ['/v1/announcements/changes', 'get', announcementChangesSchema],
    ['/v1/announcements/popup', 'get', announcementPublicPopupSchema],
    ['/v1/announcements/{announcementId}', 'get', announcementDetailSchema],
    ['/v1/me/announcements/popup', 'get', announcementOwnerPopupSchema],
    [
      '/v1/me/announcements/{announcementId}/popup-acknowledgement',
      'put',
      announcementAckReceiptSchema,
    ],
  ] as const;
  assert.deepEqual(
    Object.keys(doc.paths),
    cases.map(([path]) => path),
  );
  for (const [path, method, schema] of cases) {
    assert.deepEqual(Object.keys(doc.paths[path]!), [method]);
    const operation = doc.paths[path]![method]!;
    assert.deepEqual(
      operation.security,
      path.startsWith('/v1/me/')
        ? [{ accessToken: [] }]
        : [{}, { accessToken: [] }],
    );
    if (method === 'get') assert.equal(operation.requestBody, undefined);
    else {
      assert.ok(operation.requestBody);
      assert.ok(!('$ref' in operation.requestBody));
      assert.equal(operation.requestBody.required, true);
    }
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
});
