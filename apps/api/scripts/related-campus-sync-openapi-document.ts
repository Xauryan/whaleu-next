import { documentRelatedCanonicalIdentifiers } from './related-campus-identifiers-openapi.js';
import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { z } from 'zod';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import type {
  OperationObject,
  ParameterObject,
  SchemaObject,
} from '@nestjs/swagger';
import {
  CommunityReadController,
  CommunityPublicationController,
} from '../src/community/community.module.js';
import { FeedService } from '../src/community/feed.service.js';
import { PublicationService } from '../src/community/publication.service.js';
import { DeletionService } from '../src/community/deletion.service.js';
import { DiscussionController } from '../src/community/discussion/controller.js';
import { DiscussionReadService } from '../src/community/discussion/read.service.js';
import { DiscussionMutationService } from '../src/community/discussion/mutation.service.js';
import { ReplyPublicationService } from '../src/community/discussion/publication.service.js';
import { CategoryReclassificationController } from '../src/community/category-reclassification/controller.js';
import { CategoryReclassificationService } from '../src/community/category-reclassification/service.js';
import {
  categoryPostIdSchema,
  categoryManagementSchema,
  reclassificationReceiptSchema,
  reclassificationRecoverySchema,
} from '../src/community/category-reclassification/contracts.js';
import {
  publishPostSchema,
  publishCommentSchema,
  capabilitiesQuerySchema,
  feedQuerySchema,
  postViewQuerySchema,
} from '../src/community/contracts.js';
import { publishReplySchema } from '../src/community/discussion/contracts.js';
import { hotPostViewSchema } from '../src/community/hot/response-schema.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';

// These response projections mirror the existing public TypeScript interfaces.
// Inputs are always converted from the actual runtime validation schemas.
const availability = z.enum(['allowed', 'denied', 'unavailable']);
const reason = z.string().nullable();
export const relatedPublicationCapabilitiesSchema = z.strictObject({
  publish: z.strictObject({ availability, reason }),
  relatedCampusSync: z
    .strictObject({
      availability,
      reason,
      authorModes: z.array(z.enum(['named', 'anonymous'])).optional(),
      canDisableComments: z.boolean().optional(),
    })
    .optional(),
  authorModes: z.array(z.enum(['named', 'anonymous'])),
  canDisableComments: z.boolean(),
  postImageLimit: z.literal(9),
  commentImageLimit: z.literal(3),
  mediaAvailability: z.literal('unavailable'),
  commentRules: z.strictObject({
    unverifiedRequiresNamed: z.literal(true),
    ownAnonymousPostForcesAnonymous: z.literal(true),
  }),
});
export const relatedCommentCapabilitiesSchema = z.strictObject({
  inheritsRelatedCampusSync: z.boolean().optional(),
  lastAuthorMode: z.enum(['named', 'anonymous']).nullable(),
  availability,
  reason,
  authorModes: z.array(z.enum(['named', 'anonymous'])),
  forcedAuthorMode: z.literal('anonymous').nullable(),
});
export const relatedPostViewSchema = hotPostViewSchema
  .safeExtend({
    allowAnonymousDm: z.boolean(),
    feedback: z
      .strictObject({
        authorSchool: z.string().nullable(),
        hasContacts: z.boolean(),
      })
      .optional(),
  })
  .meta({ id: 'CommunityPostView' });
export const relatedFeedPageSchema = z.strictObject({
  items: z.array(relatedPostViewSchema),
  relatedCampusDistribution: z.enum(['complete', 'unavailable']).optional(),
  nextCursor: z.string().nullable(),
  continuation: z.enum([
    'available',
    'end',
    'login_required',
    'phone_verification_required',
  ]),
});
const publicationReceipt = z.union([
  z.strictObject({
    requestId: z.uuid(),
    operation: z.enum(['publish_post', 'publish_comment', 'publish_reply']),
    outcome: z.literal('created'),
    resourceId: z.uuid(),
    createdAt: z.string(),
  }),
  z.strictObject({
    requestId: z.uuid(),
    operation: z.enum(['publish_post', 'publish_comment', 'publish_reply']),
    outcome: z.literal('rejected'),
    code: z.string(),
  }),
]);
const schema = (value: z.ZodType, io: 'input' | 'output' = 'output') =>
  z.toJSONSchema(value, {
    target: 'openapi-3.0',
    io,
    metadata: z.registry(),
    reused: 'inline',
    cycles: 'throw',
  }) as SchemaObject;
const content = (value: z.ZodType, io: 'input' | 'output' = 'output') => ({
  'application/json': { schema: schema(value, io) },
});
function query(value: z.ZodType): ParameterObject[] {
  const object = schema(value, 'input');
  return Object.entries(object.properties ?? {}).map(([name, property]) => ({
    name,
    in: 'query',
    required: object.required?.includes(name) ?? false,
    schema: property,
  }));
}

/** The category owner historically reuses its UUID lowercasing input pipe in
 * three output contracts. Represent only that exact known transform as its
 * canonical UUID result; preserve every surrounding runtime field, bound and
 * strict union, and reject any other newly introduced output transform. */
export function categoryOutputOpenApiSchema(value: z.ZodType): SchemaObject {
  return z.toJSONSchema(value, {
    target: 'openapi-3.0',
    io: 'output',
    metadata: z.registry(),
    reused: 'inline',
    cycles: 'throw',
    unrepresentable: ({ zodSchema }) =>
      zodSchema === categoryPostIdSchema.out
        ? {
            type: 'string',
            format: 'uuid',
            pattern:
              '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
          }
        : 'throw',
  }) as SchemaObject;
}

/** Actual routes, fail-only service providers, no application graph, DB or provider. */
export async function createRelatedCampusSyncOpenApiDocument(): Promise<OpenAPIObject> {
  for (const [controller, methods] of [
    [
      CommunityReadController,
      ['capabilities', 'feed', 'detail', 'commentCapabilities'],
    ],
    [CommunityPublicationController, ['post', 'comment']],
    [DiscussionController, ['create']],
    [
      CategoryReclassificationController,
      ['management', 'command', 'recovery', 'cancel'],
    ],
  ] as const)
    for (const method of methods) {
      if (
        !Reflect.hasMetadata(PARAMTYPES_METADATA, controller.prototype, method)
      )
        throw new Error(
          'OpenAPI requires emitted TypeScript decorator metadata',
        );
    }
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [
      CommunityReadController,
      CommunityPublicationController,
      DiscussionController,
      CategoryReclassificationController,
    ],
    providers: [
      {
        provide: FeedService,
        useValue: {
          spaces: fail,
          capabilities: fail,
          feed: fail,
          detail: fail,
          commentCapabilities: fail,
        },
      },
      { provide: PublicationService, useValue: { post: fail, comment: fail } },
      { provide: DeletionService, useValue: { post: fail, comment: fail } },
      {
        provide: DiscussionReadService,
        useValue: {
          comments: fail,
          comment: fail,
          reply: fail,
          replies: fail,
          context: fail,
        },
      },
      {
        provide: DiscussionMutationService,
        useValue: { deleteReply: fail, set: fail },
      },
      { provide: ReplyPublicationService, useValue: { create: fail } },
      {
        provide: CategoryReclassificationService,
        useValue: { management: fail, command: fail, recovery: fail },
      },
    ],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU related-campus publication and distribution')
        .setVersion('1')
        .setDescription(
          'Related-campus opt-in creates one canonical native post and one shared discussion graph. Omitted or false opt-in retains historical publication behavior. Fresh opt-in requires current home identity, explicit school configuration, accepted current Campus topology and exact Review applicability; unsupported shapes fail closed. Capabilities are advisory. Public distribution uses current accepted groups and preserves all Review, Media, Safety and owner-hidden checks. Post.space and content identifiers remain canonical. isRelatedCampusSync is true only in another eligible view; sourceRegion is safe public metadata. Missing optional metadata is not authority. relatedCampusDistribution unavailable means same-school results remain available without proving remote completeness. Detail viewSpaceId only selects display context. Children inherit the root binding and never accept client sync choices. Separate owner documents define pin v2, removal v3, explicit unsupported Profile capabilities and settings v2.',
        )
        .addSecurity('accessToken', { type: 'http', scheme: 'bearer' })
        .build(),
      {
        deepScanRoutes: false,
        autoTagControllers: false,
        excludeDynamicDefaults: true,
        standardSchemaConverter: (value, { schemaType }) => {
          if (schemaType !== 'output') return undefined;
          for (const output of [
            categoryManagementSchema,
            reclassificationReceiptSchema,
            reclassificationRecoverySchema,
          ])
            if (value === output)
              return { schema: categoryOutputOpenApiSchema(output) };
          return undefined;
        },
      },
    );
    const selected: OpenAPIObject['paths'] = {};
    const operation = (
      path: string,
      method: 'get' | 'post',
    ): OperationObject => {
      const found = document.paths[path]?.[method];
      if (!found)
        throw new Error(
          `Missing actual related-campus route ${method} ${path}`,
        );
      selected[path] ??= {};
      selected[path][method] = found;
      found.security = [{ accessToken: [] }];
      found.parameters = (found.parameters ?? [])
        .filter((p) => !('$ref' in p) && p.in === 'path')
        .map((p) => ({ ...p, schema: { type: 'string', format: 'uuid' } }));
      for (const status of ['400', '401', '403', '404', '409', '503'])
        found.responses[status] = {
          description:
            status === '503'
              ? 'Current owner proof or accepted applicability unavailable; never silently downgraded.'
              : 'Existing semantic error envelope.',
          content: content(safeErrorResponseSchema),
        };
      return found;
    };
    const read = (path: string, output: z.ZodType, params?: z.ZodType) => {
      const op = operation(path, 'get');
      op.responses['200'] = {
        description: 'Current public owner projection.',
        content: content(output),
      };
      if (params) op.parameters?.push(...query(params));
      return op;
    };
    read(
      '/v1/community/capabilities',
      relatedPublicationCapabilitiesSchema,
      capabilitiesQuerySchema,
    );
    const feed = read(
      '/v1/community/posts',
      relatedFeedPageSchema,
      feedQuerySchema,
    );
    feed.security = [{ accessToken: [] }, {}];
    read(
      '/v1/community/posts/{postId}',
      relatedPostViewSchema,
      postViewQuerySchema,
    );
    read(
      '/v1/community/posts/{postId}/comment-capabilities',
      relatedCommentCapabilitiesSchema,
    );
    for (const [path, input] of [
      ['/v1/community/posts', publishPostSchema],
      ['/v1/community/posts/{postId}/comments', publishCommentSchema],
      ['/v1/community/comments/{id}/replies', publishReplySchema],
    ] as const) {
      const op = operation(path, 'post');
      op.requestBody = { required: true, content: content(input, 'input') };
      documentRelatedCanonicalIdentifiers(
        op,
        path === '/v1/community/posts'
          ? 'post'
          : path.endsWith('/comments')
            ? 'comment'
            : 'reply',
        path === '/v1/community/posts'
          ? undefined
          : path.endsWith('/comments')
            ? 'postId'
            : 'id',
      );
      op.responses['201'] = {
        description:
          'Actor-owned canonical publication result, recoverable under its original key.',
        content: content(publicationReceipt),
      };
    }
    for (const path of [
      '/v1/community/posts/{postId}/category-management',
      '/v1/community/category-commands',
      '/v1/community/category-requests/{requestId}',
      '/v1/community/category-requests/{requestId}/cancel',
    ]) {
      const actual = document.paths[path];
      if (!actual) throw new Error(`Missing actual category route ${path}`);
      selected[path] = actual;
    }
    document.paths = selected;
    return document;
  } finally {
    await app.close();
  }
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  return value;
}
export async function renderRelatedCampusSyncOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createRelatedCampusSyncOpenApiDocument()),
      null,
      2,
    ),
    {
      parser: 'json',
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      endOfLine: 'lf',
    },
  );
}
export async function writeRelatedCampusSyncOpenApi(check: boolean) {
  const artifact = new URL(
    '../../../../docs/openapi/related-campus-sync.json',
    import.meta.url,
  );
  const rendered = await renderRelatedCampusSyncOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Related-campus OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Related-campus OpenAPI artifact is current.'
      : 'Generated docs/openapi/related-campus-sync.json.',
  );
}
