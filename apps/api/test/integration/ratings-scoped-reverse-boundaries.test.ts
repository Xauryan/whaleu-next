import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  ratingScopedFixture,
  writeRatingScopedSource,
} from '../support/rating-scoped-fixture.js';
import {
  prepareSyntheticOpaqueAdoption,
  writeSyntheticOpaqueAdoption,
} from '../support/rating-scoped-adoption-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { ApplicationError } from '../../src/http/application-error.js';

test(
  'whole-release reverse boundaries survive early flush, late leaves and forged sealed parents',
  { timeout: 180000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const seeded = await f.seedScopedCatalogs({ different: false });
    await t.test(
      'set-wise source vector digest is byte-identical to the original canonical serializer, including fallback shapes',
      async () => {
        for (const value of [
          [],
          [
            {
              id: 'quoted"id',
              revision: '换行\n',
              kind: 'unicode中文',
              key: 'slash\\tab\t',
              digest: 'd',
            },
          ],
          [
            {
              id: 'x',
              revision: 'y',
              kind: 'z',
              key: 'k',
              digest: 'd',
              extra: true,
            },
          ],
          [{ id: null }],
          ['not an object'],
          null,
        ]) {
          const result = (
            await f.pool.query(
              `SELECT whaleu_ratings.scoped_digest('vector',$1::jsonb) optimized,
        encode(sha256(convert_to('whaleu:rating-scoped-vector:v1'||chr(10)||whaleu_ratings.creation_canonical_json($1::jsonb),'UTF8')),'hex') original`,
              [JSON.stringify(value)],
            )
          ).rows[0]!;
          assert.equal(result.optimized, result.original);
        }
        const result = (
          await f.pool
            .query(`WITH input AS(SELECT jsonb_agg(jsonb_build_object('id',n::text,'revision',n::text,'kind','source','key',n::text,'digest','digest') ORDER BY n) value FROM generate_series(1,6144)n)
      SELECT whaleu_ratings.scoped_digest('vector',value) optimized,encode(sha256(convert_to('whaleu:rating-scoped-vector:v1'||chr(10)||whaleu_ratings.creation_canonical_json(value),'UTF8')),'hex') original FROM input`)
        ).rows[0]!;
        assert.equal(result.optimized, result.original);
      },
    );
    const snapshot = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'releases',(SELECT count(*) FROM whaleu_ratings.scoped_releases),
    'catalogs',(SELECT count(*) FROM whaleu_ratings.scoped_catalogs),
    'categories',(SELECT count(*) FROM whaleu_ratings.scoped_categories),
    'lineage',(SELECT count(*) FROM whaleu_ratings.scoped_category_lineage),
    'memberships',(SELECT count(*) FROM whaleu_ratings.scoped_target_memberships),
    'heads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY scope_key) FROM whaleu_ratings.scoped_catalog_heads h),
    'protocols',(SELECT jsonb_agg(to_jsonb(h) ORDER BY logical_scope_key) FROM whaleu_ratings.scope_protocol_heads h),
    'compat',(SELECT count(*) FROM whaleu_ratings.compat_versions),
    'legacy',(SELECT count(*) FROM whaleu_ratings.catalogs),
    'legacyHeads',(SELECT jsonb_agg(to_jsonb(h) ORDER BY scope_key) FROM whaleu_ratings.catalog_heads h),
    'sources',(SELECT count(*) FROM whaleu_ratings.scoped_source_attestations),
    'placements',(SELECT count(*) FROM whaleu_ratings.category_scope_placements),
    'adoptions',(SELECT count(*) FROM whaleu_ratings.legacy_adoption_manifests),
    'adoptionIdentities',(SELECT count(*) FROM whaleu_ratings.scoped_adoption_identities),
    'adoptionAliases',(SELECT count(*) FROM whaleu_ratings.scoped_adoption_aliases),
    'sourceEpoch',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch),
    'protocolEpoch',(SELECT epoch FROM whaleu_ratings.scope_protocol_epoch),
    'poolEpoch',(SELECT epoch FROM whaleu_ratings.random_pool_epoch),
    'navigationEpoch',(SELECT epoch FROM whaleu_ratings.navigation_epoch),
    'reviewEpoch',(SELECT epoch FROM whaleu_community.rating_review_epoch)) state`)
      ).rows[0]!.state;
    type Release = Awaited<ReturnType<typeof f.publish>>;
    const rejected = async (run: (tx: PoolClient) => Promise<void>) => {
      const before = await snapshot();
      await assert.rejects(
        withCommunityScopeWriter(f.pool, run),
        (error: unknown) =>
          error instanceof ApplicationError ||
          (!!error &&
            typeof error === 'object' &&
            'code' in error &&
            ['23514', '23503', '23505'].includes(String(error.code))),
      );
      assert.deepEqual(
        await snapshot(),
        before,
        'Every tentative output, head and epoch rolls back',
      );
    };
    const afterFlush = (
      run: (tx: PoolClient, release: Release) => Promise<void>,
    ) =>
      rejected(async (tx) => {
        const release = await f.publish({ activate: true }, tx);
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
        await run(tx, release);
      });
    // Demand an actual SQL integrity rejection before the application-owned
    // final epoch proof. If PostgreSQL accepts the forged state, fail here rather
    // than letting the later TypeScript proof hide the missing database guard.
    const rejectedAtSQLFlush = async (
      run: (tx: PoolClient, release: Release) => Promise<void>,
      message: string,
    ) => {
      const before = await snapshot();
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          const release = await f.publish({ activate: true }, tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          await tx.query('SET CONSTRAINTS ALL DEFERRED');
          await run(tx, release);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          assert.fail('PostgreSQL accepted a single-sided adopted publication');
        }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === '23514' &&
          error.message.includes(message),
      );
      assert.deepEqual(await snapshot(), before);
    };
    await t.test(
      'raw SQL rejects a newer empty opaque legacy head after a successful activation flush',
      () =>
        rejectedAtSQLFlush(async (tx) => {
          const catalog = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_ratings.catalogs(id,region_id,coverage,provenance,source_reference,policy_reference,effective_at,valid_until,sealed)
      VALUES($1,NULL,'complete','accepted','synthetic-late-opaque','synthetic-late-opaque',clock_timestamp(),clock_timestamp()+interval '1 hour',true)`,
            [catalog],
          );
          await tx.query(
            "UPDATE whaleu_ratings.catalog_heads SET catalog_id=$1 WHERE scope_key='global'",
            [catalog],
          );
        }, 'Adopted legacy head lacks its exact fresh compatibility cause'),
    );
    await t.test(
      'raw SQL rejects an otherwise exact adopted source release that omits compatibility publication',
      () =>
        rejectedAtSQLFlush(async (tx, activation) => {
          const before = activation.outputs.find(
            (output) => output.scopeKey === 'global',
          )!;
          const release = randomUUID();
          const catalog = randomUUID();
          const head = randomUUID();
          await tx.query(
            `WITH vector AS(SELECT whaleu_ratings.scoped_current_source_vector(ARRAY['global']) value)
      INSERT INTO whaleu_ratings.scoped_releases(id,compiler_version,cause_kind,cause,source_vector,source_digest,affected_scope_keys,negative_digest,valid_until)
      SELECT $1,old.compiler_version,'source_release',jsonb_build_object(
       'issuanceSourceId',old.cause->'capabilitySourceId','issuanceSourceRevision',old.cause->'capabilitySourceRevision',
       'sourceDigest',whaleu_ratings.scoped_digest('vector',vector.value),'topologySnapshotId',old.cause->'topologySnapshotId','inventoryFingerprint',old.cause->'inventoryFingerprint'),
       vector.value,whaleu_ratings.scoped_digest('vector',vector.value),ARRAY['global'],
       whaleu_ratings.scoped_digest('negative',jsonb_build_object('inventory',old.cause->'inventoryFingerprint','sources',vector.value)),old.valid_until
      FROM whaleu_ratings.scoped_releases old CROSS JOIN vector WHERE old.id=$2`,
            [release, activation.releaseId],
          );
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_catalogs
      SELECT (jsonb_populate_record(NULL::whaleu_ratings.scoped_catalogs,to_jsonb(c)||jsonb_build_object(
       'id',$2::uuid,'release_id',$3::uuid,'head_revision',$4::uuid,'sealed',false,'effective_at',clock_timestamp(),'publication_transaction',pg_current_xact_id()))).*
      FROM whaleu_ratings.scoped_catalogs c WHERE c.id=$1`,
            [before.id, catalog, release, head],
          );
          for (const table of [
            'scoped_categories',
            'scoped_category_lineage',
            'scoped_target_memberships',
          ])
            await tx.query(
              `INSERT INTO whaleu_ratings.${table}
      SELECT (jsonb_populate_record(NULL::whaleu_ratings.${table},to_jsonb(leaf)||jsonb_build_object('catalog_id',$2::uuid))).*
      FROM whaleu_ratings.${table} leaf WHERE leaf.catalog_id=$1`,
              [before.id, catalog],
            );
          await tx.query(
            'UPDATE whaleu_ratings.scoped_catalogs SET sealed=true WHERE id=$1',
            [catalog],
          );
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_release_scopes(release_id,scope_key,before_catalog_id,before_head_revision,after_catalog_id,after_head_revision)
      VALUES($1,'global',$2,$3,$4,$5)`,
            [release, before.id, before.headRevision, catalog, head],
          );
          await tx.query(
            "UPDATE whaleu_ratings.scoped_catalog_heads SET catalog_id=$1,release_id=$2,head_revision=$3 WHERE scope_key='global'",
            [catalog, release, head],
          );
        }, 'Adopted scoped release lacks its complete fresh compatibility publication'),
    );
    await t.test(
      'late category leaf cannot reuse a genuinely fresh but already sealed parent',
      () =>
        afterFlush(async (tx, release) => {
          const catalog = release.outputs.find(
            (out) => out.scopeKey === 'global',
          )!.id;
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_categories
      SELECT (jsonb_populate_record(NULL::whaleu_ratings.scoped_categories,to_jsonb(c)||jsonb_build_object('category_id',$2::uuid,'effective_revision',$3::uuid,'ordinal',999))).*
      FROM whaleu_ratings.scoped_categories c WHERE catalog_id=$1 LIMIT 1`,
            [catalog, randomUUID(), randomUUID()],
          );
        }),
    );
    await t.test(
      'a forged sealed catalog cannot borrow the genuine release after its complete set was flushed',
      () =>
        afterFlush(async (tx, release) => {
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_catalogs
      SELECT (jsonb_populate_record(NULL::whaleu_ratings.scoped_catalogs,to_jsonb(c)||jsonb_build_object('id',$2::uuid,'head_revision',$3::uuid))).*
      FROM whaleu_ratings.scoped_catalogs c WHERE id=$1`,
            [release.outputs[0]!.id, randomUUID(), randomUUID()],
          );
        }),
    );
    await t.test(
      'an unlisted scope cannot append to the immutable affected set after flush',
      () =>
        afterFlush(async (tx, release) => {
          await tx.query(
            `INSERT INTO whaleu_ratings.scoped_release_scopes(release_id,scope_key,after_catalog_id,after_head_revision)
      VALUES($1,$2,$3,$4)`,
            [
              release.releaseId,
              `campus:${randomUUID()}`,
              release.outputs[0]!.id,
              release.outputs[0]!.headRevision,
            ],
          );
        }),
    );
    await t.test(
      'zero-row source writers after full flush invalidate the retained final owner proof',
      () =>
        afterFlush(async (tx) => {
          const result = await tx.query(
            'UPDATE whaleu_ratings.scoped_source_attestations SET payload=payload WHERE false',
          );
          assert.equal(result.rowCount, 0);
        }),
    );
    await t.test(
      'a real Review withdrawal after full flush invalidates the closure and rolls back',
      () =>
        afterFlush(async (tx) => {
          const binding = (
            await tx.query(
              'SELECT decision_id FROM whaleu_community.rating_scoped_category_source_bindings ORDER BY decision_id LIMIT 1',
            )
          ).rows[0]!;
          const event = randomUUID();
          await tx.query(
            `INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
      VALUES($1,$2,'revoked','complete','accepted','synthetic-late-review','synthetic-late-review',clock_timestamp())`,
            [event, binding.decision_id],
          );
          await tx.query(
            'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
            [binding.decision_id, event],
          );
        }),
    );
    await t.test(
      'forcing immediate verification before output leaves exist never authorizes a partial publication',
      () =>
        rejected(async (tx) => {
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          await f.publish({ activate: true }, tx);
        }),
    );
    for (const table of ['scope_protocol_versions', 'compat_versions'])
      await t.test(
        `${table} cannot append a second per-domain version to an already flushed release`,
        () =>
          afterFlush(async (tx, release) => {
            await tx.query(
              `INSERT INTO whaleu_ratings.${table} SELECT (jsonb_populate_record(NULL::whaleu_ratings.${table},to_jsonb(v)||jsonb_build_object('id',$2::uuid,'previous_version_id',v.id))).* FROM whaleu_ratings.${table} v WHERE release_id=$1 LIMIT 1`,
              [release.releaseId, randomUUID()],
            );
          }),
      );
    for (const table of [
      'scoped_releases',
      'scoped_release_scopes',
      'scoped_category_lineage',
      'compat_projection_manifests',
      'compat_projection_lineage',
    ])
      await t.test(
        `${table} has an actual immutable database guard, including after an earlier successful flush`,
        () =>
          afterFlush(async (tx, release) => {
            const key =
              table === 'scoped_releases'
                ? 'id'
                : table === 'compat_projection_lineage'
                  ? 'manifest_id'
                  : 'release_id';
            const id =
              table === 'compat_projection_lineage'
                ? (
                    await tx.query(
                      'SELECT id FROM whaleu_ratings.compat_projection_manifests WHERE release_id=$1 LIMIT 1',
                      [release.releaseId],
                    )
                  ).rows[0]!.id
                : release.releaseId;
            if (table === 'scoped_category_lineage')
              await tx.query(
                'UPDATE whaleu_ratings.scoped_category_lineage SET proof=proof WHERE catalog_id=$1',
                [release.outputs.find((out) => out.scopeKey === 'global')!.id],
              );
            else
              await tx.query(
                `UPDATE whaleu_ratings.${table} SET ${key}=${key} WHERE ${key}=$1`,
                [id],
              );
          }),
      );
    const rejectedSourceAtSQLFlush = async (
      run: (tx: PoolClient) => Promise<void>,
      message: string,
    ) => {
      const before = await snapshot();
      await assert.rejects(
        withCommunityScopeWriter(f.pool, async (tx) => {
          assert.equal(
            (
              await tx.query(
                'SELECT count(*)::integer count FROM whaleu_ratings.scope_protocol_heads',
              )
            ).rows[0]!.count,
            0,
            'This source-only attack must not be masked by adopted publication checks',
          );
          await run(tx);
          await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
          assert.fail(
            'PostgreSQL accepted a source dependency outside its reviewed scope',
          );
        }),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          error.code === '23514' &&
          error.message.includes(message),
      );
      assert.deepEqual(await snapshot(), before);
    };
    await t.test(
      'raw SQL cannot place a genuine global-only base into an unrelated campus source vector',
      () =>
        rejectedSourceAtSQLFlush(async (tx) => {
          const placement = randomUUID();
          const scopeKeys = [`campus:${f.campusB}`];
          const source = await writeRatingScopedSource(tx, {
            kind: 'scoped_category_scope',
            key: `synthetic-cross-scope:${placement}`,
            scopeKeys,
            payload: {
              categoryId: seeded.global.categoryId,
              baseSourceId: seeded.global.source.id,
              baseSourceRevision: seeded.global.source.revision,
              placementRevision: placement,
              placement: { kind: 'campuses', campusIds: [f.campusB] },
              scopeKeys,
            },
          });
          await tx.query(
            `INSERT INTO whaleu_ratings.category_scope_placements(placement_revision,category_id,base_source_id,base_source_revision,scope_keys,source_id,source_revision)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              placement,
              seeded.global.categoryId,
              seeded.global.source.id,
              seeded.global.source.revision,
              scopeKeys,
              source.id,
              source.revision,
            ],
          );
        }, 'Category placement exceeds its exact base source scope'),
    );
    await t.test(
      'raw SQL cannot widen opaque adoption beyond the exact campus covered by its genuine Review source',
      async () => {
        const categoryId = randomUUID();
        const original = await f.catalog(f.creator, {
          regionId: f.regionId,
          categoryIds: [categoryId],
        });
        const adoption = await prepareSyntheticOpaqueAdoption(
          f,
          original.catalogId,
          categoryId,
          [`campus:${f.campusA}`],
        );
        await rejectedSourceAtSQLFlush(async (tx) => {
          await writeSyntheticOpaqueAdoption(tx, {
            ...adoption,
            scopeKeys: [`campus:${f.campusB}`],
            placement: { kind: 'campuses', campusIds: [f.campusB] },
          });
        }, 'Adoption scope exceeds its exact reviewed source scope');
      },
    );
  },
);
