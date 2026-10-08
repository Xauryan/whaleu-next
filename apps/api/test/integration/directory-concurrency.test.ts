import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import {
  seedDirectoryTaxonomy,
  seedDirectoryCatalog,
  syntheticDirectoryCategory,
  syntheticDirectoryEntry,
} from '../support/directory-catalog-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

test(
  'directory current catalog/category authority and final cursor deadlines survive actual PostgreSQL lock waits',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(),
      observer = observeDirectoryQueries(f.app);
    const actor = await f.actor(),
      remoteActor = await f.actor({ campusId: f.scope.related.campusId });
    const region = f.scope.home.regionId,
      remote = f.scope.related.regionId;
    const category = syntheticDirectoryCategory();
    const taxonomy = await seedDirectoryTaxonomy(f.pool, region, 'org', [
      category,
    ]);
    const row = syntheticDirectoryEntry(category.id);
    await seedDirectoryCatalog(f.pool, region, 'org', taxonomy, [row]);
    const get = (
      suffix: string,
      query: object = {},
      regionId = region,
      who = actor,
    ) =>
      request(f.app.getHttpServer())
        .get(`/v1/directory/regions/${regionId}/${suffix}`)
        .query(query)
        .set('Authorization', `Bearer ${who.accessToken}`);
    const safeError = (
      response: { status: number; body: { error?: { code: string } } },
      code: string,
    ) => {
      assert.ok(response.status >= 400);
      assert.deepEqual(Object.keys(response.body), ['error']);
      assert.equal(response.body.error?.code, code);
    };
    try {
      await t.test(
        'approved-to-pending head transition committed during the shared-gate wait discloses no old entry or QQ',
        async () => {
          const next = await seedDirectoryCatalog(
            f.pool,
            region,
            'org',
            taxonomy,
            [{ ...row, state: 'pending' }],
            { head: false },
          );
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await lockSafetyPolicy(tx, true);
            await tx.query(
              "UPDATE whaleu_organizations.directory_catalog_heads SET revision_id=$1 WHERE region_id=$2 AND kind='org'",
              [next, region],
            );
            const pending = get(`entries/${row.id}`).then(
              (response) => response,
            );
            await f.waitForLock('pg_advisory_xact_lock_shared');
            await tx.query('COMMIT');
            safeError(await pending, 'DIRECTORY_NOT_FOUND');
            const page = await get('entries', {
              kind: 'org',
              categoryId: category.id,
            });
            assert.equal(page.status, 200);
            assert.deepEqual(page.body, {
              items: [],
              continuation: 'end',
              nextCursor: null,
            });
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'category deactivation committed during lock wait invalidates pending detail and category listing',
        async () => {
          await seedDirectoryCatalog(f.pool, region, 'org', taxonomy, [row]);
          const nextTaxonomy = await seedDirectoryTaxonomy(
            f.pool,
            region,
            'org',
            [{ ...category, lifecycle: 'inactive' }],
            { head: false },
          );
          const nextCatalog = await seedDirectoryCatalog(
            f.pool,
            region,
            'org',
            nextTaxonomy,
            [row],
            { head: false },
          );
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await lockSafetyPolicy(tx, true);
            await tx.query(
              "UPDATE whaleu_organizations.directory_taxonomy_heads SET revision_id=$1 WHERE region_id=$2 AND kind='org'",
              [nextTaxonomy, region],
            );
            await tx.query(
              "UPDATE whaleu_organizations.directory_catalog_heads SET revision_id=$1 WHERE region_id=$2 AND kind='org'",
              [nextCatalog, region],
            );
            const pending = get(`entries/${row.id}`).then(
              (response) => response,
            );
            await f.waitForLock('pg_advisory_xact_lock_shared');
            await tx.query('COMMIT');
            safeError(await pending, 'DIRECTORY_NOT_FOUND');
            const page = await get('categories', { kind: 'org' });
            assert.equal(page.status, 200);
            assert.deepEqual(page.body.items, []);
            safeError(
              await get('entries', { kind: 'org', categoryId: category.id }),
              'DIRECTORY_NOT_FOUND',
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'global taxonomy-head advance invalidates both regional pinned populations until individually reconciled',
        async () => {
          const category = syntheticDirectoryCategory({
            name: '全局共享官方分类',
          });
          const oldTaxonomy = await seedDirectoryTaxonomy(
            f.pool,
            region,
            'official',
            [category],
          );
          const entry = syntheticDirectoryEntry(category.id),
            remoteEntry = syntheticDirectoryEntry(category.id);
          await seedDirectoryCatalog(f.pool, region, 'official', oldTaxonomy, [
            entry,
          ]);
          await seedDirectoryCatalog(f.pool, remote, 'official', oldTaxonomy, [
            remoteEntry,
          ]);
          assert.equal(
            (await get('categories', { kind: 'official' })).status,
            200,
          );
          assert.equal(
            (await get('categories', { kind: 'official' }, remote, remoteActor))
              .status,
            200,
          );
          const newTaxonomy = await seedDirectoryTaxonomy(
            f.pool,
            region,
            'official',
            [{ ...category, name: '新接受的官方分类' }],
          );
          safeError(
            await get('categories', { kind: 'official' }),
            'DIRECTORY_UNAVAILABLE',
          );
          safeError(
            await get('categories', { kind: 'official' }, remote, remoteActor),
            'DIRECTORY_UNAVAILABLE',
          );
          await seedDirectoryCatalog(f.pool, region, 'official', newTaxonomy, [
            entry,
          ]);
          assert.equal(
            (await get('categories', { kind: 'official' })).body.items[0].name,
            '新接受的官方分类',
          );
          safeError(
            await get('categories', { kind: 'official' }, remote, remoteActor),
            'DIRECTORY_UNAVAILABLE',
          );
          safeError(
            await get(`entries/${remoteEntry.id}`, {}, remote, remoteActor),
            'DIRECTORY_NOT_FOUND',
          );
        },
      );
      await t.test(
        'catalog deadline expiring while issuing cursor rolls back cursor and discards complete private page',
        async () => {
          const category = syntheticDirectoryCategory();
          const tax = await seedDirectoryTaxonomy(f.pool, region, 'school', [
            category,
          ]);
          const entries = Array.from({ length: 22 }, (_, i) =>
            syntheticDirectoryEntry(category.id, {
              ordinal: i,
              searchOrdinal: i,
            }),
          );
          await seedDirectoryCatalog(f.pool, region, 'school', tax, entries, {
            validUntil: new Date(Date.now() + 650),
          });
          const before = (
            await f.pool.query(
              'SELECT * FROM whaleu_community.discovery_cursors',
            )
          ).rowCount;
          let delayed = false;
          observer.setHook(async ({ sql }) => {
            if (
              !delayed &&
              sql.includes('INSERT INTO whaleu_community.discovery_cursors')
            ) {
              delayed = true;
              await sleep(800);
            }
          });
          try {
            safeError(
              await get('entries', { kind: 'school', categoryId: category.id }),
              'DIRECTORY_UNAVAILABLE',
            );
            assert.ok(delayed);
          } finally {
            observer.setHook(null);
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT * FROM whaleu_community.discovery_cursors',
              )
            ).rowCount,
            before,
          );
        },
      );
    } finally {
      observer.restore();
      await f.close();
    }
  },
);
