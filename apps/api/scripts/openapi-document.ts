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

/** Offline-only announcement contract export, using the official controllers. */
export async function createAnnouncementsOpenApiDocument(): Promise<OpenAPIObject> {
  const { AnnouncementsController, OwnAnnouncementsController } =
    await import('../src/announcements/controller.js');
  const { AnnouncementsService } =
    await import('../src/announcements/service.js');
  const { AnnouncementRequestGuard } =
    await import('../src/request-throttling/announcement-request.guard.js');
  for (const [controller, methods] of [
    [AnnouncementsController, ['list', 'popup', 'changes', 'detail']],
    [OwnAnnouncementsController, ['popup', 'acknowledge']],
  ] as const) {
    for (const method of methods)
      if (
        !Reflect.hasMetadata(PARAMTYPES_METADATA, controller.prototype, method)
      )
        throw new Error(
          'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
        );
  }
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [AnnouncementsController, OwnAnnouncementsController],
    providers: [
      {
        provide: AnnouncementsService,
        useValue: {
          list: fail,
          popup: fail,
          changes: fail,
          detail: fail,
          ownerPopup: fail,
          acknowledge: fail,
        },
      },
    ],
  })
    .overrideGuard(AnnouncementRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU announcements')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Opaque WhaleU access token. Optional for public content; required for own popup state and acknowledgement. Supplied invalid credentials fail.',
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
export async function renderAnnouncementsOpenApiDocument(): Promise<string> {
  return renderDocument(await createAnnouncementsOpenApiDocument());
}

/** Offline official controller/owner export; never starts application work. */
export async function createSearchOpenApiDocument(): Promise<OpenAPIObject> {
  const { SearchController } =
    await import('../src/community/search/controller.js');
  const { SearchService } = await import('../src/community/search/service.js');
  if (
    !Reflect.hasMetadata(
      PARAMTYPES_METADATA,
      SearchController.prototype,
      'search',
    )
  )
    throw new Error(
      'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
    );
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [SearchController],
    providers: [{ provide: SearchService, useValue: { search: fail } }],
  }).compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU community content search')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Opaque WhaleU access token. Optional for initial post preview only.',
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
export async function renderSearchOpenApiDocument(): Promise<string> {
  return renderDocument(await createSearchOpenApiDocument());
}

/** Tooling-only activity controllers. No application, database or provider work. */
export async function createActivitiesOpenApiDocument(): Promise<OpenAPIObject> {
  const { ActivitiesController } =
    await import('../src/activities/controller.js');
  const { ActivitiesService } = await import('../src/activities/service.js');
  const { ActivityRequestGuard } =
    await import('../src/request-throttling/activity-request.guard.js');
  for (const method of ['context', 'list', 'detail', 'visit'])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        ActivitiesController.prototype,
        method,
      )
    )
      throw new Error(
        'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
      );
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [ActivitiesController],
    providers: [
      {
        provide: ActivitiesService,
        useValue: { context: fail, list: fail, detail: fail, visit: fail },
      },
    ],
  })
    .overrideGuard(ActivityRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU activities')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque WhaleU access token required for every route.',
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
export async function renderActivitiesOpenApiDocument(): Promise<string> {
  return renderDocument(await createActivitiesOpenApiDocument());
}

/** Tooling-only errand controllers. Never execute application or provider work. */
export async function createErrandsOpenApiDocument(): Promise<OpenAPIObject> {
  const { ErrandAdminCommandController } =
    await import('../src/errands/admin-command-controller.js');
  const { ErrandAdminCommandService } =
    await import('../src/errands/admin-command-service.js');
  const { ErrandRestrictionService } =
    await import('../src/errands/restriction-service.js');
  const { ErrandAdminController } =
    await import('../src/errands/admin-controller.js');
  const { ErrandAdminService } =
    await import('../src/errands/admin-service.js');
  const { ErrandsController } = await import('../src/errands/controller.js');
  const { ErrandsService } = await import('../src/errands/service.js');
  const { ErrandNoticesController } =
    await import('../src/notifications/errand.module.js');
  const { ErrandNoticesService } =
    await import('../src/notifications/errand.service.js');
  const { ErrandRequestGuard } =
    await import('../src/request-throttling/errand-request.guard.js');
  for (const method of [
    'publish',
    'list',
    'own',
    'contacts',
    'receipt',
    'detail',
    'accept',
    'cancel',
    'complete',
    'delete',
  ])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        ErrandsController.prototype,
        method,
      )
    )
      throw new Error(
        'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
      );
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [
      ErrandsController,
      ErrandNoticesController,
      ErrandAdminController,
      ErrandAdminCommandController,
    ],
    providers: [
      { provide: ErrandsService, useValue: {} },
      { provide: ErrandAdminService, useValue: {} },
      { provide: ErrandAdminCommandService, useValue: {} },
      { provide: ErrandRestrictionService, useValue: {} },
      { provide: ErrandNoticesService, useValue: {} },
    ],
  })
    .overrideGuard(ErrandRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU text-only errands')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque owner session required. Receipts prove outcomes only; every fresh content/contact read reauthorizes.',
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
export async function renderErrandsOpenApiDocument(): Promise<string> {
  return renderDocument(await createErrandsOpenApiDocument());
}

/** Tooling-only rating routes. No live database, issuer or provider. */
export async function createRatingsOpenApiDocument(): Promise<OpenAPIObject> {
  const { RatingsController } = await import('../src/ratings/controller.js');
  const { RatingsService } = await import('../src/ratings/service.js');
  const { RatingDiscussionController } =
    await import('../src/ratings/discussion-controller.js');
  const { RatingDiscussionService } =
    await import('../src/ratings/discussion-service.js');
  const { RatingUpdatesController } =
    await import('../src/notifications/ratings/controller.js');
  const { RatingUpdatesReadService } =
    await import('../src/notifications/ratings/read.service.js');
  const { RatingRequestGuard } =
    await import('../src/request-throttling/rating-request.guard.js');
  for (const method of [
    'context',
    'categories',
    'targets',
    'target',
    'myScore',
    'summary',
    'comments',
    'comment',
    'receipt',
    'setScore',
    'createComment',
    'deleteComment',
  ])
    if (
      !Reflect.hasMetadata(
        PARAMTYPES_METADATA,
        RatingsController.prototype,
        method,
      )
    )
      throw new Error(
        'OpenAPI requires TypeScript decorator metadata; use npm run openapi:build.',
      );
  const fail = () => {
    throw new Error('OpenAPI must not execute application work');
  };
  const testing = await Test.createTestingModule({
    controllers: [
      RatingsController,
      RatingDiscussionController,
      RatingUpdatesController,
    ],
    providers: [
      { provide: RatingsService, useValue: {} },
      { provide: RatingDiscussionService, useValue: {} },
      { provide: RatingUpdatesReadService, useValue: {} },
    ],
  })
    .overrideGuard(RatingRequestGuard)
    .useValue({ canActivate: fail })
    .compile();
  const app = testing.createNestApplication({ logger: false });
  try {
    return SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setOpenAPIVersion('3.0.3')
        .setTitle('WhaleU ratings, text discussions and local direct updates')
        .setVersion('1')
        .addSecurity('accessToken', {
          type: 'http',
          scheme: 'bearer',
          description:
            'Current opaque owner session. Receipts never grant access to content.',
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
export async function renderRatingsOpenApiDocument(): Promise<string> {
  return renderDocument(await createRatingsOpenApiDocument());
}
