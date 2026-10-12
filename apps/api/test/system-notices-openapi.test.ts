import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  maxItems?: number;
  maximum?: number;
  anyOf?: Schema[];
  oneOf?: Schema[];
};
type Builder = {
  createSystemNoticesOpenApiDocument(): Promise<OpenAPIObject>;
  renderSystemNoticesOpenApiDocument(): Promise<string>;
};
const builder = async (): Promise<Builder> =>
  import(
    new URL(
      '../.openapi-build/scripts/system-notices-openapi-document.js',
      import.meta.url,
    ).href
  ) as Promise<Builder>;

test('system notice OpenAPI retains three owner-only routes and three exact source-free notice kinds', async () => {
  const doc = await (await builder()).createSystemNoticesOpenApiDocument();
  assert.equal(doc.openapi, '3.0.3');
  const resolve = (schema: Schema | undefined): Schema => {
    assert.ok(schema);
    if (!schema.$ref) return schema;
    assert.ok(schema.$ref.startsWith('#/components/schemas/'));
    return resolve(
      doc.components?.schemas?.[
        schema.$ref.slice('#/components/schemas/'.length)
      ] as Schema | undefined,
    );
  };
  const exactFields = (schema: Schema, names: string[]) => {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      names.slice().sort(),
    );
    assert.deepEqual(
      (schema.required ?? []).slice().sort(),
      names.slice().sort(),
    );
  };
  const operations = [
    ['/v1/me/system-notices', 'get', 'systemNoticesList'],
    ['/v1/me/system-notices/unread-count', 'get', 'systemNoticesUnreadCount'],
    ['/v1/me/system-notices/{id}/read', 'put', 'systemNoticeMarkRead'],
  ] as const;
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    operations.map(([path]) => path).sort(),
  );
  for (const [path, method, operationId] of operations) {
    const operation = doc.paths[path]?.[method];
    assert.ok(operation);
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    const query = (operation.parameters ?? []).filter(
      (parameter) => !('$ref' in parameter) && parameter.in === 'query',
    );
    assert.deepEqual(
      query
        .map((parameter) =>
          '$ref' in parameter ? parameter.$ref : parameter.name,
        )
        .sort(),
      operationId === 'systemNoticesList' ? ['cursor', 'limit'] : [],
    );
    if (method === 'put') {
      const body = operation.requestBody;
      assert.ok(body && !('$ref' in body));
      exactFields(
        resolve(body.content['application/json']?.schema as Schema),
        [],
      );
      const parameters = (operation.parameters ?? []).filter(
        (parameter) => !('$ref' in parameter) && parameter.in === 'path',
      );
      assert.equal(parameters.length, 1);
      const id = parameters[0];
      assert.ok(id && !('$ref' in id));
      assert.equal(id.name, 'id');
      assert.equal(resolve(id.schema as Schema).format, 'uuid');
    } else assert.equal(operation.requestBody, undefined);
    const response = operation.responses['200'];
    assert.ok(response && !('$ref' in response));
    const schema = resolve(
      response.content?.['application/json']?.schema as Schema,
    );
    if (operationId === 'systemNoticesList') {
      exactFields(schema, ['items', 'nextCursor', 'unreadCount']);
      const items = resolve(schema.properties?.['items']);
      assert.equal(items.type, 'array');
      assert.equal(items.maxItems, 50);
      const union = resolve(items.items);
      const variants = (union.anyOf ?? union.oneOf ?? []).map(resolve);
      assert.equal(variants.length, 4);
      const fields = {
        post_jury_removed: ['keepVotes', 'removeVotes'],
        profile_nickname_reset: ['nickname'],
        profile_custom_avatar_cleared: [],
        admin_post_removed: [],
      };
      for (const [kind, specific] of Object.entries(fields)) {
        const variant = variants.find((item) =>
          resolve(item.properties?.['kind']).enum?.includes(kind),
        );
        assert.ok(variant, kind);
        exactFields(variant, [
          'noticeId',
          'kind',
          'createdAt',
          'readAt',
          ...specific,
        ]);
        assert.equal(resolve(variant.properties?.['noticeId']).format, 'uuid');
        assert.equal(
          resolve(variant.properties?.['createdAt']).format,
          'date-time',
        );
      }
    } else if (operationId === 'systemNoticeMarkRead')
      exactFields(schema, ['noticeId', 'readAt', 'unreadCount']);
    else exactFields(schema, ['unreadCount']);
    assert.equal(
      resolve(schema.properties?.['unreadCount']).maximum,
      2147483647,
    );
  }
});

test('system notice OpenAPI is deterministic and matches the generated artifact', async () => {
  const { renderSystemNoticesOpenApiDocument } = await builder();
  const first = await renderSystemNoticesOpenApiDocument();
  assert.equal(await renderSystemNoticesOpenApiDocument(), first);
  assert.equal(
    await readFile(
      new URL('../../../docs/openapi/system-notices.json', import.meta.url),
      'utf8',
    ),
    first,
  );
});
