import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { OpenAPIObject } from '@nestjs/swagger';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import { avatarCommandHash } from '../src/profile/avatar/contracts.js';
import {
  avatarModerationCommandSchema,
  avatarModerationEmptyBodySchema,
  avatarModerationEmptyQuerySchema,
  avatarModerationManagementSchema,
  avatarModerationReceiptSchema,
  avatarModerationRecoverySchema,
  avatarModerationRequestIdSchema,
  avatarModerationTargetSchema,
} from '../src/profile/avatar-moderation/contracts.js';
import { avatarModerationIntentHash } from '../src/profile/avatar-moderation/evidence.js';
import { moderationIntentHash } from '../src/profile/moderation/evidence.js';

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const targetId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const appearanceId = 'cccccccc-cccc-5ccc-8ccc-cccccccccccc';
const actorId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const eventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const command = {
  clientRequestId: requestId,
  target: { kind: 'post' as const, id: targetId },
  expectedProfileRevision: 3,
  expectedAppearanceId: appearanceId,
  action: 'clear_custom_avatar' as const,
};
const receiptBase = {
  requestId,
  target: command.target,
  expectedProfileRevision: command.expectedProfileRevision,
  expectedAppearanceId: appearanceId,
  action: command.action,
};
const applied = {
  ...receiptBase,
  outcome: 'applied' as const,
  revision: 4,
  eventId,
  recordedAt: '2026-10-12T18:00:00.000Z',
};

test('avatar moderation accepts only exact post/comment/reply targets and never account-directed authority', () => {
  for (const kind of ['post', 'comment', 'reply']) {
    const target = { kind, id: targetId };
    assert.ok(avatarModerationTargetSchema.safeParse(target).success);
    assert.ok(
      avatarModerationCommandSchema.safeParse({ ...command, target }).success,
    );
  }
  for (const target of [
    { kind: 'account', id: targetId },
    { kind: 'profile', id: targetId },
    { kind: 'post', id: '1' },
    { kind: 'post', id: null },
    { kind: 'post' },
    { id: targetId },
    { kind: 'post', id: targetId, accountId: actorId },
    { kind: 'comment', id: targetId, postId: eventId },
    { kind: 'reply', id: targetId, rootId: eventId },
    { kind: 'reply', id: targetId, originalRegionId: eventId },
  ]) {
    assert.equal(avatarModerationTargetSchema.safeParse(target).success, false);
    assert.equal(
      avatarModerationCommandSchema.safeParse({ ...command, target }).success,
      false,
    );
  }
});

test('clear command requires an original UUID4 key, bounded shared revision and exact current appearance', () => {
  assert.deepEqual(avatarModerationCommandSchema.parse(command), command);
  for (const key of Object.keys(command))
    assert.equal(
      avatarModerationCommandSchema.safeParse(
        Object.fromEntries(
          Object.entries(command).filter(([name]) => name !== key),
        ),
      ).success,
      false,
      `missing ${key}`,
    );
  for (const action of [
    'reset_nickname',
    'reset_avatar',
    'select_avatar',
    'clear',
    'set_avatar',
    '',
  ])
    assert.equal(
      avatarModerationCommandSchema.safeParse({ ...command, action }).success,
      false,
    );
  for (const expectedProfileRevision of [
    -1,
    0.5,
    2147483647,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '3',
    null,
    undefined,
  ])
    assert.equal(
      avatarModerationCommandSchema.safeParse({
        ...command,
        expectedProfileRevision,
      }).success,
      false,
    );
  for (const expectedProfileRevision of [0, 2147483646])
    assert.ok(
      avatarModerationCommandSchema.safeParse({
        ...command,
        expectedProfileRevision,
      }).success,
    );
  for (const expectedAppearanceId of [null, undefined, '', 'current', '1', 1])
    assert.equal(
      avatarModerationCommandSchema.safeParse({
        ...command,
        expectedAppearanceId,
      }).success,
      false,
    );
  for (const clientRequestId of [
    null,
    undefined,
    '',
    appearanceId,
    'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa',
  ])
    assert.equal(
      avatarModerationCommandSchema.safeParse({ ...command, clientRequestId })
        .success,
      false,
    );
  for (const key of [
    'actorId',
    'moderatorAccountId',
    'subjectAccountId',
    'subjectId',
    'accountId',
    'profileId',
    'originalRegionId',
    'grantId',
    'role',
    'authority',
    'approved',
    'source',
    'assetId',
    'bindingId',
    'catalogVersion',
    'url',
    'image',
    'reviewId',
    'reason',
    'nickname',
    'canClearCustomAvatar',
    'eventId',
  ])
    assert.equal(
      avatarModerationCommandSchema.safeParse({ ...command, [key]: eventId })
        .success,
      false,
      key,
    );
});

test('avatar request UUIDs canonicalize before hashing while output identities stay canonical', () => {
  assert.equal(
    avatarModerationRequestIdSchema.parse(requestId.toUpperCase()),
    requestId,
  );
  const normalized = avatarModerationCommandSchema.parse({
    ...command,
    clientRequestId: requestId.toUpperCase(),
    expectedAppearanceId: appearanceId.toUpperCase(),
    target: { ...command.target, id: targetId.toUpperCase() },
  });
  assert.deepEqual(normalized, command);
  assert.equal(
    avatarModerationIntentHash(actorId, normalized),
    avatarModerationIntentHash(actorId, command),
  );
  for (const patch of [
    { requestId: requestId.toUpperCase() },
    { eventId: eventId.toUpperCase() },
    { expectedAppearanceId: appearanceId.toUpperCase() },
    { target: { ...command.target, id: targetId.toUpperCase() } },
  ])
    assert.equal(
      avatarModerationReceiptSchema.safeParse({ ...applied, ...patch }).success,
      false,
    );
});

test('management and receipt contracts expose only the bounded public projection and original intent', () => {
  const management = {
    target: command.target,
    displayName: 'SyntheticName',
    revision: 3,
    canClearCustomAvatar: true,
    expectedAppearanceId: appearanceId,
  };
  assert.deepEqual(
    avatarModerationManagementSchema.parse(management),
    management,
  );
  assert.ok(
    avatarModerationManagementSchema.safeParse({
      ...management,
      canClearCustomAvatar: false,
      expectedAppearanceId: null,
    }).success,
  );
  for (const key of [
    'accountId',
    'subjectId',
    'moderatorAccountId',
    'profileId',
    'source',
    'assetId',
    'bindingId',
    'grantId',
    'oldAvatar',
    'newAvatar',
    'reason',
  ]) {
    assert.equal(
      avatarModerationManagementSchema.safeParse({
        ...management,
        [key]: actorId,
      }).success,
      false,
      key,
    );
    assert.equal(
      avatarModerationReceiptSchema.safeParse({ ...applied, [key]: actorId })
        .success,
      false,
      key,
    );
  }
  assert.deepEqual(avatarModerationReceiptSchema.parse(applied), applied);
  for (const patch of [
    { revision: 3 },
    { revision: 5 },
    { revision: 2147483647 },
    { eventId: null },
    { expectedAppearanceId: null },
    { recordedAt: 'yesterday' },
    { outcome: 'unchanged' },
    { displayName: 'SyntheticName' },
  ])
    assert.equal(
      avatarModerationReceiptSchema.safeParse({ ...applied, ...patch }).success,
      false,
    );
  assert.ok(
    avatarModerationReceiptSchema.safeParse({
      ...applied,
      expectedProfileRevision: 2147483646,
      revision: 2147483647,
    }).success,
  );
});

test('recovery and cancellation retain only the original intent and explicit terminal rejection', () => {
  for (const code of [
    'PROFILE_AVATAR_MODERATION_STALE',
    'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE',
    'PROFILE_AVATAR_MODERATION_CANCELLED',
  ]) {
    const receipt = { ...receiptBase, outcome: 'rejected', code };
    assert.ok(avatarModerationReceiptSchema.safeParse(receipt).success);
    assert.ok(
      avatarModerationRecoverySchema.safeParse({ state: 'recorded', receipt })
        .success,
    );
    for (const patch of [
      { currentRevision: 5 },
      { currentAppearanceId: eventId },
      { eventId },
      { revision: 4 },
    ])
      assert.equal(
        avatarModerationReceiptSchema.safeParse({ ...receipt, ...patch })
          .success,
        false,
      );
  }
  assert.equal(
    avatarModerationReceiptSchema.safeParse({
      ...receiptBase,
      outcome: 'rejected',
      code: 'PROFILE_MODERATION_STALE',
    }).success,
    false,
  );
  assert.deepEqual(
    avatarModerationRecoverySchema.parse({ state: 'not_recorded' }),
    { state: 'not_recorded' },
  );
  for (const patch of [
    { canReplaceKey: true },
    { receipt: applied },
    { target: command.target },
    { accountId: actorId },
  ])
    assert.equal(
      avatarModerationRecoverySchema.safeParse({
        state: 'not_recorded',
        ...patch,
      }).success,
      false,
    );
  assert.ok(avatarModerationEmptyQuerySchema.safeParse({}).success);
  assert.ok(avatarModerationEmptyBodySchema.safeParse(undefined).success);
  assert.ok(avatarModerationEmptyBodySchema.safeParse({}).success);
  for (const unexpected of [
    { target: command.target },
    { grantId: eventId },
    { action: 'clear_custom_avatar' },
  ]) {
    assert.equal(
      avatarModerationEmptyQuerySchema.safeParse(unexpected).success,
      false,
    );
    assert.equal(
      avatarModerationEmptyBodySchema.safeParse(unexpected).success,
      false,
    );
  }
});

test('avatar moderation hash independently binds actor, key, exact target, shared revision and appearance in its own domain', () => {
  const value = avatarModerationIntentHash(actorId, command);
  assert.equal(
    value,
    createHash('sha256')
      .update(
        `whaleu:profile-avatar-moderation-command:v1\n${canonicalJson({ actor: actorId, command })}`,
      )
      .digest('hex'),
  );
  assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(
    avatarModerationIntentHash(actorId, {
      action: command.action,
      expectedAppearanceId: appearanceId,
      expectedProfileRevision: 3,
      target: { id: targetId, kind: 'post' },
      clientRequestId: requestId,
    }),
    value,
    'object insertion order is not part of the canonical intent',
  );
  assert.notEqual(avatarModerationIntentHash(eventId, command), value);
  for (const change of [
    { clientRequestId: eventId },
    { target: { kind: 'comment' as const, id: targetId } },
    { target: { kind: 'reply' as const, id: targetId } },
    { target: { kind: 'post' as const, id: eventId } },
    { expectedProfileRevision: 4 },
    { expectedAppearanceId: eventId },
  ])
    assert.notEqual(
      avatarModerationIntentHash(actorId, { ...command, ...change }),
      value,
    );
  assert.notEqual(
    moderationIntentHash(actorId, {
      clientRequestId: requestId,
      target: command.target,
      expectedProfileRevision: 3,
      action: 'reset_nickname',
    }),
    value,
  );
  assert.notEqual(
    avatarCommandHash(actorId, {
      protocol: 'profile-media-v1',
      clientRequestId: requestId,
      expectedRevision: 3,
      source: { kind: 'clear' },
    }),
    value,
  );
});

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
const artifact = new URL(
  '../../../docs/openapi/profile-avatar-moderation.json',
  import.meta.url,
);

test('avatar moderation OpenAPI artifact exposes exactly four authenticated target-only operations with strict minimal wire schemas', async () => {
  const doc = JSON.parse(await readFile(artifact, 'utf8')) as OpenAPIObject;
  assert.equal(doc.openapi, '3.0.3');
  const resolve = (raw: Schema | undefined): Schema => {
    assert.ok(raw);
    if (!raw.$ref) return raw;
    assert.ok(raw.$ref.startsWith('#/components/schemas/'));
    return resolve(
      doc.components?.schemas?.[
        raw.$ref.slice('#/components/schemas/'.length)
      ] as Schema | undefined,
    );
  };
  const exact = (schema: Schema, keys: string[]) => {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      keys.slice().sort(),
    );
    assert.deepEqual(schema.required?.slice().sort(), keys.slice().sort());
  };
  const checkTarget = (raw: Schema | undefined) => {
    const target = resolve(raw);
    exact(target, ['kind', 'id']);
    assert.deepEqual(resolve(target.properties?.['kind']).enum, [
      'post',
      'comment',
      'reply',
    ]);
    assert.equal(resolve(target.properties?.['id']).format, 'uuid');
  };
  const checkReceipt = (raw: Schema | undefined) => {
    const schema = resolve(raw),
      variants = (schema.anyOf ?? schema.oneOf ?? []).map(resolve);
    assert.equal(variants.length, 2);
    const applied = variants.find((v) =>
      resolve(v.properties?.['outcome']).enum?.includes('applied'),
    );
    const rejected = variants.find((v) =>
      resolve(v.properties?.['outcome']).enum?.includes('rejected'),
    );
    assert.ok(applied && rejected);
    const base = [
      'requestId',
      'target',
      'expectedProfileRevision',
      'expectedAppearanceId',
      'action',
      'outcome',
    ];
    exact(applied, [...base, 'revision', 'eventId', 'recordedAt']);
    exact(rejected, [...base, 'code']);
    for (const variant of variants) {
      checkTarget(variant.properties?.['target']);
      assert.equal(
        resolve(variant.properties?.['expectedAppearanceId']).format,
        'uuid',
      );
      assert.equal(resolve(variant.properties?.['requestId']).format, 'uuid');
      assert.deepEqual(resolve(variant.properties?.['action']).enum, [
        'clear_custom_avatar',
      ]);
      assert.equal(
        resolve(variant.properties?.['expectedProfileRevision']).maximum,
        2147483646,
      );
    }
    assert.equal(resolve(applied.properties?.['revision']).maximum, 2147483647);
    assert.equal(resolve(applied.properties?.['eventId']).format, 'uuid');
    assert.equal(
      resolve(applied.properties?.['recordedAt']).format,
      'date-time',
    );
    assert.deepEqual(resolve(rejected.properties?.['code']).enum, [
      'PROFILE_AVATAR_MODERATION_STALE',
      'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE',
      'PROFILE_AVATAR_MODERATION_CANCELLED',
    ]);
  };
  const operations = [
    [
      '/v1/community/profile-avatar-moderation/management',
      'get',
      'profileAvatarClearManagement',
    ],
    [
      '/v1/community/profile-avatar-moderation/commands',
      'post',
      'profileAvatarClearCommand',
    ],
    [
      '/v1/community/profile-avatar-moderation/requests/{requestId}',
      'get',
      'profileAvatarClearRecovery',
    ],
    [
      '/v1/community/profile-avatar-moderation/commands/cancel',
      'post',
      'profileAvatarClearCancel',
    ],
  ] as const;
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    operations.map(([path]) => path).sort(),
  );
  for (const [path, method, operationId] of operations) {
    assert.deepEqual(Object.keys(doc.paths[path] ?? {}), [method]);
    const operation = doc.paths[path]?.[method];
    assert.ok(operation, path);
    assert.equal(operation.operationId, operationId);
    assert.deepEqual(operation.security, [{ accessToken: [] }]);
    const query = (operation.parameters ?? []).filter(
      (p) => !('$ref' in p) && p.in === 'query',
    );
    if (operationId === 'profileAvatarClearManagement') {
      assert.deepEqual(
        query.map((p) => ('$ref' in p ? p.$ref : p.name)).sort(),
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
    if (operationId === 'profileAvatarClearRecovery') {
      const parameters = (operation.parameters ?? []).filter(
        (p) => !('$ref' in p) && p.in === 'path',
      );
      assert.equal(parameters.length, 1);
      const parameter = parameters[0];
      assert.ok(parameter && !('$ref' in parameter));
      assert.equal(parameter.name, 'requestId');
      assert.equal(parameter.required, true);
      assert.equal(
        resolve(parameter.schema as Schema | undefined).format,
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
      exact(schema, [
        'clientRequestId',
        'target',
        'expectedProfileRevision',
        'expectedAppearanceId',
        'action',
      ]);
      checkTarget(schema.properties?.['target']);
      assert.equal(
        resolve(schema.properties?.['clientRequestId']).format,
        'uuid',
      );
      assert.equal(
        resolve(schema.properties?.['expectedAppearanceId']).format,
        'uuid',
      );
      assert.deepEqual(resolve(schema.properties?.['action']).enum, [
        'clear_custom_avatar',
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
    if (operationId === 'profileAvatarClearManagement') {
      const variants = (schema.anyOf ?? schema.oneOf ?? []).map(resolve);
      assert.equal(variants.length, 2);
      const available = variants.find((v) => v.properties?.['revision']);
      const unavailable = variants.find((v) => v.properties?.['blocker']);
      assert.ok(available && unavailable);
      exact(available, [
        'target',
        'displayName',
        'revision',
        'canClearCustomAvatar',
        'expectedAppearanceId',
      ]);
      checkTarget(available.properties?.['target']);
      assert.equal(
        resolve(available.properties?.['displayName']).maxLength,
        20,
      );
      assert.equal(
        resolve(available.properties?.['canClearCustomAvatar']).type,
        'boolean',
      );
      exact(unavailable, [
        'target',
        'canClearCustomAvatar',
        'availability',
        'blocker',
      ]);
      checkTarget(unavailable.properties?.['target']);
      assert.deepEqual(
        resolve(unavailable.properties?.['canClearCustomAvatar']).enum,
        [false],
      );
      assert.deepEqual(resolve(unavailable.properties?.['availability']).enum, [
        'unavailable',
      ]);
      assert.deepEqual(resolve(unavailable.properties?.['blocker']).enum, [
        'related_sync_unsupported',
      ]);
    } else if (operationId === 'profileAvatarClearRecovery') {
      const variants = (schema.anyOf ?? schema.oneOf ?? []).map(resolve);
      assert.equal(variants.length, 2);
      const recorded = variants.find((v) =>
        resolve(v.properties?.['state']).enum?.includes('recorded'),
      );
      const absent = variants.find((v) =>
        resolve(v.properties?.['state']).enum?.includes('not_recorded'),
      );
      assert.ok(recorded && absent);
      exact(recorded, ['state', 'receipt']);
      exact(absent, ['state']);
      checkReceipt(recorded.properties?.['receipt']);
    } else checkReceipt(schema);
  }
  const wire = JSON.stringify({
    paths: doc.paths,
    schemas: doc.components?.schemas,
  });
  for (const field of [
    'accountId',
    'subjectId',
    'subjectAccountId',
    'moderatorAccountId',
    'actorId',
    'profileId',
    'grantId',
    'originalRegionId',
    'assetId',
    'bindingId',
    'source',
    'reviewId',
    'reason',
    'url',
    'oldAvatar',
    'newAvatar',
  ])
    assert.equal(wire.includes(`"${field}":`), false, field);
});

test('emitted avatar moderation OpenAPI remains deterministic and matches the checked-in artifact', async () => {
  const builder = (await import(
    new URL(
      '../.openapi-build/scripts/profile-avatar-moderation-openapi-document.js',
      import.meta.url,
    ).href
  )) as {
    renderProfileAvatarModerationOpenApiDocument(): Promise<string>;
  };
  const rendered = await builder.renderProfileAvatarModerationOpenApiDocument();
  assert.equal(
    await builder.renderProfileAvatarModerationOpenApiDocument(),
    rendered,
  );
  assert.equal(await readFile(artifact, 'utf8'), rendered);
  assert.equal(rendered.endsWith('\n'), true);
});
