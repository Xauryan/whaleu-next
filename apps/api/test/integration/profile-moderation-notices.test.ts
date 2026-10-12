/** Ordinary AppModule, real Review and both real causal writers on disposable PG.
 * Narrow test-only INSERT inputs make timestamp ties and UUID collisions exact;
 * no production trigger, source proof or settlement guard is disabled. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { DatabaseService } from '../../src/database/database.js';
import { SystemNoticesService } from '../../src/notifications/system-notices/service.js';
import type { SystemNoticesPage } from '../../src/notifications/system-notices/contracts.js';
import { moderationManagementSchema } from '../../src/profile/moderation/contracts.js';
import { profileModerationFixture } from '../support/profile-moderation-fixture.js';

const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));

test(
  'mixed jury and nickname notices keep exact tied pagination, legacy cursors, collision closure and independent owner delivery',
  { timeout: 180000 },
  async (t) => {
    const f = await profileModerationFixture();
    t.after(() => f.close());
    const http = f.app.getHttpServer();
    const admin = await f.actor(),
      owner = await f.actor(),
      stranger = await f.actor();
    await f.grant(admin.accountId, 'school_admin', f.scope.home.regionId);
    const voters: (typeof owner)[] = [];
    for (let index = 0; index < 6; index++) voters.push(await f.actor());
    const post = await f.publish(owner);
    const profileId = '40000000-0000-4000-8000-000000000001',
      juryId = '80000000-0000-4000-8000-000000000002';
    await f.pool.query(`
      CREATE TABLE whaleu_notifications.system_notice_test_inputs (
        recipient_account_id uuid PRIMARY KEY, profile_id uuid NOT NULL,
        jury_id uuid NOT NULL, decided_at timestamptz
      );
      CREATE FUNCTION whaleu_notifications.system_notice_test_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE input whaleu_notifications.system_notice_test_inputs;
      BEGIN
        SELECT * INTO input FROM whaleu_notifications.system_notice_test_inputs WHERE recipient_account_id=NEW.recipient_account_id;
        IF FOUND THEN NEW.id:=CASE WHEN TG_TABLE_NAME='system_notices' THEN input.jury_id ELSE input.profile_id END; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER synthetic_notice_identity BEFORE INSERT ON whaleu_notifications.system_notices
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.system_notice_test_identity();
      CREATE TRIGGER synthetic_notice_identity BEFORE INSERT ON whaleu_notifications.profile_moderation_notices
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.system_notice_test_identity();
      CREATE FUNCTION whaleu_notifications.system_notice_test_clock() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE stamp timestamptz;
      BEGIN
        SELECT decided_at INTO stamp FROM whaleu_notifications.system_notice_test_inputs WHERE recipient_account_id=NEW.owner_account_id;
        IF stamp IS NOT NULL THEN NEW.decided_at:=stamp; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER synthetic_notice_clock BEFORE INSERT ON whaleu_safety.report_decisions
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.system_notice_test_clock();
    `);
    // Start the jury source with the existing profile UUID deliberately.
    await f.pool.query(
      'INSERT INTO whaleu_notifications.system_notice_test_inputs(recipient_account_id,profile_id,jury_id) VALUES($1,$2,$2)',
      [owner.accountId, profileId],
    );
    const get = (path: string, actor = owner) =>
      request(http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const list = async (
      query: { limit?: number; cursor?: string } = {},
      actor = owner,
    ) => {
      const response = await get('/v1/me/system-notices', actor).query(query);
      ok(response);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(String(response.headers['vary']), /Authorization/i);
      return response.body as SystemNoticesPage;
    };
    const counts = async () =>
      (
        await f.pool.query(`SELECT
          (SELECT count(*)::integer FROM whaleu_notifications.profile_moderation_notices) profile,
          (SELECT count(*)::integer FROM whaleu_notifications.system_notices) jury,
          (SELECT count(*)::integer FROM whaleu_notifications.system_notice_ids) registry`)
      ).rows[0];
    const management = await get(
      '/v1/community/profile-moderation/management',
      admin,
    ).query({ kind: 'post', id: post.id });
    ok(management);
    const command = {
      clientRequestId: randomUUID(),
      target: { kind: 'post', id: post.id },
      action: 'reset_nickname',
      expectedProfileRevision: moderationManagementSchema.parse(management.body)
        .revision,
    };
    const reset = () =>
      request(http)
        .post('/v1/community/profile-moderation/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(command);
    const applied = await reset();
    ok(applied);
    assert.equal(applied.body.outcome, 'applied');
    const single = await list();
    assert.equal(single.items.length, 1);
    assert.equal(single.items[0]!.noticeId, profileId);
    assert.equal(single.unreadCount, 1);
    await f.pool.query(
      'UPDATE whaleu_notifications.system_notice_test_inputs SET decided_at=$2 WHERE recipient_account_id=$1',
      [owner.accountId, single.items[0]!.createdAt],
    );
    assert.deepEqual(await counts(), { profile: 1, jury: 0, registry: 1 });

    await t.test(
      'nickname notice remains private and unread while its source is owner-hidden',
      async () => {
        const hidden = async (ownerHidden: boolean) => {
          const state = await get(
            `/v1/me/community/posts/${post.id}/owner-visibility`,
          );
          ok(state);
          const response = await request(http)
            .post('/v1/me/community/owner-visibility-commands')
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              postId: post.id,
              ownerHidden,
              expectedVersion: state.body.version,
            });
          ok(response);
          assert.equal(response.body.outcome, 'applied');
        };
        await hidden(true);
        const unavailable = await get(`/v1/community/posts/${post.id}`, admin);
        assert.ok(unavailable.status >= 400, JSON.stringify(unavailable.body));
        assert.deepEqual(await list(), single);
        assert.deepEqual(await list({}, stranger), {
          items: [],
          nextCursor: null,
          unreadCount: 0,
        });
        await hidden(false);
      },
    );

    const reported = await request(http)
      .post('/v1/me/safety/reports')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        clientRequestId: randomUUID(),
        target: { kind: 'post', id: post.id },
      });
    ok(reported);
    assert.equal(reported.body.outcome, 'accepted');
    const jury = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_safety.post_juries WHERE post_id=$1',
        [post.id],
      )
    ).rows[0]!;
    assert.ok(jury);
    const ballot = {
      clientRequestId: randomUUID(),
      postId: post.id,
      juryId: jury.id,
      vote: 'remove',
    };
    const vote = (
      index: number,
      body = { ...ballot, clientRequestId: randomUUID() },
    ) =>
      request(http)
        .post('/v1/me/safety/jury-votes')
        .set('Authorization', `Bearer ${voters[index]!.accessToken}`)
        .send(body);
    for (let index = 0; index < 5; index++) {
      const response = await vote(index);
      ok(response);
      assert.equal(response.body.outcome, 'accepted');
    }
    await t.test(
      'a real colliding jury source rolls back its sixth ballot, decision and removal',
      async () => {
        const response = await vote(5, ballot);
        assert.ok(response.status >= 400, JSON.stringify(response.body));
        assert.deepEqual(await counts(), { profile: 1, jury: 0, registry: 1 });
        const state = (
          await f.pool.query(
            `SELECT j.state,
          (SELECT count(*)::integer FROM whaleu_safety.jury_ballots WHERE jury_id=j.id) ballots,
          (SELECT count(*)::integer FROM whaleu_safety.report_decisions WHERE case_id=j.case_id) decisions,
          (SELECT count(*)::integer FROM whaleu_safety.report_requests WHERE account_id=$2 AND client_request_id=$3) requests,
          (SELECT deleted_at IS NULL FROM whaleu_community.posts WHERE id=j.post_id) live
          FROM whaleu_safety.post_juries j WHERE j.id=$1`,
            [jury.id, voters[5]!.accountId, ballot.clientRequestId],
          )
        ).rows[0];
        assert.deepEqual(state, {
          state: 'pending',
          ballots: 5,
          decisions: 0,
          requests: 0,
          live: true,
        });
        assert.deepEqual(await list(), single);
      },
    );
    await f.pool.query(
      'UPDATE whaleu_notifications.system_notice_test_inputs SET jury_id=$2 WHERE recipient_account_id=$1',
      [owner.accountId, juryId],
    );
    const settled = await vote(5, ballot);
    ok(settled);
    assert.equal(settled.body.outcome, 'accepted');
    assert.deepEqual(await counts(), { profile: 1, jury: 1, registry: 2 });

    await t.test(
      'equal-time mixed pages and independently constructed v1 cursors keep one total order',
      async () => {
        const first = await list({ limit: 1 });
        assert.deepEqual(first.items, [
          {
            noticeId: juryId,
            kind: 'post_jury_removed',
            createdAt: single.items[0]!.createdAt,
            readAt: null,
            keepVotes: 0,
            removeVotes: 6,
          },
        ]);
        assert.equal(first.unreadCount, 2);
        assert.ok(first.nextCursor);
        const decoded = JSON.parse(
          Buffer.from(first.nextCursor, 'base64url').toString(),
        );
        assert.equal(decoded.v, 2);
        assert.equal(decoded.kind, 'post_jury_removed');
        const second = await list({ limit: 1, cursor: first.nextCursor });
        assert.deepEqual(second, {
          items: single.items,
          nextCursor: null,
          unreadCount: 2,
        });
        const legacy = Buffer.from(
          JSON.stringify({
            v: 1,
            scope: `system-notices:${createHash('sha256')
              .update(
                JSON.stringify([
                  'system-notices-cursor-v1',
                  owner.accountId.toLowerCase(),
                ]),
              )
              .digest('hex')}`,
            limit: 1,
            at: single.items[0]!.createdAt,
            id: juryId,
          }),
        ).toString('base64url');
        assert.deepEqual(await list({ limit: 1, cursor: legacy }), second);
        ok(
          await get('/v1/me/system-notices', stranger).query({
            limit: 1,
            cursor: legacy,
          }),
          400,
        );
        ok(
          await get('/v1/me/system-notices').query({
            limit: 2,
            cursor: legacy,
          }),
          400,
        );
        const all = await list();
        assert.deepEqual(all.items, [...first.items, ...second.items]);
        assert.equal(all.nextCursor, null);
        assert.equal(all.unreadCount, 2);
        for (const value of [
          owner.accountId,
          admin.accountId,
          post.id,
          applied.body.eventId,
          post.input.text,
        ])
          assert.equal(JSON.stringify(all).includes(value), false);
      },
    );

    await t.test(
      'deleted source and exact writer replays retain both notices without duplicate registry or unread entries',
      async () => {
        const gone = await get(`/v1/community/posts/${post.id}`);
        assert.ok(gone.status >= 400, JSON.stringify(gone.body));
        const again = await reset();
        ok(again);
        assert.deepEqual(again.body, applied.body);
        const ballotAgain = await vote(5, ballot);
        ok(ballotAgain);
        assert.deepEqual(ballotAgain.body, settled.body);
        const decision = (
          await f.pool.query<{ decision_id: string; created_at: Date }>(
            'SELECT decision_id,created_at FROM whaleu_notifications.system_notices WHERE id=$1',
            [juryId],
          )
        ).rows[0]!;
        await f.app.get(DatabaseService).transaction((tx) =>
          f.app.get(SystemNoticesService).appendPostJuryRemoval(
            {
              decisionId: decision.decision_id,
              ownerAccountId: owner.accountId,
              keepVotes: 0,
              removeVotes: 6,
              occurredAt: decision.created_at,
            },
            tx,
          ),
        );
        assert.deepEqual(await counts(), { profile: 1, jury: 1, registry: 2 });
        const page = await list();
        assert.deepEqual(
          page.items.map((item) => item.noticeId),
          [juryId, profileId],
        );
        assert.equal(page.unreadCount, 2);
        for (const table of [
          'system_notices',
          'profile_moderation_notices',
          'system_notice_ids',
        ])
          await assert.rejects(
            f.pool.query(`TRUNCATE whaleu_notifications.${table}`),
          );
        assert.deepEqual(await counts(), { profile: 1, jury: 1, registry: 2 });
      },
    );

    await t.test(
      'owner UUID reads route each kind once and preserve first read timestamps',
      async () => {
        const read = (id: string, actor = owner) =>
          request(http)
            .put(`/v1/me/system-notices/${id}/read`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send({});
        for (const id of [juryId, profileId]) ok(await read(id, stranger), 404);
        assert.equal((await list()).unreadCount, 2);
        for (const [index, id] of [juryId, profileId].entries()) {
          const first = await read(id),
            again = await read(id);
          ok(first);
          ok(again);
          assert.deepEqual(again.body, first.body);
          assert.equal(first.body.noticeId, id);
          assert.equal(first.body.unreadCount, 1 - index);
          assert.equal(typeof first.body.readAt, 'string');
        }
        const page = await list();
        assert.equal(page.items.length, 2);
        assert.ok(page.items.every((item) => item.readAt !== null));
        assert.equal(page.unreadCount, 0);
        const count = await get('/v1/me/system-notices/unread-count');
        ok(count);
        assert.deepEqual(count.body, { unreadCount: 0 });
        assert.deepEqual(await list({}, stranger), {
          items: [],
          nextCursor: null,
          unreadCount: 0,
        });
      },
    );
  },
);
