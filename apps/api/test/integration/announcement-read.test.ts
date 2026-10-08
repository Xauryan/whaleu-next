import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  syntheticAnnouncement,
  seedAnnouncementCatalog,
  seedAnnouncementHistoryCoverage,
  seedHistoricalAnnouncementAcknowledgement,
  announcementMarkerCount,
} from '../support/announcement-fixtures.js';

function safe(response: Response, code?: string) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['vary'], 'Authorization');
  if (code) {
    assert.ok(response.status >= 400, JSON.stringify(response.body));
    assert.deepEqual(Object.keys(response.body), ['error']);
    assert.equal(response.body.error.code, code);
  } else assert.equal(response.status, 200, JSON.stringify(response.body));
}

test(
  'announcements use current canonical public scope and separate owner popup markers through normal AppModule',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    const get = (
      suffix = '',
      query: object = {},
      actor?: { accessToken: string },
    ) => {
      const call = request(f.app.getHttpServer())
        .get(`/v1/announcements${suffix}`)
        .query(query);
      return actor
        ? call.set('Authorization', `Bearer ${actor.accessToken}`)
        : call;
    };
    const owner = (actor?: { accessToken: string }, campusId?: string) => {
      const call = request(f.app.getHttpServer())
        .get('/v1/me/announcements/popup')
        .query(campusId ? { campusId } : {});
      return actor
        ? call.set('Authorization', `Bearer ${actor.accessToken}`)
        : call;
    };
    const ack = (
      actor: { accessToken: string } | undefined,
      id: string,
      revision: string,
      campusId: string | null = null,
      extra: object = {},
    ) => {
      const call = request(f.app.getHttpServer())
        .put(`/v1/me/announcements/${id}/popup-acknowledgement`)
        .send({ campusId, expectedRevision: revision, ...extra });
      return actor
        ? call.set('Authorization', `Bearer ${actor.accessToken}`)
        : call;
    };
    try {
      await t.test(
        'missing accepted catalog is unavailable while sealed empty is proven empty',
        async () => {
          safe(await get(), 'ANNOUNCEMENTS_UNAVAILABLE');
          safe(await get('/popup'), 'ANNOUNCEMENTS_UNAVAILABLE');
          await seedAnnouncementCatalog(f.pool, []);
          safe(await get());
          assert.deepEqual((await get()).body, {
            context: { campusId: null },
            items: [],
            continuation: 'end',
            nextCursor: null,
          });
          assert.deepEqual((await get('/popup')).body, {
            context: { campusId: null },
            popup: null,
          });
          assert.deepEqual((await get('/changes')).body.newness, {
            status: 'available',
            hasNew: false,
            newCount: '0',
          });
        },
      );
      const global = syntheticAnnouncement({
        ordinal: '10',
        versionLabel: '同一版本',
        bodyText: '第一段\n\n  保留缩进\nUnicode 鲸鱼',
        announcementDate: null,
      });
      const home = syntheticAnnouncement({
        ordinal: '30',
        campusIds: [f.scope.home.campusId],
        versionLabel: global.versionLabel,
      });
      const related = syntheticAnnouncement({
        ordinal: '40',
        campusIds: [f.scope.related.campusId],
      });
      const hidden = syntheticAnnouncement({
        ordinal: '100',
        state: 'withdrawn',
      });
      const pending = syntheticAnnouncement({
        ordinal: '200',
        state: 'pending',
      });
      await seedAnnouncementCatalog(f.pool, [
        global,
        home,
        related,
        hidden,
        pending,
      ]);
      const actor = await f.actor({
        phone: 'unverified',
        affiliation: 'unverified',
        identity: false,
      });
      await t.test(
        'guest content reads and phone/student-unverified authenticated reads need no identity campus',
        async () => {
          for (const who of [undefined, actor]) {
            const page = await get('', {}, who);
            safe(page);
            assert.deepEqual(
              page.body.items.map((row: { id: string }) => row.id),
              [global.id],
            );
            assert.equal(page.body.items[0].isLatest, true);
            const detail = await get(`/${global.id}`, {}, who);
            safe(detail);
            assert.equal(detail.body.bodyText, global.bodyText);
            assert.equal(detail.body.announcementDate, null);
            assert.deepEqual(detail.body.media, {
              status: 'known_empty',
              items: [],
            });
            safe(await get('/popup', {}, who));
            safe(await get('/changes', {}, who));
          }
          safe(await owner(), 'AUTHENTICATION_REQUIRED');
          safe(
            await ack(undefined, global.id, global.revision),
            'AUTHENTICATION_REQUIRED',
          );
          for (const header of [
            'Bearer invalid',
            'Basic invalid',
            'Bearer',
            `Bearer wu_a_${'a'.repeat(43)}`,
          ]) {
            for (const suffix of ['', '/popup', '/changes', `/${global.id}`]) {
              safe(
                await get(suffix).set('Authorization', header),
                'AUTHENTICATION_REQUIRED',
              );
            }
          }
        },
      );
      await t.test(
        'exact physical browsing campus never broadens to same institution, region, community or identity scope',
        async () => {
          const before = await f.snapshot();
          for (const who of [undefined, actor]) {
            const page = await get(
              '',
              { campusId: f.scope.home.campusId },
              who,
            );
            safe(page);
            assert.deepEqual(
              page.body.items.map((row: { id: string }) => row.id),
              [home.id, global.id],
            );
            assert.deepEqual(
              page.body.items.map((row: { isLatest: boolean }) => row.isLatest),
              [true, false],
            );
            safe(
              await get(
                `/${related.id}`,
                { campusId: f.scope.home.campusId },
                who,
              ),
              'ANNOUNCEMENT_NOT_FOUND',
            );
            safe(await get(`/${home.id}`, {}, who), 'ANNOUNCEMENT_NOT_FOUND');
            safe(await get(`/${hidden.id}`, {}, who), 'ANNOUNCEMENT_NOT_FOUND');
            safe(
              await get(`/${pending.id}`, {}, who),
              'ANNOUNCEMENT_NOT_FOUND',
            );
          }
          assert.deepEqual(
            await f.snapshot(),
            before,
            'All public GETs are domain-state pure',
          );
          for (const campusId of [
            randomUUID(),
            f.scope.home.regionId,
            f.scope.global.spaceId,
          ])
            safe(await get('', { campusId }), 'CAMPUS_NOT_FOUND');
          for (const query of [
            { campusId: '0' },
            { campusId: [f.scope.home.campusId, f.scope.related.campusId] },
            { ownerId: actor.accountId },
            { limit: 51 },
            { since: '2026-01-01' },
          ]) {
            const response = await get('', query);
            assert.equal(response.status, 400, JSON.stringify(response.body));
          }
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'DELETE FROM whaleu_campus.campus_region_assignments WHERE campus_id=$1',
              [f.scope.home.campusId],
            ),
          );
          const exact = await get('', { campusId: f.scope.home.campusId });
          safe(exact);
          assert.equal(
            exact.body.items[0].id,
            home.id,
            'Accepted exact campus targeting requires no region inference',
          );
        },
      );
      await t.test(
        'every signed-in read and command rechecks current safety while guests stay public',
        async () => {
          for (const [patch, code] of [
            ['actions_allowed=false', 'SAFETY_ACTION_RESTRICTED'],
            ["restriction_coverage='missing'", 'SAFETY_UNAVAILABLE'],
            [
              "valid_until=clock_timestamp()-interval '1 second'",
              'SAFETY_UNAVAILABLE',
            ],
          ] as const) {
            const restricted = await createRuntimeActor(f.app);
            await withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                `UPDATE whaleu_safety.account_heads SET ${patch} WHERE account_id=$1`,
                [restricted.accountId],
              ),
            );
            for (const suffix of ['', '/popup', '/changes', `/${global.id}`])
              safe(await get(suffix, {}, restricted), code);
            safe(await owner(restricted), code);
            safe(await ack(restricted, global.id, global.revision), code);
          }
          safe(await get());
        },
      );
      await t.test(
        'GETs never acknowledge; owner-only repeat/concurrent receipts preserve original timestamp and latest suppresses older unseen',
        async () => {
          const second = await createRuntimeActor(f.app);
          const before = await f.snapshot();
          const unseen = await owner(actor, f.scope.home.campusId);
          safe(unseen);
          assert.equal(unseen.body.candidate.id, home.id);
          assert.deepEqual(unseen.body.acknowledgement, {
            status: 'unseen',
            acknowledgedAt: null,
          });
          assert.deepEqual(
            await f.snapshot(),
            before,
            'Owner popup GET is pure too',
          );
          const bad = await ack(
            actor,
            home.id,
            home.revision,
            f.scope.home.campusId,
            { accountId: second.accountId },
          );
          assert.equal(bad.status, 400);
          const commands = await Promise.all(
            Array.from({ length: 6 }, () =>
              ack(actor, home.id, home.revision, f.scope.home.campusId),
            ),
          );
          for (const response of commands) {
            safe(response);
            assert.deepEqual(response.body, commands[0]!.body);
          }
          assert.equal(
            await announcementMarkerCount(f.pool, actor.accountId, home.id),
            1,
          );
          assert.equal(
            await announcementMarkerCount(f.pool, second.accountId, home.id),
            0,
          );
          assert.ok(commands[0]!.body.acknowledgement.acknowledgedAt);
          assert.deepEqual(
            (await ack(actor, home.id, home.revision, f.scope.home.campusId))
              .body,
            commands[0]!.body,
            'Lost response replay returns original receipt',
          );
          const suppressed = await owner(actor, f.scope.home.campusId);
          safe(suppressed);
          assert.equal(suppressed.body.candidate.id, home.id);
          assert.equal(suppressed.body.acknowledgement.status, 'acknowledged');
          assert.equal(
            (await owner(second, f.scope.home.campusId)).body.acknowledgement
              .status,
            'unseen',
          );
          assert.equal(
            (await owner(actor)).body.acknowledgement.status,
            'unseen',
            'Same display version must not fan out acknowledgement',
          );
          safe(await ack(actor, global.id, global.revision));
          const receipt = (await owner(actor)).body.acknowledgement;
          assert.deepEqual(
            (await owner(actor, f.scope.foreign.campusId)).body.acknowledgement,
            receipt,
            'Global marker is campus independent',
          );
          const edited = {
            ...home,
            revision: randomUUID(),
            bodyText: 'Accepted edit of same stable identity',
          };
          await seedAnnouncementCatalog(f.pool, [global, edited, related]);
          const current = await owner(actor, f.scope.home.campusId);
          safe(current);
          assert.equal(current.body.candidate.bodyText, edited.bodyText);
          assert.deepEqual(
            current.body.acknowledgement,
            commands[0]!.body.acknowledgement,
          );
          safe(
            await ack(second, home.id, home.revision, f.scope.home.campusId),
            'ANNOUNCEMENT_REVISION_CHANGED',
          );
          assert.equal(
            await announcementMarkerCount(f.pool, second.accountId, home.id),
            0,
          );
          // An older still-active popup can be explicitly closed after a newer one appears.
          safe(await ack(second, global.id, global.revision));
        },
      );
      await t.test(
        'preserved identities require owner-specific history coverage; trusted historical timestamp may remain unknown',
        async () => {
          const imported = syntheticAnnouncement({
            ordinal: '300',
            origin: 'preserved',
            versionLabel: global.versionLabel,
          });
          await seedAnnouncementCatalog(f.pool, [imported]);
          const who = await createRuntimeActor(f.app),
            other = await createRuntimeActor(f.app);
          assert.deepEqual((await owner(who)).body.acknowledgement, {
            status: 'unavailable',
            acknowledgedAt: null,
          });
          await seedAnnouncementHistoryCoverage(
            f.pool,
            who.accountId,
            imported.id,
          );
          assert.deepEqual((await owner(who)).body.acknowledgement, {
            status: 'unseen',
            acknowledgedAt: null,
          });
          assert.equal(
            (await owner(other)).body.acknowledgement.status,
            'unavailable',
          );
          await seedHistoricalAnnouncementAcknowledgement(
            f.pool,
            other.accountId,
            imported.id,
          );
          assert.deepEqual((await owner(other)).body.acknowledgement, {
            status: 'acknowledged',
            acknowledgedAt: null,
          });
        },
      );
      await t.test(
        'retarget, disable, withdrawal and stale revisions never create owner markers',
        async () => {
          const who = await createRuntimeActor(f.app);
          const row = syntheticAnnouncement({ ordinal: '400' });
          await seedAnnouncementCatalog(f.pool, [row]);
          for (const replacement of [
            {
              ...row,
              revision: randomUUID(),
              campusIds: [f.scope.related.campusId],
            },
            { ...row, revision: randomUUID(), popupEnabled: false },
            { ...row, state: 'withdrawn' as const },
          ]) {
            await seedAnnouncementCatalog(f.pool, [replacement]);
            const response = await ack(who, row.id, row.revision);
            assert.ok(
              [404, 409, 503].includes(response.status),
              JSON.stringify(response.body),
            );
            assert.equal(
              await announcementMarkerCount(f.pool, who.accountId, row.id),
              0,
            );
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'announcement keyset traversal and exact newness are independent from display dates and acknowledgement',
  { timeout: 120000 },
  async (t) => {
    const f = await directoryRuntimeFixture();
    const get = (query: object = {}, who?: { accessToken: string }) => {
      const call = request(f.app.getHttpServer())
        .get('/v1/announcements')
        .query(query);
      return who
        ? call.set('Authorization', `Bearer ${who.accessToken}`)
        : call;
    };
    try {
      const rows = Array.from({ length: 127 }, (_, i) =>
        syntheticAnnouncement({
          ordinal: String(i + 1),
          createdAt: i % 3 === 0 ? null : '2026-01-01T00:00:00.000001Z',
          announcementDate: i % 2 === 0 ? null : '2030-01-01',
          versionLabel: 'Repeated version',
        }),
      );
      await seedAnnouncementCatalog(f.pool, rows);
      await t.test(
        '127 records traverse by exact accepted ordinal, no duplicate or skip and latest is catalog-wide',
        async () => {
          let cursor: string | null = null;
          const observed: string[] = [];
          do {
            const response = await get({
              limit: 17,
              ...(cursor ? { cursor } : {}),
            });
            safe(response);
            assert.ok(response.body.items.length <= 17);
            assert.equal(
              response.body.items.filter(
                (row: { isLatest: boolean }) => row.isLatest,
              ).length,
              cursor ? 0 : 1,
            );
            observed.push(
              ...response.body.items.map((row: { id: string }) => row.id),
            );
            cursor = response.body.nextCursor;
            assert.equal(response.body.continuation, cursor ? 'more' : 'end');
          } while (cursor);
          assert.deepEqual(
            observed,
            rows.toReversed().map((row) => row.id),
          );
          assert.equal(new Set(observed).size, 127);
        },
      );
      await t.test(
        'opaque cursor binds guest/authenticated mode, session, campus, limit and catalog revision',
        async () => {
          const actor = await createRuntimeActor(f.app),
            other = await createRuntimeActor(f.app);
          const guestCursor = (await get({ limit: 17 })).body.nextCursor;
          const memberCursor = (await get({ limit: 17 }, actor)).body
            .nextCursor;
          for (const [query, who] of [
            [{ limit: 17, cursor: guestCursor }, actor],
            [{ limit: 17, cursor: memberCursor }, undefined],
            [{ limit: 17, cursor: memberCursor }, other],
            [{ limit: 18, cursor: guestCursor }, undefined],
            [
              {
                limit: 17,
                cursor: guestCursor,
                campusId: f.scope.home.campusId,
              },
              undefined,
            ],
          ] as const)
            safe(await get(query, who), 'DISCOVERY_RESTART_REQUIRED');
          const principal = (
            await f.pool.query<{
              provider: 'wechat';
              appId: string;
              subject: string;
            }>(
              'SELECT provider,app_id AS "appId",subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
              [actor.accountId],
            )
          ).rows[0]!;
          const accessToken = mintToken('access'),
            refreshToken = mintToken('refresh');
          const relogin = await f.app
            .get(IdentityRepository)
            .createSession(principal, {
              access: hashToken(accessToken),
              refresh: hashToken(refreshToken),
            });
          assert.equal(relogin.accountId, actor.accountId);
          assert.notEqual(relogin.sessionId, actor.sessionId);
          safe(
            await get({ limit: 17, cursor: memberCursor }, { accessToken }),
            'DISCOVERY_RESTART_REQUIRED',
          );
          await f.pool.query(
            "WITH fixture AS (DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1 RETURNING *) INSERT INTO whaleu_community.discovery_cursors(cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at) SELECT cursor,scope_hash,bucket_hash,coordinate_hash,position,statement_timestamp()-interval '25 hours',statement_timestamp()-interval '1 hour' FROM fixture",
            [guestCursor],
          );
          safe(
            await get({ limit: 17, cursor: guestCursor }),
            'DISCOVERY_RESTART_REQUIRED',
          );
          await seedAnnouncementCatalog(f.pool, rows);
          safe(
            await get({ limit: 17, cursor: memberCursor }, actor),
            'DISCOVERY_RESTART_REQUIRED',
          );
        },
      );
      await t.test(
        'microseconds compare exactly; updated/display date and markers never determine newness',
        async () => {
          const exact = [
            syntheticAnnouncement({
              ordinal: '1',
              createdAt: '2026-01-01T00:00:00.000001Z',
              updatedAt: '2026-02-01T00:00:00Z',
              announcementDate: '2030-01-01',
            }),
            syntheticAnnouncement({
              ordinal: '2',
              createdAt: '2026-01-01T00:00:00.000002Z',
            }),
            syntheticAnnouncement({
              ordinal: '3',
              createdAt: '2026-01-01T00:00:00.000003Z',
              campusIds: [f.scope.home.campusId],
            }),
            syntheticAnnouncement({
              ordinal: '4',
              createdAt: '2026-01-01T00:00:00.000004Z',
              state: 'withdrawn',
            }),
          ];
          await seedAnnouncementCatalog(f.pool, exact);
          const changes = async (since: string, campusId?: string) =>
            request(f.app.getHttpServer())
              .get('/v1/announcements/changes')
              .query({ since, ...(campusId ? { campusId } : {}) });
          const one = await changes('2026-01-01T00:00:00.000001Z');
          safe(one);
          assert.deepEqual(one.body.newness, {
            status: 'available',
            hasNew: true,
            newCount: '1',
          });
          assert.equal(
            (
              await changes(
                '2026-01-01T00:00:00.000001Z',
                f.scope.home.campusId,
              )
            ).body.newness.newCount,
            '2',
          );
          assert.equal(
            (await changes('2026-01-01T08:00:00.000002+08:00')).body.newness
              .newCount,
            '0',
          );
          assert.equal(
            (await changes('2030-01-01T00:00:00Z')).body.newness.newCount,
            '0',
          );
          const unknown = syntheticAnnouncement({
            ordinal: '5',
            createdAt: null,
            campusIds: [f.scope.home.campusId],
          });
          await seedAnnouncementCatalog(f.pool, [...exact, unknown]);
          assert.equal(
            (await changes('2026-01-01T00:00:00.000001Z')).body.newness.status,
            'available',
          );
          assert.deepEqual(
            (
              await changes(
                '2026-01-01T00:00:00.000001Z',
                f.scope.home.campusId,
              )
            ).body.newness,
            { status: 'unavailable', hasNew: null, newCount: null },
          );
          const defaultWindow = await request(f.app.getHttpServer()).get(
            '/v1/announcements/changes',
          );
          safe(defaultWindow);
          assert.equal(
            Date.parse(defaultWindow.body.checkedAt) -
              Date.parse(defaultWindow.body.since),
            30 * 24 * 60 * 60 * 1000,
          );
          const actor = await createRuntimeActor(f.app);
          const before = (await changes('2026-01-01T00:00:00Z')).body.newness;
          await request(f.app.getHttpServer())
            .put(`/v1/me/announcements/${exact[1]!.id}/popup-acknowledgement`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send({ campusId: null, expectedRevision: exact[1]!.revision })
            .expect(200);
          assert.deepEqual(
            (await changes('2026-01-01T00:00:00Z')).body.newness,
            before,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
