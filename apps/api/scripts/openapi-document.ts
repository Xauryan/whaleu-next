import 'reflect-metadata';
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

export async function renderViewOpenApiDocument(): Promise<string> {
  return `${JSON.stringify(sorted(await createViewOpenApiDocument()), null, 2)}\n`;
}
