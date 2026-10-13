import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { SchoolAdminManagementController } from '../src/authorization/school-admin-management/controller.js';
import { SchoolAdminManagementService } from '../src/authorization/school-admin-management/service.js';
export async function createSchoolAdminManagementOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['management', 'command', 'recovery', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        SchoolAdminManagementController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [SchoolAdminManagementController],
    providers: [
      {
        provide: SchoolAdminManagementService,
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
        .setTitle('WhaleU school administrator management')
        .setDescription(
          'Strict current super-admin management of one existing public profile. Appointment requires accepted current school affiliation and reconciled linked-region inventory. Reassignment revokes the exact old fixed grant and issues a new immutable grant. role_admin is a retained optional cosmetic title and never authority or automatic appearance. Original-key recovery and cancellation require only the same active account and current presented session token. No global-role issuance, verification changes, provider identity, student-number lookup or notifications.',
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
export async function renderSchoolAdminManagementOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createSchoolAdminManagementOpenApiDocument()),
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
export async function writeSchoolAdminManagementOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/school-admin-management.json',
      import.meta.url,
    ),
    rendered = await renderSchoolAdminManagementOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'School administrator management OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'School administrator management OpenAPI artifact is current.'
      : 'Generated docs/openapi/school-admin-management.json.',
  );
}
