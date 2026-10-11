/** Exact receipt and generation boundaries on the real AppModule/PG owner.
 * Run only under the parent's exclusive disposable PostgreSQL lease. Hostile
 * SQL is never committed as fixture history; no owner trigger is replaced. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingCategoryIconIntentHash,
  ratingCategoryIconReceiptSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';
import { RatingCategoryIconManagementService } from '../../src/ratings/category-management/icon-service.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

async function createIntent(f: CategoryIconManagementFixture) {
  return f.intent(await f.context(), 'create_categories_scoped', {
    parentId: null,
    placement: { kind: 'global' },
    nodes: [
      {
        key: 'root',
        parentKey: null,
        name: 'Receipt boundary category',
        description: 'Exact original owner',
        icon: { mode: 'clear' },
      },
    ],
  });
}

/** Include original authority, source/release projections, Review, Media and
 * owner epochs, not merely the added icon rows or an empty public response. */
async function graph(f: CategoryIconManagementFixture) {
  const tables = [
    'whaleu_ratings.command_claims',
    'whaleu_ratings.requests',
    'whaleu_ratings.scoped_command_preparations',
    'whaleu_ratings.scoped_command_causes',
    'whaleu_ratings.scoped_command_outcomes',
    'whaleu_ratings.scoped_source_attestations',
    'whaleu_ratings.scoped_source_heads',
    'whaleu_ratings.scoped_source_epoch',
    'whaleu_ratings.random_pool_epoch',
    'whaleu_ratings.navigation_epoch',
    'whaleu_ratings.compat_versions',
    'whaleu_ratings.compat_heads',
    'whaleu_ratings.compat_projection_manifests',
    'whaleu_ratings.compat_projection_lineage',
    'whaleu_ratings.scope_protocol_versions',
    'whaleu_ratings.scope_protocol_heads',
    'whaleu_ratings.scope_protocol_epoch',
    'whaleu_ratings.scoped_releases',
    'whaleu_ratings.scoped_release_scopes',
    'whaleu_ratings.scoped_catalogs',
    'whaleu_ratings.scoped_catalog_heads',
    'whaleu_ratings.scoped_categories',
    'whaleu_ratings.scoped_category_lineage',
    'whaleu_ratings.scoped_target_memberships',
    'whaleu_ratings.category_scope_placements',
    'whaleu_ratings.category_icon_preparations',
    'whaleu_ratings.category_icon_recovery_fences',
    'whaleu_ratings.category_icon_retirement_queue',
    'whaleu_ratings.category_icon_review_bindings',
    'whaleu_community.rating_approval_decisions',
    'whaleu_community.rating_approval_events',
    'whaleu_community.rating_approval_heads',
    'whaleu_community.rating_scoped_category_source_bindings',
    'whaleu_community.rating_review_epoch',
    'whaleu_community.rating_review_binding_epoch',
    'whaleu_media.upload_intents',
    'whaleu_media.assets',
    'whaleu_media.variants',
    'whaleu_media.asset_safety_events',
    'whaleu_media.asset_safety_heads',
    'whaleu_media.bindings',
    'whaleu_media.cleanup_obligations',
  ];
  const original = (
    await f.pool.query<{ value: unknown }>(
      `SELECT jsonb_build_object(${tables
        .map(
          (table) =>
            `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM ${table} r)`,
        )
        .join(',')}) value`,
    )
  ).rows[0]!.value;
  return { original, icons: await f.artifacts() };
}
function pgFence(error: unknown, ...functions: string[]) {
  assert.ok(error instanceof Error, String(error));
  const pg = error as Error & { code?: string; where?: string };
  assert.equal(pg.code, '23514', pg.message);
  for (const name of functions)
    assert.match(
      pg.where ?? '',
      new RegExp(`(?:\\.|\\s)${name}\\(`),
      pg.message,
    );
  return true;
}
async function epoch(tx: PoolClient) {
  return BigInt(
    (
      await tx.query<{ epoch: string }>(
        'SELECT epoch::text FROM whaleu_ratings.category_icon_epoch WHERE singleton',
      )
    ).rows[0]!.epoch,
  );
}
async function advance(tx: PoolClient) {
  const before = await epoch(tx);
  assert.equal(
    (
      await tx.query(
        'UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch+1 WHERE singleton',
      )
    ).rowCount,
    1,
  );
  assert.equal(await epoch(tx), before + 1n);
}
async function forceFinal(tx: PoolClient) {
  await tx.query(
    'SET CONSTRAINTS whaleu_ratings.category_icon_final_generation IMMEDIATE',
  );
}
async function forceReceipt(tx: PoolClient) {
  await tx.query(
    'SET CONSTRAINTS whaleu_ratings.category_icon_receipt_full_boundary IMMEDIATE',
  );
}

/** Only compose Database.transaction with the actual guarded writer. The real
 * service still performs every original read, claim, mutation and finalizer. */
async function withOwnerTransaction(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  contextRevision: string,
  work: (tx: PoolClient, commit: () => Promise<void>) => Promise<void>,
) {
  const database = f.app.get(DatabaseService),
    original = database.transaction;
  try {
    await withCommunityScopeWriter(f.pool, async (tx) => {
      database.transaction = async <T>(
        body: (client: PoolClient) => Promise<T>,
      ): Promise<T> => body(tx);
      const commit = async () => {
        const receipt = await f.app
          .get(RatingCategoryIconManagementService)
          .commit(f.admin.accessToken, {
            intent: input,
            preparationContextRevision: contextRevision,
          });
        assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      };
      await work(tx, commit);
    });
  } finally {
    database.transaction = original;
  }
}
async function commandThenSql(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  revision: string,
  after: (tx: PoolClient) => Promise<void>,
) {
  await withOwnerTransaction(f, input, revision, async (tx, commit) => {
    await commit();
    await after(tx);
  });
}
function wire(input: RatingCategoryIconIntent, outcome: 'applied' | 'closed') {
  return {
    protocolVersion: 5,
    requestId: input.payload.clientRequestId,
    operation: input.operation,
    intentHash: ratingCategoryIconIntentHash(input),
    outcome,
    ...(outcome === 'closed'
      ? { code: 'RATING_CATEGORY_CANCELLED' }
      : {
          result: {
            releaseId: null,
            mediaReleaseDigest: null,
            categoryIds: [],
            heads: [],
            occurredAt: '2026-01-01T00:00:00.000Z',
          },
        }),
  };
}
async function rawRequest(
  tx: PoolClient,
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  receipt: ReturnType<typeof wire> | null,
) {
  assert.equal(
    (
      await tx.query(
        `INSERT INTO whaleu_ratings.requests
    (account_id,request_id,operation,intent_hash,receipt) VALUES($1,$2,$3,$4,$5::jsonb)`,
        [
          f.admin.accountId,
          input.payload.clientRequestId,
          input.operation,
          ratingCategoryIconIntentHash(input),
          receipt === null ? null : JSON.stringify(receipt),
        ],
      )
    ).rowCount,
    1,
  );
}
async function rawOutcome(
  tx: PoolClient,
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  outcome: 'applied' | 'closed',
) {
  const receipt = wire(input, outcome);
  assert.equal(
    (
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_command_outcomes
    (account_id,request_id,operation,intent_hash,intent,outcome,result,code)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8)`,
        [
          f.admin.accountId,
          input.payload.clientRequestId,
          input.operation,
          ratingCategoryIconIntentHash(input),
          JSON.stringify(input),
          outcome,
          'result' in receipt ? JSON.stringify(receipt.result) : null,
          'code' in receipt ? receipt.code : null,
        ],
      )
    ).rowCount,
    1,
  );
}
async function holdReview(tx: PoolClient, decisionId: string) {
  const eventId = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_community.rating_approval_events
    (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
    VALUES($1,$2,'held','complete','accepted','synthetic-receipt-fence','synthetic-exact-late-hold',clock_timestamp())`,
    [eventId, decisionId],
  );
  assert.equal(
    (
      await tx.query(
        'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
        [decisionId, eventId],
      )
    ).rowCount,
    1,
  );
}

test(
  'Category receipt generation is immediate; receipt, final generation and original whole-release constraints remain deferred and enabled',
  { timeout: 120000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], { runtime: false });
    t.after(() => f.close());
    const rows = (
      await f.pool.query<{
        relation: string;
        name: string;
        enabled: string;
        deferred: boolean;
        initially: boolean;
        constraint: boolean;
        function_name: string;
      }>(`SELECT c.relname relation,t.tgname name,t.tgenabled enabled,t.tgdeferrable deferred,
      t.tginitdeferred initially,t.tgconstraint<>0 AS constraint,p.proname function_name
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE n.nspname='whaleu_ratings' AND NOT t.tgisinternal
      AND t.tgname IN ('category_icon_receipt_generation','category_icon_receipt_full_boundary',
        'category_icon_final_generation','scoped_catalog_causal')`)
    ).rows;
    for (const [name, relation, deferred] of [
      ['category_icon_receipt_generation', 'requests', false],
      ['category_icon_receipt_full_boundary', 'requests', true],
      ['category_icon_final_generation', 'category_icon_epoch', true],
    ] as const) {
      const matches = rows.filter(
        (row) => row.name === name && row.relation === relation,
      );
      assert.equal(matches.length, 1);
      assert.deepEqual(matches[0], {
        name,
        relation,
        enabled: 'O',
        deferred,
        initially: deferred,
        constraint: deferred,
        function_name: name,
      });
    }
    for (const relation of [
      'scoped_releases',
      'scoped_release_scopes',
      'scoped_catalogs',
      'scoped_catalog_heads',
      'scoped_categories',
      'scoped_category_lineage',
      'scoped_target_memberships',
    ]) {
      assert.deepEqual(
        rows.filter(
          (row) =>
            row.name === 'scoped_catalog_causal' && row.relation === relation,
        ),
        [
          {
            relation,
            name: 'scoped_catalog_causal',
            enabled: 'O',
            deferred: true,
            initially: true,
            constraint: true,
            function_name: 'scoped_catalog_artifact_causal',
          },
        ],
      );
    }
    const functions = (
      await f.pool.query<{ original: string; extension: string }>(`SELECT
      pg_get_functiondef('whaleu_ratings.scoped_catalog_artifact_causal()'::regprocedure) original,
      pg_get_functiondef('whaleu_ratings.verify_scoped_release(uuid)'::regprocedure) extension`)
    ).rows[0]!;
    assert.match(
      functions.original,
      /PERFORM whaleu_ratings\.verify_scoped_release\(NEW\.id\)/,
    );
    assert.match(
      functions.extension,
      /PERFORM whaleu_ratings\.verify_scoped_release_compat\(release\)/,
    );
    assert.match(
      functions.extension,
      /PERFORM whaleu_ratings\.verify_category_icon_release\(release\)/,
    );
  },
);

test(
  'Category raw receipt-only writes and mismatched outcomes fail their exact named deferred fences',
  { timeout: 180000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], { runtime: false });
    t.after(() => f.close());
    const input = await createIntent(f),
      before = await graph(f);
    for (const outcome of ['applied', 'closed'] as const) {
      for (const mode of ['insert', 'update'] as const) {
        let reached = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            const old = await epoch(tx);
            await rawRequest(
              tx,
              f,
              input,
              mode === 'insert' ? wire(input, outcome) : null,
            );
            if (mode === 'update') {
              assert.equal(
                await epoch(tx),
                old,
                'A null claim is not a v5 receipt event',
              );
              assert.equal(
                (
                  await tx.query(
                    `UPDATE whaleu_ratings.requests SET receipt=$3::jsonb
              WHERE account_id=$1 AND request_id=$2`,
                    [
                      f.admin.accountId,
                      input.payload.clientRequestId,
                      JSON.stringify(wire(input, outcome)),
                    ],
                  )
                ).rowCount,
                1,
              );
            }
            assert.equal(
              await epoch(tx),
              old + 1n,
              'Receipt INSERT/UPDATE advances before any deferred flush',
            );
            reached = true;
            await forceReceipt(tx);
            assert.fail(
              'Receipt-only SQL without outcome or cold fence was accepted',
            );
          }),
          (error: unknown) =>
            reached &&
            pgFence(
              error,
              'verify_category_management_command',
              'category_icon_receipt_full_boundary',
            ),
        );
        assert.deepEqual(await graph(f), before);
      }
    }
    for (const receipt of [null, 'closed', 'applied'] as const) {
      let reached = false;
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          await rawRequest(
            tx,
            f,
            input,
            receipt === null ? null : wire(input, receipt),
          );
          await rawOutcome(
            tx,
            f,
            input,
            receipt === 'closed' ? 'applied' : 'closed',
          );
          if (receipt === null) await advance(tx);
          reached = true;
          if (receipt === null) await forceFinal(tx);
          else await forceReceipt(tx);
          assert.fail(
            'Null/closed/applied receipt mismatch passed the named boundary',
          );
        }),
        (error: unknown) =>
          reached &&
          (receipt === null
            ? pgFence(
                error,
                'verify_category_icon_command',
                'category_icon_final_generation',
              )
            : pgFence(
                error,
                'verify_category_management_command',
                'category_icon_receipt_full_boundary',
              )),
      );
      assert.deepEqual(await graph(f), before);
    }
    let reached = false;
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await rawRequest(tx, f, input, wire(input, 'applied'));
        await rawOutcome(tx, f, input, 'applied');
        await forceReceipt(tx); // Exact local bytes alone must not bless success.
        reached = true;
        await forceFinal(tx);
        assert.fail('Raw success without a prepared execution was accepted');
      }),
      (error: unknown) =>
        reached &&
        pgFence(
          error,
          'verify_category_icon_command',
          'category_icon_final_generation',
        ),
    );
    assert.deepEqual(await graph(f), before);
  },
);

test(
  'Category lawful pending preparation and cold cancellation remain valid; incomplete execution cannot hide behind a missing receipt/outcome',
  { timeout: 180000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], { runtime: false });
    t.after(() => f.close());
    const input = await createIntent(f);
    const prepared = await f.prepare(input);
    await f.approveText(input);
    await f.approveIcons(input);
    const keys = [f.admin.accountId, input.payload.clientRequestId];
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2',
          keys,
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
          keys,
        )
      ).rowCount,
      0,
      'A legal pending preparation has its original claim, not an invented finished request',
    );
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await advance(tx);
      await forceFinal(tx);
    });
    const before = await graph(f);
    for (const hasOutcome of [false, true]) {
      let reached = false;
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          await rawRequest(tx, f, input, null);
          // This deliberately incomplete hostile attempt uses only the already
          // persisted real preparation. The unchanged execution guard must admit
          // its genuine before-state proof before the named final seal rejects it.
          assert.equal(
            (
              await tx.query(
                `INSERT INTO whaleu_ratings.scoped_command_causes
          (account_id,request_id,cause_kind,artifact_id,artifact_revision,proof)
          SELECT p.account_id,p.request_id,'category_execution',p.context_id,p.context_id,
            whaleu_ratings.category_icon_execution_proof(p,ip)
          FROM whaleu_ratings.scoped_command_preparations p
          JOIN whaleu_ratings.category_icon_preparations ip ON (ip.actor_id,ip.request_id)=(p.account_id,p.request_id)
          WHERE p.account_id=$1 AND p.request_id=$2`,
                keys,
              )
            ).rowCount,
            1,
          );
          if (hasOutcome) await rawOutcome(tx, f, input, 'closed');
          await advance(tx);
          reached = true;
          await forceFinal(tx);
          assert.fail(
            'Current-transaction execution was skipped because its receipt/outcome was missing',
          );
        }),
        (error: unknown) =>
          reached &&
          pgFence(
            error,
            'verify_category_icon_command',
            'category_icon_final_generation',
          ),
      );
      assert.deepEqual(await graph(f), before);
    }
    const lawful = await f.commit(input, prepared.contextRevision);
    categoryIconHttpOk(lawful);
    assert.equal(
      ratingCategoryIconReceiptSchema.parse(lawful.body).outcome,
      'applied',
    );
    const unknownId = randomUUID(),
      beforeUnknown = await graph(f);
    const unknown = await f.auth(
      request(f.http).get(`/v5/ratings/requests/${unknownId}`),
    );
    assert.equal(unknown.status, 404);
    assert.deepEqual(
      await graph(f),
      beforeUnknown,
      'Unknown recovery does not erase or manufacture owner evidence',
    );
    const cancelled = await f.post('cancel-by-hash', {
      protocolVersion: 5,
      requestId: unknownId,
      operation: input.operation,
      intentHash: 'a'.repeat(64),
    });
    categoryIconHttpOk(cancelled);
    assert.equal(
      ratingCategoryIconReceiptSchema.parse(cancelled.body).outcome,
      'closed',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_recovery_fences WHERE actor_id=$1 AND request_id=$2',
          [f.admin.accountId, unknownId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=$1 AND request_id=$2',
          [f.admin.accountId, unknownId],
        )
      ).rowCount,
      0,
      'A real hash-only cold fence must not invent an outcome or preparation',
    );
  },
);

test(
  'Category epoch refuses reset, self-assignment, recreation, deletion and identity changes at its own immediate guard',
  { timeout: 120000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], { runtime: false });
    t.after(() => f.close());
    const before = await graph(f);
    for (const sql of [
      'UPDATE whaleu_ratings.category_icon_epoch SET epoch=0 WHERE singleton',
      'UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch WHERE singleton',
      'UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch+2 WHERE singleton',
      'UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch+1,singleton=false WHERE singleton',
      'UPDATE whaleu_ratings.category_icon_epoch SET epoch=epoch+1,version=2 WHERE singleton',
      'INSERT INTO whaleu_ratings.category_icon_epoch(singleton,version,epoch) VALUES(true,1,0)',
      'DELETE FROM whaleu_ratings.category_icon_epoch WHERE singleton',
      'TRUNCATE whaleu_ratings.category_icon_epoch',
    ]) {
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(sql);
        }),
        (error: unknown) => pgFence(error, 'category_icon_epoch_guard'),
        sql,
      );
      assert.deepEqual(await graph(f), before);
    }
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await advance(tx);
      await forceFinal(tx);
    });
  },
);

for (const rolledBackGeneration of [false, true]) {
  test(
    `Category ${rolledBackGeneration ? 'same-key savepoint replay' : 'legal epoch advance'} cannot reuse an early seal after a late invalid fact`,
    { timeout: 180000 },
    async (t) => {
      const f = await categoryIconManagementFixture([], { runtime: false });
      t.after(() => f.close());
      const input = await createIntent(f),
        prepared = await f.prepare(input);
      await f.approveText(input);
      const icons = await f.approveIcons(input);
      assert.equal(icons.length, 1);
      const before = await graph(f);
      let earlyPassed = false,
        reached = false;
      await assert.rejects(
        withOwnerTransaction(
          f,
          input,
          prepared.contextRevision,
          async (tx, commit) => {
            const originalEpoch = await epoch(tx),
              checkpoint = checkpointTransactionDeadlines(tx);
            if (rolledBackGeneration)
              await tx.query('SAVEPOINT receipt_generation');
            await commit();
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            earlyPassed = true;
            await tx.query('SET CONSTRAINTS ALL DEFERRED');
            if (rolledBackGeneration) {
              await tx.query('ROLLBACK TO SAVEPOINT receipt_generation');
              // Mirror the original owner's rollback bookkeeping, so the second
              // complete command obtains fresh owner read/mutation capabilities.
              restoreTransactionDeadlines(tx, checkpoint);
              assert.equal(await epoch(tx), originalEpoch);
              assert.equal(
                (
                  await tx.query(
                    'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                    [f.admin.accountId, input.payload.clientRequestId],
                  )
                ).rowCount,
                0,
              );
              await forceFinal(tx); // The rolled-back command's events no longer exist.
              await tx.query('SET CONSTRAINTS ALL DEFERRED');
              await commit(); // Same original key, complete unmodified owner again.
            }
            await advance(tx);
            await holdReview(tx, icons[0]!.decisionId);
            reached = true;
            await forceFinal(tx);
            assert.fail(
              'A late invalid Review fact borrowed an earlier generation seal',
            );
          },
        ),
        (error: unknown) =>
          earlyPassed &&
          reached &&
          pgFence(error, 'category_icon_final_generation'),
      );
      assert.ok(
        earlyPassed && reached,
        'Both the lawful early flush and exact final boundary must be reached',
      );
      assert.deepEqual(await graph(f), before);
      const lawful = await f.commit(input, prepared.contextRevision);
      categoryIconHttpOk(lawful);
      assert.equal(
        ratingCategoryIconReceiptSchema.parse(lawful.body).outcome,
        'applied',
      );
    },
  );
}

test(
  'Category original request and immutable graph DELETE attempts hit their real guards and roll back full image publication',
  { timeout: 300000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 41, height: 37, channels: 3, background: '#516b83' },
    })
      .png()
      .toBuffer();
    const f = await categoryIconManagementFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const upload = await f.ready(
      await createIntent(f),
      { kind: 'new', key: 'root' },
      bytes,
    );
    const prepared = await f.prepare(upload.input);
    await f.approveText(upload.input);
    await f.approveIcons(upload.input);
    const before = await graph(f),
      keys = [f.admin.accountId, upload.input.payload.clientRequestId];
    for (const [sql, guard] of [
      [
        'DELETE FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
        'request_immutable',
      ],
      [
        'DELETE FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2',
        'immutable',
      ],
      [
        'DELETE FROM whaleu_ratings.scoped_command_outcomes WHERE account_id=$1 AND request_id=$2',
        'immutable',
      ],
      [
        "DELETE FROM whaleu_ratings.scoped_source_attestations WHERE payload->'management'->>'accountId'=$1::text AND payload->'management'->>'requestId'=$2::text",
        'immutable',
      ],
      [
        "DELETE FROM whaleu_ratings.scoped_releases WHERE cause->>'accountId'=$1::text AND cause->>'requestId'=$2::text",
        'immutable',
      ],
      [
        'DELETE FROM whaleu_ratings.category_icon_review_bindings WHERE account_id=$1 AND request_id=$2',
        'immutable',
      ],
      [
        'DELETE FROM whaleu_media.bindings WHERE id IN (SELECT a.media_binding_id FROM whaleu_ratings.category_icon_appearances a JOIN whaleu_ratings.category_icon_definitions d ON d.appearance_id=a.id WHERE d.actor_id=$1 AND d.request_id=$2)',
        'guard_mutable_record',
      ],
    ] as const) {
      let reached = false;
      await assert.rejects(
        commandThenSql(
          f,
          upload.input,
          prepared.contextRevision,
          async (tx) => {
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            await tx.query('SET CONSTRAINTS ALL DEFERRED');
            // Prove a real original row is selected; a zero-row DELETE is no proof.
            const selected = sql.replace(/^DELETE FROM /, 'SELECT 1 FROM ');
            assert.ok((await tx.query(selected, keys)).rows.length > 0, sql);
            reached = true;
            await tx.query(sql, keys);
            assert.fail('Original retained owner row was deleted');
          },
        ),
        (error: unknown) => reached && pgFence(error, guard),
      );
      assert.deepEqual(
        await graph(f),
        before,
        `${sql}: request/source/release/Review/Media graph must roll back`,
      );
    }
    const lawful = await f.commit(upload.input, prepared.contextRevision);
    categoryIconHttpOk(lawful);
    assert.equal(
      ratingCategoryIconReceiptSchema.parse(lawful.body).outcome,
      'applied',
    );
  },
);
