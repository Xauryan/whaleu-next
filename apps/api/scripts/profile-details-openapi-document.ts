import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import type { OpenAPIObject } from '@nestjs/swagger';
export function createProfileDetailsOpenApiDocument(): OpenAPIObject {
  const fields = {
    region: {
      type: 'string',
      nullable: true,
      maxLength: 80,
      description: 'Self-reported area label; never inferred from location.',
    },
    gender: {
      type: 'string',
      nullable: true,
      enum: ['female', 'male'] as string[],
    },
    age: {
      type: 'integer',
      nullable: true,
      minimum: 0,
      maximum: 120,
      description: 'Self-reported current age, not derived from birth date.',
    },
    showRegion: { type: 'boolean', default: false },
    showGender: { type: 'boolean', default: false },
    showAge: { type: 'boolean', default: false },
  } as const;
  const response = (name: string) => ({
    description: name,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
    },
  });
  return {
    openapi: '3.0.3',
    info: {
      title: 'WhaleU optional profile details',
      version: '1',
      description:
        'Private-by-default optional self-reported fields. Does not modify the existing strict profile DTO; no backfill from identity data. Public reads expose only fields explicitly enabled by their owner and honor current named-profile access.',
    },
    paths: {
      '/v1/me/profile-stats': {
        get: {
          operationId: 'ProfileStatsController_own',
          security: [{ accessToken: [] }],
          description:
            'Current recorded relationships with active existing profiles visible to the owner under both block directions. Not lifetime totals. Bounded current-source reads; lock contention, incomplete coverage or exhausted budget is unavailable, not zero. Received interactions has no complete safe aggregate and remains unavailable.',
          responses: { '200': response('OwnProfileStats') },
        },
      },
      '/v1/me/profile-details': {
        get: {
          operationId: 'ProfileDetailsController_own',
          security: [{ accessToken: [] }],
          responses: { '200': response('OwnProfileDetails') },
        },
        patch: {
          operationId: 'ProfileDetailsController_update',
          security: [{ accessToken: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProfileDetailsPatch' },
              },
            },
          },
          responses: {
            '200': response('OwnProfileDetails'),
            '409': {
              description:
                'PROFILE_DETAILS_REVISION_CONFLICT; reload before editing. The rejected write is not applied.',
            },
          },
        },
      },
      '/v1/profiles/{profileId}/details': {
        get: {
          operationId: 'ProfileDetailsController_public',
          security: [{}, { accessToken: [] }],
          parameters: [
            {
              name: 'profileId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: { '200': response('PublicProfileDetails') },
        },
      },
    },
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ProfileSocialCount: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'value'],
              properties: {
                status: { type: 'string', enum: ['known'] },
                value: { type: 'integer', minimum: 0, maximum: 1024 },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'value'],
              properties: {
                status: { type: 'string', enum: ['unavailable'] },
                value: { nullable: true, enum: [null] },
              },
            },
          ],
        },
        OwnProfileStats: {
          type: 'object',
          additionalProperties: false,
          required: [
            'accountId',
            'following',
            'followers',
            'receivedInteractions',
          ],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            following: { $ref: '#/components/schemas/ProfileSocialCount' },
            followers: { $ref: '#/components/schemas/ProfileSocialCount' },
            receivedInteractions: {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'value'],
              properties: {
                status: { type: 'string', enum: ['unavailable'] },
                value: { nullable: true, enum: [null] },
              },
            },
          },
        },
        OwnProfileDetails: {
          type: 'object',
          additionalProperties: false,
          required: ['accountId', 'revision', ...Object.keys(fields)],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            revision: { type: 'integer', minimum: 0, maximum: 2147483647 },
            ...fields,
          },
        },
        ProfileDetailsPatch: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedRevision', ...Object.keys(fields)],
          properties: {
            expectedRevision: {
              type: 'integer',
              minimum: 0,
              maximum: 2147483646,
            },
            ...fields,
          },
        },
        PublicProfileDetails: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'profileId'],
              properties: {
                status: { type: 'string', enum: ['unavailable'] },
                profileId: { type: 'string', format: 'uuid' },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['status', 'profileId', 'region', 'gender', 'age'],
              properties: {
                status: { type: 'string', enum: ['available'] },
                profileId: { type: 'string', format: 'uuid' },
                region: fields.region,
                gender: fields.gender,
                age: fields.age,
              },
            },
          ],
        },
      },
    },
  };
}
export async function writeProfileDetailsOpenApi(check: boolean) {
  const output = new URL(
    '../../../../docs/openapi/profile-details.json',
    import.meta.url,
  );
  const text = await format(
    JSON.stringify(createProfileDetailsOpenApiDocument()),
    { parser: 'json' },
  );
  if (check) {
    if ((await readFile(output, 'utf8')) !== text)
      throw new Error('Stale docs/openapi/profile-details.json');
  } else await writeFile(output, text);
}
