import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import type { Pool, PoolClient } from 'pg';
import {
  ratingScopedCommandFixture,
  scopedSuccess,
  type RatingScopedCommandFixture,
} from '../support/rating-scoped-command-fixture.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import {
  appendTopologyRevision,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { ratingScopedContextSchema } from '../../src/ratings/scoped/contracts.js';

// Explicit registry: a missing registration cannot disappear behind discovery.
// Context/command records do not pretend to advance public source/space epochs.
type Epoch = 'source' | 'protocol' | 'pool' | 'navigation' | 'binding';
const publicEpochs: Epoch[] = ['pool', 'navigation'];
const sourceEpochs: Epoch[] = ['source', ...publicEpochs];
const protocolEpochs: Epoch[] = ['protocol', ...sourceEpochs];
const registry: Array<{ table: string; column: string; epochs: Epoch[] }> = [
  { table: 'scoped_source_attestations', column: 'id', epochs: sourceEpochs },
  { table: 'scoped_source_heads', column: 'source_id', epochs: sourceEpochs },
  { table: 'legacy_adoption_manifests', column: 'id', epochs: sourceEpochs },
  { table: 'scoped_adoption_identities', column: 'id', epochs: sourceEpochs },
  {
    table: 'scoped_adoption_aliases',
    column: 'identity_id',
    epochs: sourceEpochs,
  },
  {
    table: 'category_scope_placements',
    column: 'placement_revision',
    epochs: sourceEpochs,
  },
  {
    table: 'target_scope_placements',
    column: 'placement_revision',
    epochs: sourceEpochs,
  },
  { table: 'scoped_catalogs', column: 'id', epochs: publicEpochs },
  { table: 'scoped_catalog_heads', column: 'catalog_id', epochs: publicEpochs },
  { table: 'scoped_categories', column: 'category_id', epochs: publicEpochs },
  {
    table: 'scoped_category_lineage',
    column: 'category_id',
    epochs: publicEpochs,
  },
  {
    table: 'scoped_target_memberships',
    column: 'target_id',
    epochs: publicEpochs,
  },
  { table: 'scoped_releases', column: 'id', epochs: publicEpochs },
  {
    table: 'scoped_release_scopes',
    column: 'release_id',
    epochs: publicEpochs,
  },
  { table: 'compat_versions', column: 'id', epochs: publicEpochs },
  { table: 'compat_heads', column: 'version_id', epochs: publicEpochs },
  { table: 'compat_projection_manifests', column: 'id', epochs: publicEpochs },
  {
    table: 'compat_projection_lineage',
    column: 'manifest_id',
    epochs: publicEpochs,
  },
  { table: 'scope_protocol_versions', column: 'id', epochs: protocolEpochs },
  {
    table: 'scope_protocol_heads',
    column: 'version_id',
    epochs: protocolEpochs,
  },
  {
    table: 'whaleu_community.rating_scoped_category_source_bindings',
    column: 'source_id',
    epochs: ['binding', ...sourceEpochs],
  },
  {
    table: 'whaleu_community.rating_scoped_target_definition_bindings',
    column: 'target_id',
    epochs: ['binding', ...publicEpochs],
  },
  {
    table: 'whaleu_community.rating_scoped_content_bindings',
    column: 'subject_id',
    epochs: ['binding'],
  },
  { table: 'scoped_contexts', column: 'id', epochs: [] },
  { table: 'scoped_command_preparations', column: 'request_id', epochs: [] },
  { table: 'scoped_command_outcomes', column: 'request_id', epochs: [] },
  { table: 'scoped_command_causes', column: 'request_id', epochs: [] },
  { table: 'command_claims', column: 'request_id', epochs: [] },
  { table: 'requests', column: 'request_id', epochs: [] },
];
const qualify = (table: string) =>
  table.includes('.') ? table : `whaleu_ratings.${table}`;
const epochTable: Record<Epoch, string> = {
  source: 'whaleu_ratings.scoped_source_epoch',
  protocol: 'whaleu_ratings.scope_protocol_epoch',
  pool: 'whaleu_ratings.random_pool_epoch',
  navigation: 'whaleu_ratings.navigation_epoch',
  binding: 'whaleu_community.rating_review_binding_epoch',
};
const epochSql = `SELECT (SELECT epoch::text FROM whaleu_ratings.scoped_source_epoch) source,
  (SELECT epoch::text FROM whaleu_ratings.scope_protocol_epoch) protocol,
  (SELECT epoch::text FROM whaleu_ratings.random_pool_epoch) pool,
  (SELECT epoch::text FROM whaleu_ratings.navigation_epoch) navigation,
  (SELECT epoch::text FROM whaleu_community.rating_review_binding_epoch) binding`;
const epochs = async (client: Pool | PoolClient) =>
  (await client.query<Record<Epoch, string>>(epochSql)).rows[0]!;
function noWait(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '55P03'
  );
}
async function snapshot(f: RatingScopedCommandFixture) {
  const result: Record<string, unknown> = { epochs: await epochs(f.pool) };
  for (const table of [
    ...registry.map((r) => qualify(r.table)),
    'whaleu_ratings.targets',
    'whaleu_ratings.target_definition_versions',
    'whaleu_ratings.target_definition_heads',
    'whaleu_ratings.target_definition_lifecycles',
    'whaleu_ratings.target_state_revisions',
    'whaleu_ratings.score_baselines',
    'whaleu_ratings.score_summaries',
    'whaleu_ratings.effect_events',
  ])
    result[table] = (
      await f.pool.query(
        `SELECT to_jsonb(r) row FROM ${table} r ORDER BY to_jsonb(r)::text`,
      )
    ).rows;
  return result;
}

test(
  'M3B exact new writer registry includes zero-row writes and observable nonblocking final fences',
  { timeout: 300000 },
  async (t) => {
    const f = await ratingScopedCommandFixture();
    t.after(() => f.close());
    const target = await f.createScopedTarget();
    for (const entry of registry)
      await t.test(
        `zero-row ${entry.table} advances only registered epochs and blocks NOWAIT`,
        async () => {
          const table = qualify(entry.table);
          const triggers = (
            await f.pool.query<{
              tgname: string;
              tgtype: number;
              proname: string;
            }>(
              `SELECT t.tgname,t.tgtype,p.proname
      FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=$1::regclass AND NOT t.tgisinternal ORDER BY t.tgname`,
              [table],
            )
          ).rows;
          if (entry.epochs.length) {
            for (const bit of [4, 8, 16])
              assert.ok(
                triggers.some(
                  (r) =>
                    (r.tgtype & 1) === 0 &&
                    (r.tgtype & 2) === 2 &&
                    (r.tgtype & bit) === bit,
                ),
                `${table}: BEFORE STATEMENT I/U/D`,
              );
            assert.ok(
              triggers.some((r) => /writer/.test(r.proname)),
              `${table}: explicit writer gate`,
            );
          }
          const holder = await f.pool.connect(),
            reader = await f.pool.connect();
          const before = await epochs(f.pool);
          const rows = (
            await f.pool.query(
              `SELECT to_jsonb(r) row FROM ${table} r ORDER BY to_jsonb(r)::text`,
            )
          ).rows;
          try {
            await holder.query('BEGIN');
            const write = await holder.query(
              `UPDATE ${table} SET ${entry.column}=${entry.column} WHERE false`,
            );
            assert.equal(write.rowCount, 0);
            const pending = await epochs(holder);
            for (const epoch of Object.keys(epochTable) as Epoch[])
              assert.equal(
                BigInt(pending[epoch]),
                BigInt(before[epoch]) +
                  (entry.epochs.includes(epoch) ? 1n : 0n),
                `${table}: ${epoch}`,
              );
            assert.deepEqual(
              await epochs(f.pool),
              before,
              'Uncommitted source epochs remain invisible to snapshot readers',
            );
            for (const epoch of entry.epochs) {
              await reader.query('BEGIN');
              const start = performance.now();
              const scoped = epoch === 'source' || epoch === 'protocol';
              if (scoped)
                await reader.query(
                  `LOCK TABLE ${epochTable[epoch]} IN ROW SHARE MODE NOWAIT`,
                );
              await assert.rejects(
                reader.query(
                  scoped
                    ? `SELECT singleton,version,epoch FROM ${epochTable[epoch]} FOR SHARE NOWAIT`
                    : `LOCK TABLE ${epochTable[epoch]} IN SHARE MODE NOWAIT`,
                ),
                noWait,
              );
              assert.ok(
                performance.now() - start < 1000,
                '55P03 must precede writer release, not a statement timeout',
              );
              await reader.query('ROLLBACK');
            }
            await holder.query('COMMIT');
            assert.deepEqual(await epochs(f.pool), pending);
            assert.deepEqual(
              (
                await f.pool.query(
                  `SELECT to_jsonb(r) row FROM ${table} r ORDER BY to_jsonb(r)::text`,
                )
              ).rows,
              rows,
              'Zero-row epoch observations never fabricate business rows',
            );
          } finally {
            await reader.query('ROLLBACK');
            await holder.query('ROLLBACK');
            reader.release();
            holder.release();
          }
        },
      );

    for (const mode of ['read', 'random'] as const)
      for (const fence of [
        epochTable.source,
        epochTable.protocol,
        epochTable.pool,
        epochTable.navigation,
        'whaleu_community.rating_review_epoch',
        'whaleu_community.rating_scoped_content_bindings',
        'whaleu_community.rating_scoped_target_definition_bindings',
        'whaleu_community.rating_scoped_category_source_bindings',
        'whaleu_ratings.scoped_contexts',
      ])
        await t.test(
          `${mode} final boundary fails immediately while exact ${fence} fence remains held`,
          async () => {
            const response = await f.requestScopedContext(f.creator, {
              purpose: mode,
              mode: 'public',
              selector: { kind: 'global' },
            });
            assert.equal(response.status, 200, JSON.stringify(response.body));
            const context = ratingScopedContextSchema.parse(response.body);
            const observer = observeDirectoryQueries(f.app),
              holder = await f.pool.connect();
            let installed = false,
              start = 0;
            const statements: string[] = [];
            try {
              await holder.query('BEGIN');
              // The first failed NOWAIT query has no successful after-query
              // callback. Observe the attempted SQL without replacing its result.
              observer.setBeforeHook(async ({ sql }) => {
                statements.push(sql);
              });
              observer.setHook(async ({ sql }) => {
                if (!installed && sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
                  installed = true;
                  await holder.query(
                    // Exact-row owners admit unrelated ROW EXCLUSIVE holders;
                    // their relation fence rejects a genuine EXCLUSIVE blocker.
                    `LOCK TABLE ${fence} IN ${[epochTable.source, epochTable.protocol, 'whaleu_ratings.scoped_contexts'].includes(fence) ? 'EXCLUSIVE' : 'ROW EXCLUSIVE'} MODE`,
                  );
                  start = performance.now();
                }
              });
              const result = await f
                .auth(
                  request(f.http).get(
                    mode === 'read'
                      ? `/v2/ratings/targets/${target.id}`
                      : '/v2/ratings/random-target',
                  ),
                  f.creator,
                )
                .query({
                  contextId: context.id,
                  contextToken: context.token,
                  ...(mode === 'random'
                    ? { categoryId: f.data.global.categoryId }
                    : {}),
                });
              assert.equal(
                installed,
                true,
                'The actual HTTP transaction reached the post-deferred final boundary',
              );
              assert.ok(
                performance.now() - start < 1000,
                JSON.stringify({
                  elapsed: performance.now() - start,
                  body: result.body,
                }),
              );
              assert.notEqual(result.status, 200, JSON.stringify(result.body));
              assert.ok(
                [
                  'RATING_SCOPE_UNAVAILABLE',
                  'RATING_UNAVAILABLE',
                  'CONTENT_REVIEW_UNAVAILABLE',
                ].includes(result.body.error?.code),
                JSON.stringify(result.body),
              );
              const afterFlush = statements.slice(
                statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE') + 1,
              );
              assert.ok(
                afterFlush.some((sql) =>
                  [
                    epochTable.source,
                    epochTable.protocol,
                    'whaleu_ratings.scoped_contexts',
                  ].includes(fence)
                    ? sql.includes(fence) &&
                      /IN ROW SHARE MODE NOWAIT/.test(sql)
                    : /IN SHARE MODE NOWAIT/.test(sql),
                ),
                'Actual owner proof issues a NOWAIT fence',
              );
              assert.equal(
                afterFlush.some((sql) =>
                  /FOR (UPDATE|SHARE)(?!.*NOWAIT)/.test(sql),
                ),
                false,
                'No queued row-lock source reread after deferred flush',
              );
            } finally {
              observer.restore();
              await holder.query('ROLLBACK');
              holder.release();
            }
          },
        );

    await t.test(
      'readonly ABA remains rejected although the business rows and heads return byte-identical',
      async () => {
        const context = await f.scopedContext(f.creator);
        const beforeRows = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key',
          )
        ).rows;
        const observer = observeDirectoryQueries(f.app);
        let wrote = false;
        try {
          observer.setHook(async ({ sql }, tx) => {
            if (!wrote && sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              wrote = true;
              await tx.query(
                'UPDATE whaleu_ratings.scoped_catalog_heads SET catalog_id=catalog_id WHERE false',
              );
              await tx.query(
                'UPDATE whaleu_ratings.scoped_catalog_heads SET catalog_id=catalog_id WHERE false',
              );
            }
          });
          const result = await f
            .auth(
              request(f.http).get(`/v2/ratings/targets/${target.id}`),
              f.creator,
            )
            .query({ contextId: context.id, contextToken: context.token });
          assert.equal(wrote, true);
          assert.notEqual(result.status, 200, JSON.stringify(result.body));
          assert.ok(
            ['RATING_UNAVAILABLE', 'RATING_SCOPE_UNAVAILABLE'].includes(
              result.body.error?.code,
            ),
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key',
              )
            ).rows,
            beforeRows,
          );
        } finally {
          observer.restore();
        }
      },
    );

    await t.test(
      'authorized creation/edit retain their after epochs without discarding immutable before evidence',
      async () => {
        const before = await epochs(f.pool);
        const created = await f.createScopedTarget(
          f.creator,
          'Legitimate source/head writer after proof',
        );
        const afterCreate = await epochs(f.pool);
        assert.ok(BigInt(afterCreate.source) > BigInt(before.source));
        assert.ok(BigInt(afterCreate.pool) > BigInt(before.pool));
        const input = await f.scopedEditIntent(f.creator, created.id, {
          name: 'Legitimate definition after proof',
        });
        const prepared = await f.prepareCommand(f.creator, input);
        await f.approveCommand(f.creator, input);
        const observer = observeDirectoryQueries(f.app);
        let observed = false;
        try {
          observer.setHook(async ({ sql }, tx) => {
            if (
              !observed &&
              /UPDATE whaleu_ratings\.requests SET receipt/.test(sql)
            ) {
              observed = true;
              const row = (
                await tx.query(
                  `SELECT p.before_state->'target'->>'revision' before_revision,
            p.before_state->'target'->>'definitionRevision' before_definition,h.definition_revision after_definition,t.revision after_revision,
            (SELECT count(*)::int FROM whaleu_ratings.target_definition_versions WHERE target_id=t.id) retained_versions
            FROM whaleu_ratings.scoped_command_preparations p JOIN whaleu_ratings.targets t ON t.id=p.target_id
            JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id WHERE p.account_id=$1 AND p.request_id=$2`,
                  [f.creator.accountId, input.payload.clientRequestId],
                )
              ).rows[0]!;
              assert.equal(row.before_revision, created.revision);
              assert.equal(row.before_definition, created.revision);
              assert.equal(row.after_revision, prepared.targetRevision);
              assert.equal(row.after_definition, prepared.definitionRevision);
              assert.equal(row.retained_versions, 2);
            }
          });
          const response = await f.sendCommand(
            f.creator,
            input,
            prepared.contextRevision,
          );
          assert.equal(response.status, 200, JSON.stringify(response.body));
          scopedSuccess(response.body);
          assert.equal(observed, true);
        } finally {
          observer.restore();
        }
      },
    );
  },
);

// A real deferred constraint trigger sleeps in PostgreSQL until the captured
// deadline. It changes no result or owner, and leaves all original guards active.
test(
  'M3B deferred SQL waits cross real owner deadlines and roll back every tentative artifact and epoch',
  { timeout: 600000 },
  async (t) => {
    for (const mode of [
      'review_visibility',
      'review_consume',
      'before_review_visibility',
      'source',
      'context_preparation',
      'topology',
    ] as const)
      await t.test(
        `${mode}: complete tentative definition exists before expiry and nothing commits after the wait`,
        async (tt) => {
          const f = await ratingScopedCommandFixture();
          tt.after(() => f.close());
          let target = await f.createScopedTarget();
          let deadline = new Date(Date.now() + 4000);
          if (mode === 'source') {
            const source = (
              await f.pool
                .query(`SELECT s.payload FROM whaleu_ratings.scoped_source_heads h
          JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(h.source_id,h.source_revision)
          WHERE h.source_kind='scope_absence' AND h.source_key='global'`)
            ).rows[0]!;
            await f.atomicChange(
              (tx) =>
                f.issueSource(
                  {
                    kind: 'scope_absence',
                    key: 'global',
                    scopeKeys: ['global'],
                    payload: source.payload,
                    validUntil: deadline,
                  },
                  tx,
                ),
              { domain: { kind: 'global_compat' } },
            );
          } else if (mode === 'topology') {
            f.scope.topologySnapshotId = await appendTopologyRevision(
              f.pool,
              f.scope.topology,
              { validUntil: deadline.getTime() },
            );
            await appendIdentitySelection(
              f.pool,
              f.creator.accountId,
              f.creator.facts,
              f.scope,
            );
            await f.publish({ activate: true });
          } else if (mode === 'before_review_visibility') {
            const input = await f.commandIntent(
              f.creator,
              'create_target_scoped',
              {
                name: 'Short current predecessor Review',
                description: '',
                assetIds: [],
              },
            );
            const prepared = await f.prepareCommand(f.creator, input);
            const approved = await f.approveCommand(f.creator, input, {
              visibilityUntil: deadline,
            });
            const response = await f.sendCommand(
              f.creator,
              input,
              prepared.contextRevision,
            );
            assert.equal(response.status, 200, JSON.stringify(response.body));
            const receipt = scopedSuccess(response.body);
            target = {
              ...target,
              input,
              prepared,
              approved,
              response,
              receipt,
              id: String(receipt.result['targetId']),
              revision: String(receipt.result['revision']),
            };
          } else if (mode === 'context_preparation') {
            // The real context is shortened by this still-valid session boundary.
            // Do not mutate immutable preparations or restore the token prematurely:
            // its generation is part of the exact scoped context contract.
            await f.pool.query(
              'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE session_id=$1',
              [f.creator.sessionId, deadline],
            );
          }
          const input = await f.scopedEditIntent(f.creator, target.id, {
            name: `Tentative deadline ${mode}`,
          });
          const prepared = await f.prepareCommand(f.creator, input);
          if (mode === 'context_preparation') {
            deadline = new Date(prepared.validUntil);
            assert.ok(deadline.getTime() <= Date.now() + 4000);
          }
          await f.approveCommand(
            f.creator,
            input,
            mode === 'review_visibility'
              ? { visibilityUntil: deadline }
              : mode === 'review_consume'
                ? { consumeUntil: deadline }
                : {},
          );
          const before = await snapshot(f);
          const observer = observeDirectoryQueries(f.app);
          let installed = false,
            tentative = false,
            beforeValid = false,
            beforeRetained = false;
          try {
            await f.pool
              .query(`CREATE FUNCTION whaleu_ratings.synthetic_scoped_deadline_wait() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_sleep(greatest(0,extract(epoch FROM TG_ARGV[0]::timestamptz-clock_timestamp()))+0.2); RETURN NULL; END $$;
          CREATE CONSTRAINT TRIGGER synthetic_scoped_deadline_wait AFTER INSERT ON whaleu_ratings.requests
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.operation='edit_target_scoped')
          EXECUTE FUNCTION whaleu_ratings.synthetic_scoped_deadline_wait('${deadline.toISOString()}')`);
            installed = true;
            observer.setHook(async ({ sql }, tx) => {
              if (
                !tentative &&
                /UPDATE whaleu_ratings\.requests SET receipt/.test(sql)
              ) {
                const row = (
                  await tx.query<{
                    complete: boolean;
                    before_valid: boolean;
                    before_retained: boolean;
                  }>(
                    `SELECT
              q.receipt->>'outcome'='applied' AND h.definition_revision=$3::uuid AND t.revision=$4::uuid
              AND EXISTS(SELECT 1 FROM whaleu_community.rating_scoped_target_definition_bindings b WHERE b.target_id=t.id AND b.definition_revision=h.definition_revision AND b.publication_transaction=pg_current_xact_id())
              AND EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=t.id AND l.target_revision=t.revision AND l.definition_revision=h.definition_revision)
              AND (SELECT count(*) FROM whaleu_ratings.scoped_command_causes WHERE account_id=$1 AND request_id=$2)=2 complete,
              clock_timestamp()<$5::timestamptz before_valid,
              EXISTS(SELECT 1 FROM whaleu_ratings.target_definition_versions v WHERE v.target_id=t.id AND v.definition_revision=(p.before_state->'target'->>'definitionRevision')::uuid) before_retained
              FROM whaleu_ratings.requests q JOIN whaleu_ratings.scoped_command_preparations p USING(account_id,request_id)
              JOIN whaleu_ratings.targets t ON t.id=p.target_id JOIN whaleu_ratings.target_definition_heads h ON h.target_id=t.id
              WHERE q.account_id=$1 AND q.request_id=$2`,
                    [
                      f.creator.accountId,
                      input.payload.clientRequestId,
                      prepared.definitionRevision,
                      prepared.targetRevision,
                      deadline,
                    ],
                  )
                ).rows[0]!;
                tentative = row.complete;
                beforeValid = row.before_valid;
                beforeRetained = row.before_retained;
              }
            });
            const result = await f.sendCommand(
              f.creator,
              input,
              prepared.contextRevision,
            );
            assert.equal(
              tentative,
              true,
              'An actual request, version, head, lifecycle, typed causes and exact Review binding existed',
            );
            assert.equal(
              beforeValid,
              true,
              'The owner was valid at tentative publication, so this is a final-boundary expiry test',
            );
            assert.equal(
              beforeRetained,
              true,
              'The writer must preserve original definition evidence',
            );
            assert.equal(
              (
                await f.pool.query<{ expired: boolean }>(
                  'SELECT clock_timestamp()>$1::timestamptz expired',
                  [deadline],
                )
              ).rows[0]!.expired,
              true,
            );
            assert.ok(result.status >= 400, JSON.stringify(result.body));
            assert.equal(
              result.body.outcome,
              undefined,
              'Owner uncertainty after deferred wait is not a durable business rejection',
            );
            assert.deepEqual(
              await snapshot(f),
              before,
              'Every tentative request/artifact/epoch rolled back; original preparation and claim remain',
            );
          } finally {
            observer.restore();
            if (installed)
              await f.pool.query(
                'DROP TRIGGER synthetic_scoped_deadline_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_scoped_deadline_wait()',
              );
          }
        },
      );
  },
);
