import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  prepareRatingTargetSchema,
  createRatingTargetSchema,
  ratingTargetPreparationSchema,
  ratingTargetCreationReceiptSchema,
} from '../src/ratings/management/contracts.js';
import {
  RatingManagementService,
  ratingTargetCreateHash,
} from '../src/ratings/management/service.js';
import type { DatabaseService } from '../src/database/database.js';
import type { RatingsAccessService } from '../src/ratings/access.js';
import type { RatingsRepository } from '../src/ratings/repository.js';
import type { RatingCatalogWriter } from '../src/ratings/management/catalog-writer.js';
import type { RatingNativeTargetSourceFacade } from '../src/ratings/management/native-source.facade.js';
import type { RatingContentReviewFacade } from '../src/community/content-review/rating-content-review.facade.js';
const input = {
  clientRequestId: randomUUID(),
  regionId: null,
  categoryId: randomUUID(),
  expectedCategoryRevision: randomUUID(),
  expectedCatalogRevision: randomUUID(),
  name: 'Synthetic target',
  description: '',
  assetIds: [] as [],
};
const contextRevision = 'a'.repeat(43);
const prepared = {
  requestId: input.clientRequestId,
  targetId: randomUUID(),
  revision: randomUUID(),
  contextRevision,
};
const receipt = {
  requestId: input.clientRequestId,
  operation: 'create_target' as const,
  outcome: 'applied' as const,
  targetId: prepared.targetId,
  revision: prepared.revision,
  catalogRevision: randomUUID(),
  occurredAt: '2026-10-09T01:02:03.123456Z',
};
test('M1 ordinary creation input accepts only exact content/scope/CAS fields, never client authority or origin', () => {
  assert.deepEqual(prepareRatingTargetSchema.parse(input), input);
  assert.ok(
    prepareRatingTargetSchema.safeParse({ ...input, regionId: randomUUID() })
      .success,
  );
  for (const extra of [
    { actor: randomUUID() },
    { creatorId: randomUUID() },
    { role: 'admin' },
    { accepted: true },
    { source: 'new_native' },
    { coverage: 'complete' },
    { originalSchoolId: randomUUID() },
    { schoolless: true },
    { origin: 'unknown' },
    { policyId: randomUUID() },
    { targetId: randomUUID() },
    { expectedContextRevision: contextRevision },
  ])
    assert.equal(
      prepareRatingTargetSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
  for (const key of Object.keys(input)) {
    const omitted = { ...input } as Record<string, unknown>;
    delete omitted[key];
    assert.equal(
      prepareRatingTargetSchema.safeParse(omitted).success,
      false,
      key,
    );
  }
  for (const patch of [
    { regionId: 'school-guess' },
    { categoryId: 'bad' },
    { expectedCategoryRevision: null },
    { expectedCatalogRevision: '' },
    { assetIds: [randomUUID()] },
  ])
    assert.equal(
      prepareRatingTargetSchema.safeParse({ ...input, ...patch }).success,
      false,
    );
});
test('M1 Unicode bounds count codepoints, normalize CRLF/trim without normalization or silent truncation', () => {
  const result = prepareRatingTargetSchema.parse({
    ...input,
    name: ' 🌊\r\n鲸 ',
    description: ' \r\n说明\t ',
  });
  assert.equal(result.name, '🌊\n鲸');
  assert.equal(result.description, '说明');
  assert.equal(
    prepareRatingTargetSchema.parse({
      ...input,
      name: '🌊'.repeat(100),
      description: '🌊'.repeat(500),
    }).name.length,
    200,
  );
  assert.equal(
    prepareRatingTargetSchema.parse({ ...input, name: 'e\u0301' }).name,
    'e\u0301',
  );
  for (const patch of [
    { name: '🌊'.repeat(101) },
    { description: '🌊'.repeat(501) },
    { name: ' \r\n ' },
    { name: 'a\rb' },
    { name: '\ud800' },
    { description: 'a\u0000b' },
    { description: 'a\u0085b' },
    { name: 42 },
  ])
    assert.equal(
      prepareRatingTargetSchema.safeParse({ ...input, ...patch }).success,
      false,
    );
});
test('M1 commit requires strict opaque context; preparations and receipts are minimal durable terminal records', () => {
  assert.ok(
    createRatingTargetSchema.safeParse({
      ...input,
      expectedContextRevision: contextRevision,
    }).success,
  );
  assert.equal(createRatingTargetSchema.safeParse(input).success, false);
  for (const token of [
    '',
    randomUUID(),
    'a'.repeat(42),
    'a'.repeat(44),
    '+'.repeat(43),
  ])
    assert.equal(
      createRatingTargetSchema.safeParse({
        ...input,
        expectedContextRevision: token,
      }).success,
      false,
    );
  assert.deepEqual(ratingTargetPreparationSchema.parse(prepared), prepared);
  assert.deepEqual(ratingTargetCreationReceiptSchema.parse(receipt), receipt);
  for (const extra of [
    { name: 'private' },
    { description: 'private' },
    { creatorId: randomUUID() },
    { source: 'new_native' },
    { allowedActions: { create: true } },
  ]) {
    assert.equal(
      ratingTargetPreparationSchema.safeParse({ ...prepared, ...extra })
        .success,
      false,
    );
    assert.equal(
      ratingTargetCreationReceiptSchema.safeParse({ ...receipt, ...extra })
        .success,
      false,
    );
  }
  for (const outcome of ['noop', 'rejected'])
    assert.equal(
      ratingTargetCreationReceiptSchema.safeParse({ ...receipt, outcome })
        .success,
      false,
    );
  for (const code of [
    'RATING_CREATION_CONTEXT_CHANGED',
    'CONTENT_REJECTED',
    'RATING_CREATION_CANCELLED',
  ]) {
    const rejected = {
      requestId: input.clientRequestId,
      operation: 'create_target',
      outcome: 'rejected',
      code,
    };
    assert.ok(ratingTargetCreationReceiptSchema.safeParse(rejected).success);
    assert.equal(
      ratingTargetCreationReceiptSchema.safeParse({
        ...rejected,
        targetId: prepared.targetId,
      }).success,
      false,
    );
    assert.equal(
      ratingTargetCreationReceiptSchema.safeParse({
        ...rejected,
        code: 'RATING_UNAVAILABLE',
      }).success,
      false,
    );
  }
  assert.equal(
    ratingTargetCreationReceiptSchema.safeParse({
      ...receipt,
      occurredAt: '2026-10-09T01:02:03.1234567Z',
    }).success,
    false,
  );
});
test('M1 hash has stable canonical ordering, exact content/scope/CAS sensitivity and separate domain', () => {
  const parsed = prepareRatingTargetSchema.parse(input),
    hash = ratingTargetCreateHash(parsed);
  const reordered = Object.fromEntries(
    Object.entries(parsed).reverse(),
  ) as typeof parsed;
  assert.equal(ratingTargetCreateHash(reordered), hash);
  const normalized = prepareRatingTargetSchema.parse({
    ...input,
    name: ' Synthetic target\r\n ',
    description: ' ',
  });
  assert.equal(ratingTargetCreateHash(normalized), hash);
  assert.equal(
    hash,
    createHash('sha256')
      .update(
        'whaleu:rating-target-create:v1\n' +
          canonicalJson({ operation: 'create_target', intent: parsed }),
      )
      .digest('hex'),
  );
  assert.notEqual(
    hash,
    createHash('sha256')
      .update(
        'whaleu:rating-command:v1\n' +
          canonicalJson({ operation: 'create_target', intent: parsed }),
      )
      .digest('hex'),
  );
  for (const patch of [
    { clientRequestId: randomUUID() },
    { regionId: randomUUID() },
    { categoryId: randomUUID() },
    { expectedCategoryRevision: randomUUID() },
    { expectedCatalogRevision: randomUUID() },
    { name: 'Synthetic Target' },
    { description: 'extra' },
  ])
    assert.notEqual(
      ratingTargetCreateHash(
        prepareRatingTargetSchema.parse({ ...input, ...patch }),
      ),
      hash,
    );
});
test('M1 commit replay excludes expectedContextRevision from intent hash and reads receipt before expired context/current eligibility', async () => {
  const accountId = randomUUID(),
    queries: string[] = [],
    hash = ratingTargetCreateHash(input);
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM whaleu_ratings.command_claims'))
        return { rows: [{ operation: 'create_target', intent_hash: hash }] };
      if (sql.includes('SELECT receipt FROM whaleu_ratings.requests'))
        return { rows: [{ receipt }] };
      if (sql.includes('target_preparations'))
        throw new Error(
          'Historical receipt must precede preparation/current context',
        );
      return { rows: [] };
    },
  } as unknown as PoolClient;
  let rechecked = 0;
  const database = {
    transaction: async (run: (tx: PoolClient) => Promise<unknown>) => run(tx),
  } as unknown as DatabaseService;
  const access = {
    authenticate: async () => ({ accountId, sessionId: randomUUID() }),
    recheck: async () => {
      rechecked++;
    },
    resolveAccount: async () => {
      throw new Error('No eligibility read for historical receipt');
    },
  } as unknown as RatingsAccessService;
  const service = new RatingManagementService(
    database,
    access,
    {} as RatingsRepository,
    {} as RatingCatalogWriter,
    {} as RatingNativeTargetSourceFacade,
    {} as RatingContentReviewFacade,
  );
  for (const expectedContextRevision of ['a'.repeat(43), 'b'.repeat(43)])
    assert.deepEqual(
      await service.create(
        'token',
        createRatingTargetSchema.parse({ ...input, expectedContextRevision }),
      ),
      receipt,
    );
  assert.equal(rechecked, 2);
  assert.ok(queries[0]?.includes('pg_advisory_xact_lock('));
  assert.equal(
    queries.some((q) => q.includes('pg_advisory_xact_lock_shared')),
    false,
  );
  await assert.rejects(
    () =>
      service.create(
        'token',
        createRatingTargetSchema.parse({
          ...input,
          name: 'different',
          expectedContextRevision: contextRevision,
        }),
      ),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'REQUEST_CONFLICT',
  );
});
