/** Static acceptance source; run only under the parent's exclusive disposable
 * PostgreSQL lease. The original v1 HTTP command creates the multi-domain
 * Category and its real legacy-bridge derivatives. No derived roots, receipts,
 * appearances, bindings or final catalogs are fixture-inserted. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { RatingCategoryIconManagementService } from '../../src/ratings/category-management/icon-service.js';
import {
  categoryIconHttpOk,
  categoryIconManagementFixture,
  type CategoryIconManagementFixture,
} from '../support/category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import type { RatingScopedFixture } from '../support/rating-scoped-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  ratingCategoryIconReceiptSchema,
  type RatingCategoryIconIntent,
} from '../../src/ratings/category-management/icon-contracts.js';
import type { CategoryIconRoot } from '../../src/ratings/category-management/icon-references.js';
import type { RatingNavigationSelector } from '../../src/ratings/scoped/contracts.js';

const originalName = 'Original multi-domain native category';
const originalDescription =
  'One real native identity with independent domain bridges';
const globalSelector = { kind: 'global' } as const;
type NativeCreation = Awaited<
  ReturnType<RatingScopedFixture['createCategories']>
>;
type Bridge = {
  id: string;
  revision: string;
  scope_keys: string[];
  source_key: string;
  origin: { kind: string; requestId: string; releaseId: string } | null;
};
type CoverageEntry = {
  scopeKey: string;
  categoryId: string;
  identityId: string;
  baseSource: { id: string; revision: string };
  overrideSource: null;
  baseEvidence: { kind: 'absent'; evidenceId: string; evidenceDigest: string };
  overrideEvidence: null;
};

async function multibaseFixture(images: readonly Buffer[]) {
  let original:
    | { native: NativeCreation; categoryId: string; bridges: Bridge[] }
    | undefined;
  const f = await categoryIconManagementFixture(
    images.map((bytes) => ({
      sha256: sha256(bytes),
      verdict: 'allow' as const,
    })),
    {
      bootstrap: {
        beforeAdoption: async (base) => {
          await base.declareAll();
          // Explicit original compatibility policy, installed before activation.
          // Empty original adoption has no synthetic Category bases to sanitize.
          for (const logical of base.logicalScopeKeys) {
            const scopeKeys =
              logical === 'global'
                ? ['global']
                : base.scope.topology.assignments
                    .filter(
                      (campus) =>
                        campus.isActive && campus.regionId === logical,
                    )
                    .map((campus) => `campus:${campus.campusId}`)
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
                name: originalName,
                description: originalDescription,
              },
            ],
          });
          assert.equal(native.receipt.categories.length, 1);
          const categoryId = native.receipt.categories[0]!.id;
          const cause = (
            await base.pool.query<{
              artifact_id: string;
              proof: {
                domains: Array<{
                  logicalScopeKey: string;
                  scopeKeys: string[];
                }>;
              };
            }>(
              `SELECT artifact_id,proof FROM whaleu_ratings.scoped_command_causes
           WHERE account_id=$1 AND request_id=$2 AND cause_kind='legacy_bridge'`,
              [base.creator.accountId, native.input.clientRequestId],
            )
          ).rows[0];
          assert.ok(
            cause,
            'Only the actual original applied command may create the bridge cause',
          );
          assert.deepEqual(
            cause.proof.domains.map((domain) => domain.logicalScopeKey).sort(),
            base.logicalScopeKeys,
          );
          assert.deepEqual(
            cause.proof.domains.flatMap((domain) => domain.scopeKeys).sort(),
            base.scopeKeys,
          );
          const bridges = (
            await base.pool.query<Bridge>(
              `SELECT s.id,s.revision,s.scope_keys,s.source_key,
             whaleu_ratings.category_icon_native_text_origin(s.id,s.revision,$1,$1) origin
           FROM whaleu_ratings.scoped_source_attestations s
           WHERE s.source_kind='m3a_native_bridge' AND s.issuer='ratings-legacy-bridge'
             AND s.payload->>'categoryId'=$1::text AND s.payload->>'bridgeId'=$2 ORDER BY s.source_key`,
              [categoryId, cause.artifact_id],
            )
          ).rows;
          assert.equal(bridges.length, base.logicalScopeKeys.length);
          assert.ok(bridges.length > 1);
          assert.equal(
            new Set(bridges.map((bridge) => bridge.id)).size,
            bridges.length,
          );
          for (const domain of cause.proof.domains) {
            const bridge = bridges.find(
              (item) =>
                item.source_key ===
                `bridge-category:${categoryId}:${domain.logicalScopeKey}`,
            );
            assert.ok(bridge);
            assert.deepEqual(bridge.scope_keys, domain.scopeKeys);
            assert.ok(
              bridge.origin,
              'Every branch must prove the immutable original v1 receipt',
            );
            assert.equal(bridge.origin.kind, 'next-native-strict-text');
            assert.equal(bridge.origin.requestId, native.input.clientRequestId);
            assert.equal(bridge.origin.releaseId, native.receipt.releaseId);
          }
          original = { native, categoryId, bridges };

          // Coverage is frozen to protocol.release_id, not the latest catalog.
          // Re-adopt through the original owner before registering the extension,
          // so the actual nonempty original catalogs are what SQL must prove.
          const adopted = await base.publish({ activate: true });
          const protocols = (
            await base.pool.query<{
              id: string;
              release_id: string;
              inventory: CoverageEntry[] | null;
            }>(
              `SELECT v.id,v.release_id,whaleu_ratings.category_icon_coverage_inventory(v.id) inventory
           FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id
           WHERE v.phase='adopted' ORDER BY v.id`,
            )
          ).rows;
          assert.equal(protocols.length, base.logicalScopeKeys.length);
          const coverage = protocols.flatMap((protocol) => {
            assert.equal(protocol.release_id, adopted.releaseId);
            assert.ok(
              protocol.inventory && protocol.inventory.length > 0,
              'Nonempty native adoption needs exact absence lineage',
            );
            return protocol.inventory;
          });
          assert.deepEqual(
            coverage.map((entry) => entry.scopeKey).sort(),
            base.scopeKeys,
          );
          for (const entry of coverage) {
            const bridge = bridges.find((item) =>
              item.scope_keys.includes(entry.scopeKey),
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
            assert.match(entry.baseEvidence.evidenceDigest, /^[a-f0-9]{64}$/);
            assert.equal(entry.overrideSource, null);
            assert.equal(entry.overrideEvidence, null);
          }
          await withCommunityScopeWriter(base.pool, async (tx) => {
            for (const protocol of protocols)
              await tx.query(
                `WITH facts AS (
              SELECT v.*,s.digest source_digest,s.valid_until source_until,
                whaleu_ratings.category_icon_coverage_inventory(v.id) inventory,
                whaleu_ratings.category_icon_route_contract() routes,whaleu_ratings.category_icon_native_contract() native
              FROM whaleu_ratings.scope_protocol_versions v JOIN whaleu_ratings.scoped_source_attestations s
                ON(s.id,s.revision)=(v.capability_source_id,v.capability_source_revision) WHERE v.id=$1
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
              SELECT $2,id,capability_source_id,capability_source_revision,source_digest,5,8,8,13,
                'ratings-category-icon-v1',ARRAY['icon'],routes,native,compatibility,
                whaleu_ratings.category_icon_digest('adoption',jsonb_build_object('protocolVersionId',id,'generation',generation,
                  'releaseId',release_id,'manifest',manifest,'compatibilityDigest',compatibility,'coverageDigest',coverage)),
                coverage,inventory,'ratings-category-icon-capability-owner',
                'rating-category-icon-adoption:'||id::text||':'||capability_source_id::text||':'||capability_source_revision::text,
                clock_timestamp(),least(source_until,clock_timestamp()+interval '20 minutes') FROM digests`,
                [protocol.id, randomUUID()],
              );
            const registered = (
              await tx.query<{ inventory: CoverageEntry[]; current: boolean }>(
                `SELECT coverage_inventory inventory,whaleu_ratings.category_icon_capability_current(id,clock_timestamp()) current
             FROM whaleu_ratings.category_icon_capability_sources ORDER BY protocol_version_id`,
              )
            ).rows;
            assert.equal(registered.length, protocols.length);
            assert.ok(registered.every((row) => row.current));
            assert.deepEqual(
              registered.map((row) => row.inventory),
              protocols.map((row) => row.inventory),
            );
          });
        },
      },
    },
  );
  assert.ok(original);
  return { f, ...original };
}

test(
  'Category text successors of every genuine bridge consolidate without resurrecting superseded source heads',
  { timeout: 360000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const image = await sharp({
      create: { width: 48, height: 40, channels: 3, background: '#387b68' },
    })
      .png()
      .toBuffer();
    const { f, categoryId, bridges } = await multibaseFixture([image]);
    t.after(() => f.close());
    const editedName = 'Unified text successor for every real native bridge';
    const draft = f.intent(
      await f.context(globalSelector),
      'edit_category_base_scoped',
      {
        categoryId,
        name: editedName,
        description: 'Every branch has a reviewed original-owner successor',
        icon: { mode: 'clear' },
      },
    );
    const upload = await f.ready(draft, { kind: 'base', categoryId }, image);
    const edited = await f.execute(upload.input);
    assert.ok(
      edited.receipt.outcome === 'applied' && edited.receipt.result.releaseId,
    );
    const editing = await f.stored(upload.input);
    const successors = editing.category_plan.sourceIssues.filter(
      (issue) => issue.kind === 'scoped_category_base',
    );
    assert.equal(successors.length, bridges.length);
    assert.equal(editing.category_plan.envelopes.length, bridges.length);
    assert.equal(editing.media_plan.plan.newAppearances.length, 1);
    const appearance = editing.media_plan.plan.newAppearances[0]!;
    for (const successor of successors) {
      const bridge = bridges.find(
        (item) => item.id === successor.payload['previousBaseSourceId'],
      );
      assert.ok(
        bridge,
        'Each text successor must be anchored in one exact real bridge',
      );
      assert.equal(
        successor.payload['previousBaseSourceRevision'],
        bridge.revision,
      );
      assert.deepEqual(successor.scopeKeys, bridge.scope_keys);
    }
    await assertRelease(f, upload.input, edited.receipt.result.releaseId);
    const beforeRoots = await roots(f, categoryId);
    assert.equal(beforeRoots.length, bridges.length);
    assert.ok(
      beforeRoots.every(
        (root) =>
          root.kind === 'base' &&
          root.value.kind === 'image' &&
          root.value.appearance.appearanceId === appearance.appearanceId,
      ),
    );
    const beforeBindings = await bindings(f, categoryId);
    assert.equal(beforeBindings.length, 1);

    const priorSources = await consolidationFacts(
      f,
      categoryId,
      successors.map((source) => source.id),
    );
    assert.equal(priorSources.length, bridges.length);
    for (const prior of priorSources) {
      assert.equal(prior.stored, true);
      assert.ok(prior.scoped_keys.length > 0);
      assert.ok(
        prior.compat_keys.length > 0,
        'Real current compat tuples reference every pre-merge branch',
      );
      assert.equal(
        prior.consolidated,
        false,
        'A current stored/scoped/compat reference cannot be excluded',
      );
    }
    const frozenCatalogBefore = (
      await f.pool.query<{ catalog_id: string }>(
        'SELECT catalog_id FROM whaleu_ratings.catalog_heads WHERE scope_key=$1',
        [f.regionId],
      )
    ).rows[0]!.catalog_id;
    // A-only is lawful and makes the A/B legacy compatibility domain divergent.
    // It leaves the original native catalog head frozen while current compat
    // tuples point at the new A category and the empty B catalog.
    const merge = f.intent(
      await f.context(globalSelector),
      'set_category_scope_scoped',
      {
        categoryId,
        placement: { kind: 'campuses', campusIds: [f.campusA] },
        propagation: 'self',
      },
    );
    const mergePrepared = await f.prepare(merge);
    await f.approveText(merge);
    await f.approveIcons(merge);
    for (const attack of [
      'invented-predecessors',
      'borrowed-release',
    ] as const) {
      const beforeAttack = await publicationState(f);
      let earlyPassed = false,
        namedBoundaryReached = false;
      const guard =
        attack === 'invented-predecessors'
          ? 'category_icon_definition_guard'
          : 'category_icon_release_row_guard';
      await assert.rejects(
        commandThenSql(f, merge, mergePrepared.contextRevision, async (tx) => {
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          earlyPassed = true;
          await tx.query('SET CONSTRAINTS ALL DEFERRED');
          namedBoundaryReached = true;
          if (attack === 'invented-predecessors') {
            // An intentionally invalid raw INSERT, never fixture history. The
            // exact named before-row guard must reject it before duplicate-key
            // handling; an invented predecessor list cannot prove consolidation.
            await tx.query(
              `INSERT INTO whaleu_ratings.category_icon_definitions
             (id,category_id,identity_id,kind,campus_id,base_source_id,base_source_revision,text_source_id,text_source_revision,
              value,appearance_id,predecessors,definition_digest,actor_id,request_id,intent_hash)
             SELECT id,category_id,identity_id,kind,campus_id,base_source_id,base_source_revision,text_source_id,text_source_revision,
               value,appearance_id,ARRAY[]::uuid[],definition_digest,actor_id,request_id,intent_hash
             FROM whaleu_ratings.category_icon_definitions WHERE actor_id=$1 AND request_id=$2 AND kind='base'`,
              [f.admin.accountId, merge.payload.clientRequestId],
            );
          } else {
            // Borrow the genuine new manifest bytes for an existing old release.
            // No receipt, release, cause, current head or source is manufactured.
            await tx.query(
              `INSERT INTO whaleu_ratings.category_icon_release_manifests
             (release_id,extension_version,digest,row_count,management_coverage,scope_extent,root_snapshot,capabilities,serialized_bytes)
             SELECT $3,extension_version,digest,row_count,management_coverage,scope_extent,root_snapshot,capabilities,serialized_bytes
             FROM whaleu_ratings.category_icon_release_manifests m JOIN whaleu_ratings.scoped_command_outcomes o
               ON m.release_id=(o.result->>'releaseId')::uuid WHERE o.account_id=$1 AND o.request_id=$2`,
              [
                f.admin.accountId,
                merge.payload.clientRequestId,
                f.adopted.releaseId,
              ],
            );
          }
          assert.fail(`The exact ${guard} accepted ${attack}`);
        }),
        (error: unknown) =>
          earlyPassed &&
          namedBoundaryReached &&
          namedCheckViolation(error, guard),
      );
      assert.equal(
        earlyPassed,
        true,
        'The genuine original command graph must validate before the raw attack',
      );
      assert.equal(namedBoundaryReached, true);
      assert.deepEqual(
        await publicationState(f),
        beforeAttack,
        `${attack}: all original, extension, Review and Media writes must roll back`,
      );
      assert.deepEqual(
        await consolidationFacts(
          f,
          categoryId,
          successors.map((source) => source.id),
        ),
        priorSources,
      );
    }
    const mergeResponse = await f.commit(merge, mergePrepared.contextRevision);
    categoryIconHttpOk(mergeResponse);
    const merged = {
      receipt: ratingCategoryIconReceiptSchema.parse(mergeResponse.body),
    };
    assert.ok(
      merged.receipt.outcome === 'applied' && merged.receipt.result.releaseId,
    );
    const merging = await f.stored(merge);
    assert.equal(merging.category_plan.envelopes.length, 1);
    assert.deepEqual(merging.media_plan.plan.newAppearances, []);
    assert.equal(merging.media_plan.plan.afterRoots.length, 1);
    const finalRoots = await roots(f, categoryId);
    assert.deepEqual(
      finalRoots,
      merging.media_plan.plan.afterRoots,
      'Exact consumed predecessors must not reappear as unresolved roots merely because their source heads remain',
    );
    const finalBase = finalRoots[0]!;
    assert.ok(finalBase.kind === 'base' && finalBase.value.kind === 'image');
    assert.deepEqual(finalBase.value.appearance, appearance);
    assert.equal(
      (
        await f.pool.query<{ name: string }>(
          `SELECT c.name FROM whaleu_ratings.scoped_catalog_heads h
       JOIN whaleu_ratings.scoped_categories c ON c.catalog_id=h.catalog_id
       WHERE h.scope_key=$1 AND c.category_id=$2`,
          [`campus:${f.campusA}`, categoryId],
        )
      ).rows[0]!.name,
      editedName,
    );
    const mergedDefinition = (
      await f.pool.query<{ predecessors: string[] }>(
        'SELECT predecessors FROM whaleu_ratings.category_icon_definitions WHERE id=$1',
        [finalBase.definitionId],
      )
    ).rows[0]!;
    assert.deepEqual(
      mergedDefinition.predecessors,
      beforeRoots.map((root) => root.definitionId).sort(),
    );
    const consumedSources = await consolidationFacts(
      f,
      categoryId,
      successors.map((source) => source.id),
    );
    assert.equal(consumedSources.length, priorSources.length);
    for (const consumed of consumedSources) {
      assert.equal(consumed.stored, false);
      assert.deepEqual(consumed.scoped_keys, []);
      assert.deepEqual(consumed.compat_keys, []);
      assert.equal(
        consumed.consolidated,
        true,
        'Exact consumed sources are excluded only after every live reference has left',
      );
      assert.equal(consumed.wrong_category, false);
      assert.equal(consumed.wrong_identity, false);
      assert.equal(consumed.wrong_source, false);
      assert.equal(consumed.wrong_revision, false);
      assert.deepEqual(
        consumed.metadata,
        priorSources.find((source) => source.id === consumed.id)!.metadata,
        'Consolidation never rewrites the original immutable source metadata',
      );
    }
    assert.equal(
      consumedSources.filter((source) => source.current_source_head).length,
      bridges.length - 1,
      'Nonselected historical source heads remain under the original owner',
    );
    const currentSource = (
      await consolidationFacts(f, categoryId, [finalBase.source.id])
    )[0]!;
    assert.equal(currentSource.stored, true);
    assert.ok(
      currentSource.scoped_keys.length > 0 &&
        currentSource.compat_keys.length > 0,
    );
    assert.equal(currentSource.consolidated, false);
    const frozen = (
      await f.pool.query<{
        state: string;
        catalog_id: string;
        legacy_catalog_id: string | null;
        supported: boolean;
        review_sources: Array<{ proof: { baseSourceId: string } }>;
      }>(
        `SELECT v.state,h.catalog_id,v.legacy_catalog_id,
         whaleu_ratings.category_catalog_compat_current(h.catalog_id) supported,l.review_sources
       FROM whaleu_ratings.catalog_heads h
       JOIN whaleu_ratings.compat_heads current ON current.compat_key='region_compat:'||h.scope_key
       JOIN whaleu_ratings.compat_versions v ON v.id=current.version_id
       JOIN whaleu_ratings.compat_projection_manifests m ON m.after_catalog_id=h.catalog_id
       JOIN whaleu_ratings.compat_projection_lineage l ON l.manifest_id=m.id AND l.category_id=$2
       WHERE h.scope_key=$1`,
        [f.regionId, categoryId],
      )
    ).rows[0];
    assert.ok(
      frozen,
      'The unsupported native catalog must retain its genuine original projection provenance',
    );
    assert.equal(frozen.state, 'divergent');
    assert.equal(frozen.catalog_id, frozenCatalogBefore);
    assert.equal(frozen.legacy_catalog_id, null);
    assert.equal(frozen.supported, false);
    assert.ok(frozen.review_sources.length > 0);
    for (const input of frozen.review_sources)
      assert.equal(
        consumedSources.find((source) => source.id === input.proof.baseSourceId)
          ?.consolidated,
        true,
        'A frozen unsupported native head must not permanently pin a source absent from all current compat tuples',
      );
    assert.deepEqual(await bindings(f, categoryId), beforeBindings);
    await assertRelease(f, merge, merged.receipt.result.releaseId);
    assert.equal(
      await publicAppearance(f, categoryId, {
        kind: 'campus',
        campusId: f.campusA,
      }),
      appearance.appearanceId,
    );
    assert.ok(
      !(
        await f.publicPage({ kind: 'campus', campusId: f.campusB })
      ).page.items.some((item) => item.id === categoryId),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements WHERE appearance_id=$1',
          [appearance.appearanceId],
        )
      ).rowCount,
      0,
    );
  },
);

function namedCheckViolation(error: unknown, name: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23514' &&
    'where' in error &&
    typeof error.where === 'string' &&
    error.where.includes(`${name}()`)
  );
}
async function commandThenSql(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  revision: string,
  after: (tx: PoolClient) => Promise<void>,
) {
  const database = f.app.get(DatabaseService),
    original = database.transaction;
  try {
    await withCommunityScopeWriter(f.pool, async (tx) => {
      database.transaction = async <T>(
        work: (client: PoolClient) => Promise<T>,
      ): Promise<T> => work(tx);
      const receipt = await f.app
        .get(RatingCategoryIconManagementService)
        .commit(f.admin.accessToken, {
          intent: input,
          preparationContextRevision: revision,
        });
      assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
      await after(tx);
    });
  } finally {
    database.transaction = original;
  }
}
async function consolidationFacts(
  f: CategoryIconManagementFixture,
  categoryId: string,
  sourceIds: readonly string[],
) {
  return (
    await f.pool.query<{
      id: string;
      revision: string;
      metadata: unknown;
      current_source_head: boolean;
      stored: boolean;
      scoped_keys: string[];
      compat_keys: string[];
      consolidated: boolean;
      wrong_category: boolean;
      wrong_identity: boolean;
      wrong_source: boolean;
      wrong_revision: boolean;
    }>(
      `SELECT s.id,s.revision,to_jsonb(s) metadata,
       EXISTS(SELECT 1 FROM whaleu_ratings.scoped_source_heads h WHERE (h.source_id,h.source_revision)=(s.id,s.revision)) current_source_head,
       EXISTS(SELECT 1 FROM whaleu_ratings.category_icon_definition_heads h JOIN whaleu_ratings.category_icon_definitions d ON d.id=h.definition_id
         WHERE d.category_id=$1 AND d.identity_id=$1 AND (d.base_source_id,d.base_source_revision)=(s.id,s.revision)) stored,
       ARRAY(SELECT h.scope_key FROM whaleu_ratings.scoped_catalog_heads h JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=h.catalog_id
         WHERE l.category_id=$1 AND (l.base_source_id,l.base_source_revision)=(s.id,s.revision) ORDER BY h.scope_key) scoped_keys,
       ARRAY(SELECT DISTINCT h.compat_key FROM whaleu_ratings.compat_heads h JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id
         CROSS JOIN LATERAL jsonb_array_elements(v.scoped_tuples) item JOIN whaleu_ratings.scoped_category_lineage l ON l.catalog_id=(item->>'catalogId')::uuid
         WHERE l.category_id=$1 AND (l.base_source_id,l.base_source_revision)=(s.id,s.revision) ORDER BY h.compat_key) compat_keys,
       whaleu_ratings.category_icon_source_consolidated($1,$1,s.id,s.revision) consolidated,
       whaleu_ratings.category_icon_source_consolidated($3,$1,s.id,s.revision) wrong_category,
       whaleu_ratings.category_icon_source_consolidated($1,$3,s.id,s.revision) wrong_identity,
       whaleu_ratings.category_icon_source_consolidated($1,$1,$3,s.revision) wrong_source,
       whaleu_ratings.category_icon_source_consolidated($1,$1,s.id,$3) wrong_revision
     FROM whaleu_ratings.scoped_source_attestations s WHERE s.id=ANY($2::uuid[]) ORDER BY s.id`,
      [categoryId, sourceIds, randomUUID()],
    )
  ).rows;
}

async function roots(f: CategoryIconManagementFixture, categoryId: string) {
  return (
    await f.pool.query<{ roots: CategoryIconRoot[] }>(
      'SELECT whaleu_ratings.category_icon_complete_roots() roots',
    )
  ).rows[0]!.roots.filter((root) => root.categoryId === categoryId);
}
async function bindings(f: CategoryIconManagementFixture, categoryId: string) {
  return (
    await f.pool.query<{
      id: string;
      asset_id: string;
      media_binding_id: string;
      detached_at: Date | null;
    }>(
      `SELECT a.id,a.asset_id,a.media_binding_id,b.detached_at FROM whaleu_ratings.category_icon_appearances a
     JOIN whaleu_media.bindings b ON b.id=a.media_binding_id WHERE a.category_id=$1 ORDER BY a.id`,
      [categoryId],
    )
  ).rows;
}
async function publicationState(f: CategoryIconManagementFixture) {
  // Closed static table list: failed HTTP preparation/commit must not partially
  // claim a request or mutate any original, extension, Review or Media graph.
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
    'whaleu_ratings.scoped_command_outcomes',
    'whaleu_ratings.scoped_command_preparations',
    'whaleu_ratings.command_claims',
    'whaleu_ratings.category_icon_preparations',
    'whaleu_ratings.category_icon_review_bindings',
    'whaleu_ratings.category_icon_management_review_heads',
    'whaleu_ratings.compat_heads',
    'whaleu_ratings.compat_versions',
    'whaleu_ratings.compat_projection_manifests',
    'whaleu_ratings.catalog_heads',
    'whaleu_ratings.catalogs',
    'whaleu_ratings.categories',
    'whaleu_community.rating_scoped_category_source_bindings',
    'whaleu_community.rating_approval_bindings',
    'whaleu_media.assets',
    'whaleu_media.upload_intents',
    'whaleu_media.jobs',
    'whaleu_ratings.scoped_source_epoch',
    'whaleu_ratings.navigation_epoch',
    'whaleu_ratings.random_pool_epoch',
  ];
  const owner = (
    await f.pool.query<{ state: unknown }>(
      `SELECT jsonb_build_object(${tables
        .map(
          (table) =>
            `'${table}',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb) FROM ${table} r)`,
        )
        .join(',')}) state`,
    )
  ).rows[0]!.state;
  return { owner, artifacts: await f.artifacts() };
}
async function publicAppearance(
  f: CategoryIconManagementFixture,
  categoryId: string,
  selector: RatingNavigationSelector,
) {
  const category = (await f.publicPage(selector)).page.items.find(
    (item) => item.id === categoryId,
  );
  assert.ok(
    category?.icon,
    'The actual current public Category must expose its authorized image',
  );
  const icon = category.icon;
  const delivered = await f
    .auth(
      request(f.http).get(
        `/v3/media/ratings-category-icon/categories/${categoryId}/appearances/${icon.appearanceId}/display-v1`,
      ),
    )
    .query({ contextId: icon.contextId, contextToken: icon.contextToken });
  categoryIconHttpOk(delivered);
  assert.ok(Buffer.isBuffer(delivered.body));
  return icon.appearanceId;
}
async function assertRelease(
  f: CategoryIconManagementFixture,
  input: RatingCategoryIconIntent,
  releaseId: string,
) {
  const persisted = await f.stored(input);
  const publication = (
    await f.pool.query<{
      valid: boolean;
      same_transaction: boolean;
      review_count: number;
      definition_count: number;
    }>(
      `SELECT whaleu_ratings.category_icon_release_payload_valid(r.id) valid,
       r.publication_transaction=m.publication_transaction
       AND r.publication_transaction=o.mutation_transaction same_transaction,
       (SELECT count(*)::int FROM whaleu_ratings.category_icon_review_bindings b
         WHERE b.account_id=$1 AND b.request_id=$2 AND b.publication_transaction=r.publication_transaction) review_count,
       (SELECT count(*)::int FROM whaleu_ratings.category_icon_definitions d
         WHERE d.actor_id=$1 AND d.request_id=$2 AND d.publication_transaction=r.publication_transaction) definition_count
     FROM whaleu_ratings.scoped_releases r
     JOIN whaleu_ratings.category_icon_release_manifests m ON m.release_id=r.id
     JOIN whaleu_ratings.scoped_command_outcomes o ON o.account_id=$1 AND o.request_id=$2 WHERE r.id=$3`,
      [f.admin.accountId, input.payload.clientRequestId, releaseId],
    )
  ).rows[0];
  assert.ok(publication);
  assert.equal(publication.valid, true);
  assert.equal(publication.same_transaction, true);
  assert.equal(
    publication.review_count,
    persisted.media_plan.reviewEnvelopes.length,
  );
  assert.ok(publication.definition_count > 0);
  const textBindings = (
    await f.pool.query<{ source_id: string }>(
      `SELECT source_id FROM whaleu_community.rating_scoped_category_source_bindings
     WHERE source_id=ANY($1::uuid[]) AND envelope_version=5 ORDER BY source_id`,
      [persisted.category_plan.envelopes.map((envelope) => envelope.sourceId)],
    )
  ).rows;
  assert.deepEqual(
    textBindings.map((row) => row.source_id),
    persisted.category_plan.envelopes
      .map((envelope) => envelope.sourceId)
      .sort(),
  );
}

test(
  'Category genuine multi-domain bridges share one C1 binding, reject a conflicting override and consolidate without losing references',
  { timeout: 480000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const images = await Promise.all(
      ['#285c84', '#c47b32'].map((background) =>
        sharp({ create: { width: 48, height: 40, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const { f, categoryId, native, bridges } = await multibaseFixture(images);
    t.after(() => f.close());
    const initial = await roots(f, categoryId);
    assert.equal(initial.length, bridges.length);
    assert.ok(
      initial.every(
        (root) =>
          root.kind === 'base' &&
          root.identityId === categoryId &&
          root.value.kind === 'absent' &&
          root.value.evidenceId === native.input.clientRequestId,
      ),
    );
    assert.equal((await bindings(f, categoryId)).length, 0);
    const campus = { kind: 'campus', campusId: f.campusA } as const;

    // Keep the original text unchanged: this is a single base-icon operation,
    // not a hand-built split or a fabricated textual successor.
    const draft = f.intent(
      await f.context(globalSelector),
      'edit_category_base_scoped',
      {
        categoryId,
        name: originalName,
        description: originalDescription,
        icon: { mode: 'clear' },
      },
    );
    const upload = await f.ready(
      draft,
      { kind: 'base', categoryId },
      images[0]!,
    );
    const prepared = await f.prepare(upload.input);
    const replacement = await f.stored(upload.input);
    assert.deepEqual(replacement.media_plan.plan.beforeRoots, initial);
    assert.equal(replacement.media_plan.plan.newAppearances.length, 1);
    assert.equal(
      replacement.media_plan.plan.afterRoots.filter(
        (root) => root.kind === 'base',
      ).length,
      bridges.length,
    );
    assert.equal(
      replacement.media_plan.reviewEnvelopes.length,
      f.scopeKeys.length,
    );
    assert.deepEqual(
      replacement.media_plan.plan.affectedScopeKeys,
      f.scopeKeys,
    );
    const appearance = replacement.media_plan.plan.newAppearances[0]!;
    assert.equal(appearance.assetId, upload.status.assetId);
    for (const root of replacement.media_plan.plan.afterRoots) {
      assert.equal(root.value.kind, 'image');
      if (root.value.kind === 'image')
        assert.deepEqual(root.value.appearance, appearance);
    }
    await f.approveText(upload.input);
    const awaitingReview = await publicationState(f);
    assert.equal(
      (await f.commit(upload.input, prepared.contextRevision)).body.error.code,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    assert.deepEqual(await publicationState(f), awaitingReview);
    await f.approveIcons(upload.input);
    const committed = await f.commit(upload.input, prepared.contextRevision);
    categoryIconHttpOk(committed);
    const receipt = ratingCategoryIconReceiptSchema.parse(committed.body);
    assert.ok(receipt.outcome === 'applied' && receipt.result.releaseId);
    await assertRelease(f, upload.input, receipt.result.releaseId);
    const shared = await bindings(f, categoryId);
    assert.equal(
      shared.length,
      1,
      'All domain roots must share one actual Media binding',
    );
    assert.deepEqual(shared[0], {
      id: appearance.appearanceId,
      asset_id: upload.status.assetId,
      media_binding_id: shared[0]!.media_binding_id,
      detached_at: null,
    });
    for (const selector of [
      globalSelector,
      ...f.campusIds.map((campusId) => ({ kind: 'campus' as const, campusId })),
    ])
      assert.equal(
        await publicAppearance(f, categoryId, selector),
        appearance.appearanceId,
      );
    const beforeReplay = await publicationState(f);
    const replay = await f.commit(upload.input, prepared.contextRevision);
    categoryIconHttpOk(replay);
    assert.deepEqual(replay.body, receipt);
    assert.deepEqual(await publicationState(f), beforeReplay);

    // This conflict is reachable through HTTP: one campus has an explicit
    // image on its active branch; every other branch has missing/inherit there.
    // It does not claim two different dormant images for one campus are reachable.
    const overrideDraft = f.intent(
      await f.context(campus),
      'set_category_override_scoped',
      {
        categoryId,
        name: { mode: 'inherit' },
        description: { mode: 'inherit' },
        icon: { mode: 'set', value: null },
      },
    );
    const overrideUpload = await f.ready(
      overrideDraft,
      { kind: 'override', categoryId, campusId: f.campusA },
      images[1]!,
    );
    const override = await f.execute(overrideUpload.input);
    const conflictingRoots = await roots(f, categoryId);
    assert.equal(
      conflictingRoots.filter((root) => root.kind === 'base').length,
      bridges.length,
    );
    const explicit = conflictingRoots.filter(
      (root) => root.kind === 'override',
    );
    assert.equal(explicit.length, 1);
    assert.ok(
      explicit[0]!.kind === 'override' && explicit[0]!.value.kind === 'image',
    );
    const overrideAppearance = explicit[0]!.value.appearance.appearanceId;
    assert.notEqual(overrideAppearance, appearance.appearanceId);
    assert.equal(
      await publicAppearance(f, categoryId, campus),
      overrideAppearance,
    );
    assert.equal(
      await publicAppearance(f, categoryId, globalSelector),
      appearance.appearanceId,
    );
    assert.equal(
      (await bindings(f, categoryId)).filter(
        (binding) => binding.detached_at === null,
      ).length,
      2,
    );
    assert.equal(override.receipt.outcome, 'applied');
    const scopePayload = {
      categoryId,
      placement: { kind: 'campuses', campusIds: [f.campusA, f.campusB].sort() },
      propagation: 'self',
    };
    const conflictingMerge = f.intent(
      await f.context(globalSelector),
      'set_category_scope_scoped',
      scopePayload,
    );
    const beforeConflict = await publicationState(f);
    const denied = await f.post('prepare', conflictingMerge);
    assert.equal(denied.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
    assert.deepEqual(
      await publicationState(f),
      beforeConflict,
      'Conflicting complete closure must leave every owner/Media artifact unchanged',
    );
    assert.deepEqual(await roots(f, categoryId), conflictingRoots);

    // Explicit user-level inherit resolves the actual conflict. Consolidation
    // must retain the same shared appearance and all predecessor definitions.
    await f.execute(
      f.intent(await f.context(campus), 'set_category_override_scoped', {
        categoryId,
        name: { mode: 'inherit' },
        description: { mode: 'inherit' },
        icon: { mode: 'inherit' },
      }),
    );
    const beforeMergeRoots = await roots(f, categoryId);
    const beforeMergeBindings = await bindings(f, categoryId);
    const merge = f.intent(
      await f.context(globalSelector),
      'set_category_scope_scoped',
      scopePayload,
    );
    const merging = await f.prepare(merge);
    const mergePlan = await f.stored(merge);
    assert.equal(
      mergePlan.category_plan.envelopes.length,
      1,
      'The original text owner supplies the merged Review5 source',
    );
    assert.ok(mergePlan.media_plan.reviewEnvelopes.length > 0);
    assert.deepEqual(mergePlan.media_plan.plan.newAppearances, []);
    assert.equal(
      mergePlan.media_plan.plan.afterRoots.filter(
        (root) => root.kind === 'base',
      ).length,
      1,
    );
    await f.approveIcons(merge);
    const withoutText = await publicationState(f);
    assert.equal(
      (await f.commit(merge, merging.contextRevision)).body.error.code,
      'CONTENT_REVIEW_UNAVAILABLE',
    );
    assert.deepEqual(
      await publicationState(f),
      withoutText,
      'Review8 must not replace the original Review5 gate',
    );
    await f.approveText(merge);
    const mergedResponse = await f.commit(merge, merging.contextRevision);
    categoryIconHttpOk(mergedResponse);
    const merged = ratingCategoryIconReceiptSchema.parse(mergedResponse.body);
    assert.ok(merged.outcome === 'applied' && merged.result.releaseId);
    await assertRelease(f, merge, merged.result.releaseId);
    const finalRoots = await roots(f, categoryId);
    assert.deepEqual(finalRoots, mergePlan.media_plan.plan.afterRoots);
    const finalBases = finalRoots.filter((root) => root.kind === 'base');
    assert.equal(finalBases.length, 1);
    const finalBase = finalBases[0]!;
    assert.ok(finalBase.kind === 'base' && finalBase.value.kind === 'image');
    assert.deepEqual(finalBase.value.appearance, appearance);
    assert.deepEqual(
      finalBase.scopeKeys,
      [`campus:${f.campusA}`, `campus:${f.campusB}`].sort(),
    );
    const definition = (
      await f.pool.query<{ predecessors: string[]; appearance_id: string }>(
        'SELECT predecessors,appearance_id FROM whaleu_ratings.category_icon_definitions WHERE id=$1',
        [finalBase.definitionId],
      )
    ).rows[0]!;
    assert.deepEqual(
      definition.predecessors,
      beforeMergeRoots
        .filter((root) => root.kind === 'base')
        .map((root) => root.definitionId)
        .sort(),
    );
    assert.equal(definition.appearance_id, appearance.appearanceId);
    assert.deepEqual(
      await bindings(f, categoryId),
      beforeMergeBindings,
      'Merging references must neither bind again nor detach an existing image',
    );
    assert.equal(
      await publicAppearance(f, categoryId, campus),
      appearance.appearanceId,
    );
    assert.equal(
      await publicAppearance(f, categoryId, {
        kind: 'campus',
        campusId: f.campusB,
      }),
      appearance.appearanceId,
    );
    assert.ok(
      !(await f.publicPage(globalSelector)).page.items.some(
        (item) => item.id === categoryId,
      ),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_icon_terminal_retirements WHERE appearance_id=$1',
          [appearance.appearanceId],
        )
      ).rowCount,
      0,
    );
  },
);
