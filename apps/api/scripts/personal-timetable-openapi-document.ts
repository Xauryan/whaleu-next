import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import type { OpenAPIObject, SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';
import {
  timetableCommandSchema,
  timetableTermsSchema,
  timetableDetailSchema,
  timetableReceiptSchema,
  timetableRecoverySchema,
} from '../src/personal-timetable/contracts.js';
export function createPersonalTimetableOpenApiDocument(): OpenAPIObject {
  const response = (name: string) => ({
    description: name,
    headers: {
      'Cache-Control': {
        schema: { type: 'string' as const },
        description: 'private, no-store',
      },
    },
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
    },
  });
  const body = {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/PersonalTimetableCommand' },
      },
    },
  };
  const id = (name: string) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: {
      type: 'string' as const,
      format: 'uuid',
      pattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  });
  const security = [{ accessToken: [] }];
  const errors = {
    '400': { description: 'Strict DTO rejected. No request recorded.' },
    '401': {
      description:
        'Current presented session required, including recovery; revocation and precise expiry are never bypassed.',
    },
    '503': {
      description:
        'TIMETABLE_UNAVAILABLE: retain original intent and request key; recover before deciding outcome.',
    },
  };
  const schema = (value: z.ZodType): SchemaObject =>
    z.toJSONSchema(value, {
      target: 'openapi-3.0',
      io: 'input',
    }) as unknown as SchemaObject;
  return {
    openapi: '3.0.3',
    info: {
      title: 'WhaleU account-private manual timetable',
      version: '1',
      description:
        'Manual private account data only. No academic login/import, grades, notifications, sharing or public profiles. Up to 32 live terms and 200 live entries per term. Tombstones scrub all schedule fields and reserve IDs permanently within the account. Every mutation CASes the aggregate term revision under one account lock. Read and commit proofs require current sessions; interaction mute alone does not block private self service.',
    },
    paths: {
      '/v1/me/timetable/terms': {
        get: {
          operationId: 'PersonalTimetableController_list',
          security,
          responses: {
            '200': response('PersonalTimetableTerms'),
            ...errors,
            '403': {
              description: 'Current access suspension denies private reads.',
            },
          },
        },
      },
      '/v1/me/timetable/terms/{termId}': {
        get: {
          operationId: 'PersonalTimetableController_detail',
          security,
          parameters: [id('termId')],
          responses: {
            '200': response('PersonalTimetableDetail'),
            ...errors,
            '404': {
              description:
                'TIMETABLE_NOT_FOUND; absent, deleted and other-account targets are indistinguishable.',
            },
          },
        },
      },
      '/v1/me/timetable/commands': {
        post: {
          operationId: 'PersonalTimetableController_execute',
          security,
          requestBody: body,
          description:
            'Full replacement payloads, strict version 1 discriminated union. Term.create expectedRevision=0; all other operations use current aggregate positive term revision. Exact same request key + SHA256 canonical full command replays original receipt without effects. A rejected receipt is durable and requires a new key after explicit edit/rebase. New writes enforce private_self_service after historical recovery. Changing Monday shifts the series; shortening weekCount rejects existing out-of-range weeks, never trims. Half-open same-day minutes, end > start, explicit strictly increasing unique weeks in 1..term.weekCount. Monday is a validated civil date in years1900..2199, Asia/Shanghai only. Text values must be canonical before freezing, never server-trimmed.',
          responses: {
            '200': response('PersonalTimetableReceipt'),
            ...errors,
            '409': {
              description:
                'TIMETABLE_REQUEST_CONFLICT: key reused with a different full-command intent.',
            },
          },
        },
      },
      '/v1/me/timetable/requests/{requestId}': {
        get: {
          operationId: 'PersonalTimetableController_recover',
          security,
          parameters: [id('requestId')],
          description:
            'Minimal private receipt recovery remains available under account punishment with a current authenticated session. Unknown is not evidence of failure, cancellation or rollback; retain original key and intent. Cross-account receipts return unknown.',
          responses: {
            '200': response('PersonalTimetableRecovery'),
            ...errors,
          },
        },
      },
      '/v1/me/timetable/requests/{requestId}/cancel': {
        post: {
          operationId: 'PersonalTimetableController_cancel',
          security,
          parameters: [id('requestId')],
          requestBody: body,
          description:
            'Send the entire original frozen command and matching path requestId. If unrecorded, atomically seal its exact hash as cancelled. If already settled, return original historical receipt, including an applied receipt; cancellation never rolls back or undoes a committed effect. A cancelled key can never later execute. No private schedule text is returned or retained in receipts.',
          responses: {
            '200': response('PersonalTimetableReceipt'),
            ...errors,
            '409': {
              description:
                'TIMETABLE_REQUEST_CONFLICT: path/key or original intent mismatch.',
            },
          },
        },
      },
    },
    components: {
      securitySchemes: { accessToken: { type: 'http', scheme: 'bearer' } },
      schemas: {
        PersonalTimetableCommand: schema(timetableCommandSchema),
        PersonalTimetableTerms: schema(timetableTermsSchema),
        PersonalTimetableDetail: schema(timetableDetailSchema),
        PersonalTimetableReceipt: {
          ...schema(timetableReceiptSchema),
          description:
            'Minimal immutable intent proof. intentHash is lowercase SHA256 of UTF8 JSON.stringify canonical command ordered version,requestId,operation,termId,expectedRevision,entryId (entry operations only),payload. Term payload order name,weekOneMonday,weekCount,timeZone. Entry payload order name,teacher,location,note,dayOfWeek,startMinute,endMinute,weeks,color. Delete payload {}. Verify every original field/hash before clearing native recovery. Applied resultingRevision=expectedRevision+1; cancelled resultingRevision=null; rejected code is required. Never contains schedule text.',
        },
        PersonalTimetableRecovery: schema(timetableRecoverySchema),
      },
    },
  };
}
export async function renderPersonalTimetableOpenApiDocument(): Promise<string> {
  return format(JSON.stringify(createPersonalTimetableOpenApiDocument()), {
    parser: 'json',
  });
}
export async function writePersonalTimetableOpenApi(check: boolean) {
  const output = new URL(
      '../../../../docs/openapi/personal-timetable.json',
      import.meta.url,
    ),
    text = await renderPersonalTimetableOpenApiDocument();
  if (check) {
    if ((await readFile(output, 'utf8')) !== text)
      throw new Error('Stale docs/openapi/personal-timetable.json');
  } else await writeFile(output, text);
}
