import {
  adminDiscussionRemovalManagementQuerySchema,
  adminDiscussionRemovalCommandSchema,
  adminDiscussionRemovalRequestIdSchema,
} from '../src/community/admin-discussion-removal/contracts.js';
import {
  documentScopedRemovalQuery,
  documentScopedRemovalInputs,
} from './scoped-removal-openapi-query.js';
import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AdminDiscussionRemovalController } from '../src/community/admin-discussion-removal/controller.js';
import { AdminDiscussionRemovalService } from '../src/community/admin-discussion-removal/service.js';
export async function createAdminDiscussionRemovalOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['management', 'command', 'recovery', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        AdminDiscussionRemovalController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [AdminDiscussionRemovalController],
    providers: [
      {
        provide: AdminDiscussionRemovalService,
        useValue: {
          management: fail,
          command: fail,
          recovery: fail,
        },
      },
    ],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU scoped administrator discussion removal')
        .setDescription(
          'Remove one currently readable canonical native root comment or reply. Legacy v1 and compound v2 retain original-region or super-admin grants, including exact v4 inherited-root reconstruction; v2 retains protected-target checks. Pure-removal v3 requires explicit viewSpaceId and an exact current destination-region or super-admin grant for current related distribution, and carries no punishment, selection or punishment options. Named and anonymous content remains content targets only; private authors never become public account locators. Exact school-admin or super-admin grant, phone, Safety, Review, source version and current Media remain required. The selected child alone is tombstoned; a root releases its own comment pin and hides its thread by ancestry, while a reply preserves siblings and references. The canonical component capture and bounded media-cleanup obligation remain independent. Version1 sends no author notification; selected version2 adds a private deletion notice and a separately caused punishment notice. Version1 creates no account punishment; explicit version2 may atomically issue Safety mute or suspension for the exact original author. No owner-deletion Experience, jury verdict, role grant or provider is created. Actor-owned recovery and cancellation need only the same active account and current session token.',
        )
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token. Management and new commands require exact content-bound authority; recovery and cancellation belong to the original actor. Caller-supplied account/profile identifiers and display role labels never grant authority.',
        })
        .build(),
      {
        deepScanRoutes: false,
        autoTagControllers: false,
        excludeDynamicDefaults: true,
      },
    );
    documentScopedRemovalQuery(
      document,
      '/v1/community/admin-discussion-removal/management',
      adminDiscussionRemovalManagementQuerySchema,
    );
    documentScopedRemovalInputs(
      document,
      '/v1/community/admin-discussion-removal',
      adminDiscussionRemovalCommandSchema,
      adminDiscussionRemovalRequestIdSchema,
    );
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
export async function renderAdminDiscussionRemovalOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createAdminDiscussionRemovalOpenApiDocument()),
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
export async function writeAdminDiscussionRemovalOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/admin-discussion-removal.json',
      import.meta.url,
    ),
    rendered = await renderAdminDiscussionRemovalOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Administrator discussion removal OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Administrator discussion removal OpenAPI artifact is current.'
      : 'Generated docs/openapi/admin-discussion-removal.json.',
  );
}
