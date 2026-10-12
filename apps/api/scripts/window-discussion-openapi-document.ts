import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  WindowDiscussionController,
  WindowDiscussionNoticesController,
} from '../src/ratings/windows/discussion/controller.js';
import { WindowDiscussionService } from '../src/ratings/windows/discussion/service.js';
import { RatingRequestGuard } from '../src/request-throttling/rating-request.guard.js';
export async function createWindowDiscussionOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of [
    'receipt',
    'cancel',
    'page',
    'publish',
    'own',
    'like',
    'reply',
    'thread',
  ])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        WindowDiscussionController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [
      WindowDiscussionController,
      WindowDiscussionNoticesController,
    ],
    providers: [
      {
        provide: WindowDiscussionService,
        useValue: {
          page: fail,
          publish: fail,
          reply: fail,
          like: fail,
          own: fail,
          receipt: fail,
          cancel: fail,
          noticePage: fail,
          noticeTarget: fail,
          noticeRead: fail,
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
        .setTitle('WhaleU specialist Window text discussion')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current actor session; fresh public reads and positive mutations additionally require phone and Safety.',
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
export async function renderWindowDiscussionOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createWindowDiscussionOpenApiDocument()),
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
export async function writeWindowDiscussionOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/window-discussion.json',
      import.meta.url,
    ),
    rendered = await renderWindowDiscussionOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Window discussion OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Window discussion OpenAPI artifact is current.'
      : 'Generated docs/openapi/window-discussion.json.',
  );
}
