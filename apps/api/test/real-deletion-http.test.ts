import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { configureHttp } from '../src/http/http.js';
import { IdentityRateLimiter } from '../src/identity/rate-limit.js';
import { RealDeletionService } from '../src/account-deletion/real/service.js';
import {
  REAL_DELETION_CONSENT,
  REAL_DELETION_PROTOCOL,
} from '../src/account-deletion/real/contracts.js';
const command = {
  version: 1,
  intentId: '10000000-0000-4000-8000-000000000001',
  expectedGeneration: '0',
  consent: REAL_DELETION_CONSENT,
  recoverySecret: 'wu_dr_' + Buffer.alloc(32, 17).toString('base64url'),
};
const response = {
  protocol: REAL_DELETION_PROTOCOL,
  intentId: command.intentId,
  phase: 'prepared',
  revision: '0',
  preparedAt: '2026-01-01T00:00:00.000Z',
  preparationExpiresAt: '2026-01-01T00:15:00.000Z',
  acceptedAt: null,
  cancelBefore: null,
  completedAt: null,
};
const base = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
  WECHAT_APP_ID: 'wx0123456789abcdef',
  WECHAT_APP_SECRET: 'synthetic-provider-secret-for-unit-tests-only',
  AUTH_RATE_LIMIT_KEY: '01'.repeat(32),
};

test('real production AppModule exposes disabled deletion routes without database/risk writes', async () => {
  let riskCalls = 0;
  const module = await Test.createTestingModule({
    imports: [AppModule.register(loadConfig(base))],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ready: async () => true })
    .overrideProvider(IdentityRateLimiter)
    .useValue({
      consume: async () => {
        riskCalls++;
      },
    })
    .compile();
  const app = module.createNestApplication();
  configureHttp(app);
  await app.init();
  try {
    const result = await request(app.getHttpServer())
      .post('/v1/account-deletion/prepare')
      .send(command)
      .expect(503);
    assert.equal(result.body.error.code, 'REAL_DELETION_UNAVAILABLE');
    assert.equal(riskCalls, 0);
    assert(!JSON.stringify(result.body).includes(command.recoverySecret));
  } finally {
    await app.close();
  }
});
test('HTTP composition keeps recovery separate from bearer, strict body and private receipt', async () => {
  const calls: string[] = [];
  let captured: unknown;
  const config = loadConfig({
    ...base,
    REAL_ACCOUNT_DELETION_ENTRY: 'prepare_only',
  });
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config)],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ready: async () => true })
    .overrideProvider(IdentityRateLimiter)
    .useValue({
      consume: async (op: string) => {
        calls.push(op);
      },
    })
    .overrideProvider(RealDeletionService)
    .useValue({
      prepare: async (token: string, body: unknown) => {
        assert.match(token, /^wu_a_/);
        captured = body;
        return response;
      },
      status: async (body: unknown) => {
        captured = body;
        return response;
      },
    })
    .compile();
  const app = module.createNestApplication();
  configureHttp(app);
  await app.init();
  try {
    const access = 'wu_a_' + Buffer.alloc(32, 34).toString('base64url');
    const prepared = await request(app.getHttpServer())
      .post('/v1/account-deletion/prepare')
      .set('Authorization', 'Bearer ' + access)
      .send(command)
      .expect(200);
    assert.deepEqual(captured, command);
    assert.equal(prepared.headers['cache-control'], 'private, no-store');
    assert.deepEqual(prepared.body, response);
    const recovered = await request(app.getHttpServer())
      .post('/v1/account-deletion/status')
      .send({
        intentId: command.intentId,
        recoverySecret: command.recoverySecret,
      })
      .expect(200);
    assert.deepEqual(recovered.body, response);
    const bad = await request(app.getHttpServer())
      .post('/v1/account-deletion/prepare')
      .set('Authorization', 'Bearer ' + access)
      .send({ ...command, accountId: command.intentId })
      .expect(400);
    assert(!JSON.stringify(bad.body).includes(command.recoverySecret));
    await request(app.getHttpServer())
      .post('/v1/account-deletion/prepare')
      .set('Authorization', 'Bearer ' + command.recoverySecret)
      .send(command)
      .expect(401);
    assert.deepEqual(calls, [
      'deletion-prepare',
      'deletion-status',
      'deletion-prepare',
    ]);
  } finally {
    await app.close();
  }
});
