import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import {
  majorDiscussionFixture,
  discussionHistory,
  reviewMajorDiscussion,
  revokeMajorDiscussionReview,
} from '../support/major-discussion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { MajorDiscussionNoticeOwner } from '../../src/notifications/major-discussion/owner.js';
import { majorDiscussionDeleteIntentHash } from '../../src/majors/discussion/delete-service.js';
import { inTransaction } from '../../src/database/database.js';
function ok(r: { status: number; body: unknown }, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
}
test(
  'Major logical deletion A-G/J/K: independent authority, visibility, durable recovery and immutable history',
  { timeout: 240000 },
  async (t) => {
    const f = await majorDiscussionFixture();
    t.after(() => f.close());
    const actor = await f.actor({ identity: false }),
      other = await f.actor({ identity: false }),
      third = await f.actor({ identity: false }),
      w = f.add(),
      foreign = f.add(),
      http = f.app.getHttpServer();
    const catalog = await f.accept([w, foreign]);
    await f.acceptDiscussion([w.id, foreign.id]);
    const post = (path: string, body: object, a = actor) =>
      request(http)
        .post('/v1/majors' + path)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(body);
    const get = (path: string, a = actor) =>
      request(http)
        .get('/v1/majors' + path)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const publish = async (
      body: string,
      a = actor,
      root: string | null = null,
      target: string | null = null,
    ) => {
      const q = root
        ? f.reply(catalog, w, body, target)
        : f.root(catalog, w, body);
      const decision = await reviewMajorDiscussion(
        f.pool,
        a.accountId,
        w.id,
        q,
        root,
      );
      const r = await post(
        `/${w.id}/discussion${root ? `/${root}/replies` : ''}`,
        q,
        a,
      );
      ok(r);
      return { id: r.body.commentId as string, q, receipt: r.body, decision };
    };
    const del = (
      id: string,
      rootId: string | null = null,
      a = actor,
      key = randomUUID(),
      major = w.id,
    ) =>
      post(
        `/${major}/discussion/${id}/delete`,
        { clientRequestId: key, rootId },
        a,
      );
    const grant = async (
      a: typeof actor,
      role: 'developer' | 'school_admin' | 'super_admin',
      region: string | null = null,
      from = new Date(Date.now() - 1000),
      until: Date | null = null,
    ) => {
      const id = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at) VALUES($1,$2,$3,$4,$2,'synthetic:major-delete-scope',$5,$6)",
          [id, a.accountId, role, region, from, until],
        ),
      );
      return id;
    };
    await t.test(
      'A/F: author withdrawal ignores base/source/Review/history; wrong author/major/root and invalid phone fail',
      async () => {
        const root = await publish('withdrawable without source'),
          reply = await publish('own reply', actor, root.id);
        const allowed = await get(
          `/${w.id}/discussion/${root.id}/delete-capability`,
        );
        ok(allowed);
        assert.deepEqual(allowed.body, {
          majorId: w.id,
          commentId: root.id,
          rootId: null,
          allowed: true,
        });
        const denied = await get(
          `/${w.id}/discussion/${root.id}/delete-capability`,
          other,
        );
        ok(denied);
        assert.deepEqual(denied.body, {
          majorId: w.id,
          commentId: root.id,
          rootId: null,
          allowed: false,
        });
        const absent = randomUUID(),
          unknown = await get(
            `/${w.id}/discussion/${absent}/delete-capability`,
            other,
          );
        ok(unknown);
        assert.deepEqual(unknown.body, {
          majorId: w.id,
          commentId: absent,
          rootId: null,
          allowed: false,
        });
        ok(await del(root.id, null, other), 404);
        ok(await del(root.id, null, actor, randomUUID(), foreign.id), 404);
        ok(await del(reply.id, null), 404);
        ok(await del(root.id, reply.id), 404);
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        await revokeMajorDiscussionReview(f.pool, root.decision);
        await discussionHistory(f.pool, w.id, 'population', 'unknown');
        await discussionHistory(f.pool, w.id, 'likes', 'unknown');
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
        );
        const reducedCapability = await get(
          `/${w.id}/discussion/${root.id}/delete-capability`,
        );
        ok(reducedCapability);
        assert.equal(reducedCapability.body.allowed, true);
        const deleted = await del(root.id);
        ok(deleted);
        assert.equal(deleted.body.outcome, 'applied');
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          phone: 'unverified',
          identity: false,
        });
        ok(await del(reply.id, root.id), 403);
        ok(await get(`/discussion-delete-requests/${deleted.body.requestId}`));
        ok(await del(root.id, null, actor, deleted.body.requestId));
        await f.certify(actor.accountId, { identity: false });
        await f.acceptDiscussion([w.id]);
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
        );
        ok(await del(reply.id, root.id));
      },
    );
    await t.test(
      'B/C: exact admin region; developer/future/expired and missing mapping deny even for super admin',
      async () => {
        const school = await f.actor({
            identity: false,
            affiliation: 'unverified',
          }),
          wrong = await f.actor({ identity: false }),
          dev = await f.actor({ identity: false }),
          superAdmin = await f.actor({ identity: false }),
          future = await f.actor({ identity: false }),
          expired = await f.actor({ identity: false });
        await grant(school, 'school_admin', f.scope.home.regionId);
        await grant(wrong, 'school_admin', f.scope.foreign.regionId);
        await f.certify(wrong.accountId, { campusId: f.scope.home.campusId });
        await f.certify(school.accountId, {
          campusId: f.scope.foreign.campusId,
        });
        await grant(dev, 'developer');
        await grant(superAdmin, 'super_admin');
        await grant(
          future,
          'school_admin',
          f.scope.home.regionId,
          new Date(Date.now() + 3600000),
        );
        await grant(
          expired,
          'super_admin',
          null,
          new Date(Date.now() - 3600000),
          new Date(Date.now() - 1000),
        );
        const root = await publish('admin scope'),
          reply = await publish('admin scoped reply', other, root.id);
        for (const a of [wrong, dev, future, expired])
          ok(await del(root.id, null, a), 404);
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn'",
        );
        for (const a of [school, superAdmin])
          ok(await del(root.id, null, a), 404);
        await f.pool.query(
          "UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
        );
        ok(await del(reply.id, root.id, school));
        ok(await del(root.id, null, superAdmin));
        ok(await get(`/${w.id}/discussion/${root.id}`, superAdmin), 404);
      },
    );
    await t.test(
      'D/J/K: addressed deletion removes reference; root denies descendants/count/hot/notices; history preserved',
      async () => {
        const root = await publish('visible root'),
          addressed = await publish('addressed original', other, root.id),
          survivor = await publish(
            'other author body preserved',
            third,
            root.id,
            addressed.id,
          );
        const like = f.like(catalog, w),
          liked = await post(
            `/${w.id}/discussion/${root.id}/like`,
            like,
            other,
          );
        ok(liked);
        const counts = async () =>
          (
            await f.pool.query(
              'SELECT (SELECT count(*) FROM whaleu_majors.major_discussion_comments)::int comments,(SELECT count(*) FROM whaleu_majors.major_discussion_like_events)::int likes,(SELECT count(*) FROM whaleu_majors.major_discussion_commands)::int commands,(SELECT count(*) FROM whaleu_notifications.major_discussion_notices)::int notices',
            )
          ).rows[0];
        const before = await counts();
        ok(await del(addressed.id, root.id, other));
        const thread = await get(`/${w.id}/discussion/${root.id}`);
        ok(thread);
        assert.equal(thread.body.root.replyCount, 1);
        assert.deepEqual(
          thread.body.items.map((x: { id: string }) => x.id),
          [survivor.id],
        );
        assert.equal(thread.body.items[0].body, 'other author body preserved');
        assert.equal(thread.body.items[0].replyToReplyId, null);
        assert.equal(thread.body.items[0].addressedAuthor, null);
        const notice = (
          await f.pool.query<{ id: string }>(
            'SELECT id FROM whaleu_notifications.major_discussion_notices WHERE recipient_id=$1 AND event_id=$2',
            [actor.accountId, survivor.id],
          )
        ).rows[0]!;
        ok(await del(root.id));
        ok(await get(`/${w.id}/discussion/${root.id}`), 404);
        ok(
          await post(
            `/${w.id}/discussion/${survivor.id}/like`,
            f.like(catalog, w),
            other,
          ),
          404,
        );
        ok(
          await request(http)
            .get(`/v1/me/major-discussion/notices/${notice.id}/target`)
            .set('Authorization', 'Bearer ' + actor.accessToken),
          404,
        );
        const page = await get(`/${w.id}/discussion`);
        ok(page);
        assert.equal(
          page.body.items.some((x: { id: string }) => x.id === root.id),
          false,
        );
        assert.deepEqual(await counts(), before);
        ok(
          await post(
            `/${w.id}/discussion/${root.id}/like`,
            f.like(catalog, w, false, liked.body.membershipRevision),
            other,
          ),
        );
        ok(await get(`/discussion-requests/${root.q.clientRequestId}`));
      },
    );
    await t.test(
      'E: original key/body replay, subject conflict, actor-private receipts, cancel before/after and new-key noop',
      async () => {
        const root = await publish('durable delete'),
          command = { clientRequestId: randomUUID(), rootId: null };
        const receipt = await post(
          `/${w.id}/discussion/${root.id}/delete`,
          command,
        );
        ok(receipt);
        assert.deepEqual(
          (await post(`/${w.id}/discussion/${root.id}/delete`, command)).body,
          receipt.body,
        );
        ok(
          await post(`/${w.id}/discussion/${randomUUID()}/delete`, command),
          409,
        );
        ok(
          await get(
            `/discussion-delete-requests/${command.clientRequestId}`,
            other,
          ),
          404,
        );
        const noop = await del(root.id);
        ok(noop);
        assert.equal(noop.body.outcome, 'noop');
        assert.equal(noop.body.tombstoneId, receipt.body.tombstoneId);
        const input = {
          operation: 'major.discussion.delete.v1',
          majorId: w.id,
          commentId: root.id,
          command,
        };
        assert.deepEqual(
          (
            await post(
              `/discussion-delete-requests/${command.clientRequestId}/cancel`,
              input,
            )
          ).body,
          receipt.body,
        );
        const second = await publish('cancel before delete'),
          q = { clientRequestId: randomUUID(), rootId: null };
        ok(await get(`/discussion-delete-requests/${q.clientRequestId}`), 404);
        const cancel = await post(
          `/discussion-delete-requests/${q.clientRequestId}/cancel`,
          { ...input, commentId: second.id, command: q },
        );
        ok(cancel);
        assert.equal(cancel.body.code, 'MAJOR_DISCUSSION_CANCELLED');
        assert.deepEqual(
          (await post(`/${w.id}/discussion/${second.id}/delete`, q)).body,
          cancel.body,
        );
        ok(await get(`/${w.id}/discussion/${second.id}`));
      },
    );
    await t.test(
      'G: actual deferred Safety/session/grant/catalog ABA/zero-row mapping mutations roll back',
      async () => {
        const admin = await f.actor({ identity: false });
        const gid = await grant(admin, 'super_admin');
        const changes = [
          `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,application_state,application_coverage) SELECT gen_random_uuid(),account_id,revision+1,'none','complete' FROM whaleu_verification.account_heads WHERE account_id=NEW.actor_id;
           INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) SELECT gen_random_uuid(),h.account_id,gen_random_uuid(),'reconciled_snapshot',h.account_id,h.revision,s.id,s.revision,'synthetic_phone_loss' FROM whaleu_verification.account_heads h JOIN whaleu_verification.snapshots s ON s.account_id=h.account_id AND s.revision=h.revision+1 WHERE h.account_id=NEW.actor_id;
           UPDATE whaleu_verification.account_heads h SET revision=s.revision,snapshot_id=s.id FROM whaleu_verification.snapshots s WHERE h.account_id=NEW.actor_id AND s.account_id=h.account_id AND s.revision=h.revision+1`,
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=NEW.actor_id',
          "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=NEW.session_id",
          `UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id='${gid}'`,
          "UPDATE whaleu_majors.major_catalog_head SET state='withdrawn';UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
          'UPDATE whaleu_campus.campus_region_assignments SET operating_region_id=operating_region_id WHERE false',
          `UPDATE whaleu_campus.campus_region_assignments SET operating_region_id='${f.scope.foreign.regionId}' WHERE campus_id='${f.scope.home.campusId}'`,
        ];
        for (const change of changes) {
          const root = await publish('deferred authority rollback'),
            key = randomUUID();
          await f.pool.query(
            'CREATE FUNCTION whaleu_majors.delete_test_loss() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ' +
              change +
              ';RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_delete_test_loss AFTER INSERT ON whaleu_majors.major_discussion_delete_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.delete_test_loss()',
          );
          try {
            const result = await del(root.id, null, admin, key);
            assert.ok(
              [401, 403, 409, 503].includes(result.status),
              JSON.stringify(result.body),
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=$1',
                  [root.id],
                )
              ).rowCount,
              0,
            );
            ok(await get(`/discussion-delete-requests/${key}`, admin), 404);
          } finally {
            await f.pool.query(
              'DROP TRIGGER zz_delete_test_loss ON whaleu_majors.major_discussion_delete_commands;DROP FUNCTION whaleu_majors.delete_test_loss()',
            );
          }
        }
      },
    );
    await t.test(
      'G/K: raw tombstone cannot bypass receipt; old/new immutable rows reject zero-row UPDATE/DELETE/TRUNCATE',
      async () => {
        const root = await publish('raw authority'),
          key = randomUUID();
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            await tx.query(
              'INSERT INTO whaleu_majors.major_discussion_tombstones(id,major_id,comment_id,actor_id,request_id) VALUES($1,$2,$3,$4,$5)',
              [randomUUID(), w.id, root.id, other.accountId, key],
            );
          }),
        );
        ok(await del(root.id));
        for (const table of [
          'major_discussion_comments',
          'major_discussion_like_events',
          'major_discussion_commands',
          'major_discussion_tombstones',
          'major_discussion_delete_commands',
        ])
          for (const sql of [
            `UPDATE whaleu_majors.${table} SET actor_id=actor_id WHERE false`,
            `DELETE FROM whaleu_majors.${table} WHERE false`,
            `TRUNCATE whaleu_majors.${table} CASCADE`,
          ])
            await assert.rejects(f.pool.query(sql));
      },
    );
    await t.test(
      'G: missing admin epoch fails API and raw final fence; author remains independent',
      async () => {
        const admin = await f.actor({ identity: false });
        await grant(admin, 'super_admin');
        const root = await publish('missing admin epoch'),
          own = await publish('author ignores missing admin epoch');
        // Raw SQL does not register any TypeScript final proof. Its own deferred
        // command/tombstone constraints must still reject a missing epoch.
        for (const table of [
          'major_delete_authority_epoch',
          'major_discussion_epoch',
        ]) {
          const command = { clientRequestId: randomUUID(), rootId: null };
          await assert.rejects(
            inTransaction(f.pool, async (tx) => {
              const authority = (
                await tx.query<{ authority: unknown }>(
                  'SELECT whaleu_majors.major_delete_authority($1,$2,$3,NULL,clock_timestamp()) authority',
                  [admin.accountId, w.id, root.id],
                )
              ).rows[0]!.authority;
              assert.ok(authority);
              const tombstone = (
                await tx.query<{ id: string; recorded_at: Date }>(
                  'INSERT INTO whaleu_majors.major_discussion_tombstones(id,major_id,comment_id,actor_id,request_id) VALUES($1,$2,$3,$4,$5) RETURNING id,recorded_at',
                  [
                    randomUUID(),
                    w.id,
                    root.id,
                    admin.accountId,
                    command.clientRequestId,
                  ],
                )
              ).rows[0]!;
              const receipt = {
                requestId: command.clientRequestId,
                operation: 'major.discussion.delete.v1',
                majorId: w.id,
                commentId: root.id,
                rootId: null,
                outcome: 'applied',
                tombstoneId: tombstone.id,
                recordedAt: tombstone.recorded_at.toISOString(),
              };
              await tx.query(
                'INSERT INTO whaleu_majors.major_discussion_delete_commands(actor_id,request_id,session_id,major_id,comment_id,command,intent_hash,receipt,authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                [
                  admin.accountId,
                  command.clientRequestId,
                  admin.sessionId,
                  w.id,
                  root.id,
                  command,
                  majorDiscussionDeleteIntentHash(
                    admin.accountId,
                    w.id,
                    root.id,
                    command,
                  ),
                  receipt,
                  authority,
                ],
              );
              await tx.query(`DELETE FROM whaleu_majors.${table}`);
            }),
            /epoch unavailable/,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=$1',
                [root.id],
              )
            ).rowCount,
            0,
          );
        }
        const saved = (
          await f.pool.query<{ revision: string }>(
            'DELETE FROM whaleu_majors.major_delete_authority_epoch WHERE singleton RETURNING revision::text',
          )
        ).rows[0]!;
        try {
          ok(await del(root.id, null, admin), 404);
          await assert.rejects(
            f.pool.query('SELECT whaleu_majors.major_delete_fence(true)'),
            /epoch unavailable/,
          );
          assert.equal(
            (
              await f.pool.query<{ authority: unknown }>(
                'SELECT whaleu_majors.major_delete_authority($1,$2,$3,NULL,clock_timestamp()) authority',
                [admin.accountId, w.id, root.id],
              )
            ).rows[0]!.authority,
            null,
          );
          ok(await del(own.id));
        } finally {
          await f.pool.query(
            'INSERT INTO whaleu_majors.major_delete_authority_epoch(singleton,revision) VALUES(true,$1)',
            [saved.revision],
          );
        }
        await assert.rejects(
          inTransaction(f.pool, async (tx) => {
            await tx.query('DELETE FROM whaleu_majors.major_discussion_epoch');
            await tx.query('SELECT whaleu_majors.major_delete_fence(false)');
          }),
          /content epoch unavailable/,
        );
      },
    );
    await t.test(
      'G: deferred catalog and Review revocation cannot defeat reduced author withdrawal',
      async () => {
        const root = await publish('reduced author deferred source loss');
        await f.pool.query(
          `CREATE FUNCTION whaleu_majors.delete_test_source_loss() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE whaleu_majors.major_catalog_head SET state='withdrawn';UPDATE whaleu_community.major_discussion_review_heads SET state='revoked' WHERE decision_id='${root.decision}';RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_delete_test_source_loss AFTER INSERT ON whaleu_majors.major_discussion_delete_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.delete_test_source_loss()`,
        );
        try {
          ok(await del(root.id));
        } finally {
          await f.pool.query(
            "DROP TRIGGER zz_delete_test_source_loss ON whaleu_majors.major_discussion_delete_commands;DROP FUNCTION whaleu_majors.delete_test_source_loss();UPDATE whaleu_majors.major_catalog_head SET state='accepted'",
          );
        }
      },
    );
    await t.test(
      'G: final proof after actual deferred wait rejects exact expired admin grant',
      async () => {
        const admin = await f.actor({ identity: false }),
          root = await publish('admin exact deadline');
        await grant(
          admin,
          'super_admin',
          null,
          new Date(Date.now() - 1000),
          new Date(Date.now() + 2000),
        );
        const boundary = (
          await f.pool.query<{ at: boolean; before: boolean }>(
            `SELECT whaleu_majors.major_delete_authority($1,$2,$3,NULL,g.expires_at) IS NULL at,whaleu_majors.major_delete_authority($1,$2,$3,NULL,g.expires_at-interval '1 microsecond') IS NOT NULL before FROM whaleu_authorization.role_grants g WHERE g.account_id=$1 AND g.role='super_admin'`,
            [admin.accountId, w.id, root.id],
          )
        ).rows[0]!;
        assert.deepEqual(boundary, { at: true, before: true });
        await f.pool.query(
          'CREATE FUNCTION whaleu_majors.delete_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2.1);RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER zz_delete_test_wait AFTER INSERT ON whaleu_majors.major_discussion_delete_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_majors.delete_test_wait()',
        );
        try {
          const key = randomUUID();
          let finished = false;
          const pending = del(root.id, null, admin, key).then((r) => {
            finished = true;
            return r;
          });
          let observed = false;
          const limit = Date.now() + 5000;
          while (!finished && Date.now() < limit) {
            observed = (
              await f.pool.query<{ observed: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='PgSleep' AND query LIKE '%CONSTRAINTS%') observed",
              )
            ).rows[0]!.observed;
            if (observed) break;
            await sleep(10);
          }
          const r = await pending;
          assert.equal(
            observed,
            true,
            'Actual deferred wait must be observed after initial authority, never initial 404',
          );
          ok(r, 503);
          ok(await get(`/discussion-delete-requests/${key}`, admin), 404);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=$1',
                [root.id],
              )
            ).rowCount,
            0,
          );
        } finally {
          await f.pool.query(
            'DROP TRIGGER zz_delete_test_wait ON whaleu_majors.major_discussion_delete_commands;DROP FUNCTION whaleu_majors.delete_test_wait()',
          );
        }
      },
    );
    await t.test(
      'D/G: actual two-writer reply/positive-like vs root delete settle without a deadlock or hidden retry',
      async () => {
        const notices = f.app.get(MajorDiscussionNoticeOwner);
        const original = notices.capture.bind(notices);
        const deadlocks = async () =>
          (
            await f.pool.query<{ deadlocks: string }>(
              'SELECT deadlocks::text FROM pg_stat_database WHERE datname=current_database()',
            )
          ).rows[0]!.deadlocks;
        for (const kind of ['reply', 'like'] as const) {
          const root = await publish('two writer ' + kind),
            q =
              kind === 'reply'
                ? f.reply(catalog, w, 'racing descendant')
                : f.like(catalog, w);
          if (kind === 'reply')
            await reviewMajorDiscussion(
              f.pool,
              other.accountId,
              w.id,
              q as ReturnType<typeof f.reply>,
              root.id,
            );
          let entered!: () => void, release!: () => void;
          const atCapture = new Promise<void>((r) => {
              entered = r;
            }),
            resume = new Promise<void>((r) => {
              release = r;
            });
          notices.capture = async (...args) => {
            await original(...args);
            if (args[1] === q.clientRequestId) {
              entered();
              await resume;
            }
          };
          const before = await deadlocks();
          let pending: Promise<request.Response> | undefined,
            deleting: Promise<request.Response> | undefined;
          try {
            pending = post(
              `/${w.id}/discussion/${root.id}/${kind === 'reply' ? 'replies' : 'like'}`,
              q,
              other,
            ).then((r) => r);
            await Promise.race([
              atCapture,
              pending.then((r) =>
                assert.fail(
                  'Expected writer capture before response: ' +
                    JSON.stringify(r.body),
                ),
              ),
            ]);
            deleting = del(root.id).then((r) => r);
            await f.waitForLock(
              'INSERT INTO whaleu_majors.major_discussion_tombstones',
            );
            release();
            const [publication, deletion] = await Promise.all([
              pending,
              deleting,
            ]);
            ok(deletion);
            assert.equal(
              publication.status,
              503,
              JSON.stringify(publication.body),
            );
            assert.equal(
              await deadlocks(),
              before,
              'No policy lock upgrade cycle or implicit retry',
            );
            ok(
              await get(`/discussion-requests/${q.clientRequestId}`, other),
              404,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_majors.major_discussion_tombstones WHERE comment_id=$1',
                  [root.id],
                )
              ).rowCount,
              1,
            );
            ok(await get(`/${w.id}/discussion/${root.id}`), 404);
          } finally {
            release();
            await Promise.allSettled(
              [pending, deleting].filter(
                (p): p is Promise<request.Response> => p !== undefined,
              ),
            );
            notices.capture = original;
          }
        }
      },
    );
  },
);
