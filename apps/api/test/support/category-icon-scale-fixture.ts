/** TEST ONLY. Original native Category receipts prove absence before adoption.
 * Bulk target issuance precedes scoped activation and managed absence lineage.
 * Only then do real C1 commands replace two icons. No opaque legacy category,
 * C1 absence/projection row, forged native command or source-guard bypass. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { categoryIconManagementFixture } from './category-icon-management-fixtures.js';
import { withCommunityScopeWriter } from './community-scope-fixtures.js';
import { writeRatingApproval } from './rating-runtime-fixture.js';
import {
  writeRatingScopedSource,
  type RatingScopedFixture,
} from './rating-scoped-fixture.js';
import { writeSyntheticNativeBridge } from './rating-scoped-adoption-fixture.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
import { canonicalRatingEnvelope } from '../../src/community/content-review/rating-contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';

export async function setCategoryScaleAssetState(
  f: Pick<RatingScopedFixture, 'pool'>,
  assetId: string,
  state: 'allow' | 'unknown',
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const before = (
      await tx.query<{
        revision: string;
        manifest_digest: string;
        policy_revision: string;
      }>(
        `SELECT h.revision::text,a.manifest_digest,a.policy_revision
         FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id
         WHERE a.id=$1 FOR UPDATE OF a,h`,
        [assetId],
      )
    ).rows[0];
    assert.ok(
      before,
      'Only an actually processed and bound asset may change safety',
    );
    const eventId = randomUUID(),
      revision = String(BigInt(before.revision) + 1n);
    await tx.query(
      `INSERT INTO whaleu_media.asset_safety_events
       (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
       VALUES($1::uuid,$2,$3,$4,$5,$6,'synthetic-category-scale',($1::uuid)::text,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
      [
        eventId,
        assetId,
        revision,
        state,
        before.manifest_digest,
        before.policy_revision,
      ],
    );
    await tx.query(
      'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
      [assetId, revision, eventId],
    );
  });
}

async function issueTargets(
  f: RatingScopedFixture,
  tx: PoolClient,
  groups: readonly { categoryId: string; count: number }[],
) {
  const scopeKeys = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
  const anchors = (
    await tx.query<{ catalog_id: string; id: string; revision: string }>(
      `SELECT c.catalog_id,c.id,c.revision FROM whaleu_ratings.catalog_heads h
       JOIN whaleu_ratings.categories c ON c.catalog_id=h.catalog_id
       WHERE h.scope_key=$1 AND c.id=ANY($2::uuid[]) ORDER BY c.id`,
      [f.regionId, groups.map((group) => group.categoryId)],
    )
  ).rows;
  assert.equal(
    anchors.length,
    groups.length,
    'Real original native category anchors are required',
  );
  assert.equal(
    (
      await tx.query(
        "SELECT 1 FROM whaleu_ratings.scope_protocol_versions WHERE phase='adopted'",
      )
    ).rowCount,
    0,
    'Bulk source issuance must precede adoption and managed absence lineage',
  );
  const targets: Array<{ id: string; revision: string; categoryId: string }> =
    [];
  for (const group of groups) {
    const anchor = anchors.find((row) => row.id === group.categoryId)!;
    for (let index = 0; index < group.count; index++) {
      const id = randomUUID(),
        revision = randomUUID(),
        sourceId = randomUUID(),
        name = `Category scale target ${targets.length + 1}`,
        description =
          'Exact original target beneath a proven native Category receipt';
      const envelope = canonicalRatingEnvelope({
        version: 1,
        accountId: f.creator.accountId,
        purpose: 'publish_rating_target',
        clientRequestId: randomUUID(),
        targetId: id,
        targetRevision: revision,
        categoryId: anchor.id,
        categoryRevision: anchor.revision,
        catalogRevision: anchor.catalog_id,
        scope: { regionId: f.regionId },
        assetIds: [],
        name,
        description,
      });
      const approval = await writeRatingApproval(tx, envelope);
      await tx.query(
        `INSERT INTO whaleu_ratings.target_sources
         (id,target_id,origin,coverage,provenance,source_reference,policy_reference,effective_at)
         VALUES($1,$2,'new_native','complete','accepted','synthetic-category-scale-original-target',
           'synthetic-independent-fresh-target-policy',clock_timestamp())`,
        [sourceId, id],
      );
      // The original INSERT triggers create the exact definition/head/lifecycle,
      // creation, like/subscription/order baselines and reverse causal links.
      await tx.query(
        `INSERT INTO whaleu_ratings.targets
         (id,revision,category_id,creator_id,region_id,source_id,name,description,active,envelope)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9::jsonb)`,
        [
          id,
          revision,
          anchor.id,
          f.creator.accountId,
          f.regionId,
          sourceId,
          name,
          description,
          canonicalJson(envelope),
        ],
      );
      await tx.query(
        `INSERT INTO whaleu_ratings.score_baselines(target_id,id,kind,source_id,source_reference,policy_reference)
         VALUES($1,$2,'fresh_zero',$3,'synthetic-independent-category-scale-baseline','synthetic-fresh-target-score-policy')`,
        [id, randomUUID(), sourceId],
      );
      await tx.query(
        `INSERT INTO whaleu_community.rating_approval_bindings
         (kind,subject_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
         VALUES('target',$1,1,$2,$3,'publish_rating_target',1,$4,$5::jsonb,$6::jsonb)`,
        [
          id,
          approval.decisionId,
          f.creator.accountId,
          approval.digest,
          canonicalJson(envelope),
          canonicalJson(envelope.scope),
        ],
      );
      const placement = await writeRatingScopedSource(tx, {
        kind: 'scoped_target_placement',
        key: `category-scale-target:${id}`,
        scopeKeys,
        payload: { targetId: id, categoryId: anchor.id },
      });
      await tx.query(
        `INSERT INTO whaleu_ratings.target_scope_placements
         (placement_revision,target_id,scope_keys,source_id,source_revision) VALUES($1,$2,$3::text[],$4,$5)`,
        [randomUUID(), id, scopeKeys, placement.id, placement.revision],
      );
      targets.push({ id, revision, categoryId: anchor.id });
    }
  }
  return { targets, scopeKeys };
}

export async function categoryIconScaleFixture() {
  const sharp = (await import('sharp')).default;
  const png = await sharp({
    create: { width: 44, height: 36, channels: 3, background: '#326c8a' },
  })
    .png()
    .toBuffer();
  type NativeCreation = Awaited<
    ReturnType<RatingScopedFixture['createCategories']>
  >;
  type Bridge = Awaited<
    ReturnType<typeof writeSyntheticNativeBridge>
  >['bridge'];
  type InventoryEntry = {
    catalogId: string;
    scopeKey: string;
    categoryId: string;
    identityId: string;
    baseSource: { id: string; revision: string };
    overrideSource: null;
    baseEvidence: {
      kind: 'absent';
      evidenceId: string;
      evidenceDigest: string;
    };
    overrideEvidence: null;
  };
  let bootstrap:
    | {
        native: NativeCreation;
        targets: Awaited<ReturnType<typeof issueTargets>>['targets'];
        scopeKeys: string[];
        rootId: string;
        childId: string;
        siblingId: string;
        bridges: Map<string, Bridge>;
      }
    | undefined;
  const f = await categoryIconManagementFixture(
    [{ sha256: sha256(png), verdict: 'allow' }],
    {
      bootstrap: {
        beforeAdoption: async (base: RatingScopedFixture) => {
          const native = await base.createCategories(
            base.creator,
            base.regionId,
            {
              nodes: [
                {
                  key: 'root',
                  parentKey: null,
                  name: 'Strict native scale root',
                  description: 'Exact native creation receipt proves no icon',
                },
                {
                  key: 'child',
                  parentKey: 'root',
                  name: 'C1 scale 1001 child',
                  description: 'Exact native absence under an image ancestor',
                },
                {
                  key: 'sibling',
                  parentKey: 'root',
                  name: 'Strict native scale sibling',
                  description: 'Exact native creation receipt proves no icon',
                },
              ],
            },
          );
          const catalog = native.receipt.catalogs.find(
            (row) => row.regionId === base.regionId,
          );
          assert.ok(
            catalog,
            'The real native command must publish its regional catalog',
          );
          const categories = (
            await base.pool.query<{
              id: string;
              revision: string;
              name: string;
            }>(
              'SELECT id,revision,name FROM whaleu_ratings.categories WHERE catalog_id=$1 ORDER BY ordinal',
              [catalog.catalogRevision],
            )
          ).rows;
          assert.equal(categories.length, 3);
          const named = (name: string) => {
            const row = categories.find((category) => category.name === name);
            assert.ok(row);
            return row.id;
          };
          const rootId = named('Strict native scale root'),
            childId = named('C1 scale 1001 child'),
            siblingId = named('Strict native scale sibling');
          const seeded = await withCommunityScopeWriter(base.pool, (tx) =>
            issueTargets(base, tx, [
              { categoryId: childId, count: 1001 },
              { categoryId: siblingId, count: 1047 },
            ]),
          );
          const bridges = new Map<string, Bridge>();
          await withCommunityScopeWriter(base.pool, async (tx) => {
            for (const category of categories) {
              const { bridge } = await writeSyntheticNativeBridge(tx, {
                legacyCatalogId: catalog.catalogRevision,
                categoryId: category.id,
                categoryRevision: category.revision,
                scopeKeys: seeded.scopeKeys,
              });
              const proof = (
                await tx.query<{
                  origin: { kind: string; requestId: string } | null;
                }>(
                  'SELECT whaleu_ratings.category_icon_native_text_origin($1,$2,$3,$3) origin',
                  [bridge.id, bridge.revision, category.id],
                )
              ).rows[0]!.origin;
              assert.ok(
                proof,
                'A bridge must prove the actual native creation, not an opaque legacy row',
              );
              assert.equal(proof.kind, 'next-native-strict-text');
              assert.equal(proof.requestId, native.input.clientRequestId);
              bridges.set(category.id, bridge);
            }
          });
          await base.declareAll();
          for (const scopeKey of seeded.scopeKeys)
            await base.declareScope(scopeKey, {
              categoryIds: categories.map((category) => category.id).sort(),
              targetIds: seeded.targets.map((target) => target.id).sort(),
              legacyCatalogIds: [catalog.catalogRevision],
            });
          bootstrap = {
            native,
            ...seeded,
            rootId,
            childId,
            siblingId,
            bridges,
          };
        },
        registerCapabilities: async (base: RatingScopedFixture) => {
          assert.ok(bootstrap);
          const initial = bootstrap;
          const protocols = (
            await base.pool.query<{
              id: string;
              inventory: InventoryEntry[] | null;
            }>(
              `SELECT v.id,whaleu_ratings.category_icon_coverage_inventory(v.id) inventory
           FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id
           WHERE v.phase='adopted' ORDER BY v.id`,
            )
          ).rows;
          assert.ok(protocols.length > 0);
          const coverage = protocols.flatMap((protocol) => {
            assert.ok(
              protocol.inventory,
              'Every adopted catalog must have SQL-derived strict native absence',
            );
            return protocol.inventory;
          });
          assert.equal(
            coverage.length,
            6,
            'The nonempty original adoption has three categories in both campuses',
          );
          for (const entry of coverage) {
            const bridge = initial.bridges.get(entry.categoryId);
            assert.ok(bridge);
            assert.ok(initial.scopeKeys.includes(entry.scopeKey));
            assert.equal(entry.identityId, entry.categoryId);
            assert.deepEqual(entry.baseSource, {
              id: bridge.id,
              revision: bridge.revision,
            });
            assert.equal(entry.baseEvidence.kind, 'absent');
            assert.equal(
              entry.baseEvidence.evidenceId,
              initial.native.input.clientRequestId,
            );
            assert.match(entry.baseEvidence.evidenceDigest, /^[a-f0-9]{64}$/);
            assert.equal(entry.overrideSource, null);
            assert.equal(entry.overrideEvidence, null);
          }
          await withCommunityScopeWriter(base.pool, async (tx) => {
            for (const protocol of protocols) {
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
            }
            const registered = (
              await tx.query<{ inventory: InventoryEntry[]; current: boolean }>(
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
  try {
    assert.ok(bootstrap);
    const initial = bootstrap;
    const selector = { kind: 'campus' as const, campusId: f.campusA };
    const rootDraft = f.intent(
      await f.context(selector),
      'edit_category_base_scoped',
      {
        categoryId: initial.rootId,
        name: 'C1 scale root',
        description: 'Shared ancestor icon',
        icon: { mode: 'clear' },
      },
    );
    const rootUpload = await f.ready(
      rootDraft,
      { kind: 'base', categoryId: initial.rootId },
      png,
    );
    const rootCreated = await f.execute(rootUpload.input);
    assert.equal(rootCreated.receipt.outcome, 'applied');
    const siblingDraft = f.intent(
      await f.context(selector),
      'edit_category_base_scoped',
      {
        categoryId: initial.siblingId,
        name: 'C1 scale 1047 sibling',
        description: 'Independent unselected image path',
        icon: { mode: 'clear' },
      },
    );
    const siblingUpload = await f.ready(
      siblingDraft,
      { kind: 'base', categoryId: initial.siblingId },
      png,
    );
    const siblingCreated = await f.execute(siblingUpload.input);
    assert.equal(siblingCreated.receipt.outcome, 'applied');
    const currentDecisions = (
      await f.pool.query<{ decision_id: string }>(
        `SELECT b.decision_id FROM whaleu_ratings.scoped_catalog_heads h
       JOIN whaleu_ratings.category_icon_projections p ON(p.catalog_id,p.release_id)=(h.catalog_id,h.release_id)
       JOIN whaleu_ratings.category_icon_review_bindings b ON b.id=p.review_binding_id ORDER BY b.decision_id`,
      )
    ).rows.map((row) => row.decision_id);
    assert.equal(currentDecisions.length, 6);
    const iconApprovals = [
      ...rootCreated.icons,
      ...siblingCreated.icons,
    ].filter((approval) => currentDecisions.includes(approval.decisionId));
    assert.deepEqual(
      iconApprovals.map((approval) => approval.decisionId).sort(),
      currentDecisions,
    );
    const beforeCarryReleaseId = siblingCreated.receipt.result.releaseId;
    // A source release with unchanged accepted inputs exercises the real C1
    // carry hook without manufacturing a successor to managed scope_absence.
    const release = await f.publish();
    return {
      ...f,
      ...initial,
      selector,
      release,
      rootUpload,
      siblingUpload,
      rootCreated,
      siblingCreated,
      iconApprovals,
      beforeCarryReleaseId,
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
