import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  deleteRatingTargetSchema,
  cancelRatingTargetDeletionSchema,
  ratingTargetOwnerDeletionContextSchema,
  ratingTargetOwnerDeletionReceiptSchema,
} from '../src/ratings/management/target-deletion/contracts.js';
import { ratingTargetOwnerDeletionIntentHash } from '../src/ratings/management/target-deletion/requests.js';
import { RatingTargetOwnerDeletionService } from '../src/ratings/management/target-deletion/service.js';
import type { RatingTargetOwnerDeletionRepository } from '../src/ratings/management/target-deletion/repository.js';
import type { DatabaseService } from '../src/database/database.js';
import type { RatingsAccessService } from '../src/ratings/access.js';
const intent = {
  clientRequestId: randomUUID(),
  targetId: randomUUID(),
  expectedTargetRevision: randomUUID(),
};
const receipt = {
  requestId: intent.clientRequestId,
  operation: 'delete_target' as const,
  outcome: 'applied' as const,
  targetId: intent.targetId,
  revision: randomUUID(),
  occurredAt: '2026-10-09T02:03:04.123456Z',
};
test('M2A strict original intent carries only request, target and lifecycle CAS', () => {
  assert.deepEqual(cancelRatingTargetDeletionSchema.parse(intent), intent);
  const command = {
    clientRequestId: intent.clientRequestId,
    expectedTargetRevision: intent.expectedTargetRevision,
  };
  assert.deepEqual(deleteRatingTargetSchema.parse(command), command);
  assert.equal(deleteRatingTargetSchema.safeParse(intent).success, false);
  for (const key of Object.keys(intent)) {
    const value: Record<string, unknown> = { ...intent };
    delete value[key];
    assert.equal(
      cancelRatingTargetDeletionSchema.safeParse(value).success,
      false,
      key,
    );
  }
  for (const extra of [
    { creatorId: randomUUID() },
    { role: 'admin' },
    { regionId: null },
    { name: 'hidden' },
    { source: 'new_native' },
    { originalCampus: randomUUID() },
    { expectedContextRevision: 'a'.repeat(43) },
    { deleted: true },
  ])
    assert.equal(
      cancelRatingTargetDeletionSchema.safeParse({ ...intent, ...extra })
        .success,
      false,
    );
  assert.equal(
    cancelRatingTargetDeletionSchema.safeParse({
      ...intent,
      expectedTargetRevision: null,
    }).success,
    false,
  );
  assert.equal(
    cancelRatingTargetDeletionSchema.safeParse({
      ...intent,
      expectedTargetRevision: '11111111-1111-0111-8111-111111111111',
    }).success,
    false,
  );
});
test('M2A metadata distinguishes owner tombstone without public text or identity', () => {
  for (const kind of ['not_owner_deleted', 'owner_deleted']) {
    const context = {
      targetId: intent.targetId,
      revision: intent.expectedTargetRevision,
      deletion: { kind },
    };
    assert.deepEqual(
      ratingTargetOwnerDeletionContextSchema.parse(context),
      context,
    );
    for (const extra of [
      { name: 'hidden' },
      { description: 'hidden' },
      { creatorId: randomUUID() },
      { regionId: null },
      { active: false },
      { summary: { count: 1 } },
      { envelope: {} },
    ])
      assert.equal(
        ratingTargetOwnerDeletionContextSchema.safeParse({
          ...context,
          ...extra,
        }).success,
        false,
      );
    assert.equal(
      ratingTargetOwnerDeletionContextSchema.safeParse({
        ...context,
        deletion: { kind, deletedAt: receipt.occurredAt },
      }).success,
      false,
    );
  }
  assert.equal(
    ratingTargetOwnerDeletionContextSchema.safeParse({
      targetId: intent.targetId,
      revision: intent.expectedTargetRevision,
      deletion: { kind: 'inactive' },
    }).success,
    false,
  );
});
test('M2A receipts reject hidden payloads and unknown failures as terminal outcomes', () => {
  for (const outcome of ['applied', 'noop']) {
    const value = { ...receipt, outcome };
    assert.ok(ratingTargetOwnerDeletionReceiptSchema.safeParse(value).success);
    assert.equal(
      ratingTargetOwnerDeletionReceiptSchema.safeParse({
        ...value,
        name: 'hidden',
      }).success,
      false,
    );
  }
  for (const code of [
    'RATING_NOT_FOUND',
    'RATING_REVISION_CONFLICT',
    'PHONE_VERIFICATION_REQUIRED',
    'SAFETY_ACTION_RESTRICTED',
    'RATING_TARGET_DELETION_CANCELLED',
  ]) {
    const value = {
      requestId: intent.clientRequestId,
      operation: 'delete_target',
      outcome: 'rejected',
      code,
    };
    assert.ok(ratingTargetOwnerDeletionReceiptSchema.safeParse(value).success);
    assert.equal(
      ratingTargetOwnerDeletionReceiptSchema.safeParse({
        ...value,
        targetId: intent.targetId,
      }).success,
      false,
    );
  }
  for (const code of [
    'RATING_UNAVAILABLE',
    'VERIFICATION_UNAVAILABLE',
    'CONTENT_REVIEW_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'DATABASE_ERROR',
  ])
    assert.equal(
      ratingTargetOwnerDeletionReceiptSchema.safeParse({
        requestId: intent.clientRequestId,
        operation: 'delete_target',
        outcome: 'rejected',
        code,
      }).success,
      false,
    );
  assert.equal(
    ratingTargetOwnerDeletionReceiptSchema.safeParse({
      ...receipt,
      occurredAt: '2026-10-09T02:03:04.1234567Z',
    }).success,
    false,
  );
});
test('M2A hash is domain-separated and exact over the unchanged original intent', () => {
  const hash = ratingTargetOwnerDeletionIntentHash(intent);
  assert.equal(
    hash,
    ratingTargetOwnerDeletionIntentHash({
      expectedTargetRevision: intent.expectedTargetRevision,
      targetId: intent.targetId,
      clientRequestId: intent.clientRequestId,
    }),
  );
  assert.equal(
    hash,
    createHash('sha256')
      .update(
        'whaleu:rating-target-delete:v1\n' +
          canonicalJson({ operation: 'delete_target', intent }),
      )
      .digest('hex'),
  );
  for (const key of Object.keys(intent))
    assert.notEqual(
      hash,
      ratingTargetOwnerDeletionIntentHash({ ...intent, [key]: randomUUID() }),
    );
  assert.notEqual(
    hash,
    createHash('sha256')
      .update(
        'whaleu:rating-command:v1\n' +
          canonicalJson({ operation: 'delete_target', intent }),
      )
      .digest('hex'),
  );
});
test('M2A historical commit and cancellation replay acquire exclusive gate first and skip cleanup eligibility', async () => {
  const accountId = randomUUID(),
    queries: string[] = [],
    hash = ratingTargetOwnerDeletionIntentHash(intent);
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM whaleu_ratings.command_claims'))
        return { rows: [{ operation: 'delete_target', intent_hash: hash }] };
      if (sql.includes('SELECT operation,intent_hash,receipt'))
        return {
          rows: [{ operation: 'delete_target', intent_hash: hash, receipt }],
        };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  let checks = 0;
  const database = {
    transaction: async (run: (tx: PoolClient) => Promise<unknown>) => run(tx),
  } as unknown as DatabaseService;
  const access = {
    authenticate: async () => {
      assert.ok(queries[0]?.includes('pg_advisory_xact_lock('));
      return { accountId };
    },
    requireDeletionActor: async () => {
      throw new Error(
        'Historical replay must precede current cleanup eligibility',
      );
    },
    recheck: async () => {
      checks++;
    },
  } as unknown as RatingsAccessService;
  const records = {
    metadata: async () => {
      throw new Error(
        'Historical replay must not read target content/metadata',
      );
    },
  } as unknown as RatingTargetOwnerDeletionRepository;
  const service = new RatingTargetOwnerDeletionService(
    database,
    access,
    records,
  );
  const { targetId, ...command } = intent;
  assert.deepEqual(await service.delete('session', targetId, command), receipt);
  assert.deepEqual(await service.cancel('new-session', intent), receipt);
  assert.equal(checks, 2);
  await assert.rejects(
    () =>
      service.delete('session', targetId, {
        ...command,
        expectedTargetRevision: randomUUID(),
      }),
    (error: unknown) =>
      !!error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'REQUEST_CONFLICT',
  );
  assert.equal(
    queries.some(
      (q) =>
        q.includes('target_owner_delete_audits') ||
        q.includes('target_owner_delete_closures'),
    ),
    false,
  );
});
