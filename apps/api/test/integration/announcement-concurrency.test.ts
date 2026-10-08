import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import {
  syntheticAnnouncement,
  seedAnnouncementCatalog,
  seedAnnouncementHistoryCoverage,
  announcementMarkerCount,
} from '../support/announcement-fixtures.js';

function denied(response: Response, code?: string) {
  assert.ok(response.status >= 400, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body), ['error']);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['vary'], 'Authorization');
  if (code) assert.equal(response.body.error.code, code);
}

test(
  'announcement immutable authority, real writer waits, final expiry and acknowledgement transaction failures',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture(),
      observer = observeDirectoryQueries(f.app);
    const actor = await createRuntimeActor(f.app);
    const read = (id: string, campusId?: string) =>
      request(f.app.getHttpServer())
        .get(`/v1/announcements/${id}`)
        .query(campusId ? { campusId } : {});
    const ack = (
      row: { id: string; revision: string },
      campusId: string | null = null,
    ) =>
      request(f.app.getHttpServer())
        .put(`/v1/me/announcements/${row.id}/popup-acknowledgement`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({ campusId, expectedRevision: row.revision });
    try {
      await t.test(
        'sealed content, audience, ordering and accepted approval cannot mutate in place',
        async () => {
          const row = syntheticAnnouncement({
            campusIds: [f.scope.home.campusId],
          });
          const catalog = await seedAnnouncementCatalog(f.pool, [row]);
          for (const [sql, values] of [
            [
              'UPDATE whaleu_announcements.content_revisions SET body_text=$2 WHERE id=$1',
              [row.revision, 'Replacement'],
            ],
            [
              'DELETE FROM whaleu_announcements.content_revisions WHERE id=$1',
              [row.revision],
            ],
            [
              'UPDATE whaleu_announcements.campus_audiences SET campus_id=$2 WHERE content_revision_id=$1',
              [row.revision, f.scope.related.campusId],
            ],
            [
              "INSERT INTO whaleu_announcements.campus_audiences(content_revision_id,campus_id,provenance,source_reference,policy_reference) VALUES($1,$2,'accepted','synthetic','synthetic')",
              [row.revision, f.scope.related.campusId],
            ],
            [
              'UPDATE whaleu_announcements.catalog_entries SET source_ordinal=99 WHERE catalog_revision_id=$1',
              [catalog],
            ],
            [
              "UPDATE whaleu_announcements.catalog_entries SET publication_state='pending' WHERE catalog_revision_id=$1",
              [catalog],
            ],
            [
              'UPDATE whaleu_announcements.catalog_revisions SET sealed=false WHERE id=$1',
              [catalog],
            ],
            [
              "UPDATE whaleu_announcements.identities SET origin_kind='preserved' WHERE id=$1",
              [row.id],
            ],
          ] as const)
            await assert.rejects(
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(sql, [...values]),
              ),
            );
          const current = await read(row.id, f.scope.home.campusId);
          assert.equal(current.status, 200);
          assert.equal(current.body.bodyText, row.bodyText);
          const unsealed = await seedAnnouncementCatalog(f.pool, [row], {
            seal: false,
          });
          denied(
            await read(row.id, f.scope.home.campusId),
            'ANNOUNCEMENTS_UNAVAILABLE',
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_announcements.catalog_entries SET approved_content_revision=NULL WHERE catalog_revision_id=$1',
              [unsealed],
            ),
          );
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'UPDATE whaleu_announcements.catalog_revisions SET sealed=true WHERE id=$1',
                [unsealed],
              ),
            ),
          );
          await seedAnnouncementCatalog(f.pool, [row], {
            seal: false,
            coverage: 'missing',
          });
          denied(
            await read(row.id, f.scope.home.campusId),
            'ANNOUNCEMENTS_UNAVAILABLE',
          );
        },
      );
      await t.test(
        'withdrawal, retarget and edit committed during policy wait deny stale bodies and commands',
        async () => {
          for (const mode of ['withdrawal', 'retarget', 'edit'] as const) {
            const row = syntheticAnnouncement();
            await seedAnnouncementCatalog(f.pool, [row]);
            const changed =
              mode === 'withdrawal'
                ? { ...row, state: 'withdrawn' as const }
                : mode === 'retarget'
                  ? {
                      ...row,
                      revision: randomUUID(),
                      campusIds: [f.scope.related.campusId],
                    }
                  : {
                      ...row,
                      revision: randomUUID(),
                      bodyText: 'Edited current body',
                    };
            const next = await seedAnnouncementCatalog(f.pool, [changed], {
              head: false,
            });
            const tx = await f.pool.connect();
            try {
              await tx.query('BEGIN');
              await lockSafetyPolicy(tx, true);
              await tx.query(
                'UPDATE whaleu_announcements.catalog_head SET revision_id=$1',
                [next],
              );
              const pendingRead = read(row.id).then((r) => r),
                pendingAck = ack(row).then((r) => r);
              await f.waitForLock('pg_advisory_xact_lock_shared');
              await tx.query('COMMIT');
              const result = await pendingRead;
              if (mode === 'edit') {
                assert.equal(result.status, 200);
                assert.equal(result.body.bodyText, changed.bodyText);
              } else denied(result, 'ANNOUNCEMENT_NOT_FOUND');
              denied(
                await pendingAck,
                mode === 'edit' ? 'ANNOUNCEMENT_REVISION_CHANGED' : undefined,
              );
              assert.equal(
                await announcementMarkerCount(f.pool, actor.accountId, row.id),
                0,
              );
            } finally {
              await tx.query('ROLLBACK');
              tx.release();
            }
          }
        },
      );
      await t.test(
        'physical campus deactivation during policy wait never falls back to global',
        async () => {
          const row = syntheticAnnouncement({
            campusIds: [f.scope.home.campusId],
          });
          await seedAnnouncementCatalog(f.pool, [row]);
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await lockSafetyPolicy(tx, true);
            await tx.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [f.scope.home.campusId],
            );
            const pending = read(row.id, f.scope.home.campusId).then((r) => r),
              command = ack(row, f.scope.home.campusId).then((r) => r);
            await f.waitForLock('pg_advisory_xact_lock_shared');
            await tx.query('COMMIT');
            denied(await pending, 'CAMPUS_UNAVAILABLE');
            denied(await command, 'CAMPUS_UNAVAILABLE');
            assert.equal(
              await announcementMarkerCount(f.pool, actor.accountId, row.id),
              0,
            );
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );
      await t.test(
        'catalog expiry after page assembly and real cursor insertion discards page and rolls back cursor',
        async () => {
          const rows = Array.from({ length: 3 }, (_, i) =>
            syntheticAnnouncement({ ordinal: String(i + 1) }),
          );
          await seedAnnouncementCatalog(f.pool, rows, {
            validUntil: new Date(Date.now() + 1200),
          });
          const before = (
            await f.pool.query(
              'SELECT 1 FROM whaleu_community.discovery_cursors',
            )
          ).rowCount;
          let delayed = false;
          observer.setHook(async ({ sql }) => {
            if (
              !delayed &&
              sql.includes('INSERT INTO whaleu_community.discovery_cursors')
            ) {
              delayed = true;
              await sleep(1400);
            }
          });
          try {
            denied(
              await request(f.app.getHttpServer())
                .get('/v1/announcements')
                .query({ limit: 1 }),
              'ANNOUNCEMENTS_UNAVAILABLE',
            );
            assert.equal(delayed, true);
          } finally {
            observer.setHook(null);
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_community.discovery_cursors',
              )
            ).rowCount,
            before,
          );
        },
      );
      await t.test(
        'catalog expiry after real acknowledgement insert rolls back receipt and returns no success',
        async () => {
          const row = syntheticAnnouncement();
          await seedAnnouncementCatalog(f.pool, [row], {
            validUntil: new Date(Date.now() + 1200),
          });
          let delayed = false;
          observer.setHook(async ({ sql }) => {
            if (
              !delayed &&
              sql.includes(
                'INSERT INTO whaleu_announcements.popup_acknowledgements',
              )
            ) {
              delayed = true;
              await sleep(1400);
            }
          });
          try {
            denied(await ack(row), 'ANNOUNCEMENTS_UNAVAILABLE');
            assert.equal(delayed, true);
          } finally {
            observer.setHook(null);
          }
          assert.equal(
            await announcementMarkerCount(f.pool, actor.accountId, row.id),
            0,
          );
        },
      );
      await t.test(
        'owner historical coverage expiring after real status reads cannot expose a false unseen popup',
        async () => {
          const row = syntheticAnnouncement({ origin: 'preserved' });
          await seedAnnouncementCatalog(f.pool, [row]);
          await seedAnnouncementHistoryCoverage(
            f.pool,
            actor.accountId,
            row.id,
            new Date(Date.now() + 1200),
          );
          let coverageRead = false,
            delayed = false;
          observer.setHook(async ({ sql }) => {
            if (
              sql.includes('FROM whaleu_announcements.owner_history_coverage')
            )
              coverageRead = true;
            if (
              coverageRead &&
              !delayed &&
              sql === 'SELECT clock_timestamp() AS now'
            ) {
              delayed = true;
              await sleep(1400);
            }
          });
          try {
            denied(
              await request(f.app.getHttpServer())
                .get('/v1/me/announcements/popup')
                .set('Authorization', `Bearer ${actor.accessToken}`),
              'ANNOUNCEMENTS_UNAVAILABLE',
            );
            assert.equal(delayed, true);
          } finally {
            observer.setHook(null);
          }
          assert.equal(
            await announcementMarkerCount(f.pool, actor.accountId, row.id),
            0,
          );
        },
      );
      await t.test(
        'unknown override on the newest popup never falls back to an older popup or writes an acknowledgement',
        async () => {
          const older = syntheticAnnouncement({ ordinal: '1' });
          const newer = syntheticAnnouncement({
            ordinal: '2',
            unknownPopupTitle: true,
          });
          await seedAnnouncementCatalog(f.pool, [older, newer]);
          denied(
            await request(f.app.getHttpServer()).get('/v1/announcements/popup'),
            'ANNOUNCEMENTS_UNAVAILABLE',
          );
          denied(
            await request(f.app.getHttpServer())
              .get('/v1/me/announcements/popup')
              .set('Authorization', `Bearer ${actor.accessToken}`),
            'ANNOUNCEMENTS_UNAVAILABLE',
          );
          denied(await ack(newer), 'ANNOUNCEMENTS_UNAVAILABLE');
          assert.equal(
            await announcementMarkerCount(f.pool, actor.accountId, newer.id),
            0,
          );
          assert.equal(
            (await read(newer.id)).status,
            200,
            'Independent main body is still accepted',
          );
        },
      );
      await t.test(
        'malformed JSON and forbidden GET bodies retain private cache/error policy',
        async () => {
          const bad = await request(f.app.getHttpServer())
            .get('/v1/announcements')
            .set('Content-Type', 'application/json')
            .send('{');
          denied(bad);
          assert.equal(bad.status, 400);
          const body = await request(f.app.getHttpServer())
            .get('/v1/announcements')
            .send({ accountId: actor.accountId });
          denied(body);
          assert.equal(body.status, 400);
        },
      );
      await t.test(
        'exact-count PostgreSQL statement budget exhaustion returns unavailable, never a fabricated zero',
        async () => {
          await seedAnnouncementCatalog(f.pool, [syntheticAnnouncement()]);
          let exhausted = false;
          observer.setHook(async ({ sql }, tx) => {
            if (!exhausted && sql.includes("set_config('statement_timeout'")) {
              exhausted = true;
              await tx.query('SELECT pg_sleep(0.7)');
            }
          });
          try {
            const result = await request(f.app.getHttpServer()).get(
              '/v1/announcements/changes',
            );
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(exhausted, true);
            assert.deepEqual(result.body.newness, {
              status: 'unavailable',
              hasNew: null,
              newCount: null,
            });
          } finally {
            observer.setHook(null);
          }
        },
      );
      await t.test(
        'insert failure and deferred COMMIT failure are atomic; successful marker is append-only',
        async () => {
          for (const deferred of [false, true]) {
            const row = syntheticAnnouncement();
            await seedAnnouncementCatalog(f.pool, [row]);
            await f.pool
              .query(`CREATE FUNCTION whaleu_announcements.synthetic_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic acknowledgement failure'; END $$;
          CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER synthetic_ack_failure ${deferred ? 'AFTER' : 'BEFORE'} INSERT ON whaleu_announcements.popup_acknowledgements ${deferred ? 'DEFERRABLE INITIALLY DEFERRED ' : ''}FOR EACH ROW EXECUTE FUNCTION whaleu_announcements.synthetic_ack_failure()`);
            try {
              const response = await ack(row);
              denied(response);
              assert.equal(response.status, 500);
            } finally {
              await f.pool.query(
                'DROP TRIGGER synthetic_ack_failure ON whaleu_announcements.popup_acknowledgements; DROP FUNCTION whaleu_announcements.synthetic_ack_failure()',
              );
            }
            assert.equal(
              await announcementMarkerCount(f.pool, actor.accountId, row.id),
              0,
            );
            assert.equal((await ack(row)).status, 200);
            await assert.rejects(
              f.pool.query(
                'UPDATE whaleu_announcements.popup_acknowledgements SET acknowledged_at=clock_timestamp() WHERE account_id=$1 AND announcement_id=$2',
                [actor.accountId, row.id],
              ),
            );
            await assert.rejects(
              f.pool.query(
                'DELETE FROM whaleu_announcements.popup_acknowledgements WHERE account_id=$1 AND announcement_id=$2',
                [actor.accountId, row.id],
              ),
            );
          }
        },
      );
    } finally {
      observer.restore();
      await f.close();
    }
  },
);
