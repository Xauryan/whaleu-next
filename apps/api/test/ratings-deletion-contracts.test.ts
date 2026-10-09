import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import * as contracts from '../src/ratings/deletion/contracts.js';
import {
  deleteRatingCommentSchema,
  ratingReceiptSchema,
} from '../src/ratings/contracts.js';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import {
  RatingAdminDeletionRequests,
  ratingAdminDeletionIntentHash,
} from '../src/ratings/deletion/requests.js';
import { RatingTargetOriginFacade } from '../src/ratings/deletion/origin.facade.js';
import { CampusRatingOriginScopeFacade } from '../src/campus/rating-origin-scope.facade.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { DatabaseService } from '../src/database/database.js';
import type { RatingsAccessService } from '../src/ratings/access.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
const id = randomUUID();
const revision = randomUUID();
const context = {
  subjectKind: 'comment' as const,
  targetId: randomUUID(),
  rootId: id,
  subjectId: id,
  regionId: null,
  targetRevision: randomUUID(),
  rootRevision: revision,
  revision,
  deleted: false,
};
const command = {
  clientRequestId: randomUUID(),
  targetId: context.targetId,
  expectedTargetRevision: context.targetRevision,
  expectedRevision: revision,
  expectedContextRevision: 'a'.repeat(43),
};
const receipt = {
  requestId: command.clientRequestId,
  operation: 'admin_delete_comment' as const,
  outcome: 'applied' as const,
  targetId: context.targetId,
  rootId: id,
  subjectId: id,
  revision: randomUUID(),
  occurredAt: '2026-10-09T01:02:03.123456Z',
};
test('deletion contexts expose strict metadata and distinguish owner and administrator', () => {
  assert.deepEqual(
    contracts.ratingDeletionContextSchema.parse(context),
    context,
  );
  assert.ok(
    contracts.ratingAdminDeletionContextSchema.safeParse({
      ...context,
      contextRevision: command.expectedContextRevision,
    }).success,
  );
  for (const extra of [
    { body: 'private' },
    { accountId: id },
    { author: { accountId: id } },
    { categoryId: id },
    { grantId: id },
    { sourceReference: 'private' },
    { contextRevision: command.expectedContextRevision },
  ])
    assert.equal(
      contracts.ratingDeletionContextSchema.safeParse({ ...context, ...extra })
        .success,
      false,
    );
  assert.equal(
    contracts.ratingAdminDeletionContextSchema.safeParse(context).success,
    false,
  );
  assert.equal(
    contracts.ratingDeletionContextSchema.safeParse({
      ...context,
      rootId: randomUUID(),
    }).success,
    false,
  );
  assert.equal(
    contracts.ratingDeletionContextSchema.safeParse({
      ...context,
      rootRevision: randomUUID(),
    }).success,
    false,
  );
});
test('admin deletion commands require exact server context and prohibit identity, time and region overrides', () => {
  assert.ok(
    contracts.adminDeleteRatingCommentSchema.safeParse(command).success,
  );
  const reply = { ...command, rootId: id, expectedRootRevision: revision };
  assert.ok(contracts.adminDeleteRatingReplySchema.safeParse(reply).success);
  for (const extra of [
    { actor: id },
    { accountId: id },
    { role: 'super_admin' },
    { author: id },
    { regionId: null },
    { occurredAt: receipt.occurredAt },
    { reason: 'anything' },
    { rootId: id },
  ])
    assert.equal(
      contracts.adminDeleteRatingCommentSchema.safeParse({
        ...command,
        ...extra,
      }).success,
      false,
    );
  assert.equal(
    contracts.adminDeleteRatingReplySchema.safeParse(command).success,
    false,
  );
  assert.equal(
    contracts.adminDeleteRatingCommentSchema.safeParse({
      ...command,
      expectedContextRevision: 'forged',
    }).success,
    false,
  );
  assert.equal(
    deleteRatingCommentSchema.safeParse({ ...command, regionId: null }).success,
    false,
  );
});
test('admin receipts are minimal and cannot pass an old owner decoder', () => {
  assert.deepEqual(
    contracts.ratingAdminDeletionReceiptSchema.parse(receipt),
    receipt,
  );
  assert.equal(ratingReceiptSchema.safeParse(receipt).success, false);
  for (const extra of [
    { author: id },
    { body: 'private' },
    { grantId: id },
    { contextRevision: command.expectedContextRevision },
  ])
    assert.equal(
      contracts.ratingAdminDeletionReceiptSchema.safeParse({
        ...receipt,
        ...extra,
      }).success,
      false,
    );
  assert.equal(
    contracts.ratingAdminDeletionReceiptSchema.safeParse({
      ...receipt,
      rootId: randomUUID(),
    }).success,
    false,
  );
  for (const code of [
    'AUTHORIZATION_UNAVAILABLE',
    'RATING_DELETION_AUTHORITY_UNAVAILABLE',
    'RATING_DELETION_CONTEXT_CHANGED',
    'RATING_UNAVAILABLE',
  ])
    assert.equal(
      contracts.ratingAdminDeletionReceiptSchema.safeParse({
        requestId: command.clientRequestId,
        operation: 'admin_delete_comment',
        outcome: 'rejected',
        code,
      }).success,
      false,
    );
});
test('admin command hashes use a separate domain and include context intent', () => {
  const hash = ratingAdminDeletionIntentHash('admin_delete_comment', command);
  assert.equal(
    hash,
    ratingAdminDeletionIntentHash('admin_delete_comment', { ...command }),
  );
  assert.notEqual(
    hash,
    ratingAdminDeletionIntentHash('admin_delete_reply', command),
  );
  assert.notEqual(
    hash,
    ratingAdminDeletionIntentHash('admin_delete_comment', {
      ...command,
      expectedContextRevision: 'b'.repeat(43),
    }),
  );
  assert.notEqual(
    hash,
    createHash('sha256')
      .update(
        'whaleu:rating-command:v1\n' +
          canonicalJson({ operation: 'admin_delete_comment', intent: command }),
      )
      .digest('hex'),
  );
});
function requestHarness(
  existing: unknown = null,
  operation = 'admin_delete_comment',
  hash = ratingAdminDeletionIntentHash('admin_delete_comment', command),
) {
  const queries: string[] = [];
  let saved: unknown;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.startsWith('SELECT intent_hash'))
        return { rows: [{ intent_hash: hash, operation, receipt: existing }] };
      if (sql.startsWith('UPDATE whaleu_ratings.requests'))
        saved = JSON.parse(values?.[2] as string);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async (run: (tx: PoolClient) => Promise<unknown>) => run(tx),
  } as unknown as DatabaseService;
  let rechecks = 0;
  const access = {
    authenticate: async () => ({
      accountId: id,
      sessionId: randomUUID(),
      expiresAt: Date.now() + 60000,
      refreshExpiresAt: Date.now() + 60000,
    }),
    recheck: async () => {
      rechecks++;
    },
  } as unknown as RatingsAccessService;
  return {
    requests: new RatingAdminDeletionRequests(database, access),
    queries,
    get saved() {
      return saved;
    },
    get rechecks() {
      return rechecks;
    },
  };
}
test('receipt replay precedes grant, context, CAS and effects', async () => {
  const h = requestHarness(receipt);
  const result = await h.requests.execute(
    'token',
    command.clientRequestId,
    'admin_delete_comment',
    command,
    async () => {
      throw new Error('Replay must not apply');
    },
  );
  assert.deepEqual(result, receipt);
  assert.equal(h.rechecks, 1);
  assert.equal(h.saved, undefined);
});
test('same shared request key cannot be reused across admin and owner operations', async () => {
  const h = requestHarness(receipt, 'delete_comment');
  await assert.rejects(
    h.requests.execute(
      'token',
      command.clientRequestId,
      'admin_delete_comment',
      command,
      async () => {
        throw new Error('No apply');
      },
    ),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'REQUEST_CONFLICT',
  );
});
test('terminal pre-mutation rejection retains transaction authority proofs', async () => {
  const h = requestHarness();
  await h.requests.execute(
    'token',
    command.clientRequestId,
    'admin_delete_comment',
    command,
    async () => {
      throw new ApplicationError('RATING_REVISION_CONFLICT');
    },
  );
  assert.deepEqual(h.saved, {
    requestId: command.clientRequestId,
    operation: 'admin_delete_comment',
    outcome: 'rejected',
    code: 'RATING_REVISION_CONFLICT',
  });
  assert.equal(
    h.queries.some((sql) => /SAVEPOINT|ROLLBACK/.test(sql)),
    false,
  );
});
test('stale context and uncertain authority never become terminal receipts', async () => {
  for (const code of [
    'RATING_DELETION_CONTEXT_CHANGED',
    'RATING_DELETION_AUTHORITY_UNAVAILABLE',
    'AUTHORIZATION_UNAVAILABLE',
  ] as const) {
    const h = requestHarness();
    await assert.rejects(
      h.requests.execute(
        'token',
        command.clientRequestId,
        'admin_delete_comment',
        command,
        async () => {
          throw new ApplicationError(code);
        },
      ),
      (e: unknown) => e instanceof ApplicationError && e.code === code,
    );
    assert.equal(h.saved, undefined);
  }
});
function proofHarness(
  source: () => unknown[],
  onQuery?: (sql: string) => void,
) {
  const tx = {
    query: async (sql: string) => {
      onQuery?.(sql);
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '5s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.startsWith('WITH instant')) return { rows: source() };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return tx;
}
test('origin absence is a required NOWAIT-fenced fact, never a guessed campus', async () => {
  const statements: string[] = [];
  const tx = proofHarness(
    () => [],
    (sql) => statements.push(sql),
  );
  try {
    const origin = await new RatingTargetOriginFacade().observe(id, tx);
    assert.equal(origin.state, 'absent');
    assert.equal(origin.campusId, null);
    await checkTransactionDeadlines(tx);
    assert.ok(
      statements.some((sql) =>
        sql.includes(
          'target_origin_heads,whaleu_ratings.target_origin_sources IN SHARE MODE NOWAIT',
        ),
      ),
    );
    assert.equal(
      statements.some((sql) => /category|affiliation|role_grants/.test(sql)),
      false,
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('origin appearing after an absent observation fails final proof', async () => {
  let rows: unknown[] = [];
  const tx = proofHarness(() => rows);
  try {
    await new RatingTargetOriginFacade().observe(id, tx);
    rows = [
      {
        head_revision: 1,
        source_id: randomUUID(),
        revision: 1,
        state: 'schoolless',
        origin_campus_id: null,
        revoked: false,
        source_version: 1,
        coverage_state: 'complete',
        provenance_state: 'accepted',
        source_reference: 'fixture',
        policy_reference: 'fixture',
        effective_at: new Date(0),
        precise_from: '1970-01-01',
        valid_until: null,
        precise_until: null,
        expiry_kind: 'policy_exempt',
        valid: true,
        future: false,
      },
    ];
    await assert.rejects(
      checkTransactionDeadlines(tx),
      (e: unknown) =>
        e instanceof ApplicationError &&
        e.code === 'RATING_DELETION_AUTHORITY_UNAVAILABLE',
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('Campus origin mapping is independent of public region activity', async () => {
  const campusId = randomUUID(),
    institutionId = randomUUID(),
    groupId = randomUUID(),
    regionId = randomUUID();
  const tx = proofHarness(() => [
    {
      id: randomUUID(),
      revision: 1,
      valid: true,
      valid_until: null,
      effective_at: '1970-01-01',
      precise_until: null,
      topology: {
        version: 1,
        groups: [{ groupId, coverage: 'complete', isActive: false }],
        regions: [
          {
            regionId,
            institutionId,
            groupId,
            coverage: 'complete',
            isActive: false,
          },
        ],
        assignments: [
          {
            campusId,
            institutionId,
            regionId,
            coverage: 'complete',
            isActive: false,
          },
        ],
      },
    },
  ]);
  try {
    assert.equal(
      (await new CampusRatingOriginScopeFacade().resolve(campusId, tx))
        .operatingRegionId,
      regionId,
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});
