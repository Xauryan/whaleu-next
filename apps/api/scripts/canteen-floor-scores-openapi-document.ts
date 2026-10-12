import { RatingRequestGuard } from '../src/request-throttling/rating-request.guard.js';
import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { FloorRatingsController } from '../src/ratings/canteen-floors/controller.js';
import { FloorRatingsService } from '../src/ratings/canteen-floors/service.js';
export async function createCanteenFloorScoresOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of [
    'catalog',
    'detail',
    'setScore',
    'receipt',
    'cancel',
    'own',
    'summary',
  ])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        FloorRatingsController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [FloorRatingsController],
    providers: [
      {
        provide: FloorRatingsService,
        useValue: {
          catalog: fail,
          detail: fail,
          setScore: fail,
          receipt: fail,
          cancel: fail,
          own: fail,
          summary: fail,
        },
      },
    ],
  })
    .overrideGuard(RatingRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU independent canteen-floor scores')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token; fresh reads and writes require current phone, Safety and accepted floor topology/history.',
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
export async function renderCanteenFloorScoresOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createCanteenFloorScoresOpenApiDocument()),
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
export async function writeCanteenFloorScoresOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/canteen-floor-scores.json',
      import.meta.url,
    ),
    rendered = await renderCanteenFloorScoresOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Canteen-floor scores OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Canteen-floor scores OpenAPI artifact is current.'
      : 'Generated docs/openapi/canteen-floor-scores.json.',
  );
}
