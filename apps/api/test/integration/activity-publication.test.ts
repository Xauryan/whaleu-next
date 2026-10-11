import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import { sha256 } from '../../src/media/processing/protocol.js';
import { publicationCommandHash } from '../../src/activities/publication/contracts.js';
import {
  activityPublicationFixture,
  approvedActivityOrganizer,
  createActivityDraft,
} from '../support/activity-publication-fixture.js';
import { readyActivityImage } from '../support/media/activity-runtime-fixture.js';
import { organizationOk } from '../support/media/organization-runtime-fixture.js';
const path = (id: string) => `/v1/activity-publication/drafts/${id}/commands`;
test(
  'actual Activity publication: target manager, mandatory cover, queue processor, exact replay, public detail and immutable publisher history',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 24, height: 24, channels: 3, background: '#287a81' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      other = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const organizers = await request(http)
      .get('/v1/activity-publication/organizers')
      .set('Authorization', auth);
    organizationOk(organizers);
    assert.deepEqual(
      organizers.body.items.map(
        (i: { organizationId: string }) => i.organizationId,
      ),
      [org.id],
    );
    const denied = await request(http)
      .get('/v1/activity-publication/organizers')
      .set('Authorization', `Bearer ${reviewer.accessToken}`);
    organizationOk(denied);
    assert.deepEqual(denied.body.items, []);
    const draft = await createActivityDraft(f, actor, org),
      first = {
        action: 'publish' as const,
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      };
    assert.equal(
      (
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send(first)
      ).status,
      409,
    );
    const ready = await readyActivityImage(f, actor, draft.id, 'cover', 1, png);
    assert.equal(ready.status.status, 'ready_unbound');
    if (ready.status.status !== 'ready_unbound') throw Error('ready');
    const save = {
      action: 'save',
      clientRequestId: randomUUID(),
      expectedRevision: 1,
      content: {
        ...draft.content,
        types: ['online', 'reward'],
        activityTime: '任意时间',
        activityLocation: '线上',
        showOrganizerQr: true,
      },
      mediaChanges: {
        cover: { action: 'replace', assetId: ready.status.assetId },
      },
    };
    const saved = await request(http)
      .post(path(draft.id))
      .set('Authorization', auth)
      .send(save);
    organizationOk(saved);
    assert.equal(saved.body.revision, 2);
    const publish = {
        action: 'publish' as const,
        clientRequestId: randomUUID(),
        expectedRevision: 2,
      },
      pending = await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send(publish);
    organizationOk(pending);
    assert.equal(pending.body.state, 'pending');
    assert.equal(pending.body.review, 'pending');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_activities.native_activities',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send({ ...save, clientRequestId: randomUUID(), expectedRevision: 2 })
      ).status,
      409,
    );
    const ownerOnly = await request(http)
      .get(`/v1/activity-publication/requests/${publish.clientRequestId}`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    organizationOk(ownerOnly);
    assert.equal(ownerOnly.body.state, 'not_recorded');
    assert.deepEqual(await f.reviewProcessor.processOne(), {
      state: 'reviewed',
      result: 'allow',
    });
    const recovery = await request(http)
      .get(`/v1/activity-publication/requests/${publish.clientRequestId}`)
      .set('Authorization', auth);
    organizationOk(recovery);
    assert.equal(recovery.body.review, 'ready');
    const published = await request(http)
      .post(path(draft.id))
      .set('Authorization', auth)
      .send(publish);
    organizationOk(published);
    assert.equal(published.body.outcome, 'published');
    assert.equal(
      (
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send({
            action: 'cancel_draft',
            clientRequestId: randomUUID(),
            expectedRevision: 2,
          })
      ).status,
      403,
    );
    assert.deepEqual(
      (
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send(publish)
      ).body,
      published.body,
    );
    const detail = await request(http)
      .get(`/v1/activity-publication/activities/${draft.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    organizationOk(detail);
    assert.equal(detail.body.source, 'native');
    assert.deepEqual(detail.body.content.types, ['online', 'reward']);
    assert.equal(detail.body.content.endAt, null);
    assert.equal(detail.body.organizerQr.status, 'available');
    assert.equal(detail.body.organizerQr.slot, 'mainQr');
    assert.equal(detail.body.organizerQr.assetId, undefined);
    const mine = await request(http)
      .get('/v1/activity-publication/mine')
      .set('Authorization', auth);
    organizationOk(mine);
    assert.equal(mine.body.items[0].id, draft.id);
    assert.equal(
      (
        await request(http)
          .get('/v1/activity-publication/mine')
          .set('Authorization', `Bearer ${reviewer.accessToken}`)
      ).body.items.length,
      0,
    );
    const cancellation = await request(http)
      .post(
        `/v1/activity-publication/requests/${publish.clientRequestId}/cancel`,
      )
      .set('Authorization', auth)
      .send({
        requestHash: publicationCommandHash(actor.accountId, draft.id, publish),
      });
    organizationOk(cancellation);
    assert.equal(cancellation.body.state, 'recorded');
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_activities.native_activities',
        )
      ).rows[0].n,
      1,
    );
  },
);
test(
  'cancel competes safely with queued review; reject stays private and original key is frozen',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 20, height: 20, channels: 3, background: '#693d6f' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture(
        [{ sha256: sha256(png), verdict: 'allow' }],
        { reviewResult: 'reject' },
      );
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      draft = await createActivityDraft(f, actor, org),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const image = await readyActivityImage(f, actor, draft.id, 'cover', 1, png);
    if (image.status.status !== 'ready_unbound') throw Error('ready');
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          content: draft.content,
          mediaChanges: {
            cover: { action: 'replace', assetId: image.status.assetId },
          },
        }),
    );
    const publish = {
      action: 'publish' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send(publish),
    );
    await f.reviewProcessor.processOne();
    const rejected = await request(http)
      .post(path(draft.id))
      .set('Authorization', auth)
      .send(publish);
    organizationOk(rejected);
    assert.equal(rejected.body.review, 'rejected');
    assert.equal(
      (
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send({ ...publish, expectedRevision: 3 })
      ).status,
      409,
    );
    const cancelled = await request(http)
      .post(
        `/v1/activity-publication/requests/${publish.clientRequestId}/cancel`,
      )
      .set('Authorization', auth)
      .send({
        requestHash: publicationCommandHash(actor.accountId, draft.id, publish),
      });
    organizationOk(cancelled);
    assert.equal(cancelled.body.state, 'cancelled');
    assert.equal(
      (
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send(publish)
      ).status,
      409,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_activities.native_activities',
        )
      ).rows[0].n,
      0,
    );
  },
);

test(
  'original publisher history survives a real organization transfer and former-admin revocation',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 18, height: 18, channels: 3, background: '#51395e' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      recipient = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      draft = await createActivityDraft(f, actor, org),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const image = await readyActivityImage(f, actor, draft.id, 'cover', 1, png);
    if (image.status.status !== 'ready_unbound') throw Error('ready');
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          content: draft.content,
          mediaChanges: {
            cover: { action: 'replace', assetId: image.status.assetId },
          },
        }),
    );
    const publish = {
      action: 'publish' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send(publish),
    );
    await f.reviewProcessor.processOne();
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send(publish),
    );
    const privateDraft = await createActivityDraft(f, actor, org);
    for (const person of [actor, recipient])
      organizationOk(
        await request(http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${person.accessToken}`)
          .send({ expectedRevision: 0, nickname: '活动管理成员' }),
      );
    const profile = async (id: string) =>
      (
        await f.pool.query<{ id: string }>(
          'SELECT public_id id FROM whaleu_profile.profiles WHERE account_id=$1',
          [id],
        )
      ).rows[0]!.id;
    organizationOk(
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
    organizationOk(
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
    assert.deepEqual(
      (
        await request(http)
          .get('/v1/activity-publication/organizers')
          .set('Authorization', auth)
      ).body.items,
      [],
    );
    const closed = await request(http)
      .post(path(privateDraft.id))
      .set('Authorization', auth)
      .send({
        action: 'cancel_draft',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      });
    organizationOk(closed);
    assert.equal(closed.body.outcome, 'draft_cancelled');
    const mine = await request(http)
      .get('/v1/activity-publication/mine')
      .set('Authorization', auth);
    organizationOk(mine);
    assert.equal(mine.body.items[0].id, draft.id);
    assert.deepEqual(
      (
        await request(http)
          .get('/v1/activity-publication/mine')
          .set('Authorization', `Bearer ${recipient.accessToken}`)
      ).body.items,
      [],
    );
  },
);

test(
  'old reviewed draft cannot cross organization revision; same key never silently re-reviews changed authority',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 18, height: 18, channels: 3, background: '#3c6a54' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      draft = await createActivityDraft(f, actor, org),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const image = await readyActivityImage(f, actor, draft.id, 'cover', 1, png);
    if (image.status.status !== 'ready_unbound') throw Error('ready');
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          content: draft.content,
          mediaChanges: {
            cover: { action: 'replace', assetId: image.status.assetId },
          },
        }),
    );
    const publish = {
      action: 'publish' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send(publish),
    );
    await f.reviewProcessor.processOne();
    organizationOk(
      await request(http)
        .post(`/v1/organizations/${org.id}/content`)
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 2,
          data: { ...org.data, introText: '组织资料已修订' },
          mediaChanges: {},
        }),
    );
    const stale = await request(http)
      .post(path(draft.id))
      .set('Authorization', auth)
      .send(publish);
    assert.equal(stale.status, 403, JSON.stringify(stale.body));
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_activities.native_activities',
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_activities.review_jobs',
        )
      ).rows[0].n,
      1,
    );
  },
);

test(
  'verification expiry and an unresolved organization writer after deferred waiting roll publication back at its bounded final fence',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 18, height: 18, channels: 3, background: '#4c5481' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      draft = await createActivityDraft(f, actor, org),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    const image = await readyActivityImage(f, actor, draft.id, 'cover', 1, png);
    if (image.status.status !== 'ready_unbound') throw Error('ready');
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 1,
          content: draft.content,
          mediaChanges: {
            cover: { action: 'replace', assetId: image.status.assetId },
          },
        }),
    );
    const publish = {
      action: 'publish' as const,
      clientRequestId: randomUUID(),
      expectedRevision: 2,
    };
    organizationOk(
      await request(http)
        .post(path(draft.id))
        .set('Authorization', auth)
        .send(publish),
    );
    await f.reviewProcessor.processOne();
    await f.pool.query(
      `CREATE FUNCTION whaleu_activities.test_deferred_publication_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.client_request_id='${publish.clientRequestId}'::uuid THEN PERFORM pg_sleep(2);END IF;RETURN NULL;END$$;CREATE CONSTRAINT TRIGGER test_deferred_publication_wait AFTER INSERT ON whaleu_activities.publication_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_activities.test_deferred_publication_wait()`,
    );
    await f.certify(actor.accountId, {
      expiresAt: new Date(Date.now() + 1500),
    });
    const expired = await request(http)
      .post(path(draft.id))
      .set('Authorization', auth)
      .send(publish);
    assert.equal(expired.status, 503, JSON.stringify(expired.body));
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_activities.native_activities',
        )
      ).rows[0].n,
      0,
    );
    await f.certify(actor.accountId);
    const blocked = request(http)
      .post(path(draft.id))
      .set('Authorization', auth)
      .send(publish)
      .then((r) => r);
    const until = Date.now() + 5000;
    while (
      !(
        await f.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='whaleu-next' AND wait_event='PgSleep'",
        )
      ).rowCount
    ) {
      assert.ok(Date.now() < until, 'Publication reaches real deferred wait');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const writer = await f.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        'LOCK TABLE whaleu_organizations.organizations IN ROW EXCLUSIVE MODE',
      );
      const response = await blocked;
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(
        (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_activities.native_activities',
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
    await f.pool.query(
      'DROP TRIGGER test_deferred_publication_wait ON whaleu_activities.publication_receipts;DROP FUNCTION whaleu_activities.test_deferred_publication_wait()',
    );
    const resumed = await request(http)
      .post(path(draft.id))
      .set('Authorization', auth)
      .send(publish);
    organizationOk(resumed);
    assert.equal(resumed.body.outcome, 'published');
  },
);

test(
  'twenty stale organization drafts can be explicitly closed by their original owner, releasing capacity without deleting publication history',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 16, height: 16, channels: 3, background: '#365977' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      other = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`,
      drafts = [];
    for (let i = 0; i < 20; i++)
      drafts.push(await createActivityDraft(f, actor, org));
    organizationOk(
      await request(http)
        .post(`/v1/organizations/${org.id}/content`)
        .set('Authorization', auth)
        .send({
          action: 'save',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
          expectedAuthorityVersion: 2,
          data: { ...org.data, introText: '令旧草稿权限快照失效' },
          mediaChanges: {},
        }),
    );
    const newId = randomUUID(),
      create = {
        ...drafts[0]!.command,
        clientRequestId: randomUUID(),
        organizationRevision: 3,
      };
    assert.equal(
      (
        await request(http)
          .post(path(newId))
          .set('Authorization', auth)
          .send(create)
      ).status,
      429,
    );
    const stale = drafts[0]!,
      cancel = {
        action: 'cancel_draft',
        clientRequestId: randomUUID(),
        expectedRevision: 1,
      };
    assert.equal(
      (
        await request(http)
          .post(path(stale.id))
          .set('Authorization', `Bearer ${other.accessToken}`)
          .send(cancel)
      ).status,
      403,
    );
    const owned = await request(http)
      .get(`/v1/activity-publication/drafts/${stale.id}`)
      .set('Authorization', auth);
    organizationOk(owned);
    assert.equal(owned.body.revision, 1);
    const cancelled = await request(http)
      .post(path(stale.id))
      .set('Authorization', auth)
      .send(cancel);
    organizationOk(cancelled);
    assert.equal(cancelled.body.outcome, 'draft_cancelled');
    const historicCreate = await request(http)
      .post(
        `/v1/activity-publication/requests/${stale.command.clientRequestId}/cancel`,
      )
      .set('Authorization', auth)
      .send({
        requestHash: publicationCommandHash(
          actor.accountId,
          stale.id,
          stale.command,
        ),
      });
    organizationOk(historicCreate);
    assert.equal(historicCreate.body.state, 'recorded');
    assert.equal(historicCreate.body.receipt.outcome, 'created');
    assert.deepEqual(
      (
        await request(http)
          .post(path(stale.id))
          .set('Authorization', auth)
          .send(cancel)
      ).body,
      cancelled.body,
    );
    organizationOk(
      await request(http)
        .post(path(newId))
        .set('Authorization', auth)
        .send(create),
    );
    assert.equal(
      (
        await request(http)
          .post(path(stale.id))
          .set('Authorization', auth)
          .send({
            action: 'publish',
            clientRequestId: randomUUID(),
            expectedRevision: 1,
          })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::integer n FROM whaleu_activities.publication_drafts WHERE account_id=$1 AND state='draft'",
          [actor.accountId],
        )
      ).rows[0].n,
      20,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT state FROM whaleu_activities.publication_drafts WHERE id=$1',
          [stale.id],
        )
      ).rows[0].state,
      'cancelled',
    );
  },
);

test(
  'bounded catalog skips known revoked B and returns continuation to healthy A; expired review evidence stays unavailable',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 16, height: 16, channels: 3, background: '#814a35' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`,
      ids: string[] = [];
    for (const name of ['healthy A', 'revoked B']) {
      const draft = await createActivityDraft(f, actor, org, {
          title: name,
          description: '',
          types: ['online'],
          activityTime: '',
          activityLocation: '',
          endAt: null,
          showOrganizerQr: false,
        }),
        image = await readyActivityImage(f, actor, draft.id, 'cover', 1, png);
      if (image.status.status !== 'ready_unbound') throw Error('ready');
      organizationOk(
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send({
            action: 'save',
            clientRequestId: randomUUID(),
            expectedRevision: 1,
            content: draft.content,
            mediaChanges: {
              cover: { action: 'replace', assetId: image.status.assetId },
            },
          }),
      );
      const publish = {
        action: 'publish',
        clientRequestId: randomUUID(),
        expectedRevision: 2,
      };
      organizationOk(
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send(publish),
      );
      if (ids.length === 0)
        f.reviewRuntime.validUntil.setTime(Date.now() + 12000);
      await f.reviewProcessor.processOne();
      organizationOk(
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send(publish),
      );
      ids.push(draft.id);
    }
    const before = await request(http)
      .get('/v1/activity-publication/catalog')
      .set('Authorization', auth)
      .query({ limit: 1 });
    organizationOk(before);
    assert.equal(before.body.items[0].id, ids[1]);
    const decision = (
        await f.pool.query<{ id: string }>(
          'SELECT review_decision_id id FROM whaleu_activities.native_activities WHERE id=$1',
          [ids[1]],
        )
      ).rows[0]!.id,
      event = randomUUID();
    const reviewTx = await f.pool.connect();
    await reviewTx.query('BEGIN');
    try {
      await reviewTx.query(
        `INSERT INTO whaleu_activities.review_events(id,decision_id,revision,state,provenance_ref) VALUES($1,$2,2,'revoked','explicit synthetic review withdrawal')`,
        [event, decision],
      );
      await reviewTx.query(
        `UPDATE whaleu_activities.review_heads SET state='revoked',revision=2,event_id=$2 WHERE decision_id=$1`,
        [decision, event],
      );
      await reviewTx.query('COMMIT');
    } catch (error) {
      await reviewTx.query('ROLLBACK');
      throw error;
    } finally {
      reviewTx.release();
    }
    const first = await request(http)
      .get('/v1/activity-publication/catalog')
      .set('Authorization', auth)
      .query({ limit: 1 });
    organizationOk(first);
    assert.deepEqual(first.body.items, []);
    assert.ok(first.body.nextCursor);
    const next = await request(http)
      .get('/v1/activity-publication/catalog')
      .set('Authorization', auth)
      .query({ limit: 1, cursor: first.body.nextCursor });
    organizationOk(next);
    assert.equal(next.body.items[0].id, ids[0]);
    assert.equal(next.body.nextCursor, null);
    assert.ok(
      (
        await request(http)
          .get(`/v1/activity-publication/activities/${ids[1]}`)
          .set('Authorization', auth)
      ).status >= 400,
    );
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, f.reviewRuntime.validUntil.getTime() - Date.now() + 25),
      ),
    );
    const unavailable = await request(http)
      .get('/v1/activity-publication/catalog')
      .set('Authorization', auth)
      .query({ limit: 1 });
    assert.equal(unavailable.status, 503, JSON.stringify(unavailable.body));
  },
);

test(
  'original-key publication cancellation and draft closure have one durable winner under concurrent submission',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
        create: { width: 16, height: 16, channels: 3, background: '#976259' },
      })
        .png()
        .toBuffer(),
      f = await activityPublicationFixture([
        { sha256: sha256(png), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const actor = await f.actor(),
      reviewer = await f.actor(),
      org = await approvedActivityOrganizer(f, actor, reviewer, png),
      http = f.app.getHttpServer(),
      auth = `Bearer ${actor.accessToken}`;
    for (const queued of [false, true]) {
      const draft = await createActivityDraft(f, actor, org),
        image = await readyActivityImage(f, actor, draft.id, 'cover', 1, png);
      if (image.status.status !== 'ready_unbound') throw Error('ready');
      organizationOk(
        await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send({
            action: 'save',
            clientRequestId: randomUUID(),
            expectedRevision: 1,
            content: draft.content,
            mediaChanges: {
              cover: { action: 'replace', assetId: image.status.assetId },
            },
          }),
      );
      const publish = {
          action: 'publish' as const,
          clientRequestId: randomUUID(),
          expectedRevision: 2,
        },
        close = {
          action: 'cancel_draft',
          clientRequestId: randomUUID(),
          expectedRevision: 2,
        };
      if (queued) {
        organizationOk(
          await request(http)
            .post(path(draft.id))
            .set('Authorization', auth)
            .send(publish),
        );
        await f.reviewProcessor.processOne();
        const [sent, cancelled] = await Promise.all([
          request(http)
            .post(path(draft.id))
            .set('Authorization', auth)
            .send(publish),
          request(http)
            .post(
              `/v1/activity-publication/requests/${publish.clientRequestId}/cancel`,
            )
            .set('Authorization', auth)
            .send({
              requestHash: publicationCommandHash(
                actor.accountId,
                draft.id,
                publish,
              ),
            }),
        ]);
        organizationOk(cancelled);
        const closed = await request(http)
          .post(path(draft.id))
          .set('Authorization', auth)
          .send(close);
        if (cancelled.body.state === 'recorded') {
          organizationOk(sent);
          assert.equal(sent.body.outcome, 'published');
          assert.equal(closed.status, 403);
        } else {
          assert.equal(cancelled.body.state, 'cancelled');
          assert.equal(sent.status, 409);
          organizationOk(closed);
          assert.equal(closed.body.outcome, 'draft_cancelled');
        }
      } else {
        const [sent, closed] = await Promise.all([
          request(http)
            .post(path(draft.id))
            .set('Authorization', auth)
            .send(publish),
          request(http)
            .post(path(draft.id))
            .set('Authorization', auth)
            .send(close),
        ]);
        if (closed.status < 300) {
          assert.equal(closed.body.outcome, 'draft_cancelled');
          assert.equal(sent.status, 403);
        } else {
          assert.equal(closed.status, 409);
          organizationOk(sent);
          assert.equal(sent.body.state, 'pending');
          organizationOk(
            await request(http)
              .post(
                `/v1/activity-publication/requests/${publish.clientRequestId}/cancel`,
              )
              .set('Authorization', auth)
              .send({
                requestHash: publicationCommandHash(
                  actor.accountId,
                  draft.id,
                  publish,
                ),
              }),
          );
          const ended = await request(http)
            .post(path(draft.id))
            .set('Authorization', auth)
            .send(close);
          organizationOk(ended);
          assert.equal(ended.body.outcome, 'draft_cancelled');
        }
      }
      const stored = (
          await f.pool.query(
            'SELECT state FROM whaleu_activities.publication_drafts WHERE id=$1',
            [draft.id],
          )
        ).rows[0].state,
        native = (
          await f.pool.query(
            'SELECT count(*)::integer n FROM whaleu_activities.native_activities WHERE id=$1',
            [draft.id],
          )
        ).rows[0].n;
      assert.equal(native, stored === 'published' ? 1 : 0);
      assert.ok(['cancelled', 'published'].includes(stored));
      const outcomes = (
        await f.pool.query(
          "SELECT action FROM whaleu_activities.publication_events WHERE activity_id=$1 AND action IN('publish','cancel_draft')",
          [draft.id],
        )
      ).rows;
      assert.equal(outcomes.length, 1);
      const media = (
        await f.pool.query(
          'SELECT b.detached_at,b.detach_reason FROM whaleu_activities.media_appearances a JOIN whaleu_media.bindings b ON b.id=a.binding_id WHERE a.activity_id=$1',
          [draft.id],
        )
      ).rows;
      assert.equal(media.length, 1);
      assert.equal(media[0].detached_at !== null, stored === 'cancelled');
      assert.equal(
        media[0].detach_reason,
        stored === 'cancelled' ? 'activity-draft-cancelled' : null,
      );
    }
  },
);
