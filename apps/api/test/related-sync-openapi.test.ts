import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { z } from 'zod';
import {
  publishPostSchema,
  publishCommentSchema,
} from '../src/community/contracts.js';
import { relatedCanonicalIdSchema } from '../src/community/related-sync/contracts.js';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { OperationObject, SchemaObject } from '@nestjs/swagger';

type Schema = SchemaObject & { $ref?: string };
async function document(file: string, method: string): Promise<OpenAPIObject> {
  const module = await import(
    new URL(
      `../.openapi-build/scripts/${file}-openapi-document.js`,
      import.meta.url,
    ).href
  );
  return module[method]();
}
function resolve(doc: OpenAPIObject, raw: Schema | undefined): Schema {
  assert.ok(raw);
  if (!raw.$ref) return raw;
  assert.ok(raw.$ref.startsWith('#/components/schemas/'));
  return resolve(
    doc,
    doc.components?.schemas?.[
      raw.$ref.slice('#/components/schemas/'.length)
    ] as Schema | undefined,
  );
}
function variants(doc: OpenAPIObject, raw: Schema): Schema[] {
  const value = resolve(doc, raw);
  const options = value.anyOf ?? value.oneOf;
  return options
    ? options.flatMap((option) => variants(doc, option as Schema))
    : [value];
}
function body(doc: OpenAPIObject, path: string): Schema {
  const value = doc.paths[path]?.post?.requestBody;
  assert.ok(
    value && !('$ref' in value),
    `POST ${path} must document its actual request body`,
  );
  assert.equal(value.required, true);
  return resolve(
    doc,
    value.content['application/json']?.schema as Schema | undefined,
  );
}
function response(
  doc: OpenAPIObject,
  path: string,
  method: 'get' | 'post' = 'get',
): Schema {
  const value = doc.paths[path]?.[method]?.responses['200'];
  assert.ok(value && !('$ref' in value));
  return resolve(
    doc,
    value.content?.['application/json']?.schema as Schema | undefined,
  );
}
function exact(schema: Schema, keys: string[]) {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(schema.properties ?? {}).sort(),
    keys.slice().sort(),
  );
}

test('related-campus document binds actual publication, capability and explicit-view routes without exposing internal distribution facts', async () => {
  const module = await import(
    new URL(
      '../.openapi-build/scripts/related-campus-sync-openapi-document.js',
      import.meta.url,
    ).href
  );
  const doc: OpenAPIObject =
    await module.createRelatedCampusSyncOpenApiDocument();
  assert.equal(doc.openapi, '3.0.3');
  assert.equal(Object.keys(doc.paths).length, 10);
  const post = body(doc, '/v1/community/posts');
  assert.equal(post.additionalProperties, false);
  assert.equal(
    resolve(doc, post.properties?.['syncToRelatedCampuses'] as Schema).type,
    'boolean',
  );
  assert.equal(post.required?.includes('syncToRelatedCampuses'), false);
  for (const path of [
    '/v1/community/posts/{postId}/comments',
    '/v1/community/comments/{id}/replies',
  ]) {
    const child = body(doc, path);
    assert.equal(child.additionalProperties, false);
    assert.equal(child.properties?.['syncToRelatedCampuses'], undefined);
    assert.equal(child.properties?.['viewSpaceId'], undefined);
  }
  const capabilities = response(doc, '/v1/community/capabilities');
  const related = resolve(
    doc,
    capabilities.properties?.['relatedCampusSync'] as Schema,
  );
  assert.deepEqual(
    resolve(doc, related.properties?.['availability'] as Schema).enum,
    ['allowed', 'denied', 'unavailable'],
  );
  assert.ok(related.properties?.['authorModes']);
  assert.ok(related.properties?.['canDisableComments']);
  const detail = doc.paths['/v1/community/posts/{postId}']?.get;
  const view = detail?.parameters?.find(
    (p) => !('$ref' in p) && p.name === 'viewSpaceId',
  );
  assert.ok(view && !('$ref' in view));
  assert.equal(view.required, false);
  assert.equal((view.schema as Schema).format, 'uuid');
  const projection = response(doc, '/v1/community/posts/{postId}');
  assert.ok(projection.properties?.['isRelatedCampusSync']);
  const source = resolve(
    doc,
    projection.properties?.['sourceRegion'] as Schema,
  );
  exact(source, ['id', 'name']);
  const feed = response(doc, '/v1/community/posts');
  assert.deepEqual(
    resolve(doc, feed.properties?.['relatedCampusDistribution'] as Schema).enum,
    ['complete', 'unavailable'],
  );
  assert.ok(
    response(doc, '/v1/community/posts/{postId}/comment-capabilities')
      .properties?.['inheritsRelatedCampusSync'],
  );
  const category = response(
    doc,
    '/v1/community/posts/{postId}/category-management',
  );
  assert.deepEqual(
    resolve(doc, category.properties?.['blocker'] as Schema).enum,
    ['related_sync_unsupported'],
  );
  assert.equal(
    resolve(doc, category.properties?.['postId'] as Schema).format,
    'uuid',
  );
  assert.equal(
    resolve(doc, category.properties?.['postId'] as Schema).pattern,
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  );
  assert.throws(
    () =>
      module.categoryOutputOpenApiSchema(
        z.string().transform((value) => value.length),
      ),
    /Transforms cannot be represented/,
  );
  assert.equal(
    resolve(doc, projection.properties?.['allowAnonymousDm'] as Schema).type,
    'boolean',
  );
  assert.equal(projection.required?.includes('allowAnonymousDm'), true);
  const wire = JSON.stringify(doc);
  for (const internal of [
    'topologySnapshotId',
    'topologyRevision',
    'sourceGeneration',
    'fingerprint',
    'grantId',
    'subjectId',
    'affiliationAssertionId',
  ])
    assert.equal(wire.includes(`"${internal}":`), false, internal);
  const rendered = await module.renderRelatedCampusSyncOpenApiDocument();
  assert.equal(await module.renderRelatedCampusSyncOpenApiDocument(), rendered);
  assert.equal(
    await readFile(
      new URL(
        '../../../docs/openapi/related-campus-sync.json',
        import.meta.url,
      ),
      'utf8',
    ),
    rendered,
  );
});

test('generated owner documents preserve strict pin v1/v2, pure-removal v3 and unavailable Profile branches', async () => {
  const pins = await document(
    'scoped-post-pins',
    'createScopedPostPinsOpenApiDocument',
  );
  const pinOptions = variants(
    pins,
    body(pins, '/v1/community/post-pin-commands'),
  );
  assert.equal(pinOptions.length, 6);
  assert.equal(pinOptions.filter((v) => v.properties?.['version']).length, 3);
  for (const v of pinOptions) {
    const versioned = !!v.properties?.['version'];
    assert.equal(!!v.properties?.['spaceId'], versioned);
    if (versioned)
      assert.deepEqual(
        resolve(pins, v.properties?.['version'] as Schema).enum,
        [2],
      );
  }
  assert.ok(
    pins.paths['/v1/community/posts/{postId}/pin']?.get?.parameters?.some(
      (p) => !('$ref' in p) && p.name === 'viewSpaceId',
    ),
  );
  for (const [name, create, base] of [
    [
      'admin-post-removal',
      'createAdminPostRemovalOpenApiDocument',
      '/v1/community/admin-post-removal',
    ],
    [
      'admin-discussion-removal',
      'createAdminDiscussionRemovalOpenApiDocument',
      '/v1/community/admin-discussion-removal',
    ],
  ] as const) {
    const doc = await document(name, create);
    const query = doc.paths[`${base}/management`]?.get?.parameters ?? [];
    assert.deepEqual(query.map((p) => ('$ref' in p ? p.$ref : p.name)).sort(), [
      'id',
      'kind',
      'version',
      'viewSpaceId',
    ]);
    assert.deepEqual(
      body(doc, `${base}/commands/cancel`),
      body(doc, `${base}/commands`),
    );
    const locator = doc.paths[`${base}/requests/{requestId}`]?.get?.parameters;
    assert.equal(locator?.length, 1);
    const requestId = locator?.[0];
    assert.ok(requestId && !('$ref' in requestId));
    assert.equal(requestId.name, 'requestId');
    assert.equal(requestId.in, 'path');
    assert.equal(requestId.required, true);
    assert.equal((requestId.schema as Schema).format, 'uuid');
    const pure = variants(doc, body(doc, `${base}/commands`)).find(
      (v) =>
        v.properties?.['version'] &&
        resolve(doc, v.properties['version'] as Schema).enum?.includes(3),
    );
    assert.ok(pure);
    exact(pure, [
      'clientRequestId',
      'target',
      'expectedTargetVersion',
      'action',
      'version',
      'viewSpaceId',
    ]);
    const management = variants(doc, response(doc, `${base}/management`)).find(
      (v) => v.properties?.['viewSpaceId'],
    );
    assert.ok(management);
    exact(management, [
      'target',
      'targetVersion',
      'canRemove',
      'version',
      'viewSpaceId',
    ]);
    const receipts = variants(
      doc,
      response(doc, `${base}/commands`, 'post'),
    ).filter((v) => v.properties?.['viewSpaceId']);
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) {
      assert.equal(receipt.properties?.['punishment'], undefined);
      assert.equal(receipt.properties?.['selection'], undefined);
    }
  }
  for (const [name, create, base, capability] of [
    [
      'profile-moderation',
      'createProfileModerationOpenApiDocument',
      '/v1/community/profile-moderation',
      'canReset',
    ],
    [
      'profile-avatar-moderation',
      'createProfileAvatarModerationOpenApiDocument',
      '/v1/community/profile-avatar-moderation',
      'canClearCustomAvatar',
    ],
  ] as const) {
    const doc = await document(name, create);
    const unavailable = variants(doc, response(doc, `${base}/management`)).find(
      (v) => v.properties?.['blocker'],
    );
    assert.ok(unavailable);
    exact(unavailable, ['target', capability, 'availability', 'blocker']);
    assert.deepEqual(
      resolve(doc, unavailable.properties?.[capability] as Schema).enum,
      [false],
    );
  }
  const settings = await document(
    'school-posting-policy',
    'createSchoolPostingPolicyOpenApiDocument',
  );
  const commands = variants(
    settings,
    body(settings, '/v1/me/school-posting-policy/{regionId}'),
  );
  assert.equal(commands.length, 2);
  for (const command of commands) {
    const policy = resolve(settings, command.properties?.['policy'] as Schema);
    assert.equal(
      !!policy.properties?.['relatedSyncEnabled'],
      !!command.properties?.['version'],
    );
    assert.equal(policy.additionalProperties, false);
  }
});

test('existing Review and discovery exports carry opt-in and public source coverage without widening child inputs', async () => {
  const source = await import(
    new URL('../.openapi-build/scripts/openapi-document.js', import.meta.url)
      .href
  );
  const review: OpenAPIObject = await source.createUsableTextOpenApiDocument();
  assert.ok(
    body(review, '/v1/community/reviews/posts').properties?.[
      'syncToRelatedCampuses'
    ],
  );
  for (const path of [
    '/v1/community/reviews/posts/{id}/comments',
    '/v1/community/reviews/comments/{id}/replies',
  ])
    assert.equal(
      body(review, path).properties?.['syncToRelatedCampuses'],
      undefined,
    );
  for (const method of [
    'createHotOpenApiDocument',
    'createSearchOpenApiDocument',
  ]) {
    const doc: OpenAPIObject = await source[method]();
    const wire = JSON.stringify(doc);
    for (const field of [
      'isRelatedCampusSync',
      'sourceRegion',
      'relatedCampusDistribution',
    ])
      assert.ok(wire.includes(`"${field}":`), field);
  }
});

test('OpenAPI represents v4-only canonical identifiers while preserving legacy request schemas and recovery order', async () => {
  const source = await import(
    new URL('../.openapi-build/scripts/openapi-document.js', import.meta.url)
      .href
  );
  const main = await document(
    'related-campus-sync',
    'createRelatedCampusSyncOpenApiDocument',
  );
  const review: OpenAPIObject = await source.createUsableTextOpenApiDocument();
  const input = (value: z.ZodType) =>
    z.toJSONSchema(value, {
      target: 'openapi-3.0',
      io: 'input',
      metadata: z.registry(),
      reused: 'inline',
      cycles: 'throw',
    }) as Schema;
  const canonical = input(relatedCanonicalIdSchema);
  const legacy = input(publishPostSchema);
  for (const [doc, rootPath, commentPath, replyPath, parameter] of [
    [
      main,
      '/v1/community/posts',
      '/v1/community/posts/{postId}/comments',
      '/v1/community/comments/{id}/replies',
      'postId',
    ],
    [
      review,
      '/v1/community/reviews/posts',
      '/v1/community/reviews/posts/{id}/comments',
      '/v1/community/reviews/comments/{id}/replies',
      'id',
    ],
  ] as const) {
    const root = body(doc, rootPath);
    const { allOf, ...base } = root;
    assert.deepEqual(
      base,
      legacy,
      'legacy validation fields and default/optional handling remain exact',
    );
    assert.equal(root.additionalProperties, false);
    assert.equal(root.required?.includes('syncToRelatedCampuses'), false);
    assert.equal(allOf?.length, 1);
    const conditions = (allOf![0] as Schema).anyOf as Schema[];
    assert.equal(conditions.length, 2);
    const absentOrFalse = conditions[0]!,
      explicitTrue = conditions[1]!;
    assert.deepEqual(
      (absentOrFalse.properties?.['syncToRelatedCampuses'] as Schema).enum,
      [false],
    );
    assert.equal(absentOrFalse.required, undefined);
    assert.deepEqual(explicitTrue.required, ['syncToRelatedCampuses']);
    assert.deepEqual(
      (explicitTrue.properties?.['syncToRelatedCampuses'] as Schema).enum,
      [true],
    );
    assert.deepEqual(explicitTrue.properties?.['spaceId'], canonical);
    assert.deepEqual(
      (explicitTrue.properties?.['imageAssetIds'] as Schema).items,
      canonical,
    );
    assert.deepEqual(
      body(doc, commentPath),
      input(publishCommentSchema),
      'comment input stays legacy-shaped; v4 context belongs to the server',
    );
    const comment = doc.paths[commentPath]!.post! as OperationObject & {
      'x-related-canonical-identifiers': {
        condition: string;
        pathParameters: Record<string, Schema>;
        bodyProperties: { imageAssetIds: Schema };
        validationOrder: string;
      };
    };
    const conditional = comment!['x-related-canonical-identifiers'];
    assert.equal(
      conditional.condition,
      'server-resolved canonical root uses related-sync v4',
    );
    assert.deepEqual(conditional.pathParameters[parameter], canonical);
    assert.deepEqual(conditional.bodyProperties.imageAssetIds.items, canonical);
    assert.match(
      conditional.validationOrder,
      /after original-key receipt recovery, before new Review/,
    );
    for (const path of [rootPath, commentPath]) {
      const error = doc.paths[path]!.post!.responses['422'];
      assert.ok(error && !('$ref' in error));
      const envelope = resolve(
        doc,
        error.content?.['application/json']?.schema as Schema,
      );
      const fields = resolve(doc, envelope.properties?.['error'] as Schema);
      exact(fields, ['code', 'message', 'requestId']);
      assert.deepEqual((fields.properties?.['code'] as Schema).enum, [
        'RELATED_CONTENT_CANONICAL_ID_REQUIRED',
      ]);
      assert.match(
        error.description,
        /after original-key receipt recovery and before new Review/,
      );
    }
    assert.match(
      doc.paths[replyPath]!.post!.description!,
      /already canonicalizes UUIDs to lowercase/,
    );
    assert.equal(
      doc.paths[replyPath]!.post!.responses['422'],
      undefined,
      'reply normalization is not a newly documented lowercase rejection',
    );
  }
  const upper = 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF';
  const unchanged = {
    clientRequestId: '11111111-1111-4111-8111-111111111111',
    spaceId: upper,
    category: 'discussion',
    text: 'Legacy byte preservation',
    authorMode: 'named',
    imageAssetIds: [upper],
  };
  for (const syncToRelatedCampuses of [undefined, false]) {
    const parsed = publishPostSchema.parse({
      ...unchanged,
      ...(syncToRelatedCampuses === undefined ? {} : { syncToRelatedCampuses }),
    });
    assert.equal(parsed.spaceId, upper);
    assert.deepEqual(parsed.imageAssetIds, [upper]);
  }
  assert.equal(relatedCanonicalIdSchema.safeParse(upper).success, false);
  assert.equal(
    relatedCanonicalIdSchema.safeParse(upper.toLowerCase()).success,
    true,
  );
});
