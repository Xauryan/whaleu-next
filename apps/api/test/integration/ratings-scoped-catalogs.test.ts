import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { ratingScopedContextSchema } from '../../src/ratings/scoped/contracts.js';
import type { RatingScopedContext } from '../../src/ratings/scoped/contracts.js';
import { RATING_SCOPED_REQUIRED_CAPABILITIES } from '../../src/ratings/scoped/constants.js';

test(
  'M3B synthetic issuance, complete Campus compiler domains, typed compatibility and atomic activation',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    const actor = f.creator;
    const heads = async () =>
      (
        await f.pool.query(
          `SELECT scope_key,catalog_id,head_revision,release_id FROM whaleu_ratings.scoped_catalog_heads ORDER BY scope_key`,
        )
      ).rows;
    const publicationState = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
      'releases',(SELECT count(*) FROM whaleu_ratings.scoped_releases),
      'catalogs',(SELECT count(*) FROM whaleu_ratings.scoped_catalogs),
      'categories',(SELECT count(*) FROM whaleu_ratings.scoped_categories),
      'compat',(SELECT count(*) FROM whaleu_ratings.compat_versions),
      'projections',(SELECT count(*) FROM whaleu_ratings.compat_projection_manifests),
      'protocols',(SELECT count(*) FROM whaleu_ratings.scope_protocol_versions),
      'sourceEpoch',(SELECT epoch FROM whaleu_ratings.scoped_source_epoch WHERE singleton),
      'protocolEpoch',(SELECT epoch FROM whaleu_ratings.scope_protocol_epoch WHERE singleton),
      'navigationEpoch',(SELECT epoch FROM whaleu_ratings.navigation_epoch WHERE singleton),
      'randomEpoch',(SELECT epoch FROM whaleu_ratings.random_pool_epoch WHERE singleton)) state`)
      ).rows[0]!.state;
    const readWith = (context: RatingScopedContext) =>
      f
        .auth(request(f.http).get('/v2/ratings/categories'), actor)
        .query({ contextId: context.id, contextToken: context.token });
    const requestCampus = (campusId: string) =>
      f.requestScopedContext(actor, {
        purpose: 'read',
        mode: 'public',
        selector: { kind: 'campus', campusId },
      });
    const randomContext = async () => {
      const response = await f.requestScopedContext(actor, {
        purpose: 'random',
        mode: 'public',
        selector: {
          kind: 'institution_with_global',
          anchorCampusId: f.campusA,
        },
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return ratingScopedContextSchema.parse(response.body);
    };
    let data: Awaited<ReturnType<typeof f.seedScopedCatalogs>>;
    const randomWith = (context: RatingScopedContext) =>
      f.auth(request(f.http).get('/v2/ratings/random-target'), actor).query({
        contextId: context.id,
        contextToken: context.token,
        categoryId: data.local.categoryId,
      });
    const unavailable = (response: {
      status: number;
      body: { error?: { code?: string } };
    }) => {
      assert.notEqual(response.status, 200, JSON.stringify(response.body));
      assert(
        [
          'RATING_SCOPE_UNAVAILABLE',
          'RATING_UNAVAILABLE',
          'RATING_SCOPED_CONTEXT_CHANGED',
          'IDENTITY_CAMPUS_UNAVAILABLE',
        ].includes(response.body.error?.code ?? ''),
        JSON.stringify(response.body),
      );
    };
    await t.test(
      'missing owner absence is unknown and produces no partial or empty catalog',
      async () => {
        await f.capability();
        const before = await publicationState();
        await assert.rejects(() => f.publish());
        assert.deepEqual(await publicationState(), before);
        assert.deepEqual(await heads(), []);
        unavailable(await requestCampus(f.campusA));
      },
    );
    await t.test(
      'compiler materializes reviewed differences and proven-empty campuses while protocol stays dormant',
      async () => {
        data = await f.seedScopedCatalogs();
        const published = await f.publish();
        assert.equal(published.outputs.length, f.campusIds.length + 1);
        const a = published.outputs.find(
            (o) => o.scopeKey === `campus:${f.campusA}`,
          )!,
          b = published.outputs.find(
            (o) => o.scopeKey === `campus:${f.campusB}`,
          )!;
        const localA = a.categories.find(
            (c) => c.expected.body.id === data.local.categoryId,
          )!,
          localB = b.categories.find(
            (c) => c.expected.body.id === data.local.categoryId,
          )!;
        assert.equal(localA.expected.body.name, 'Shared local category');
        assert.equal(localB.expected.body.name, 'Campus B category');
        assert.equal(localA.expected.body.hidden, false);
        assert.equal(localB.expected.body.hidden, true);
        assert.equal(localA.expected.body.ordinal, '0');
        assert.equal(localB.expected.body.ordinal, '10');
        assert.notEqual(localA.revision, localB.revision);
        assert.notEqual(localA.digest, localB.digest);
        assert(
          published.outputs
            .filter((o) =>
              [
                `campus:${f.scope.related.campusId}`,
                `campus:${f.scope.foreign.campusId}`,
              ].includes(o.scopeKey),
            )
            .every(
              (o) => o.categories.length === 0 && o.memberships.length === 0,
            ),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scope_protocol_heads',
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (await f.pool.query('SELECT 1 FROM whaleu_ratings.compat_heads'))
            .rowCount,
          0,
        );
        unavailable(await requestCampus(f.campusA));
        const source = (
          await f.pool.query(
            `SELECT s.source_kind,b.operation,b.envelope_version FROM whaleu_ratings.scoped_category_lineage l
        JOIN whaleu_ratings.scoped_source_attestations s ON (s.id,s.revision)=(l.base_source_id,l.base_source_revision)
        JOIN whaleu_community.rating_scoped_category_source_bindings b ON (b.source_id,b.source_revision)=(s.id,s.revision)
        WHERE l.catalog_id=$1 AND l.category_id=$2`,
            [a.id, data.local.categoryId],
          )
        ).rows[0];
        assert.deepEqual(source, {
          source_kind: 'scoped_category_base',
          operation: 'publish_rating_category_base_scoped',
          envelope_version: 5,
        });
      },
    );
    await t.test(
      'missing capability and partial activation domain roll back every tentative projection and epoch',
      async () => {
        await f.capability({
          capabilities: [...RATING_SCOPED_REQUIRED_CAPABILITIES].slice(0, -1),
        });
        let before = await publicationState(),
          beforeHeads = await heads();
        await assert.rejects(() => f.publish({ activate: true }));
        assert.deepEqual(await publicationState(), before);
        assert.deepEqual(await heads(), beforeHeads);
        await f.capability();
        before = await publicationState();
        beforeHeads = await heads();
        await assert.rejects(() =>
          f.publish({ activate: true, logicalScopeKeys: ['global'] }),
        );
        assert.deepEqual(await publicationState(), before);
        assert.deepEqual(await heads(), beforeHeads);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.scope_protocol_heads',
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      'activation publishes full scope, typed compat and protocol heads in one real transaction',
      async () => {
        const generation = randomUUID(),
          release = await f.publish({ activate: true, generation });
        const protocols = (
          await f.pool
            .query(`SELECT h.logical_scope_key,v.phase,v.generation,v.release_id FROM whaleu_ratings.scope_protocol_heads h
        JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id ORDER BY h.logical_scope_key`)
        ).rows;
        assert.deepEqual(
          protocols.map((p) => p.logical_scope_key),
          f.logicalScopeKeys,
        );
        assert(
          protocols.every(
            (p) =>
              p.phase === 'adopted' &&
              p.generation === generation &&
              p.release_id === release.releaseId,
          ),
        );
        const compatibility = (
          await f.pool
            .query(`SELECT v.compat_key,v.state,v.campus_ids FROM whaleu_ratings.compat_heads h
        JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id ORDER BY v.compat_key`)
        ).rows;
        assert.equal(
          compatibility.find((v) => v.compat_key === 'global_compat')!.state,
          'equal',
        );
        const region = compatibility.find(
          (v) => v.compat_key === `region_compat:${f.regionId}`,
        )!;
        assert.equal(region.state, 'divergent');
        assert.deepEqual(region.campus_ids, [f.campusA, f.campusB].sort());
        const a = await f.scopedCategories(actor, {
            kind: 'campus',
            campusId: f.campusA,
          }),
          b = await f.scopedCategories(actor, {
            kind: 'campus',
            campusId: f.campusB,
          }),
          global = await f.scopedCategories(actor, { kind: 'global' });
        assert.deepEqual(
          a.page.items.map((x) => x.id),
          [data.local.categoryId, data.second.categoryId],
        );
        assert.deepEqual(
          b.page.items.map((x) => x.id),
          [data.second.categoryId],
        );
        assert.deepEqual(
          global.page.items.map((x) => x.id),
          [data.global.categoryId],
        );
        assert.equal(global.page.items[0]!.name, 'Independent global category');
        assert.equal(a.context.identityCampusId, f.campusA);
        assert.equal(b.context.identityCampusId, f.campusA);
        assert.deepEqual(b.context.selector, {
          kind: 'campus',
          campusId: f.campusB,
        });
        for (const response of [a.response, b.response, global.response]) {
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.match(response.headers['vary'] ?? '', /Authorization/i);
        }
        const empty = await f.scopedCategories(actor, {
          kind: 'campus',
          campusId: f.scope.related.campusId,
        });
        assert.deepEqual(empty.page.items, []);
        const oldGlobal = await f.auth(
          request(f.http).get('/v1/ratings/categories'),
          actor,
        );
        assert.equal(oldGlobal.status, 200, JSON.stringify(oldGlobal.body));
        assert.equal(
          oldGlobal.body.items[0].name,
          'Independent global category',
        );
        unavailable(
          await f
            .auth(request(f.http).get('/v1/ratings/categories'), actor)
            .query({ regionId: f.regionId }),
        );
      },
    );
    await t.test(
      'whole institution random carries every campus plus independent global and has authoritative generation',
      async () => {
        const context = await randomContext();
        assert.deepEqual(
          context.heads.map((h) => h.scopeKey),
          f.scopeKeys,
        );
        assert.notEqual(
          context.protocolGeneration,
          context.id,
          'A context UUID is not a protocol generation',
        );
        const generation = (
          await f.pool.query(
            `SELECT v.generation FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE h.logical_scope_key=$1`,
            [f.regionId],
          )
        ).rows[0]!.generation;
        assert.equal(context.protocolGeneration, generation);
        const response = await randomWith(context);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.candidateCount, 0);
        assert.equal(response.body.item, null);
        const missing = await f
          .auth(request(f.http).get('/v2/ratings/random-target'), actor)
          .query({
            contextId: context.id,
            contextToken: context.token,
            categoryId: randomUUID(),
          });
        assert.equal(missing.body.error.code, 'RATING_NOT_FOUND');
      },
    );
    await t.test(
      'two ordinary context issuances leave one another valid and guessed context identity grants nothing',
      async () => {
        const first = await f.scopedContext(actor, {
          kind: 'campus',
          campusId: f.campusA,
        });
        const second = await f.scopedContext(actor, {
          kind: 'campus',
          campusId: f.campusA,
        });
        assert.notEqual(first.id, second.id);
        assert.equal(first.scopeRevision, second.scopeRevision);
        assert.equal((await readWith(first)).status, 200);
        assert.equal((await readWith(second)).status, 200);
        const forged = await f
          .auth(request(f.http).get('/v2/ratings/categories'), actor)
          .query({ contextId: randomUUID(), contextToken: first.token });
        unavailable(forged);
        const crossed = await f
          .auth(request(f.http).get('/v2/ratings/categories'), actor)
          .query({ contextId: first.id, contextToken: second.token });
        unavailable(crossed);
        const another = await f.actor();
        const outsider = await f
          .auth(request(f.http).get('/v2/ratings/categories'), another)
          .query({ contextId: first.id, contextToken: first.token });
        unavailable(outsider);
      },
    );
    await t.test(
      'unselected-campus or global source changes invalidate the full random domain, not just the anchor',
      async () => {
        for (const changedScope of [
          `campus:${f.scope.related.campusId}`,
          'global',
        ]) {
          const anchor = await f.scopedContext(actor, {
              kind: 'campus',
              campusId: f.campusA,
            }),
            context = await randomContext();
          await f.atomicChange((tx) => f.declareScope(changedScope, {}, tx), {
            domain:
              changedScope === 'global'
                ? { kind: 'global_compat' }
                : { kind: 'region_compat', regionId: f.scope.related.regionId },
          });
          assert.equal(
            (await readWith(anchor)).status,
            200,
            'The selected campus source was not changed',
          );
          unavailable(await randomWith(context));
        }
      },
    );
    await t.test(
      'an unselected logical protocol generation invalidates random despite the unchanged anchor generation',
      async () => {
        const anchor = await f.scopedContext(actor, {
            kind: 'campus',
            campusId: f.campusA,
          }),
          context = await randomContext();
        const newGeneration = randomUUID();
        await f.publish({
          activate: true,
          generation: newGeneration,
          domain: { kind: 'region_compat', regionId: f.scope.related.regionId },
        });
        const freshAnchor = (
          await f.pool.query(
            `SELECT v.generation FROM whaleu_ratings.scope_protocol_heads h JOIN whaleu_ratings.scope_protocol_versions v ON v.id=h.version_id WHERE h.logical_scope_key=$1`,
            [f.regionId],
          )
        ).rows[0]!.generation;
        assert.equal(freshAnchor, context.protocolGeneration);
        assert.notEqual(freshAnchor, newGeneration);
        assert.equal((await readWith(anchor)).status, 200);
        unavailable(await randomWith(context));
      },
    );
    await t.test(
      'physical inventory changes on an unselected campus invalidate the captured topology proof',
      async () => {
        const context = await randomContext();
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_campus.campuses SET full_name=$2 WHERE id=$1',
            [f.scope.related.campusId, 'Synthetic renamed scoped campus'],
          ),
        );
        unavailable(await randomWith(context));
      },
    );
    await t.test(
      'unknown adopted source cannot replace the previously proven empty campus',
      async () => {
        const empty = await f.scopedContext(actor, {
          kind: 'campus',
          campusId: f.scope.related.campusId,
        });
        const before = await publicationState(),
          beforeHeads = await heads();
        await assert.rejects(() =>
          f.atomicChange((tx) =>
            f.declareScope(
              `campus:${f.scope.related.campusId}`,
              { complete: false },
              tx,
            ),
          ),
        );
        assert.deepEqual(await publicationState(), before);
        assert.deepEqual(await heads(), beforeHeads);
        assert.equal(
          (await readWith(empty)).status,
          200,
          'Failed unknown publication retains the old complete scope',
        );
      },
    );
    await t.test(
      'divergence converges only through a new independent canonical compat projection',
      async () => {
        const globalBefore = (
          await f.pool.query(
            "SELECT catalog_id FROM whaleu_ratings.catalog_heads WHERE scope_key='global'",
          )
        ).rows[0]!.catalog_id;
        const release = await f.atomicChange(async (tx) => {
          await f.override(
            data.local,
            f.campusA,
            'New converged category',
            '',
            tx,
          );
          await f.override(
            data.local,
            f.campusB,
            'New converged category',
            '',
            tx,
          );
          await f.lifecycle(data.local, f.campusB, false, true, tx);
          await f.order(data.local, f.campusB, '0', tx);
        });
        const equal = (
          await f.pool.query(
            `SELECT v.*,m.id manifest_id,m.after_catalog_id FROM whaleu_ratings.compat_heads h
        JOIN whaleu_ratings.compat_versions v ON v.id=h.version_id LEFT JOIN whaleu_ratings.compat_projection_manifests m ON m.compat_version_id=v.id
        WHERE h.compat_key=$1`,
            [`region_compat:${f.regionId}`],
          )
        ).rows[0]!;
        assert.equal(equal.state, 'equal');
        assert.equal(equal.release_id, release.releaseId);
        assert.ok(equal.manifest_id);
        const old = (
          await f.pool.query(
            `SELECT c.name,c.revision,m.source_kind materialization_kind,l.source_kind lineage_kind,l.base_revision
        FROM whaleu_ratings.categories c JOIN whaleu_ratings.catalog_materializations m ON m.catalog_id=c.catalog_id
        JOIN whaleu_ratings.catalog_category_lineage l ON (l.catalog_id,l.category_id)=(c.catalog_id,c.id)
        WHERE c.catalog_id=$1 AND c.id=$2`,
            [equal.after_catalog_id, data.local.categoryId],
          )
        ).rows[0]!;
        assert.equal(old.name, 'New converged category');
        assert.equal(old.materialization_kind, 'compat_projection');
        assert.equal(old.lineage_kind, 'compat_effective');
        assert.equal(old.base_revision, null);
        const revisions = release.outputs
          .filter((o) =>
            [`campus:${f.campusA}`, `campus:${f.campusB}`].includes(o.scopeKey),
          )
          .map(
            (o) =>
              o.categories.find(
                (c) => c.expected.body.id === data.local.categoryId,
              )!.revision,
          );
        assert(revisions.every((revision) => revision !== old.revision));
        assert.equal(
          (
            await f.pool.query(
              "SELECT catalog_id FROM whaleu_ratings.catalog_heads WHERE scope_key='global'",
            )
          ).rows[0]!.catalog_id,
          globalBefore,
        );
        const legacy = await f
          .auth(request(f.http).get('/v1/ratings/categories'), actor)
          .query({ regionId: f.regionId });
        assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
        assert.equal(legacy.body.items[0].name, 'New converged category');
        const a = await f.scopedCategories(actor, {
            kind: 'campus',
            campusId: f.campusA,
          }),
          b = await f.scopedCategories(actor, {
            kind: 'campus',
            campusId: f.campusB,
          });
        assert.deepEqual(
          a.page.items.map((x) => x.name),
          b.page.items.map((x) => x.name),
        );
        const before = await publicationState();
        await assert.rejects(() =>
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_ratings.compat_versions SET state=$2 WHERE id=$1',
              [equal.id, 'divergent'],
            ),
          ),
        );
        assert.deepEqual(await publicationState(), before);
      },
    );
  },
);
