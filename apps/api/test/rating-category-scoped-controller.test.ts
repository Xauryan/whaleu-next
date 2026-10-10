import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import { RatingCategoryScopedManagementController } from '../src/ratings/category-management/scoped-controller.js';
import { RatingCategoryScopedManagementService } from '../src/ratings/category-management/scoped-service.js';
import { RatingCategoryManagementReader } from '../src/ratings/category-management/scoped-reader.repository.js';
import { RatingCategorySourceIssuer } from '../src/ratings/category-management/source-issuer.js';
import { RatingsModule } from '../src/ratings/module.js';
import { RatingRequestGuard } from '../src/request-throttling/rating-request.guard.js';
import { ratingScopedRequestReceiptSchema } from '../src/ratings/scoped/request-receipt.js';
import { ratingScopedReceiptSchema } from '../src/ratings/scoped/contracts.js';
import {
  ratingCategoryScopedOperations,
  ratingCategoryScopedReceiptSchema,
  ratingCategoryManagementQuerySchema,
  ratingCategoryManagementContextRequestSchema,
} from '../src/ratings/category-management/scoped-contracts.js';
const id = (n: number) =>
  `99000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('eight category routes match the native manifest and retain guard, bearer auth and private headers', () => {
  const manifest = readFileSync(
    new URL(
      '../../wechat/src/ratings/category-scoped-routes.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const expected = [
    ...manifest.matchAll(
      /\[\s*'([^']+)',\s*'(GET|POST)',\s*'([^']+)'[,\s]*\]/g,
    ),
  ].map((match) => ({
    operationId: `ratingScopedCategoryManagement${match[1]}`,
    method: match[2],
    path: match[3],
  }));
  assert.equal(expected.length, 8);
  const controller = RatingCategoryScopedManagementController;
  assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [
    RatingRequestGuard,
  ]);
  assert.deepEqual(Reflect.getMetadata('swagger/apiSecurity', controller), [
    { accessToken: [] },
  ]);
  const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const actual: typeof expected = [];
  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    const method = Object.getOwnPropertyDescriptor(controller.prototype, name)
      ?.value as unknown;
    if (
      typeof method !== 'function' ||
      !Reflect.hasMetadata(METHOD_METADATA, method)
    )
      continue;
    assert.equal(Reflect.getMetadata(HTTP_CODE_METADATA, method), 200);
    const headers = Reflect.getMetadata(HEADERS_METADATA, method) as {
      name: string;
      value: string;
    }[];
    assert(
      headers.some(
        (header) =>
          header.name === 'Cache-Control' && header.value === 'no-store',
      ),
    );
    assert(
      headers.some(
        (header) => header.name === 'Vary' && header.value === 'Authorization',
      ),
    );
    const operation = Reflect.getMetadata('swagger/apiOperation', method) as {
      operationId: string;
    };
    actual.push({
      operationId: operation.operationId,
      method:
        RequestMethod[
          Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod
        ]!,
      path: `/${prefix}/${Reflect.getMetadata(PATH_METADATA, method) as string}`,
    });
  }
  const sort = (rows: typeof actual) =>
    [...rows].sort((a, b) => a.operationId.localeCompare(b.operationId));
  assert.deepEqual(sort(actual), sort(expected));
  assert.equal(
    new Set(actual.map((route) => `${route.method}:${route.path}`)).size,
    8,
  );
});

test('runtime module registers the category boundary and exact service dependencies', () => {
  const controllers = Reflect.getMetadata(
    MODULE_METADATA.CONTROLLERS,
    RatingsModule,
  ) as unknown[];
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    RatingsModule,
  ) as unknown[];
  assert(controllers.includes(RatingCategoryScopedManagementController));
  for (const provider of [
    RatingCategoryScopedManagementService,
    RatingCategoryManagementReader,
    RatingCategorySourceIssuer,
  ])
    assert(providers.includes(provider));
});

test('management context/query reject public authority flags and unrelated parameters', () => {
  assert(
    ratingCategoryManagementContextRequestSchema.safeParse({
      selector: { kind: 'global' },
    }).success,
  );
  assert(
    !ratingCategoryManagementContextRequestSchema.safeParse({
      selector: { kind: 'global' },
      mode: 'public',
    }).success,
  );
  assert(
    !ratingCategoryManagementContextRequestSchema.safeParse({
      selector: { kind: 'campus', campusId: id(1), regionId: id(2) },
    }).success,
  );
  assert(
    !ratingCategoryManagementQuerySchema.safeParse({
      contextId: id(1),
      contextToken: 'a'.repeat(43),
      authority: 'global',
    }).success,
  );
});

test('shared request decoder admits exact category receipts without broadening public command receipts', () => {
  for (const operation of ratingCategoryScopedOperations) {
    const receipt = {
      protocolVersion: 2,
      requestId: id(1),
      operation,
      intentHash: 'a'.repeat(64),
      outcome: 'applied',
      result: {
        releaseId: id(2),
        categoryIds: [id(3)],
        heads: [],
        occurredAt: '2026-10-10T00:00:00.000Z',
      },
    };
    assert.deepEqual(ratingScopedRequestReceiptSchema.parse(receipt), receipt);
    assert(ratingCategoryScopedReceiptSchema.safeParse(receipt).success);
    assert(!ratingScopedReceiptSchema.safeParse(receipt).success);
    assert(
      !ratingScopedRequestReceiptSchema.safeParse({
        ...receipt,
        operation: 'unknown_category_operation',
      }).success,
    );
    assert(
      !ratingScopedRequestReceiptSchema.safeParse({
        ...receipt,
        protocolVersion: 1,
      }).success,
    );
    assert(
      !ratingScopedRequestReceiptSchema.safeParse({
        ...receipt,
        result: { ...receipt.result, name: 'Unreviewed body' },
      }).success,
    );
  }
  const old = {
    protocolVersion: 2,
    requestId: id(1),
    operation: 'set_score_scoped',
    intentHash: 'b'.repeat(64),
    outcome: 'closed',
    code: 'RATING_SCOPED_CONTEXT_CHANGED',
  };
  assert.deepEqual(
    ratingScopedRequestReceiptSchema.parse(old),
    ratingScopedReceiptSchema.parse(old),
  );
});
