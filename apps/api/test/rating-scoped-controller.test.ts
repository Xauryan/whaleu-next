import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants.js';
import {
  RatingScopedController,
  RatingScopedNoticesController,
  ratingScopedCommitSchema,
  ratingScopedOperationSchema,
} from '../src/ratings/scoped/controller.js';
import { RatingRequestGuard } from '../src/request-throttling/rating-request.guard.js';
import { ratingScopedIntentSchema } from '../src/ratings/scoped/contracts.js';
import {
  scopedTestContext,
  scopedTestId as id,
} from './rating-scoped-service-helpers.js';

test('scoped API exposes exactly the 39 native-consumed paths with existing auth guard and private cache headers', () => {
  const manifest = readFileSync(
    new URL('../../wechat/src/ratings/scoped-routes.ts', import.meta.url),
    'utf8',
  );
  const expected = [
    ...manifest.matchAll(
      /\[\s*'([^']+)',\s*'(GET|PUT|POST)',\s*'([^']+)'[,\s]*\]/g,
    ),
  ].map((match) => ({
    operationId: `ratingScoped${match[1]}`,
    method: match[2],
    path: match[3],
  }));
  assert.equal(expected.length, 39);
  const actual: { operationId: string; method: string; path: string }[] = [];
  for (const controller of [
    RatingScopedController,
    RatingScopedNoticesController,
  ]) {
    assert.deepEqual(Reflect.getMetadata(GUARDS_METADATA, controller), [
      RatingRequestGuard,
    ]);
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
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
          (header) =>
            header.name === 'Vary' && header.value === 'Authorization',
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
  }
  const sort = (rows: typeof actual) =>
    [...rows].sort((a, b) => a.operationId.localeCompare(b.operationId));
  assert.equal(
    new Set(actual.map((route) => `${route.method}:${route.path}`)).size,
    39,
  );
  assert.deepEqual(sort(actual), sort(expected as typeof actual));
});
function intent(
  operation: 'set_score_scoped' | 'create_target_scoped' = 'set_score_scoped',
) {
  const c = scopedTestContext();
  const context = {
    id: c.id,
    token: c.token,
    tokenDigest: c.tokenDigest,
    selector: c.selector,
    scopeRevision: c.scopeRevision,
    protocolGeneration: c.protocolGeneration,
    catalogRevision: c.heads[0]!.catalogRevision,
    headRevision: c.heads[0]!.headRevision,
    sourceDigest: c.sourceDigest,
  };
  const base = {
    clientRequestId: id(12),
    categoryId: id(13),
    expectedCategoryRevision: id(14),
  };
  return ratingScopedIntentSchema.parse({
    protocolVersion: 2,
    operation,
    context,
    payload:
      operation === 'set_score_scoped'
        ? {
            ...base,
            targetId: id(10),
            expectedTargetRevision: id(11),
            expectedRevision: null,
            score: 5,
          }
        : { ...base, name: 'Synthetic target', description: '', assetIds: [] },
  });
}
const auth = `Bearer wu_a_${'a'.repeat(43)}`;
function fixture() {
  type Dependencies = ConstructorParameters<typeof RatingScopedController>;
  const calls: { method: string; arguments: unknown[] }[] = [];
  const invoke =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, arguments: args });
      return Promise.resolve({ method });
    };
  const controller = new RatingScopedController(
    {
      create: () => {
        assert.fail('Recovery must not warm context');
      },
    } as unknown as Dependencies[0],
    {} as Dependencies[1],
    {
      status: invoke('status'),
      cancel: invoke('cancel'),
      submit: invoke('submit'),
      prepare: invoke('prepare'),
    } as unknown as Dependencies[2],
    {} as Dependencies[3],
    {} as Dependencies[4],
  );
  return { controller, calls };
}
test('historical status and cancellation dispatch straight to command owner before any context warmup', async () => {
  const f = fixture(),
    original = intent('create_target_scoped');
  await f.controller.request(auth, id(12), {}, undefined);
  await f.controller.cancelTarget(auth, {}, original);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['status', 'cancel'],
  );
  assert.deepEqual(f.calls[1]!.arguments, [auth.slice(7), original]);
});
test('thin command routes require exact operation and URL subject before invoking shared transitions', async () => {
  const f = fixture(),
    score = intent();
  assert.throws(
    () => f.controller.setScore(auth, id(99), {}, score),
    BadRequestException,
  );
  assert.throws(
    () =>
      f.controller.setScore(auth, id(10), {}, intent('create_target_scoped')),
    BadRequestException,
  );
  assert.equal(f.calls.length, 0);
  await f.controller.setScore(auth, id(10), {}, score);
  assert.deepEqual(f.calls[0], {
    method: 'submit',
    arguments: [auth.slice(7), score],
  });
});
test('M1 commit strips transport proof from immutable original intent rather than hashing a refreshed command', async () => {
  const f = fixture(),
    original = intent('create_target_scoped'),
    proof = 'p'.repeat(43);
  const body = ratingScopedCommitSchema.parse({
    ...original,
    preparationContextRevision: proof,
  });
  await f.controller.createTarget(auth, {}, body);
  assert.deepEqual(f.calls[0], {
    method: 'submit',
    arguments: [auth.slice(7), original, proof],
  });
  assert.equal(ratingScopedIntentSchema.safeParse(body).success, false);
  assert.equal(
    ratingScopedCommitSchema.safeParse({ ...body, unknown: true }).success,
    false,
  );
  assert.equal(
    ratingScopedOperationSchema('set_score_scoped').safeParse(original).success,
    false,
  );
});
