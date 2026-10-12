import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { SystemNoticesController } from '../src/notifications/system-notices/controller.js';
import { SystemNoticesService } from '../src/notifications/system-notices/service.js';
export async function createSystemNoticesOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['list', 'count', 'read'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        SystemNoticesController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [SystemNoticesController],
    providers: [
      {
        provide: SystemNoticesService,
        useValue: {
          list: fail,
          unreadCount: fail,
          markRead: fail,
        },
      },
    ],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU owner system notices')
        .setDescription(
          'Authenticated owner-only list, unread count and idempotent first-read acknowledgement for three strict notice kinds: post_jury_removed, profile_nickname_reset and profile_custom_avatar_cleared. Custom avatar clear notices expose only noticeId, kind, createdAt and readAt, without identity, old image, source links or replacement-image claims. Equal-time pagination uses createdAt, global notice ID and kind; old v1 jury and v2 nickname cursors remain readable. Reading a list never marks notices read. No content visibility or profile lookup is required to read a historical notice.',
        )
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token. Each request authenticates the recipient owner independently. A notice ID or cursor is not an authorization grant; callers cannot select another account or override ownership with an administrator role.',
        })
        .build(),
      {
        deepScanRoutes: false,
        autoTagControllers: false,
        excludeDynamicDefaults: true,
      },
    );
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
export async function renderSystemNoticesOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(sorted(await createSystemNoticesOpenApiDocument()), null, 2),
    {
      parser: 'json',
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      endOfLine: 'lf',
    },
  );
}
export async function writeSystemNoticesOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/system-notices.json',
      import.meta.url,
    ),
    rendered = await renderSystemNoticesOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'System notices OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'System notices OpenAPI artifact is current.'
      : 'Generated docs/openapi/system-notices.json.',
  );
}
