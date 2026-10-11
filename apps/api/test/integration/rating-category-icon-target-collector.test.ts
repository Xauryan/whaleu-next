/** Real PostgreSQL collector regressions. Run only under the parent's exclusive
 * disposable database lease. The original service, release compiler, Review,
 * Media, SQL guards and final transaction validators are never replaced. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { canonicalRatingScopedEnvelope } from '../../src/community/content-review/rating-scoped-contracts.js';
import { DatabaseService, inTransaction } from '../../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
  transactionReadEpoch,
} from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  beginCategoryIconTargetMutation,
  beginCategoryIconMutation,
  consumeCategoryIconTargetPublication,
  finishCategoryIconMutation,
  retainCategoryIconState,
  type CategoryIconMutation,
} from '../../src/ratings/category-management/icon-proof.js';
import { RatingScopedCommands } from '../../src/ratings/scoped/commands.service.js';
import { ratingScopedEditContextSchema } from '../../src/ratings/scoped/controller.js';
import {
  ratingScopedIntentSchema,
  ratingScopedPreparationSchema,
} from '../../src/ratings/scoped/contracts.js';
import { RatingScopedReleaseRepository } from '../../src/ratings/scoped/release.repository.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  scopedCommandContext,
  scopedSuccess,
} from '../support/rating-scoped-command-fixture.js';

const unavailable = (error: unknown) =>
  error instanceof ApplicationError &&
  error.code === 'RATING_SCOPE_UNAVAILABLE';

/** Retain complete original command artifacts as well as Category/Media rows.
 * Even an unresolved request or execution cause must roll back here. */
async function graph(f: CategoryIconManagementFixture) {
  const tables = [
    'scoped_catalog_heads',
    'scoped_releases',
    'scoped_release_scopes',
    'scoped_catalogs',
    'scoped_categories',
    'scoped_category_lineage',
    'scoped_target_memberships',
    'scoped_source_attestations',
    'scoped_source_heads',
    'scoped_source_epoch',
    'targets',
    'target_sources',
    'target_creations',
    'target_scope_placements',
    'target_origin_sources',
    'target_origin_heads',
    'target_definition_versions',
    'target_definition_heads',
    'target_definition_lifecycles',
    'target_state_revisions',
    'score_baselines',
    'subscription_baselines',
    'effect_events',
    'requests',
    'scoped_command_preparations',
    'scoped_command_causes',
    'scoped_command_outcomes',
  ];
  const original = (
    await f.pool.query<{ state: unknown }>(
      `SELECT jsonb_build_object(${tables
        .map(
          (table) =>
            `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM whaleu_ratings.${table} r)`,
        )
        .join(',')},
    'review',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)
      FROM whaleu_community.rating_scoped_target_definition_bindings r)) state`,
    )
  ).rows[0]!.state;
  return { original, categoryAndMedia: await f.artifacts() };
}

/** Change only the transaction entrypoint so a real outer caller can perform a
 * read before the unchanged original service runs. The fixture wrapper retains
 * real BEGIN, safety policy locking, deferred checks, mandatory proofs, COMMIT
 * and ROLLBACK; no fake transaction, cached flag or SQL guard is introduced. */
async function withOriginalServiceTransaction<T>(
  f: CategoryIconManagementFixture,
  run: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const database = f.app.get(DatabaseService),
    original = database.transaction;
  try {
    return await withCommunityScopeWriter(f.pool, async (tx) => {
      database.transaction = async <Result>(
        work: (client: PoolClient) => Promise<Result>,
      ) => work(tx);
      return run(tx);
    });
  } finally {
    database.transaction = original;
  }
}

test(
  'original target Category collectors preserve outer reads and bind one publication to one transaction',
  { timeout: 300000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 37, height: 29, channels: 3, background: '#3e8197' },
    })
      .png()
      .toBuffer();
    const f = await categoryIconManagementFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      commands = f.app.get(RatingScopedCommands);
    await f.atomicChange((tx) =>
      f.issueSource(
        {
          kind: 'native_scoped_create',
          key: 'synthetic-native-scoped-create',
          scopeKeys: f.scopeKeys,
          payload: {
            enabled: true,
            genericKind: 'general',
            scopeKeys: [...f.scopeKeys].sort(),
          },
        },
        tx,
      ),
    );
    const tree = f.intent(await f.context(), 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'global' },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Collector root',
          description: '',
          icon: { mode: 'clear' },
        },
        {
          key: 'middle',
          parentKey: 'root',
          name: 'Collector middle',
          description: '',
          icon: { mode: 'clear' },
        },
        {
          key: 'leaf',
          parentKey: 'middle',
          name: 'Collector leaf',
          description: '',
          icon: { mode: 'clear' },
        },
      ],
    });
    const upload = await f.ready(tree, { kind: 'new', key: 'middle' }, bytes);
    await f.execute(upload.input);
    const path = (
      await f.pool.query<{
        id: string;
        parent_id: string | null;
        level: number;
      }>(
        `SELECT c.category_id id,c.parent_id,c.level FROM whaleu_ratings.scoped_catalog_heads h
       JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=h.catalog_id
       WHERE h.scope_key='global' ORDER BY c.level`,
      )
    ).rows;
    assert.equal(path.length, 3);
    const [root, middle, leaf] = path;
    assert.ok(root && middle && leaf);
    assert.equal(root.parent_id, null);
    assert.equal(middle.parent_id, root.id);
    assert.equal(leaf.parent_id, middle.id);
    assert.deepEqual(
      path.map((row) => row.level),
      [1, 2, 3],
    );
    const keys = ['global'];
    const prepare = async () => {
      const context = await f.scopedContext(
        actor,
        { kind: 'global' },
        'create_target',
      );
      const category = (
        await f.pool.query<{ effective_revision: string }>(
          'SELECT effective_revision FROM whaleu_ratings.scoped_categories WHERE catalog_id=$1 AND category_id=$2',
          [context.heads[0]!.catalogRevision, leaf.id],
        )
      ).rows[0];
      assert.ok(category);
      const input = ratingScopedIntentSchema.parse({
        protocolVersion: 2,
        operation: 'create_target_scoped',
        context: scopedCommandContext(context),
        payload: {
          clientRequestId: randomUUID(),
          categoryId: leaf.id,
          expectedCategoryRevision: category.effective_revision,
          name: 'A target below the real middle icon',
          description: 'Collector ownership regression',
          assetIds: [],
        },
      });
      const response = await f
        .auth(request(f.http).post('/v2/ratings/management/prepare'), actor)
        .send(input);
      categoryIconHttpOk(response);
      const prepared = ratingScopedPreparationSchema.parse(response.body);
      const stored = (
        await f.pool.query<{ envelope: unknown; intent_hash: string }>(
          'SELECT envelope,intent_hash FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
          [actor.accountId, input.payload.clientRequestId],
        )
      ).rows[0];
      assert.ok(stored?.envelope);
      await f.approveScoped(canonicalRatingScopedEnvelope(stored.envelope));
      return { input, prepared, hash: stored.intent_hash };
    };
    type Pending = Awaited<ReturnType<typeof prepare>>;
    const submit = (pending: Pending) =>
      commands.submit(
        actor.accessToken,
        pending.input,
        pending.prepared.contextRevision,
      );
    const targetInput = (
      pending: Pending,
      operation: 'create_target_scoped' | 'edit_target_scoped' = pending.input
        .operation === 'create_target_scoped'
        ? 'create_target_scoped'
        : 'edit_target_scoped',
    ) => ({
      actor: actor.accountId,
      request: pending.input.payload.clientRequestId,
      hash: pending.hash,
      operation,
      scopeKeys: keys,
    });

    for (const rollback of [false, true]) {
      await t.test(
        `an independent outer Category read survives ${rollback ? 'savepoint rollback and ' : ''}a legitimate target self-publication`,
        async () => {
          const pending = await prepare(),
            before = await graph(f);
          let appliedInside = false;
          await assert.rejects(
            withOriginalServiceTransaction(f, async (tx) => {
              // This immutable fingerprint is captured before the original target's
              // pre-read collector. Its old head/epoch cannot be silently adopted.
              await retainCategoryIconState(['global'], tx);
              if (rollback) {
                const checkpoint = checkpointTransactionDeadlines(tx);
                await tx.query('SAVEPOINT independent_outer_read');
                const abandoned = await beginCategoryIconTargetMutation(
                  targetInput(pending, 'create_target_scoped'),
                  tx,
                );
                await retainCategoryIconState(['global'], tx);
                await tx.query('ROLLBACK TO SAVEPOINT independent_outer_read');
                restoreTransactionDeadlines(tx, checkpoint);
                await assert.rejects(
                  finishCategoryIconMutation(abandoned, tx),
                  unavailable,
                );
                await tx.query('RELEASE SAVEPOINT independent_outer_read');
              }
              const receipt = scopedSuccess(await submit(pending));
              appliedInside = true;
              assert.ok(receipt.result['targetId']);
              assert.equal(
                (
                  await tx.query(
                    'SELECT 1 FROM whaleu_ratings.targets WHERE id=$1',
                    [receipt.result['targetId']],
                  )
                ).rowCount,
                1,
                'The legitimate original target really wrote before final rejection',
              );
            }),
            unavailable,
          );
          assert.equal(
            appliedInside,
            true,
            'Failure must be the final outer read fence, not an earlier command refusal',
          );
          assert.deepEqual(
            await graph(f),
            before,
            'All target, publication, Review, Category and Media facts roll back',
          );
          const retried = scopedSuccess(await submit(pending));
          assert.equal(
            retried.requestId,
            pending.input.payload.clientRequestId,
            'The identical prepared key remains usable after the rejected outer transaction',
          );
        },
      );
    }

    let createdTarget = '';
    await t.test(
      'only the exact original create can borrow the collector once',
      async () => {
        const pending = await prepare(),
          releases = f.app.get(RatingScopedReleaseRepository);
        const original = releases.publish;
        let checked = 0;
        releases.publish = async function (proof, cause, tx) {
          assert.equal(cause.kind, 'create_target_scoped');
          const exact = {
            kind: 'create_target_scoped',
            accountId: actor.accountId,
            requestId: pending.input.payload.clientRequestId,
          };
          const actualKeys = [...proof.scopeKeys].sort();
          assert.deepEqual(actualKeys, keys);
          const wrongCauses = [
            undefined,
            { ...exact, kind: 'category_icon_management' },
            { ...exact, accountId: randomUUID() },
            { ...exact, requestId: randomUUID() },
          ];
          for (const wrong of wrongCauses)
            await assert.rejects(
              consumeCategoryIconTargetPublication(
                randomUUID(),
                actualKeys,
                wrong,
                tx,
              ),
              unavailable,
            );
          for (const wrongKeys of [
            [],
            ['campus:unrelated'],
            [...actualKeys, 'campus:unrelated'],
            [...actualKeys, ...actualKeys],
          ])
            await assert.rejects(
              consumeCategoryIconTargetPublication(
                randomUUID(),
                wrongKeys,
                exact,
                tx,
              ),
              unavailable,
            );
          // Exercise an actual competing original publisher as well as exact-key
          // helper negatives. It still runs compiler/source/capability checks.
          await assert.rejects(
            original.call(
              releases,
              proof,
              {
                kind: 'category_management',
                accountId: actor.accountId,
                requestId: exact.requestId,
              },
              tx,
            ),
            unavailable,
          );
          const publication = await original.call(releases, proof, cause, tx);
          await assert.rejects(
            consumeCategoryIconTargetPublication(
              publication.releaseId,
              actualKeys,
              exact,
              tx,
            ),
            unavailable,
          );
          await assert.rejects(
            consumeCategoryIconTargetPublication(
              randomUUID(),
              actualKeys,
              exact,
              tx,
            ),
            unavailable,
          );
          await assert.rejects(
            original.call(releases, proof, cause, tx),
            unavailable,
            'A second genuine publisher cannot reuse the one consumed create capability',
          );
          checked++;
          return publication;
        };
        try {
          const receipt = scopedSuccess(await submit(pending));
          assert.ok(receipt.result['targetId']);
          createdTarget = String(receipt.result['targetId']);
          assert.equal(checked, 1);
        } finally {
          releases.publish = original;
        }
      },
    );

    const createLifetime = await prepare();
    const editContext = await f.scopedContext(
      actor,
      { kind: 'global' },
      'edit_target',
    );
    const detailResponse = await f
      .auth(
        request(f.http).get(
          `/v2/ratings/management/owner-edit/targets/${createdTarget}/context`,
        ),
        actor,
      )
      .query({ contextId: editContext.id, contextToken: editContext.token });
    categoryIconHttpOk(detailResponse);
    const detail = ratingScopedEditContextSchema.parse(detailResponse.body);
    const editInput = ratingScopedIntentSchema.parse({
      protocolVersion: 2,
      operation: 'edit_target_scoped',
      context: scopedCommandContext(editContext),
      payload: {
        clientRequestId: randomUUID(),
        targetId: createdTarget,
        expectedTargetRevision: detail.revision,
        expectedDefinitionRevision: detail.definitionRevision,
        expectedContentVersion: detail.contentVersion,
        categoryId: detail.categoryId,
        expectedCategoryRevision: detail.categoryRevision,
        name: `${detail.name} edited`,
        description: detail.description,
        assetIds: [],
      },
    });
    const editResponse = await f
      .auth(
        request(f.http).post('/v2/ratings/management/owner-edit/prepare'),
        actor,
      )
      .send(editInput);
    categoryIconHttpOk(editResponse);
    const editStored = (
      await f.pool.query<{ envelope: unknown; intent_hash: string }>(
        'SELECT envelope,intent_hash FROM whaleu_ratings.scoped_command_preparations WHERE account_id=$1 AND request_id=$2',
        [actor.accountId, editInput.payload.clientRequestId],
      )
    ).rows[0];
    assert.ok(editStored?.envelope);
    await f.approveScoped(canonicalRatingScopedEnvelope(editStored.envelope));
    const lifetime: Pending = {
      input: editInput,
      prepared: ratingScopedPreparationSchema.parse(editResponse.body),
      hash: editStored.intent_hash,
    };
    const collect = async (
      tx: PoolClient,
      operation?: 'create_target_scoped' | 'edit_target_scoped',
    ) => {
      const capability = operation
        ? await beginCategoryIconTargetMutation(
            targetInput(
              operation === 'create_target_scoped' ? createLifetime : lifetime,
              operation,
            ),
            tx,
          )
        : await beginCategoryIconMutation(tx);
      await retainCategoryIconState(['global'], tx);
      return capability;
    };
    await t.test(
      'an unfinished collector rejects commit even with no Category data write',
      async () => {
        const before = await graph(f);
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            await collect(tx, 'edit_target_scoped');
          }),
          unavailable,
        );
        assert.deepEqual(await graph(f), before);
      },
    );
    await t.test(
      'a create collector cannot finish without its original execution and publication',
      async () => {
        const before = await graph(f);
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            const capability = await collect(tx, 'create_target_scoped');
            // The real persisted preparation alone cannot supply execution cause.
            await assert.rejects(
              consumeCategoryIconTargetPublication(
                randomUUID(),
                keys,
                {
                  kind: 'create_target_scoped',
                  accountId: actor.accountId,
                  requestId: createLifetime.input.payload.clientRequestId,
                },
                tx,
              ),
              unavailable,
            );
            await finishCategoryIconMutation(capability, tx);
          }),
          unavailable,
        );
        assert.deepEqual(await graph(f), before);
      },
    );
    await t.test(
      'a prepared edit alone cannot finish without its exact execution outcome and receipt',
      async () => {
        const before = await graph(f);
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            const capability = await collect(tx, 'edit_target_scoped');
            await finishCategoryIconMutation(capability, tx);
          }),
          unavailable,
        );
        assert.deepEqual(await graph(f), before);
      },
    );
    await t.test(
      'finishing twice, reading after finish and beginning twice are rejected',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const capability = await collect(tx);
          await assert.rejects(
            beginCategoryIconTargetMutation(targetInput(lifetime), tx),
            unavailable,
          );
          await finishCategoryIconMutation(capability, tx);
          await assert.rejects(
            finishCategoryIconMutation(capability, tx),
            unavailable,
          );
          await assert.rejects(
            retainCategoryIconState(['global'], tx),
            unavailable,
          );
          await assert.rejects(
            beginCategoryIconTargetMutation(targetInput(lifetime), tx),
            unavailable,
          );
        });
      },
    );
    await t.test(
      'a capability cannot finish on another actual PostgreSQL client',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const capability = await collect(tx);
          await inTransaction(
            f.pool,
            async (other) => {
              assert.notEqual(other, tx);
              await assert.rejects(
                finishCategoryIconMutation(capability, other),
                unavailable,
              );
              assert.equal(
                await consumeCategoryIconTargetPublication(
                  randomUUID(),
                  keys,
                  {
                    kind: 'create_target_scoped',
                    accountId: actor.accountId,
                    requestId: lifetime.input.payload.clientRequestId,
                  },
                  other,
                ),
                false,
                'A different transaction receives no borrowed target authority',
              );
            },
            { isolationLevel: 'read committed' },
          );
          await finishCategoryIconMutation(capability, tx);
        });
      },
    );
    await t.test(
      'real savepoint rollback invalidates a collected capability and permits a fresh lifetime',
      async () => {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          const checkpoint = checkpointTransactionDeadlines(tx),
            beforeEpoch = transactionReadEpoch(tx);
          await tx.query('SAVEPOINT target_collector_lifetime');
          const abandoned = await collect(tx);
          await tx.query('ROLLBACK TO SAVEPOINT target_collector_lifetime');
          restoreTransactionDeadlines(tx, checkpoint);
          assert.notEqual(transactionReadEpoch(tx), beforeEpoch);
          await assert.rejects(
            finishCategoryIconMutation(abandoned, tx),
            unavailable,
          );
          assert.equal(
            await consumeCategoryIconTargetPublication(
              randomUUID(),
              keys,
              {
                kind: 'create_target_scoped',
                accountId: actor.accountId,
                requestId: lifetime.input.payload.clientRequestId,
              },
              tx,
            ),
            false,
          );
          const fresh = await collect(tx);
          await finishCategoryIconMutation(fresh, tx);
          await assert.rejects(
            finishCategoryIconMutation(abandoned, tx),
            unavailable,
          );
          await tx.query('RELEASE SAVEPOINT target_collector_lifetime');
        });
      },
    );
    await t.test(
      'a capability from a committed transaction cannot be revived in the next transaction',
      async () => {
        let completed: CategoryIconMutation | undefined;
        await withCommunityScopeWriter(f.pool, async (tx) => {
          completed = await collect(tx);
          await finishCategoryIconMutation(completed, tx);
        });
        assert.ok(completed);
        await inTransaction(
          f.pool,
          async (tx) => {
            await assert.rejects(
              finishCategoryIconMutation(completed!, tx),
              unavailable,
            );
          },
          { isolationLevel: 'read committed' },
        );
      },
    );
  },
);
