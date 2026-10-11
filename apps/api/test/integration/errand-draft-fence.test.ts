import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import sharp from 'sharp';
import {
  errandMediaFixture,
  errandMediaBody,
  readyErrandImage,
  publishErrandImages,
  errandMediaOk as ok,
} from '../support/media/errand-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import {
  ERRAND_PUBLICATION_PROTOCOL as protocol,
  errandPublicationHash,
} from '../../src/errands/publication-contracts.js';
import { DatabaseService } from '../../src/database/database.js';
import { requireErrandMediaCurrent } from '../../src/errands/media-current-proof.js';
import {
  ERRAND_MEDIA_PROTOCOL,
  errandMediaRequestHash,
} from '../../src/media/contracts-errand.js';
import { sha256 } from '../../src/media/processing/protocol.js';

async function draftOnlyFixture() {
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#123456' },
  })
    .png()
    .toBuffer();
  return errandMediaFixture([{ sha256: sha256(bytes), verdict: 'allow' }]);
}

test(
  'Absent Errand draft cancellation fences late create under lost eligibility, retains original key and isolates actors',
  { timeout: 120000 },
  async (t) => {
    const f = await draftOnlyFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      foreign = await f.actor(),
      http = f.app.getHttpServer();
    const create = (
      actor: typeof owner,
      draftId: string,
      targetRegionId = f.scope.home.regionId,
    ) =>
      request(http)
        .post('/v2/errand-drafts')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({ protocol, draftId, targetRegionId });
    const cancel = (
      actor: typeof owner,
      draftId: string,
      publication: { requestId: string; requestHash: string } | null,
    ) =>
      request(http)
        .post(`/v2/errand-drafts/${draftId}/cancel`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({ protocol, expectedRevision: 1, publication });
    const template = await create(owner, randomUUID());
    ok(template);
    const foreignExisting = await cancel(foreign, template.body.draftId, {
      requestId: randomUUID(),
      requestHash: 'd'.repeat(64),
    });
    assert.equal(foreignExisting.status, 404);
    assert.equal(foreignExisting.body.error.code, 'ERRAND_NOT_FOUND');
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_errands.media_draft_cancellations WHERE actor_id=$1 AND draft_id=$2',
          [foreign.accountId, template.body.draftId],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'INSERT INTO whaleu_errands.media_draft_cancellations(actor_id,draft_id) VALUES($1,$2)',
          [foreign.accountId, template.body.draftId],
        ),
      ),
      { code: '23514', constraint: 'errand_media_draft_identity' },
    );
    const draftId = randomUUID(),
      body = errandMediaBody(f, { ...template.body, draftId }, []);
    const publication = {
      requestId: body.clientRequestId,
      requestHash: errandPublicationHash(body),
    };
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_errands.media_drafts WHERE id=$1',
          [draftId],
        )
      ).rowCount,
      0,
    );
    await setRuntimeVerification(
      f.pool,
      owner.accountId,
      f.scope.institutionId,
      f.scope.home.regionId,
      'unverified',
      'unverified',
    );
    assert.notEqual((await create(owner, draftId)).status, 200);
    const cancelled = await cancel(owner, draftId, publication);
    ok(cancelled);
    assert.deepEqual(cancelled.body, {
      protocol,
      draftId,
      revision: 1,
      state: 'cancelled_before_create',
    });
    const repeated = await cancel(owner, draftId, publication);
    ok(repeated);
    assert.deepEqual(repeated.body, cancelled.body);
    for (const key of [
      null,
      { ...publication, requestId: randomUUID() },
      { ...publication, requestHash: '0'.repeat(64) },
    ])
      assert.notEqual((await cancel(owner, draftId, key)).status, 200);
    const receipt = await request(http)
      .get(`/v1/me/errand-requests/${publication.requestId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    ok(receipt);
    assert.equal(receipt.body.outcome, 'rejected');
    assert.equal(receipt.body.code, 'ERRAND_STATE_CONFLICT');
    const original = (
      await f.pool.query(
        'SELECT * FROM whaleu_errands.media_draft_cancellations WHERE actor_id=$1 AND draft_id=$2',
        [owner.accountId, draftId],
      )
    ).rows;
    // Another actor may fence their own request identity, never rewrite this one.
    ok(await cancel(foreign, draftId, null));
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT * FROM whaleu_errands.media_draft_cancellations WHERE actor_id=$1 AND draft_id=$2',
          [owner.accountId, draftId],
        )
      ).rows,
      original,
    );
    const foreignReceipt = await request(http)
      .get(`/v1/me/errand-requests/${publication.requestId}`)
      .set('Authorization', `Bearer ${foreign.accessToken}`);
    assert.notEqual(foreignReceipt.status, 200);
    assert.notEqual(
      (
        await request(http)
          .post(`/v2/errand-publications/${publication.requestId}/publish`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ requestHash: publication.requestHash })
      ).status,
      200,
    );

    await f.certify(owner.accountId);
    for (const region of [f.scope.home.regionId, f.scope.related.regionId])
      assert.notEqual((await create(owner, draftId, region)).status, 200);
    assert.notEqual(
      (
        await request(http)
          .post('/v2/errand-publications/prepare')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send(body)
      ).status,
      200,
    );
    const fresh = await create(owner, randomUUID(), f.scope.related.regionId);
    ok(fresh);
    assert.equal(fresh.body.targetRegionId, f.scope.related.regionId);
    assert.equal(fresh.body.state, 'open');
    const foreignAbsent = randomUUID();
    ok(await cancel(foreign, foreignAbsent, null));
    ok(await create(owner, foreignAbsent));
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_errands.media_drafts(id,actor_id,target_region_id,scope,authority_version)
     SELECT $1,actor_id,target_region_id,scope,authority_version FROM whaleu_errands.media_drafts WHERE id=$2`,
          [draftId, fresh.body.draftId],
        ),
      ),
      { code: '23514', constraint: 'errand_media_draft_identity' },
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'INSERT INTO whaleu_errands.media_draft_cancellations(actor_id,draft_id) VALUES($1,$2)',
          [owner.accountId, fresh.body.draftId],
        ),
      ),
      { code: '23514', constraint: 'errand_media_draft_identity' },
    );
    for (const sql of [
      'UPDATE whaleu_errands.media_draft_cancellations SET publication_request_hash=publication_request_hash',
      'DELETE FROM whaleu_errands.media_draft_cancellations',
      'TRUNCATE whaleu_errands.media_draft_cancellations',
    ])
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) => tx.query(sql)),
        { code: '23514' },
      );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_errands.media_drafts WHERE id=$1',
          [draftId],
        )
      ).rowCount,
      0,
    );
    const noKey = randomUUID();
    ok(await cancel(owner, noKey, null));
    ok(await cancel(owner, noKey, null));
    assert.notEqual(
      (
        await cancel(owner, noKey, {
          requestId: randomUUID(),
          requestHash: 'a'.repeat(64),
        })
      ).status,
      200,
    );
  },
);

test(
  'Errand draft cancellation raw guards, exact serialization and zero-row/final owner fences',
  { timeout: 120000 },
  async (t) => {
    const f = await draftOnlyFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      http = f.app.getHttpServer(),
      db = f.app.get(DatabaseService);
    const draftId = randomUUID();
    const [created, cancelled] = await Promise.all([
      request(http)
        .post('/v2/errand-drafts')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({ protocol, draftId, targetRegionId: f.scope.home.regionId }),
      request(http)
        .post(`/v2/errand-drafts/${draftId}/cancel`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({ protocol, expectedRevision: 1, publication: null }),
    ]);
    ok(cancelled);
    if (created.status === 200) {
      assert.equal(cancelled.body.state, 'cancelled');
      assert.equal(
        (
          await f.pool.query(
            'SELECT state FROM whaleu_errands.media_drafts WHERE id=$1',
            [draftId],
          )
        ).rows[0].state,
        'cancelled',
      );
    } else {
      assert.equal(cancelled.body.state, 'cancelled_before_create');
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_errands.media_drafts WHERE id=$1',
            [draftId],
          )
        ).rowCount,
        0,
      );
    }
    const prove = (id: string) =>
      db.transaction((tx) => requireErrandMediaCurrent('draft', id, tx), {
        isolationLevel: 'read committed',
      });
    const absent = randomUUID(),
      writer = await f.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(
        'DELETE FROM whaleu_errands.media_draft_cancellations WHERE false',
      );
      await assert.rejects(prove(absent), { code: 'ERRAND_UNAVAILABLE' });
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
    await prove(absent);
    await assert.rejects(
      db.transaction(
        async (tx) => {
          await requireErrandMediaCurrent('draft', absent, tx);
          await withCommunityScopeWriter(f.pool, (other) =>
            other.query(
              'INSERT INTO whaleu_errands.media_draft_cancellations(actor_id,draft_id) VALUES($1,$2)',
              [actor.accountId, absent],
            ),
          );
        },
        { isolationLevel: 'read committed' },
      ),
      { code: 'ERRAND_UNAVAILABLE' },
    );
    await prove(absent);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'INSERT INTO whaleu_errands.media_draft_cancellations(actor_id,draft_id,publication_request_id,publication_request_hash) VALUES($1,$2,$3,$4)',
          [actor.accountId, randomUUID(), randomUUID(), 'b'.repeat(64)],
        ),
      ),
    );
    const stale = await f.pool.connect();
    try {
      await stale.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(
        stale.query(
          'INSERT INTO whaleu_errands.media_draft_cancellations(actor_id,draft_id) VALUES($1,$2)',
          [actor.accountId, randomUUID()],
        ),
        { code: '23514', constraint: 'errand_media_draft_identity' },
      );
    } finally {
      await stale.query('ROLLBACK');
      stale.release();
    }
  },
);

test(
  'Twenty original Media keys fence through HTTP across two isolated account quotas; eleventh key remains recoverable',
  { timeout: 120000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 24, height: 24, channels: 3, background: '#485674' },
    })
      .png()
      .toBuffer();
    const f = await errandMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const http = f.app.getHttpServer(),
      boundActor = await f.actor();
    const create = async (actor: typeof boundActor) => {
      const response = await request(http)
        .post('/v2/errand-drafts')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({
          protocol,
          draftId: randomUUID(),
          targetRegionId: f.scope.home.regionId,
        });
      ok(response);
      return response.body;
    };
    const boundDraft = await create(boundActor),
      image = await readyErrandImage(
        f,
        boundActor,
        boundDraft,
        'private0',
        bytes,
      );
    const order = await publishErrandImages(f, boundActor, boundDraft, [
      image.fact,
    ]);
    const binding = (
      await f.pool.query(
        'SELECT binding_id FROM whaleu_media.errand_appearances WHERE order_id=$1',
        [order.id],
      )
    ).rows[0].binding_id;
    let fenced = 0;
    for (let account = 0; account < 2; account++) {
      const actor = await f.actor(),
        draft = await create(actor),
        authorization = `Bearer ${actor.accessToken}`;
      await setRuntimeVerification(
        f.pool,
        actor.accountId,
        f.scope.institutionId,
        f.scope.home.regionId,
        'unverified',
        'unverified',
      );
      const originals = Array.from({ length: 10 }, () => ({
        protocol: ERRAND_MEDIA_PROTOCOL,
        clientRequestId: randomUUID(),
        draftId: draft.draftId,
        draftRevision: 1,
        targetRegionId: draft.targetRegionId,
        slot: 'public0' as const,
        declaration: {
          mime: 'image/png' as const,
          bytes: bytes.length,
          sha256: sha256(bytes),
        },
      }));
      for (const original of originals) {
        const failed = await request(http)
          .post('/v3/media/errands/upload-intents')
          .set('Authorization', authorization)
          .send(original);
        assert.notEqual(failed.status, 200);
        const missing = await request(http)
          .get(`/v3/media/errands/upload-requests/${original.clientRequestId}`)
          .set('Authorization', authorization);
        ok(missing);
        assert.equal(missing.body.state, 'not_recorded');
      }
      const parent = await request(http)
        .post(`/v2/errand-drafts/${draft.draftId}/cancel`)
        .set('Authorization', authorization)
        .send({ protocol, expectedRevision: 1, publication: null });
      ok(parent);
      assert.equal(parent.body.state, 'cancelled');
      for (const original of originals) {
        const requestHash = errandMediaRequestHash(actor.accountId, original);
        const terminal = await request(http)
          .post(
            `/v3/media/errands/upload-requests/${original.clientRequestId}/cancel`,
          )
          .set('Authorization', authorization)
          .send({ protocol: ERRAND_MEDIA_PROTOCOL, requestHash });
        ok(terminal);
        assert.equal(terminal.body.state, 'cancelled_before_prepare');
        assert.equal(terminal.body.requestHash, requestHash);
        assert.notEqual(
          (
            await request(http)
              .post('/v3/media/errands/upload-intents')
              .set('Authorization', authorization)
              .send(original)
          ).status,
          200,
        );
        fenced++;
      }
      const eleventh = { ...originals[0]!, clientRequestId: randomUUID() };
      const limited = await request(http)
        .post(
          `/v3/media/errands/upload-requests/${eleventh.clientRequestId}/cancel`,
        )
        .set('Authorization', authorization)
        .send({
          protocol: ERRAND_MEDIA_PROTOCOL,
          requestHash: errandMediaRequestHash(actor.accountId, eleventh),
        });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers['retry-after']) > 0);
      const pending = await request(http)
        .get(`/v3/media/errands/upload-requests/${eleventh.clientRequestId}`)
        .set('Authorization', authorization);
      ok(pending);
      assert.equal(pending.body.state, 'not_recorded');
      ok(
        await request(http)
          .post(`/v2/errand-drafts/${draft.draftId}/cancel`)
          .set('Authorization', authorization)
          .send({ protocol, expectedRevision: 1, publication: null }),
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT 1 FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND protocol_namespace=14 AND state='cancelled_before_prepare'",
            [actor.accountId],
          )
        ).rowCount,
        10,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        0,
      );
    }
    assert.equal(fenced, 20);
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.bindings WHERE id=$1 AND detached_at IS NULL',
          [binding],
        )
      ).rowCount,
      1,
    );
    const delivery = await request(http)
      .get(
        `/v3/media/errands/orders/${order.id}/private0/bindings/${binding}/display-v1`,
      )
      .set('Authorization', `Bearer ${boundActor.accessToken}`)
      .query({ revision: 1 });
    ok(delivery);
    assert.ok(Buffer.isBuffer(delivery.body) && delivery.body.length > 0);
  },
);
