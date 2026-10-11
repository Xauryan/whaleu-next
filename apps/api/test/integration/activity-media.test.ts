import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { finished } from 'node:stream/promises';
import type { ActivityPublicationFixture } from '../support/activity-publication-fixture.js';
import sharp from 'sharp';
import request from 'supertest';
import {
  activityPublicationFixture,
  approvedActivityOrganizer,
  createActivityDraft,
} from '../support/activity-publication-fixture.js';
import {
  readyActivityImage,
  activityMediaPrefix as prefix,
  activityMediaOk as ok,
} from '../support/media/activity-runtime-fixture.js';
import {
  ACTIVITY_MEDIA_PROTOCOL,
  activityDescriptorSchema,
  activityMediaRequestHash,
  activityMediaSlotSchema,
} from '../../src/media/contracts-activity.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { activityMediaBindingsSchema } from '../../src/activities/media/contracts.js';
import {
  activityReviewEnvelopeSchema,
  activityReviewDigest,
  publicationCommandHash,
} from '../../src/activities/publication/contracts.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import type { ExactObject } from '../../src/media/contracts.js';
const api = '/v1/activity-publication';
/** Observe the real shared rolling quota, then wait for an actual slot to age
 * out. Never change clocks, erase receipts, or weaken the production limiter. */
async function waitMediaRequestCapacity(
  f: ActivityPublicationFixture,
  actor: string,
) {
  const row = (
    await f.pool.query<{ wait_ms: number }>(
      `SELECT CASE WHEN count(*)>=10 THEN greatest(1,ceil(extract(epoch FROM (min(created_at)+interval '1 minute'-clock_timestamp()))*1000))::integer ELSE 0 END wait_ms FROM (SELECT actor_id,created_at FROM whaleu_media.upload_request_fences UNION ALL SELECT actor_id,created_at FROM whaleu_media.ratings_discussion_batch_request_fences) requests WHERE actor_id=$1 AND created_at>clock_timestamp()-interval '1 minute' AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [actor],
    )
  ).rows[0]!;
  if (row.wait_ms > 0) await delay(row.wait_ms + 25);
}

const picture = (background = '#2a6677') =>
  sharp({ create: { width: 64, height: 64, channels: 3, background } })
    .png()
    .toBuffer();
const content = {
  title: '活动独立媒体测试',
  description: '真实媒体生命周期与精确发布审图',
  types: ['online'] as const,
  activityTime: '',
  activityLocation: '',
  endAt: null,
  showOrganizerQr: false,
};
test(
  'Closing an original unpublished draft after role loss retires only its bindings and waits for real cleanup quiescence',
  { timeout: 300000 },
  async (t) => {
    const bytes = await picture(),
      f = await activityPublicationFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      recipient = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, bytes),
      draft = await createActivityDraft(f, actor, org, {
        ...content,
        types: ['online'],
      }),
      publishedDraft = await createActivityDraft(f, actor, org, {
        ...content,
        types: ['online'],
      }),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const command = (activityId: string, value: object, token = auth) =>
      request(http)
        .post(`${api}/drafts/${activityId}/commands`)
        .set('Authorization', token)
        .send(value);
    const images = [];
    for (const slot of ['cover', 'gallery0'] as const) {
      const image = await readyActivityImage(
        f,
        actor,
        draft.id,
        slot,
        1,
        bytes,
      );
      if (image.status.status !== 'ready_unbound')
        assert.fail('Expected ready image');
      images.push({ input: image.input, status: image.status });
    }
    const save = {
      action: 'save',
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      content: draft.content,
      mediaChanges: Object.fromEntries(
        images.map((image) => [
          image.input.slot,
          { action: 'replace', assetId: image.status.assetId },
        ]),
      ),
    };
    const saved = await command(draft.id, save);
    ok(saved);
    const currentBindings = activityMediaBindingsSchema.parse(
      (
        await f.pool.query(
          'SELECT media_bindings FROM whaleu_activities.publication_drafts WHERE id=$1',
          [draft.id],
        )
      ).rows[0].media_bindings,
    );
    // Even the trusted media operation cannot detach without the exact owner
    // cancellation event, final cleared pointer set and original receipt.
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await f.activityMedia.retireDraft(
          {
            actorAccountId: actor.accountId,
            activityId: draft.id,
            revision: 2,
            currentBindings,
          },
          tx,
        );
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      }),
      /retirement requires exact atomic/,
    );
    const live = await readyActivityImage(
      f,
      actor,
      publishedDraft.id,
      'cover',
      1,
      bytes,
    );
    if (live.status.status !== 'ready_unbound')
      assert.fail('Expected live image');
    ok(
      await command(publishedDraft.id, {
        action: 'save',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
        content: publishedDraft.content,
        mediaChanges: {
          cover: { action: 'replace', assetId: live.status.assetId },
        },
      }),
    );
    const publish = {
      action: 'publish',
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
    ok(await command(publishedDraft.id, publish));
    assert.equal((await f.reviewProcessor.processOne()).state, 'reviewed');
    ok(await command(publishedDraft.id, publish));
    for (const person of [actor, recipient])
      ok(
        await request(http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${person.accessToken}`)
          .send({ expectedRevision: 0, nickname: '活动媒体原发布者' }),
      );
    const profile = async (id: string) =>
      (
        await f.pool.query<{ id: string }>(
          'SELECT public_id id FROM whaleu_profile.profiles WHERE account_id=$1',
          [id],
        )
      ).rows[0]!.id;
    ok(
      await request(http)
        .post(`/v1/organizations/${org.id}/members`)
        .set('Authorization', auth)
        .send({
          action: 'transfer_owner',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 2,
          targetProfileId: await profile(recipient.accountId),
        }),
    );
    ok(
      await request(http)
        .post(`/v1/organizations/${org.id}/members`)
        .set('Authorization', `Bearer ${recipient.accessToken}`)
        .send({
          action: 'remove_admin',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 3,
          targetProfileId: await profile(actor.accountId),
        }),
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents`)
        .set('Authorization', auth)
        .send({
          ...images[0]!.input,
          revision: 2,
          clientRequestId: randomUUID(),
        }),
      403,
    );
    const close = {
      action: 'cancel_draft',
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
    ok(await command(draft.id, close, `Bearer ${recipient.accessToken}`), 403);
    const cancelled = await command(draft.id, close);
    ok(cancelled);
    assert.equal(cancelled.body.outcome, 'draft_cancelled');
    assert.deepEqual((await command(draft.id, close)).body, cancelled.body);
    const closed = (
      await f.pool.query<{
        state: string;
        revision: string;
        media_bindings: Record<string, string | null>;
      }>(
        'SELECT state,revision,media_bindings FROM whaleu_activities.publication_drafts WHERE id=$1',
        [draft.id],
      )
    ).rows[0]!;
    assert.equal(closed.state, 'cancelled');
    assert.equal(closed.revision, '2');
    assert.ok(
      Object.values(closed.media_bindings).every((value) => value === null),
    );
    const retired = (
      await f.pool.query<{
        detached_at: Date;
        detach_reason: string;
        revision: string;
        active: string;
      }>(
        `SELECT b.detached_at,b.detach_reason,r.revision,(SELECT count(*)::text FROM whaleu_media.bindings live WHERE live.asset_id=b.asset_id AND live.detached_at IS NULL) active FROM whaleu_activities.media_retirements r JOIN whaleu_media.bindings b ON b.id=r.binding_id WHERE r.activity_id=$1`,
        [draft.id],
      )
    ).rows;
    assert.equal(retired.length, 2);
    assert.ok(
      retired.every(
        (row) =>
          row.detached_at &&
          row.detach_reason === 'activity-draft-cancelled' &&
          row.revision === '2' &&
          row.active === '0',
      ),
    );
    for (const image of images) {
      const recovered = await request(http)
        .get(`${prefix}/upload-requests/${image.input.clientRequestId}`)
        .set('Authorization', auth);
      ok(recovered);
      assert.equal(recovered.body.status.status, 'bound_history');
      assert.equal(recovered.body.status.attachmentState, 'detached');
      const denied = await request(http)
        .get(
          `${prefix}/management/activities/${draft.id}/slots/${image.input.slot}/bindings/${currentBindings[image.input.slot]}/display-v1`,
        )
        .set('Authorization', auth)
        .query({ revision: 2 });
      assert.ok([403, 409, 503].includes(denied.status));
      assert.ok(!Buffer.isBuffer(denied.body));
    }
    const historical = await request(http)
      .get(`${api}/requests/${save.clientRequestId}`)
      .set('Authorization', auth);
    ok(historical);
    assert.equal(historical.body.state, 'recorded');
    assert.deepEqual(historical.body.receipt, saved.body);
    const assets = images.map((image) => image.status.assetId),
      intents = images.map((image) => image.status.intentId);
    const variants = (
      await f.pool.query<ExactObject>(
        'SELECT provider,environment,bucket,object_key key,object_version version FROM whaleu_media.variants WHERE asset_id=ANY($1::uuid[])',
        [assets],
      )
    ).rows;
    assert.equal(variants.length, 4);
    for (const object of variants)
      assert.ok((await f.storage.measure(object)).bytes > 0);
    assert.equal(
      (
        await f.pool.query(
          `SELECT 1 FROM whaleu_media.upload_intents WHERE id=ANY($1::uuid[]) AND state<>'cleanup_pending'`,
          [intents],
        )
      ).rowCount,
      0,
    );
    const obligations = `FROM whaleu_media.cleanup_obligations c LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=ANY($1::uuid[])`;
    const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
    // Already-stopped ingress scratch has its own earlier deadline. Drain only
    // those original due obligations; image objects retain their two-minute wait.
    for (let n = 0; n < 16; n++) {
      const result = await cleanup.runOne();
      if (result === 'idle') break;
      assert.equal(result, 'deleted');
      assert.ok(n < 15);
    }
    for (const object of variants)
      assert.ok((await f.storage.measure(object)).bytes > 0);
    assert.equal(
      (
        await f.pool.query(
          `SELECT 1 ${obligations} AND c.ingress_writer_id IS NULL AND c.state<>'pending'`,
          [intents],
        )
      ).rowCount,
      0,
    );
    const deadline = (
      await f.pool.query<{ wait_ms: number; count: number; quiet: boolean }>(
        `SELECT greatest(0,ceil(extract(epoch FROM(max(c.not_before)-clock_timestamp()))*1000))::integer wait_ms,count(*)::integer count,bool_and(c.ingress_writer_id IS NOT NULL OR c.not_before>=c.created_at+interval '119 seconds') quiet ${obligations}`,
        [intents],
      )
    ).rows[0]!;
    assert.ok(deadline.count >= 8 && deadline.quiet && deadline.wait_ms > 0);
    // Wait the actual persisted original deadline, then let the existing
    // collector establish its own process-local stopped-writer proof and delete.
    await delay(deadline.wait_ms + 30);
    for (let n = 0; n < 64; n++) {
      const result = await cleanup.runOne();
      if (result === 'idle') break;
      assert.equal(result, 'deleted');
      assert.ok(n < 63, 'Cleanup must drain its bounded obligations');
    }
    assert.equal(
      (
        await f.pool.query(`SELECT 1 ${obligations} AND c.state<>'deleted'`, [
          intents,
        ])
      ).rowCount,
      0,
    );
    for (const object of variants)
      await assert.rejects(f.storage.openExact(object, 5 * 1024 * 1024), {
        code: 'ENOENT',
      });
    for (const image of images) {
      const recovered = await request(http)
        .get(`${prefix}/upload-requests/${image.input.clientRequestId}`)
        .set('Authorization', auth);
      ok(recovered);
      assert.equal(recovered.body.status.status, 'bound_history');
      assert.equal(recovered.body.status.attachmentState, 'detached');
    }
    ok(
      await command(publishedDraft.id, {
        ...close,
        clientRequestId: randomUUID(),
      }),
      403,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1 AND detached_at IS NULL',
          [live.status.assetId],
        )
      ).rowCount,
      1,
    );
    const publicCover = await request(http)
      .get(
        `${prefix}/public/activities/${publishedDraft.id}/slots/cover/descriptor`,
      )
      .set('Authorization', `Bearer ${recipient.accessToken}`)
      .query({ revision: 2 });
    ok(publicCover);
    ok(
      await request(http)
        .get(
          `${prefix}/public/activities/${publishedDraft.id}/slots/cover/bindings/${publicCover.body.bindingId}/display-v1`,
        )
        .set('Authorization', `Bearer ${recipient.accessToken}`)
        .query({ revision: 2 }),
    );
    const qrPath = `/v3/media/organizations/public/organizations/${org.id}/slots/mainQr`;
    const qr = await request(http)
      .get(`${qrPath}/descriptor`)
      .set('Authorization', `Bearer ${recipient.accessToken}`)
      .query({ applicationRevision: 2 });
    ok(qr);
    ok(
      await request(http)
        .get(`${qrPath}/bindings/${qr.body.bindingId}/display-v1`)
        .set('Authorization', `Bearer ${recipient.accessToken}`)
        .query({ applicationRevision: 2 }),
    );
  },
);
test(
  'Activity Media11 binds all ten distinct own slots, rejects cross-owner use, retires replacements and serves exact public reviewed bytes',
  { timeout: 300000 },
  async (t) => {
    const bytes = await picture(),
      f = await activityPublicationFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      other = await f.actor();
    const org = await approvedActivityOrganizer(f, actor, reviewer, bytes),
      draft = await createActivityDraft(f, actor, org, {
        ...content,
        types: ['online'],
      });
    const http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const ready = [];
    for (const slot of activityMediaSlotSchema.options) {
      await waitMediaRequestCapacity(f, actor.accountId);
      const value = await readyActivityImage(
        f,
        actor,
        draft.id,
        slot,
        1,
        bytes,
      );
      if (value.status.status !== 'ready_unbound')
        assert.fail(
          `Expected current ${slot}: ${JSON.stringify(value.status)}`,
        );
      ready.push({ input: value.input, status: value.status });
    }
    const exactUploads = await f.pool.query<{
      scopes: number;
      intents: number;
      requests: number;
    }>(
      `SELECT (SELECT count(*)::integer FROM whaleu_activities.media_upload_scopes WHERE activity_id=$1) scopes,(SELECT count(*)::integer FROM whaleu_media.upload_intents WHERE owner_kind='activities' AND actor_id=$2) intents,(SELECT count(*)::integer FROM whaleu_media.upload_request_fences f JOIN whaleu_activities.media_upload_scopes s ON(s.actor_id,s.client_request_id)=(f.actor_id,f.client_request_id) WHERE s.activity_id=$1) requests`,
      [draft.id, actor.accountId],
    );
    assert.deepEqual(exactUploads.rows[0], {
      scopes: 10,
      intents: 10,
      requests: 10,
    });
    assert.equal(
      (
        await f.pool.query<{ hash: string }>(
          'SELECT whaleu_activities.media_request_hash($1,$2::jsonb) hash',
          [actor.accountId, JSON.stringify(ready[0]!.input)],
        )
      ).rows[0]!.hash,
      activityMediaRequestHash(actor.accountId, ready[0]!.input),
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT protocol_version,owner_kind,resource_kind,audience,purpose FROM whaleu_media.upload_intents WHERE id=$1',
          [ready[0]!.status.intentId],
        )
      ).rows[0],
      {
        protocol_version: 11,
        owner_kind: 'activities',
        resource_kind: 'activity_image',
        audience: 'activity-gated',
        purpose: 'activity-image',
      },
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ ...ready[0]!.input, clientRequestId: randomUUID() }),
      403,
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents`)
        .set('Authorization', auth)
        .send({
          ...ready[0]!.input,
          clientRequestId: randomUUID(),
          slot: 'gallery9',
        }),
      400,
    );
    const command = (id: string, input: object) =>
      request(http)
        .post(`${api}/drafts/${id}/commands`)
        .set('Authorization', auth)
        .send(input);
    const save = (revision: number, mediaChanges: unknown) => ({
      action: 'save',
      clientRequestId: randomUUID(),
      expectedRevision: revision,
      content,
      mediaChanges,
    });
    const cross = await command(
      draft.id,
      save(1, {
        gallery0: { action: 'replace', assetId: ready[0]!.status.assetId },
      }),
    );
    ok(cross, 409);
    assert.equal(cross.body.error.code, 'MEDIA_NOT_READY');
    const another = await createActivityDraft(f, actor, org, {
      ...content,
      types: ['online'],
    });
    ok(
      await command(
        another.id,
        save(1, {
          cover: { action: 'replace', assetId: ready[0]!.status.assetId },
        }),
      ),
      409,
    );
    const changes = Object.fromEntries(
      ready.map((v) => [
        v.input.slot,
        { action: 'replace', assetId: v.status.assetId },
      ]),
    );
    ok(await command(draft.id, save(1, changes)));
    const descriptorPath = (audience: string, slot: string) =>
      `${prefix}/${audience}/activities/${draft.id}/slots/${slot}/descriptor`;
    const described = await request(http)
      .get(descriptorPath('management', 'cover'))
      .set('Authorization', auth)
      .query({ revision: 2 });
    ok(described);
    const descriptor = activityDescriptorSchema.parse(described.body);
    ok(
      await request(http)
        .get(descriptorPath('public', 'cover'))
        .set('Authorization', auth)
        .query({ revision: 2 }),
      404,
    );
    ok(
      await request(http)
        .get(descriptorPath('management', 'cover'))
        .set('Authorization', `Bearer ${other.accessToken}`)
        .query({ revision: 2 }),
      403,
    );
    ok(
      await request(http)
        .get(descriptorPath('management', 'cover'))
        .query({ revision: 2 }),
      401,
    );
    const imagePath = (audience: string, binding: string) =>
      `${prefix}/${audience}/activities/${draft.id}/slots/cover/bindings/${binding}/display-v1`;
    const image = await request(http)
      .get(imagePath('management', descriptor.bindingId))
      .set('Authorization', auth)
      .query({ revision: 2 });
    ok(image);
    assert.ok(Buffer.isBuffer(image.body) && image.body.length > 0);
    assert.ok(image.headers['cache-control']?.includes('no-store'));
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    ok(
      await request(http)
        .get(imagePath('management', descriptor.bindingId))
        .set('Authorization', auth)
        .set('Range', 'bytes=0-5')
        .query({ revision: 2 }),
      503,
    );
    await waitMediaRequestCapacity(f, actor.accountId);
    const replacement = await readyActivityImage(
      f,
      actor,
      draft.id,
      'cover',
      2,
      bytes,
    );
    if (replacement.status.status !== 'ready_unbound')
      assert.fail('Expected replacement');
    const replacementAssetId = replacement.status.assetId;
    // A forged raw save must not consume this genuine ready replacement while
    // issuing a receipt for a command that requested all slots to remain kept.
    const originalSave = {
      action: 'save' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
      content: { ...content, types: ['online' as const] },
      mediaChanges: {},
    };
    const originalHash = publicationCommandHash(
      actor.accountId,
      draft.id,
      originalSave,
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          'INSERT INTO whaleu_activities.publication_requests(actor_id,client_request_id,activity_id,request_hash,command) VALUES($1,$2,$3,$4,$5::jsonb)',
          [
            actor.accountId,
            originalSave.clientRequestId,
            draft.id,
            originalHash,
            JSON.stringify(originalSave),
          ],
        );
        const currentBindings = activityMediaBindingsSchema.parse(
          (
            await tx.query<{ media_bindings: unknown }>(
              'SELECT media_bindings FROM whaleu_activities.publication_drafts WHERE id=$1',
              [draft.id],
            )
          ).rows[0]!.media_bindings,
        );
        const wrongBindings = await f.activityMedia.mutate(
            {
              actorAccountId: actor.accountId,
              activityId: draft.id,
              revision: 2,
              currentBindings,
              changes: {
                cover: { action: 'replace', assetId: replacementAssetId },
              },
            },
            tx,
          ),
          event = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_activities.publication_events(id,activity_id,actor_id,client_request_id,action,revision,content,media_bindings) VALUES($1,$2,$3,$4,'save',3,$5::jsonb,$6::jsonb)`,
          [
            event,
            draft.id,
            actor.accountId,
            originalSave.clientRequestId,
            JSON.stringify(content),
            JSON.stringify(wrongBindings),
          ],
        );
        await tx.query(
          'UPDATE whaleu_activities.publication_drafts SET revision=3,media_bindings=$2::jsonb,updated_at=transaction_timestamp() WHERE id=$1',
          [draft.id, JSON.stringify(wrongBindings)],
        );
        const receipt = {
          requestId: originalSave.clientRequestId,
          requestHash: originalHash,
          activityId: draft.id,
          revision: 3,
          outcome: 'saved',
        };
        await tx.query(
          'INSERT INTO whaleu_activities.publication_receipts(actor_id,client_request_id,request_hash,activity_id,event_id,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
          [
            actor.accountId,
            originalSave.clientRequestId,
            originalHash,
            draft.id,
            event,
            JSON.stringify(receipt),
          ],
        );
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      }),
      /binding must implement exact original slot change/,
    );
    ok(
      await command(
        draft.id,
        save(2, {
          cover: { action: 'replace', assetId: replacement.status.assetId },
          gallery8: { action: 'remove' },
        }),
      ),
    );
    ok(
      await request(http)
        .get(imagePath('management', descriptor.bindingId))
        .set('Authorization', auth)
        .query({ revision: 3 }),
      503,
    );
    const historical = await request(http)
      .get(`${prefix}/upload-intents/${ready[0]!.status.intentId}`)
      .set('Authorization', auth);
    ok(historical);
    assert.equal(historical.body.status, 'bound_history');
    assert.equal(historical.body.attachmentState, 'detached');
    const publish = {
      action: 'publish',
      clientRequestId: randomUUID(),
      expectedRevision: 3,
    };
    const pending = await command(draft.id, publish);
    ok(pending);
    assert.equal(pending.body.state, 'pending');
    assert.equal((await f.reviewProcessor.processOne()).state, 'reviewed');
    const published = await command(draft.id, publish);
    ok(published);
    assert.equal(published.body.outcome, 'published');
    const publicDescriptor = await request(http)
      .get(descriptorPath('public', 'cover'))
      .set('Authorization', `Bearer ${other.accessToken}`)
      .query({ revision: 3 });
    ok(publicDescriptor);
    const current = activityDescriptorSchema.parse(publicDescriptor.body);
    assert.notEqual(current.bindingId, descriptor.bindingId);
    const delivered = await request(http)
      .get(imagePath('public', current.bindingId))
      .set('Authorization', `Bearer ${other.accessToken}`)
      .query({ revision: 3 });
    ok(delivered);
    assert.ok(Buffer.isBuffer(delivered.body));
    const publication = (
        await f.pool.query<{
          media_bindings: Record<string, string | null>;
          show_organizer_qr: boolean;
          organizer_qr: unknown;
        }>(
          `SELECT media_bindings,(content->>'showOrganizerQr')::boolean show_organizer_qr,organizer_qr FROM whaleu_activities.native_activities WHERE id=$1`,
          [draft.id],
        )
      ).rows[0]!,
      stored = publication.media_bindings;
    assert.equal(Object.values(stored).filter(Boolean).length, 9);
    assert.equal(stored['gallery8'], null);
    // Revoke a different, still-bound gallery asset after cover storage opens.
    // The second check covers the whole published set, so no cover bytes escape.
    const otherSlotAssetId = ready[1]!.status.assetId;
    const original = f.storage.openExact.bind(f.storage);
    let notified = false,
      storageBytes = 0,
      closedProbe = Promise.resolve(),
      notifyOpened!: () => void,
      releaseStorage!: () => void;
    const storageOpened = new Promise<void>((resolve) => {
        notifyOpened = resolve;
      }),
      storageReleased = new Promise<void>((resolve) => {
        releaseStorage = resolve;
      });
    f.storage.openExact = async (...args) => {
      const result = await original(...args);
      try {
        if (!notified) {
          notified = true;
          // Setting explicit paused mode first means attaching this observer
          // does not itself cause the file stream to flow.
          result.stream.pause();
          closedProbe = finished(result.stream).catch(() => undefined);
          result.stream.on('data', (chunk: Buffer) => {
            storageBytes += chunk.length;
          });
          notifyOpened();
          await storageReleased;
        }
        return result;
      } catch (error) {
        result.stream.destroy();
        await finished(result.stream).catch(() => undefined);
        throw error;
      }
    };
    const delivery = request(http)
      .get(imagePath('public', current.bindingId))
      .set('Authorization', auth)
      .query({ revision: 3 })
      .then((response) => response);
    try {
      await Promise.race([
        storageOpened,
        delivery.then(() => assert.fail('Delivery must wait at storage open')),
      ]);
      assert.equal(storageBytes, 0);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const event = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,2,'revoked',a.manifest_digest,a.policy_revision,'activity-revocation-test',$1::text,'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a WHERE a.id=$2`,
          [event, otherSlotAssetId],
        );
        await tx.query(
          'UPDATE whaleu_media.asset_safety_heads SET revision=2,event_id=$2 WHERE asset_id=$1',
          [otherSlotAssetId, event],
        );
      });
    } finally {
      releaseStorage();
      f.storage.openExact = original;
    }
    const denied = await delivery;
    await closedProbe;
    assert.ok([409, 503].includes(denied.status), JSON.stringify(denied.body));
    assert.ok(!Buffer.isBuffer(denied.body));
    assert.equal(storageBytes, 0);
    assert.match(denied.headers['content-type'] ?? '', /application\/json/);
    const deniedDescriptor = await request(http)
      .get(descriptorPath('public', 'cover'))
      .set('Authorization', auth)
      .query({ revision: 3 });
    assert.ok([409, 503].includes(deniedDescriptor.status));
    // The activity deliberately omits its QR reference. It cannot privatize
    // an independently approved organization's own public mainQr endpoint.
    assert.equal(publication.show_organizer_qr, false);
    assert.equal(publication.organizer_qr, null);
    const qrPath = `/v3/media/organizations/public/organizations/${org.id}/slots/mainQr`;
    const qrDescriptor = await request(http)
      .get(`${qrPath}/descriptor`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .query({ applicationRevision: org.revision });
    ok(qrDescriptor);
    const qrBytes = await request(http)
      .get(`${qrPath}/bindings/${qrDescriptor.body.bindingId}/display-v1`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .query({ applicationRevision: org.revision });
    ok(qrBytes);
    assert.ok(Buffer.isBuffer(qrBytes.body) && qrBytes.body.length > 0);
  },
);
test(
  'Activity media original-key cancellation and independent image rejection cannot manufacture cover readiness',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      rejected = await picture('#842a4e'),
      f = await activityPublicationFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
        { sha256: sha256(rejected), verdict: 'revoked' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, bytes),
      draft = await createActivityDraft(f, actor, org, {
        ...content,
        types: ['online'],
      });
    const http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`,
      input = {
        protocol: ACTIVITY_MEDIA_PROTOCOL,
        clientRequestId: randomUUID(),
        activityId: draft.id,
        revision: 1,
        slot: 'cover',
        declaration: {
          mime: 'image/png',
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      };
    const hash = activityMediaRequestHash(actor.accountId, input);
    ok(
      await request(http)
        .post(`${prefix}/upload-requests/${input.clientRequestId}/cancel`)
        .set('Authorization', auth)
        .send({ protocol: ACTIVITY_MEDIA_PROTOCOL, requestHash: hash }),
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents`)
        .set('Authorization', auth)
        .send(input),
      409,
    );
    const recovery = await request(http)
      .get(`${prefix}/upload-requests/${input.clientRequestId}`)
      .set('Authorization', auth);
    ok(recovery);
    assert.equal(recovery.body.state, 'cancelled_before_prepare');
    ok(
      await request(http)
        .post(
          '/v3/media/organizations/upload-requests/' +
            input.clientRequestId +
            '/cancel',
        )
        .set('Authorization', auth)
        .send({ protocol: 'organization-media-v1', requestHash: hash }),
      409,
    );
    const denied = await readyActivityImage(
      f,
      actor,
      draft.id,
      'cover',
      1,
      rejected,
    );
    assert.equal(denied.status.status, 'terminal');
    if (denied.status.status === 'terminal')
      assert.equal(denied.status.reason, 'rejected');
    const missing = await request(http)
      .post(`${api}/drafts/${draft.id}/commands`)
      .set('Authorization', auth)
      .send({
        action: 'publish',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      });
    ok(missing, 409);
    assert.equal(missing.body.error.code, 'MEDIA_NOT_READY');
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_activities.native_activities WHERE id=$1',
          [draft.id],
        )
      ).rowCount,
      0,
    );
    // School review authority is not activity publication/media authority.
    ok(
      await request(http)
        .post(`${prefix}/upload-intents`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ ...input, clientRequestId: randomUUID() }),
      403,
    );
    const prepared = await request(http)
      .post(`${prefix}/upload-intents`)
      .set('Authorization', auth)
      .send({ ...input, clientRequestId: randomUUID() });
    ok(prepared);
    const organization = (
      await f.pool.query<{ revision: string; authority_version: string }>(
        'SELECT revision,authority_version FROM whaleu_organizations.organizations WHERE id=$1',
        [org.id],
      )
    ).rows[0]!;
    ok(
      await request(http)
        .post(`/v1/organizations/${org.id}/content`)
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: Number(organization.revision),
          expectedAuthorityVersion: Number(organization.authority_version),
          data: { ...org.data, name: '已更新组织' },
          mediaChanges: {},
        }),
    );
    ok(
      await request(http)
        .post(`${prefix}/upload-intents/${prepared.body.intentId}/grant`)
        .set('Authorization', auth)
        .send({}),
      403,
    );
    // Losing the old target revision stops new byte effects but leaves only
    // original-actor historical recovery/cancellation available.
    const staleStatus = await request(http)
      .get(`${prefix}/upload-intents/${prepared.body.intentId}`)
      .set('Authorization', auth);
    ok(staleStatus);
    assert.equal(staleStatus.body.status, 'prepared');
    const cancelled = await request(http)
      .post(`${prefix}/upload-intents/${prepared.body.intentId}/cancel`)
      .set('Authorization', auth)
      .send({});
    ok(cancelled);
    assert.equal(cancelled.body.status, 'terminal');
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_activities.media_upload_scopes(id,actor_id,client_request_id,activity_id,slot,revision,scope_revision,input,authority_version) SELECT $1,account_id,$2,id,'cover',revision,$3,$4::jsonb,'forged' FROM whaleu_activities.publication_drafts WHERE id=$5`,
          [randomUUID(), randomUUID(), hash, JSON.stringify(input), draft.id],
        ),
      ),
    );
  },
);

test(
  'Activity SQL publication requires the independent review to cover its exact bound asset set, even for a raw writer',
  { timeout: 240000 },
  async (t) => {
    const bytes = await picture(),
      f = await activityPublicationFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, bytes),
      draft = await createActivityDraft(f, actor, org, {
        ...content,
        types: ['online'],
      });
    const http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`,
      endpoint = `${api}/drafts/${draft.id}/commands`;
    const image = await readyActivityImage(
      f,
      actor,
      draft.id,
      'cover',
      1,
      bytes,
    );
    if (image.status.status !== 'ready_unbound')
      assert.fail('Cover not reviewed');
    ok(
      await request(http)
        .post(endpoint)
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          content,
          mediaChanges: {
            cover: { action: 'replace', assetId: image.status.assetId },
          },
        }),
    );
    const original = {
      action: 'publish' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
    const pending = await request(http)
      .post(endpoint)
      .set('Authorization', auth)
      .send(original);
    ok(pending);
    assert.equal(pending.body.state, 'pending');
    const exact = activityReviewEnvelopeSchema.parse(
      (
        await f.pool.query<{ envelope: unknown }>(
          'SELECT envelope FROM whaleu_activities.review_jobs WHERE actor_id=$1 AND client_request_id=$2',
          [actor.accountId, original.clientRequestId],
        )
      ).rows[0]!.envelope,
    );
    ok(
      await request(http)
        .post(`${api}/requests/${original.clientRequestId}/cancel`)
        .set('Authorization', auth)
        .send({ requestHash: pending.body.requestHash }),
    );
    // Simulate a raw queued-job writer, not a seeded approval. The real independent
    // processor reviews this different immutable envelope; publication must still
    // reject it because the approved manifest set is not the bound owner set.
    const command = {
        action: 'publish' as const,
        clientRequestId: randomUUID(),
        expectedRevision: 2,
      },
      hash = publicationCommandHash(actor.accountId, draft.id, command),
      job = randomUUID();
    const forged = activityReviewEnvelopeSchema.parse({
      ...exact,
      media: [
        {
          ...exact.media[0]!,
          assetId: randomUUID(),
          manifestDigest: 'f'.repeat(64),
        },
      ],
    });
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        'INSERT INTO whaleu_activities.publication_requests(actor_id,client_request_id,activity_id,request_hash,command) VALUES($1,$2,$3,$4,$5::jsonb)',
        [
          actor.accountId,
          command.clientRequestId,
          draft.id,
          hash,
          JSON.stringify(command),
        ],
      );
      await tx.query(
        'INSERT INTO whaleu_activities.review_jobs(id,actor_id,client_request_id,activity_id,digest,envelope) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [
          job,
          actor.accountId,
          command.clientRequestId,
          draft.id,
          activityReviewDigest(forged),
          JSON.stringify(forged),
        ],
      );
    });
    assert.equal((await f.reviewProcessor.processOne()).state, 'reviewed');
    const decision = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_activities.review_decisions WHERE job_id=$1',
        [job],
      )
    ).rows[0]!.id;
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          `INSERT INTO whaleu_activities.native_activities(id,original_publisher_account_id,organization_id,organization_revision,revision,region_id,organizer_label,content,media_bindings,organizer_qr,review_decision_id) SELECT id,account_id,organization_id,organization_revision,revision,region_id,$2,content,media_bindings,NULL,$3 FROM whaleu_activities.publication_drafts WHERE id=$1`,
          [draft.id, exact.organizerLabel, decision],
        );
        const event = randomUUID();
        await tx.query(
          `INSERT INTO whaleu_activities.publication_events(id,activity_id,actor_id,client_request_id,action,revision,content,media_bindings) SELECT $1,id,account_id,$2,'publish',revision,content,media_bindings FROM whaleu_activities.publication_drafts WHERE id=$3`,
          [event, command.clientRequestId, draft.id],
        );
        await tx.query(
          `UPDATE whaleu_activities.publication_drafts SET state='published',updated_at=transaction_timestamp() WHERE id=$1`,
          [draft.id],
        );
        const receipt = {
          requestId: command.clientRequestId,
          requestHash: hash,
          activityId: draft.id,
          revision: 2,
          outcome: 'published',
        };
        await tx.query(
          'INSERT INTO whaleu_activities.publication_receipts(actor_id,client_request_id,request_hash,activity_id,event_id,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
          [
            actor.accountId,
            command.clientRequestId,
            hash,
            draft.id,
            event,
            JSON.stringify(receipt),
          ],
        );
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      }),
      /review must cover exact current asset identities and manifests/,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_activities.native_activities WHERE id=$1',
          [draft.id],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await f.pool.query<{ state: string }>(
          'SELECT state FROM whaleu_activities.publication_drafts WHERE id=$1',
          [draft.id],
        )
      ).rows[0]!.state,
      'draft',
    );
  },
);
