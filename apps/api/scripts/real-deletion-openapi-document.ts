import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  prepareDeletionSchema,
  deletionStatusSchema,
  acceptDeletionSchema,
  cancelDeletionSchema,
} from '../src/account-deletion/real/contracts.js';
export function createRealDeletionOpenApiDocument(): OpenAPIObject {
  const schema = (value: z.ZodType): SchemaObject =>
    z.toJSONSchema(value, {
      target: 'openapi-3.0',
      io: 'input',
    }) as unknown as SchemaObject;
  const body = (name: string) => ({
    required: true,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
    },
  });
  const errors = {
    '400': {
      description: 'Strict bounded command rejected; no authority granted.',
    },
    '404': {
      description:
        'Scope unavailable; unknown request, wrong secret and cross-account target are indistinguishable.',
    },
    '409': {
      description:
        'Exact original intent conflicts; no secret replacement or expiry extension.',
    },
    '429': { description: 'Bounded request rate exhausted.' },
    '503': {
      description:
        'Real deletion unavailable. Missing schema/configuration or unproven authority never activates deletion.',
    },
  };
  const response = {
    description:
      'Only this exact preparation. No account, session, provider identity or secret.',
    headers: {
      'Cache-Control': {
        schema: { type: 'string' as const },
        description: 'private, no-store',
      },
    },
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/RealDeletionPreparationReceipt' },
      },
    },
  };
  const requestResponse = {
    ...response,
    description:
      'Minimum exact existing real request receipt. No ordinary credentials or account history.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/RealDeletionRequestReceipt' },
      },
    },
  };
  const statusResponse = {
    ...response,
    description:
      'This exact preparation or accepted request only; closing new acceptance does not revoke recovery.',
    content: {
      'application/json': {
        schema: {
          oneOf: [
            { $ref: '#/components/schemas/RealDeletionPreparationReceipt' },
            { $ref: '#/components/schemas/RealDeletionRequestReceipt' },
          ],
        },
      },
    },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: 'WhaleU real account deletion non-activated request entry',
      version: '1',
      description:
        'Disabled by default. New preparation is non-destructive. The real request coordinator is connected, but installed production admission remains unavailable. Existing exact request receipts and capability cancellation remain recoverable with new requests disabled. Fresh-provider lost-capability recovery and complete erasure are NOT implemented; no production acceptance availability is claimed. Recovery secret is generated and persisted by the native client before prepare, sent only in body and retained server-side only as a purpose/account/intent/generation-bound hash. No environment value can enable acceptance. No ordinary-account deletion availability is claimed.',
    },
    paths: {
      '/v1/account-deletion/prepare': {
        post: {
          operationId: 'RealDeletionController_prepare',
          security: [{ accessToken: [] }],
          requestBody: body('RealDeletionPrepare'),
          responses: {
            '200': response,
            '401': { description: 'Current ordinary access token required.' },
            ...errors,
          },
        },
      },
      '/v1/account-deletion/status': {
        post: {
          operationId: 'RealDeletionController_status',
          requestBody: body('RealDeletionStatus'),
          responses: { '200': statusResponse, ...errors },
        },
      },
      '/v1/account-deletion/accept': {
        post: {
          operationId: 'RealDeletionController_accept',
          description:
            'Exact accepted receipt replay precedes bearer/provider requirements. New acceptance additionally requires an original ordinary bearer, fresh WeChat verification and a fixed legitimate admission owner. The installed production owner is unavailable; configuration alone cannot enable it.',
          requestBody: body('RealDeletionAccept'),
          responses: {
            '200': requestResponse,
            '401': {
              description:
                'A verified prepared capability requires an original current bearer for new acceptance; an existing accepted receipt never requires ordinary credentials.',
            },
            ...errors,
          },
        },
      },
      '/v1/account-deletion/cancel': {
        post: {
          operationId: 'RealDeletionController_cancel',
          description:
            'Purpose-only exact request cancellation or command replay. No ordinary bearer required; new-acceptance disabled flags do not block recovery. Never reports an unaccepted preparation as successfully cancelled.',
          requestBody: body('RealDeletionCancel'),
          responses: { '200': requestResponse, ...errors },
        },
      },
    },
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer' } },
      schemas: {
        RealDeletionPrepare: schema(prepareDeletionSchema),
        RealDeletionStatus: schema(deletionStatusSchema),
        RealDeletionAccept: schema(acceptDeletionSchema),
        RealDeletionCancel: schema(cancelDeletionSchema),
        RealDeletionRequestReceipt: {
          type: 'object',
          additionalProperties: false,
          required: [
            'protocol',
            'intentId',
            'phase',
            'revision',
            'preparedAt',
            'preparationExpiresAt',
            'acceptedAt',
            'cancelBefore',
            'completedAt',
          ],
          properties: {
            protocol: { type: 'string', enum: ['real-account-deletion-v1'] },
            intentId: { type: 'string', format: 'uuid' },
            phase: { type: 'string', enum: ['cooling', 'cancelled'] },
            revision: { type: 'string', pattern: '^[1-9][0-9]*$' },
            preparedAt: { type: 'string', format: 'date-time' },
            preparationExpiresAt: { type: 'string', format: 'date-time' },
            acceptedAt: { type: 'string', format: 'date-time' },
            cancelBefore: { type: 'string', format: 'date-time' },
            completedAt: { type: 'string', nullable: true, enum: [null] },
          },
        },
        RealDeletionPreparationReceipt: {
          type: 'object',
          additionalProperties: false,
          required: [
            'protocol',
            'intentId',
            'phase',
            'revision',
            'preparedAt',
            'preparationExpiresAt',
            'acceptedAt',
            'cancelBefore',
            'completedAt',
          ],
          properties: {
            protocol: { type: 'string', enum: ['real-account-deletion-v1'] },
            intentId: { type: 'string', format: 'uuid' },
            phase: { type: 'string', enum: ['prepared'] },
            revision: { type: 'string', enum: ['0'] },
            preparedAt: { type: 'string', format: 'date-time' },
            preparationExpiresAt: { type: 'string', format: 'date-time' },
            acceptedAt: { type: 'string', nullable: true, enum: [null] },
            cancelBefore: { type: 'string', nullable: true, enum: [null] },
            completedAt: { type: 'string', nullable: true, enum: [null] },
          },
        },
      },
    },
  };
}
export async function renderRealDeletionOpenApiDocument(): Promise<string> {
  return format(JSON.stringify(createRealDeletionOpenApiDocument()), {
    parser: 'json',
  });
}
export async function writeRealDeletionOpenApi(check: boolean) {
  const output = new URL(
      '../../../../docs/openapi/real-account-deletion.json',
      import.meta.url,
    ),
    text = await renderRealDeletionOpenApiDocument();
  if (check) {
    if ((await readFile(output, 'utf8')) !== text)
      throw new Error('Stale real-account-deletion OpenAPI');
  } else await writeFile(output, text);
}
