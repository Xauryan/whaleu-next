import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { accountRoutePolicies } from '../src/safety/account-policy/routes.js';
import { assertAccountRouteManifest } from '../src/safety/account-policy/runtime-inventory.js';
import {
  createReadingContentOpenApiDocument,
  renderReadingContentOpenApiDocument,
} from '../scripts/reading-content-openapi-document.js';
test('six source-aware routes join genuine Nest browse inventory without granting guest access', async () => {
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
        throw new Error('Inventory must not query database');
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.init();
    const actual = assertAccountRouteManifest(
      app.get(ModulesContainer),
      accountRoutePolicies,
    ).filter((row) => row.handler.startsWith('ReadingContentController.'));
    assert.equal(actual.length, 6);
    for (const [, method, path, action, phase] of accountRoutePolicies.filter(
      ([handler]) => handler.startsWith('ReadingContentController.'),
    )) {
      assert.equal(method, 'GET');
      assert.ok(path.startsWith('/v2/community/'));
      assert.equal(action, 'browse');
      assert.equal(phase, 'entry');
    }
    assert.throws(() =>
      assertAccountRouteManifest(
        app.get(ModulesContainer),
        accountRoutePolicies.filter(
          ([handler]) => handler !== 'ReadingContentController.detail',
        ),
      ),
    );
  } finally {
    await app.close();
  }
});
test('runtime-derived OpenAPI covers exact routes and is current', async () => {
  const document = createReadingContentOpenApiDocument();
  assert.deepEqual(
    Object.keys(document.paths).sort(),
    [
      '/v2/community/posts/{id}',
      '/v2/community/posts/{id}/comments',
      '/v2/community/comments/{id}',
      '/v2/community/comments/{id}/replies',
      '/v2/community/replies/{id}',
      '/v2/community/posts/{id}/discussion-context',
    ].sort(),
  );
  assert.equal(
    await readFile(
      new URL(
        '../../../docs/openapi/community-reading-content.json',
        import.meta.url,
      ),
      'utf8',
    ),
    await renderReadingContentOpenApiDocument(),
  );
});
