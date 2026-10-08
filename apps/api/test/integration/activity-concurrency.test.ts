import { DatabaseService } from '../../src/database/database.js';
import { ActivitiesRepository } from '../../src/activities/repository.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import {
  syntheticActivity,
  seedActivityCatalog,
  seedActivityHistory,
  activityVisitCount,
} from '../support/activity-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
function denied(r: Response, code?: string) {
  assert.ok(r.status >= 400, JSON.stringify(r.body));
  assert.deepEqual(Object.keys(r.body), ['error']);
  assert.equal(r.headers['cache-control'], 'no-store');
  if (code) assert.equal(r.body.error.code, code);
}
test(
  'activities head/policy/owner/quota waits and post-deferred deadlines never emit stale bodies or commit failed visits',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(),
      observer = observeDirectoryQueries(f.app),
      http = f.app.getHttpServer(),
      region = f.scope.home.regionId;
    const read = (
      actor: { accessToken: string },
      q: Record<string, unknown> = { window: 'all', limit: 1 },
    ) =>
      request(http)
        .get(`/v1/regions/${region}/activities`)
        .query(q)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const visit = (
      actor: { accessToken: string },
      catalog: string,
      id = randomUUID(),
    ) =>
      request(http)
        .put(`/v1/me/activity-visits/${id}`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({ regionId: region, expectedCatalogRevision: catalog });
    const cursors = async () =>
      Number(
        (
          await f.pool.query<{ n: number }>(
            'SELECT count(*)::int n FROM whaleu_community.discovery_cursors',
          )
        ).rows[0]!.n,
      );
    try {
      await t.test(
        'catalog head replacement behind real writer gate is read fresh and stale visit precondition rejects',
        async () => {
          const actor = await f.actor(),
            row = syntheticActivity(),
            old = await seedActivityCatalog(f.pool, region, [row]),
            changed = {
              ...row,
              revision: randomUUID(),
              title: 'Current accepted replacement',
            },
            next = await seedActivityCatalog(f.pool, region, [changed], {
              head: false,
            }),
            tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await lockSafetyPolicy(tx, true);
            await tx.query(
              'UPDATE whaleu_activities.catalog_head SET revision_id=$1 WHERE region_id=$2',
              [next, region],
            );
            const pending = read(actor).then((r) => r),
              command = visit(actor, old).then((r) => r);
            await f.waitForLock('pg_advisory_xact_lock_shared');
            await tx.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(result.body.items[0].title, changed.title);
            assert.equal(result.body.context.catalogRevision, next);
            denied(await command, 'ACTIVITY_REVISION_CHANGED');
            assert.equal(await activityVisitCount(f.pool, actor.accountId), 0);
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'head pointer lock completes before its referenced revision is fetched',
        async () => {
          const actor = await f.actor(),
            row = syntheticActivity(),
            old = await seedActivityCatalog(f.pool, region, [row]),
            next = await seedActivityCatalog(
              f.pool,
              region,
              [{ ...row, revision: randomUUID(), title: 'New pointer target' }],
              { head: false },
            ),
            tx = await f.pool.connect();
          let paused = false;
          let resume!: () => void;
          let entered!: () => void;
          const ready = new Promise<void>((r) => (entered = r)),
            release = new Promise<void>((r) => (resume = r));
          // Pause after the ordinary shared gate; a row-only lock then exercises the
          // post-wait head fetch separately from the policy writer serialization above.
          observer.setHook(async ({ sql }) => {
            if (!paused && sql.includes('FROM whaleu_campus.campuses c')) {
              paused = true;
              entered();
              await release;
            }
          });
          try {
            const pending = read(actor).then((r) => r);
            await ready;
            await tx.query('BEGIN');
            await tx.query(
              'SELECT revision_id FROM whaleu_activities.catalog_head WHERE region_id=$1 FOR UPDATE',
              [region],
            );
            resume();
            await f.waitForLock('FROM whaleu_activities.catalog_head');
            await tx.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 200);
            assert.equal(result.body.context.catalogRevision, old);
            assert.notEqual(old, next);
          } finally {
            resume();
            observer.setHook(null);
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'catalog repository fresh statement observes actual head replacement after a legal writer wait',
        async () => {
          const old = await seedActivityCatalog(f.pool, region, []),
            next = await seedActivityCatalog(f.pool, region, [], {
              head: false,
            }),
            tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await lockSafetyPolicy(tx, true);
            await tx.query(
              'UPDATE whaleu_activities.catalog_head SET revision_id=$1 WHERE region_id=$2',
              [next, region],
            );
            const pending = f.app
              .get(DatabaseService)
              .transaction(
                (client) =>
                  f.app.get(ActivitiesRepository).catalog(region, client),
                { isolationLevel: 'read committed' },
              );
            await f.waitForLock('FROM whaleu_activities.catalog_head');
            await tx.query('COMMIT');
            const result = await pending;
            assert.equal(result.id, next);
            assert.notEqual(result.id, old);
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'catalog expiry during real account cursor quota wait rolls back replay and next coordinates',
        async () => {
          const actor = await f.actor(),
            rows = [syntheticActivity(), syntheticActivity({ ordinal: '2' })];
          await seedActivityCatalog(f.pool, region, rows, {
            validUntil: new Date(Date.now() + 900),
          });
          const before = await cursors(),
            tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [
                `whaleu:discovery:quota:v1:${discoveryCursorBucket(actor.accountId).hash}`,
              ],
            );
            const pending = read(actor).then((r) => r);
            await f.waitForLock(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            );
            await sleep(1100);
            await tx.query('COMMIT');
            denied(await pending, 'ACTIVITY_UNAVAILABLE');
            assert.equal(await cursors(), before);
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'source-history expiry after selection and cursor allocation aborts entry while explicit all is independent',
        async () => {
          const actor = await f.actor();
          await seedActivityCatalog(f.pool, region, [syntheticActivity()]);
          await seedActivityHistory(f.pool, actor.accountId, 'never_visited', {
            validUntil: new Date(Date.now() + 700),
          });
          let delayed = false;
          observer.setHook(async ({ sql }) => {
            if (
              !delayed &&
              sql.includes('INSERT INTO whaleu_community.discovery_cursors')
            ) {
              delayed = true;
              await sleep(900);
            }
          });
          try {
            denied(
              await read(actor, { window: 'entry', limit: 1 }),
              'ACTIVITY_ENTRY_SELECTION_UNAVAILABLE',
            );
            assert.ok(delayed);
          } finally {
            observer.setHook(null);
          }
          assert.equal((await read(actor)).status, 200);
        },
      );
      await t.test(
        'owner lock wait followed by member expiry never creates a fresh receipt',
        async () => {
          const actor = await f.actor({
              expiresAt: new Date(Date.now() + 800),
            }),
            catalog = await seedActivityCatalog(f.pool, region, []),
            tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:activity-visit:'||$1::text,0))",
              [actor.accountId],
            );
            const pending = visit(actor, catalog).then((r) => r);
            await f.waitForLock('whaleu:activity-visit:');
            await sleep(1000);
            await tx.query('COMMIT');
            denied(await pending);
            assert.equal(await activityVisitCount(f.pool, actor.accountId), 0);
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'catalog/phone/session expiry after real insert and deferred constraints discards receipt',
        async () => {
          for (const mode of ['catalog', 'phone', 'session'] as const) {
            const actor = await f.actor();
            const catalog = await seedActivityCatalog(
              f.pool,
              region,
              [],
              mode === 'catalog'
                ? { validUntil: new Date(Date.now() + 850) }
                : {},
            );
            if (mode === 'phone')
              await f.certify(actor.accountId, {
                expiresAt: new Date(Date.now() + 850),
              });
            if (mode === 'session')
              await f.pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '850 milliseconds' WHERE session_id=$1",
                [actor.sessionId],
              );
            await f.pool.query(
              `CREATE FUNCTION whaleu_activities.synthetic_slow_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER synthetic_slow_receipt AFTER INSERT ON whaleu_activities.owner_visit_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.synthetic_slow_receipt()`,
            );
            try {
              denied(await visit(actor, catalog));
              assert.equal(
                await activityVisitCount(f.pool, actor.accountId),
                0,
              );
            } finally {
              await f.pool.query(
                'DROP TRIGGER synthetic_slow_receipt ON whaleu_activities.owner_visit_receipts; DROP FUNCTION whaleu_activities.synthetic_slow_receipt()',
              );
            }
          }
        },
      );
      await t.test(
        'conflicting concurrent request intent records exactly one original owner receipt',
        async () => {
          const actor = await f.actor(),
            first = await seedActivityCatalog(f.pool, region, []),
            next = await seedActivityCatalog(f.pool, region, []),
            id = randomUUID();
          const results = await Promise.all([
            visit(actor, first, id),
            visit(actor, next, id),
          ]);
          assert.equal(results.filter((r) => r.status === 200).length, 1);
          denied(results.find((r) => r.status !== 200)!);
          assert.equal(await activityVisitCount(f.pool, actor.accountId), 1);
        },
      );
      await t.test(
        'direct source writers cannot mutate sealed facts or owner history and all canonical truncation is forbidden',
        async () => {
          const actor = await f.actor(),
            coverage = await seedActivityHistory(
              f.pool,
              actor.accountId,
              'never_visited',
            ),
            row = syntheticActivity(),
            catalog = await seedActivityCatalog(f.pool, region, [row]);
          for (const [sql, values] of [
            [
              "UPDATE whaleu_activities.owner_visit_coverage SET history_state='visited' WHERE id=$1",
              [coverage],
            ],
            [
              'DELETE FROM whaleu_activities.catalog_entries WHERE catalog_revision_id=$1',
              [catalog],
            ],
            [
              "UPDATE whaleu_activities.content_revisions SET organizer_label='Forged' WHERE id=$1",
              [row.revision],
            ],
          ] as const)
            await assert.rejects(f.pool.query(sql, [...values]));
          await assert.rejects(
            f.pool.query('TRUNCATE whaleu_activities.owner_visit_receipts'),
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'DELETE FROM whaleu_activities.catalog_head WHERE region_id=$1',
              [region],
            ),
          );
          denied(await read(actor), 'ACTIVITY_UNAVAILABLE');
        },
      );
    } finally {
      observer.restore();
      await f.close();
    }
  },
);
