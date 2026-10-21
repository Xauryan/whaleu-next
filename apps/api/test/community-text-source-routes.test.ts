import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderReadingCapabilityOpenApiDocument } from '../scripts/reading-capability-openapi-document.js';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config/config.js';
import { DatabaseService } from '../src/database/database.js';
import { accountRoutePolicies } from '../src/safety/account-policy/routes.js';
import { assertAccountRouteManifest } from '../src/safety/account-policy/runtime-inventory.js';

/** Future central gate only: genuine registered Nest controller inventory, not a
 * source regex pretending to prove startup. No database/server is used here. */
test('text-source routes exactly join authenticated browse inventory without changing legacy routes', async () => {
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
        throw new Error('Inventory may not query database');
      },
    })
    .compile();
  const app = module.createNestApplication({ logger: false });
  try {
    await app.init();
    const actual = assertAccountRouteManifest(
      app.get(ModulesContainer),
      accountRoutePolicies,
    );
    const selected = accountRoutePolicies.filter(([handler]) =>
      handler.startsWith('TextSourceController.'),
    );
    assert.deepEqual(
      selected.map((row) => row.slice(0, 5)),
      [
        [
          'TextSourceController.capabilities',
          'GET',
          '/v1/community/text-source-capabilities',
          'browse',
          'entry',
        ],
        [
          'TextSourceController.source',
          'GET',
          '/v1/community/text-sources/:kind/:id',
          'browse',
          'entry',
        ],
      ],
    );
    assert.equal(
      actual.filter((row) => row.handler.startsWith('TextSourceController.'))
        .length,
      2,
    );
    assert.deepEqual(
      accountRoutePolicies
        .filter(
          ([handler]) => handler === 'ReadingFormattingController.capabilities',
        )
        .map((row) => row.slice(0, 5)),
      [
        [
          'ReadingFormattingController.capabilities',
          'GET',
          '/v2/community/text-source-capabilities',
          'browse',
          'entry',
        ],
      ],
    );
    assert.equal(
      actual.filter(
        (row) => row.handler === 'ReadingFormattingController.capabilities',
      ).length,
      1,
    );
    assert.throws(() =>
      assertAccountRouteManifest(
        app.get(ModulesContainer),
        accountRoutePolicies.filter(
          ([handler]) => handler !== 'ReadingFormattingController.capabilities',
        ),
      ),
    );
    assert.throws(() =>
      assertAccountRouteManifest(
        app.get(ModulesContainer),
        accountRoutePolicies.filter(
          ([handler]) => handler !== 'TextSourceController.source',
        ),
      ),
    );
    assert.throws(() =>
      assertAccountRouteManifest(app.get(ModulesContainer), [
        ...accountRoutePolicies,
        [
          'TextSourceController.unregistered',
          'GET',
          '/v1/community/text-source-fake',
          'browse',
          'entry',
          'apps/api/src/community/text-source/controller.ts',
        ],
      ]),
    );
  } finally {
    await app.close();
  }
});

test('v2 diagnostic OpenAPI is generated from actual controller and strict independent contracts', async () => {
  assert.equal(
    await readFile(
      new URL(
        '../../../docs/openapi/community-reading-capability.json',
        import.meta.url,
      ),
      'utf8',
    ),
    await renderReadingCapabilityOpenApiDocument(),
  );
});
