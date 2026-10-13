/** Four real causal notice writers on disposable PG and ordinary AppModule.
 * Narrow INSERT identity/decision-clock inputs create deterministic cross-table
 * collisions and a jury/avatar millisecond tie. All production guards remain. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import type { SystemNoticesPage } from '../../src/notifications/system-notices/contracts.js';
import { moderationManagementSchema } from '../../src/profile/moderation/contracts.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';

const ok = (response: { status: number; body: unknown }, status = 200) =>
  assert.equal(response.status, status, JSON.stringify(response.body));

test(
  'four-kind notices preserve causal collision rollback, tied pagination, old cursors and independent owner-only reads',
  { timeout: 180000 },
  async (t) => {
    const f = await adminPostRemovalFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      owner = await f.actor(),
      stranger = await f.actor();
    const grantId = await f.grant(admin);
    const selected = await f.custom(owner);
    const post = await f.publish(owner);
    const voters: (typeof owner)[] = [];
    for (let index = 0; index < 6; index++) voters.push(await f.actor());
    const nicknameId = '40000000-0000-4000-8000-000000000001',
      avatarId = '60000000-0000-4000-8000-000000000002',
      juryId = '80000000-0000-4000-8000-000000000003',
      adminId = '70000000-0000-4000-8000-000000000004';
    await f.pool.query(`
      CREATE TABLE whaleu_notifications.avatar_notice_test_inputs (
        recipient_account_id uuid PRIMARY KEY, nickname_id uuid NOT NULL,
        avatar_id uuid NOT NULL, jury_id uuid NOT NULL, admin_id uuid, decided_at timestamptz
      );
      CREATE FUNCTION whaleu_notifications.avatar_notice_test_identity() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE input whaleu_notifications.avatar_notice_test_inputs;
      BEGIN
        SELECT * INTO input FROM whaleu_notifications.avatar_notice_test_inputs WHERE recipient_account_id=NEW.recipient_account_id;
        IF FOUND THEN NEW.id:=CASE TG_TABLE_NAME
          WHEN 'system_notices' THEN input.jury_id
          WHEN 'profile_moderation_notices' THEN input.nickname_id
          WHEN 'profile_avatar_moderation_notices' THEN input.avatar_id
          WHEN 'admin_post_removal_notices' THEN input.admin_id END; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER synthetic_avatar_notice_identity BEFORE INSERT ON whaleu_notifications.system_notices
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.avatar_notice_test_identity();
      CREATE TRIGGER synthetic_avatar_notice_identity BEFORE INSERT ON whaleu_notifications.profile_moderation_notices
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.avatar_notice_test_identity();
      CREATE TRIGGER synthetic_avatar_notice_identity BEFORE INSERT ON whaleu_notifications.profile_avatar_moderation_notices
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.avatar_notice_test_identity();
      CREATE TRIGGER synthetic_avatar_notice_identity BEFORE INSERT ON whaleu_notifications.admin_post_removal_notices
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.avatar_notice_test_identity();
      CREATE FUNCTION whaleu_notifications.avatar_notice_test_clock() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE stamp timestamptz;
      BEGIN
        SELECT decided_at INTO stamp FROM whaleu_notifications.avatar_notice_test_inputs WHERE recipient_account_id=NEW.owner_account_id;
        IF stamp IS NOT NULL THEN NEW.decided_at:=stamp; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER synthetic_avatar_notice_clock BEFORE INSERT ON whaleu_safety.report_decisions
        FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.avatar_notice_test_clock();
    `);
    await f.pool.query(
      'INSERT INTO whaleu_notifications.avatar_notice_test_inputs(recipient_account_id,nickname_id,avatar_id,jury_id) VALUES($1,$2,$2,$3)',
      [owner.accountId, nicknameId, avatarId],
    );
    const get = (path: string, actor = owner) =>
      request(f.http)
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
      (SELECT count(*)::integer FROM whaleu_notifications.profile_moderation_notices) nickname,
      (SELECT count(*)::integer FROM whaleu_notifications.profile_avatar_moderation_notices) avatar,
      (SELECT count(*)::integer FROM whaleu_notifications.system_notices) jury,
      (SELECT count(*)::integer FROM whaleu_notifications.admin_post_removal_notices) admin,
      (SELECT count(*)::integer FROM whaleu_notifications.system_notice_ids) registry`)
      ).rows[0];
    const nicknameView = await get(
      '/v1/community/profile-moderation/management',
      admin,
    ).query({ kind: post.kind, id: post.id });
    ok(nicknameView);
    const nicknameCommand = {
      clientRequestId: randomUUID(),
      target: { kind: post.kind, id: post.id },
      action: 'reset_nickname',
      expectedProfileRevision: moderationManagementSchema.parse(
        nicknameView.body,
      ).revision,
    };
    const reset = () =>
      request(f.http)
        .post('/v1/community/profile-moderation/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(nicknameCommand);
    const nicknameApplied = await reset();
    ok(nicknameApplied);
    assert.equal(nicknameApplied.body.outcome, 'applied');
    const nicknamePage = await list();
    assert.equal(nicknamePage.items[0]!.noticeId, nicknameId);
    const view = await f.management({ kind: post.kind, id: post.id }, admin);
    assert.equal(view.expectedAppearanceId, selected.appearanceId);
    const command = f.command(
      { kind: post.kind, id: post.id },
      view.revision,
      selected.appearanceId,
    );
    await t.test(
      'a real avatar notice colliding with a nickname rolls back the entire clear',
      async () => {
        const before = (
          await f.pool.query(
            `SELECT p.revision,c.appearance_id,b.detached_at
        FROM whaleu_profile.profiles p JOIN whaleu_profile.avatar_current c ON c.actor_id=p.account_id
        JOIN whaleu_media.bindings b ON b.resource_id=c.appearance_id
        WHERE p.account_id=$1`,
            [owner.accountId],
          )
        ).rows;
        assert.equal(before.length, 1);
        const failed = await f.send(admin, command);
        assert.ok(failed.status >= 400, JSON.stringify(failed.body));
        assert.deepEqual(await counts(), {
          nickname: 1,
          avatar: 0,
          jury: 0,
          admin: 0,
          registry: 1,
        });
        assert.deepEqual(
          (
            await f.pool.query(
              `SELECT p.revision,c.appearance_id,b.detached_at
        FROM whaleu_profile.profiles p JOIN whaleu_profile.avatar_current c ON c.actor_id=p.account_id
        JOIN whaleu_media.bindings b ON b.resource_id=c.appearance_id
        WHERE p.account_id=$1`,
              [owner.accountId],
            )
          ).rows,
          before,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::integer count FROM whaleu_profile.avatar_moderation_commands WHERE actor_id=$1 AND request_id=$2',
              [admin.accountId, command.clientRequestId],
            )
          ).rows[0].count,
          0,
        );
      },
    );
    await f.pool.query(
      'UPDATE whaleu_notifications.avatar_notice_test_inputs SET avatar_id=$2 WHERE recipient_account_id=$1',
      [owner.accountId, avatarId],
    );
    const avatarApplied = await f.send(admin, command);
    ok(avatarApplied);
    assert.equal(avatarApplied.body.outcome, 'applied');
    const pair = await list();
    const cleared = pair.items.find(
      (item) => item.kind === 'profile_custom_avatar_cleared',
    );
    assert.deepEqual(cleared, {
      noticeId: avatarId,
      kind: 'profile_custom_avatar_cleared',
      createdAt: avatarApplied.body.recordedAt,
      readAt: null,
    });
    const removalPost = await f.publish(owner, { authorMode: 'anonymous' });
    const removalView = await f.removalManagement(removalPost, admin);
    const removalBody = f.removalCommand(
      removalPost,
      removalView.targetVersion,
    );
    await f.pool.query(
      'UPDATE whaleu_notifications.avatar_notice_test_inputs SET admin_id=$2 WHERE recipient_account_id=$1',
      [owner.accountId, avatarId],
    );
    await t.test(
      'administrative notice UUID collision rolls back tombstone, cleanup, event and original-key receipt',
      async () => {
        const failed = await f.removalSend(admin, removalBody);
        assert.ok(failed.status >= 400, JSON.stringify(failed.body));
        assert.equal(
          (
            await f.pool.query(
              'SELECT deleted_at FROM whaleu_community.posts WHERE id=$1',
              [removalPost.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.admin_post_removal_commands',
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_community.media_cleanup_jobs WHERE resource_id=$1',
              [removalPost.id],
            )
          ).rows[0]!.n,
          0,
        );
      },
    );
    await f.pool.query(
      'UPDATE whaleu_notifications.avatar_notice_test_inputs SET admin_id=$2 WHERE recipient_account_id=$1',
      [owner.accountId, adminId],
    );
    const removalApplied = await f.removalSend(admin, removalBody);
    ok(removalApplied);
    assert.equal(removalApplied.body.outcome, 'applied');
    await f.pool.query(
      'UPDATE whaleu_notifications.avatar_notice_test_inputs SET decided_at=$2 WHERE recipient_account_id=$1',
      [owner.accountId, removalApplied.body.recordedAt],
    );

    const reported = await request(f.http)
      .post('/v1/me/safety/reports')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        clientRequestId: randomUUID(),
        target: { kind: post.kind, id: post.id },
      });
    ok(reported);
    assert.equal(reported.body.outcome, 'accepted');
    const jury = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_safety.post_juries WHERE post_id=$1',
        [post.id],
      )
    ).rows[0]!;
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
      request(f.http)
        .post('/v1/me/safety/jury-votes')
        .set('Authorization', `Bearer ${voters[index]!.accessToken}`)
        .send(body);
    for (let index = 0; index < 5; index++) {
      const response = await vote(index);
      ok(response);
      assert.equal(response.body.outcome, 'accepted');
    }
    await t.test(
      'a real jury notice colliding with an avatar cannot commit its source decision',
      async () => {
        const failed = await vote(5, ballot);
        assert.ok(failed.status >= 400, JSON.stringify(failed.body));
        assert.deepEqual(await counts(), {
          nickname: 1,
          avatar: 1,
          jury: 0,
          admin: 1,
          registry: 3,
        });
        const state = (
          await f.pool.query(
            `SELECT j.state,
        (SELECT count(*)::integer FROM whaleu_safety.jury_ballots WHERE jury_id=j.id) ballots,
        (SELECT count(*)::integer FROM whaleu_safety.report_decisions WHERE case_id=j.case_id) decisions,
        (SELECT deleted_at IS NULL FROM whaleu_community.posts WHERE id=j.post_id) live
        FROM whaleu_safety.post_juries j WHERE j.id=$1`,
            [jury.id],
          )
        ).rows[0];
        assert.deepEqual(state, {
          state: 'pending',
          ballots: 5,
          decisions: 0,
          live: true,
        });
      },
    );
    await f.pool.query(
      'UPDATE whaleu_notifications.avatar_notice_test_inputs SET jury_id=$2 WHERE recipient_account_id=$1',
      [owner.accountId, juryId],
    );
    const settled = await vote(5, ballot);
    ok(settled);
    assert.equal(settled.body.outcome, 'accepted');
    const full = await list();
    assert.deepEqual(
      full.items.map((item) => item.noticeId),
      [juryId, adminId, avatarId, nicknameId],
    );
    assert.equal(full.items[0]!.createdAt, removalApplied.body.recordedAt);
    assert.equal(full.items[1]!.createdAt, removalApplied.body.recordedAt);
    assert.equal(full.unreadCount, 4);

    await t.test(
      'tied pages are complete and independently constructed old cursors keep exact boundaries',
      async () => {
        const first = await list({ limit: 1 });
        assert.ok(first.nextCursor);
        const second = await list({ limit: 1, cursor: first.nextCursor });
        assert.ok(second.nextCursor);
        const third = await list({ limit: 1, cursor: second.nextCursor });
        assert.ok(third.nextCursor);
        const fourth = await list({ limit: 1, cursor: third.nextCursor });
        assert.equal(fourth.nextCursor, null);
        assert.deepEqual(
          [...first.items, ...second.items, ...third.items, ...fourth.items],
          full.items,
        );
        assert.equal(
          JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString()).v,
          5,
        );
        const scope = `system-notices:${createHash('sha256')
          .update(
            JSON.stringify([
              'system-notices-cursor-v1',
              owner.accountId.toLowerCase(),
            ]),
          )
          .digest('hex')}`;
        for (const v of [1, 2, 3, 4]) {
          const cursor = Buffer.from(
            JSON.stringify({
              v,
              scope,
              limit: 1,
              at: removalApplied.body.recordedAt,
              id: juryId,
              ...(v >= 2 ? { kind: 'post_jury_removed' } : {}),
            }),
          ).toString('base64url');
          assert.deepEqual(await list({ limit: 1, cursor }), second);
          ok(
            await get('/v1/me/system-notices', stranger).query({
              limit: 1,
              cursor,
            }),
            400,
          );
          ok(
            await get('/v1/me/system-notices').query({ limit: 2, cursor }),
            400,
          );
        }
        const nicknameCursor = Buffer.from(
          JSON.stringify({
            v: 2,
            scope,
            limit: 1,
            at: nicknamePage.items[0]!.createdAt,
            id: nicknameId,
            kind: 'profile_nickname_reset',
          }),
        ).toString('base64url');
        assert.deepEqual(await list({ limit: 1, cursor: nicknameCursor }), {
          items: [],
          nextCursor: null,
          unreadCount: 4,
        });
        for (const value of [
          owner.accountId,
          admin.accountId,
          post.id,
          selected.appearanceId,
          selected.body.source.assetId,
          avatarApplied.body.eventId,
          nicknameApplied.body.eventId,
          post.input.text,
        ])
          assert.equal(JSON.stringify(full).includes(value), false);
      },
    );

    await t.test(
      'source deletion and grant revocation cannot hide historical notices or add replay unread entries',
      async () => {
        const gone = await get(`/v1/community/posts/${post.id}`);
        assert.ok(gone.status >= 400);
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
            [grantId, admin.accountId],
          ),
        );
        assert.deepEqual(await list(), full);
        const avatarReplay = await f.send(admin, command),
          nicknameReplay = await reset();
        ok(avatarReplay);
        ok(nicknameReplay);
        assert.deepEqual(avatarReplay.body, avatarApplied.body);
        assert.deepEqual(nicknameReplay.body, nicknameApplied.body);
        const removalReplay = await f.removalSend(admin, removalBody);
        ok(removalReplay);
        assert.deepEqual(removalReplay.body, removalApplied.body);
        assert.deepEqual(await counts(), {
          nickname: 1,
          avatar: 1,
          jury: 1,
          admin: 1,
          registry: 4,
        });
        assert.deepEqual(await list(), full);
        await assert.rejects(
          f.pool.query(
            "INSERT INTO whaleu_notifications.system_notice_ids(id,kind,recipient_account_id) VALUES($1,'profile_custom_avatar_cleared',$2)",
            [juryId, owner.accountId],
          ),
          { code: '23505' },
        );
        for (const table of [
          'system_notices',
          'profile_moderation_notices',
          'profile_avatar_moderation_notices',
          'admin_post_removal_notices',
          'system_notice_ids',
        ])
          await assert.rejects(
            f.pool.query(`TRUNCATE whaleu_notifications.${table}`),
          );
      },
    );

    await t.test(
      'all four exact owned reads keep their first timestamps and strangers cannot change counts',
      async () => {
        const read = (id: string, actor = owner) =>
          request(f.http)
            .put(`/v1/me/system-notices/${id}/read`)
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .send({});
        for (const id of [juryId, adminId, avatarId, nicknameId])
          ok(await read(id, stranger), 404);
        const outsiderCount = await get(
          '/v1/me/system-notices/unread-count',
          stranger,
        );
        ok(outsiderCount);
        assert.deepEqual(outsiderCount.body, { unreadCount: 0 });
        assert.equal((await list()).unreadCount, 4);
        for (const [index, id] of [
          juryId,
          adminId,
          avatarId,
          nicknameId,
        ].entries()) {
          const first = await read(id),
            again = await read(id);
          ok(first);
          ok(again);
          assert.deepEqual(again.body, first.body);
          assert.equal(first.body.noticeId, id);
          assert.equal(first.body.unreadCount, 3 - index);
          assert.equal(typeof first.body.readAt, 'string');
        }
        const page = await list();
        assert.equal(page.items.length, 4);
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
