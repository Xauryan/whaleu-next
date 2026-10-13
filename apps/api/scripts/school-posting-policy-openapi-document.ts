import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { SchoolPostingPolicyController } from '../src/school-posting-policy/controller.js';
import { SchoolPostingPolicyService } from '../src/school-posting-policy/service.js';
import { SchoolPostingPolicyRequestGuard } from '../src/school-posting-policy/request-guard.js';
export async function createSchoolPostingPolicyOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of ['read', 'save', 'recover', 'cancel'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        SchoolPostingPolicyController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [SchoolPostingPolicyController],
    providers: [
      {
        provide: SchoolPostingPolicyService,
        useValue: { management: fail, save: fail, recover: fail, cancel: fail },
      },
    ],
  })
    .overrideGuard(SchoolPostingPolicyRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU school posting policy')
        .setDescription(
          'Unversioned settings commands retain their original strict policy and hashes. Version 2 explicitly includes policy.relatedSyncEnabled and atomically saves the related-sync control with the existing posting policy under one revision CAS. Management may expose the current relatedSyncEnabled value; old writers cannot silently downgrade an enabled v2 policy and receive related_sync_unsupported. The setting governs new publication admission, not the current distribution of an existing canonical related-sync post. Recovery and cancellation preserve the original key and hash.',
        )
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
export async function renderSchoolPostingPolicyOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createSchoolPostingPolicyOpenApiDocument()),
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
export async function writeSchoolPostingPolicyOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/school-posting-policy.json',
      import.meta.url,
    ),
    rendered = await renderSchoolPostingPolicyOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'School posting policy OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'School posting policy OpenAPI artifact is current.'
      : 'Generated docs/openapi/school-posting-policy.json.',
  );
}
