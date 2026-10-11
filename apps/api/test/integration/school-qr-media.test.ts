import { schoolCommandHash } from '../../src/school-configuration/contracts.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import {
  schoolQrFixture,
  grantSchool,
  readySchoolQr,
  publishSchoolQr,
  qrPrefix,
  qrOk,
  schoolData,
} from '../support/media/school-qr-runtime-fixture.js';
import {
  SCHOOL_QR_MEDIA_PROTOCOL,
  schoolQrMediaRequestHash,
  schoolQrDescriptorSchema,
} from '../../src/media/contracts-school-qr.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
const picture = () =>
  sharp({
    create: { width: 64, height: 64, channels: 3, background: '#245276' },
  })
    .png()
    .toBuffer();
test(
  'School Media9 exact upload, shared processor/Review, CAS publication, guest current delivery, replacement/removal and internal review exclusion',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      f = await schoolQrFixture([{ sha256: sha256(bytes), verdict: 'allow' }]);
    t.after(() => f.close());
    const actor = await f.actor(),
      other = await f.actor(),
      developer = await f.actor();
    await grantSchool(f, actor);
    await grantSchool(f, developer, 'developer');
    const http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const prepared = await readySchoolQr(f, actor, bytes);
    assert.equal(prepared.status.status, 'ready_unbound');
    if (prepared.status.status !== 'ready_unbound')
      throw new Error('Expected ready image');
    const requestHash = schoolQrMediaRequestHash(
      actor.accountId,
      prepared.input,
    );
    assert.equal(
      (
        await f.pool.query<{ hash: string }>(
          'SELECT whaleu_school_configuration.qr_request_hash($1,$2::jsonb) hash',
          [actor.accountId, JSON.stringify(prepared.input)],
        )
      ).rows[0]?.hash,
      requestHash,
    );
    const intent = (
      await f.pool.query(
        'SELECT protocol_version,owner_kind,resource_kind,audience,purpose FROM whaleu_media.upload_intents WHERE id=$1',
        [prepared.status.intentId],
      )
    ).rows[0];
    assert.deepEqual(intent, {
      protocol_version: 9,
      owner_kind: 'school_configuration',
      resource_kind: 'entry_qr',
      audience: 'school-config-gated',
      purpose: 'school-configuration-qr-image',
    });
    const crossInput = { ...prepared.input, clientRequestId: randomUUID() };
    qrOk(
      await request(http)
        .post(`${qrPrefix}/upload-intents`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send(crossInput),
      403,
    );
    qrOk(
      await request(http)
        .post(`${qrPrefix}/upload-intents`)
        .set('Authorization', `Bearer ${developer.accessToken}`)
        .send(crossInput),
      403,
    );
    const first = await publishSchoolQr(f, actor, 'treehole', 0, {
      action: 'replace',
      assetId: prepared.status.assetId,
    });
    const descriptorResponse = await request(http)
      .get(`${qrPrefix}/entries/treehole/descriptor`)
      .query({ campusId: f.scope.home.campusId, entryRevision: 1 });
    qrOk(descriptorResponse);
    const descriptor = schoolQrDescriptorSchema.parse(descriptorResponse.body);
    // A valid text hash/source cannot turn a raw foreign QR pointer into authority.
    const bypass = async (
      entryKey: 'trading' | 'treehole',
      revision: number,
      bindingId: string | null,
    ) => {
      const command = {
        clientRequestId: randomUUID(),
        expectedRevision: revision,
        entry: schoolData(entryKey),
        qrcode: { action: 'keep' as const },
      };
      const grantId = (
        await f.pool.query<{ id: string }>(
          "SELECT id FROM whaleu_authorization.role_grants WHERE account_id=$1 AND role='school_admin'",
          [actor.accountId],
        )
      ).rows[0]!.id;
      return withCommunityScopeWriter(f.pool, (tx) =>
        f.qr.repository.save(
          {
            actor: actor.accountId,
            grantId,
            regionId: f.scope.home.regionId,
            key: entryKey,
            command,
            requestHash: schoolCommandHash(
              actor.accountId,
              f.scope.home.regionId,
              entryKey,
              command,
            ),
            bindingId,
          },
          tx,
        ),
      );
    };
    await assert.rejects(bypass('trading', 0, descriptor.bindingId));
    await assert.rejects(bypass('treehole', 1, null));
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::integer n FROM whaleu_school_configuration.entries WHERE entry_key='trading'",
        )
      ).rows[0]?.n,
      0,
    );
    const url = `${qrPrefix}/entries/treehole/bindings/${descriptor.bindingId}/display-v1`;
    const image = await request(http)
      .get(url)
      .query({ campusId: f.scope.home.campusId, entryRevision: 1 });
    qrOk(image);
    assert.ok(image.headers['cache-control']?.includes('no-store'));
    assert.ok(Buffer.isBuffer(image.body));
    assert.ok(image.body.length > 0);
    qrOk(
      await request(http)
        .get(url)
        .query({ campusId: f.scope.foreign.campusId, entryRevision: 1 }),
      503,
    );
    qrOk(
      await request(http)
        .get(url)
        .set('Authorization', 'Bearer invalid')
        .query({ campusId: f.scope.home.campusId, entryRevision: 1 }),
      401,
    );
    qrOk(
      await request(http)
        .get(url)
        .set('Range', 'bytes=0-5')
        .query({ campusId: f.scope.home.campusId, entryRevision: 1 }),
      503,
    );
    // A successful original command replay is metadata only, not permission to reuse stale QR bytes.
    qrOk(
      await request(http)
        .post(
          `/v1/me/school-configuration/${f.scope.home.regionId}/entries/treehole`,
        )
        .set('Authorization', auth)
        .send(first.command),
    );
    await publishSchoolQr(f, actor, 'treehole', 1, { action: 'keep' }, false);
    qrOk(
      await request(http)
        .get(url)
        .query({ campusId: f.scope.home.campusId, entryRevision: 1 }),
      503,
    );
    qrOk(
      await request(http)
        .get(`${qrPrefix}/entries/treehole/descriptor`)
        .query({ campusId: f.scope.home.campusId, entryRevision: 2 }),
      503,
    );
    await publishSchoolQr(f, actor, 'treehole', 2, { action: 'keep' });
    qrOk(
      await request(http)
        .get(url)
        .query({ campusId: f.scope.home.campusId, entryRevision: 3 }),
    );
    // Replacement preserves the exact old historical receipt but revokes its binding.
    const replacement = await readySchoolQr(f, actor, bytes, 'treehole', 3);
    if (replacement.status.status !== 'ready_unbound')
      throw new Error('Expected ready replacement');
    await publishSchoolQr(f, actor, 'treehole', 3, {
      action: 'replace',
      assetId: replacement.status.assetId,
    });
    qrOk(
      await request(http)
        .get(url)
        .query({ campusId: f.scope.home.campusId, entryRevision: 4 }),
      503,
    );
    const oldRecovery = await request(http)
      .get(`${qrPrefix}/upload-requests/${prepared.input.clientRequestId}`)
      .set('Authorization', auth);
    qrOk(oldRecovery);
    assert.equal(oldRecovery.body.status.status, 'bound_history');
    assert.equal(oldRecovery.body.status.attachmentState, 'detached');
    await publishSchoolQr(f, actor, 'treehole', 4, { action: 'remove' });
    assert.equal(
      (
        await f.pool.query(
          'SELECT qr_binding_id FROM whaleu_school_configuration.entries WHERE region_id=$1 AND entry_key=$2',
          [f.scope.home.regionId, 'treehole'],
        )
      ).rows[0]?.qr_binding_id,
      null,
    );
    const review = await readySchoolQr(f, actor, bytes, 'review');
    if (review.status.status !== 'ready_unbound')
      throw new Error('Expected review ready');
    await publishSchoolQr(f, actor, 'review', 0, {
      action: 'replace',
      assetId: review.status.assetId,
    });
    qrOk(
      await request(http)
        .get(`${qrPrefix}/entries/review/descriptor`)
        .query({ campusId: f.scope.home.campusId, entryRevision: 1 }),
      503,
    );
    const management = await request(http)
      .get(
        `${qrPrefix}/management/regions/${f.scope.home.regionId}/entries/review/descriptor`,
      )
      .set('Authorization', auth)
      .query({ entryRevision: 1 });
    qrOk(management);
    const publicServices = await request(http)
      .get('/v1/school-services')
      .query({ campusId: f.scope.home.campusId });
    qrOk(publicServices);
    assert.ok(
      !JSON.stringify(publicServices.body).includes(management.body.bindingId),
    );
    assert.ok(
      !publicServices.body.entries.some(
        (e: { entryKey: string }) => e.entryKey === 'review',
      ),
    );
    // Default AppModule never inherits the test runtime; it remains honestly unavailable.
    const ordinary = await f.startOrdinaryRuntime();
    qrOk(
      await request(ordinary.getHttpServer())
        .post(`${qrPrefix}/upload-intents`)
        .set('Authorization', auth)
        .send({
          ...prepared.input,
          clientRequestId: randomUUID(),
          entryKey: 'admin',
        }),
      503,
    );
  },
);
test(
  'School Media9 cancellation namespace and current owner CAS reject stale work; delivery checks again after storage staging',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      f = await schoolQrFixture([{ sha256: sha256(bytes), verdict: 'allow' }]);
    t.after(() => f.close());
    const actor = await f.actor();
    const grant = await grantSchool(f, actor);
    const http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const input = {
      protocol: SCHOOL_QR_MEDIA_PROTOCOL,
      clientRequestId: randomUUID(),
      regionId: f.scope.home.regionId,
      entryKey: 'treehole',
      expectedRevision: 0,
      declaration: {
        mime: 'image/png',
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    };
    const hash = schoolQrMediaRequestHash(actor.accountId, input);
    qrOk(
      await request(http)
        .post(`${qrPrefix}/upload-requests/${input.clientRequestId}/cancel`)
        .set('Authorization', auth)
        .send({ protocol: SCHOOL_QR_MEDIA_PROTOCOL, requestHash: hash }),
    );
    qrOk(
      await request(http)
        .post(`${qrPrefix}/upload-intents`)
        .set('Authorization', auth)
        .send(input),
      409,
    );
    qrOk(
      await request(http)
        .get(`/v2/media/upload-requests/${input.clientRequestId}`)
        .set('Authorization', auth),
      409,
    );
    const pending = await request(http)
      .post(`${qrPrefix}/upload-intents`)
      .set('Authorization', auth)
      .send({ ...input, clientRequestId: randomUUID() });
    qrOk(pending);
    await publishSchoolQr(f, actor, 'treehole', 0, { action: 'keep' });
    qrOk(
      await request(http)
        .post(`${qrPrefix}/upload-intents/${pending.body.intentId}/grant`)
        .set('Authorization', auth)
        .send({}),
      409,
    );
    const ready = await readySchoolQr(f, actor, bytes, 'treehole', 1);
    if (ready.status.status !== 'ready_unbound')
      throw new Error('Expected ready');
    await publishSchoolQr(f, actor, 'treehole', 1, {
      action: 'replace',
      assetId: ready.status.assetId,
    });
    const described = await request(http)
      .get(`${qrPrefix}/entries/treehole/descriptor`)
      .query({ campusId: f.scope.home.campusId, entryRevision: 2 });
    qrOk(described);
    const originalOpen = f.storage.openExact.bind(f.storage);
    let changed = false;
    f.storage.openExact = async (object, maximum) => {
      const result = await originalOpen(object, maximum);
      if (!changed) {
        changed = true;
        await publishSchoolQr(
          f,
          actor,
          'treehole',
          2,
          { action: 'keep' },
          false,
        );
      }
      return result;
    };
    const download = await request(http)
      .get(
        `${qrPrefix}/entries/treehole/bindings/${described.body.bindingId}/display-v1`,
      )
      .query({ campusId: f.scope.home.campusId, entryRevision: 2 });
    qrOk(download, 503);
    assert.ok(
      !Buffer.isBuffer(download.body),
      'no image byte body after second-check rejection',
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1`,
        [grant, actor.accountId],
      ),
    );
    qrOk(
      await request(http)
        .post(`${qrPrefix}/upload-intents`)
        .set('Authorization', auth)
        .send({ ...input, clientRequestId: randomUUID(), expectedRevision: 3 }),
      403,
    );
    const recovered = await request(http)
      .get(`${qrPrefix}/upload-requests/${ready.input.clientRequestId}`)
      .set('Authorization', auth);
    qrOk(recovered);
    assert.equal(recovered.body.status.status, 'bound_history');
  },
);
