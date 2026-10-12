import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import type { PublishPost } from '../../src/community/contracts.js';

/** Synthetic real source, native publication, ordinary HTTP and PostgreSQL. */
test(
  'ordinary regional administration removes only one live post with private author notice and no owner or jury experience',
  { timeout: 240000 },
  async (t) => {
    const f = await adminPostRemovalFixture(true);
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor(),
      peer = await f.actor();
    await f.grant(admin);
    const get = (path: string, actor = peer) =>
      request(f.http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`);
    const patches: Partial<PublishPost>[] = [
      {},
      { authorMode: 'anonymous' },
      {
        category: 'trading',
        trading: {
          subtype: 'shuma',
          price: '12.50',
          urgency: 'urgent',
          location: 'Synthetic pickup',
          contacts: { wechat: 'synthetic', qq: '', phone: '' },
        },
      },
      {
        component: {
          kind: 'poll',
          question: 'Remove this synthetic poll?',
          selectionMode: 'single',
          options: ['First', 'Second'],
        },
      },
      {
        component: {
          kind: 'formation',
          capacity: 3,
          theme: 'Synthetic',
          contacts: { wechat: 'synthetic', qq: '', phone: '' },
          contactSharing: 'members_v1',
        },
      },
    ];
    const stable = async () =>
      (
        await f.pool.query(`SELECT jsonb_build_object(
    'profiles',(SELECT jsonb_agg(to_jsonb(p) ORDER BY account_id) FROM whaleu_profile.profiles p),
    'grants',(SELECT jsonb_agg(to_jsonb(g) ORDER BY id) FROM whaleu_authorization.role_grants g),
    'identity',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_identity.accounts a),
    'personas',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM whaleu_community.thread_personas p),
    'source',(SELECT jsonb_agg(to_jsonb(b) ORDER BY content_kind,content_id) FROM whaleu_community.content_approval_bindings b)) value`)
      ).rows[0]!.value;
    for (const [index, patch] of [...patches, {}].entries()) {
      const post = await f.publish(subject, patch, index === patches.length);
      const root = await f.child(peer, post.id),
        reply = await f.child(subject, post.id, root.id);
      const before = (
        await f.pool.query(
          'SELECT to_jsonb(p) value FROM whaleu_community.posts p WHERE id=$1',
          [post.id],
        )
      ).rows[0]!.value;
      const unchanged = await stable();
      const management = await f.removalManagement(post, admin);
      assert.deepEqual(Object.keys(management).sort(), [
        'canRemove',
        'target',
        'targetVersion',
      ]);
      assert.ok(!JSON.stringify(management).includes(subject.accountId));
      const body = f.removalCommand(post, management.targetVersion);
      const response = await f.removalSend(admin, body);
      profileOk(response);
      assert.equal(response.body.outcome, 'applied');
      const after = (
        await f.pool.query(
          'SELECT to_jsonb(p) value FROM whaleu_community.posts p WHERE id=$1',
          [post.id],
        )
      ).rows[0]!.value;
      assert.ok(after.deleted_at);
      assert.deepEqual(
        {
          ...after,
          deleted_at: before.deleted_at,
          local_deletion_transaction: before.local_deletion_transaction,
        },
        before,
      );
      assert.deepEqual(await stable(), unchanged);
      const totals = (
        await f.pool.query(
          `SELECT
      (SELECT count(*)::int FROM whaleu_community.admin_post_removal_events WHERE target_id=$1) events,
      (SELECT count(*)::int FROM whaleu_community.admin_post_removal_transitions WHERE target_id=$1) transitions,
      (SELECT count(*)::int FROM whaleu_community.media_cleanup_jobs WHERE resource_kind='post' AND resource_id=$1) jobs,
      (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='admin_post_removed') administrative,
      (SELECT count(*)::int FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type IN('post_deleted','moderation_removed')) counterfeit`,
          [post.id],
        )
      ).rows[0];
      assert.deepEqual(totals, {
        events: 1,
        transitions: 1,
        jobs: 1,
        administrative: 1,
        counterfeit: 0,
      });
      for (const path of [
        `/v1/community/posts/${post.id}`,
        `/v1/community/posts/${post.id}/comments`,
        `/v1/community/comments/${root.id}`,
        `/v1/community/replies/${reply.id}`,
      ]) {
        const denied = await get(path);
        assert.ok(
          denied.status >= 400,
          `${path}: ${JSON.stringify(denied.body)}`,
        );
      }
      assert.ok(
        (await request(f.http).get(`/v1/community/posts/${post.id}`)).status >=
          400,
      );
      const replay = await f.removalSend(admin, body);
      profileOk(replay);
      assert.deepEqual(replay.body, response.body);
      const cancel = await f.removalSend(admin, body, true);
      profileOk(cancel);
      assert.deepEqual(cancel.body, response.body);
      const conflict = await f.removalSend(admin, {
        ...body,
        expectedTargetVersion: 'a'.repeat(64),
      });
      assert.equal(conflict.status, 409);
      const history = await f.removalRecovery(admin, body.clientRequestId);
      profileOk(history);
      assert.deepEqual(history.body, {
        state: 'recorded',
        receipt: response.body,
      });
      const privateRecovery = await f.removalRecovery(
        peer,
        body.clientRequestId,
      );
      profileOk(privateRecovery);
      assert.deepEqual(privateRecovery.body, { state: 'not_recorded' });
      const notice = await get('/v1/me/system-notices', subject);
      profileOk(notice);
      assert.equal(notice.body.unreadCount, index + 1);
      const item = notice.body.items.find(
        (n: { createdAt: string }) => n.createdAt === response.body.recordedAt,
      );
      assert.ok(item);
      assert.equal(item.kind, 'admin_post_removed');
      assert.deepEqual(Object.keys(item).sort(), [
        'createdAt',
        'kind',
        'noticeId',
        'readAt',
      ]);
      assert.ok(!JSON.stringify(item).includes(post.id));
      assert.ok(!JSON.stringify(item).includes(subject.accountId));
    }
    const own = await f.publish(admin);
    const forbidden = await request(f.http)
      .get('/v1/community/admin-post-removal/management')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .query({ kind: own.kind, id: own.id });
    assert.equal(forbidden.body.error.code, 'ADMIN_POST_REMOVAL_OWN_POST');
    profileOk(
      await request(f.http)
        .delete(`/v1/community/posts/${own.id}`)
        .set('Authorization', `Bearer ${admin.accessToken}`),
      204,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='post_deleted'",
          [own.id],
        )
      ).rows[0]!.n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_community.admin_post_removal_events WHERE target_id=$1',
          [own.id],
        )
      ).rows[0]!.n,
      0,
    );
  },
);

test(
  'post removal admission is exact original region and current source; terminal requests need only the same active account and token',
  { timeout: 240000 },
  async (t) => {
    const f = await adminPostRemovalFixture();
    t.after(() => f.close());
    const subject = await f.actor(),
      admin = await f.actor(),
      superAdmin = await f.actor(),
      developer = await f.actor(),
      wrong = await f.actor(),
      unverified = await f.actor({ phone: 'unverified' }),
      labelOnly = await f.actor();
    const grant = await f.grant(admin);
    await f.grant(superAdmin, 'super_admin', null);
    await f.grant(developer, 'developer', null);
    await f.grant(wrong, 'school_admin', f.scope.foreign.regionId);
    await f.grant(unverified);
    const post = await f.publish(subject);
    const view = await f.removalManagement(post, admin);
    for (const actor of [developer, wrong, unverified, labelOnly]) {
      const body = f.removalCommand(post, view.targetVersion);
      const denied = await f.removalSend(actor, body);
      assert.notEqual(denied.status, 200, JSON.stringify(denied.body));
      assert.deepEqual(
        (await f.removalRecovery(actor, body.clientRequestId)).body,
        { state: 'not_recorded' },
      );
    }
    for (const extra of [
      { subjectAccountId: subject.accountId },
      { banUser: true },
      { reason: 'Free reason' },
      { target: { kind: 'comment', id: randomUUID() } },
    ])
      assert.equal(
        (
          await f.removalSend(admin, {
            ...f.removalCommand(post, view.targetVersion),
            ...extra,
          } as never)
        ).status,
        400,
      );
    const stale = await f.removalSend(
      admin,
      f.removalCommand(post, '0'.repeat(64)),
    );
    profileOk(stale);
    assert.equal(stale.body.code, 'ADMIN_POST_REMOVAL_STALE');
    const foreign = await f.publish(subject, {
      spaceId: f.scope.foreign.spaceId,
    });
    const wrongRegion = await f.removalSend(
      admin,
      f.removalCommand(foreign, '0'.repeat(64)),
    );
    assert.notEqual(wrongRegion.status, 200);
    await f.removalApply(foreign, superAdmin);
    const applied = await f.removalApply(post, admin);
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        [grant],
      ),
    );
    const replay = await f.removalSend(admin, applied.body);
    profileOk(replay);
    assert.deepEqual(replay.body, applied.receipt);
    const body = f.removalCommand(
      { kind: 'post', id: randomUUID() },
      '0'.repeat(64),
    );
    const cancelled = await f.removalSend(unverified, body, true);
    profileOk(cancelled);
    assert.equal(cancelled.body.code, 'ADMIN_POST_REMOVAL_CANCELLED');
    const late = await f.removalSend(unverified, body);
    profileOk(late);
    assert.deepEqual(late.body, cancelled.body);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_community.admin_post_removal_events',
        )
      ).rows[0]!.n,
      2,
    );
  },
);
