import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import {
  organizationMediaFixture,
  createOrganizationDraft,
  grantOrganizationSchoolReviewer,
  readyOrganizationImage,
  organizationMediaPrefix as prefix,
  organizationApiPrefix as api,
  organizationOk as ok,
} from '../support/media/organization-runtime-fixture.js';
import {
  organizationDescriptorSchema,
  organizationMediaRequestHash,
  ORGANIZATION_MEDIA_PROTOCOL,
} from '../../src/media/contracts-organization.js';
import { sha256 } from '../../src/media/processing/protocol.js';
const picture = () =>
  sharp({
    create: { width: 64, height: 64, channels: 3, background: '#3579a2' },
  })
    .png()
    .toBuffer();
test(
  'Organization Media10 real applicant upload, independent Review, atomic slots, private contacts and immutable current delivery',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      f = await organizationMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      other = await f.actor(),
      reviewer = await f.actor();
    await grantOrganizationSchoolReviewer(f, reviewer);
    const org = await createOrganizationDraft(f, actor),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const ready = [];
    for (const slot of [
      'avatar',
      'mainQr',
      'managerContact',
      'introImage8',
    ] as const) {
      const value = await readyOrganizationImage(
        f,
        actor,
        org.id,
        slot,
        1,
        bytes,
      );
      assert.equal(value.status.status, 'ready_unbound');
      if (value.status.status !== 'ready_unbound')
        throw new Error('Expected current reviewed image');
      ready.push({ input: value.input, status: value.status });
    }
    assert.equal(
      (
        await f.pool.query<{ hash: string }>(
          'SELECT whaleu_organizations.media_request_hash($1,$2::jsonb) hash',
          [actor.accountId, JSON.stringify(ready[0]!.input)],
        )
      ).rows[0]!.hash,
      organizationMediaRequestHash(actor.accountId, ready[0]!.input),
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT protocol_version,owner_kind,resource_kind,audience,purpose FROM whaleu_media.upload_intents WHERE id=$1',
          [ready[0]!.status.intentId],
        )
      ).rows[0],
      {
        protocol_version: 10,
        owner_kind: 'organizations',
        resource_kind: 'organization_image',
        audience: 'organization-gated',
        purpose: 'organization-image',
      },
    );
    const foreign = await request(http)
      .post(`${prefix}/upload-intents`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ ...ready[0]!.input, clientRequestId: randomUUID() });
    ok(foreign, 403);
    const crossSlot = await request(http)
      .post(`${api}/${org.id}/content`)
      .set('Authorization', auth)
      .send({
        action: 'save',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        expectedAuthorityVersion: 1,
        data: org.data,
        mediaChanges: {
          mainQr: { action: 'replace', assetId: ready[0]!.status.assetId },
        },
      });
    ok(crossSlot, 409);
    assert.equal(crossSlot.body.error.code, 'MEDIA_NOT_READY');
    assert.equal(
      (
        await f.pool.query(
          'SELECT revision FROM whaleu_organizations.organizations WHERE id=$1',
          [org.id],
        )
      ).rows[0].revision,
      '1',
    );
    const mediaChanges = Object.fromEntries(
      ready.map((v) => [
        v.input.slot,
        { action: 'replace', assetId: v.status.assetId },
      ]),
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/content`)
        .set('Authorization', auth)
        .send({
          action: 'submit',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          expectedAuthorityVersion: 1,
          data: org.data,
          mediaChanges,
        }),
    );
    const descriptorPath = (audience: string, slot: string) =>
      `${prefix}/${audience}/organizations/${org.id}/slots/${slot}/descriptor`;
    ok(
      await request(http)
        .get(descriptorPath('public', 'mainQr'))
        .set('Authorization', auth)
        .query({ applicationRevision: 2 }),
      503,
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents`)
        .set('Authorization', auth)
        .send({
          ...ready[0]!.input,
          clientRequestId: randomUUID(),
          applicationRevision: 2,
        }),
      409,
    );
    ok(
      await request(http)
        .get(descriptorPath('management', 'managerContact'))
        .set('Authorization', auth)
        .query({ applicationRevision: 2 }),
    );
    ok(
      await request(http)
        .post(`${api}/${org.id}/review`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .query({ regionId: f.scope.home.regionId })
        .send({
          action: 'approve',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 1,
          reason: '',
        }),
    );
    const descriptorResponse = await request(http)
      .get(descriptorPath('public', 'mainQr'))
      .set('Authorization', `Bearer ${other.accessToken}`)
      .query({ applicationRevision: 2 });
    ok(descriptorResponse);
    const descriptor = organizationDescriptorSchema.parse(
      descriptorResponse.body,
    );
    ok(
      await request(http)
        .get(descriptorPath('public', 'managerContact'))
        .set('Authorization', auth)
        .query({ applicationRevision: 2 }),
      503,
    );
    ok(
      await request(http)
        .get(descriptorPath('management', 'managerContact'))
        .set('Authorization', `Bearer ${other.accessToken}`)
        .query({ applicationRevision: 2 }),
      403,
    );
    ok(
      await request(http)
        .get(descriptorPath('public', 'mainQr'))
        .query({ applicationRevision: 2 }),
      401,
    );
    const imagePath = `${prefix}/public/organizations/${org.id}/slots/mainQr/bindings/${descriptor.bindingId}/display-v1`;
    const image = await request(http)
      .get(imagePath)
      .set('Authorization', auth)
      .query({ applicationRevision: 2 });
    ok(image);
    assert.ok(image.headers['cache-control']?.includes('no-store'));
    assert.ok(Buffer.isBuffer(image.body) && image.body.length > 0);
    ok(
      await request(http)
        .get(imagePath)
        .set('Authorization', auth)
        .set('Range', 'bytes=0-5')
        .query({ applicationRevision: 2 }),
      503,
    );
    const replacement = await readyOrganizationImage(
      f,
      actor,
      org.id,
      'mainQr',
      2,
      bytes,
    );
    assert.equal(replacement.status.status, 'ready_unbound');
    if (replacement.status.status !== 'ready_unbound')
      throw new Error('Expected replacement');
    ok(
      await request(http)
        .post(`${api}/${org.id}/content`)
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 2,
          data: org.data,
          mediaChanges: {
            mainQr: { action: 'replace', assetId: replacement.status.assetId },
          },
        }),
    );
    ok(
      await request(http)
        .get(imagePath)
        .set('Authorization', auth)
        .query({ applicationRevision: 2 }),
      503,
    );
    ok(
      await request(http)
        .get(imagePath)
        .set('Authorization', auth)
        .query({ applicationRevision: 3 }),
      503,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT detached_at IS NOT NULL detached FROM whaleu_media.bindings WHERE id=$1',
          [descriptor.bindingId],
        )
      ).rows[0].detached,
      true,
    );
    const retained = await request(http)
      .get(descriptorPath('public', 'introImage8'))
      .set('Authorization', auth)
      .query({ applicationRevision: 3 });
    ok(retained);
    const detail = await request(http)
      .get(`${api}/regions/${f.scope.home.regionId}/entries/${org.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    ok(detail);
    assert.equal(detail.body.mediaBindings.managerContact, undefined);
    const originalOpen = f.storage.openExact.bind(f.storage);
    let changed = false;
    f.storage.openExact = async (object, maximum) => {
      const result = await originalOpen(object, maximum);
      if (!changed) {
        changed = true;
        ok(
          await request(http)
            .post(`${api}/${org.id}/content`)
            .set('Authorization', auth)
            .send({
              action: 'save',
              clientRequestId: randomUUID(),
              expectedRevision: 3,
              expectedAuthorityVersion: 2,
              data: org.data,
              mediaChanges: {},
            }),
        );
      }
      return result;
    };
    const rejected = await request(http)
      .get(
        `${prefix}/public/organizations/${org.id}/slots/introImage8/bindings/${retained.body.bindingId}/display-v1`,
      )
      .set('Authorization', auth)
      .query({ applicationRevision: 3 });
    ok(rejected, 503);
    assert.ok(
      !Buffer.isBuffer(rejected.body),
      'second owner check must reject before releasing any image bytes',
    );
    const pendingUpload = await request(http)
      .post(`${prefix}/upload-intents`)
      .set('Authorization', auth)
      .send({
        ...ready[0]!.input,
        clientRequestId: randomUUID(),
        applicationRevision: 4,
      });
    ok(pendingUpload);
    ok(
      await request(http)
        .patch('/v1/me/profile')
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ expectedRevision: 0, nickname: '新组织负责人' }),
    );
    const targetProfile = (
      await f.pool.query<{ public_id: string }>(
        'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
        [other.accountId],
      )
    ).rows[0]!.public_id;
    ok(
      await request(http)
        .post(`${api}/${org.id}/members`)
        .set('Authorization', auth)
        .send({
          action: 'transfer_owner',
          clientRequestId: randomUUID(),
          expectedRevision: 4,
          expectedAuthorityVersion: 2,
          targetProfileId: targetProfile,
        }),
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents/${pendingUpload.body.intentId}/grant`)
        .set('Authorization', auth)
        .send({}),
      409,
    );
    const originalReceipt = await request(http)
      .get(`${prefix}/upload-requests/${ready[0]!.input.clientRequestId}`)
      .set('Authorization', auth);
    ok(originalReceipt);
    assert.equal(originalReceipt.body.status.status, 'bound_history');
    const cancelBound = await request(http)
      .post(
        `${prefix}/upload-requests/${ready[0]!.input.clientRequestId}/cancel`,
      )
      .set('Authorization', auth)
      .send({
        protocol: ORGANIZATION_MEDIA_PROTOCOL,
        requestHash: organizationMediaRequestHash(
          actor.accountId,
          ready[0]!.input,
        ),
      });
    ok(cancelBound);
    assert.equal(cancelBound.body.status.status, 'bound_history');
    const stillPublished = await request(http)
      .get(descriptorPath('public', 'mainQr'))
      .set('Authorization', auth)
      .query({ applicationRevision: 4 });
    ok(stillPublished);
  },
);
test(
  'Organization original-key cancellation, owner isolation and official private-slot denial',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      f = await organizationMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      org = await createOrganizationDraft(f, actor, 'official'),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const input = {
      protocol: ORGANIZATION_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      organizationId: org.id,
      slot: 'avatar',
      applicationRevision: 1,
      declaration: {
        mime: 'image/png',
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    };
    const hash = organizationMediaRequestHash(actor.accountId, input);
    ok(
      await request(http)
        .post(`${prefix}/upload-requests/${input.clientRequestId}/cancel`)
        .set('Authorization', auth)
        .send({ protocol: ORGANIZATION_MEDIA_PROTOCOL, requestHash: hash }),
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents`)
        .set('Authorization', auth)
        .send(input),
      409,
    );
    for (const slot of ['managerContact', 'linkedOfficialQr'])
      ok(
        await request(http)
          .post(`${prefix}/upload-intents`)
          .set('Authorization', auth)
          .send({ ...input, clientRequestId: randomUUID(), slot }),
        503,
      );
    const ready = await readyOrganizationImage(
      f,
      actor,
      org.id,
      'avatar',
      1,
      bytes,
    );
    const other = await createOrganizationDraft(f, actor, 'official');
    if (ready.status.status !== 'ready_unbound')
      throw new Error('Expected image');
    const crossOwner = await request(http)
      .post(`${api}/${other.id}/content`)
      .set('Authorization', auth)
      .send({
        action: 'save',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        expectedAuthorityVersion: 1,
        data: other.data,
        mediaChanges: {
          avatar: { action: 'replace', assetId: ready.status.assetId },
        },
      });
    ok(crossOwner, 409);
    assert.equal(crossOwner.body.error.code, 'MEDIA_NOT_READY');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_media.bindings',
        )
      ).rows[0].n,
      0,
    );
  },
);
