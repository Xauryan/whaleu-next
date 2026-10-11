/** Real HTTP / PostgreSQL manifest boundaries. Run only under the parent's
 * exclusive disposable PostgreSQL lease. No trigger is removed or disabled;
 * synthetic Media supplies bytes/verdicts, never owner proofs or receipts. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { DatabaseService } from '../../src/database/database.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
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

const manifestInsert =
  'INSERT INTO whaleu_ratings.category_icon_release_manifests(';
const releaseInsert = 'INSERT INTO whaleu_ratings.scoped_releases(';
const manifestBoundary =
  'SET CONSTRAINTS whaleu_ratings.category_icon_release_row_causal IMMEDIATE';
const finalBoundary =
  'SET CONSTRAINTS whaleu_ratings.category_icon_final_generation IMMEDIATE';
const freshReleaseError =
  'Category icon artifact requires its exact fresh marked release';
const manifestPayloadError =
  'Category icon manifest lacks its exact immutable release payload';

function exactViolation(message: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23514' &&
    'message' in error &&
    error.message === message;
}

/** Include the original owners, not just the extension's projection counts.
 * Every identifier below is a fixed test-owned table name. */
async function publicationState(f: CategoryIconManagementFixture) {
  const tables = [
    'whaleu_ratings.requests',
    'whaleu_ratings.scoped_command_preparations',
    'whaleu_ratings.scoped_command_causes',
    'whaleu_ratings.scoped_command_outcomes',
    'whaleu_ratings.scoped_source_attestations',
    'whaleu_ratings.scoped_source_heads',
    'whaleu_ratings.scoped_source_epoch',
    'whaleu_ratings.scope_protocol_epoch',
    'whaleu_ratings.scope_protocol_versions',
    'whaleu_ratings.scope_protocol_heads',
    'whaleu_ratings.scoped_releases',
    'whaleu_ratings.scoped_release_scopes',
    'whaleu_ratings.scoped_catalogs',
    'whaleu_ratings.scoped_catalog_heads',
    'whaleu_ratings.scoped_categories',
    'whaleu_ratings.scoped_category_lineage',
    'whaleu_ratings.scoped_target_memberships',
    'whaleu_ratings.category_scope_placements',
    'whaleu_ratings.compat_heads',
    'whaleu_ratings.compat_versions',
    'whaleu_ratings.compat_projection_manifests',
    'whaleu_ratings.compat_projection_lineage',
    'whaleu_ratings.catalog_materializations',
    'whaleu_ratings.catalogs',
    'whaleu_ratings.catalog_heads',
    'whaleu_ratings.categories',
    'whaleu_ratings.category_icon_epoch',
    'whaleu_ratings.category_icon_capability_sources',
    'whaleu_ratings.category_icon_preparations',
    'whaleu_ratings.category_icon_upload_scopes',
    'whaleu_ratings.category_icon_upload_authorizations',
    'whaleu_ratings.category_icon_upload_scope_fences',
    'whaleu_ratings.category_icon_recovery_fences',
    'whaleu_ratings.category_icon_definitions',
    'whaleu_ratings.category_icon_definition_heads',
    'whaleu_ratings.category_icon_appearances',
    'whaleu_ratings.category_icon_review_bindings',
    'whaleu_ratings.category_icon_management_review_heads',
    'whaleu_ratings.category_icon_release_manifests',
    'whaleu_ratings.category_icon_projections',
    'whaleu_ratings.category_icon_retirement_queue',
    'whaleu_ratings.category_icon_terminal_retirements',
    'whaleu_community.content_approval_policies',
    'whaleu_community.rating_approval_decisions',
    'whaleu_community.rating_approval_events',
    'whaleu_community.rating_approval_heads',
    'whaleu_community.rating_approval_bindings',
    'whaleu_community.rating_category_base_bindings',
    'whaleu_community.rating_scoped_content_bindings',
    'whaleu_community.rating_scoped_target_definition_bindings',
    'whaleu_community.rating_scoped_category_source_bindings',
    'whaleu_community.rating_review_epoch',
    'whaleu_community.rating_review_binding_epoch',
    'whaleu_media.upload_intents',
    'whaleu_media.category_icon_request_markers',
    'whaleu_media.quota_reservations',
    'whaleu_media.object_attempts',
    'whaleu_media.assets',
    'whaleu_media.variants',
    'whaleu_media.asset_safety_events',
    'whaleu_media.asset_safety_heads',
    'whaleu_media.scope_consumptions',
    'whaleu_media.bindings',
    'whaleu_media.media_owner_states',
    'whaleu_media.jobs',
    'whaleu_media.cleanup_obligations',
  ];
  return (
    await f.pool.query<{ state: unknown }>(
      `SELECT jsonb_object_agg(name,snapshot_rows) state FROM (${tables
        .map(
          (table) => `SELECT '${table}' name,
          coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) snapshot_rows
          FROM ${table} t`,
        )
        .join(' UNION ALL ')}) snapshots`,
    )
  ).rows[0]!.state;
}

type Rewrite = (sql: string, parameters: unknown[] | undefined) => void;
async function withInsertRewrite<T>(
  tx: PoolClient,
  rewrite: Rewrite,
  work: () => Promise<T>,
) {
  const query = tx.query.bind(tx);
  tx.query = (async (sql: string, values?: unknown[]) => {
    const parameters = values ? [...values] : undefined;
    rewrite(sql, parameters);
    return query(sql, parameters);
  }) as typeof tx.query;
  try {
    return await work();
  } finally {
    tx.query = query;
  }
}

/** Execute the real application command inside the guarded fixture transaction,
 * then append SQL before its actual COMMIT. All original owners still run. */
async function commandThenSql(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  contextRevision: string,
  after: (tx: PoolClient, releaseId: string) => Promise<void>,
  rewrite: Rewrite = () => {},
) {
  const database = f.app.get(DatabaseService);
  const original = database.transaction;
  try {
    await withCommunityScopeWriter(f.pool, (tx) =>
      withInsertRewrite(tx, rewrite, async () => {
        database.transaction = async <T>(
          work: (client: PoolClient) => Promise<T>,
        ): Promise<T> => work(tx);
        const receipt = await f.app
          .get(RatingCategoryIconManagementService)
          .commit(f.admin.accessToken, {
            intent: input,
            preparationContextRevision: contextRevision,
          });
        assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
        if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
        assert.ok(receipt.result.releaseId);
        await after(tx, receipt.result.releaseId);
      }),
    );
  } finally {
    database.transaction = original;
  }
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

const zeroRowWriters = [
  `INSERT INTO whaleu_ratings.category_icon_release_manifests
    (release_id,extension_version,digest,row_count,management_coverage,
     scope_extent,root_snapshot,capabilities,serialized_bytes)
   SELECT release_id,extension_version,digest,row_count,management_coverage,
     scope_extent,root_snapshot,capabilities,serialized_bytes
   FROM whaleu_ratings.category_icon_release_manifests WHERE false`,
  'UPDATE whaleu_ratings.category_icon_release_manifests SET digest=digest WHERE false',
  'DELETE FROM whaleu_ratings.category_icon_release_manifests WHERE false',
] as const;

async function writeZeroRows(tx: PoolClient, sql: string) {
  const before = await epoch(tx);
  assert.equal((await tx.query(sql)).rowCount, 0);
  assert.equal(
    await epoch(tx),
    before + 1n,
    'A manifest statement queues a new generation even without a row event',
  );
}

test(
  'Category manifest reverse membership retains the original full release and final-generation fences',
  { timeout: 240000 },
  async (t) => {
    const f = await categoryIconManagementFixture([], { runtime: false });
    t.after(() => f.close());

    await t.test(
      'installed deferred hooks retain both full owners and the narrow reverse check',
      async () => {
        const hooks = (
          await f.pool.query<{
            table_name: string;
            trigger_name: string;
            function_name: string;
            deferred: boolean;
            initially_deferred: boolean;
            enabled: string;
            trigger_type: number;
            body: string;
          }>(`SELECT c.relname table_name,t.tgname trigger_name,p.proname function_name,
          t.tgdeferrable deferred,t.tginitdeferred initially_deferred,t.tgenabled enabled,
          t.tgtype::integer trigger_type,pg_get_functiondef(p.oid) body
          FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE n.nspname='whaleu_ratings' AND NOT t.tgisinternal AND (
            (c.relname='scoped_releases' AND t.tgname IN ('scoped_catalog_causal','scoped_immutable'))
            OR (c.relname='category_icon_release_manifests' AND t.tgname IN
              ('category_icon_release_row_causal','category_icon_immutable','a01_category_icon_epoch'))
            OR (c.relname='category_icon_epoch' AND t.tgname='category_icon_final_generation'))`)
        ).rows;
        assert.equal(hooks.length, 6);
        const hook = (table: string, name: string) => {
          const found = hooks.filter(
            (row) => row.table_name === table && row.trigger_name === name,
          );
          assert.equal(found.length, 1);
          assert.equal(found[0]!.enabled, 'O');
          return found[0]!;
        };
        const original = hook('scoped_releases', 'scoped_catalog_causal');
        const reverse = hook(
          'category_icon_release_manifests',
          'category_icon_release_row_causal',
        );
        const final = hook(
          'category_icon_epoch',
          'category_icon_final_generation',
        );
        for (const boundary of [original, reverse, final]) {
          assert.equal(boundary.deferred, true);
          assert.equal(boundary.initially_deferred, true);
        }
        assert.equal(original.function_name, 'scoped_catalog_artifact_causal');
        assert.match(original.body, /verify_scoped_release\(NEW\.id\)/);
        const owner = (
          await f.pool.query<{ body: string }>(
            `SELECT pg_get_functiondef('whaleu_ratings.verify_scoped_release(uuid)'::regprocedure) body`,
          )
        ).rows[0]!.body;
        for (const retained of [
          'Release affected set or exact source vector incomplete',
          'Scoped whole-release admission exceeded',
          'verify_scoped_catalog(item.after_catalog_id)',
          'verify_scoped_command(',
          'verify_scoped_release_compat(release)',
          'verify_category_icon_release(release)',
        ])
          assert.ok(
            owner.includes(retained),
            `Original release retains ${retained}`,
          );
        const manifestBranch = reverse.body
          .split("IF TG_TABLE_NAME='category_icon_release_manifests' THEN")[1]
          ?.split('RETURN NULL;END IF;')[0];
        assert.ok(manifestBranch);
        assert.match(
          manifestBranch,
          /r\.publication_transaction=pg_current_xact_id\(\)/,
        );
        assert.match(
          manifestBranch,
          /NEW\.publication_transaction=r\.publication_transaction/,
        );
        assert.match(manifestBranch, /categoryIconExtension/);
        assert.match(
          manifestBranch,
          /r\.cause->>'categoryIconDigest'=NEW\.digest/,
        );
        assert.match(
          manifestBranch,
          /category_icon_release_payload_valid\(r\.id\)/,
        );
        assert.doesNotMatch(
          manifestBranch,
          /PERFORM whaleu_ratings\.verify_scoped_release/,
        );
        assert.match(final.body, /NEW\.epoch<>current_epoch/);
        assert.match(final.body, /verify_category_icon_command\(/);
        assert.match(final.body, /category_icon_final_roots\(/);
        assert.match(
          final.body,
          /verify_category_icon_release\(publication\.id\)/,
        );
        const statement = hook(
          'category_icon_release_manifests',
          'a01_category_icon_epoch',
        );
        assert.equal(statement.function_name, 'advance_category_icon_epoch');
        assert.equal(
          statement.trigger_type,
          62,
          'BEFORE STATEMENT INSERT/UPDATE/DELETE/TRUNCATE',
        );
        assert.match(statement.body, /SET epoch=epoch\+1/);
        for (const immutable of [
          hook('scoped_releases', 'scoped_immutable'),
          hook('category_icon_release_manifests', 'category_icon_immutable'),
        ]) {
          assert.equal(immutable.function_name, 'immutable');
          assert.equal(immutable.trigger_type, 27, 'BEFORE ROW UPDATE/DELETE');
          assert.match(immutable.body, /Rating record is immutable/);
        }
      },
    );

    // Registration alone does not adopt an extension. An actual empty reorder
    // is text-noop but must publish its first Category extension generation.
    const adoption = await f.execute(
      f.intent(await f.context(), 'reorder_categories_scoped', {
        parentId: null,
        action: 'set',
        orderedIds: [],
      }),
    );
    assert.equal(adoption.receipt.outcome, 'applied');
    assert.equal(adoption.prepared.changedIconCount, 0);
    const prior = await f.publish();
    assert.equal(
      (
        await f.pool.query<{ valid: boolean }>(
          'SELECT whaleu_ratings.category_icon_release_payload_valid($1) valid',
          [prior.releaseId],
        )
      ).rows[0]!.valid,
      true,
    );

    for (const transaction of ['fresh', 'historical'] as const) {
      await t.test(
        `raw manifest-only INSERT cannot borrow a validated historical release with ${transaction} transaction bytes`,
        async () => {
          const before = await publicationState(f);
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              // This is the only DML in the attempt. Copy an actual immutable
              // payload, including its exact digest; do not fabricate a release.
              await tx.query(
                `INSERT INTO whaleu_ratings.category_icon_release_manifests
               (release_id,extension_version,digest,row_count,management_coverage,
                scope_extent,root_snapshot,capabilities,serialized_bytes,publication_transaction)
               SELECT release_id,extension_version,digest,row_count,management_coverage,
                scope_extent,root_snapshot,capabilities,serialized_bytes,
                ${transaction === 'fresh' ? 'pg_current_xact_id()' : 'publication_transaction'}
               FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=$1`,
                [prior.releaseId],
              );
              assert.fail(
                'A historical release cannot authorize a raw manifest append',
              );
            }),
            exactViolation(freshReleaseError),
            'The fresh-release guard must reject before a duplicate primary-key error',
          );
          assert.deepEqual(await publicationState(f), before);
        },
      );
    }

    for (const attack of [
      'wrong-release',
      'missing-extension-cause',
      'wrong-cause-digest',
      'wrong-manifest-digest',
      'wrong-scope-cause',
    ] as const) {
      await t.test(
        `genuine empty publication rejects ${attack} at its exact manifest boundary`,
        async () => {
          const before = await publicationState(f);
          const immediate =
            attack === 'wrong-release' || attack === 'missing-extension-cause';
          let rewritten = 0;
          let manifestAttempted = false;
          let boundaryReached = false;
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              withInsertRewrite(
                tx,
                (sql, parameters) => {
                  if (
                    sql.startsWith(releaseInsert) &&
                    [
                      'missing-extension-cause',
                      'wrong-cause-digest',
                      'wrong-scope-cause',
                    ].includes(attack)
                  ) {
                    assert.ok(parameters);
                    const cause = JSON.parse(String(parameters[3])) as Record<
                      string,
                      unknown
                    >;
                    assert.equal(
                      cause['categoryIconExtension'],
                      'ratings-category-icon-v1',
                    );
                    if (attack === 'missing-extension-cause')
                      delete cause['categoryIconExtension'];
                    else if (attack === 'wrong-cause-digest') {
                      assert.notEqual(
                        cause['categoryIconDigest'],
                        '0'.repeat(64),
                      );
                      cause['categoryIconDigest'] = '0'.repeat(64);
                    } else cause['categoryIconScopeKeys'] = [];
                    parameters[3] = canonicalJson(cause);
                    rewritten++;
                  }
                  if (sql.startsWith(manifestInsert)) {
                    manifestAttempted = true;
                    assert.ok(parameters);
                    assert.equal(
                      parameters[2],
                      0,
                      'Use a genuine empty release to isolate the manifest hook from projection guards',
                    );
                    if (attack === 'wrong-release') {
                      parameters[0] = prior.releaseId;
                      rewritten++;
                    } else if (attack === 'wrong-manifest-digest') {
                      assert.notEqual(parameters[1], '0'.repeat(64));
                      parameters[1] = '0'.repeat(64);
                      rewritten++;
                    }
                  }
                },
                async () => {
                  await f.publish({}, tx);
                  assert.equal(
                    immediate,
                    false,
                    'The row guard must reject this INSERT immediately',
                  );
                  boundaryReached = true;
                  await tx.query(manifestBoundary);
                  assert.fail(`Manifest reverse hook accepted ${attack}`);
                },
              ),
            ),
            (error: unknown) =>
              rewritten === 1 &&
              manifestAttempted &&
              boundaryReached === !immediate &&
              exactViolation(
                immediate ? freshReleaseError : manifestPayloadError,
              )(error),
          );
          assert.equal(rewritten, 1);
          assert.equal(manifestAttempted, true);
          assert.deepEqual(
            await publicationState(f),
            before,
            'Original release, sources, compatibility and extension all roll back',
          );
        },
      );
    }
  },
);

test(
  'Category image manifests remain immutable after early seals and revalidate reused final generations',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 61, height: 47, channels: 3, background: '#235c81' },
    })
      .png()
      .toBuffer();
    const f = await categoryIconManagementFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const input = f.intent(await f.context(), 'create_categories_scoped', {
      parentId: null,
      placement: { kind: 'global' },
      nodes: [
        {
          key: 'root',
          parentKey: null,
          name: 'Manifest fence category',
          description: 'Original owner image publication',
          icon: { mode: 'clear' },
        },
      ],
    });
    const upload = await f.ready(input, { kind: 'new', key: 'root' }, bytes);
    const prepared = await f.prepare(upload.input);
    await f.approveText(upload.input);
    await f.approveIcons(upload.input);
    const before = await publicationState(f);

    await t.test(
      'a complete real image command cannot omit its recoverable manifest coverage',
      async () => {
        let rewritten = 0;
        let boundaryReached = false;
        await assert.rejects(
          commandThenSql(
            f,
            upload.input,
            prepared.contextRevision,
            async (tx, releaseId) => {
              assert.equal(
                (
                  await tx.query<{ n: number }>(
                    'SELECT count(*)::integer n FROM whaleu_ratings.category_icon_projections WHERE release_id=$1',
                    [releaseId],
                  )
                ).rows[0]!.n,
                1,
              );
              boundaryReached = true;
              await tx.query(manifestBoundary);
              assert.fail(
                'The reverse payload seal accepted missing management coverage',
              );
            },
            (sql, parameters) => {
              if (!sql.startsWith(manifestInsert)) return;
              assert.ok(parameters);
              const coverage = JSON.parse(String(parameters[7])) as unknown[];
              assert.equal(
                coverage.length,
                1,
                'The real image has one exact global management slot',
              );
              parameters[7] = '[]';
              rewritten++;
            },
          ),
          (error: unknown) =>
            rewritten === 1 &&
            boundaryReached &&
            exactViolation(manifestPayloadError)(error),
        );
        assert.deepEqual(
          await publicationState(f),
          before,
          'Source/placement/receipt, original Review, Review8 and Media bindings all roll back',
        );
      },
    );

    for (const attack of [
      'manifest-digest',
      'management-coverage',
      'manifest-delete',
    ] as const) {
      await t.test(
        `early SET CONSTRAINTS cannot authorize later ${attack}`,
        async () => {
          let earlyPassed = false;
          let mutationReached = false;
          await assert.rejects(
            commandThenSql(
              f,
              upload.input,
              prepared.contextRevision,
              async (tx, releaseId) => {
                await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
                earlyPassed = true;
                const row = (
                  await tx.query<{ coverage: number; valid: boolean }>(
                    `SELECT jsonb_array_length(management_coverage) coverage,
                whaleu_ratings.category_icon_release_payload_valid(release_id) valid
               FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=$1`,
                    [releaseId],
                  )
                ).rows[0];
                assert.deepEqual(row, { coverage: 1, valid: true });
                mutationReached = true;
                await tx.query(
                  attack === 'manifest-digest'
                    ? `UPDATE whaleu_ratings.category_icon_release_manifests SET digest=repeat('0',64) WHERE release_id=$1`
                    : attack === 'management-coverage'
                      ? `UPDATE whaleu_ratings.category_icon_release_manifests SET management_coverage='[]'::jsonb WHERE release_id=$1`
                      : 'DELETE FROM whaleu_ratings.category_icon_release_manifests WHERE release_id=$1',
                  [releaseId],
                );
                assert.fail('An early verified manifest is still immutable');
              },
            ),
            (error: unknown) =>
              earlyPassed &&
              mutationReached &&
              exactViolation('Rating record is immutable')(error),
          );
          assert.equal(earlyPassed, true);
          assert.equal(mutationReached, true);
          assert.deepEqual(
            await publicationState(f),
            before,
            'Rejecting the late write rolls back the complete real owner/source/release/Review/Media graph',
          );
        },
      );
    }

    // The same genuine upload/preparation remains usable after all rollbacks.
    const committed = await f.commit(upload.input, prepared.contextRevision);
    categoryIconHttpOk(committed);
    const receipt = ratingCategoryIconReceiptSchema.parse(committed.body);
    if (receipt.outcome !== 'applied') assert.fail(JSON.stringify(receipt));
    const categoryId = receipt.result.categoryIds[0]!;
    assert.ok(
      (await f.publicPage()).page.items.find((item) => item.id === categoryId)
        ?.icon,
    );

    await t.test(
      'zero-row manifest writers and a rolled-back consumed generation cannot cache validation',
      async () => {
        const stable = await publicationState(f);
        let earlyPassed = false;
        let sameGenerationReused = false;
        let boundaryReached = false;
        await assert.rejects(
          withCommunityScopeWriter(f.pool, async (tx) => {
            // Carry the real committed image through the genuine original
            // publisher. This transaction has no new command whose row hook
            // could accidentally supply the expected final-generation rejection.
            const publication = await f.publish({}, tx);
            await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
            earlyPassed = true;
            await tx.query('SET CONSTRAINTS ALL DEFERRED');
            const decision = (
              await tx.query<{ decision_id: string }>(
                `SELECT b.decision_id FROM whaleu_ratings.category_icon_projections p
             JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id
             WHERE p.release_id=$1 AND p.category_id=$2`,
                [publication.releaseId, categoryId],
              )
            ).rows;
            assert.equal(decision.length, 1);
            const savedEpoch = await epoch(tx);
            await tx.query('SAVEPOINT consumed_manifest_generation');
            for (const sql of zeroRowWriters) await writeZeroRows(tx, sql);
            const consumedEpoch = await epoch(tx);
            assert.equal(consumedEpoch, savedEpoch + 3n);
            await tx.query(finalBoundary);
            await tx.query(
              'SET CONSTRAINTS whaleu_ratings.category_icon_final_generation DEFERRED',
            );
            await tx.query(
              'ROLLBACK TO SAVEPOINT consumed_manifest_generation',
            );
            assert.equal(await epoch(tx), savedEpoch);

            // A legal event and head replacement each advance the Review epoch;
            // the zero-row manifest UPDATE supplies the third generation. Reuse
            // the exact previously consumed number with different current facts.
            const eventId = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_community.rating_approval_events
             (id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
             VALUES($1,$2,'held','complete','accepted','synthetic-manifest-fence-review',
               'synthetic-exact-manifest-review-hold',clock_timestamp())`,
              [eventId, decision[0]!.decision_id],
            );
            assert.equal(
              (
                await tx.query(
                  'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
                  [decision[0]!.decision_id, eventId],
                )
              ).rowCount,
              1,
            );
            await writeZeroRows(tx, zeroRowWriters[1]);
            assert.equal(await epoch(tx), consumedEpoch);
            sameGenerationReused = true;
            assert.equal(
              (
                await tx.query<{ valid: boolean }>(
                  'SELECT whaleu_ratings.category_icon_release_payload_valid($1) valid',
                  [publication.releaseId],
                )
              ).rows[0]!.valid,
              true,
              'Immutable release membership stays valid; current Review requires the full final generation',
            );
            boundaryReached = true;
            await tx.query(finalBoundary);
            assert.fail(
              'A rolled-back successful generation cannot bless new held Review facts',
            );
          }),
          (error: unknown) =>
            earlyPassed &&
            sameGenerationReused &&
            boundaryReached &&
            exactViolation('Category icon release Review8 is not current')(
              error,
            ),
        );
        assert.equal(earlyPassed, true);
        assert.equal(sameGenerationReused, true);
        assert.equal(boundaryReached, true);
        assert.deepEqual(
          await publicationState(f),
          stable,
          'Review event/head, all epochs, original release/compat graph and Media remain unchanged',
        );
        const lawful = await f.publish();
        assert.equal(
          (
            await f.pool.query<{ valid: boolean }>(
              'SELECT whaleu_ratings.category_icon_release_payload_valid($1) valid',
              [lawful.releaseId],
            )
          ).rows[0]!.valid,
          true,
        );
      },
    );
  },
);
