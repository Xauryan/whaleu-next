import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import {
  organizationMediaFixture,
  createOrganizationDraft,
  readyOrganizationImage,
  grantOrganizationSchoolReviewer,
  organizationOk as ok,
} from '../support/media/organization-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { organizationCommandHash } from '../../src/organizations/management/contracts.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
const api = '/v1/organizations';
test(
  'real organization draft, rejection/resubmission, school first approval, same-key receipts and unique target authority survive concurrency',
  { timeout: 300000 },
  async (t) => {
    const bytes = await sharp({
        create: { width: 48, height: 48, channels: 3, background: '#208575' },
      })
        .png()
        .toBuffer(),
      f = await organizationMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const owner = await f.actor(),
      reviewer = await f.actor(),
      one = await f.actor(),
      two = await f.actor(),
      developer = await f.actor(),
      foreign = await f.actor({ campusId: f.scope.related.campusId }),
      http = f.app.getHttpServer();
    const auth = (actor: { accessToken: string }) =>
      `Bearer ${actor.accessToken}`;
    await grantOrganizationSchoolReviewer(f, reviewer);
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-organization-developer')`,
        [randomUUID(), developer.accountId],
      ),
    );
    for (const actor of [owner, one, two])
      ok(
        await request(http)
          .patch('/v1/me/profile')
          .send({ expectedRevision: 0, nickname: '组织成员' })
          .set('Authorization', auth(actor)),
      );
    const profile = async (account: string) =>
      (
        await f.pool.query<{ id: string }>(
          'SELECT public_id id FROM whaleu_profile.profiles WHERE account_id=$1',
          [account],
        )
      ).rows[0]!.id;
    const org = await createOrganizationDraft(f, owner, 'qq');
    const noMedia = {
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      expectedAuthorityVersion: 1,
      action: 'submit' as const,
      data: org.data,
      mediaChanges: {},
    };
    ok(
      await request(http)
        .post(`${api}/${org.id}/content`)
        .set('Authorization', auth(owner))
        .send(noMedia),
      422,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_organizations.organization_grants',
        )
      ).rows[0].n,
      0,
    );
    const changes: Record<string, unknown> = {};
    for (const slot of ['avatar', 'mainQr'] as const) {
      const image = await readyOrganizationImage(
        f,
        owner,
        org.id,
        slot,
        1,
        bytes,
      );
      assert.equal(image.status.status, 'ready_unbound');
      if (image.status.status !== 'ready_unbound') throw Error('image');
      changes[slot] = { action: 'replace', assetId: image.status.assetId };
    }
    const submit = {
      ...noMedia,
      clientRequestId: randomUUID(),
      mediaChanges: changes,
    };
    ok(
      await request(http)
        .post(`${api}/${org.id}/content`)
        .set('Authorization', auth(owner))
        .send(submit),
    );
    const review = {
      clientRequestId: randomUUID(),
      expectedRevision: 2,
      expectedAuthorityVersion: 1,
      action: 'reject',
      reason: '请完善介绍',
    };
    ok(
      await request(http)
        .post(`${api}/${org.id}/review`)
        .query({ regionId: f.scope.home.regionId })
        .set('Authorization', auth(developer))
        .send(review),
      403,
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/review`)
        .query({ regionId: f.scope.related.regionId })
        .set('Authorization', auth(reviewer))
        .send(review),
      403,
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/review`)
        .query({ regionId: f.scope.home.regionId })
        .set('Authorization', auth(reviewer))
        .send({ ...review, reason: '' }),
      400,
    );
    const rejected = await request(http)
      .post(`${api}/${org.id}/review`)
      .query({ regionId: f.scope.home.regionId })
      .set('Authorization', auth(reviewer))
      .send(review);
    ok(rejected);
    const own = await request(http)
      .get(`${api}/${org.id}`)
      .set('Authorization', auth(owner));
    ok(own);
    assert.equal(own.body.reviewReason, '请完善介绍');
    assert.equal(own.body.members.length, 0);
    ok(
      await request(http)
        .post(`${api}/${org.id}/content`)
        .set('Authorization', auth(owner))
        .send({
          action: 'submit',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 2,
          data: { ...org.data, introText: '完善介绍' },
          mediaChanges: {},
        }),
    );
    const approve = {
      action: 'approve',
      clientRequestId: randomUUID(),
      expectedRevision: 3,
      expectedAuthorityVersion: 2,
      reason: '',
    };
    const approved = await request(http)
      .post(`${api}/${org.id}/review`)
      .query({ regionId: f.scope.home.regionId })
      .set('Authorization', auth(reviewer))
      .send(approve);
    ok(approved);
    const replay = await request(http)
      .post(`${api}/${org.id}/review`)
      .query({ regionId: f.scope.home.regionId })
      .set('Authorization', auth(reviewer))
      .send(approve);
    ok(replay);
    assert.deepEqual(replay.body, approved.body);
    ok(
      await request(http)
        .post(`${api}/${org.id}/review`)
        .query({ regionId: f.scope.home.regionId })
        .set('Authorization', auth(reviewer))
        .send({ ...approve, clientRequestId: randomUUID() }),
      409,
    );
    const publicDetail = await request(http)
      .get(`${api}/regions/${f.scope.home.regionId}/entries/${org.id}`)
      .set('Authorization', auth(reviewer));
    ok(publicDetail);
    assert.equal(publicDetail.body.management.available, true);
    ok(
      await request(http)
        .get(`${api}/regions/${f.scope.home.regionId}/entries/${org.id}`)
        .set('Authorization', auth(foreign)),
      403,
    );
    const add = {
      action: 'add_admin',
      clientRequestId: randomUUID(),
      expectedRevision: 3,
      expectedAuthorityVersion: 3,
      targetProfileId: await profile(one.accountId),
    };
    ok(
      await request(http)
        .post(`${api}/${org.id}/members`)
        .set('Authorization', auth(owner))
        .send(add),
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/members`)
        .set('Authorization', auth(one))
        .send({
          action: 'transfer_owner',
          clientRequestId: randomUUID(),
          expectedRevision: 3,
          expectedAuthorityVersion: 4,
          targetProfileId: await profile(two.accountId),
        }),
      403,
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/members`)
        .set('Authorization', auth(one))
        .send({
          action: 'remove_admin',
          clientRequestId: randomUUID(),
          expectedRevision: 3,
          expectedAuthorityVersion: 4,
          targetProfileId: await profile(owner.accountId),
        }),
      409,
    );
    const profileOne = await profile(one.accountId),
      profileTwo = await profile(two.accountId);
    const transfers = await Promise.all(
      [profileOne, profileTwo].map((targetProfileId) =>
        request(http)
          .post(`${api}/${org.id}/members`)
          .set('Authorization', auth(reviewer))
          .send({
            action: 'transfer_owner',
            clientRequestId: randomUUID(),
            expectedRevision: 3,
            expectedAuthorityVersion: 4,
            targetProfileId,
          }),
      ),
    );
    assert.deepEqual(transfers.map((r) => r.status).sort(), [200, 409]);
    const grants = (
      await f.pool.query<{ account_id: string; role: string }>(
        `SELECT account_id,role FROM whaleu_organizations.organization_grants WHERE organization_id=$1 AND revoked_at IS NULL ORDER BY role`,
        [org.id],
      )
    ).rows;
    assert.equal(
      grants.filter((g) => g.role === 'organization_owner').length,
      1,
    );
    assert.equal(
      grants.find((g) => g.account_id === owner.accountId)?.role,
      'organization_admin',
    );
    assert.equal(
      grants.some((g) => g.account_id === reviewer.accountId),
      false,
      'school transfer never demotes/grants the operator',
    );
    const former = await request(http)
      .get(`${api}/${org.id}`)
      .set('Authorization', auth(owner));
    ok(former);
    assert.equal(former.body.permissions.transferOwner, false);
    assert.equal(former.body.permissions.manageMembers, true);
    const removeSelf = {
      action: 'remove_admin',
      clientRequestId: randomUUID(),
      expectedRevision: 3,
      expectedAuthorityVersion: 5,
      targetProfileId: await profile(owner.accountId),
    };
    const removed = await request(http)
      .post(`${api}/${org.id}/members`)
      .set('Authorization', auth(owner))
      .send(removeSelf);
    ok(removed);
    ok(
      await request(http)
        .get(`${api}/${org.id}`)
        .set('Authorization', auth(owner)),
      403,
    );
    const history = await request(http)
      .get(`${api}/requests/${removeSelf.clientRequestId}`)
      .set('Authorization', auth(owner));
    ok(history);
    assert.deepEqual(history.body.receipt, removed.body);
    const mine = await request(http)
      .get(`${api}/mine`)
      .set('Authorization', auth(owner));
    ok(mine);
    assert.equal(
      mine.body.items.some((i: { id: string }) => i.id === org.id),
      false,
    );
    const command = {
        action: 'create' as const,
        clientRequestId: randomUUID(),
        organizationId: randomUUID(),
        regionId: f.scope.home.regionId,
        expectedRevision: 0,
        expectedAuthorityVersion: 0,
        data: org.data,
      },
      hash = organizationCommandHash(
        owner.accountId,
        command.organizationId,
        command,
      );
    ok(
      await request(http)
        .post(`${api}/requests/${command.clientRequestId}/cancel`)
        .set('Authorization', auth(owner))
        .send({ requestHash: hash }),
    );
    ok(
      await request(http)
        .post(api)
        .set('Authorization', auth(owner))
        .send(command),
      409,
    );
    ok(
      await request(http)
        .get(`${api}/requests/${command.clientRequestId}`)
        .set('Authorization', auth(one)),
    );
    assert.equal(
      (
        await request(http)
          .get(`${api}/requests/${command.clientRequestId}`)
          .set('Authorization', auth(one))
      ).body.state,
      'not_recorded',
    );
    for (const upper of ['ABCDEFAB-1234-4234-8234-123456789ABC']) {
      ok(
        await request(http)
          .post(api)
          .set('Authorization', auth(owner))
          .send({
            ...command,
            clientRequestId: upper,
            organizationId: randomUUID(),
          }),
        400,
      );
      ok(
        await request(http)
          .get(`${api}/requests/${upper}`)
          .set('Authorization', auth(owner)),
        400,
      );
      ok(
        await request(http)
          .post(`${api}/requests/${upper}/cancel`)
          .set('Authorization', auth(owner))
          .send({ requestHash: hash }),
        400,
      );
    }
  },
);

test(
  '100-manager transfer rejects a new member atomically but accepts an existing administrator without increasing capacity',
  { timeout: 300000 },
  async (t) => {
    const bytes = await sharp({
        create: { width: 16, height: 16, channels: 3, background: '#375577' },
      })
        .png()
        .toBuffer(),
      f = await organizationMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const owner = await f.actor(),
      reviewer = await f.actor(),
      http = f.app.getHttpServer(),
      auth = `Bearer ${reviewer.accessToken}`;
    await grantOrganizationSchoolReviewer(f, reviewer);
    const org = await createOrganizationDraft(f, owner, 'qq');
    const mediaChanges: Record<string, unknown> = {};
    for (const slot of ['avatar', 'mainQr'] as const) {
      const uploaded = await readyOrganizationImage(
        f,
        owner,
        org.id,
        slot,
        1,
        bytes,
      );
      if (uploaded.status.status !== 'ready_unbound')
        throw Error('Expected image');
      mediaChanges[slot] = {
        action: 'replace',
        assetId: uploaded.status.assetId,
      };
    }
    ok(
      await request(http)
        .post(`${api}/${org.id}/content`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          action: 'submit',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          expectedAuthorityVersion: 1,
          data: org.data,
          mediaChanges,
        }),
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/review`)
        .query({ regionId: f.scope.home.regionId })
        .set('Authorization', auth)
        .send({
          action: 'approve',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 1,
          reason: '',
        }),
    );
    let version = 2,
      firstAdmin: string | null = null;
    for (let i = 0; i < 99; i++) {
      const actor = await f.actor();
      ok(
        await request(http)
          .patch('/v1/me/profile')
          .send({ expectedRevision: 0, nickname: '组织成员' })
          .set('Authorization', `Bearer ${actor.accessToken}`),
      );
      const profileId = (
        await f.pool.query<{ id: string }>(
          'SELECT public_id id FROM whaleu_profile.profiles WHERE account_id=$1',
          [actor.accountId],
        )
      ).rows[0]!.id;
      firstAdmin ??= profileId;
      ok(
        await request(http)
          .post(`${api}/${org.id}/members`)
          .set('Authorization', auth)
          .send({
            action: 'add_admin',
            clientRequestId: randomUUID(),
            expectedRevision: 2,
            expectedAuthorityVersion: version,
            targetProfileId: profileId,
          }),
      );
      version++;
    }
    const outsider = await f.actor();
    ok(
      await request(http)
        .patch('/v1/me/profile')
        .send({ expectedRevision: 0, nickname: '组织成员' })
        .set('Authorization', `Bearer ${outsider.accessToken}`),
    );
    const outsiderProfile = (
      await f.pool.query<{ id: string }>(
        'SELECT public_id id FROM whaleu_profile.profiles WHERE account_id=$1',
        [outsider.accountId],
      )
    ).rows[0]!.id;
    const before = (
      await f.pool.query(
        `SELECT count(*)::integer n FROM whaleu_organizations.organization_events WHERE organization_id=$1`,
        [org.id],
      )
    ).rows[0].n;
    const rejected = await request(http)
      .post(`${api}/${org.id}/members`)
      .set('Authorization', auth)
      .send({
        action: 'transfer_owner',
        clientRequestId: randomUUID(),
        expectedRevision: 2,
        expectedAuthorityVersion: version,
        targetProfileId: outsiderProfile,
      });
    ok(rejected, 409);
    assert.equal(rejected.body.error.code, 'ORGANIZATION_MEMBER_LIMIT');
    assert.equal(
      (
        await f.pool.query(
          `SELECT count(*)::integer n FROM whaleu_organizations.organization_events WHERE organization_id=$1`,
          [org.id],
        )
      ).rows[0].n,
      before,
    );
    assert.equal(
      (
        await f.pool.query(
          `SELECT account_id FROM whaleu_organizations.organization_grants WHERE organization_id=$1 AND role='organization_owner' AND revoked_at IS NULL`,
          [org.id],
        )
      ).rows[0].account_id,
      owner.accountId,
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/members`)
        .set('Authorization', auth)
        .send({
          action: 'transfer_owner',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: version,
          targetProfileId: firstAdmin,
        }),
    );
    const counts = (
      await f.pool.query(
        `SELECT count(*)::integer n,count(*) FILTER(WHERE role='organization_owner')::integer owners FROM whaleu_organizations.organization_grants WHERE organization_id=$1 AND revoked_at IS NULL`,
        [org.id],
      )
    ).rows[0];
    assert.deepEqual(counts, { n: 100, owners: 1 });
    ok(await request(http).get(`${api}/${org.id}`).set('Authorization', auth));
  },
);
