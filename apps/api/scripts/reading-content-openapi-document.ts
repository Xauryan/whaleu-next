import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { z } from 'zod';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { ReadingContentController } from '../src/community/reading-content/controller.js';
import { postViewQuerySchema } from '../src/community/contracts.js';
import {
  commentsQuerySchema,
  repliesQuerySchema,
  contextQuerySchema,
} from '../src/community/discussion/contracts.js';
import {
  readingPostDetailSchema,
  readingCommentsPageSchema,
  readingCommentDetailSchema,
  readingRepliesPageSchema,
  readingReplyDetailSchema,
  readingContextSchema,
} from '../src/community/reading-content/contracts.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';

/** Runtime contracts and actual registered route metadata are the authority.
 * No application services, provider, database or external account are started. */
export function createReadingContentOpenApiDocument() {
  const routes = [
    [
      'detail',
      'ReadingPostDetail',
      readingPostDetailSchema,
      postViewQuerySchema,
    ],
    [
      'comments',
      'ReadingCommentsPage',
      readingCommentsPageSchema,
      commentsQuerySchema,
    ],
    ['comment', 'ReadingCommentDetail', readingCommentDetailSchema, null],
    [
      'replies',
      'ReadingRepliesPage',
      readingRepliesPageSchema,
      repliesQuerySchema,
    ],
    ['reply', 'ReadingReplyDetail', readingReplyDetailSchema, null],
    ['context', 'ReadingContext', readingContextSchema, contextQuerySchema],
  ] as const;
  const schemas: Record<string, unknown> = {};
  const paths: Record<string, unknown> = {};
  for (const [method, name, schema, query] of routes) {
    const handler = ReadingContentController.prototype[method];
    const prefix = Reflect.getMetadata(PATH_METADATA, ReadingContentController);
    const route = Reflect.getMetadata(PATH_METADATA, handler);
    if (
      prefix !== 'v2/community' ||
      typeof route !== 'string' ||
      Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod.GET
    )
      throw new Error('Source-aware route metadata changed');
    const path = `/${prefix}/${route.replace(':id', '{id}')}`;
    schemas[name] = z.toJSONSchema(schema);
    const parameters: object[] = [
      {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
    ];
    if (query) {
      const input = z.toJSONSchema(query, { io: 'input' });
      for (const [key, value] of Object.entries(input.properties ?? {}))
        parameters.push({
          name: key,
          in: 'query',
          required: input.required?.includes(key) ?? false,
          schema: value,
        });
    }
    paths[path] = {
      get: {
        operationId: `ReadingContentController_${method}`,
        security: [{ accessToken: [] }],
        parameters,
        description:
          'Same authenticated legacy access policy and managed transaction. Unchanged nested DTO; server-owned explicit source discriminator. v6 requires exact current source, Review, Media, Campus, Community and Safety evidence. Denial/unknown evidence fails the entire read, never a legacy fallback. Only lossless derived presentation is optional. Preview identities must exactly match the existing nested preview. Discussion cursors remain scoped to the original parent/root/session/sort.',
        responses: {
          200: {
            description: 'Current source-aware projection',
            headers: {
              'Cache-Control': {
                schema: { type: 'string', const: 'no-store' },
              },
              Vary: { schema: { type: 'string', const: 'Authorization' } },
            },
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${name}` },
              },
            },
          },
          ...Object.fromEntries(
            [400, 401, 403, 404, 409, 503].map((code) => [
              code,
              {
                description:
                  'Existing validation, identity, authorization, missing content, continuation or current-source failure; no content/source body is returned.',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/SafeError' },
                  },
                },
              },
            ]),
          ),
        },
      },
    };
  }
  schemas['SafeError'] = z.toJSONSchema(safeErrorResponseSchema);
  return {
    openapi: '3.1.0',
    info: {
      title: 'WhaleU source-aware current detail and discussion',
      version: '2',
    },
    paths,
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer' } },
      schemas,
    },
  };
}
export async function renderReadingContentOpenApiDocument(): Promise<string> {
  return format(JSON.stringify(createReadingContentOpenApiDocument()), {
    parser: 'json',
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
  });
}
export async function writeReadingContentOpenApi(check: boolean) {
  const artifact = new URL(
    '../../../../docs/openapi/community-reading-content.json',
    import.meta.url,
  );
  const rendered = await renderReadingContentOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error('Reading content OpenAPI artifact is stale');
  } else await writeFile(artifact, rendered, 'utf8');
}
