import 'reflect-metadata';
import { format } from 'prettier';
import { Test } from '@nestjs/testing';
import { PARAMTYPES_METADATA } from '@nestjs/common/constants.js';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ViewReportingController } from '../src/community/view-component/controller.js';
import { ViewReportingService } from '../src/community/view-component/service.js';
import { ViewReportingRequestGuard } from '../src/request-throttling/view-request.guard.js';

/** Tooling-only graph: no application bootstrap, database, timers, or HTTP server. */
export async function createViewOpenApiDocument(): Promise<OpenAPIObject> {
  // Swagger discovers body schemas through emitted parameter metadata. tsx alone
  // omits it; fail rather than silently publish operations without request bodies.
  for (const method of ['epoch', 'report']) {
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        ViewReportingController.prototype,
        method,
      )
    ) {
      throw new Error(
        'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
      );
    }
  }
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [ViewReportingController],
    providers: [
      {
        provide: ViewReportingService,
        useValue: { issueEpoch: fail, report: fail },
      },
    ],
  })
    .overrideGuard(ViewReportingRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU view reporting')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description: 'Opaque WhaleU access token.',
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
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sorted(item)]),
    );
  }
  return value;
}

/** Stable key ordering followed by the installed repository formatter. Keep
 * emitted bytes valid under both OpenAPI drift checks and format:check. JSON
 * formatting has no runtime dependency or effect on the document's semantics. */
async function renderDocument(document: OpenAPIObject): Promise<string> {
  return format(JSON.stringify(sorted(document), null, 2), {
    parser: 'json',
    printWidth: 80,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
  });
}
export async function renderViewOpenApiDocument(): Promise<string> {
  return renderDocument(await createViewOpenApiDocument());
}

/** Separate owner document; the view-reporting runtime contract is unchanged. */
export async function createDirectoryOpenApiDocument(): Promise<OpenAPIObject> {
  const { DirectoryController } =
    await import('../src/organizations/directory/controller.js');
  const { DirectoryService } =
    await import('../src/organizations/directory/service.js');
  const { DirectoryRequestGuard } =
    await import('../src/request-throttling/directory-request.guard.js');
  for (const method of ['context', 'categories', 'entries', 'detail']) {
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        DirectoryController.prototype,
        method,
      )
    )
      throw new Error(
        'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
      );
  }
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [DirectoryController],
    providers: [
      {
        provide: DirectoryService,
        useValue: {
          context: fail,
          categories: fail,
          entries: fail,
          detail: fail,
        },
      },
    ],
  })
    .overrideGuard(DirectoryRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU organization directory')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description: 'Opaque WhaleU access token.',
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
export async function renderDirectoryOpenApiDocument(): Promise<string> {
  return renderDocument(await createDirectoryOpenApiDocument());
}

/** Tooling-only hot contract export: no components, runner or database graph. */
export async function createHotOpenApiDocument(): Promise<OpenAPIObject> {
  const { HotController } = await import('../src/community/hot/controller.js');
  const { HotFeedService } = await import('../src/community/hot/service.js');
  if (
    !Reflect.hasMetadata(PARAMTYPES_METADATA, HotController.prototype, 'read')
  )
    throw new Error(
      'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
    );
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [HotController],
    providers: [{ provide: HotFeedService, useValue: { read: fail } }],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU unified public hot feed')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Opaque WhaleU access token. Optional for first page only.',
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
export async function renderHotOpenApiDocument(): Promise<string> {
  return renderDocument(await createHotOpenApiDocument());
}
