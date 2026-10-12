import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AdminPostRemovalController } from '../src/community/admin-removal/controller.js';
import { AdminPostRemovalService } from '../src/community/admin-removal/service.js';
export async function createAdminPostRemovalOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['management', 'command', 'recovery', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        AdminPostRemovalController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [AdminPostRemovalController],
    providers: [
      {
        provide: AdminPostRemovalService,
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
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU scoped administrator post removal')
        .setDescription(
          'Remove one currently readable native-origin post in its original regional scope with sync:none. Named and anonymous posts remain content targets only; private authors never become public account locators. Exact school-admin or super-admin grant, phone, Safety, Review, source version and current Media remain required. The canonical tombstone closes pins and creates the existing durable bounded cleanup obligation, plus one independent private author notice. No owner-deletion Experience, jury verdict, ban, role grant or provider is created. Actor-owned recovery and cancellation need only the same active account and current session token.',
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
export async function renderAdminPostRemovalOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createAdminPostRemovalOpenApiDocument()),
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
export async function writeAdminPostRemovalOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/admin-post-removal.json',
      import.meta.url,
    ),
    rendered = await renderAdminPostRemovalOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Administrator post removal OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Administrator post removal OpenAPI artifact is current.'
      : 'Generated docs/openapi/admin-post-removal.json.',
  );
}
