import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  ProfileCoverOwnedController,
  ProfileCoverPublicController,
  ProfileCoverMultipartInterceptor,
} from '../src/profile/cover/controller.js';
import {
  ProfileCoverService,
  PROFILE_COVER_RUNTIME,
} from '../src/profile/cover/service.js';
import { ProfileCoverUploadApplication } from '../src/profile/cover/upload-application.js';
import { ProfileCoverDelivery } from '../src/profile/cover/delivery.js';
export async function createProfileCoverOpenApiDocument(): Promise<OpenAPIObject> {
  if (
    !Reflect.hasMetadata(
      PARAMTYPES_METADATA,
      ProfileCoverOwnedController.prototype,
      'command',
    )
  )
    throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const testing = await Test.createTestingModule({
    controllers: [ProfileCoverOwnedController, ProfileCoverPublicController],
    providers: [
      { provide: ProfileCoverService, useValue: {} },
      { provide: ProfileCoverUploadApplication, useValue: {} },
      { provide: ProfileCoverDelivery, useValue: {} },
      { provide: PROFILE_COVER_RUNTIME, useValue: null },
      ProfileCoverMultipartInterceptor,
    ],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('Independent profile cover media')
        .setVersion('1')
        .addBearerAuth(
          { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
          'accessToken',
        )
        .build(),
    );
  } finally {
    await app.close();
  }
}
export async function writeProfileCoverOpenApi(check: boolean) {
  const output = await format(
    JSON.stringify(await createProfileCoverOpenApiDocument()),
    { parser: 'json' },
  );
  const path = new URL(
    '../../../../docs/openapi/profile-cover.json',
    import.meta.url,
  );
  if (check) {
    if ((await readFile(path, 'utf8')) !== output)
      throw new Error('Profile cover OpenAPI artifact is stale');
  } else await writeFile(path, output, 'utf8');
}
