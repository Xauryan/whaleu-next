import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ActivityPublicationController } from '../src/activities/publication/controller.js';
import { ActivityPublicationService } from '../src/activities/publication/service.js';
import { ActivityPublicationRequestGuard } from '../src/activities/publication/request-guard.js';
import {
  ActivityMediaController,
  ActivityMultipartInterceptor,
} from '../src/activities/media/controller.js';
import {
  ActivityMediaService,
  ACTIVITY_MEDIA_RUNTIME,
} from '../src/activities/media/facade.js';
import { ActivityMediaRequestGuard } from '../src/activities/media/request-guard.js';
export async function createActivityPublicationOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of [
    'command',
    'draft',
    'organizers',
    'list',
    'mine',
    'detail',
    'recover',
    'cancel',
  ])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        ActivityPublicationController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [ActivityPublicationController, ActivityMediaController],
    providers: [
      {
        provide: ActivityMediaService,
        useValue: {
          runtime: null,
          prepare: fail,
          recover: fail,
          status: fail,
          cancelRequest: fail,
          cancel: fail,
          grant: fail,
          finalize: fail,
          observed: fail,
          descriptor: fail,
          open: fail,
        },
      },
      { provide: ACTIVITY_MEDIA_RUNTIME, useValue: null },
      ActivityMultipartInterceptor,
      {
        provide: ActivityPublicationService,
        useValue: {
          command: fail,
          draft: fail,
          organizers: fail,
          list: fail,
          mine: fail,
          detail: fail,
          recover: fail,
          cancel: fail,
        },
      },
    ],
  })
    .overrideGuard(ActivityMediaRequestGuard)
    .useValue({ canActivate: fail })
    .overrideGuard(ActivityPublicationRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU native activity publication')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token; publication requires an approved home-school organization and an actual target owner/admin grant.',
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
export async function renderActivityPublicationOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createActivityPublicationOpenApiDocument()),
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
export async function writeActivityPublicationOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/activity-publication.json',
      import.meta.url,
    ),
    rendered = await renderActivityPublicationOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Activity publication OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Activity publication OpenAPI artifact is current.'
      : 'Generated docs/openapi/activity-publication.json.',
  );
}
