import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { schoolAdminManagementFixture } from '../support/school-admin-management-fixture.js';
import { DatabaseService } from '../../src/database/database.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { PostPinAuthorityFacade } from '../../src/authorization/post-pin-authority.facade.js';
import { RatingAuthorizationFacade } from '../../src/authorization/rating-grants.facade.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import type {
  SchoolAdminFixture,
  SchoolAdminActor,
} from '../support/school-admin-management-fixture.js';
import type { MaintenanceIntent } from '../../src/experience/maintenance.contracts.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import { establishSyntheticExperienceBaseline } from '../support/experience-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { hold, release } from '../support/title-maintenance-fixture.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';

test(
  'new grants are consumed only in their current fixed region and retained title never restores authority after revocation',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.existingActor();
    await f.grant(admin);
    const db = f.app.get(DatabaseService),
      identity = f.app.get(IdentityService),
      authority = f.app.get(AuthorizationService),
      pins = f.app.get(PostPinAuthorityFacade),
      ratings = f.app.get(RatingAuthorizationFacade);
    const get = (path: string) =>
      request(f.http)
        .get(path)
        .set('Authorization', `Bearer ${target.accessToken}`);
    const consumers = async (region: string | null) => {
      for (const path of [
        '/v1/me/school-configuration/capabilities',
        '/v1/organizations/capabilities',
        '/v1/student-verification-review/capabilities',
        '/v1/announcement-management/capabilities',
      ]) {
        const response = await get(path);
        assert.equal(
          response.status,
          200,
          `${path}: ${JSON.stringify(response.body)}`,
        );
        assert.equal(response.body.management, region ? 'fixed' : 'none', path);
        assert.equal(response.body.region?.id ?? null, region, path);
      }
      for (const selected of [
        f.scope.home.regionId,
        f.scope.related.regionId,
      ]) {
        for (const path of [
          `/v1/me/school-configuration?regionId=${selected}`,
          `/v1/me/school-posting-policy?regionId=${selected}`,
          `/v1/organizations/reviews?regionId=${selected}`,
          `/v1/student-verification-review/regions/${selected}/applications`,
          `/v1/admin/errands?regionId=${selected}`,
        ]) {
          const response = await get(path);
          assert.equal(
            response.status,
            selected === region ? 200 : 403,
            `${path}: ${JSON.stringify(response.body)}`,
          );
        }
      }
      const announcements = await get('/v1/announcement-management');
      assert.equal(
        announcements.status,
        region ? 200 : 403,
        JSON.stringify(announcements.body),
      );
    };
    const consume = async (region: string, allowed: boolean) => {
      const current = await db.transaction(
        async (tx) => {
          await lockSafetyPolicy(tx);
          await identity.session(target.accessToken, tx);
          return ratings.scope(target.accountId, tx);
        },
        { isolationLevel: 'read committed' },
      );
      if (allowed) {
        assert.equal(current.kind, 'fixed');
      }
      for (const guard of [
        (tx: Parameters<AuthorizationService['grants']>[1]) =>
          authority.requireRegionManagement(target.accountId, region, tx),
        (tx: Parameters<AuthorizationService['grants']>[1]) =>
          authority.requireErrandManagement(target.accountId, region, tx),
        (tx: Parameters<AuthorizationService['grants']>[1]) =>
          pins.require(target.accountId, region, tx),
      ]) {
        const operation = () =>
          db.transaction(
            async (tx) => {
              await lockSafetyPolicy(tx);
              await identity.session(target.accessToken, tx);
              return guard(tx);
            },
            { isolationLevel: 'read committed' },
          );
        if (allowed) await operation();
        else await assert.rejects(operation);
      }
    };
    await f.apply(admin, target.profileId, 'appoint', f.scope.home.regionId);
    await consumers(f.scope.home.regionId);
    await consume(f.scope.home.regionId, true);
    await consume(f.scope.related.regionId, false);
    await assert.rejects(() =>
      db.transaction(
        (tx) => authority.requireUnprotectedErrandTarget(target.accountId, tx),
        { isolationLevel: 'read committed' },
      ),
    );
    await f.apply(
      admin,
      target.profileId,
      'reassign',
      f.scope.related.regionId,
    );
    await consume(f.scope.home.regionId, false);
    await consumers(f.scope.related.regionId);
    await consume(f.scope.related.regionId, true);
    const appearance = () =>
      request(f.http)
        .get('/v1/me/experience/appearance')
        .set('Authorization', `Bearer ${target.accessToken}`);
    const before = await appearance();
    assert.equal(before.status, 200);
    assert.equal(before.body.titleKey, null);
    assert.ok(
      before.body.titles.some((v: { key: string }) => v.key === 'role_admin'),
    );
    const equipped = await request(f.http)
      .put('/v1/me/experience/appearance')
      .set('Authorization', `Bearer ${target.accessToken}`)
      .send({
        requestId: randomUUID(),
        expectedRevision: before.body.revision,
        titleKey: 'role_admin',
        colorId: null,
      });
    assert.equal(equipped.status, 200, JSON.stringify(equipped.body));
    assert.equal(equipped.body.outcome, 'applied');
    await f.apply(admin, target.profileId, 'revoke');
    await consumers(null);
    await consume(f.scope.home.regionId, false);
    await consume(f.scope.related.regionId, false);
    await db.transaction(
      (tx) => authority.requireUnprotectedErrandTarget(target.accountId, tx),
      { isolationLevel: 'read committed' },
    );
    const retained = await appearance();
    assert.equal(retained.body.titleKey, 'role_admin');
    assert.deepEqual(retained.body.titles, before.body.titles);
    const base = await db.transaction(
      async (tx) => ({
        course: await ratings.courseCommentBase(target.accountId, tx),
        major: await ratings.majorDiscussionBase(target.accountId, tx),
      }),
      { isolationLevel: 'read committed' },
    );
    assert.equal(base.course.allowed, false);
    assert.equal(base.major.allowed, false);
    const caps = await request(f.http)
      .get('/v1/me/authorization')
      .set('Authorization', `Bearer ${target.accessToken}`);
    assert.equal(caps.body.role, 'member');
    assert.deepEqual(caps.body.management.operatingRegionIds, []);
    const summary = await request(f.http)
      .get('/v1/me/experience')
      .set('Authorization', `Bearer ${target.accessToken}`);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.baseline, 'baseline_unknown');
    assert.equal(summary.body.balance, null);
  },
);

test(
  'Experience appearance and appointment share terminal owner ordering without account-lock upgrades or automatic appearance mutation',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    const view = await f.management(admin, target.profileId);
    const pending = f.send(
      admin,
      f.command(view, 'appoint', f.scope.home.regionId),
    );
    const appearance = request(f.http)
      .put('/v1/me/experience/appearance')
      .set('Authorization', `Bearer ${target.accessToken}`)
      .send({
        requestId: randomUUID(),
        expectedRevision: '0',
        titleKey: null,
        colorId: 1,
      });
    const results = await Promise.all([pending, appearance]);
    for (const r of results)
      assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(results[0]!.body.outcome, 'applied');
    const selected = await request(f.http)
      .get('/v1/me/experience/appearance')
      .set('Authorization', `Bearer ${target.accessToken}`);
    assert.equal(selected.body.titleKey, null);
    assert.equal(selected.body.colorId, 1);
  },
);

/** Force the real concurrent operations to overlap at their ordinary locks.
 * No worker/provider/owner method is replaced, and no transaction budget is raised. */
async function waitForOwnerContenders(
  f: SchoolAdminFixture,
  count: number,
): Promise<void> {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const row = (
      await f.pool.query<{ waiting: number }>(
        `SELECT count(*)::integer waiting FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid()
           AND wait_event_type='Lock' AND query LIKE '%whaleu_experience.owners%'
           AND query LIKE '%FOR UPDATE%'`,
      )
    ).rows[0]!;
    if (row.waiting >= count) return;
    await sleep(10);
  }
  assert.fail(`Expected ${count} genuine Experience owner lock contenders`);
}

async function assertAppointmentTitle(
  f: SchoolAdminFixture,
  target: SchoolAdminActor,
  balance: string,
) {
  const grants = await f.grants(target);
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.revoked_at, null);
  assert.equal(grants[0]!.operating_region_id, f.scope.home.regionId);
  const titles = await f.pool.query<{ origin: string }>(
    "SELECT origin FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='role_admin'",
    [target.accountId],
  );
  assert.deepEqual(titles.rows, [{ origin: 'school_admin_appointment' }]);
  const summary = await request(f.http)
    .get('/v1/me/experience')
    .set('Authorization', `Bearer ${target.accessToken}`);
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.balance, balance);
  const appearance = await request(f.http)
    .get('/v1/me/experience/appearance')
    .set('Authorization', `Bearer ${target.accessToken}`);
  assert.equal(appearance.status, 200, JSON.stringify(appearance.body));
  assert.equal(appearance.body.titleKey, null);
  assert.equal(appearance.body.colorId, null);
}

test(
  'actual title-maintenance repair and appointment serialize on the same owner without losing either entitlement',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.existingActor();
    await f.grant(admin);
    await withCommunityScopeWriter(f.pool, (tx) =>
      establishSyntheticExperienceBaseline(tx, target.accountId, {
        balance: 39n,
      }),
    );
    const batch = (intent: MaintenanceIntent) =>
      request(f.http)
        .post('/v1/admin/experience/title-maintenance/batches')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(intent);
    let intent: MaintenanceIntent = {
      requestId: randomUUID(),
      operation: 'repair_level_titles',
    };
    // Maintenance is an immutable bounded sweep, not a target selector. Walk
    // its real continuation up to (but never through) this exact target.
    const preceding = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_identity.accounts WHERE id<$1 ORDER BY id',
        [target.accountId],
      )
    ).rows;
    for (const owner of preceding) {
      const result = await batch(intent);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const item: { owner_id: string } | undefined = (
        await f.pool.query<{ owner_id: string }>(
          'SELECT owner_id FROM whaleu_experience.maintenance_items WHERE actor_id=$1 AND request_id=$2',
          [admin.accountId, intent.requestId],
        )
      ).rows[0];
      assert.equal(item?.owner_id, owner.id);
      intent = { requestId: randomUUID(), previousRequestId: intent.requestId };
    }
    const command = f.command(
      await f.management(admin, target.profileId),
      'appoint',
      f.scope.home.regionId,
    );
    let held: PoolClient | undefined = await hold(
      f.pool,
      'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
      [target.accountId],
    );
    const repair = batch(intent).then((response) => response);
    let appointment: Promise<request.Response> | undefined;
    try {
      await waitForOwnerContenders(f, 1);
      appointment = f.send(admin, command).then((response) => response);
      // Maintenance already holds its actor grant; appointment must wait for
      // that source before reaching the terminal Experience owner lock.
      await f.waitForLock('ORDER BY account_id,id FOR UPDATE');
      await release(held);
      held = undefined;
      const [repaired, appointed] = await Promise.all([repair, appointment]);
      assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
      assert.equal(repaired.body.grantedTitles, 1);
      assert.equal(appointed.status, 200, JSON.stringify(appointed.body));
      assert.equal(appointed.body.outcome, 'applied');
      assert.equal(appointed.body.titleGranted, true);
      const repairedOwner = (
        await f.pool.query<{ owner_id: string; outcome: string }>(
          'SELECT owner_id,outcome FROM whaleu_experience.maintenance_items WHERE actor_id=$1 AND request_id=$2',
          [admin.accountId, intent.requestId],
        )
      ).rows[0];
      assert.deepEqual(repairedOwner, {
        owner_id: target.accountId,
        outcome: 'repaired',
      });
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='level_1' AND origin='maintenance'",
            [target.accountId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_experience.settlements WHERE owner_id=$1',
            [target.accountId],
          )
        ).rowCount,
        0,
      );
      assert.deepEqual((await f.send(admin, command)).body, appointed.body);
      await assertAppointmentTitle(f, target, '39');
    } finally {
      await release(held);
      await Promise.allSettled([repair, ...(appointment ? [appointment] : [])]);
    }
  },
);

test(
  'actual sign-in and appointment overlap at the terminal owner without lost balance, duplicate reward or automatic appearance',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    const command = f.command(
      await f.management(admin, target.profileId),
      'appoint',
      f.scope.home.regionId,
    );
    const signInId = randomUUID();
    const signIn = () =>
      request(f.http)
        .post('/v1/me/experience/sign-in')
        .set('Authorization', `Bearer ${target.accessToken}`)
        .send({ requestId: signInId });
    let held: PoolClient | undefined = await hold(
      f.pool,
      'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
      [target.accountId],
    );
    const signing = signIn().then((response) => response);
    let appointment: Promise<request.Response> | undefined;
    try {
      await waitForOwnerContenders(f, 1);
      appointment = f.send(admin, command).then((response) => response);
      await waitForOwnerContenders(f, 2);
      await release(held);
      held = undefined;
      const [signed, appointed] = await Promise.all([signing, appointment]);
      for (const result of [signed, appointed])
        assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(signed.body.outcome, 'awarded');
      assert.equal(signed.body.appliedDelta, '2');
      assert.equal(appointed.body.outcome, 'applied');
      assert.equal(appointed.body.titleGranted, true);
      assert.deepEqual((await signIn()).body, signed.body);
      assert.deepEqual((await f.send(admin, command)).body, appointed.body);
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_experience.settlements WHERE owner_id=$1 AND action='sign_in'",
            [target.accountId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_experience.records WHERE owner_id=$1 AND action='sign_in'",
            [target.accountId],
          )
        ).rowCount,
        1,
      );
      await assertAppointmentTitle(f, target, '2');
    } finally {
      await release(held);
      await Promise.allSettled([
        signing,
        ...(appointment ? [appointment] : []),
      ]);
    }
  },
);

test(
  'real publication settlement and appointment overlap at the terminal owner and preserve exactly-once source acknowledgement',
  { timeout: 180000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    await seedReviewPolicy(f.pool);
    const input = publishPostSchema.parse({
      clientRequestId: randomUUID(),
      spaceId: f.scope.home.spaceId,
      category: 'discussion',
      text: `School admin settlement concurrency ${randomUUID()}`,
      imageAssetIds: [],
      authorMode: 'named',
      commentsPolicy: 'open',
    });
    await approveEnvelope(
      f.pool,
      await postApprovalEnvelope(f.app, f.pool, target.accountId, input),
    );
    const published = await request(f.http)
      .post('/v1/community/posts')
      .set('Authorization', `Bearer ${target.accessToken}`)
      .send(input);
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const units = (
      await f.pool.query<{ unit_id: string }>(
        "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=$1 AND action='publish' AND state='pending'",
        [target.accountId],
      )
    ).rows.map((row) => row.unit_id);
    assert.equal(
      units.length,
      1,
      'Real HTTP publication must enroll exactly one source unit',
    );
    const worker = f.app.get(ExperienceWorker);
    const command = f.command(
      await f.management(admin, target.profileId),
      'appoint',
      f.scope.home.regionId,
    );
    let held: PoolClient | undefined = await hold(
      f.pool,
      'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
      [target.accountId],
    );
    const settling = worker.run({ mode: 'apply', unitIds: units });
    let appointment: Promise<request.Response> | undefined;
    try {
      await waitForOwnerContenders(f, 1);
      appointment = f.send(admin, command).then((response) => response);
      await waitForOwnerContenders(f, 2);
      await release(held);
      held = undefined;
      const [settled, appointed] = await Promise.all([settling, appointment]);
      assert.equal(settled.failed, 0, JSON.stringify(settled));
      assert.equal(settled.settled, 1, JSON.stringify(settled));
      assert.equal(appointed.status, 200, JSON.stringify(appointed.body));
      assert.equal(appointed.body.outcome, 'applied');
      assert.equal(appointed.body.titleGranted, true);
      const replayed = await worker.run({ mode: 'apply', unitIds: units });
      assert.equal(replayed.failed, 0, JSON.stringify(replayed));
      assert.equal(replayed.settled, 0);
      assert.equal(replayed.completed, 1);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_experience.settlements WHERE unit_id=$1',
            units,
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_experience.records WHERE owner_id=$1 AND action='publish'",
            [target.accountId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_experience.work WHERE unit_id=$1 AND state='completed' AND completed_at IS NOT NULL",
            units,
          )
        ).rowCount,
        1,
      );
      assert.deepEqual((await f.send(admin, command)).body, appointed.body);
      await assertAppointmentTitle(f, target, '10');
    } finally {
      await release(held);
      await Promise.allSettled([
        settling,
        ...(appointment ? [appointment] : []),
      ]);
    }
  },
);
