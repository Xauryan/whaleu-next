import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ProfileAvatarModerationController } from '../src/profile/avatar-moderation/controller.js';
import { ProfileAvatarModerationService } from '../src/profile/avatar-moderation/service.js';
export async function createProfileAvatarModerationOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['management', 'command', 'recovery', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        ProfileAvatarModerationController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [ProfileAvatarModerationController],
    providers: [
      {
        provide: ProfileAvatarModerationService,
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
        .setTitle('WhaleU scoped profile custom avatar clear')
        .setDescription(
          'Clear only the current custom avatar from a named post, comment or reply in the fixed original regional scope. The shared Profile revision and current appearance must match. This removes the account-wide non-anonymous custom image and shows the existing unselected placeholder. No replacement bytes, fake Review, production catalog or provider is created. The subject receives a private notice. A readable named related-sync source with current content-management authority instead returns only target, canClearCustomAvatar:false, availability:unavailable and blocker:related_sync_unsupported, including at its original campus; no display, revision, appearance or subject identity is exposed. Fresh related-source commands cannot clear an avatar. New requests and storage opens awaiting final authorization reject the old appearance; already authorized streams and downloaded bytes are not recalled. Actor-owned recovery and cancellation require only the original session and key.',
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
export async function renderProfileAvatarModerationOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createProfileAvatarModerationOpenApiDocument()),
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
export async function writeProfileAvatarModerationOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/profile-avatar-moderation.json',
      import.meta.url,
    ),
    rendered = await renderProfileAvatarModerationOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Profile moderation OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Profile moderation OpenAPI artifact is current.'
      : 'Generated docs/openapi/profile-avatar-moderation.json.',
  );
}
