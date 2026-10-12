import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  PostPinsController,
  PostPinRecoveryController,
} from '../src/community/post-pins/controller.js';
import { PostPinsService } from '../src/community/post-pins/service.js';
export async function createScopedPostPinsOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['list', 'slot', 'detail', 'command'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        PostPinsController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [PostPinsController, PostPinRecoveryController],
    providers: [
      {
        provide: PostPinsService,
        useValue: {
          list: fail,
          slot: fail,
          detail: fail,
          command: fail,
          receipt: fail,
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
        .setTitle('WhaleU scoped post pins')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token; school management checks true current grants.',
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
export async function renderScopedPostPinsOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createScopedPostPinsOpenApiDocument()),
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
export async function writeScopedPostPinsOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/scoped-post-pins.json',
      import.meta.url,
    ),
    rendered = await renderScopedPostPinsOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Scoped post pins OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Scoped post pins OpenAPI artifact is current.'
      : 'Generated docs/openapi/scoped-post-pins.json.',
  );
}
