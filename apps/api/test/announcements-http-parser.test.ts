import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { configureHttp } from '../src/http/http.js';
test('announcement parser errors retain no-store and optional-auth Vary before guards', async () => {
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
      query: () => {
        throw new Error('Parser failures must not reach database');
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
  try {
    for (const path of [
      '/v1/announcements',
      '/v1/announcements/changes',
      '/v1/me/announcements/popup',
    ]) {
      for (const [body, contentType, status] of [
        ['{bad', 'application/json', 400],
        ['{}', 'application/json; charset=bogus', 415],
        [
          JSON.stringify({ private: 'x'.repeat(70000) }),
          'application/json',
          413,
        ],
      ] as const) {
        const response = await request(app.getHttpServer())
          .get(path)
          .set('Content-Type', contentType)
          .send(body)
          .expect(status);
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['vary'], 'Authorization');
        assert.equal(JSON.stringify(response.body).includes('private'), false);
      }
    }
  } finally {
    await app.close();
  }
});
