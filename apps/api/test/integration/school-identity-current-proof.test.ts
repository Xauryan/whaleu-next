import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import { schoolUidFixture } from '../support/school-uid-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import type { SchoolIdentityCommand } from '../../src/school-identity/contracts.js';

test(
  'school identity target CAS, original full-intent cancellation and same-account replacement-session recovery after role loss',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner));
    const view = await f.management(f.admin, profile, f.destination.campusId);
    assert.ok(view.destination);
    const command: SchoolIdentityCommand = {
      version: 1,
      action: 'correct_school',
      clientRequestId: randomUUID(),
      targetProfileId: profile,
      expectedStateVersion: view.stateVersion,
      destinationCampusId: f.destination.campusId,
      expectedDestinationVersion: view.destination.destinationVersion,
    };
    const results = await Promise.all([
      f.send(f.admin, command),
      f.send(f.admin, { ...command, clientRequestId: randomUUID() }),
    ]);
    assert.equal(results[0]!.status, 200, JSON.stringify(results[0]!.body));
    assert.equal(results[1]!.status, 200, JSON.stringify(results[1]!.body));
    assert.deepEqual(results.map((r) => r.body.outcome).sort(), [
      'applied',
      'rejected',
    ]);
    const applied = results.find((r) => r.body.outcome === 'applied')!.body;
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
        [f.adminGrant, f.admin.accountId],
      ),
    );
    const replacement = await f.actor('synthetic-school-uid-native-admin');
    const recovered = await request(f.app.getHttpServer())
      .get(`/v1/admin/school-identities/requests/${applied.requestId}`)
      .set('Authorization', `Bearer ${replacement.accessToken}`);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.deepEqual(recovered.body, { state: 'recorded', receipt: applied });
    const other = await request(f.app.getHttpServer())
      .get(`/v1/admin/school-identities/requests/${applied.requestId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    assert.deepEqual(other.body, { state: 'not_recorded' });
    const cancelled = { ...command, clientRequestId: randomUUID() };
    const cancel = await f.send(replacement, cancelled, true);
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(cancel.body.code, 'SCHOOL_IDENTITY_CANCELLED');
    const late = await f.send(replacement, cancelled);
    assert.deepEqual(late.body, cancel.body);
    const changed = await f.send(replacement, {
      ...cancelled,
      expectedStateVersion: '0'.repeat(64),
    });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error.code, 'SCHOOL_IDENTITY_REQUEST_CONFLICT');
  },
);

test(
  'strict school UID lookup requires an explicit super grant and reveals only a current visible public profile',
  { timeout: 240000 },
  async (t) => {
    const f = await schoolUidFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      profile = await f.profile(owner);
    await f.approve(f.admin, await f.submit(owner));
    const developer = await f.actor(),
      school = await f.actor(),
      http = f.app.getHttpServer();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      for (const [actor, role, region] of [
        [developer, 'developer', null],
        [school, 'school_admin', f.home.regionId],
      ] as const)
        await tx.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-school-uid-authority')",
          [randomUUID(), actor.accountId, role, region],
        );
    });
    const lookup = (
      actor: typeof owner,
      query: Record<string, unknown> = {
        schoolCode: f.home.schoolCode,
        uid: '000001',
      },
    ) =>
      request(http)
        .get('/v1/admin/school-uids/lookup')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .query(query);
    for (const actor of [owner, developer, school]) {
      assert.equal((await lookup(actor)).status, 403);
      assert.equal(
        (
          await request(http)
            .get('/v1/admin/school-identities/management')
            .set('Authorization', `Bearer ${actor.accessToken}`)
            .query({ targetProfileId: profile })
        ).status,
        403,
      );
      const capabilities = await request(http)
        .get('/v1/me/authorization')
        .set('Authorization', `Bearer ${actor.accessToken}`);
      assert.equal(capabilities.body.schoolIdentityManagement, false);
    }
    const found = await lookup(f.admin);
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.equal(found.headers['cache-control'], 'no-store');
    assert.equal(found.headers['vary'], 'Authorization');
    assert.deepEqual(found.body, {
      status: 'found',
      target: {
        profileId: profile,
        displayName: (await f.management(f.admin, profile)).target.displayName,
      },
    });
    for (const uid of ['0', '-1', '1.0', '1e0', ' 1', '9223372036854775808'])
      assert.equal(
        (await lookup(f.admin, { schoolCode: f.home.schoolCode, uid })).status,
        400,
        uid,
      );
    assert.equal(
      (
        await lookup(f.admin, {
          schoolCode: f.home.schoolCode,
          uid: '1',
          accountId: owner.accountId,
        })
      ).status,
      400,
    );
    assert.deepEqual(
      (
        await lookup(f.admin, {
          schoolCode: f.destination.schoolCode,
          uid: '1',
        })
      ).body,
      { status: 'unavailable' },
    );
    await f.correct(f.admin, profile, f.destination.campusId);
    assert.deepEqual((await lookup(f.admin)).body, { status: 'unavailable' });
    assert.equal(
      (
        await lookup(f.admin, {
          schoolCode: f.destination.schoolCode,
          uid: '1',
        })
      ).body.status,
      'found',
    );
    await f.pool.query(
      "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
      [owner.accountId],
    );
    assert.deepEqual(
      (
        await lookup(f.admin, {
          schoolCode: f.destination.schoolCode,
          uid: '1',
        })
      ).body,
      { status: 'unavailable' },
    );
  },
);
