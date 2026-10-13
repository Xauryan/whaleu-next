import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Controller,
  Get,
  Module,
  Post,
  HttpCode,
  Header,
  Param,
  UseGuards,
  UseInterceptors,
  Version,
  SetMetadata,
  applyDecorators,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { accountRoutePolicies } from '../src/safety/account-policy/routes.js';
import {
  assertAccountRouteManifest,
  registeredAccountRoutes,
} from '../src/safety/account-policy/runtime-inventory.js';

test('actual AppModule Nest route metadata equals the semantic inventory in both directions', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
  });
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(DatabaseService)
    .useValue({
      ready: async () => true,
      query: () => {
        throw new Error('Route inventory must not query database');
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.init();
    const routes = assertAccountRouteManifest(
      app.get(ModulesContainer),
      accountRoutePolicies,
    );
    assert.ok(
      routes.some((r) => r.handler === 'RatingScopedController.context'),
    );
    assert.ok(
      routes.some(
        (r) => r.handler === 'RatingCategoryScopedManagementController.context',
      ),
    );
    assert.ok(
      routes.some(
        (r) => r.handler === 'RatingCategoryIconManagementController.prepare',
      ),
    );
  } finally {
    await app.close();
  }
});

const dynamic = (path: string) => applyDecorators(Post(path));
const alias = Get;
class ParentController {
  @alias('inherited') inherited() {}
}
@Controller('factory')
class FactoryController extends ParentController {
  @dynamic('generated') generated() {}
}
@Module({ controllers: [FactoryController] })
class FixtureModule {}
test('effective metadata catches inherited, aliased and factory decorators, omissions and duplicates', async () => {
  const module = await Test.createTestingModule({
    imports: [FixtureModule],
  }).compile();
  try {
    const modules = module.get(ModulesContainer),
      routes = registeredAccountRoutes(modules);
    assert.deepEqual(routes.map((r) => r.path).sort(), [
      '/factory/generated',
      '/factory/inherited',
    ]);
    const policy = routes.map(
      (r) =>
        [r.handler, r.method, r.path, 'browse', 'entry', 'fixture.ts'] as const,
    );
    assert.doesNotThrow(() => assertAccountRouteManifest(modules, policy));
    assert.throws(
      () => assertAccountRouteManifest(modules, policy.slice(1)),
      /missing=/,
    );
    assert.throws(
      () => assertAccountRouteManifest(modules, [...policy, policy[0]!]),
      /Duplicate semantic/,
    );
    assert.throws(
      () =>
        assertAccountRouteManifest(modules, [
          ...policy,
          [
            'Unknown.method',
            'GET',
            '/unknown',
            'browse',
            'entry',
            'fixture.ts',
          ],
        ]),
      /stale=/,
    );
  } finally {
    await module.close();
  }
});

// Use real semantic handler identities to exercise the production interceptor,
// including a wrapper applied after Nest's route decorator and inherited slots.
import request from 'supertest';
import { ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AccountPolicy } from '../src/safety/account-policy/decorator.js';
import { AccountPolicyInterceptor } from '../src/safety/account-policy/interceptor.js';
import { IdentityService } from '../src/identity/identity.service.js';
class WrappedHealthBase {
  @AccountPolicy('guest', 'restricted')
  @Post('ready')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'wrappedReady' })
  ready() {
    return { status: 'ok' };
  }
}
@Controller('health')
class HealthController extends WrappedHealthBase {
  @AccountPolicy('guest', 'restricted')
  @Get('live')
  live() {
    return { status: 'ok' };
  }
}
test('production HTTP policy dispatch resolves wrapped and inherited handlers by property identity', async () => {
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: DatabaseService, useValue: {} },
      { provide: IdentityService, useValue: {} },
      { provide: APP_INTERCEPTOR, useClass: AccountPolicyInterceptor },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.init();
    const responses = [
      await request(app.getHttpServer()).get('/health/live'),
      await request(app.getHttpServer()).post('/health/ready'),
    ];
    for (const response of responses) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body, { status: 'ok' });
    }
    assert.equal(responses[1]!.headers['cache-control'], 'no-store');
    assert.equal(
      Reflect.getMetadata(
        'swagger/apiOperation',
        WrappedHealthBase.prototype.ready,
      ).operationId,
      'wrappedReady',
    );
  } finally {
    await app.close();
  }
});

class MetadataGuard {
  canActivate() {
    return false;
  }
}
class MetadataInterceptor {
  intercept(_context: unknown, next: { handle(): unknown }) {
    return next.handle();
  }
}
@Controller('metadata')
class MetadataController {
  @Get(':id')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(MetadataGuard)
  @UseInterceptors(MetadataInterceptor)
  @Version('1')
  @SetMetadata('auth', 'original-session-only')
  @ApiBearerAuth('accessToken')
  @ApiOperation({ operationId: 'metadataRecovery' })
  recovery(@Param('id') id: string) {
    return { id };
  }
}
test('method policy wrapping preserves each route, auth, guard, interceptor, parameter and Swagger metadata exactly once', () => {
  const target = MetadataController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(target, 'recovery')!;
  const original = descriptor.value as typeof target.recovery;
  const before = Reflect.getOwnMetadataKeys(original).map((key) => [
    key,
    Reflect.getOwnMetadata(key, original),
  ]);
  const parameters = Reflect.getOwnMetadataKeys(
    MetadataController,
    'recovery',
  ).map((key) => [
    key,
    Reflect.getOwnMetadata(key, MetadataController, 'recovery'),
  ]);
  AccountPolicy('restricted_self_service', 'restricted')(
    target,
    'recovery',
    descriptor,
  );
  Object.defineProperty(target, 'recovery', descriptor);
  const wrapped = target.recovery;
  assert.notEqual(wrapped, original);
  assert.deepEqual(
    Reflect.getOwnMetadataKeys(wrapped).map((key) => [
      key,
      Reflect.getOwnMetadata(key, wrapped),
    ]),
    before,
  );
  assert.deepEqual(
    Reflect.getOwnMetadataKeys(MetadataController, 'recovery').map((key) => [
      key,
      Reflect.getOwnMetadata(key, MetadataController, 'recovery'),
    ]),
    parameters,
  );
  assert.equal(Reflect.getOwnMetadata('__guards__', wrapped).length, 1);
  assert.equal(Reflect.getOwnMetadata('__interceptors__', wrapped).length, 1);
  assert.deepEqual(wrapped.call(new MetadataController(), 'owned'), {
    id: 'owned',
  });
});
