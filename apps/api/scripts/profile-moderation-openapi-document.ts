import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ProfileModerationController } from '../src/profile/moderation/controller.js';
import { ProfileModerationService } from '../src/profile/moderation/service.js';
export async function createProfileModerationOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['management', 'command', 'recovery', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        ProfileModerationController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [ProfileModerationController],
    providers: [
      {
        provide: ProfileModerationService,
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
        .setTitle('WhaleU scoped profile nickname moderation')
        .setDescription(
          'Content-target nickname reset for current named posts, comments and replies in the fixed original regional scope. Exact current administrator authority, readable ancestry and shared Profile revision CAS are required. The reset affects account-wide public names, including other regions; anonymous personas remain unchanged. The subject receives a private system notice. A readable named related-sync source with current content-management authority instead returns only target, canReset:false, availability:unavailable and blocker:related_sync_unsupported, including at its original campus; no display name, revision or subject identity is exposed. Fresh related-source commands are semantically unavailable and cannot mutate the profile. Actor-owned recovery and cancellation preserve the original request and return minimal metadata without subject identity or old/new nickname.',
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
export async function renderProfileModerationOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createProfileModerationOpenApiDocument()),
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
export async function writeProfileModerationOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/profile-moderation.json',
      import.meta.url,
    ),
    rendered = await renderProfileModerationOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Profile moderation OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Profile moderation OpenAPI artifact is current.'
      : 'Generated docs/openapi/profile-moderation.json.',
  );
}
