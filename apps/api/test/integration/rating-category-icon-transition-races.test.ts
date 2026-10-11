/** Real overlapping owner transactions. Run only under the parent's exclusive
 * disposable PostgreSQL lease; no production deadline or finalizer is changed. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  DatabaseService,
  type TransactionOptions,
} from '../../src/database/database.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingCategoryIconReceiptSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';
import type { CategoryIconRoot } from '../../src/ratings/category-management/icon-references.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The contender must actually be inside PostgreSQL, waiting on this exact
 * transaction's original first-owner lock. Starting two promises is not proof. */
async function blockedBy(f: CategoryIconManagementFixture, pid: number) {
  const deadline = Date.now() + 2000;
  do {
    const rows = (
      await f.pool.query<{ pid: number; query: string }>(
        `SELECT pid,query FROM pg_stat_activity
       WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))
         AND query LIKE '%pg_advisory_xact_lock%'`,
        [pid],
      )
    ).rows;
    if (rows.length) {
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0]!.pid, pid);
      assert.match(rows[0]!.query, /whaleu:named-block-policy:v1/);
      return;
    }
    await delay(5);
  } while (Date.now() < deadline);
  assert.fail(
    'The competing real HTTP commit never waited on the exact owner transaction',
  );
}

/** Closed receipts are permitted, but none of the losing command's accepted
 * graph may leak. Read the same immutable table set inside/outside the winner. */
async function publication(tx: Pick<PoolClient, 'query'>) {
  const tables = [
    'whaleu_ratings.scoped_source_attestations',
    'whaleu_ratings.scoped_source_heads',
    'whaleu_ratings.category_scope_placements',
    'whaleu_ratings.scoped_catalogs',
    'whaleu_ratings.scoped_catalog_heads',
    'whaleu_ratings.scoped_categories',
    'whaleu_ratings.scoped_category_lineage',
    'whaleu_ratings.scoped_releases',
    'whaleu_ratings.scoped_release_scopes',
    'whaleu_ratings.scoped_command_causes',
    'whaleu_ratings.scoped_command_preparations',
    'whaleu_ratings.command_claims',
    'whaleu_ratings.category_icon_preparations',
    'whaleu_ratings.category_icon_definitions',
    'whaleu_ratings.category_icon_definition_heads',
    'whaleu_ratings.category_icon_appearances',
    'whaleu_ratings.category_icon_projections',
    'whaleu_ratings.category_icon_release_manifests',
    'whaleu_ratings.category_icon_review_bindings',
    'whaleu_ratings.category_icon_management_review_heads',
    'whaleu_ratings.category_icon_terminal_retirements',
    'whaleu_ratings.category_icon_retirement_queue',
    'whaleu_ratings.compat_heads',
    'whaleu_ratings.compat_versions',
    'whaleu_ratings.compat_projection_manifests',
    'whaleu_ratings.catalog_heads',
    'whaleu_ratings.catalogs',
    'whaleu_ratings.categories',
    'whaleu_community.rating_scoped_category_source_bindings',
    'whaleu_community.rating_approval_bindings',
    'whaleu_media.bindings',
    'whaleu_media.assets',
    'whaleu_media.upload_intents',
    'whaleu_media.jobs',
    'whaleu_media.cleanup_obligations',
  ];
  return (
    await tx.query<{ state: unknown }>(`SELECT jsonb_build_object(
    ${tables.map((table) => `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM ${table} r)`).join(',')},
    'acceptedOutcomes',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY account_id,request_id),'[]')
      FROM whaleu_ratings.scoped_command_outcomes r WHERE outcome<>'closed')) state`)
  ).rows[0]!.state;
}

async function prepare(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
) {
  const prepared = await f.prepare(input);
  await f.approveText(input);
  await f.approveIcons(input);
  return { input, revision: prepared.contextRevision };
}

async function assertClosed(
  f: CategoryIconManagementFixture,
  command: Awaited<ReturnType<typeof prepare>>,
  response: { status: number; body: unknown },
) {
  categoryIconHttpOk(response);
  const receipt = ratingCategoryIconReceiptSchema.parse(response.body);
  assert.equal(receipt.outcome, 'closed', JSON.stringify(receipt));
  if (receipt.outcome !== 'closed')
    assert.fail('The stale exact preparation must close');
  assert.equal(receipt.code, 'RATING_SCOPED_CONTEXT_CHANGED');
  assert.deepEqual(
    (await f.commit(command.input, command.revision)).body,
    receipt,
    'The same original request must recover its terminal result before any new planning',
  );
}

async function png() {
  const sharp = (await import('sharp')).default;
  return sharp({
    create: { width: 45, height: 39, channels: 3, background: '#357b91' },
  })
    .png()
    .toBuffer();
}

test(
  'C1 system registry revocation commits while the exact prepared image command waits on the original owner lock',
  { timeout: 180000 },
  async (t) => {
    const bytes = await png();
    const f = await categoryIconManagementFixture(
      [{ sha256: sha256(bytes), verdict: 'allow' }],
      { systemRegistry: true },
    );
    t.after(() => f.close());
    const upload = await f.ready(
      f.intent(await f.context(), 'create_system_category_scoped', {
        systemKey: 'synthetic_icon_general',
        name: 'Prepared before registry revocation',
        description: '',
        placement: { kind: 'global' },
        levelCount: 3,
        icon: { mode: 'clear' },
      }),
      { kind: 'new', key: 'root' },
      bytes,
    );
    const command = await prepare(f, upload.input);
    const entered = latch(),
      release = latch();
    let writerPid = 0,
      expected: unknown,
      successorId = '';
    let contender: Promise<Awaited<ReturnType<typeof f.commit>>> | undefined;
    const writer = withCommunityScopeWriter(f.pool, async (tx) => {
      writerPid = (
        await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
      ).rows[0]!.pid;
      const predecessor = (
        await tx.query<{ id: string; revision: string }>(
          `SELECT s.id,s.revision FROM whaleu_ratings.scoped_source_heads h
         JOIN whaleu_ratings.scoped_source_attestations s ON(s.id,s.revision)=(h.source_id,h.source_revision)
         WHERE h.source_kind='scoped_category_system_registry' AND h.source_key='synthetic-icon-system-registry' FOR UPDATE OF h`,
        )
      ).rows[0];
      assert.ok(predecessor);
      successorId = randomUUID();
      const revision = randomUUID();
      // Append a genuine disabled successor, preserving the original deadline.
      // An adopted source transition must publish every affected original scope.
      await tx.query(
        `INSERT INTO whaleu_ratings.scoped_source_attestations
        (id,revision,source_kind,source_key,scope_keys,payload,digest,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until)
        SELECT $1,$2,source_kind,source_key,scope_keys,jsonb_set(payload,'{enabled}','false'::jsonb),
          whaleu_ratings.scoped_digest('source',jsonb_build_object('id',$1::uuid,'revision',$2::uuid,
            'kind',source_kind,'key',source_key,'scopeKeys',scope_keys,'payload',jsonb_set(payload,'{enabled}','false'::jsonb))),
          coverage,provenance,issuer,'synthetic-concurrent-registry-revocation',policy_reference,
          greatest(effective_at+interval '1 microsecond',clock_timestamp()),valid_until
        FROM whaleu_ratings.scoped_source_attestations WHERE id=$3`,
        [successorId, revision, predecessor.id],
      );
      assert.equal(
        (
          await tx.query(
            `UPDATE whaleu_ratings.scoped_source_heads SET source_id=$1,source_revision=$2
        WHERE source_kind='scoped_category_system_registry' AND source_key='synthetic-icon-system-registry'
          AND source_id=$3 AND source_revision=$4`,
            [successorId, revision, predecessor.id, predecessor.revision],
          )
        ).rowCount,
        1,
      );
      await f.publish({}, tx);
      expected = await publication(tx);
      entered.resolve();
      await release.promise;
    });
    void writer.catch(() => undefined);
    try {
      await Promise.race([
        entered.promise,
        writer.then(() => assert.fail('Registry writer missed its barrier')),
      ]);
      contender = f
        .commit(command.input, command.revision)
        .then((response) => response);
      void contender.catch(() => undefined);
      await blockedBy(f, writerPid);
      release.resolve();
      await writer;
      const response = await contender;
      assert.ok(response);
      await assertClosed(f, command, response);
    } finally {
      release.resolve();
      await Promise.allSettled([writer, ...(contender ? [contender] : [])]);
    }
    assert.deepEqual(
      await publication(f.pool),
      expected,
      'Revocation and its original publication survive; no stale source, icon, Review or Media effect does',
    );
    assert.equal(
      (
        await f.pool.query(
          `SELECT s.payload->>'enabled' enabled
      FROM whaleu_ratings.scoped_source_heads h JOIN whaleu_ratings.scoped_source_attestations s ON s.id=h.source_id
      WHERE s.id=$1`,
          [successorId],
        )
      ).rows[0]!.enabled,
      'false',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
          [upload.status.assetId],
        )
      ).rowCount,
      0,
    );
    const fresh = f.intent(await f.context(), 'create_system_category_scoped', {
      systemKey: 'synthetic_icon_general',
      name: 'Disabled registry still rejects fresh commands',
      description: '',
      placement: { kind: 'global' },
      levelCount: 3,
      icon: { mode: 'clear' },
    });
    const denied = await f.post('prepare', fresh);
    assert.ok(denied.status >= 400, JSON.stringify(denied.body));
    assert.equal(denied.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
  },
);

/** Reuse the actual HTTP/PG fixture and its original v1 bridge. The only
 * additional ingress is exact extension registration after nonempty adoption. */
async function multibaseFixture(bytes: Buffer) {
  let categoryId = '',
    bridgeCount = 0;
  const f = await categoryIconManagementFixture(
    [{ sha256: sha256(bytes), verdict: 'allow' }],
    {
      bootstrap: {
        beforeAdoption: async (base) => {
          await base.declareAll();
          for (const logical of base.logicalScopeKeys) {
            const scopeKeys =
              logical === 'global'
                ? ['global']
                : base.scope.topology.assignments
                    .filter((row) => row.isActive && row.regionId === logical)
                    .map((row) => `campus:${row.campusId}`)
                    .sort();
            await base.issueSource({
              kind: 'native_v1_compat_write',
              key: logical,
              scopeKeys,
              payload: {
                policyVersion: 'native-v1-compat-write-v1',
                enabled: true,
                logicalScopeKey: logical,
                scopeKeys,
                operations: ['create_categories'],
                placementPolicy: 'exact_legacy_domain',
                categoryPolicy: 'append_native_only',
              },
            });
          }
        },
        registerCapabilities: async (base) => {
          const native = await base.createCategories(base.creator, null, {
            nodes: [
              {
                key: 'root',
                parentKey: null,
                name: 'Native transition race',
                description: '',
              },
            ],
          });
          assert.equal(native.receipt.categories.length, 1);
          categoryId = native.receipt.categories[0]!.id;
          const bridges = (
            await base.pool.query<{
              id: string;
              revision: string;
              scope_keys: string[];
            }>(
              `SELECT s.id,s.revision,s.scope_keys FROM whaleu_ratings.scoped_source_attestations s
           JOIN whaleu_ratings.scoped_command_causes c ON c.artifact_id::text=s.payload->>'bridgeId'
           WHERE c.account_id=$1 AND c.request_id=$2 AND c.cause_kind='legacy_bridge'
             AND s.source_kind='m3a_native_bridge' AND s.issuer='ratings-legacy-bridge' AND s.payload->>'categoryId'=$3`,
              [
                base.creator.accountId,
                native.input.clientRequestId,
                categoryId,
              ],
            )
          ).rows;
          bridgeCount = bridges.length;
          assert.equal(bridgeCount, base.logicalScopeKeys.length);
          assert.ok(
            bridgeCount > 1,
            'One real original HTTP command must produce independent domain roots',
          );
          await base.publish({ activate: true });
          await withCommunityScopeWriter(base.pool, async (tx) => {
            const versions = (
              await tx.query<{
                id: string;
                inventory: Array<{
                  scopeKey: string;
                  categoryId: string;
                  identityId: string;
                  baseSource: { id: string; revision: string };
                  baseEvidence: { kind: string; evidenceId: string };
                }>;
              }>(`SELECT v.id,whaleu_ratings.category_icon_coverage_inventory(v.id) inventory
            FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id`)
            ).rows;
            assert.deepEqual(
              versions
                .flatMap((row) => row.inventory.map((entry) => entry.scopeKey))
                .sort(),
              base.scopeKeys,
            );
            for (const version of versions) {
              assert.ok(version.inventory.length > 0);
              for (const entry of version.inventory) {
                const bridge = bridges.find((row) =>
                  row.scope_keys.includes(entry.scopeKey),
                );
                assert.ok(bridge);
                assert.equal(entry.categoryId, categoryId);
                assert.equal(entry.identityId, categoryId);
                assert.deepEqual(entry.baseSource, {
                  id: bridge.id,
                  revision: bridge.revision,
                });
                assert.equal(entry.baseEvidence.kind, 'absent');
                assert.equal(
                  entry.baseEvidence.evidenceId,
                  native.input.clientRequestId,
                );
              }
            }
            await tx.query(`WITH facts AS (
            SELECT v.*,s.digest source_digest,s.valid_until source_until,
              whaleu_ratings.category_icon_coverage_inventory(v.id) inventory,
              whaleu_ratings.category_icon_route_contract() routes,whaleu_ratings.category_icon_native_contract() native
            FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id
            JOIN whaleu_ratings.scoped_source_attestations s ON(s.id,s.revision)=(v.capability_source_id,v.capability_source_revision)
          ),digests AS (
            SELECT facts.*,whaleu_ratings.category_icon_digest('coverage-inventory',inventory) coverage,
              whaleu_ratings.category_icon_digest('compatibility',jsonb_build_object(
                'protocolVersion',5,'reviewVersion',8,'mediaVersion',8,'journalVersion',13,
                'extensionVersion','ratings-category-icon-v1','slots',ARRAY['icon'],
                'sourceId',capability_source_id,'sourceRevision',capability_source_revision,'sourceDigest',source_digest,
                'routesDigest',routes,'nativeDigest',native)) compatibility FROM facts
          ) INSERT INTO whaleu_ratings.category_icon_capability_sources
            (id,protocol_version_id,source_id,source_revision,source_digest,protocol_version,review_version,media_version,journal_version,
             extension_version,slots,routes_digest,native_digest,compatibility_digest,adoption_digest,coverage_digest,coverage_inventory,
             issuer,provenance_ref,valid_from,valid_until)
            SELECT gen_random_uuid(),id,capability_source_id,capability_source_revision,source_digest,5,8,8,13,
              'ratings-category-icon-v1',ARRAY['icon'],routes,native,compatibility,
              whaleu_ratings.category_icon_digest('adoption',jsonb_build_object('protocolVersionId',id,'generation',generation,
                'releaseId',release_id,'manifest',manifest,'compatibilityDigest',compatibility,'coverageDigest',coverage)),
              coverage,inventory,'ratings-category-icon-capability-owner',
              'rating-category-icon-adoption:'||id::text||':'||capability_source_id::text||':'||capability_source_revision::text,
              clock_timestamp(),least(source_until,clock_timestamp()+interval '20 minutes') FROM digests`);
            const current = (
              await tx.query<{ current: boolean }>(
                'SELECT whaleu_ratings.category_icon_capability_current(id,clock_timestamp()) current FROM whaleu_ratings.category_icon_capability_sources',
              )
            ).rows;
            assert.equal(current.length, versions.length);
            assert.ok(current.every((row) => row.current));
          });
        },
      },
    },
  );
  return { f, categoryId, bridgeCount };
}

async function roots(f: CategoryIconManagementFixture, categoryId: string) {
  return (
    await f.pool.query<{ roots: CategoryIconRoot[] }>(
      'SELECT whaleu_ratings.category_icon_complete_roots() roots',
    )
  ).rows[0]!.roots.filter((root) => root.categoryId === categoryId);
}

/** Pause only the first genuine HTTP owner's transaction boundary. Its normal
 * COMMIT still runs every deferred constraint, required proof and fresh deadline.
 * The second HTTP request uses a different real transaction and the same owner. */
async function overlappingCommits(
  f: CategoryIconManagementFixture,
  winner: Awaited<ReturnType<typeof prepare>>,
  loser: Awaited<ReturnType<typeof prepare>>,
) {
  const database = f.app.get(DatabaseService),
    original = database.transaction;
  const run = original.bind(database),
    entered = latch(),
    release = latch();
  let captured = false,
    pid = 0,
    expected: unknown;
  database.transaction = async <T>(
    work: (tx: PoolClient) => Promise<T>,
    options: TransactionOptions = {},
  ) =>
    run(async (tx) => {
      if (captured) return work(tx);
      const result = await work(tx);
      if (
        !result ||
        typeof result !== 'object' ||
        (result as { requestId?: string }).requestId !==
          winner.input.payload.clientRequestId
      )
        return result;
      captured = true;
      assert.equal((result as { outcome?: string }).outcome, 'applied');
      pid = (await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
        .rows[0]!.pid;
      expected = await publication(tx);
      entered.resolve();
      await release.promise;
      return result;
    }, options);
  const first = f
    .commit(winner.input, winner.revision)
    .then((response) => response);
  void first.catch(() => undefined);
  let second: typeof first | undefined;
  try {
    await Promise.race([
      entered.promise,
      first.then((response) => assert.fail(JSON.stringify(response.body))),
    ]);
    second = f.commit(loser.input, loser.revision).then((response) => response);
    void second.catch(() => undefined);
    await blockedBy(f, pid);
    release.resolve();
    const success = await first;
    categoryIconHttpOk(success);
    const receipt = ratingCategoryIconReceiptSchema.parse(success.body);
    assert.equal(receipt.outcome, 'applied');
    await assertClosed(f, loser, await second);
    assert.deepEqual(
      await publication(f.pool),
      expected,
      'Only the selected winner may publish original sources, compat, Review, roots, bindings or cleanup work',
    );
    assert.deepEqual(
      (await f.commit(winner.input, winner.revision)).body,
      receipt,
    );
    return receipt;
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    database.transaction = original;
  }
}

test(
  'C1 genuine multi-base consolidation and prepared image-reference publication serialize in both winner orders',
  { timeout: 360000 },
  async (t) => {
    const bytes = await png();
    const { f, categoryId, bridgeCount } = await multibaseFixture(bytes);
    t.after(() => f.close());
    const edit = async () =>
      f.intent(await f.context(), 'edit_category_base_scoped', {
        categoryId,
        name: 'Reviewed successor on every native bridge',
        description: 'One exact shared appearance',
        icon: { mode: 'keep' },
      });
    const attached = await f.ready(
      await edit(),
      { kind: 'base', categoryId },
      bytes,
    );
    await f.execute(attached.input);
    assert.equal(
      (await f.stored(attached.input)).category_plan.sourceIssues.filter(
        (source) => source.kind === 'scoped_category_base',
      ).length,
      bridgeCount,
    );
    for (const first of ['reference', 'consolidation'] as const) {
      await t.test(
        `${first} wins after both original preparations are accepted`,
        async () => {
          const before = await roots(f, categoryId);
          assert.equal(before.length, bridgeCount);
          assert.ok(
            before.every(
              (root) => root.kind === 'base' && root.value.kind === 'image',
            ),
          );
          const replacement = await f.ready(
            await edit(),
            { kind: 'base', categoryId },
            bytes,
          );
          const reference = await prepare(f, replacement.input);
          const consolidation = await prepare(
            f,
            f.intent(await f.context(), 'set_category_scope_scoped', {
              categoryId,
              placement: { kind: 'campuses', campusIds: [f.campusA] },
              propagation: 'self',
            }),
          );
          const referencing = await f.stored(reference.input),
            merging = await f.stored(consolidation.input);
          assert.deepEqual(
            referencing.category_plan.sourceIssues,
            [],
            'The image-only contender really references every existing text base',
          );
          assert.equal(referencing.media_plan.plan.newAppearances.length, 1);
          assert.equal(merging.media_plan.plan.afterRoots.length, 1);
          assert.deepEqual(merging.media_plan.plan.newAppearances, []);
          const winner = first === 'reference' ? reference : consolidation;
          const loser = first === 'reference' ? consolidation : reference;
          const receipt = await overlappingCommits(f, winner, loser);
          assert.ok(receipt.outcome === 'applied' && receipt.result.releaseId);
          const planned = (await f.stored(winner.input)).media_plan.plan;
          assert.deepEqual(
            await roots(f, categoryId),
            planned.afterRoots,
            'An overlapping stale command cannot resurrect consumed roots or attach its own reference',
          );
          assert.equal(
            (
              await f.pool.query<{ valid: boolean }>(
                'SELECT whaleu_ratings.category_icon_release_payload_valid($1) valid',
                [receipt.result.releaseId],
              )
            ).rows[0]!.valid,
            true,
          );
          const bound = (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
              [replacement.status.assetId],
            )
          ).rowCount;
          assert.equal(bound, first === 'reference' ? 1 : 0);
          if (first === 'consolidation') {
            const root = planned.afterRoots[0]!;
            assert.ok(root.value.kind === 'image');
            assert.equal(
              root.value.appearance.appearanceId,
              before[0]!.value.kind === 'image'
                ? before[0]!.value.appearance.appearanceId
                : null,
            );
            const definition = (
              await f.pool.query<{ predecessors: string[] }>(
                'SELECT predecessors FROM whaleu_ratings.category_icon_definitions WHERE id=$1',
                [root.definitionId],
              )
            ).rows[0]!;
            assert.deepEqual(
              definition.predecessors,
              before.map((item) => item.definitionId).sort(),
            );
            const consumed = (
              await f.pool.query<{ consolidated: boolean }>(
                `SELECT whaleu_ratings.category_icon_source_consolidated($1,$1,s.id,s.revision) consolidated
             FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=ANY($2::uuid[])`,
                [
                  categoryId,
                  before.map((item) => {
                    assert.ok(item.kind === 'base');
                    return item.source.id;
                  }),
                ],
              )
            ).rows;
            assert.equal(consumed.length, bridgeCount);
            assert.ok(consumed.every((row) => row.consolidated));
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements WHERE appearance_id=$1',
                  [root.value.appearance.appearanceId],
                )
              ).rowCount,
              0,
            );
            const current = (
              await f.publicPage({ kind: 'campus', campusId: f.campusA })
            ).page.items.find((item) => item.id === categoryId);
            assert.equal(
              current?.icon?.appearanceId,
              root.value.appearance.appearanceId,
            );
            assert.equal(
              (
                await f.publicPage({ kind: 'campus', campusId: f.campusB })
              ).page.items.some((item) => item.id === categoryId),
              false,
            );
          }
        },
      );
    }
  },
);
