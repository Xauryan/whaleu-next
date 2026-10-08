import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Controller, Get, HttpException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { configureHttp } from '../src/http/http.js';
import {
  safeErrorResponseSchema,
  titleMaintenanceContinuationErrorSchema,
} from '../src/http/error-contracts.js';
import {
  ApplicationError,
  TitleMaintenanceContinuationConflict,
} from '../src/http/application-error.js';

@Controller('test-only')
class ErrorController {
  @Get('maintenance-continuation')
  maintenanceContinuation(): never {
    throw new TitleMaintenanceContinuationConflict(
      '00000000-0000-4000-8000-000000000123',
    );
  }
  @Get('fake-maintenance-detail')
  fakeMaintenanceDetail(): never {
    throw Object.assign(
      new ApplicationError('EXPERIENCE_MAINTENANCE_REQUEST_CONFLICT'),
      {
        successorRequestId: 'private-untrusted-value',
      },
    );
  }
  @Get('crash')
  crash(): never {
    throw new Error('private-password-in-stack');
  }
  @Get('bad-request')
  badRequest(): never {
    throw new HttpException('private submitted value', 400);
  }
  @Get('phone')
  phone(): never {
    throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
  }
  @Get('moderation')
  moderation(): never {
    throw new ApplicationError('CONTENT_REVIEW_REJECTED');
  }
}

let app: INestApplication;
let databaseReady = true;

test('maintenance recovery metadata is allowlisted to its exact typed exception', async () => {
  const result = await request(app.getHttpServer())
    .get('/test-only/maintenance-continuation')
    .expect(409);
  const resultBody = titleMaintenanceContinuationErrorSchema.parse(result.body);
  assert.equal(safeErrorResponseSchema.safeParse(result.body).success, false);
  assert.deepEqual(
    Object.keys(resultBody.error).sort(),
    ['code', 'message', 'requestId', 'successorRequestId'].sort(),
  );
  assert.equal(
    resultBody.error['successorRequestId'],
    '00000000-0000-4000-8000-000000000123',
  );
  const unrelated = await request(app.getHttpServer())
    .get('/test-only/fake-maintenance-detail')
    .expect(409);
  const unrelatedBody = safeErrorResponseSchema.parse(unrelated.body);
  assert.equal(
    titleMaintenanceContinuationErrorSchema.safeParse(unrelated.body).success,
    false,
  );
  assert.equal('successorRequestId' in unrelatedBody.error, false);
  assert.equal(
    JSON.stringify(unrelated.body).includes('private-untrusted-value'),
    false,
  );
  assert.throws(
    () => new TitleMaintenanceContinuationConflict('private-bad-reference'),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'EXPERIENCE_MAINTENANCE_UNAVAILABLE',
  );
});

before(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test:test@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
  });
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
    controllers: [ErrorController],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ready: async () => databaseReady })
    .compile();
  app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
});

after(async () => {
  await app?.close();
});

test('liveness and readiness succeed with safe headers and generated request IDs', async () => {
  const live = await request(app.getHttpServer())
    .get('/health/live')
    .set('x-request-id', 'untrusted-id')
    .expect(200);
  assert.deepEqual(live.body, { status: 'ok' });
  assert.match(String(live.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  assert.equal(live.headers['x-content-type-options'], 'nosniff');
  assert.equal(live.headers['cache-control'], 'no-store');
  await request(app.getHttpServer()).get('/health/ready').expect(200);
});

test('database failure affects readiness without killing liveness', async () => {
  databaseReady = false;
  try {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      'NOT_READY',
    );
    await request(app.getHttpServer()).get('/health/live').expect(200);
  } finally {
    databaseReady = true;
  }
});

test('unknown paths and exception bodies never leak request values or exception details', async () => {
  for (const [path, status] of [
    ['/private-token-url?secret=private-value', 404],
    ['/test-only/crash', 500],
    ['/test-only/bad-request', 400],
  ] as const) {
    const response = await request(app.getHttpServer())
      .get(path)
      .expect(status);
    assert.ok(!JSON.stringify(response.body).includes('private'));
    const body = safeErrorResponseSchema.parse(response.body);
    assert.equal(body.error.requestId, response.headers['x-request-id']);
  }
});

test('business conditions remain distinct with safe messages', async () => {
  const phone = await request(app.getHttpServer())
    .get('/test-only/phone')
    .expect(403);
  const moderation = await request(app.getHttpServer())
    .get('/test-only/moderation')
    .expect(422);
  assert.equal(
    safeErrorResponseSchema.parse(phone.body).error.code,
    'PHONE_VERIFICATION_REQUIRED',
  );
  assert.equal(
    safeErrorResponseSchema.parse(moderation.body).error.code,
    'CONTENT_REVIEW_REJECTED',
  );
});

test('parser failures retain request IDs and map to safe 400/413/415 responses', async () => {
  const requests = [
    { contentType: 'application/json', body: '{broken', status: 400 },
    {
      contentType: 'application/json',
      body: JSON.stringify({ text: 'x'.repeat(65536) }),
      status: 413,
    },
    {
      contentType: 'application/json; charset=unsupported',
      body: '{}',
      status: 415,
    },
  ];
  for (const operation of requests) {
    const response = await request(app.getHttpServer())
      .post('/test-only')
      .set('Content-Type', operation.contentType)
      .send(operation.body)
      .expect(operation.status);
    const body = safeErrorResponseSchema.parse(response.body);
    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(body.error.requestId, response.headers['x-request-id']);
    assert.ok(!JSON.stringify(response.body).includes('broken'));
  }
});

test('ordinary and maintenance safe-error contracts reject extra or misplaced recovery data', () => {
  const ordinary = {
    error: {
      code: 'BAD_REQUEST',
      message: 'Invalid request',
      requestId: 'request-id',
    },
  };
  assert.equal(safeErrorResponseSchema.safeParse(ordinary).success, true);
  for (const value of [
    { ...ordinary, extra: true },
    { error: { ...ordinary.error, extra: true } },
    {
      error: {
        ...ordinary.error,
        successorRequestId: '00000000-0000-4000-8000-000000000123',
      },
    },
    { error: { code: 'BAD_REQUEST', message: 'Invalid request' } },
  ])
    assert.equal(safeErrorResponseSchema.safeParse(value).success, false);
  assert.equal(
    titleMaintenanceContinuationErrorSchema.safeParse({
      error: {
        ...ordinary.error,
        successorRequestId: '00000000-0000-4000-8000-000000000123',
      },
    }).success,
    false,
  );
});
