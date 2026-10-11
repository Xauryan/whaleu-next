import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { finished } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import sharp from 'sharp';
import request from 'supertest';
import {
  errandMediaFixture,
  createErrandMediaDraft,
  readyErrandImage,
  publishErrandImages,
  errandMediaBody,
  errandMediaPrefix as prefix,
  errandMediaOk as ok,
} from '../support/media/errand-runtime-fixture.js';
import type {
  ErrandMediaFixture,
  ErrandMediaActor,
} from '../support/media/errand-runtime-fixture.js';
import {
  errandMediaRequestHash,
  errandDescriptorSchema,
} from '../../src/media/contracts-errand.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  seedErrandFeature,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import {
  revokeErrandReview,
  approveErrand,
} from '../support/errand-review-fixtures.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { ErrandContentReviewFacade } from '../../src/community/content-review/errand-content-review.facade.js';
import { requireErrandMediaCurrent } from '../../src/errands/media-current-proof.js';
import { DatabaseService } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { SyntheticMediaCleanup } from '../support/media/synthetic-cleanup.js';
import type { ExactObject } from '../../src/media/contracts.js';
const auth = (a: ErrandMediaActor) => `Bearer ${a.accessToken}`;
async function waitForErrandClock(f: ErrandMediaFixture, deadline: Date) {
  assert.ok(Number.isFinite(deadline.getTime()));
  for (;;) {
    const remaining = (
      await f.pool.query<{ milliseconds: number }>(
        'SELECT (extract(epoch FROM ($1::timestamptz-clock_timestamp()))*1000)::double precision milliseconds',
        [deadline],
      )
    ).rows[0]!.milliseconds;
    assert.ok(Number.isFinite(remaining) && remaining <= 120001);
    // The PG Date decoder discards sub-millisecond timestamp precision.
    if (remaining < -5) return;
    await sleep(Math.max(1, Math.min(1000, remaining + 10)));
  }
}
async function imageSafety(
  f: ErrandMediaFixture,
  assetId: string,
  state: 'allow' | 'revoked',
) {
  await withCommunityScopeWriter(f.pool, async (tx) => {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_media.asset_safety_events(id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until) SELECT $1::uuid,a.id,h.revision+1,$3,a.manifest_digest,a.policy_revision,'errand-media-test',$1::text,'{}'::jsonb,clock_timestamp(),clock_timestamp()+interval '30 minutes' FROM whaleu_media.assets a JOIN whaleu_media.asset_safety_heads h ON h.asset_id=a.id WHERE a.id=$2`,
      [id, assetId, state],
    );
    await tx.query(
      `UPDATE whaleu_media.asset_safety_heads SET revision=revision+1,event_id=$2 WHERE asset_id=$1`,
      [assetId, id],
    );
  });
}
async function afterStorageOpen(
  f: ErrandMediaFixture,
  actor: ErrandMediaActor,
  path: string,
  mutate: () => Promise<unknown>,
) {
  const original = f.storage.openExact.bind(f.storage);
  let releasedBytes = 0,
    source: Readable | undefined,
    quiet = Promise.resolve(),
    entered!: () => void,
    release!: () => void;
  const reached = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.storage.openExact = async (...args) => {
    const value = await original(...args);
    source = value.stream;
    source.pause();
    quiet = finished(source).catch(() => undefined);
    source.on('data', (chunk: Buffer) => {
      releasedBytes += chunk.length;
    });
    entered();
    await gate;
    return value;
  };
  const delivery = request(f.app.getHttpServer())
    .get(path)
    .set('Authorization', auth(actor))
    .query({ revision: 1 })
    .then((v) => v);
  try {
    await Promise.race([
      reached,
      delivery.then(() => assert.fail('Expected provider gate')),
    ]);
    assert.equal(releasedBytes, 0);
    await mutate();
  } finally {
    release();
    f.storage.openExact = original;
  }
  const response = await delivery;
  await quiet;
  assert.notEqual(response.status, 200, JSON.stringify(response.body));
  assert.equal(releasedBytes, 0);
  assert.equal(source?.destroyed, true);
  assert.equal(response.headers['cache-control'], 'private, no-store');
}

test(
  'Errand completed/cancelled bound history survives actual 30-second admission expiry, not an unelapsed 24-hour asset age',
  { timeout: 120000 },
  async (t) => {
    const bytes = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#71476b' },
      })
        .png()
        .toBuffer(),
      f = await errandMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const publisher = await f.actor(),
      runner = await f.actor(),
      authorized = await createErrandMediaDraft(f, publisher),
      http = f.app.getHttpServer();
    await appendIdentitySelection(
      f.pool,
      runner.accountId,
      runner.facts,
      f.scope,
      f.scope.foreign.campusId,
    );
    const retained: {
      orderId: string;
      state: 'completed' | 'cancelled';
      intentId: string;
      assetId: string;
      bindingId: string;
    }[] = [];
    for (const operation of ['complete', 'cancel'] as const) {
      // Only the initial INSERT supplies a shorter immutable owner deadline.
      // Scope/authority come from the real authorized create path, and all
      // upload, Review, publication and lifecycle gates remain unchanged.
      const row = await withCommunityScopeWriter(
        f.pool,
        async (tx) =>
          (
            await tx.query<{ id: string; expires_at: Date }>(
              `INSERT INTO whaleu_errands.media_drafts(id,actor_id,target_region_id,scope,authority_version,expires_at)
             SELECT $1,actor_id,target_region_id,scope,authority_version,clock_timestamp()+interval '30 seconds'
             FROM whaleu_errands.media_drafts WHERE id=$2 AND actor_id=$3 RETURNING id,expires_at`,
              [randomUUID(), authorized.draftId, publisher.accountId],
            )
          ).rows[0]!,
      );
      const draft = {
          ...authorized,
          draftId: row.id,
          expiresAt: row.expires_at.getTime(),
        },
        image = await readyErrandImage(f, publisher, draft, 'private0', bytes),
        order = await publishErrandImages(f, publisher, draft, [image.fact]);
      const accepted = await request(http)
        .post(`/v1/errands/${order.id}/accept`)
        .set('Authorization', auth(runner))
        .send({
          clientRequestId: randomUUID(),
          expectedRevision: order.revision,
          contacts: { wechat: 'fixture_runner', phone: '' },
        });
      ok(accepted);
      assert.equal(accepted.body.outcome, 'applied');
      const terminal = await request(http)
        .post(`/v1/errands/${order.id}/${operation}`)
        .set('Authorization', auth(publisher))
        .send({
          clientRequestId: randomUUID(),
          expectedRevision: accepted.body.revision,
        });
      ok(terminal);
      assert.equal(terminal.body.outcome, 'applied');
      const descriptor = await request(http)
        .get(`${prefix}/orders/${order.id}/private0`)
        .set('Authorization', auth(runner))
        .query({ revision: 1 });
      ok(descriptor);
      retained.push({
        orderId: order.id,
        state: operation === 'complete' ? 'completed' : 'cancelled',
        intentId: image.status.intentId,
        assetId: image.fact.assetId,
        bindingId: errandDescriptorSchema.parse(descriptor.body).bindingId,
      });
    }
    await appendIdentitySelection(
      f.pool,
      runner.accountId,
      runner.facts,
      f.scope,
      f.scope.related.campusId,
    );
    await setRuntimeVerification(
      f.pool,
      runner.accountId,
      f.scope.institutionId,
      f.scope.home.regionId,
      'unverified',
      'verified',
    );
    for (const actor of [publisher, runner])
      await seedErrandFeature(f.pool, actor.accountId, [
        syntheticErrandRestriction('all'),
      ]);
    const intentIds = retained.map((x) => x.intentId),
      deadlines = (
        await f.pool.query<{ expires_at: Date; same_deadline: boolean }>(
          `SELECT i.expires_at,i.expires_at=s.expires_at same_deadline
           FROM whaleu_media.upload_intents i JOIN whaleu_media.errand_scopes s ON s.id=i.resource_id
           WHERE i.id=ANY($1::uuid[])`,
          [intentIds],
        )
      ).rows;
    assert.equal(deadlines.length, retained.length);
    assert.ok(deadlines.every((x) => x.same_deadline));
    await waitForErrandClock(
      f,
      new Date(Math.max(...deadlines.map((x) => x.expires_at.getTime()))),
    );
    assert.equal(
      (
        await f.pool.query(
          `SELECT 1 FROM whaleu_media.upload_intents i
           JOIN whaleu_media.errand_scopes s ON s.id=i.resource_id
           JOIN whaleu_media.assets a ON a.intent_id=i.id
           WHERE i.id=ANY($1::uuid[]) AND i.expires_at<=clock_timestamp()
            AND s.expires_at<=clock_timestamp() AND a.created_at>clock_timestamp()-interval '24 hours'`,
          [intentIds],
        )
      ).rowCount,
      retained.length,
      'Actual admission deadlines elapsed; the 24-hour asset age did not',
    );
    assert.equal(
      await withCommunityScopeWriter(f.pool, (tx) =>
        f.media.lifecycle.expireOne(tx),
      ),
      false,
      'Expired admission cannot collect either completed or cancelled bindings',
    );
    for (const item of retained) {
      const stored = (
        await f.pool.query(
          `SELECT o.state order_state,i.state intent_state,b.detached_at
           FROM whaleu_errands.orders o JOIN whaleu_media.errand_appearances p ON p.order_id=o.id
           JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_media.assets a ON a.id=b.asset_id
           JOIN whaleu_media.upload_intents i ON i.id=a.intent_id WHERE o.id=$1 AND b.id=$2`,
          [item.orderId, item.bindingId],
        )
      ).rows;
      assert.deepEqual(stored, [
        {
          order_state: item.state,
          intent_state: 'ready',
          detached_at: null,
        },
      ]);
      const history = await request(http)
        .get(`${prefix}/upload-intents/${item.intentId}`)
        .set('Authorization', auth(publisher));
      ok(history);
      assert.equal(history.body.status, 'bound_history');
      assert.equal(history.body.attachmentState, 'active');
      assert.equal(history.body.assetId, item.assetId);
      assert.equal(history.body.bindingId, item.bindingId);
      for (const actor of [publisher, runner]) {
        const descriptor = await request(http)
          .get(`${prefix}/orders/${item.orderId}/private0`)
          .set('Authorization', auth(actor))
          .query({ revision: 1 });
        ok(descriptor);
        assert.equal(descriptor.body.bindingId, item.bindingId);
        const response = await request(http)
          .get(
            `${prefix}/orders/${item.orderId}/private0/bindings/${item.bindingId}/display-v1`,
          )
          .set('Authorization', auth(actor))
          .query({ revision: 1 });
        ok(response);
        assert.ok(Buffer.isBuffer(response.body) && response.body.length > 0);
      }
    }
  },
);

test(
  'Errand Media14 real typed upload, exact publication, private participants, complete sibling Safety and terminal retention',
  { timeout: 300000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#376c83' },
    })
      .png()
      .toBuffer();
    const f = await errandMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const publisher = await f.actor(),
      runner = await f.actor(),
      stranger = await f.actor(),
      admin = await f.actor();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'synthetic-errand-media-admin')`,
        [randomUUID(), admin.accountId],
      ),
    );
    const draft = await createErrandMediaDraft(f, publisher),
      otherDraft = await createErrandMediaDraft(f, publisher);
    const pub = await readyErrandImage(f, publisher, draft, 'public0', bytes),
      priv = await readyErrandImage(f, publisher, draft, 'private0', bytes);
    const http = f.app.getHttpServer();
    await t.test(
      'hash, owner/audience scope, foreign actor/draft/slot and raw trust boundary',
      async () => {
        assert.equal(
          (
            await f.pool.query(
              'SELECT whaleu_media.errand_request_hash($1,$2::jsonb) hash',
              [publisher.accountId, JSON.stringify(pub.input)],
            )
          ).rows[0].hash,
          errandMediaRequestHash(publisher.accountId, pub.input),
        );
        for (const slot of [null, 0, {}, [], 'private0'])
          assert.equal(
            (
              await f.pool.query(
                'SELECT whaleu_errands.valid_image_set($1::jsonb,$2,false) valid',
                [JSON.stringify([{ ...pub.fact, slot }]), 'public'],
              )
            ).rows[0].valid,
            false,
          );
        for (const field of ['protocol', 'clientRequestId']) {
          const command = errandMediaBody(f, otherDraft, []);
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                `WITH input AS (SELECT $4::jsonb command)
                 INSERT INTO whaleu_errands.media_publication_intents(actor_id,request_id,draft_id,draft_revision,request_hash,command,review_digest)
                 SELECT $1::uuid,$2::uuid,$3::uuid,1,
                  encode(sha256(convert_to('whaleu:errand-command:v2'||chr(10)||whaleu_community.content_canonical_json(jsonb_build_object('operation','publish','intent',command-'clientRequestId')),'UTF8')),'hex'),
                  command,repeat('a',64) FROM input`,
                [
                  publisher.accountId,
                  command.clientRequestId,
                  otherDraft.draftId,
                  JSON.stringify({ ...command, [field]: null }),
                ],
              ),
            ),
            {
              code: '23514',
              constraint: 'errand_publication_command_identity',
            },
          );
        }
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT protocol_version,owner_kind,resource_kind,audience,purpose FROM whaleu_media.upload_intents WHERE id=$1',
              [priv.status.intentId],
            )
          ).rows[0],
          {
            protocol_version: 14,
            owner_kind: 'errands',
            resource_kind: 'errand_image',
            audience: 'errand-private',
            purpose: 'errand-private-image',
          },
        );
        await assert.rejects(
          f.publications.prepare(
            stranger.accessToken,
            errandMediaBody(f, draft, [pub.fact, priv.fact]),
          ),
        );
        await assert.rejects(
          f.publications.prepare(
            publisher.accessToken,
            errandMediaBody(f, otherDraft, [pub.fact]),
          ),
        );
        await assert.rejects(
          f.publications.prepare(
            publisher.accessToken,
            errandMediaBody(f, draft, [{ ...priv.fact, slot: 'public0' }]),
          ),
        );
        assert.notEqual(
          (
            await request(http)
              .post(`${prefix}/upload-intents`)
              .set('Authorization', auth(publisher))
              .send({ ...pub.input, clientRequestId: randomUUID() })
          ).status,
          200,
          'One original active request per owner slot',
        );
        for (const patch of [
          { audience: 'errand-public' },
          { draftRevision: 2 },
          { slot: 'gallery0' },
          { targetRegionId: f.scope.foreign.regionId },
        ])
          assert.notEqual(
            (
              await request(http)
                .post(`${prefix}/upload-intents`)
                .set('Authorization', auth(publisher))
                .send({ ...pub.input, clientRequestId: randomUUID(), ...patch })
            ).status,
            200,
          );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_media.errand_scopes SET slot=$2 WHERE client_request_id=$1',
              [pub.input.clientRequestId, 'private0'],
            ),
          ),
        );
        const authority = (
          await f.pool.query<{ authority_version: string }>(
            'SELECT authority_version FROM whaleu_errands.media_drafts WHERE id=$1',
            [draft.draftId],
          )
        ).rows[0]!.authority_version;
        await assert.rejects(
          f.app.get(DatabaseService).transaction(
            async (tx) => {
              await lockSafetyPolicy(tx, true);
              await f.media.acceptAndBindMany(
                publisher.accountId,
                draft.draftId,
                1,
                randomUUID(),
                authority,
                [pub.fact, priv.fact],
                tx,
              );
            },
            { isolationLevel: 'read committed' },
          ),
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=ANY($1::uuid[])',
              [[pub.fact.assetId, priv.fact.assetId]],
            )
          ).rowCount,
          0,
          'Deferred owner guards roll back the entire multi-slot bind',
        );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              `INSERT INTO whaleu_media.bindings(id,asset_id,manifest_digest,owner_kind,resource_kind,resource_id,content_version,slot,ordinal,attach_evidence) VALUES($1,$2,$3,'errands','errand_image',$4,1,'public0',0,'{}'::jsonb)`,
              [
                randomUUID(),
                pub.fact.assetId,
                pub.fact.manifestDigest,
                randomUUID(),
              ],
            ),
          ),
        );
      },
    );
    const order = await publishErrandImages(f, publisher, draft, [
      pub.fact,
      priv.fact,
    ]);
    const base = `${prefix}/orders/${order.id}`,
      pubDescriptorResponse = await request(http)
        .get(`${base}/public0`)
        .set('Authorization', auth(stranger))
        .query({ revision: 1 });
    ok(pubDescriptorResponse);
    const publicDescriptor = errandDescriptorSchema.parse(
        pubDescriptorResponse.body,
      ),
      path = `${base}/public0/bindings/${publicDescriptor.bindingId}/display-v1`;
    const privateDescriptorResponse = await request(http)
      .get(`${base}/private0`)
      .set('Authorization', auth(publisher))
      .query({ revision: 1 });
    ok(privateDescriptorResponse);
    const privateDescriptor = errandDescriptorSchema.parse(
        privateDescriptorResponse.body,
      ),
      privatePath = `${base}/private0/bindings/${privateDescriptor.bindingId}/display-v1`;
    await t.test(
      'only exact authenticated business reads and owner/stored accepter private reads',
      async () => {
        ok(
          await request(http)
            .get(path)
            .set('Authorization', auth(stranger))
            .query({ revision: 1 }),
        );
        ok(
          await request(http)
            .get(privatePath)
            .set('Authorization', auth(publisher))
            .query({ revision: 1 }),
        );
        for (const a of [stranger, runner, admin]) {
          assert.notEqual(
            (
              await request(http)
                .get(`${base}/private0`)
                .set('Authorization', auth(a))
                .query({ revision: 1 })
            ).status,
            200,
          );
          assert.notEqual(
            (
              await request(http)
                .get(privatePath)
                .set('Authorization', auth(a))
                .query({ revision: 1 })
            ).status,
            200,
          );
          const detail = await request(http)
            .get(`/v1/errands/${order.id}`)
            .set('Authorization', auth(a));
          ok(detail);
          for (const secret of [
            'privateMedia',
            priv.fact.assetId,
            privateDescriptor.bindingId,
            order.body.privateText,
          ])
            assert.equal(JSON.stringify(detail.body).includes(secret), false);
        }
        for (const [p, q] of [
          [path, { revision: 2 }],
          [
            `${base}/private0/bindings/${publicDescriptor.bindingId}/display-v1`,
            { revision: 1 },
          ],
          [
            `${prefix}/orders/${randomUUID()}/public0/bindings/${publicDescriptor.bindingId}/display-v1`,
            { revision: 1 },
          ],
        ] as const)
          assert.notEqual(
            (
              await request(http)
                .get(p)
                .set('Authorization', auth(publisher))
                .query(q)
            ).status,
            200,
          );
        assert.notEqual(
          (await request(http).get(path).query({ revision: 1 })).status,
          200,
        );
        assert.notEqual(
          (
            await request(http)
              .get(path)
              .set('Authorization', auth(publisher))
              .set('Range', 'bytes=0-1')
              .query({ revision: 1 })
          ).status,
          200,
        );
        const receipt = await f.media.cancel(
          publisher.accessToken,
          pub.status.intentId,
        );
        assert.equal(receipt.status, 'bound_history');
        const recovered = await f.publications.recover(
          publisher.accessToken,
          order.prepared.requestId,
        );
        assert.equal(recovered.state, 'terminal');
        assert.equal(
          JSON.stringify(recovered).includes(priv.fact.assetId),
          false,
        );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              `UPDATE whaleu_media.bindings SET detached_at=clock_timestamp(),detach_reason='errand-media-deleted' WHERE id=$1`,
              [publicDescriptor.bindingId],
            ),
          ),
        );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_media.errand_appearances SET slot=$2 WHERE binding_id=$1',
              [publicDescriptor.bindingId, 'public1'],
            ),
          ),
        );
      },
    );
    await t.test(
      'private sibling Safety revoked after public storage open releases zero bytes and closes whole order',
      async () => {
        await afterStorageOpen(f, stranger, path, () =>
          imageSafety(f, priv.fact.assetId, 'revoked'),
        );
        assert.notEqual(
          (
            await request(http)
              .get(`${base}/public0`)
              .set('Authorization', auth(stranger))
              .query({ revision: 1 })
          ).status,
          200,
        );
        assert.notEqual(
          (
            await request(http)
              .get(`/v1/errands/${order.id}`)
              .set('Authorization', auth(stranger))
          ).status,
          200,
        );
        const healthyDraft = await createErrandMediaDraft(f, publisher),
          healthy = await publishErrandImages(f, publisher, healthyDraft, []);
        for (const [actor, route, query] of [
          [stranger, '/v1/errands', { regionId: f.scope.home.regionId }],
          [publisher, '/v1/me/errands', { relation: 'published' }],
        ] as const) {
          const listed = await request(http)
            .get(route)
            .set('Authorization', auth(actor))
            .query(query);
          ok(listed);
          assert.ok(
            listed.body.items.some((x: { id: string }) => x.id === healthy.id),
          );
          assert.ok(
            !listed.body.items.some((x: { id: string }) => x.id === order.id),
          );
        }
        await imageSafety(f, priv.fact.assetId, 'allow');
        ok(
          await request(http)
            .get(path)
            .set('Authorization', auth(stranger))
            .query({ revision: 1 }),
        );
      },
    );
    await t.test(
      'current phone, account and expiring session each revoke a paused public byte delivery',
      async () => {
        await afterStorageOpen(f, stranger, path, () =>
          setRuntimeVerification(
            f.pool,
            stranger.accountId,
            f.scope.institutionId,
            f.scope.home.regionId,
            'verified',
            'unverified',
          ),
        );
        await setRuntimeVerification(
          f.pool,
          stranger.accountId,
          f.scope.institutionId,
          f.scope.home.regionId,
          'verified',
          'verified',
        );
        await afterStorageOpen(f, stranger, path, () =>
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [stranger.accountId],
            ),
          ),
        );
        await withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
            [stranger.accountId],
          ),
        );
        await afterStorageOpen(f, stranger, path, async () => {
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE session_id=$1",
              [stranger.sessionId],
            ),
          );
          await sleep(150);
        });
      },
    );
    let revision = order.revision;
    const command = async (
      a: ErrandMediaActor,
      op: 'accept' | 'complete' | 'delete',
    ) => {
      const response = await request(http)
        .post(`/v1/errands/${order.id}/${op}`)
        .set('Authorization', auth(a))
        .send({
          clientRequestId: randomUUID(),
          expectedRevision: revision,
          ...(op === 'accept'
            ? { contacts: { wechat: 'fixture_runner', phone: '' } }
            : {}),
        });
      ok(response);
      assert.equal(
        response.body.outcome,
        'applied',
        JSON.stringify(response.body),
      );
      revision = response.body.revision;
      return response;
    };
    await t.test(
      'completed participant history keeps immutable bindings and readable private images',
      async () => {
        await command(runner, 'accept');
        ok(
          await request(http)
            .get(privatePath)
            .set('Authorization', auth(runner))
            .query({ revision: 1 }),
        );
        await command(publisher, 'complete');
        for (const a of [publisher, runner])
          ok(
            await request(http)
              .get(privatePath)
              .set('Authorization', auth(a))
              .query({ revision: 1 }),
          );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE id=ANY($1::uuid[]) AND detached_at IS NULL',
              [[publicDescriptor.bindingId, privateDescriptor.bindingId]],
            )
          ).rowCount,
          2,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.errand_retirements WHERE order_id=$1',
              [order.id],
            )
          ).rowCount,
          0,
        );
        const expired = await f.app.get(DatabaseService).transaction(
          async (tx) => {
            await lockSafetyPolicy(tx, true);
            return f.media.lifecycle.expireOne(tx);
          },
          { isolationLevel: 'read committed' },
        );
        assert.equal(expired, false);
      },
    );
    await t.test(
      'deletion after Review and Safety revocation still retires all historical assets quietly',
      async () => {
        await afterStorageOpen(f, publisher, privatePath, () =>
          revokeErrandReview(f.pool, order.approval.decisionId),
        );
        await imageSafety(f, priv.fact.assetId, 'revoked');
        await command(publisher, 'delete');
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.errand_retirements WHERE order_id=$1 AND cause=$2',
              [order.id, 'deleted'],
            )
          ).rowCount,
          2,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.bindings WHERE id=ANY($1::uuid[]) AND detached_at IS NULL',
              [[publicDescriptor.bindingId, privateDescriptor.bindingId]],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              `SELECT 1 FROM whaleu_media.upload_intents WHERE id=ANY($1::uuid[]) AND state='cleanup_pending'`,
              [[pub.status.intentId, priv.status.intentId]],
            )
          ).rowCount,
          2,
        );
        assert.notEqual(
          (
            await request(http)
              .get(privatePath)
              .set('Authorization', auth(publisher))
              .query({ revision: 1 })
          ).status,
          200,
        );
        const intentIds = [pub.status.intentId, priv.status.intentId];
        const obligations = (
          await f.pool.query<{
            id: string;
            state: string;
            not_before: Date;
            not_before_text: string;
            confirmed_deleted_at: Date | null;
            quiet: boolean;
            provider: string;
            environment: string;
            bucket: string;
            key: string;
            version: string;
          }>(
            `SELECT c.id,c.state,c.not_before,c.not_before::text not_before_text,c.confirmed_deleted_at,
             c.not_before>clock_timestamp() quiet,c.provider,c.environment,c.bucket,c.object_key key,c.object_version version
             FROM whaleu_media.cleanup_obligations c
             LEFT JOIN whaleu_media.object_attempts o ON o.id=c.object_attempt_id
             LEFT JOIN whaleu_media.assets a ON a.id=c.asset_id
             LEFT JOIN whaleu_media.derived_object_attempts d ON d.id=c.derived_attempt_id
             LEFT JOIN whaleu_media.upload_ingress_writers w ON w.writer_token=c.ingress_writer_id
             LEFT JOIN whaleu_media.object_attempts wa ON wa.id=w.object_attempt_id
             WHERE coalesce(o.intent_id,a.intent_id,d.intent_id,wa.intent_id)=ANY($1::uuid[]) ORDER BY c.id`,
            [intentIds],
          )
        ).rows;
        assert.ok(obligations.length > 0 && obligations.length <= 32);
        const held = obligations.filter((x) => x.quiet);
        assert.ok(held.length > 0);
        const object = (row: (typeof obligations)[number]): ExactObject => ({
          provider: row.provider,
          environment: row.environment,
          bucket: row.bucket,
          key: row.key,
          version: row.version,
        });
        const before = await Promise.all(
          held.map((row) => f.storage.measure(object(row))),
        );
        const cleanup = new SyntheticMediaCleanup(f.pool, f.storage);
        const early = await cleanup.runOne();
        assert.ok(early === 'idle' || early === 'deleted');
        // Already-retired ingress scratch may settle immediately, but no held
        // original/derived/variant locator can be collected before its deadline.
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT id,state,not_before::text not_before_text,confirmed_deleted_at FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) ORDER BY id',
              [held.map((x) => x.id)],
            )
          ).rows,
          held.map((x) => ({
            id: x.id,
            state: x.state,
            not_before_text: x.not_before_text,
            confirmed_deleted_at: x.confirmed_deleted_at,
          })),
        );
        assert.deepEqual(
          await Promise.all(held.map((row) => f.storage.measure(object(row)))),
          before,
        );
        await waitForErrandClock(
          f,
          new Date(Math.max(...obligations.map((x) => x.not_before.getTime()))),
        );
        let idle = false;
        for (let count = 0; count <= obligations.length; count++) {
          const result = await cleanup.runOne();
          if (result === 'idle') {
            idle = true;
            break;
          }
          assert.equal(result, 'deleted');
        }
        assert.equal(
          idle,
          true,
          'Cleanup must settle within the captured bound',
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_media.cleanup_obligations WHERE id=ANY($1::uuid[]) AND (state<>'deleted' OR confirmed_deleted_at IS NULL)",
              [obligations.map((x) => x.id)],
            )
          ).rowCount,
          0,
        );
        for (const row of obligations)
          await assert.rejects(f.storage.measure(object(row)), {
            code: 'ENOENT',
          });
        for (const image of [pub, priv]) {
          const history = await request(http)
            .get(`${prefix}/upload-intents/${image.status.intentId}`)
            .set('Authorization', auth(publisher));
          ok(history);
          assert.equal(history.body.status, 'bound_history');
          assert.equal(history.body.attachmentState, 'detached');
          assert.equal(history.body.assetId, image.fact.assetId);
        }
      },
    );
  },
);

test(
  'Errand cancelled history retains stored accepter media; draft cancellation fences original publication and cleans unbound bytes',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
        create: { width: 40, height: 40, channels: 3, background: '#82553a' },
      })
        .png()
        .toBuffer(),
      f = await errandMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const publisher = await f.actor(),
      runner = await f.actor(),
      draft = await createErrandMediaDraft(f, publisher),
      media = await readyErrandImage(f, publisher, draft, 'private0', bytes),
      order = await publishErrandImages(f, publisher, draft, [media.fact]);
    const http = f.app.getHttpServer();
    const accepted = await request(http)
      .post(`/v1/errands/${order.id}/accept`)
      .set('Authorization', auth(runner))
      .send({
        clientRequestId: randomUUID(),
        expectedRevision: order.revision,
        contacts: { wechat: 'fixture_runner', phone: '' },
      });
    ok(accepted);
    assert.equal(accepted.body.outcome, 'applied');
    const cancelled = await request(http)
      .post(`/v1/errands/${order.id}/cancel`)
      .set('Authorization', auth(publisher))
      .send({
        clientRequestId: randomUUID(),
        expectedRevision: accepted.body.revision,
      });
    ok(cancelled);
    assert.equal(cancelled.body.outcome, 'applied');
    for (const a of [publisher, runner])
      ok(
        await request(http)
          .get(`${prefix}/orders/${order.id}/private0`)
          .set('Authorization', auth(a))
          .query({ revision: 1 }),
      );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.errand_retirements WHERE order_id=$1',
          [order.id],
        )
      ).rowCount,
      0,
    );
    const admin = await f.actor();
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'super_admin',NULL,$2,'synthetic-errand-cleanup')",
        [randomUUID(), admin.accountId],
      ),
    );
    const beforeDeleteBinding = (
      await f.pool.query<{ binding_id: string }>(
        'SELECT binding_id FROM whaleu_media.errand_appearances WHERE order_id=$1 AND slot=$2',
        [order.id, 'private0'],
      )
    ).rows[0]!.binding_id;
    await afterStorageOpen(
      f,
      publisher,
      `${prefix}/orders/${order.id}/private0/bindings/${beforeDeleteBinding}/display-v1`,
      async () => {
        const adminDeleted = await request(http)
          .post(`/v1/admin/errands/${order.id}/delete`)
          .set('Authorization', auth(admin))
          .send({
            clientRequestId: randomUUID(),
            expectedRevision: cancelled.body.revision,
            deleteReason: 'Synthetic image cleanup',
          });
        ok(adminDeleted);
        assert.equal(
          adminDeleted.body.outcome,
          'applied',
          JSON.stringify(adminDeleted.body),
        );
      },
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT 1 FROM whaleu_media.errand_retirements WHERE order_id=$1 AND cause='deleted'",
          [order.id],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT state,deleted_at FROM whaleu_errands.orders WHERE id=$1',
          [order.id],
        )
      ).rows[0].state,
      'cancelled',
    );
    const unboundDraft = await createErrandMediaDraft(f, publisher),
      unbound = await readyErrandImage(
        f,
        publisher,
        unboundDraft,
        'public0',
        bytes,
      ),
      body = errandMediaBody(f, unboundDraft, [unbound.fact]),
      prepared = await f.publications.prepare(publisher.accessToken, body);
    await assert.rejects(
      f.publications.cancel(publisher.accessToken, unboundDraft.draftId, {
        protocol: 'errand-publication-v2',
        expectedRevision: 1,
        publication: null,
      }),
    );
    const result = await f.publications.cancel(
      publisher.accessToken,
      unboundDraft.draftId,
      {
        protocol: 'errand-publication-v2',
        expectedRevision: 1,
        publication: {
          requestId: prepared.requestId,
          requestHash: prepared.requestHash,
        },
      },
    );
    assert.equal(result.state, 'cancelled');
    const historical = await f.publications.recover(
      publisher.accessToken,
      prepared.requestId,
    );
    assert.equal(historical.state, 'terminal');
    const retry = await f.publications.publish(
      publisher.accessToken,
      prepared.requestId,
      prepared.requestHash,
    );
    assert.equal(retry.outcome, 'rejected');
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.bindings WHERE asset_id=$1',
          [unbound.fact.assetId],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await f.media.status(publisher.accessToken, unbound.status.intentId))
        .status,
      'terminal',
    );
  },
);

test(
  'Errand audit subtraction retains exact survivor binding, retires removed slot and closes changed set until new Review',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#663395' },
      })
        .png()
        .toBuffer(),
      f = await errandMediaFixture([
        { sha256: sha256(bytes), verdict: 'allow' },
      ]);
    t.after(() => f.close());
    const publisher = await f.actor(),
      draft = await createErrandMediaDraft(f, publisher),
      pub = await readyErrandImage(f, publisher, draft, 'public0', bytes),
      priv = await readyErrandImage(f, publisher, draft, 'private0', bytes),
      order = await publishErrandImages(f, publisher, draft, [
        pub.fact,
        priv.fact,
      ]);
    const http = f.app.getHttpServer(),
      rows = (
        await f.pool.query<{
          slot: 'public0' | 'private0';
          assetId: string;
          manifestDigest: string;
          bindingId: string;
        }>(
          `SELECT slot,asset_id "assetId",manifest_digest "manifestDigest",binding_id "bindingId" FROM whaleu_media.errand_appearances WHERE order_id=$1`,
          [order.id],
        )
      ).rows;
    const removed = rows.find((x) => x.slot === 'private0')!,
      survivor = rows.find((x) => x.slot === 'public0')!;
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_errands.media_audits(id,order_id,expected_revision,next_revision,removed,issuer,provenance_ref) VALUES($1,$2,1,2,$3::jsonb,'synthetic-raw-auditor','orphan-audit')",
          [randomUUID(), order.id, JSON.stringify([removed])],
        ),
      ),
      { code: '23514', constraint: 'errand_media_audit_final' },
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_errands.media_audits WHERE order_id=$1',
          [order.id],
        )
      ).rowCount,
      0,
      'An orphan audit cannot reserve the next media revision',
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query('TRUNCATE whaleu_community.errand_media_approval_bindings'),
      ),
      { code: '23514', message: 'Content approval evidence is immutable' },
      'Empty re-review evidence still rejects TRUNCATE',
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_errands.media_sets(order_id,revision,prior_revision,cause,public_media,private_media) SELECT order_id,2,1,'audit_subtraction',public_media,private_media FROM whaleu_errands.media_sets WHERE order_id=$1 AND revision=1`,
          [order.id],
        ),
      ),
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          "INSERT INTO whaleu_errands.media_audits(id,order_id,expected_revision,next_revision,removed,issuer,provenance_ref) VALUES($1,$2,1,2,$3::jsonb,'synthetic-raw-auditor','missing-retirement')",
          [randomUUID(), order.id, JSON.stringify([removed])],
        );
        await tx.query(
          "INSERT INTO whaleu_errands.media_sets(order_id,revision,prior_revision,cause,public_media,private_media) VALUES($1,2,1,'audit_subtraction',$2::jsonb,'[]'::jsonb)",
          [order.id, JSON.stringify([survivor])],
        );
        await tx.query(
          'UPDATE whaleu_errands.media_heads SET revision=2 WHERE order_id=$1',
          [order.id],
        );
      }),
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT revision FROM whaleu_errands.media_heads WHERE order_id=$1',
          [order.id],
        )
      ).rows[0].revision,
      '1',
    );
    const envelope = await f.app.get(DatabaseService).transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        return f.publications.subtractAudited(
          {
            orderId: order.id,
            expectedRevision: 1,
            removed: [removed],
            issuer: 'synthetic-auditor',
            provenanceRef: 'synthetic-errand-subtraction',
          },
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
    assert.equal(envelope.version, 2);
    if (envelope.version !== 2) assert.fail('Expected media-aware envelope');
    assert.equal(envelope.mediaRevision, 2);
    assert.deepEqual(envelope.publicMedia, [pub.fact]);
    assert.deepEqual(envelope.privateMedia, []);
    assert.equal(
      (
        await f.pool.query(
          'SELECT id FROM whaleu_media.bindings WHERE id=$1 AND detached_at IS NULL',
          [survivor.bindingId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.errand_retirements WHERE binding_id=$1 AND cause=$2',
          [removed.bindingId, 'audit_subtraction'],
        )
      ).rowCount,
      1,
    );
    for (const revision of [1, 2])
      assert.notEqual(
        (
          await request(http)
            .get(`${prefix}/orders/${order.id}/public0`)
            .set('Authorization', auth(publisher))
            .query({ revision })
        ).status,
        200,
      );
    assert.notEqual(
      (
        await request(http)
          .get(
            `${prefix}/orders/${order.id}/private0/bindings/${removed.bindingId}/display-v1`,
          )
          .set('Authorization', auth(publisher))
          .query({ revision: 2 })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.pool.query(
          `SELECT 1 FROM whaleu_media.upload_intents WHERE id=$1 AND state='ready'`,
          [pub.status.intentId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          `SELECT 1 FROM whaleu_media.upload_intents WHERE id=$1 AND state='cleanup_pending'`,
          [priv.status.intentId],
        )
      ).rowCount,
      1,
    );
    await approveErrand(f.pool, envelope);
    await f.app.get(DatabaseService).transaction(
      async (tx) => {
        await lockSafetyPolicy(tx, true);
        await f.media.currentFacts(order.id, 2, [survivor], tx);
        await f.app
          .get(ErrandContentReviewFacade)
          .bindMediaRevision(order.id, envelope, tx);
        await requireErrandMediaCurrent('order', order.id, tx);
      },
      { isolationLevel: 'read committed' },
    );
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query('TRUNCATE whaleu_community.errand_media_approval_bindings'),
      ),
      { code: '23514', message: 'Content approval evidence is immutable' },
      'Re-review evidence cannot be erased by TRUNCATE',
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_community.errand_media_approval_bindings WHERE order_id=$1 AND media_revision=2',
          [order.id],
        )
      ).rowCount,
      1,
    );
    const restored = await request(http)
      .get(`${prefix}/orders/${order.id}/public0`)
      .set('Authorization', auth(publisher))
      .query({ revision: 2 });
    ok(restored);
    assert.equal(restored.body.bindingId, survivor.bindingId);
    assert.notEqual(
      (
        await request(http)
          .get(`${prefix}/orders/${order.id}/public0`)
          .set('Authorization', auth(publisher))
          .query({ revision: 1 })
      ).status,
      200,
    );
  },
);
