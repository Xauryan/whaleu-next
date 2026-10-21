import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { z } from 'zod';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod } from '@nestjs/common';
import { ReadingFormattingController } from '../src/community/reading-formatting/controller.js';
import { readingCapabilitySchema } from '../src/community/reading-formatting/capability.js';
import { textSourceCapabilitiesQuerySchema } from '../src/community/text-source/controller.js';
import { safeErrorResponseSchema } from '../src/http/error-contracts.js';
export function createReadingCapabilityOpenApiDocument() {
  const handler = ReadingFormattingController.prototype.capabilities;
  if (
    Reflect.getMetadata(PATH_METADATA, ReadingFormattingController) !==
      'v2/community' ||
    Reflect.getMetadata(PATH_METADATA, handler) !==
      'text-source-capabilities' ||
    Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod.GET
  )
    throw new Error('Reading capability route changed');
  const query = z.toJSONSchema(textSourceCapabilitiesQuerySchema, {
    io: 'input',
  });
  return {
    openapi: '3.1.0',
    info: {
      title: 'WhaleU source capability and independent formatting readiness',
      version: '2',
    },
    paths: {
      '/v2/community/text-source-capabilities': {
        get: {
          operationId: 'communityTextSourceCapabilitiesV2',
          security: [{ accessToken: [] }],
          parameters: Object.entries(query.properties ?? {}).map(
            ([name, schema]) => ({
              name,
              in: 'query',
              required: query.required?.includes(name) ?? false,
              schema,
            }),
          ),
          description:
            'Current source capability is mandatory and independent. Installed means complete formal M2 catalog/slot protocol observation. Worker requestedMode is this API process configuration intent, not proof of external worker readiness; readiness remains not_observed. No credentials, queue state or source content is exposed.',
          responses: {
            200: {
              description:
                'Current source capability and optional M2 observation',
              headers: {
                'Cache-Control': {
                  schema: { type: 'string', const: 'no-store' },
                },
                Vary: { schema: { type: 'string', const: 'Authorization' } },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReadingCapability' },
                },
              },
            },
            ...Object.fromEntries(
              [400, 401, 403, 409, 503].map((code) => [
                code,
                {
                  description: 'Canonical access or validation failure',
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
      },
    },
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ReadingCapability: z.toJSONSchema(readingCapabilitySchema),
        SafeError: z.toJSONSchema(safeErrorResponseSchema),
      },
    },
  };
}
export async function renderReadingCapabilityOpenApiDocument() {
  return format(JSON.stringify(createReadingCapabilityOpenApiDocument()), {
    parser: 'json',
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
  });
}
export async function writeReadingCapabilityOpenApi(check: boolean) {
  const target = new URL(
      '../../../../docs/openapi/community-reading-capability.json',
      import.meta.url,
    ),
    rendered = await renderReadingCapabilityOpenApiDocument();
  if (check) {
    if ((await readFile(target, 'utf8')) !== rendered)
      throw new Error('Reading capability OpenAPI artifact is stale');
  } else await writeFile(target, rendered, 'utf8');
}
