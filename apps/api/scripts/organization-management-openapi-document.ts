import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { OrganizationController } from '../src/organizations/management/controller.js';
import { OrganizationService } from '../src/organizations/management/service.js';
import { OrganizationRequestGuard } from '../src/organizations/management/request-guard.js';
import {
  OrganizationMediaController,
  OrganizationMultipartInterceptor,
} from '../src/organizations/media/controller.js';
import {
  OrganizationMediaService,
  ORGANIZATION_MEDIA_RUNTIME,
} from '../src/organizations/media/facade.js';
import { OrganizationMediaRequestGuard } from '../src/organizations/media/request-guard.js';
export async function createOrganizationManagementOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of [
    'create',
    'save',
    'review',
    'member',
    'detail',
    'recover',
    'cancel',
  ])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        OrganizationController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [OrganizationController, OrganizationMediaController],
    providers: [
      {
        provide: OrganizationMediaService,
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
      { provide: ORGANIZATION_MEDIA_RUNTIME, useValue: null },
      OrganizationMultipartInterceptor,
      {
        provide: OrganizationService,
        useValue: {
          create: fail,
          save: fail,
          review: fail,
          member: fail,
          detail: fail,
          recover: fail,
          cancel: fail,
        },
      },
    ],
  })
    .overrideGuard(OrganizationMediaRequestGuard)
    .useValue({ canActivate: fail })
    .overrideGuard(OrganizationRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU organization management')
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
export async function renderOrganizationManagementOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createOrganizationManagementOpenApiDocument()),
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
export async function writeOrganizationManagementOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/organization-management.json',
      import.meta.url,
    ),
    rendered = await renderOrganizationManagementOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Organization management OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Organization management OpenAPI artifact is current.'
      : 'Generated docs/openapi/organization-management.json.',
  );
}
