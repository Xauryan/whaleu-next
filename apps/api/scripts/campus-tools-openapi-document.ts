import 'reflect-metadata';
import { readFile, writeFile } from 'node:fs/promises';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { CampusToolsController } from '../src/campus-tools/controller.js';
import { CampusToolsService } from '../src/campus-tools/service.js';
import { CampusToolsMediaController } from '../src/campus-tools/media/controller.js';
import { CampusToolsMediaService } from '../src/campus-tools/media/service.js';
import { CampusToolsRequestGuard } from '../src/campus-tools/request-guard.js';

export async function createCampusToolsOpenApiDocument(): Promise<OpenAPIObject> {
  for (const [controller, methods] of [
    [CampusToolsController, ['hub', 'detail', 'link']],
    [CampusToolsMediaController, ['descriptor', 'open']],
  ] as const)
    for (const method of methods)
      if (
        !Reflect.hasMetadata(PARAMTYPES_METADATA, controller.prototype, method)
      )
        throw new Error(
          'OpenAPI requires emitted TypeScript decorator metadata',
        );
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [CampusToolsController, CampusToolsMediaController],
    providers: [
      {
        provide: CampusToolsService,
        useValue: { hub: fail, detail: fail, link: fail },
      },
      {
        provide: CampusToolsMediaService,
        useValue: { descriptor: fail, open: fail },
      },
    ],
  })
    .overrideGuard(CampusToolsRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU accepted campus tools')
        .setDescription(
          'Current accepted physical-campus catalogs, exact catalog-bound details and copy/webview actions, and dedicated immutable Media reads. Missing evidence is distinct from known-empty and not-applicable. Production source, location, and embedded-platform activation remain separate gates; no historical source is seeded.',
        )
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Optional current opaque WhaleU access token. Public guest reads are allowed, but a supplied invalid, expired, revoked, or restricted credential never silently downgrades to guest. Campus selection grants no affiliation, UID, or administrative authority.',
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
export async function renderCampusToolsOpenApiDocument(): Promise<string> {
  return format(
    JSON.stringify(sorted(await createCampusToolsOpenApiDocument()), null, 2),
    {
      parser: 'json',
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      endOfLine: 'lf',
    },
  );
}
export async function writeCampusToolsOpenApi(check: boolean) {
  const artifact = new URL(
      '../../../../docs/openapi/campus-tools.json',
      import.meta.url,
    ),
    rendered = await renderCampusToolsOpenApiDocument();
  if (check) {
    if ((await readFile(artifact, 'utf8')) !== rendered)
      throw new Error(
        'Campus tools OpenAPI artifact is stale; run npm run openapi:generate.',
      );
  } else await writeFile(artifact, rendered, 'utf8');
  console.log(
    check
      ? 'Campus tools OpenAPI artifact is current.'
      : 'Generated docs/openapi/campus-tools.json.',
  );
}
