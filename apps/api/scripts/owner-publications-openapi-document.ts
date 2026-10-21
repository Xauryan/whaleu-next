import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { PublicationHistoryController } from '../src/community/publications/controller.js';
import { PublicationHistoryService } from '../src/community/publications/service.js';
export async function createOwnerPublicationsOpenApiDocument(): Promise<OpenAPIObject> {
  if (
    !Reflect.hasMetadata(
      PARAMTYPES_METADATA,
      PublicationHistoryController.prototype,
      'list',
    )
  )
    throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const testing = await Test.createTestingModule({
    controllers: [PublicationHistoryController],
    providers: [{ provide: PublicationHistoryService, useValue: {} }],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('Private owner publication history')
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
export async function writeOwnerPublicationsOpenApi(check: boolean) {
  const output = await format(
    JSON.stringify(await createOwnerPublicationsOpenApiDocument()),
    { parser: 'json' },
  );
  const path = new URL(
    '../../../../docs/openapi/owner-publications.json',
    import.meta.url,
  );
  if (check) {
    if ((await readFile(path, 'utf8')) !== output)
      throw new Error('Owner publications OpenAPI artifact is stale');
  } else await writeFile(path, output, 'utf8');
}
