import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  socialNoticeSchema,
  socialUpdatesPageSchema,
  socialUnreadSchema,
  socialNoticeTargetSchema,
  socialNoticeReadSchema,
} from '../src/notifications/social/contracts.js';

export function createSocialUpdatesOpenApiDocument(): OpenAPIObject {
  const schema = (value: z.ZodType): SchemaObject =>
    z.toJSONSchema(value, {
      target: 'openapi-3.0',
      io: 'input',
    }) as unknown as SchemaObject;
  const category = {
    name: 'category',
    in: 'query' as const,
    required: true,
    schema: { type: 'string' as const, enum: ['likes', 'saves', 'followers'] },
    description:
      'Required immutable reader category. Every item and target must match this category.',
  };
  const notice = {
    name: 'noticeId',
    in: 'path' as const,
    required: true,
    schema: { type: 'string' as const, format: 'uuid' },
  };
  const security = [{ accessToken: [] }];
  const response = (name: string) => ({
    description: name,
    headers: {
      'Cache-Control': {
        schema: { type: 'string' as const },
        description: 'no-store',
      },
      Vary: {
        schema: { type: 'string' as const },
        description: 'Authorization',
      },
    },
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
    },
  });
  const errors = {
    '400': { description: 'Strict input or scoped cursor rejected.' },
    '401': { description: 'Current presented account/session required.' },
    '403': { description: 'Current safety policy denied the operation.' },
    '404': { description: 'No notice belonging to this account and category.' },
    '503': {
      description:
        'Mandatory authority or source proof unavailable; no private projection is returned.',
    },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: 'WhaleU local received social updates',
      version: '1',
      description:
        'Fresh local like/save/follow sources only; no historical backfill or external delivery. Likes/saves never identify the actor. Unavailable notices contain metadata only. Lists and target opening never acknowledge a notice. Current-readable unread is exact only when bounded complete coverage is proved; unknown or pending source coverage is null, never a partial total or zero substitute.',
    },
    paths: {
      '/v1/me/social-updates': {
        get: {
          operationId: 'SocialUpdatesController_list',
          security,
          parameters: [
            category,
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
            },
            {
              name: 'cursor',
              in: 'query',
              schema: {
                type: 'string',
                minLength: 1,
                maxLength: 1024,
                pattern: '^[A-Za-z0-9_-]+$',
              },
              description:
                'Opaque account/session/category/limit-bound continuation; not a target or offset.',
            },
          ],
          responses: { '200': response('SocialUpdatesPage'), ...errors },
        },
      },
      '/v1/me/social-updates/unread-count': {
        get: {
          operationId: 'SocialUpdatesController_count',
          security,
          parameters: [category],
          responses: { '200': response('SocialUnread'), ...errors },
        },
      },
      '/v1/me/social-updates/{noticeId}/target': {
        get: {
          operationId: 'SocialUpdatesController_target',
          security,
          parameters: [notice, category],
          description:
            'Reauthorizes the current target. No read acknowledgment and no unavailable reason/locator disclosure.',
          responses: { '200': response('SocialNoticeTarget'), ...errors },
        },
      },
      '/v1/me/social-updates/{noticeId}/read': {
        put: {
          operationId: 'SocialUpdatesController_read',
          security,
          parameters: [notice, category],
          description:
            'Explicit owner acknowledgment only. Retries preserve the exact original read timestamp. The response conveys no target permission.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              },
            },
          },
          responses: { '200': response('SocialNoticeRead'), ...errors },
        },
      },
    },
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer' } },
      schemas: {
        SocialNotice: schema(socialNoticeSchema),
        SocialUpdatesPage: {
          ...schema(socialUpdatesPageSchema),
          description:
            'Distinct notice IDs, at most requested limit. Category determines like/save/follow kind. Follow actor and target profile IDs are identical. Reply targets include their root comment; saves target themes only. Unread status available iff count is non-null.',
        },
        SocialUnread: schema(socialUnreadSchema),
        SocialNoticeTarget: schema(socialNoticeTargetSchema),
        SocialNoticeRead: {
          ...schema(socialNoticeReadSchema),
          description:
            'Unread status available iff count is non-null; never infer completeness from current page length.',
        },
      },
    },
  };
}
export async function renderSocialUpdatesOpenApiDocument(): Promise<string> {
  return format(JSON.stringify(createSocialUpdatesOpenApiDocument()), {
    parser: 'json',
  });
}
export async function writeSocialUpdatesOpenApi(check: boolean) {
  const output = new URL(
    '../../../../docs/openapi/social-updates.json',
    import.meta.url,
  );
  const rendered = await renderSocialUpdatesOpenApiDocument();
  if (check) {
    if ((await readFile(output, 'utf8')) !== rendered)
      throw new Error('Stale docs/openapi/social-updates.json');
  } else await writeFile(output, rendered);
}
