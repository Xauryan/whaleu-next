import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { loadConfig } from '../src/config/config.js';
import { configureHttp } from '../src/http/http.js';
import { mintToken } from '../src/identity/tokens.js';
import { FeedbackNoticesController } from '../src/notifications/feedback/controller.js';
import { FeedbackNoticesService } from '../src/notifications/feedback/service.js';
import { AppLogger } from '../src/observability/logger.js';

test('feedback notices HTTP is no-store, owner-authenticated, exact-target-only and rejects unknown/repeated data', async () => {
  const calls: unknown[][] = [];
  const now = '2026-10-11T12:00:00.000Z';
  const service = {
    list: async (...args: unknown[]) => {
      calls.push(['list', ...args]);
      return { items: [], nextCursor: null, unreadCount: 0 };
    },
    unreadCount: async (...args: unknown[]) => {
      calls.push(['count', ...args]);
      return { unreadCount: 0 };
    },
    target: async (...args: unknown[]) => {
      calls.push(['target', ...args]);
      return { noticeId: args[1], status: 'unavailable' };
    },
    markRead: async (...args: unknown[]) => {
      calls.push(['read', ...args]);
      return { noticeId: args[1], readAt: now, unreadCount: 0 };
    },
  };
  const logger = new AppLogger(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://local:local@127.0.0.1/whaleu_test',
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
    }),
  );
  const module = await Test.createTestingModule({
    controllers: [FeedbackNoticesController],
    providers: [
      { provide: FeedbackNoticesService, useValue: service },
      { provide: AppLogger, useValue: logger },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
  try {
    const base = '/v1/me/feedback-notices',
      token = mintToken('access'),
      auth = `Bearer ${token}`,
      id = randomUUID();
    const first = await request(app.getHttpServer())
      .get(base)
      .set('authorization', auth)
      .expect(200);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.match(String(first.headers['vary']), /Authorization/);
    assert.deepEqual(calls.pop(), ['list', token, { limit: 20 }]);
    await request(app.getHttpServer())
      .get(`${base}/unread-count`)
      .set('authorization', auth)
      .expect(200);
    assert.deepEqual(calls.pop(), ['count', token]);
    const target = await request(app.getHttpServer())
      .get(`${base}/${id}/target`)
      .set('authorization', auth)
      .expect(200);
    assert.deepEqual(target.body, { noticeId: id, status: 'unavailable' });
    assert.deepEqual(calls.pop(), ['target', token, id]);
    await request(app.getHttpServer())
      .put(`${base}/${id}/read`)
      .set('authorization', auth)
      .send({})
      .expect(200);
    assert.deepEqual(calls.pop(), ['read', token, id]);
    await request(app.getHttpServer()).get(base).expect(401);
    for (const path of [
      '?limit=1&limit=2',
      '?cursor=a&cursor=b',
      '?limit=51',
      `?recipientAccountId=${id}`,
      '/unread-count?all=true',
      `/${id}/target?postId=${id}`,
      '/bad-id/target',
    ]) {
      await request(app.getHttpServer())
        .get(base + path)
        .set('authorization', auth)
        .expect(400);
    }
    for (const body of [
      { all: true },
      { read: false },
      { postId: id },
      { recipientAccountId: id },
      { noticeIds: [id] },
    ]) {
      await request(app.getHttpServer())
        .put(`${base}/${id}/read`)
        .set('authorization', auth)
        .send(body)
        .expect(400);
    }
    await request(app.getHttpServer())
      .put(`${base}/${id}/read?all=true`)
      .set('authorization', auth)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .put(`${base}/read-all`)
      .set('authorization', auth)
      .send({})
      .expect(404);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});
