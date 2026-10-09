import { ActivityRequestGuard } from '../src/request-throttling/activity-request.guard.js';
import { AnnouncementRequestGuard } from '../src/request-throttling/announcement-request.guard.js';
import { DirectoryRequestGuard } from '../src/request-throttling/directory-request.guard.js';
import { ErrandRequestGuard } from '../src/request-throttling/errand-request.guard.js';
import { RatingRequestGuard } from '../src/request-throttling/rating-request.guard.js';
import { SemanticSearchRequestGuard } from '../src/community/search/semantic/request-guard.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { configureHttp } from '../src/http/http.js';
import { searchHitSchema } from '../src/community/search/response-schema.js';
import {
  semanticSearchPageSchema,
  semanticSearchQuerySchema,
} from '../src/community/search/semantic/http-contracts.js';
import { createConfiguredSemanticProvider } from '../src/community/search/semantic/runtime.js';

const config = () =>
  loadConfig({
    DATABASE_URL: 'postgresql://dev:test@127.0.0.1:55432/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
  });
const id = '00000000-0000-4000-8000-000000000001';
const hit = {
  kind: 'post',
  contentId: id,
  postId: id,
  rootCommentId: null,
  replyId: null,
  space: { id, kind: 'regional', name: 'Synthetic' },
  category: 'discussion',
  tradingSubtype: null,
  tradingUrgency: null,
  createdAt: '2026-10-08T00:00:00.123456Z',
  author: {
    kind: 'anonymous',
    personaId: id,
    displayName: '匿名鲸鱼',
    avatar: null,
    isPostAuthor: true,
  },
  postSummary: '失物',
  snippet: {
    segments: [{ text: '耳机在服务台', matched: false }],
    truncatedBefore: false,
    truncatedAfter: false,
  },
  target: { kind: 'post', postId: id },
};

test('semantic response is separate and truthful; literal highlight contract is unchanged', () => {
  const page = {
    mode: 'semantic',
    indexStatus: 'current',
    ranking: 'embedding-top32-reranked',
    items: [hit],
  };
  assert.deepEqual(semanticSearchPageSchema.parse(page), page);
  assert.equal(searchHitSchema.safeParse(hit).success, false);
  for (const patch of [
    { nextCursor: null },
    { continuation: 'end' },
    { total: 1 },
    { mode: 'literal' },
    { indexStatus: 'unknown' },
    { items: [hit, hit] },
    { items: [{ ...hit, score: 0.9 }] },
  ])
    assert.equal(
      semanticSearchPageSchema.safeParse({ ...page, ...patch }).success,
      false,
    );
  assert.equal(
    semanticSearchQuerySchema.safeParse({
      spaceId: id,
      q: 'headphones',
      cursor: 'x'.repeat(43),
    }).success,
    false,
  );
});

test('disabled semantic HTTP gives explicit unavailable without database, key lookup or provider work', async () => {
  const fail = () => {
    throw new Error('Disabled semantics attempted database work');
  };
  assert.equal(createConfiguredSemanticProvider(config()), null);
  const module = await Test.createTestingModule({
    imports: [AppModule.register(config())],
  })
    .overrideProvider(DatabaseService)
    .useValue({ query: fail, transaction: fail })
    .compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
  for (const Guard of [
    ActivityRequestGuard,
    AnnouncementRequestGuard,
    DirectoryRequestGuard,
    ErrandRequestGuard,
    RatingRequestGuard,
  ]) {
    const options = Reflect.get(
      module.get(Guard, { strict: false }),
      'options',
    ) as { throttlers: { name: string; limit: number }[] };
    assert.equal(
      options.throttlers.find((entry) => entry.name === 'default')?.limit,
      120,
      'Semantic registration must not overwrite existing global throttler options',
    );
  }
  const semanticOptions = Reflect.get(
    module.get(SemanticSearchRequestGuard, { strict: false }),
    'options',
  ) as { throttlers: { name: string; limit: number }[] };
  assert.equal(semanticOptions.throttlers[0]?.name, 'semantic');
  assert.equal(semanticOptions.throttlers[0]?.limit, 10);

  try {
    const response = await request(app.getHttpServer())
      .get('/v1/community/search/semantic')
      .query({ spaceId: id, q: '耳机' });
    assert.equal(response.status, 503, JSON.stringify(response.body));
    assert.equal(response.body.error.code, 'SEMANTIC_SEARCH_DISABLED');
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.ok(response.headers['vary']?.includes('Authorization'));
    assert.deepEqual(Object.keys(response.body), ['error']);
    for (const query of [
      { spaceId: id, q: 'x', cursor: 'x'.repeat(43) },
      { spaceId: id, scope: 'all', q: 'x' },
      { scope: 'global', q: 'x', category: 'discussion' },
      { spaceId: id, q: 'x', limit: '11' },
    ]) {
      assert.equal(
        (
          await request(app.getHttpServer())
            .get('/v1/community/search/semantic')
            .query(query)
        ).status,
        400,
      );
    }
  } finally {
    await app.close();
  }
});
