import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { schoolAdminManagementFixture } from '../support/school-admin-management-fixture.js';
import { announcementMediaContent } from '../support/media/announcement-runtime-fixture.js';
import { errandRuntimeFixture } from '../support/errand-runtime-fixture.js';
import { schoolAdminControl } from '../support/school-admin-command-harness.js';
const ok = (r: { status: number; body: unknown }) =>
  assert.equal(r.status, 200, JSON.stringify(r.body));

test(
  'API-issued fixed school authority really publishes school configuration, posting policy and announcements, then loses old-scope and revoked writes',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const superActor = await f.actor(),
      admin = await f.actor();
    await f.grant(superActor);
    const post = (path: string, body: object) =>
      request(f.http)
        .post(path)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(body);
    await f.apply(
      superActor,
      admin.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    const entry = (revision: number) => ({
      clientRequestId: randomUUID(),
      expectedRevision: revision,
      entry: {
        kind: 'official_account',
        enabled: true,
        name: 'Synthetic school account',
        description: 'New issued authority',
      },
      qrcode: { action: 'keep' },
    });
    const policy = (revision: number) => ({
      clientRequestId: randomUUID(),
      expectedRevision: revision,
      policy: {
        unverifiedPostEnabled: true,
        unverifiedCommentEnabled: false,
        unverifiedCategories: ['discussion'],
        expiry: { kind: 'policy_exempt' },
      },
    });
    const oldConfig = await post(
      `/v1/me/school-configuration/${f.scope.home.regionId}/entries/official_account`,
      entry(0),
    );
    ok(oldConfig);
    const oldPolicy = await post(
      `/v1/me/school-posting-policy/${f.scope.home.regionId}`,
      policy(0),
    );
    ok(oldPolicy);
    const oldAnnouncement = randomUUID();
    const create = () => ({
      action: 'create',
      clientRequestId: randomUUID(),
      expectedRevision: 0,
      content: announcementMediaContent,
      audience: { kind: 'fixed' },
    });
    ok(
      await post(
        `/v1/announcement-management/${oldAnnouncement}/commands`,
        create(),
      ),
    );
    ok(
      await post(`/v1/announcement-management/${oldAnnouncement}/commands`, {
        action: 'publish',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      }),
    );
    const pendingConfig = entry(1),
      pendingPolicy = policy(1),
      pendingAnnouncement = {
        action: 'set_enabled',
        enabled: false,
        clientRequestId: randomUUID(),
        expectedRevision: 2,
      };
    await f.apply(
      superActor,
      admin.profileId,
      'reassign',
      f.scope.related.regionId,
    );
    for (const [path, body] of [
      [
        `/v1/me/school-configuration/${f.scope.home.regionId}/entries/official_account`,
        pendingConfig,
      ],
      [`/v1/me/school-posting-policy/${f.scope.home.regionId}`, pendingPolicy],
      [
        `/v1/announcement-management/${oldAnnouncement}/commands`,
        pendingAnnouncement,
      ],
    ] as const) {
      const denied = await post(path, body);
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
    }
    ok(
      await post(
        `/v1/me/school-configuration/${f.scope.related.regionId}/entries/official_account`,
        entry(0),
      ),
    );
    ok(
      await post(
        `/v1/me/school-posting-policy/${f.scope.related.regionId}`,
        policy(0),
      ),
    );
    const newAnnouncement = randomUUID();
    ok(
      await post(
        `/v1/announcement-management/${newAnnouncement}/commands`,
        create(),
      ),
    );
    await f.apply(superActor, admin.profileId, 'revoke');
    for (const [path, body] of [
      [
        `/v1/me/school-configuration/${f.scope.related.regionId}/entries/official_account`,
        entry(1),
      ],
      [`/v1/me/school-posting-policy/${f.scope.related.regionId}`, policy(1)],
      [
        `/v1/announcement-management/${newAnnouncement}/commands`,
        {
          action: 'publish',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
        },
      ],
    ] as const) {
      const denied = await post(path, body);
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
    }
    const visible = await request(f.http)
      .get(`/v1/native-announcements/${oldAnnouncement}`)
      .query({ campusId: f.scope.home.campusId });
    ok(visible);
    const policyRows = (
      await f.pool.query(
        'SELECT region_id,revision FROM whaleu_community.region_policy_heads ORDER BY region_id',
      )
    ).rows;
    assert.equal(policyRows.filter((r) => r.revision === 1).length, 2);
  },
);

test(
  'API-appointed errand manager executes scoped deletion; old-scope and revoked commands fail while committed deletion history remains',
  { timeout: 180000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    t.after(() => f.close());
    const superActor = await f.actor(),
      admin = await f.actor(),
      publisher = await f.actor();
    const control = await schoolAdminControl(f, superActor, admin);
    await control.change('appoint', f.scope.home.regionId);
    const remove = (order: { id: string; revision: string }) =>
      request(f.http)
        .post(`/v1/admin/errands/${order.id}/delete`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          clientRequestId: randomUUID(),
          expectedRevision: order.revision,
          deleteReason: 'Synthetic scoped cleanup',
        });
    const first = await f.publish(publisher),
      oldPending = await f.publish(publisher);
    const removed = await remove(first);
    ok(removed);
    assert.equal(removed.body.outcome, 'applied');
    await control.change('reassign', f.scope.related.regionId);
    const denied = await remove(oldPending);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    const related = await f.publish(
        publisher,
        f.body(f.scope.related.regionId),
      ),
      later = await f.publish(publisher, f.body(f.scope.related.regionId));
    const newResult = await remove(related);
    ok(newResult);
    assert.equal(newResult.body.outcome, 'applied');
    await control.change('revoke');
    assert.equal((await remove(later)).status, 403);
    const rows = (
      await f.pool.query(
        'SELECT id,deleted_at FROM whaleu_errands.orders WHERE id=ANY($1::uuid[])',
        [[first.id, oldPending.id, related.id, later.id]],
      )
    ).rows;
    assert.ok(rows.find((r) => r.id === first.id)?.deleted_at);
    assert.ok(rows.find((r) => r.id === related.id)?.deleted_at);
    assert.equal(rows.find((r) => r.id === oldPending.id)?.deleted_at, null);
    assert.equal(rows.find((r) => r.id === later.id)?.deleted_at, null);
  },
);

test(
  'HTTP-issued publisher authority protects an errand restriction target; revocation admits a fresh command without changing the prior rejected receipt',
  { timeout: 180000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    t.after(() => f.close());
    const superActor = await f.actor(),
      manager = await f.actor(),
      publisher = await f.actor();
    const managerControl = await schoolAdminControl(f, superActor, manager);
    await managerControl.change('appoint', f.scope.home.regionId);
    // A separate super actor avoids inserting the helper's global grant twice.
    const publisherControl = await schoolAdminControl(
      f,
      await f.actor(),
      publisher,
    );
    const appointed = await publisherControl.change(
      'appoint',
      f.scope.related.regionId,
    );
    assert.equal(appointed.outcome, 'applied');
    const order = await f.publish(publisher);
    const original = {
      clientRequestId: randomUUID(),
      expectedRevision: order.revision,
      deleteReason: 'Synthetic protected-target transition',
      publisherRestriction: { kind: 'finite', unit: 'days', value: 7 },
    };
    const send = (body: typeof original) =>
      request(f.http)
        .post(`/v1/admin/errands/${order.id}/delete`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send(body);
    const state = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
      'order',(SELECT to_jsonb(o) FROM whaleu_errands.orders o WHERE id=$1),
      'events',(SELECT count(*) FROM whaleu_errands.admin_events WHERE order_id=$1),
      'restrictions',(SELECT count(*) FROM whaleu_safety.errand_restriction_definitions),
      'restrictionEvents',(SELECT count(*) FROM whaleu_safety.errand_restriction_events),
      'orderNotices',(SELECT count(*) FROM whaleu_notifications.errand_notices WHERE order_id=$1),
      'featureNotices',(SELECT count(*) FROM whaleu_notifications.errand_feature_notices)) value`,
          [order.id],
        )
      ).rows[0]!.value;
    const before = await state(),
      denied = await send(original);
    ok(denied);
    assert.equal(denied.body.outcome, 'rejected');
    assert.equal(denied.body.code, 'ERRAND_RESTRICTION_TARGET_PROTECTED');
    assert.deepEqual(await state(), before);
    await publisherControl.change('revoke');
    const replay = await send(original);
    ok(replay);
    assert.deepEqual(replay.body, denied.body);
    assert.deepEqual(await state(), before);
    const applied = await send({ ...original, clientRequestId: randomUUID() });
    ok(applied);
    assert.equal(applied.body.outcome, 'applied');
    const after = await state();
    assert.ok(after.order.deleted_at);
    assert.equal(after.events, 1);
    assert.equal(after.restrictions, 1);
    assert.equal(after.restrictionEvents, 1);
    assert.equal(after.orderNotices, 1);
    assert.equal(after.featureNotices, 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='role_admin'",
          [publisher.accountId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_authorization.role_grants WHERE account_id=$1 AND role='school_admin' AND revoked_at IS NULL",
          [manager.accountId],
        )
      ).rowCount,
      1,
    );
  },
);
