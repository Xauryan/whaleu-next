import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { OwnerVisibilityController } from '../src/community/owner-visibility/controller.js';
import { OwnerVisibilityService } from '../src/community/owner-visibility/service.js';
export async function createOwnerPostVisibilityOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['management', 'command', 'receipt', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        OwnerVisibilityController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [OwnerVisibilityController],
    providers: [
      {
        provide: OwnerVisibilityService,
        useValue: {
          management: fail,
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
        .setTitle('WhaleU owner post visibility')
        .setDescription(
          'Authenticated authors can set an independent desired owner-hidden state with exact version CAS. Recovery and cancellation use the original actor and request. Minimal management contains no content or author identity. Administrator grants do not override ownership; restoration preserves all independent content gates.',
        )
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token. All routes require the original authenticated owner; no caller-supplied account or administrator override.',
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
export async function renderOwnerPostVisibilityOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createOwnerPostVisibilityOpenApiDocument()),
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
export async function writeOwnerPostVisibilityOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/owner-post-visibility.json',
      import.meta.url,
    ),
    rendered = await renderOwnerPostVisibilityOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Owner post visibility OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Owner post visibility OpenAPI artifact is current.'
      : 'Generated docs/openapi/owner-post-visibility.json.',
  );
}
