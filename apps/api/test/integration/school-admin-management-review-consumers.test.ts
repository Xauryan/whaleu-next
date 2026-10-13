import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import { schoolAdminControl } from '../support/school-admin-command-harness.js';
import {
  organizationMediaFixture,
  createOrganizationDraft,
  readyOrganizationImage,
} from '../support/media/organization-runtime-fixture.js';
import {
  studentEvidenceFixture,
  readyVerificationEvidenceImage,
} from '../support/student-evidence-fixture.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
const ok = (r: { status: number; body: unknown }) =>
  assert.equal(r.status, 200, JSON.stringify(r.body));

test(
  'new school grant performs real organization first approval; reassignment/revocation deny pending reviews without undoing accepted organization authority',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#258768' },
    })
      .png()
      .toBuffer();
    const f = await organizationMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const superActor = await f.actor(),
      admin = await f.actor();
    const control = await schoolAdminControl(f, superActor, admin);
    await control.change('appoint', f.scope.home.regionId);
    const post = (actor: { accessToken: string }, path: string, body: object) =>
      request(f.app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
    const pending = async () => {
      const owner = await f.actor(),
        draft = await createOrganizationDraft(f, owner, 'qq'),
        mediaChanges: Record<string, unknown> = {};
      for (const slot of ['avatar', 'mainQr'] as const) {
        const media = await readyOrganizationImage(
          f,
          owner,
          draft.id,
          slot,
          1,
          bytes,
        );
        assert.equal(media.status.status, 'ready_unbound');
        if (media.status.status !== 'ready_unbound')
          throw Error('Evidence not ready');
        mediaChanges[slot] = {
          action: 'replace',
          assetId: media.status.assetId,
        };
      }
      const submitted = await post(
        owner,
        `/v1/organizations/${draft.id}/content`,
        {
          action: 'submit',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          expectedAuthorityVersion: 1,
          data: draft.data,
          mediaChanges,
        },
      );
      ok(submitted);
      return { id: draft.id, owner };
    };
    const first = await pending(),
      second = await pending();
    const approve = (id: string) =>
      post(
        admin,
        `/v1/organizations/${id}/review?regionId=${f.scope.home.regionId}`,
        {
          action: 'approve',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 1,
          reason: '',
        },
      );
    ok(await approve(first.id));
    const original = (
      await f.pool.query(
        'SELECT to_jsonb(g) value FROM whaleu_organizations.organization_grants g WHERE organization_id=$1 ORDER BY id',
        [first.id],
      )
    ).rows;
    assert.ok(original.length > 0);
    await control.change('reassign', f.scope.related.regionId);
    assert.equal((await approve(second.id)).status, 403);
    await control.change('reassign', f.scope.home.regionId);
    await control.change('revoke');
    assert.equal((await approve(second.id)).status, 403);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(g) value FROM whaleu_organizations.organization_grants g WHERE organization_id=$1 ORDER BY id',
          [first.id],
        )
      ).rows,
      original,
    );
    const ownerView = await request(f.app.getHttpServer())
      .get(`/v1/organizations/${first.id}`)
      .set('Authorization', `Bearer ${first.owner.accessToken}`);
    ok(ownerView);
    assert.equal(ownerView.body.state, 'approved');
    const pendingView = await request(f.app.getHttpServer())
      .get(`/v1/organizations/${second.id}`)
      .set('Authorization', `Bearer ${second.owner.accessToken}`);
    ok(pendingView);
    assert.equal(pendingView.body.state, 'pending');
  },
);

test(
  'new school grant performs real student evidence decision; old-region and revoked reviewer cannot finalize pending applications',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#4a8a73' },
    })
      .png()
      .toBuffer();
    const f = await studentEvidenceFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const superActor = await f.actor(),
      admin = await f.actor();
    await setRuntimeVerification(
      f.pool,
      admin.accountId,
      f.scope.institutionId,
      f.scope.home.regionId,
      'verified',
      'unavailable',
    );
    const control = await schoolAdminControl(f, superActor, admin);
    await control.change('appoint', f.scope.home.regionId);
    const post = (actor: { accessToken: string }, path: string, body: object) =>
      request(f.app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(body);
    const pending = async () => {
      const owner = await f.actor(),
        draft = await post(owner, '/v1/me/student-verification/applications', {
          clientRequestId: randomUUID(),
          campusId: f.scope.home.campusId,
        });
      ok(draft);
      const media = await readyVerificationEvidenceImage(
        f,
        owner,
        draft.body.applicationId,
        draft.body.revision,
        bytes,
      );
      assert.equal(media.status.status, 'ready_unbound');
      if (media.status.status !== 'ready_unbound')
        throw Error('Evidence not ready');
      const submitted = await post(
        owner,
        `/v1/me/student-verification/applications/${draft.body.applicationId}/submit`,
        {
          clientRequestId: randomUUID(),
          expectedRevision: draft.body.revision,
          evidence: {
            protocol: 'verification-evidence-media-v1',
            kind: 'verification-evidence-upload',
            assetId: media.status.assetId,
          },
        },
      );
      ok(submitted);
      return {
        id: submitted.body.applicationId as string,
        revision: submitted.body.revision as number,
        owner,
      };
    };
    const first = await pending(),
      second = await pending();
    const approve = (a: Awaited<ReturnType<typeof pending>>) =>
      post(
        admin,
        `/v1/student-verification-review/regions/${f.scope.home.regionId}/applications/${a.id}/decision`,
        {
          clientRequestId: randomUUID(),
          expectedRevision: a.revision,
          decision: 'approved',
        },
      );
    ok(await approve(first));
    const firstHead = (
      await f.pool.query(
        'SELECT to_jsonb(h) value FROM whaleu_verification.account_heads h WHERE account_id=$1',
        [first.owner.accountId],
      )
    ).rows;
    await control.change('reassign', f.scope.related.regionId);
    assert.equal((await approve(second)).status, 403);
    await control.change('reassign', f.scope.home.regionId);
    await control.change('revoke');
    assert.equal((await approve(second)).status, 403);
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(h) value FROM whaleu_verification.account_heads h WHERE account_id=$1',
          [first.owner.accountId],
        )
      ).rows,
      firstHead,
    );
    const rows = (
      await f.pool.query(
        'SELECT id,state FROM whaleu_verification.student_applications WHERE id=ANY($1::uuid[])',
        [[first.id, second.id]],
      )
    ).rows;
    assert.equal(rows.find((r) => r.id === first.id)?.state, 'approved');
    assert.equal(rows.find((r) => r.id === second.id)?.state, 'pending');
  },
);
