import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  ratingScopedFixture,
  writeRatingScopedSource,
} from '../support/rating-scoped-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
  writeSyntheticNativeBridge,
  editSyntheticAdoptedTarget,
  type SyntheticAdoptionAttack,
} from '../support/rating-scoped-adoption-fixture.js';
import { ApplicationError } from '../../src/http/application-error.js';

const rejectedSql = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  ['23514', '23503', '23505'].includes(String(error.code));
const rejectedCompilation = (error: unknown) =>
  rejectedSql(error) ||
  (error instanceof ApplicationError &&
    [
      'RATING_SCOPE_UNAVAILABLE',
      'CONTENT_REVIEW_UNAVAILABLE',
      'RATING_UNAVAILABLE',
    ].includes(error.code));

test(
  'M3B opaque adoption uses independent evidence identities, preserves another region and edits the original target',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const actor = f.creator,
      sharedCategoryId = randomUUID();
    const original = await f.catalog(actor, {
      regionId: f.regionId,
      categoryIds: [sharedCategoryId],
    });
    const otherRegion = await f.catalog(actor, {
      regionId: f.scope.related.regionId,
      categoryIds: [sharedCategoryId],
    });
    const scopeKeys = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
    const target = original.targets[0]!;
    const originals = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
    'catalogs',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM whaleu_ratings.catalogs c WHERE id=ANY($1::uuid[])),
    'categories',(SELECT jsonb_agg(to_jsonb(c) ORDER BY catalog_id,id) FROM whaleu_ratings.categories c WHERE catalog_id=ANY($1::uuid[])),
    'lineage',(SELECT jsonb_agg(to_jsonb(c) ORDER BY catalog_id,category_id) FROM whaleu_ratings.catalog_category_lineage c WHERE catalog_id=ANY($1::uuid[])),
    'memberships',(SELECT jsonb_agg(to_jsonb(c) ORDER BY catalog_id,target_id) FROM whaleu_ratings.target_memberships c WHERE catalog_id=ANY($1::uuid[]))) state`,
          [[original.catalogId, otherRegion.catalogId]],
        )
      ).rows[0]!.state;
    const beforeOriginals = await originals();
    const otherHead = (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.catalog_heads WHERE scope_key=$1',
        [otherRegion.regionId],
      )
    ).rows[0]!;
    const adoption = await prepareSyntheticOpaqueAdoption(
      f,
      original.catalogId,
      sharedCategoryId,
      scopeKeys,
    );
    assert.notEqual(adoption.identityId, sharedCategoryId);
    await f.declareAll();
    for (const key of scopeKeys)
      await f.declareScope(key, {
        categoryIds: [sharedCategoryId],
        targetIds: [target.id],
        legacyCatalogIds: [original.catalogId],
      });
    await f.capability();
    const state = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'sources',(SELECT count(*) FROM whaleu_ratings.scoped_source_attestations),
    'manifests',(SELECT count(*) FROM whaleu_ratings.legacy_adoption_manifests),
    'identities',(SELECT count(*) FROM whaleu_ratings.scoped_adoption_identities),
    'aliases',(SELECT count(*) FROM whaleu_ratings.scoped_adoption_aliases),
    'placements',(SELECT count(*) FROM whaleu_ratings.category_scope_placements),
    'releases',(SELECT count(*) FROM whaleu_ratings.scoped_releases),
    'sourceEpoch',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton),
    'navigationEpoch',(SELECT epoch FROM whaleu_ratings.navigation_epoch WHERE singleton)) state`)
      ).rows[0]!.state;
    const reject = async (attack: SyntheticAdoptionAttack, compile = false) => {
      const before = await state();
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          await writeSyntheticOpaqueAdoption(tx, adoption, attack);
          if (compile)
            await f.publish(
              { domain: { kind: 'region_compat', regionId: f.regionId } },
              tx,
            );
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        }),
        compile ? rejectedCompilation : rejectedSql,
        attack,
      );
      assert.deepEqual(
        await state(),
        before,
        `${attack}: no partial adoption, publication or epoch advance`,
      );
      assert.deepEqual(await originals(), beforeOriginals);
    };

    await t.test(
      'forged alias, crosswalk and original row digest are rejected by real deferred reverse guards',
      async () => {
        for (const attack of [
          'crosswalk',
          'row_digest',
          'alias_source',
          'alias_digest',
          'missing_alias',
        ] as const)
          await reject(attack);
        await reject('wrong_identity', true);
        await reject('missing_review', true);
        const before = await state();
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            writeRatingScopedSource(tx, {
              kind: 'legacy_adoption',
              key: 'synthetic-forged-adoption-without-manifest',
              scopeKeys,
              payload: {
                categoryId: sharedCategoryId,
                identityId: randomUUID(),
                manifestId: randomUUID(),
                crosswalk: [],
                placement: adoption.placement,
              },
            }),
          ),
          rejectedSql,
        );
        assert.deepEqual(
          await state(),
          before,
          'A raw accepted source flag cannot replace a manifest',
        );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            writeRatingScopedSource(tx, {
              kind: 'scoped_category_base',
              key: 'synthetic-raw-review-without-binding',
              scopeKeys,
              payload: {
                reviewEnvelope: adoption.envelope,
                issuanceDigest: adoption.envelope.issuanceDigest,
                active: true,
                hidden: false,
                ordinal: '0',
                originKind: 'regional',
              },
            }),
          ),
          rejectedSql,
        );
        assert.deepEqual(
          await state(),
          before,
          'A raw source cannot relabel the independently reviewed body',
        );
      },
    );

    await t.test(
      'real adoption preserves original opaque rows and business IDs without inserting legacy category identities',
      async () => {
        const issued = await withCommunityScopeWriter(f.pool, (tx) =>
          writeSyntheticOpaqueAdoption(tx, adoption),
        );
        assert.deepEqual(await originals(), beforeOriginals);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.category_identities WHERE id=ANY($1::uuid[])',
              [[sharedCategoryId, adoption.identityId]],
            )
          ).rowCount,
          0,
        );
        const identities = (
          await f.pool.query(
            'SELECT id,entity_kind,legacy_business_id FROM whaleu_ratings.scoped_adoption_identities WHERE manifest_id=$1 ORDER BY entity_kind,legacy_business_id',
            [issued.manifestId],
          )
        ).rows;
        assert.equal(identities.length, 2);
        assert.equal(identities[0]!.id, adoption.identityId);
        assert.equal(identities[0]!.legacy_business_id, sharedCategoryId);
        assert.equal(identities[1]!.legacy_business_id, target.id);
        const body = (
          await f.pool.query(
            'SELECT whaleu_ratings.scoped_adoption_category($1,$2) body',
            [issued.source.id, issued.source.revision],
          )
        ).rows[0]!.body;
        assert.equal(body.identityKind, 'adopted');
        assert.equal(body.identityId, adoption.identityId);
        assert.equal(body.id, sharedCategoryId);
        assert.equal(body.name, adoption.category.name);
        assert.equal(body.description, adoption.category.description);
        const published = await f.publish({
          activate: true,
          domain: { kind: 'region_compat', regionId: f.regionId },
        });
        assert.equal(published.outputs.length, 2);
        for (const output of published.outputs) {
          assert.equal(output.categories.length, 1);
          assert.equal(output.memberships.length, 1);
          assert.equal(
            output.categories[0]!.expected.body.identityId,
            adoption.identityId,
          );
          assert.equal(
            output.categories[0]!.expected.body.id,
            sharedCategoryId,
          );
          assert.equal(output.memberships[0]!.targetId, target.id);
        }
        assert.deepEqual(await originals(), beforeOriginals);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.catalog_heads WHERE scope_key=$1',
              [otherRegion.regionId],
            )
          ).rows[0],
          otherHead,
        );
        const otherCurrent = await f.pool.query<{ current: boolean }>(
          'SELECT whaleu_ratings.category_catalog_sources_complete($1) AND whaleu_ratings.category_ancestry_current($1,$2) current',
          [otherRegion.catalogId, sharedCategoryId],
        );
        assert.equal(
          otherCurrent.rows[0]!.current,
          true,
          'Same opaque business ID elsewhere remains its own legacy contract',
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scope_protocol_heads WHERE logical_scope_key=$1',
              [otherRegion.regionId],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'an old v1 target is edited through scoped Review v5 twice without changing its origin, business key or old definition',
      async () => {
        const old = (
          await f.pool.query(
            'SELECT to_jsonb(t) row FROM whaleu_ratings.targets t WHERE id=$1',
            [target.id],
          )
        ).rows[0]!.row;
        const initial = (
          await f.pool.query(
            'SELECT to_jsonb(v) row FROM whaleu_ratings.target_definition_versions v WHERE target_id=$1 AND content_version=1',
            [target.id],
          )
        ).rows[0]!.row;
        const selector = { kind: 'campus' as const, campusId: f.campusA };
        const first = await editSyntheticAdoptedTarget(
          f,
          target.id,
          selector,
          'First scoped edit of original target',
        );
        assert.equal(first.state.contentVersion, 1);
        assert.equal(first.receipt.result['contentVersion'], 2);
        assert.equal(first.approved.envelope.version, 5);
        const second = await editSyntheticAdoptedTarget(
          f,
          target.id,
          selector,
          'Second scoped edit of original target',
        );
        assert.equal(second.state.contentVersion, 2);
        assert.equal(second.receipt.result['contentVersion'], 3);
        const current = (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.targets WHERE id=$1',
            [target.id],
          )
        ).rows[0]!;
        for (const field of [
          'id',
          'category_id',
          'creator_id',
          'region_id',
          'source_id',
          'name',
          'description',
          'envelope',
        ])
          assert.deepEqual(current[field], old[field], field);
        assert.equal(current.revision, second.receipt.result['revision']);
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT to_jsonb(v) row FROM whaleu_ratings.target_definition_versions v WHERE target_id=$1 AND content_version=1',
              [target.id],
            )
          ).rows[0]!.row,
          initial,
        );
        const definitions = (
          await f.pool.query(
            `SELECT v.content_version,v.envelope->>'version' version,
      (SELECT count(*)::int FROM whaleu_ratings.target_definition_lifecycles l WHERE l.target_id=v.target_id AND l.definition_revision=v.definition_revision) lifecycles
      FROM whaleu_ratings.target_definition_versions v WHERE v.target_id=$1 ORDER BY content_version`,
            [target.id],
          )
        ).rows;
        assert.deepEqual(definitions, [
          { content_version: 1, version: '1', lifecycles: 1 },
          { content_version: 2, version: '5', lifecycles: 1 },
          { content_version: 3, version: '5', lifecycles: 1 },
        ]);
        for (const command of [first, second]) {
          const receipt = await f.auth(
            request(f.http).get(
              `/v2/ratings/requests/${command.input.payload.clientRequestId}`,
            ),
            actor,
          );
          assert.deepEqual(receipt.body, command.receipt);
        }
        assert.deepEqual(await originals(), beforeOriginals);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.category_identities WHERE id=$1',
              [sharedCategoryId],
            )
          ).rowCount,
          0,
        );
      },
    );
  },
);

test(
  'M3B mixed native + opaque legacy catalog cannot silently compile only the known native subset',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const actor = f.creator;
    const legacy = await f.catalog(actor, { regionId: f.regionId });
    await f.grant(actor, 'developer');
    const native = await f.createCategories(actor, f.regionId, {
      nodes: [
        {
          key: 'native',
          parentKey: null,
          name: 'Native neighbor of opaque row',
          description: '',
        },
      ],
    });
    const catalog = native.receipt.catalogs.find(
      (c) => c.regionId === f.regionId,
    )!;
    assert.ok(catalog);
    const nativeCategory = native.receipt.categories[0]!;
    const scopeKeys = [`campus:${f.campusA}`, `campus:${f.campusB}`].sort();
    const rows = (
      await f.pool.query(
        'SELECT category_id,source_kind FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=$1 ORDER BY category_id',
        [catalog.catalogRevision],
      )
    ).rows;
    assert.deepEqual(rows.map((row) => row.source_kind).sort(), [
      'native',
      'opaque',
    ]);
    await withCommunityScopeWriter(f.pool, (tx) =>
      writeSyntheticNativeBridge(tx, {
        legacyCatalogId: catalog.catalogRevision,
        categoryId: nativeCategory.id,
        categoryRevision: nativeCategory.revision,
        scopeKeys,
      }),
    );
    await f.declareAll();
    await f.capability();
    for (const key of scopeKeys)
      await f.declareScope(key, {
        categoryIds: [nativeCategory.id],
        targetIds: [],
        legacyCatalogIds: [catalog.catalogRevision],
      });
    const before = (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.catalog_heads ORDER BY scope_key',
      )
    ).rows;
    await assert.rejects(
      () =>
        f.publish({ domain: { kind: 'region_compat', regionId: f.regionId } }),
      rejectedCompilation,
    );
    assert.equal(
      (await f.pool.query('SELECT 1 FROM whaleu_ratings.scoped_catalog_heads'))
        .rowCount,
      0,
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.catalog_heads ORDER BY scope_key',
        )
      ).rows,
      before,
    );
    const adoption = await prepareSyntheticOpaqueAdoption(
      f,
      catalog.catalogRevision,
      legacy.categoryId,
      scopeKeys,
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      writeSyntheticOpaqueAdoption(tx, adoption),
    );
    for (const key of scopeKeys)
      await f.declareScope(key, {
        categoryIds: [nativeCategory.id, legacy.categoryId].sort(),
        targetIds: [legacy.targets[0]!.id],
        legacyCatalogIds: [catalog.catalogRevision],
      });
    const published = await f.publish({
      activate: true,
      domain: { kind: 'region_compat', regionId: f.regionId },
    });
    for (const output of published.outputs) {
      assert.deepEqual(
        output.categories.map((c) => c.expected.body.id).sort(),
        [nativeCategory.id, legacy.categoryId].sort(),
      );
      assert.deepEqual(
        output.categories.map((c) => c.expected.body.identityKind).sort(),
        ['adopted', 'native_bridge'],
      );
      assert.deepEqual(
        output.memberships.map((m) => m.targetId),
        [legacy.targets[0]!.id],
      );
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_ratings.category_identities WHERE id=$1',
          [legacy.categoryId],
        )
      ).rowCount,
      0,
    );
    const legacyRows = (
      await f.pool.query(
        'SELECT source_kind FROM whaleu_ratings.catalog_category_lineage WHERE catalog_id=$1 AND category_id=$2',
        [catalog.catalogRevision, legacy.categoryId],
      )
    ).rows;
    assert.deepEqual(legacyRows, [{ source_kind: 'opaque' }]);
  },
);
