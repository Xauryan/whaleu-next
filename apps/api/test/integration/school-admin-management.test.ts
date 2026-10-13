import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { IdentityMaintenance } from '../../src/identity/maintenance.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { DatabaseService } from '../../src/database/database.js';
import {
  schoolAdminManagementFixture,
  schoolAdminPath,
} from '../support/school-admin-management-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  schoolAdminManagementReceiptSchema,
  schoolAdminManagementSchema,
} from '../../src/authorization/school-admin-management/contracts.js';

test(
  'school administrator assignment, exact reassignment and revocation preserve title, source and immutable history',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor({ identity: false, phone: 'unavailable' });
    await f.grant(admin);
    const stable = async () =>
      (
        await f.pool.query(
          `SELECT jsonb_build_object(
    'profile',(SELECT to_jsonb(p) FROM whaleu_profile.profiles p WHERE account_id=$1),
    'identity',(SELECT to_jsonb(a) FROM whaleu_identity.accounts a WHERE id=$1),
    'verification',(SELECT to_jsonb(h) FROM whaleu_verification.account_heads h WHERE account_id=$1),
    'states',(SELECT jsonb_agg(to_jsonb(s)) FROM whaleu_experience.account_states s WHERE owner_id=$1),
    'baselines',(SELECT jsonb_agg(to_jsonb(b)) FROM whaleu_experience.baselines b WHERE owner_id=$1),
    'appearance',(SELECT jsonb_agg(to_jsonb(a)) FROM whaleu_experience.appearance a WHERE owner_id=$1),
    'records',(SELECT jsonb_agg(to_jsonb(r)) FROM whaleu_experience.records r WHERE owner_id=$1),
    'notices',(SELECT count(*) FROM whaleu_experience.unlock_notices)) value`,
          [target.accountId],
        )
      ).rows[0]!.value;
    const original = await stable();
    const view = schoolAdminManagementSchema.parse(
      await f.management(admin, target.profileId),
    );
    assert.deepEqual(
      view.eligibility.regions.map((r) => r.id).sort(),
      [f.scope.home.regionId, f.scope.related.regionId].sort(),
    );
    assert.equal(view.eligibility.defaultRegionId, null);
    assert.equal(view.actions.appoint, true);
    const first = await f.apply(
      admin,
      target.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    const receipt = schoolAdminManagementReceiptSchema.parse(first.receipt);
    assert.equal(receipt.outcome, 'applied');
    assert.equal('titleGranted' in receipt && receipt.titleGranted, true);
    const [old] = await f.grants(target);
    assert.ok(old);
    const title = (
      await f.pool.query(
        `SELECT to_jsonb(e) value FROM whaleu_experience.entitlements e WHERE owner_id=$1 AND title_key='role_admin'`,
        [target.accountId],
      )
    ).rows;
    assert.equal(title.length, 1);
    assert.equal(title[0]!.value.origin, 'school_admin_appointment');
    assert.deepEqual(await stable(), original);
    const epoch = async () =>
      (
        await f.pool.query(
          'SELECT to_jsonb(e) value FROM whaleu_majors.major_delete_authority_epoch e',
        )
      ).rows;
    const epochBefore = await epoch();
    const same = await f.apply(
      admin,
      target.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    assert.equal(same.receipt.outcome, 'unchanged');
    assert.equal(same.receipt.titleGranted, false);
    assert.deepEqual(await f.grants(target), [old]);
    assert.deepEqual(await epoch(), epochBefore);
    const different = await f.send(
      admin,
      f.command(
        await f.management(admin, target.profileId),
        'appoint',
        f.scope.related.regionId,
      ),
    );
    assert.ok(
      different.status >= 400 || different.body.outcome === 'rejected',
      JSON.stringify(different.body),
    );
    assert.deepEqual(await f.grants(target), [old]);
    const moved = await f.apply(
      admin,
      target.profileId,
      'reassign',
      f.scope.related.regionId,
    );
    assert.equal(moved.receipt.outcome, 'applied');
    assert.equal(moved.receipt.titleGranted, false);
    const grants = await f.grants(target);
    assert.equal(grants.length, 2);
    const retired = grants.find((g) => g.id === old.id)!;
    const current = grants.find((g) => g.id !== old.id)!;
    assert.ok(retired.revoked_at);
    assert.equal(current.operating_region_id, f.scope.related.regionId);
    assert.equal(current.revoked_at, null);
    assert.deepEqual(
      {
        ...retired,
        revoked_at: old.revoked_at,
        revoked_by_account_id: old.revoked_by_account_id,
      },
      old,
    );
    await f.certify(target.accountId, {
      affiliation: 'unavailable',
      phone: 'unavailable',
      identity: false,
    });
    const revoked = await f.apply(admin, target.profileId, 'revoke');
    assert.equal(revoked.receipt.outcome, 'applied');
    assert.ok((await f.grants(target)).every((g) => g.revoked_at));
    const twice = await f.apply(admin, target.profileId, 'revoke');
    assert.equal(twice.receipt.outcome, 'unchanged');
    assert.deepEqual(
      (
        await f.pool.query(
          `SELECT to_jsonb(e) value FROM whaleu_experience.entitlements e WHERE owner_id=$1 AND title_key='role_admin'`,
          [target.accountId],
        )
      ).rows,
      title,
    );
    for (const result of [
      view,
      first.receipt,
      moved.receipt,
      revoked.receipt,
    ]) {
      const json = JSON.stringify(result);
      for (const privateValue of [
        target.accountId,
        admin.accountId,
        old.id as string,
        target.sessionId,
      ])
        assert.ok(!json.includes(privateValue));
      for (const field of [
        'accountId',
        'studentNumber',
        'openid',
        'phone',
        'grantId',
        'assertionId',
        'snapshotId',
      ])
        assert.ok(!json.includes(`"${field}"`));
    }
    await assert.rejects(() =>
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_authorization.role_grants SET operating_region_id=$2 WHERE id=$1',
          [old.id, f.scope.related.regionId],
        ),
      ),
    );
    await assert.rejects(() =>
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query('DELETE FROM whaleu_authorization.role_grants WHERE id=$1', [
          old.id,
        ]),
      ),
    );
  },
);

test(
  'only actual current super authority can manage; recovery/cancel remain active-Identity-only with original immutable intent',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      developer = await f.actor(),
      member = await f.actor(),
      school = await f.actor(),
      target = await f.actor(),
      protectedTarget = await f.actor();
    const grant = await f.grant(admin);
    await f.grant(developer, 'developer');
    await f.grant(school, 'school_admin', f.scope.home.regionId);
    await f.grant(protectedTarget);
    for (const denied of [developer, member, school])
      assert.equal(
        (await f.managementResponse(denied, target.profileId)).status,
        403,
      );
    const capability = async (a: typeof admin) =>
      (
        await request(f.http)
          .get('/v1/me/authorization')
          .set('Authorization', `Bearer ${a.accessToken}`)
      ).body;
    assert.equal((await capability(developer)).schoolAdminManagement, false);
    await f.grant(admin, 'developer');
    assert.equal((await capability(admin)).role, 'developer');
    assert.equal((await capability(admin)).schoolAdminManagement, true);
    const protectedView = await f.management(admin, protectedTarget.profileId);
    assert.equal(protectedView.eligibility.status, 'protected');
    assert.deepEqual(protectedView.actions, {
      appoint: false,
      reassign: false,
      revoke: false,
    });
    const success = await f.apply(
      admin,
      target.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    const base = f.command(
      await f.management(admin, target.profileId),
      'reassign',
      f.scope.related.regionId,
    );
    for (const extra of [
      { role: 'super_admin' },
      { approvedBy: member.accountId },
      { expiresAt: new Date().toISOString() },
      { targetAccountId: target.accountId },
    ])
      assert.equal((await f.send(admin, { ...base, ...extra })).status, 400);
    assert.equal(
      (await f.send(admin, { ...base, action: 'revoke' })).status,
      400,
    );
    for (const changed of [
      { targetProfileId: protectedTarget.profileId },
      { action: 'reassign' as const },
      { regionId: f.scope.related.regionId },
      { expectedStateVersion: '0'.repeat(64) },
    ])
      assert.equal(
        (await f.send(admin, { ...success.body, ...changed })).status,
        409,
      );
    const stale = await f.send(admin, {
      ...base,
      expectedStateVersion: '0'.repeat(64),
    });
    assert.equal(stale.status, 200);
    assert.equal(stale.body.code, 'SCHOOL_ADMIN_MANAGEMENT_STALE');
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        [grant],
      ),
    );
    assert.equal(
      (await f.managementResponse(admin, target.profileId)).status,
      403,
    );
    for (const result of [
      await f.send(admin, success.body),
      await f.send(admin, success.body, true),
    ]) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body, success.receipt);
    }
    assert.deepEqual(
      (await f.recovery(admin, success.body.clientRequestId)).body,
      { state: 'recorded', receipt: success.receipt },
    );
    assert.deepEqual(
      (await f.recovery(member, success.body.clientRequestId)).body,
      { state: 'not_recorded' },
    );
    const cancel = {
      ...base,
      clientRequestId: randomUUID(),
      targetProfileId: randomUUID(),
    };
    const cancelled = await f.send(admin, cancel, true);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.code, 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED');
    assert.deepEqual((await f.send(admin, cancel)).body, cancelled.body);
    assert.notEqual(
      (await f.send(admin, { ...base, clientRequestId: randomUUID() })).status,
      200,
    );
    const locker = await f.pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        'LOCK TABLE whaleu_campus.community_topology_heads,whaleu_verification.account_heads,whaleu_experience.entitlements,whaleu_experience.school_admin_title_grants,whaleu_authorization.role_grants IN ACCESS EXCLUSIVE MODE',
      );
      const recovered = await f.recovery(admin, success.body.clientRequestId);
      assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.deepEqual(
        (await f.send(admin, success.body, true)).body,
        success.receipt,
      );
      const cold = await f.send(
        admin,
        { ...cancel, clientRequestId: randomUUID() },
        true,
      );
      assert.equal(cold.status, 200, JSON.stringify(cold.body));
      assert.equal(cold.body.code, 'SCHOOL_ADMIN_MANAGEMENT_CANCELLED');
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [admin.accountId],
      ),
    );
    assert.ok(
      (await f.recovery(admin, success.body.clientRequestId)).status >= 400,
    );
    assert.equal(
      (
        await request(f.http)
          .get(`${schoolAdminPath}/management`)
          .query({ targetProfileId: target.profileId })
      ).status,
      401,
    );
  },
);

test(
  'future and expired unrevoked grants require explicit exact-row replacement and same-region title repair does not mutate a grant',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor();
    await f.grant(admin);
    for (const status of ['future', 'expired', 'active'] as const) {
      const target = await f.actor();
      const oldId = await f.grant(
        target,
        'school_admin',
        f.scope.home.regionId,
        status === 'future'
          ? { from: new Date(Date.now() + 3600000) }
          : status === 'expired'
            ? {
                from: new Date(Date.now() - 3600000),
                until: new Date(Date.now() - 60000),
              }
            : {},
      );
      const before = await f.grants(target),
        view = await f.management(admin, target.profileId);
      assert.equal(view.currentAssignment?.status, status);
      const rejected = await f.send(
        admin,
        f.command(view, 'appoint', f.scope.home.regionId),
      );
      if (status === 'active') {
        assert.equal(rejected.status, 200);
        assert.equal(rejected.body.outcome, 'unchanged');
        assert.equal(rejected.body.titleGranted, true);
        assert.deepEqual(await f.grants(target), before);
      } else {
        assert.ok(
          rejected.status >= 400 || rejected.body.outcome === 'rejected',
        );
        assert.deepEqual(await f.grants(target), before);
        const result = await f.apply(
          admin,
          target.profileId,
          'reassign',
          f.scope.home.regionId,
        );
        assert.equal(result.receipt.outcome, 'applied');
        const rows = await f.grants(target);
        assert.equal(rows.length, 2);
        assert.ok(rows.find((g) => g.id === oldId)?.revoked_at);
        assert.equal(rows.filter((g) => g.revoked_at === null).length, 1);
      }
    }
  },
);

test(
  'historical command session metadata does not block Identity retention and another active session of the same account recovers the original receipt',
  { timeout: 120000 },
  async (t) => {
    const f = await schoolAdminManagementFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      target = await f.actor();
    await f.grant(admin);
    const applied = await f.apply(
      admin,
      target.profileId,
      'appoint',
      f.scope.home.regionId,
    );
    const provider = (
      await f.pool.query<{ app_id: string; subject: string }>(
        'SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
        [admin.accountId],
      )
    ).rows[0]!;
    const accessToken = mintToken('access'),
      refreshToken = mintToken('refresh');
    const session = await f.app.get(IdentityRepository).createSession(
      {
        provider: 'wechat',
        appId: provider.app_id,
        subject: provider.subject,
      },
      { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
    );
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()-interval '40 days',refresh_expires_at=clock_timestamp()-interval '40 days',absolute_expires_at=clock_timestamp()-interval '40 days',revoked_at=clock_timestamp()-interval '40 days',revoke_reason='logout' WHERE id=$1",
        [admin.sessionId],
      );
      await tx.query(
        "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '40 days' WHERE session_id=$1",
        [admin.sessionId],
      );
    });
    const maintenance = new IdentityMaintenance(f.app.get(DatabaseService));
    const result = await maintenance.run({
      mode: 'apply',
      retentionDays: 30,
      batchSize: 100,
    });
    assert.equal(result.sessions, 1);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_identity.sessions WHERE id=$1',
          [admin.sessionId],
        )
      ).rowCount,
      0,
    );
    const next = { ...admin, ...session, accessToken, refreshToken };
    const recovered = await f.recovery(next, applied.body.clientRequestId);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.deepEqual(recovered.body, {
      state: 'recorded',
      receipt: applied.receipt,
    });
    assert.deepEqual((await f.send(next, applied.body)).body, applied.receipt);
    assert.ok(
      (await f.recovery(admin, applied.body.clientRequestId)).status >= 400,
    );
  },
);
