import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import {
  announcementMediaFixture,
  grantAnnouncementSchool,
  createAnnouncementDraft,
  announcementMediaContent,
  announcementMediaOk as ok,
} from '../support/media/announcement-runtime-fixture.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { commandHash } from '../../src/announcements/authoring/contracts.js';
import { canonicalJson } from '../../src/community/content-review/contracts.js';
test(
  'native announcement current grants, exact source, stable identity, targeting, CAS and popup acknowledgement',
  { timeout: 300000 },
  async (t) => {
    const f = await announcementMediaFixture([
      { sha256: 'a'.repeat(64), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      other = await f.actor(),
      superAdmin = await f.actor(),
      dev = await f.actor(),
      member = await f.actor();
    await grantAnnouncementSchool(f, actor);
    await grantAnnouncementSchool(f, other);
    await grantAnnouncementSchool(f, superAdmin, 'super_admin');
    await grantAnnouncementSchool(f, dev, 'developer');
    const http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`,
      campus = f.scope.home.campusId;
    const send = (id: string, body: object, token = auth) =>
      request(http)
        .post(`/v1/announcement-management/${id}/commands`)
        .set('Authorization', token)
        .send(body);
    const detail = (id: string, target: string | null = campus) => {
      const req = request(http).get(`/v1/native-announcements/${id}`);
      return target ? req.query({ campusId: target }) : req;
    };
    const id = await createAnnouncementDraft(f, actor);
    await detail(id).expect(404);
    await request(http).get('/v1/announcements').expect(503);
    const publish = {
        action: 'publish' as const,
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      },
      published = await send(id, publish);
    ok(published);
    assert.equal(published.body.revision, 2);
    assert.equal(
      published.body.requestHash,
      commandHash(actor.accountId, id, publish),
    );
    assert.deepEqual((await send(id, publish)).body, published.body);
    ok(await detail(id));
    await detail(id, null).expect(404);
    await detail(id, f.scope.foreign.campusId).expect(404);
    await request(http)
      .get('/v1/native-announcements')
      .query({ campusId: campus })
      .set('Authorization', 'Bearer malformed')
      .expect(401);
    const update = {
      action: 'update' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
      content: {
        ...announcementMediaContent,
        versionLabel: '2',
        bodyText: '第一行\n  第二行',
      },
      audience: { kind: 'fixed' as const },
      mediaChanges: {},
    };
    await send(id, update, `Bearer ${other.accessToken}`).expect(403);
    await send(id, update, `Bearer ${dev.accessToken}`).expect(403);
    await send(id, { ...update, audience: { kind: 'all' } }).expect(403);
    const before = (await detail(id)).body;
    const popup = await request(http)
      .get('/v1/me/native-announcements/popup')
      .query({ campusId: campus })
      .set('Authorization', `Bearer ${member.accessToken}`);
    ok(popup);
    assert.equal(popup.body.candidate.id, id);
    assert.equal(popup.body.acknowledgement.status, 'unseen');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_announcements.popup_acknowledgements',
        )
      ).rows[0].n,
      0,
    );
    const ack = await request(http)
      .put(`/v1/me/native-announcements/${id}/popup-acknowledgement`)
      .set('Authorization', `Bearer ${member.accessToken}`)
      .send({ campusId: campus, expectedRevision: before.revision });
    ok(ack);
    const edits = await Promise.all([
      send(id, update),
      send(id, { ...update, clientRequestId: randomUUID() }),
    ]);
    assert.deepEqual(edits.map((r) => r.status).sort(), [200, 409]);
    const after = (await detail(id)).body;
    assert.equal(after.title, '鲸语校园1');
    assert.equal(after.versionLabel, '2');
    assert.equal(after.bodyText, '第一行\n  第二行');
    assert.equal(after.createdAt, before.createdAt);
    ok(
      await send(id, {
        action: 'set_enabled',
        clientRequestId: randomUUID(),
        expectedRevision: 3,
        enabled: false,
      }),
    );
    await detail(id).expect(404);
    ok(
      await send(id, {
        action: 'set_enabled',
        clientRequestId: randomUUID(),
        expectedRevision: 4,
        enabled: true,
      }),
    );
    const seen = await request(http)
      .get('/v1/me/native-announcements/popup')
      .query({ campusId: campus })
      .set('Authorization', `Bearer ${member.accessToken}`);
    ok(seen);
    assert.equal(seen.body.acknowledgement.status, 'acknowledged');
    assert.equal(
      seen.body.acknowledgement.acknowledgedAt,
      ack.body.acknowledgement.acknowledgedAt,
    );
    const second = await createAnnouncementDraft(f, actor);
    ok(
      await send(second, {
        action: 'publish',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      }),
    );
    assert.equal(
      (
        await request(http)
          .get('/v1/me/native-announcements/popup')
          .query({ campusId: campus })
          .set('Authorization', `Bearer ${member.accessToken}`)
      ).body.acknowledgement.status,
      'unseen',
    );
    const globalId = randomUUID(),
      globalAuth = `Bearer ${superAdmin.accessToken}`;
    ok(
      await send(
        globalId,
        {
          action: 'create',
          clientRequestId: randomUUID(),
          expectedRevision: 0,
          content: announcementMediaContent,
          audience: { kind: 'all' },
        },
        globalAuth,
      ),
    );
    ok(
      await send(
        globalId,
        {
          action: 'publish',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
        },
        globalAuth,
      ),
    );
    ok(await detail(globalId, null));
    ok(await detail(globalId, f.scope.foreign.campusId));
    const cancelled = await createAnnouncementDraft(f, actor);
    ok(
      await send(cancelled, {
        action: 'cancel_draft',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      }),
    );
    await detail(cancelled).expect(404);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_announcements.catalog_head',
        )
      ).rows[0].n,
      0,
    );
    await t.test(
      'new UTF-8 command budget admits long Chinese text, rejects overflow before receipt',
      async () => {
        const large = randomUUID(),
          text = '中'.repeat(6000),
          cmd = {
            action: 'create' as const,
            clientRequestId: randomUUID(),
            expectedRevision: 0,
            content: {
              ...announcementMediaContent,
              bodyText: text,
              popupBodyText: text,
            },
            audience: { kind: 'fixed' as const },
          };
        ok(await send(large, cmd));
        for (const character of ['中', '😀']) {
          const empty = {
            ...cmd,
            clientRequestId: randomUUID(),
            content: { ...cmd.content, bodyText: '', popupBodyText: '' },
          };
          const count = Math.min(
            10000,
            Math.floor(
              (60000 - Buffer.byteLength(canonicalJson(empty), 'utf8')) /
                (Buffer.byteLength(character, 'utf8') * 2),
            ),
          );
          const maximal = {
            ...empty,
            content: {
              ...empty.content,
              bodyText: character.repeat(count),
              popupBodyText: character.repeat(count),
            },
          };
          ok(await send(randomUUID(), maximal));
          const excess = {
            ...maximal,
            clientRequestId: randomUUID(),
            content: {
              ...maximal.content,
              bodyText: character.repeat(count + 1),
              popupBodyText: character.repeat(count + 1),
            },
          };
          await send(randomUUID(), excess).expect(400);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_announcements.native_requests WHERE client_request_id=$1',
                [excess.clientRequestId],
              )
            ).rows[0].n,
            0,
          );
        }
        const huge = {
          ...cmd,
          clientRequestId: randomUUID(),
          content: {
            ...cmd.content,
            bodyText: '😀'.repeat(8000),
            popupBodyText: '😀'.repeat(8000),
          },
        };
        await send(randomUUID(), huge).expect(400);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_announcements.native_requests WHERE client_request_id=$1',
              [huge.clientRequestId],
            )
          ).rows[0].n,
          0,
        );
      },
    );
    await t.test(
      'super cannot enter or mutate another creator private draft; creator closure survives grant move',
      async () => {
        const draft = await createAnnouncementDraft(f, other);
        await request(http)
          .get(`/v1/announcement-management/${draft}`)
          .set('Authorization', globalAuth)
          .expect(403);
        await send(
          draft,
          {
            action: 'save',
            clientRequestId: randomUUID(),
            expectedRevision: 1,
            content: announcementMediaContent,
            audience: { kind: 'all' },
            mediaChanges: {},
          },
          globalAuth,
        ).expect(403);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE account_id=$1 AND revoked_at IS NULL',
            [other.accountId],
          ),
        );
        await grantAnnouncementSchool(
          f,
          other,
          'school_admin',
          f.scope.foreign.regionId,
        );
        const ownAuth = `Bearer ${other.accessToken}`;
        await request(http)
          .get(`/v1/announcement-management/${draft}`)
          .set('Authorization', ownAuth)
          .expect(403);
        const closure = await request(http)
          .get(`/v1/announcement-management/draft-closure/${draft}`)
          .set('Authorization', ownAuth);
        ok(closure);
        assert.deepEqual(Object.keys(closure.body).sort(), [
          'id',
          'revision',
          'state',
        ]);
        ok(
          await send(
            draft,
            {
              action: 'cancel_draft',
              clientRequestId: randomUUID(),
              expectedRevision: 1,
            },
            ownAuth,
          ),
        );
      },
    );
    await t.test(
      'queued topology writer makes final bounded source proof fail rather than publishing a pre-wait audience',
      async () => {
        const observer = observeDirectoryQueries(f.app);
        let queued: Promise<unknown> | undefined;
        let fired = false;
        const target = randomUUID(),
          cmd = {
            action: 'create',
            clientRequestId: randomUUID(),
            expectedRevision: 0,
            content: announcementMediaContent,
            audience: { kind: 'fixed' },
          };
        observer.setHook(async ({ sql }) => {
          if (
            !fired &&
            sql.startsWith('INSERT INTO whaleu_announcements.native_requests')
          ) {
            fired = true;
            queued = f.pool.query(
              'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$1 WHERE campus_id=$2',
              [f.scope.foreign.regionId, campus],
            );
            await f.waitForLock(
              'UPDATE whaleu_campus.campus_region_assignments',
            );
          }
        });
        try {
          const result = await send(target, cmd);
          assert.equal(result.status, 503, JSON.stringify(result.body));
          assert.equal(fired, true);
          await queued;
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_announcements.native_requests WHERE client_request_id=$1',
                [cmd.clientRequestId],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          observer.restore();
          await queued;
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=$1 WHERE campus_id=$2',
              [f.scope.home.regionId, campus],
            ),
          );
        }
      },
    );
    await t.test(
      'grant expiry after operation SQL but before final completion rolls back source and receipt',
      async () => {
        const expiring = await f.actor(),
          grant = randomUUID();
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,'school_admin',$3,$2,'synthetic-expiring-announcement-grant',clock_timestamp()+interval '2 seconds')",
            [grant, expiring.accountId, f.scope.home.regionId],
          ),
        );
        const observer = observeDirectoryQueries(f.app);
        let fired = false;
        observer.setHook(async ({ sql }, tx) => {
          if (
            !fired &&
            sql.startsWith('INSERT INTO whaleu_announcements.native_requests')
          ) {
            fired = true;
            await tx.query('SELECT pg_sleep(2.1)');
          }
        });
        const target = randomUUID(),
          cmd = {
            action: 'create',
            clientRequestId: randomUUID(),
            expectedRevision: 0,
            content: announcementMediaContent,
            audience: { kind: 'fixed' },
          };
        try {
          const result = await send(
            target,
            cmd,
            `Bearer ${expiring.accessToken}`,
          );
          assert.equal(result.status, 503, JSON.stringify(result.body));
          assert.equal(fired, true);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_announcements.native_announcements WHERE id=$1',
                [target],
              )
            ).rows[0].n,
            0,
          );
        } finally {
          observer.restore();
        }
      },
    );
  },
);
