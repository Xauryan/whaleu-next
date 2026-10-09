import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import { z } from 'zod';
import * as contracts from '../src/ratings/contracts.js';
import * as discussion from '../src/ratings/discussion-contracts.js';
import * as updates from '../src/notifications/ratings/contracts.js';
const execute = promisify(execFile);
const probe = `import assert from 'node:assert/strict';import net from 'node:net';import pg from 'pg';import {NestApplication} from '@nestjs/core';const fail=()=>{throw new Error('OpenAPI attempted live work');};net.Server.prototype.listen=fail;net.Socket.prototype.connect=fail;pg.Pool.prototype.connect=fail;pg.Pool.prototype.query=fail;globalThis.setInterval=fail;globalThis.setTimeout=fail;NestApplication.prototype.init=fail;NestApplication.prototype.listen=fail;const {renderRatingsOpenApiDocument}=await import('./.openapi-build/scripts/openapi-document.js');const first=await renderRatingsOpenApiDocument();assert.equal(await renderRatingsOpenApiDocument(),first);process.stdout.write(first);`;
async function render() {
  const r = await execute(
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
  assert.equal(r.stderr, '');
  return r.stdout;
}
test('ratings OpenAPI is deterministic offline and artifact-current', async () =>
  assert.equal(
    await render(),
    await readFile(
      new URL('../../../docs/openapi/ratings.json', import.meta.url),
      'utf8',
    ),
  ));
test('all 23 rating operations have exact schemas and safe auth/error metadata', async () => {
  const doc = JSON.parse(await render()) as OpenAPIObject;
  const cases = [
    ['/v1/ratings/context', 'get', contracts.ratingContextSchema],
    ['/v1/ratings/categories', 'get', contracts.ratingCategoryPageSchema],
    ['/v1/ratings/targets', 'get', contracts.ratingTargetPageSchema],
    ['/v1/ratings/targets/{id}', 'get', contracts.ratingTargetSchema],
    ['/v1/ratings/targets/{id}/my-score', 'get', contracts.ratingMyScoreSchema],
    [
      '/v1/ratings/targets/{id}/score-summary',
      'get',
      contracts.ratingSummarySchema,
    ],
    [
      '/v1/ratings/targets/{id}/comments',
      'get',
      contracts.ratingCommentPageSchema,
    ],
    ['/v1/ratings/comments/{id}', 'get', contracts.ratingCommentSchema],
    ['/v1/ratings/requests/{id}', 'get', contracts.ratingReceiptSchema],
    ['/v1/ratings/targets/{id}/my-score', 'put', contracts.ratingReceiptSchema],
    [
      '/v1/ratings/targets/{id}/comments',
      'post',
      contracts.ratingReceiptSchema,
    ],
    ['/v1/ratings/comments/{id}', 'delete', contracts.ratingReceiptSchema],
    [
      '/v1/ratings/comments/{id}/discussion',
      'get',
      discussion.ratingDiscussionSchema,
    ],
    [
      '/v1/ratings/comments/{id}/replies',
      'get',
      discussion.ratingReplyPageSchema,
    ],
    ['/v1/ratings/replies/{id}', 'get', discussion.ratingReplySchema],
    [
      '/v1/ratings/replies/{id}/position',
      'get',
      discussion.ratingReplyPositionSchema,
    ],
    [
      '/v1/ratings/comments/{id}/replies',
      'post',
      discussion.ratingReplyReceiptSchema,
    ],
    ['/v1/ratings/replies/{id}', 'delete', discussion.ratingReplyReceiptSchema],
    [
      '/v1/ratings/reply-requests/{id}',
      'get',
      discussion.ratingReplyReceiptSchema,
    ],
    ['/v1/me/ratings/updates', 'get', updates.ratingUpdatesPageSchema],
    [
      '/v1/me/ratings/updates/unread-count',
      'get',
      updates.ratingUnreadCountSchema,
    ],
    [
      '/v1/me/ratings/updates/{noticeId}/target',
      'get',
      updates.ratingNoticeTargetSchema,
    ],
    [
      '/v1/me/ratings/updates/{noticeId}/read',
      'put',
      updates.ratingNoticeReadSchema,
    ],
  ] as const;
  assert.equal(
    Object.values(doc.paths).reduce((n, p) => n + Object.keys(p!).length, 0),
    cases.length,
  );
  for (const [path, method, schema] of cases) {
    const op = doc.paths[path]![method]!;
    assert.deepEqual(op.security, [{ accessToken: [] }]);
    assert.equal(!!op.requestBody, method !== 'get');
    const result = op.responses['200']!;
    assert.ok(!('$ref' in result));
    assert.deepEqual(
      result.content!['application/json']!.schema,
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
      const response = op.responses[status]!;
      assert.ok(response && !('$ref' in response));
      assert.ok(response.headers?.['cache-control']);
      assert.ok(response.headers?.['vary']);
    }
  }
});
