import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  referenceCapabilitySchema,
  referenceDestinationSchema,
  referenceLookupSchema,
  referenceLookupResultSchema,
  referenceResolveSchema,
} from '../src/community/content-references/contracts.js';

export function createContentReferencesOpenApiDocument(): OpenAPIObject {
  const schema = (value: z.ZodType): SchemaObject =>
    z.toJSONSchema(value, {
      target: 'openapi-3.0',
      io: 'input',
    }) as unknown as SchemaObject;
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
  const body = (name: string) => ({
    required: true,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
    },
  });
  const errors = {
    '400': {
      description:
        'Strict input rejected. Whole ASCII code or typed UUID targets only.',
    },
    '401': {
      description:
        'Current account and presented session required at completion.',
    },
    '403': {
      description: 'Current ordinary account safety policy denied the read.',
    },
    '503': {
      description:
        'Uninitialized capability or mandatory current authority dependency unavailable. Not a false absence.',
    },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: 'WhaleU permanent community references',
      version: '1',
      description:
        'Additive opaque numeric references. Existing UUID routes and publication receipts remain unchanged. No production import or activation. No allocation during read. Aliases and canonical codes share one permanent namespace; code width never chooses target kind.',
    },
    paths: {
      '/v1/community/content-references/capability': {
        get: {
          operationId: 'communityContentReferenceCapability',
          security,
          description:
            'Authentication required. Inactive or incomplete initialized policy returns available:false; source faults remain unavailable.',
          responses: {
            '200': response('ContentReferenceCapability'),
            ...errors,
          },
        },
      },
      '/v1/community/content-references/resolve': {
        post: {
          operationId: 'communityContentReferenceResolve',
          security,
          description:
            'Current ordinary read authority and stored ancestry, no manager bypass. Optional selected view scope is reauthorized. A navigation hint is not an access grant; destination detail rechecks authority. Aliases do not reveal canonical identity. At most 60 attempts per viewer/minute; unknown or unreadable attempts count.',
          requestBody: body('ContentReferenceResolve'),
          responses: {
            '200': response('ContentReferenceDestination'),
            ...errors,
            '404': {
              description:
                'REFERENCE_NOT_FOUND for all missing, removed or currently unreadable mappings. No mapped IDs in errors.',
            },
            '429': { description: 'REFERENCE_RATE_LIMITED' },
          },
        },
      },
      '/v1/community/content-references/lookup': {
        post: {
          operationId: 'communityContentReferenceLookup',
          security,
          description:
            '1–30 typed targets, deduplicated and deterministically ordered. Returns only existing canonical codes with current read permission. No aliases, missing placeholders or allocation. At most 120 requests per viewer/minute.',
          requestBody: body('ContentReferenceLookup'),
          responses: {
            '200': response('ContentReferenceLookupResult'),
            ...errors,
            '429': { description: 'REFERENCE_RATE_LIMITED' },
          },
        },
      },
    },
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ContentReferenceCapability: schema(referenceCapabilitySchema),
        ContentReferenceResolve: schema(referenceResolveSchema),
        ContentReferenceDestination: schema(referenceDestinationSchema),
        ContentReferenceLookup: schema(referenceLookupSchema),
        ContentReferenceLookupResult: schema(referenceLookupResultSchema),
      },
    },
  };
}
export async function renderContentReferencesOpenApiDocument(): Promise<string> {
  return format(JSON.stringify(createContentReferencesOpenApiDocument()), {
    parser: 'json',
  });
}
export async function writeContentReferencesOpenApi(
  check: boolean,
): Promise<void> {
  const output = new URL(
    '../../../../docs/openapi/content-references.json',
    import.meta.url,
  );
  const rendered = await renderContentReferencesOpenApiDocument();
  if (check) {
    if ((await readFile(output, 'utf8')) !== rendered)
      throw new Error('Stale docs/openapi/content-references.json');
  } else await writeFile(output, rendered);
}
