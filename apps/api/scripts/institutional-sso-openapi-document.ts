import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { InstitutionalSsoController } from '../src/verification/institutional/controller.js';
import { InstitutionalSsoService } from '../src/verification/institutional/service.js';

export async function createInstitutionalSsoOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['capability', 'prepare', 'read', 'complete', 'close'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        InstitutionalSsoController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [InstitutionalSsoController],
    providers: [
      {
        provide: InstitutionalSsoService,
        useValue: {
          capability: fail,
          prepare: fail,
          read: fail,
          complete: fail,
          close: fail,
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
        .setTitle('WhaleU private institutional verification')
        .setDescription(
          'Actor-owned original institutional verification requests, one-use opaque response admission, independent facts and distinct UID outcomes. The shipping institutional provider/native binding is unavailable; synthetic composition does not activate a real provider.',
        )
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token. Status and cancellation remain restricted self-service; new issuance requires current private self-service authority. Campus selection never authenticates affiliation.',
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
export async function renderInstitutionalSsoOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createInstitutionalSsoOpenApiDocument()),
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
export async function writeInstitutionalSsoOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/institutional-sso.json',
      import.meta.url,
    ),
    rendered = await renderInstitutionalSsoOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Institutional SSO OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Institutional SSO OpenAPI artifact is current.'
      : 'Generated docs/openapi/institutional-sso.json.',
  );
}
