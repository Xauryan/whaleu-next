import { format } from 'prettier';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import type {
  OpenAPIObject,
  OperationObject,
  SchemaObject,
} from '@nestjs/swagger';
import { applicationErrorCondition } from '../src/http/application-error.js';
import {
  safeErrorResponseSchema,
  safeHttpErrorDescription,
} from '../src/http/error-contracts.js';
import {
  viewEpochRequestSchema,
  viewReportSchema,
  viewReportingEpochSchema,
  viewReportReceiptSchema,
} from '../src/community/view-component/contracts.js';

const execute = promisify(execFile);
const api = fileURLToPath(new URL('../', import.meta.url));
const artifact = new URL(
  '../../../docs/openapi/view-reporting.json',
  import.meta.url,
);
const offlineProbe = `
  import assert from 'node:assert/strict';
  import net from 'node:net';
  import pg from 'pg';
  import { NestApplication } from '@nestjs/core';
  const fail = () => { throw new Error('Offline OpenAPI attempted live application work'); };
  net.Server.prototype.listen = fail;
  net.Socket.prototype.connect = fail;
  pg.Pool.prototype.connect = fail;
  pg.Pool.prototype.query = fail;
  globalThis.setInterval = fail;
  globalThis.setTimeout = fail;
  NestApplication.prototype.init = fail;
  NestApplication.prototype.listen = fail;
  NestApplication.prototype.enableShutdownHooks = fail;
  const { renderViewOpenApiDocument } = await import('./.openapi-build/scripts/openapi-document.js');
  const first = await renderViewOpenApiDocument();
  assert.equal(await renderViewOpenApiDocument(), first);
  process.stdout.write(first);
`;

async function render(): Promise<string> {
  const result = await execute(
    process.execPath,
    ['--input-type=module', '-e', offlineProbe],
    {
      cwd: api,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        DATABASE_URL: 'invalid:offline-export-must-not-read-database',
        NODE_ENV: 'production',
      },
    },
  );
  assert.equal(result.stderr, '');
  return result.stdout;
}
let documentPromise: Promise<OpenAPIObject> | undefined;
function document() {
  return (documentPromise ??= render().then(
    (text) => JSON.parse(text) as OpenAPIObject,
  ));
}
function operation(doc: OpenAPIObject, path: string): OperationObject {
  const item = doc.paths[path];
  assert.ok(item);
  assert.deepEqual(Object.keys(item), ['post']);
  assert.ok(item.post);
  return item.post;
}
function visit(
  value: unknown,
  check: (value: Record<string, unknown>) => void,
) {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, check);
  } else if (value !== null && typeof value === 'object') {
    check(value as Record<string, unknown>);
    for (const child of Object.values(value)) visit(child, check);
  }
}

test('compiled real controller export is offline, deterministic in-process/across processes, and current', async () => {
  const first = await render();
  assert.equal(await format(first, { parser: 'json' }), first);
  assert.equal(await render(), first);
  assert.equal(await readFile(artifact, 'utf8'), first);
  assert.equal(first.endsWith('\n'), true);
  assert.equal(first.endsWith('\n\n'), false);
  const doc = JSON.parse(first) as OpenAPIObject;
  assert.equal(doc.openapi, '3.0.3');
  assert.equal(doc.info.version, '1');
  assert.deepEqual(doc.servers ?? [], []);
  assert.equal(/localhost|127\.0\.0\.1|invalid:offline/.test(first), false);
});

test('only two real POST operations have required bodies, opaque bearer auth, owner responses and safe headers', async () => {
  const doc = await document();
  assert.deepEqual(Object.keys(doc.paths), [
    '/v1/me/community/view-reporting-epoch',
    '/v1/me/community/view-reports',
  ]);
  assert.deepEqual(doc.components?.securitySchemes, {
    accessToken: {
      type: 'http',
      scheme: 'bearer',
      description: 'Opaque WhaleU access token.',
    },
  });
  for (const [path, operationId, requestName, responseName, conflict] of [
    [
      '/v1/me/community/view-reporting-epoch',
      'issueCommunityViewEpoch',
      'ViewEpochRequest',
      'ViewReportingEpoch',
      false,
    ],
    [
      '/v1/me/community/view-reports',
      'reportCommunityViews',
      'ViewReport',
      'ViewReportReceipt',
      true,
    ],
  ] as const) {
    const op = operation(doc, path);
    assert.equal(op.operationId, operationId);
    assert.deepEqual(op.tags, ['View reporting']);
    assert.deepEqual(op.security, [{ accessToken: [] }]);
    assert.deepEqual(op.parameters, []);
    assert.deepEqual(op.requestBody, {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: `#/components/schemas/${requestName}` },
        },
      },
    });
    assert.deepEqual(
      Object.keys(op.responses).sort(),
      [
        '200',
        '400',
        '401',
        '403',
        ...(conflict ? ['409'] : []),
        '410',
        '413',
        '415',
        '429',
        '500',
        '503',
      ].sort(),
    );
    for (const [status, response] of Object.entries(op.responses)) {
      assert.ok(response && !('$ref' in response));
      assert.deepEqual(response.content, {
        'application/json': {
          schema: {
            $ref: `#/components/schemas/${status === '200' ? responseName : 'SafeErrorResponse'}`,
          },
        },
      });
      assert.deepEqual(
        Object.keys(response.headers ?? {}).sort(),
        [
          'cache-control',
          ...(status === '429' ? ['retry-after'] : []),
          'x-request-id',
        ].sort(),
      );
      assert.deepEqual(response.headers?.['cache-control'], {
        schema: { type: 'string', enum: ['no-store'] },
      });
      if (status === '429') {
        assert.deepEqual(response.headers?.['retry-after'], {
          schema: { type: 'string', enum: ['60'] },
        });
        assert.match(
          response.description,
          /does not guarantee a business quota has cleared/,
        );
      }
    }
    for (const code of [
      'AUTHENTICATION_REQUIRED',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_REVOKED',
      'ACCOUNT_BLOCKED',
      'VIEW_REPORTING_EPOCH_CLOSED',
      'RATE_LIMITED',
      'VIEW_REPORTING_UNAVAILABLE',
      ...(conflict ? (['VIEW_REPORT_CONFLICT'] as const) : []),
    ] as const) {
      const condition = applicationErrorCondition(code);
      const response = op.responses[String(condition.status)];
      assert.ok(response && !('$ref' in response));
      assert.ok(
        response.description.includes(`${code}: ${condition.message}.`),
      );
    }
    for (const status of [400, 413, 415, 500]) {
      const response = op.responses[String(status)];
      assert.ok(response && !('$ref' in response));
      const expected = safeHttpErrorDescription(status);
      assert.ok(
        response.description.startsWith(
          `${expected.code}: ${expected.message}.`,
        ),
      );
    }
  }
});

test('components exactly match native owner input/output conversion, strictness, cardinality, and reachable refs', async () => {
  const doc = await document();
  const schemas = doc.components?.schemas;
  assert.ok(schemas);
  assert.deepEqual(
    Object.keys(schemas).sort(),
    [
      'SafeErrorResponse',
      'ViewEpochRequest',
      'ViewReport',
      'ViewReportReceipt',
      'ViewReportingEpoch',
    ].sort(),
  );
  for (const [name, schema, io] of [
    ['ViewEpochRequest', viewEpochRequestSchema, 'input'],
    ['ViewReport', viewReportSchema, 'input'],
    ['ViewReportingEpoch', viewReportingEpochSchema, 'output'],
    ['ViewReportReceipt', viewReportReceiptSchema, 'output'],
    ['SafeErrorResponse', safeErrorResponseSchema, 'output'],
  ] as const) {
    const native = z.toJSONSchema(schema, { target: 'openapi-3.0', io });
    assert.deepEqual(
      schemas[name],
      (native['definitions'] as Record<string, unknown> | undefined)?.[name],
    );
  }
  visit(doc, (item) => {
    if ('$ref' in item) {
      assert.equal(typeof item['$ref'], 'string');
      const ref = item['$ref'] as string;
      assert.match(ref, /^#\/components\/schemas\/[^/]+$/);
      assert.ok(schemas[ref.slice('#/components/schemas/'.length)], ref);
    }
    if (item['type'] === 'object')
      assert.equal(item['additionalProperties'], false);
    if ('schema' in item) assert.notDeepEqual(item['schema'], {});
    assert.equal('uniqueItems' in item, false);
    assert.equal('successorRequestId' in item, false);
  });
  for (const [name, countField, min, max] of [
    ['ViewReport', 'postIds', 1, 50],
    ['ViewReportReceipt', 'acceptedCount', 0, 50],
  ] as const) {
    const schema = schemas[name] as SchemaObject;
    assert.equal(schema.oneOf?.length, 2);
    for (const [index, branch] of schema.oneOf!.entries()) {
      assert.ok(!('$ref' in branch));
      const count = branch.properties?.[countField] as SchemaObject;
      assert.equal(
        count[countField === 'postIds' ? 'minItems' : 'minimum'],
        min,
      );
      assert.equal(
        count[countField === 'postIds' ? 'maxItems' : 'maximum'],
        index === 0 ? max : 1,
      );
    }
  }
  assert.match(
    (schemas['ViewReportingEpoch'] as SchemaObject).description!,
    /JSON Schema does not express this date arithmetic/,
  );
  assert.match(
    (schemas['ViewReportReceipt'] as SchemaObject).description!,
    /request-dependent checks/,
  );
  assert.throws(
    () =>
      z.toJSONSchema(viewReportSchema, { target: 'openapi-3.0', io: 'output' }),
    /transform/i,
  );
});

test('CLI resolves artifact independently of cwd and check rejects missing/stale bytes without writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whaleu-openapi-'));
  try {
    const tool = join(root, 'apps/api/.openapi-build');
    await mkdir(join(root, 'apps/api'), { recursive: true });
    await cp(join(api, '.openapi-build'), tool, { recursive: true });
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    await symlink(
      fileURLToPath(new URL('../../../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      'dir',
    );
    const cli = join(tool, 'scripts/openapi.js');
    const output = join(root, 'docs/openapi/view-reporting.json');
    const run = (...args: string[]) =>
      execute(process.execPath, [cli, ...args], {
        cwd: tmpdir(),
        timeout: 30000,
      });
    await assert.rejects(run('--check'), /artifact is missing/);
    await assert.rejects(readFile(output), { code: 'ENOENT' });
    await run();
    const rendered = await readFile(output, 'utf8');
    assert.equal(rendered, await readFile(artifact, 'utf8'));
    await run('--check');
    await writeFile(output, 'stale\n');
    await assert.rejects(run('--check'), /artifact is stale/);
    assert.equal(await readFile(output, 'utf8'), 'stale\n');
    await assert.rejects(run('--unexpected'), /Usage/);
    assert.equal(await readFile(output, 'utf8'), 'stale\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uncompiled tsx export fails rather than silently dropping request-body metadata', async () => {
  await assert.rejects(
    execute(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "const { createViewOpenApiDocument } = await import('./scripts/openapi-document.ts'); await createViewOpenApiDocument();",
      ],
      { cwd: api, timeout: 30000 },
    ),
    /requires TypeScript decorator metadata/,
  );
});
