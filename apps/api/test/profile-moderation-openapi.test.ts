import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  moderationCommandSchema,
  moderationTargetSchema,
  moderationRequestIdSchema,
  moderationManagementSchema,
  moderationReceiptSchema,
} from '../src/profile/moderation/contracts.js';

type Schema = {
  $ref?: string;
  type?: string;
  format?: string;
  additionalProperties?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  enum?: unknown[];
  anyOf?: Schema[];
  oneOf?: Schema[];
};
type Builder = {
  createProfileModerationOpenApiDocument(): Promise<OpenAPIObject>;
  renderProfileModerationOpenApiDocument(): Promise<string>;
};
const builder = async (): Promise<Builder> =>
  import(
    new URL(
      '../.openapi-build/scripts/profile-moderation-openapi-document.js',
      import.meta.url,
    ).href
  ) as Promise<Builder>;

test('profile moderation OpenAPI exposes exactly four authenticated target-only operations and minimal receipts', async () => {
  const doc = await (await builder()).createProfileModerationOpenApiDocument();
  assert.equal(doc.openapi, '3.0.3');
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
  const exactFields = (schema: Schema, names: string[]) => {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      names.slice().sort(),
    );
    assert.deepEqual(schema.required?.slice().sort(), names.slice().sort());
  };
  const checkTarget = (raw: Schema | undefined) => {
    const schema = resolve(raw);
    exactFields(schema, ['kind', 'id']);
    assert.deepEqual(resolve(schema.properties?.['kind']).enum, [
      'post',
      'comment',
      'reply',
    ]);
    assert.equal(resolve(schema.properties?.['id']).format, 'uuid');
  };
  const checkReceipt = (raw: Schema | undefined) => {
    const schema = resolve(raw),
      variants = (schema.anyOf ?? schema.oneOf ?? []).map(resolve);
    assert.equal(variants.length, 2);
    const applied = variants.find((variant) =>
      resolve(variant.properties?.['outcome']).enum?.includes('applied'),
    );
    const rejected = variants.find((variant) =>
      resolve(variant.properties?.['outcome']).enum?.includes('rejected'),
    );
    assert.ok(applied && rejected);
    const common = [
      'requestId',
      'target',
      'expectedProfileRevision',
      'action',
      'outcome',
    ];
    exactFields(applied, [...common, 'revision', 'eventId', 'recordedAt']);
    exactFields(rejected, [...common, 'code']);
    for (const variant of [applied, rejected]) {
      checkTarget(variant.properties?.['target']);
      assert.equal(resolve(variant.properties?.['requestId']).format, 'uuid');
      assert.deepEqual(resolve(variant.properties?.['action']).enum, [
        'reset_nickname',
      ]);
      assert.equal(
        resolve(variant.properties?.['expectedProfileRevision']).maximum,
        2147483646,
      );
    }
    assert.equal(resolve(applied.properties?.['eventId']).format, 'uuid');
    assert.equal(
      resolve(applied.properties?.['recordedAt']).format,
      'date-time',
    );
    assert.deepEqual(resolve(rejected.properties?.['code']).enum, [
      'PROFILE_MODERATION_STALE',
      'PROFILE_MODERATION_CANCELLED',
    ]);
  };
  const operations = [
    [
      '/v1/community/profile-moderation/management',
      'get',
      'profileNicknameManagement',
    ],
    [
      '/v1/community/profile-moderation/commands',
      'post',
      'profileNicknameCommand',
    ],
    [
      '/v1/community/profile-moderation/requests/{requestId}',
      'get',
      'profileNicknameRecovery',
    ],
    [
      '/v1/community/profile-moderation/commands/cancel',
      'post',
      'profileNicknameCancel',
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
    const query = (operation.parameters ?? []).filter(
      (parameter) => !('$ref' in parameter) && parameter.in === 'query',
    );
    if (operationId === 'profileNicknameManagement') {
      assert.deepEqual(
        query
          .map((parameter) =>
            '$ref' in parameter ? parameter.$ref : parameter.name,
          )
          .sort(),
        ['id', 'kind'],
      );
      for (const parameter of query) {
        assert.ok(!('$ref' in parameter));
        assert.equal(parameter.required, true);
        const schema = resolve(parameter.schema as Schema | undefined);
        if (parameter.name === 'kind')
          assert.deepEqual(schema.enum, ['post', 'comment', 'reply']);
        else assert.equal(schema.format, 'uuid');
      }
    } else assert.deepEqual(query, []);
    if (operationId === 'profileNicknameRecovery') {
      const parameters = (operation.parameters ?? []).filter(
        (parameter) => !('$ref' in parameter) && parameter.in === 'path',
      );
      assert.equal(parameters.length, 1);
      const request = parameters[0];
      assert.ok(request && !('$ref' in request));
      assert.equal(request.name, 'requestId');
      assert.equal(request.required, true);
      assert.equal(
        resolve(request.schema as Schema | undefined).format,
        'uuid',
      );
    }
    if (method === 'post') {
      const body = operation.requestBody;
      assert.ok(body && !('$ref' in body));
      assert.equal(body.required, true);
      const schema = resolve(
        body.content['application/json']?.schema as Schema | undefined,
      );
      exactFields(schema, [
        'clientRequestId',
        'target',
        'expectedProfileRevision',
        'action',
      ]);
      checkTarget(schema.properties?.['target']);
      assert.equal(
        resolve(schema.properties?.['clientRequestId']).format,
        'uuid',
      );
      assert.deepEqual(resolve(schema.properties?.['action']).enum, [
        'reset_nickname',
      ]);
      const revision = resolve(schema.properties?.['expectedProfileRevision']);
      assert.equal(revision.type, 'integer');
      assert.equal(revision.minimum, 0);
      assert.equal(revision.maximum, 2147483646);
    } else assert.equal(operation.requestBody, undefined);
    const response = operation.responses['200'];
    assert.ok(response && !('$ref' in response));
    const schema = resolve(
      response.content?.['application/json']?.schema as Schema | undefined,
    );
    if (operationId === 'profileNicknameManagement') {
      const variants = (schema.anyOf ?? schema.oneOf ?? []).map(resolve);
      assert.equal(variants.length, 2);
      const available = variants.find(
        (variant) => variant.properties?.['revision'],
      );
      const unavailable = variants.find(
        (variant) => variant.properties?.['blocker'],
      );
      assert.ok(available && unavailable);
      exactFields(available, ['target', 'displayName', 'revision', 'canReset']);
      checkTarget(available.properties?.['target']);
      assert.equal(
        resolve(available.properties?.['displayName']).maxLength,
        20,
      );
      assert.deepEqual(resolve(available.properties?.['canReset']).enum, [
        true,
      ]);
      exactFields(unavailable, [
        'target',
        'canReset',
        'availability',
        'blocker',
      ]);
      checkTarget(unavailable.properties?.['target']);
      assert.deepEqual(resolve(unavailable.properties?.['canReset']).enum, [
        false,
      ]);
      assert.deepEqual(resolve(unavailable.properties?.['availability']).enum, [
        'unavailable',
      ]);
      assert.deepEqual(resolve(unavailable.properties?.['blocker']).enum, [
        'related_sync_unsupported',
      ]);
    } else if (operationId === 'profileNicknameRecovery') {
      const variants = (schema.anyOf ?? schema.oneOf ?? []).map(resolve);
      assert.equal(variants.length, 2);
      const recorded = variants.find((variant) =>
        resolve(variant.properties?.['state']).enum?.includes('recorded'),
      );
      const absent = variants.find((variant) =>
        resolve(variant.properties?.['state']).enum?.includes('not_recorded'),
      );
      assert.ok(recorded && absent);
      exactFields(recorded, ['state', 'receipt']);
      exactFields(absent, ['state']);
      checkReceipt(recorded.properties?.['receipt']);
    } else checkReceipt(schema);
  }
  const wire = JSON.stringify({
    paths: doc.paths,
    schemas: doc.components?.schemas,
  });
  for (const name of [
    'accountId',
    'profileId',
    'subjectId',
    'subjectAccountId',
    'actorId',
    'publicId',
    'nickname',
    'oldNickname',
    'newNickname',
    'avatar',
    'grantId',
    'role',
    'phone',
    'text',
    'images',
  ])
    assert.equal(wire.includes(`"${name}":`), false, name);
});

test('the documented target and original command reject unknown or account-directed request fields', () => {
  const id = '77777777-7777-4777-8777-777777777777';
  const command = {
    clientRequestId: id,
    target: { kind: 'post', id },
    expectedProfileRevision: 0,
    action: 'reset_nickname',
  };
  for (const kind of ['post', 'comment', 'reply']) {
    assert.equal(moderationTargetSchema.safeParse({ kind, id }).success, true);
    assert.equal(
      moderationCommandSchema.safeParse({ ...command, target: { kind, id } })
        .success,
      true,
    );
  }
  for (const extra of [
    { accountId: id },
    { profileId: id },
    { subjectId: id },
    { nickname: '任意昵称' },
    { role: 'super_admin' },
  ]) {
    assert.equal(
      moderationTargetSchema.safeParse({ ...command.target, ...extra }).success,
      false,
    );
    assert.equal(
      moderationCommandSchema.safeParse({ ...command, ...extra }).success,
      false,
    );
  }
  assert.equal(
    moderationCommandSchema.safeParse({
      ...command,
      target: { kind: 'account', id },
    }).success,
    false,
  );
  assert.equal(
    moderationCommandSchema.safeParse({ ...command, action: 'reset_avatar' })
      .success,
    false,
  );
});

test('profile moderation OpenAPI output is deterministic and matches the generated artifact', async () => {
  const { renderProfileModerationOpenApiDocument } = await builder();
  const first = await renderProfileModerationOpenApiDocument();
  assert.equal(await renderProfileModerationOpenApiDocument(), first);
  assert.equal(
    await readFile(
      new URL('../../../docs/openapi/profile-moderation.json', import.meta.url),
      'utf8',
    ),
    first,
  );
  assert.equal(first.endsWith('\n'), true);
});

test('uppercase request UUIDs canonicalize while output schemas validate canonical identifiers without transforms', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const target = { kind: 'post' as const, id };
  assert.equal(moderationRequestIdSchema.parse(id.toUpperCase()), id);
  assert.deepEqual(
    moderationTargetSchema.parse({ ...target, id: id.toUpperCase() }),
    target,
  );
  assert.deepEqual(
    moderationCommandSchema.parse({
      clientRequestId: id.toUpperCase(),
      target: { ...target, id: id.toUpperCase() },
      expectedProfileRevision: 0,
      action: 'reset_nickname',
    }),
    {
      clientRequestId: id,
      target,
      expectedProfileRevision: 0,
      action: 'reset_nickname',
    },
  );
  const management = {
    target,
    displayName: '合成昵称',
    revision: 0,
    canReset: true,
  };
  assert.deepEqual(moderationManagementSchema.parse(management), management);
  assert.equal(
    moderationManagementSchema.safeParse({
      ...management,
      target: { ...target, id: id.toUpperCase() },
    }).success,
    false,
  );
  const receipt = {
    requestId: id,
    target,
    expectedProfileRevision: 0,
    action: 'reset_nickname',
    outcome: 'applied',
    revision: 1,
    eventId: id,
    recordedAt: '2026-10-12T00:00:00.000Z',
  };
  assert.deepEqual(moderationReceiptSchema.parse(receipt), receipt);
  for (const patch of [
    { requestId: id.toUpperCase() },
    { eventId: id.toUpperCase() },
    { target: { ...target, id: id.toUpperCase() } },
    { revision: 2 },
  ])
    assert.equal(
      moderationReceiptSchema.safeParse({ ...receipt, ...patch }).success,
      false,
    );
});
