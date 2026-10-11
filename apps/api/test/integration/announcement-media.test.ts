import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { finished } from 'node:stream/promises';
import sharp from 'sharp';
import request from 'supertest';
import {
  announcementMediaFixture,
  grantAnnouncementSchool,
  createAnnouncementDraft,
  readyAnnouncementImage,
  announcementMediaPrefix as prefix,
  announcementMediaOk as ok,
  announcementMediaContent as content,
} from '../support/media/announcement-runtime-fixture.js';
import {
  ANNOUNCEMENT_MEDIA_PROTOCOL,
  announcementMediaRequestHash,
  announcementDescriptorSchema,
} from '../../src/media/contracts-announcement.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
const picture = (background = '#327799') =>
  sharp({ create: { width: 64, height: 64, channels: 3, background } })
    .png()
    .toBuffer();

test(
  'Announcement Media12 real image Review, optional-guest exact current publication and whole-set Safety recheck around storage',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      f = await announcementMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      other = await f.actor();
    await grantAnnouncementSchool(f, actor);
    const id = await createAnnouncementDraft(f, actor),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const command = (value: object) =>
      request(http)
        .post(`/v1/announcement-management/${id}/commands`)
        .set('Authorization', auth)
        .send(value);
    const images: {
      input: Awaited<ReturnType<typeof readyAnnouncementImage>>['input'];
      status: Extract<
        Awaited<ReturnType<typeof readyAnnouncementImage>>['status'],
        { status: 'ready_unbound' }
      >;
    }[] = [];
    for (const slot of ['gallery0', 'gallery8'] as const) {
      const image = await readyAnnouncementImage(f, actor, id, slot, 1, bytes);
      if (image.status.status !== 'ready_unbound')
        assert.fail('Expected independently reviewed image');
      images.push({ ...image, status: image.status });
    }
    const image = images[0]!;
    assert.equal(
      (
        await f.pool.query(
          'SELECT whaleu_announcements.media_request_hash($1,$2::jsonb) hash',
          [actor.accountId, JSON.stringify(image.input)],
        )
      ).rows[0].hash,
      announcementMediaRequestHash(actor.accountId, image.input),
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT protocol_version,owner_kind,resource_kind,audience,purpose FROM whaleu_media.upload_intents WHERE id=$1',
          [image.status.intentId],
        )
      ).rows[0],
      {
        protocol_version: 12,
        owner_kind: 'announcements',
        resource_kind: 'announcement_image',
        audience: 'announcement-gated',
        purpose: 'announcement-image',
      },
    );
    const changes = Object.fromEntries(
      images.map((v) => [
        v.input.slot,
        { action: 'replace', assetId: v.status.assetId },
      ]),
    );
    ok(
      await command({
        action: 'save',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        content,
        audience: { kind: 'fixed' },
        mediaChanges: changes,
      }),
    );
    const base = `${prefix}/public/announcements/${id}/slots/gallery0`,
      query = { revision: 3, campusId: f.scope.home.campusId };
    assert.notEqual(
      (
        await request(http)
          .get(`${base}/descriptor`)
          .query({ ...query, revision: 2 })
      ).status,
      200,
      'draft is never public',
    );
    ok(
      await command({
        action: 'publish',
        clientRequestId: randomUUID(),
        expectedRevision: 2,
      }),
    );
    const descriptorResponse = await request(http)
      .get(`${base}/descriptor`)
      .query(query);
    ok(descriptorResponse);
    const descriptor = announcementDescriptorSchema.parse(
        descriptorResponse.body,
      ),
      path = `${base}/bindings/${descriptor.bindingId}/display-v1`;
    const guest = await request(http).get(path).query(query);
    ok(guest);
    assert.ok(Buffer.isBuffer(guest.body));
    assert.equal(guest.headers['cache-control'], 'private, no-store');
    for (const header of ['Bearer bad', 'Basic bad'])
      assert.notEqual(
        (
          await request(http)
            .get(path)
            .set('Authorization', header)
            .query(query)
        ).status,
        200,
      );
    assert.notEqual(
      (
        await request(http)
          .get(path)
          .query({ ...query, campusId: randomUUID() })
      ).status,
      200,
    );
    assert.notEqual(
      (
        await request(http)
          .get(path)
          .query({ ...query, revision: 2 })
      ).status,
      200,
    );
    assert.notEqual(
      (await request(http).get(path).set('Range', 'bytes=0-1').query(query))
        .status,
      200,
    );
    assert.notEqual(
      (
        await request(http)
          .get(
            `${prefix}/management/announcements/${id}/slots/gallery0/descriptor`,
          )
          .set('Authorization', `Bearer ${other.accessToken}`)
          .query({ revision: 3 })
      ).status,
      200,
    );
    // Exact original receipt survives public use and cancel never removes a binding.
    const cancelled = await request(http)
      .post(`${prefix}/upload-intents/${image.status.intentId}/cancel`)
      .set('Authorization', auth)
      .send({});
    ok(cancelled);
    assert.equal(cancelled.body.status, 'bound_history');
    const original = f.storage.openExact.bind(f.storage);
    let bytesReleased = 0,
      close = Promise.resolve(),
      opened!: () => void,
      release!: () => void;
    const entered = new Promise<void>((r) => {
        opened = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    f.storage.openExact = async (...args) => {
      const result = await original(...args);
      result.stream.pause();
      close = finished(result.stream).catch(() => undefined);
      result.stream.on('data', (chunk: Buffer) => {
        bytesReleased += chunk.length;
      });
      opened();
      await gate;
      return result;
    };
    const delivery = request(http)
      .get(path)
      .query(query)
      .then((v) => v);
    try {
      await Promise.race([
        entered,
        delivery.then(() => assert.fail('must wait at storage')),
      ]);
      assert.equal(bytesReleased, 0);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const event = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,2,'revoked',a.manifest_digest,a.policy_revision,'announcement-test',$1::text,'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a WHERE a.id=$2`,
          [event, images[1]!.status.assetId],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=2,event_id=$2 WHERE asset_id=$1',
          [images[1]!.status.assetId, event],
        );
      });
    } finally {
      release();
      f.storage.openExact = original;
    }
    const denied = await delivery;
    await close;
    assert.notEqual(denied.status, 200);
    assert.equal(bytesReleased, 0);
    assert.ok(!Buffer.isBuffer(denied.body));
    ok(
      await command({
        action: 'set_enabled',
        clientRequestId: randomUUID(),
        expectedRevision: 3,
        enabled: false,
      }),
    );
    assert.notEqual((await request(http).get(path).query(query)).status, 200);
    assert.notEqual(
      (
        await command({
          action: 'set_enabled',
          clientRequestId: randomUUID(),
          expectedRevision: 4,
          enabled: true,
        })
      ).status,
      200,
      're-enable requires fresh independent image Safety',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_announcements.native_publications WHERE announcement_id=$1',
          [id],
        )
      ).rows[0].n,
      4,
    );
  },
);

test(
  'Announcement original-key cancellation, CAS stale images and own unpublished draft cleanup retain immutable history',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture('#999966'),
      f = await announcementMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor();
    const grant = await grantAnnouncementSchool(f, actor);
    const id = await createAnnouncementDraft(f, actor),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const command = (value: object) =>
      request(http)
        .post(`/v1/announcement-management/${id}/commands`)
        .set('Authorization', auth)
        .send(value);
    const input = {
        protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
        clientRequestId: randomUUID(),
        announcementId: id,
        slot: 'gallery8',
        revision: 1,
        declaration: {
          mime: 'image/png',
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      },
      hash = announcementMediaRequestHash(actor.accountId, input);
    const cancel = await request(http)
      .post(`${prefix}/upload-requests/${input.clientRequestId}/cancel`)
      .set('Authorization', auth)
      .send({ protocol: ANNOUNCEMENT_MEDIA_PROTOCOL, requestHash: hash });
    ok(cancel);
    assert.equal(cancel.body.state, 'cancelled_before_prepare');
    assert.notEqual(
      (
        await request(http)
          .post(`${prefix}/upload-intents`)
          .set('Authorization', auth)
          .send(input)
      ).status,
      200,
    );
    assert.notEqual(
      (
        await request(http)
          .post(`${prefix}/upload-requests/${input.clientRequestId}/cancel`)
          .set('Authorization', auth)
          .send({
            protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
            requestHash: 'b'.repeat(64),
          })
      ).status,
      200,
    );
    const stale = await readyAnnouncementImage(
        f,
        actor,
        id,
        'gallery8',
        1,
        bytes,
      ),
      image = await readyAnnouncementImage(f, actor, id, 'gallery0', 1, bytes);
    if (
      image.status.status !== 'ready_unbound' ||
      stale.status.status !== 'ready_unbound'
    )
      assert.fail('Expected reviewed images');
    ok(
      await command({
        action: 'save',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        content,
        audience: { kind: 'fixed' },
        mediaChanges: {
          gallery0: { action: 'replace', assetId: image.status.assetId },
        },
      }),
    );
    assert.notEqual(
      (
        await command({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          content,
          audience: { kind: 'fixed' },
          mediaChanges: {
            gallery8: { action: 'replace', assetId: stale.status.assetId },
          },
        })
      ).status,
      200,
    );
    const stored = (
      await f.pool.query(
        'SELECT media_bindings FROM whaleu_announcements.native_announcements WHERE id=$1',
        [id],
      )
    ).rows[0].media_bindings;
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await f.announcementMedia.retireDraft(
          {
            actorAccountId: actor.accountId,
            announcementId: id,
            revision: 2,
            currentBindings: stored,
          },
          tx,
        );
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      }),
    );
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
        [grant],
      ),
    );
    ok(
      await command({
        action: 'cancel_draft',
        clientRequestId: randomUUID(),
        expectedRevision: 2,
      }),
    );
    const recovery = await request(http)
      .get(`${prefix}/upload-intents/${image.status.intentId}`)
      .set('Authorization', auth);
    ok(recovery);
    assert.equal(recovery.body.status, 'bound_history');
    assert.equal(recovery.body.attachmentState, 'detached');
    const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
    for (let i = 0; i < 12; i++) {
      const result = await cleanup.runOne();
      if (result === 'idle') break;
      assert.notEqual(result, 'retryable');
    }
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_announcements.native_publications WHERE announcement_id=$1',
          [id],
        )
      ).rows[0].n,
      3,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_announcements.media_retirements WHERE announcement_id=$1',
          [id],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_media.upload_request_fences WHERE actor_id=$1',
          [actor.accountId],
        )
      ).rows[0].n,
      3,
    );
    const again = await request(http)
      .post(`${prefix}/upload-intents`)
      .set('Authorization', auth)
      .send(image.input);
    ok(again);
    assert.equal(again.body.status, 'bound_history');
    assert.equal(again.body.attachmentState, 'detached');
  },
);

test(
  'Announcement permits nine gallery images without cover, rejects tenth slot, and scope changes never revive an older media reference',
  { timeout: 300000 },
  async (t) => {
    const bytes = await picture('#779966'),
      f = await announcementMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor({
      affiliation: 'unverified',
      phone: 'unverified',
      identity: false,
    });
    await grantAnnouncementSchool(f, actor);
    const id = await createAnnouncementDraft(f, actor),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const command = (v: object) =>
      request(http)
        .post(`/v1/announcement-management/${id}/commands`)
        .set('Authorization', auth)
        .send(v);
    const changes: Record<string, { action: 'replace'; assetId: string }> = {};
    for (let n = 0; n < 9; n++) {
      const slot =
        `gallery${n}` as import('../../src/media/contracts-announcement.js').AnnouncementMediaSlot;
      const image = await readyAnnouncementImage(f, actor, id, slot, 1, bytes);
      if (image.status.status !== 'ready_unbound')
        assert.fail('Expected nine reviewed optional images');
      changes[slot] = { action: 'replace', assetId: image.status.assetId };
    }
    for (const slot of ['cover', 'gallery9'])
      ok(
        await request(http)
          .post(`${prefix}/upload-intents`)
          .set('Authorization', auth)
          .send({
            protocol: ANNOUNCEMENT_MEDIA_PROTOCOL,
            clientRequestId: randomUUID(),
            announcementId: id,
            slot,
            revision: 1,
            declaration: {
              mime: 'image/png',
              bytes: bytes.length,
              sha256: sha256(bytes),
            },
          }),
        400,
      );
    ok(
      await command({
        action: 'save',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        content,
        audience: { kind: 'fixed' },
        mediaChanges: changes,
      }),
    );
    ok(
      await command({
        action: 'publish',
        clientRequestId: randomUUID(),
        expectedRevision: 2,
      }),
    );
    const base = `${prefix}/public/announcements/${id}/slots/gallery8`;
    const old = await request(http)
      .get(`${base}/descriptor`)
      .query({ revision: 3, campusId: f.scope.home.campusId });
    ok(old);
    await grantAnnouncementSchool(f, actor, 'super_admin');
    ok(
      await command({
        action: 'update',
        clientRequestId: randomUUID(),
        expectedRevision: 3,
        content,
        audience: { kind: 'all' },
        mediaChanges: {},
      }),
    );
    assert.notEqual(
      (
        await request(http)
          .get(`${base}/bindings/${old.body.bindingId}/display-v1`)
          .query({ revision: 3, campusId: f.scope.home.campusId })
      ).status,
      200,
    );
    const global = await request(http)
      .get(`${base}/descriptor`)
      .query({ revision: 4 });
    ok(global);
    assert.equal(global.body.bindingId, old.body.bindingId);
    ok(
      await request(http)
        .get(`${base}/bindings/${global.body.bindingId}/display-v1`)
        .query({ revision: 4 }),
    );
    assert.equal(
      Object.values(
        (
          await f.pool.query(
            'SELECT media_bindings FROM whaleu_announcements.native_announcements WHERE id=$1',
            [id],
          )
        ).rows[0].media_bindings,
      ).filter(Boolean).length,
      9,
    );
    const initialBindings = (
      await f.pool.query(
        'SELECT media_bindings FROM whaleu_announcements.native_announcements WHERE id=$1',
        [id],
      )
    ).rows[0].media_bindings as Record<string, string | null>;
    const replacement = await readyAnnouncementImage(
      f,
      actor,
      id,
      'gallery0',
      4,
      bytes,
    );
    if (replacement.status.status !== 'ready_unbound')
      assert.fail('Replacement must pass independent Review');
    ok(
      await command({
        action: 'update',
        clientRequestId: randomUUID(),
        expectedRevision: 4,
        content,
        audience: { kind: 'all' },
        mediaChanges: {
          gallery0: { action: 'replace', assetId: replacement.status.assetId },
          gallery1: { action: 'remove' },
        },
      }),
    );
    const updatedBindings = (
      await f.pool.query(
        'SELECT media_bindings FROM whaleu_announcements.native_announcements WHERE id=$1',
        [id],
      )
    ).rows[0].media_bindings as Record<string, string | null>;
    assert.notEqual(updatedBindings['gallery0'], initialBindings['gallery0']);
    assert.equal(updatedBindings['gallery1'], null);
    for (let n = 2; n < 9; n++)
      assert.equal(
        updatedBindings[`gallery${n}`],
        initialBindings[`gallery${n}`],
      );
    assert.equal(Object.values(updatedBindings).filter(Boolean).length, 8);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_announcements.media_retirements WHERE announcement_id=$1',
          [id],
        )
      ).rows[0].n,
      2,
    );
    assert.notEqual(
      (
        await request(http)
          .get(
            `${prefix}/public/announcements/${id}/slots/gallery0/bindings/${initialBindings['gallery0']}/display-v1`,
          )
          .query({ revision: 5 })
      ).status,
      200,
    );
    assert.notEqual(
      (
        await request(http)
          .get(
            `${prefix}/public/announcements/${id}/slots/gallery1/bindings/${initialBindings['gallery1']}/display-v1`,
          )
          .query({ revision: 5 })
      ).status,
      200,
    );
    const race = async (revision: number, change: () => Promise<unknown>) => {
      const original = f.storage.openExact.bind(f.storage);
      let transferred = 0,
        quiet = Promise.resolve(),
        opened!: () => void,
        release!: () => void;
      const entered = new Promise<void>((resolve) => {
          opened = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      f.storage.openExact = async (...args) => {
        const value = await original(...args);
        value.stream.pause();
        quiet = finished(value.stream).catch(() => undefined);
        value.stream.on('data', (chunk: Buffer) => {
          transferred += chunk.length;
        });
        opened();
        await gate;
        return value;
      };
      const pending = request(http)
        .get(`${base}/bindings/${global.body.bindingId}/display-v1`)
        .query({ revision })
        .then((v) => v);
      try {
        await Promise.race([
          entered,
          pending.then(() =>
            assert.fail('must stop before bytes while current owner changes'),
          ),
        ]);
        await change();
        assert.equal(transferred, 0);
      } finally {
        release();
        f.storage.openExact = original;
      }
      const denied = await pending;
      await quiet;
      assert.notEqual(denied.status, 200);
      assert.ok(!Buffer.isBuffer(denied.body));
      assert.equal(transferred, 0);
    };
    await race(5, async () =>
      ok(
        await command({
          action: 'set_enabled',
          clientRequestId: randomUUID(),
          expectedRevision: 5,
          enabled: false,
        }),
      ),
    );
    ok(
      await command({
        action: 'set_enabled',
        clientRequestId: randomUUID(),
        expectedRevision: 6,
        enabled: true,
      }),
    );
    assert.notEqual(
      (
        await request(http)
          .get(`${base}/bindings/${global.body.bindingId}/display-v1`)
          .query({ revision: 5 })
      ).status,
      200,
      're-enable cannot revive an older revision',
    );
    await race(7, async () =>
      ok(
        await command({
          action: 'update',
          clientRequestId: randomUUID(),
          expectedRevision: 7,
          content,
          audience: { kind: 'regions', regionIds: [f.scope.foreign.regionId] },
          mediaChanges: {},
        }),
      ),
    );
    assert.notEqual(
      (
        await request(http)
          .get(`${base}/bindings/${global.body.bindingId}/display-v1`)
          .query({ revision: 8, campusId: f.scope.home.campusId })
      ).status,
      200,
    );
    ok(
      await request(http)
        .get(`${base}/bindings/${global.body.bindingId}/display-v1`)
        .query({ revision: 8, campusId: f.scope.foreign.campusId }),
    );
  },
);
