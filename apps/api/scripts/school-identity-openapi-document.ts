import { SchoolUidController } from '../src/school-uid/controller.js';
import { SchoolUidService } from '../src/school-uid/service.js';
import { PublicProfileController } from '../src/profile-discovery/controller.js';
import { ProfileDiscoveryService } from '../src/profile-discovery/service.js';
import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  SchoolIdentityController,
  SchoolUidLookupController,
} from '../src/school-identity/controller.js';
import { SchoolIdentityService } from '../src/school-identity/service.js';
export async function createSchoolIdentityOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['management', 'command', 'recovery', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        SchoolIdentityController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [
      SchoolIdentityController,
      SchoolUidLookupController,
      SchoolUidController,
      PublicProfileController,
    ],
    providers: [
      { provide: SchoolUidService, useValue: { own: fail } },
      {
        provide: ProfileDiscoveryService,
        useValue: { profile: fail, list: fail },
      },
      {
        provide: SchoolIdentityService,
        useValue: {
          management: fail,
          lookup: fail,
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
        .setTitle('WhaleU school identity and UID management')
        .setDescription(
          'Current accepted school UID projection and strict global-super lookup. Explicit verified-school correction allocates a fresh destination UID, preserving old reservations and finite expiry. Original-key cancellation/recovery is actor-owned. Unknown historical inventory remains unavailable. No real inventory or provider activation.',
        )
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token. Management and new commands require a current super_admin grant, independently of a developer display label. Recovery and cancellation belong to the original actor.',
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
export async function renderSchoolIdentityOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createSchoolIdentityOpenApiDocument()),
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
export async function writeSchoolIdentityOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/school-identity.json',
      import.meta.url,
    ),
    rendered = await renderSchoolIdentityOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'School identity and UID management OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'School identity and UID management OpenAPI artifact is current.'
      : 'Generated docs/openapi/school-identity.json.',
  );
}
