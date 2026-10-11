import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import {
  OwnStudentVerificationController,
  StudentVerificationReviewController,
} from '../src/verification/student/controller.js';
import { StudentVerificationService } from '../src/verification/student/service.js';
import {
  VerificationEvidenceMediaController,
  VerificationEvidenceMultipartInterceptor,
} from '../src/verification/evidence/controller.js';
import {
  VerificationEvidenceMediaService,
  VERIFICATION_EVIDENCE_MEDIA_RUNTIME,
} from '../src/verification/evidence/facade.js';
import { VerificationEvidenceMediaRequestGuard } from '../src/verification/evidence/request-guard.js';
export async function createStudentVerificationOpenApiDocument(): Promise<OpenAPIObject> {
  for (const method of [
    'own',
    'reserve',
    'submit',
    'withdraw',
    'recover',
    'cancelRequest',
  ])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        OwnStudentVerificationController.prototype,
        method,
      )
    )
      throw new Error('OpenAPI requires emitted TypeScript decorator metadata');
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [
      OwnStudentVerificationController,
      StudentVerificationReviewController,
      VerificationEvidenceMediaController,
    ],
    providers: [
      {
        provide: StudentVerificationService,
        useValue: {
          own: fail,
          reserve: fail,
          submit: fail,
          withdraw: fail,
          recover: fail,
          cancelRequest: fail,
          detail: fail,
          queue: fail,
          decide: fail,
          capabilities: fail,
          noticeList: fail,
          noticeTarget: fail,
        },
      },
      {
        provide: VerificationEvidenceMediaService,
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
      { provide: VERIFICATION_EVIDENCE_MEDIA_RUNTIME, useValue: null },
      VerificationEvidenceMultipartInterceptor,
    ],
  })
    .overrideGuard(VerificationEvidenceMediaRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU private student document verification')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current owner or exact scoped school reviewer session. Material is private.',
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
export async function renderStudentVerificationOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(
      sorted(await createStudentVerificationOpenApiDocument()),
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
export async function writeStudentVerificationOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/student-verification.json',
      import.meta.url,
    ),
    rendered = await renderStudentVerificationOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Student verification OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Student verification OpenAPI artifact is current.'
      : 'Generated docs/openapi/student-verification.json.',
  );
}
