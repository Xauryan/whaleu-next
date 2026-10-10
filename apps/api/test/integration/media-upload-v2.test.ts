import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { directoryRuntimeFixture } from '../support/directory-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { mediaRequestHash } from '../../src/media/contracts-v2.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { postApprovalEnvelope } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

function prepareInput(spaceId: string, bytes: Buffer, mime = 'image/png') {
  return {
    clientRequestId: randomUUID(),
    purpose: 'community-post-image',
    draftId: randomUUID(),
    spaceId,
    slot: 'images',
    ordinal: 0,
    declaration: { mime, bytes: bytes.length, sha256: sha256(bytes) },
  };
}
test(
  'ordinary AppModule all v2 operations authenticate but allocate no ingress capability',
  { timeout: 120000 },
  async () => {
    const f = await directoryRuntimeFixture();
    try {
      const actor = await f.actor(),
        id = randomUUID();
      const routes: [string, string, Record<string, unknown> | undefined][] = [
        [
          'post',
          '/v2/media/upload-intents',
          prepareInput(f.scope.home.spaceId, Buffer.from('x')),
        ],
        ['get', `/v2/media/upload-requests/${id}`, undefined],
        [
          'post',
          `/v2/media/upload-requests/${id}/cancel`,
          { requestHash: 'a'.repeat(64) },
        ],
        ['get', `/v2/media/upload-intents/${id}`, undefined],
        ['post', `/v2/media/upload-intents/${id}/grant`, {}],
        ['post', `/v2/media/upload-intents/${id}/finalize`, {}],
        ['post', `/v2/media/upload-intents/${id}/cancel`, {}],
      ];
      for (const [method, path, body] of routes) {
        for (const authorized of [false, true]) {
          let call =
            method === 'get'
              ? request(f.app.getHttpServer()).get(path)
              : request(f.app.getHttpServer()).post(path);
          if (authorized)
            call = call.set('Authorization', `Bearer ${actor.accessToken}`);
          if (body !== undefined) call = call.send(body);
          const response = await call;
          assert.equal(
            response.status,
            authorized ? 503 : 401,
            JSON.stringify(response.body),
          );
          assert.equal(response.headers['cache-control'], 'private, no-store');
          assert.match(response.headers['vary'] ?? '', /Authorization/);
        }
      }
      for (const authorized of [false, true]) {
        let call = request(f.app.getHttpServer()).post(
          `/v2/media/upload-intents/${id}/uploads/${randomUUID()}`,
        );
        if (authorized)
          call = call.set('Authorization', `Bearer ${actor.accessToken}`);
        const response = await call.attach('file', Buffer.from('x'), {
          filename: 'x.png',
          contentType: 'image/png',
        });
        assert.equal(response.status, authorized ? 503 : 401);
      }
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.upload_ingress'))
          .rowCount,
        0,
      );
      assert.equal(
        (await f.pool.query('SELECT 1 FROM whaleu_media.upload_request_fences'))
          .rowCount,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'real HTTP multipart PNG/JPEG → exact observation → sharp/Review → atomic publication/read and recovery',
  { timeout: 240000 },
  async (t) => {
    const sharp = (await import('sharp')).default;
    const fixtures = await Promise.all(
      (['png', 'jpeg'] as const).map(async (format) => ({
        mime: format === 'png' ? 'image/png' : 'image/jpeg',
        bytes: await sharp({
          create: {
            width: 800,
            height: 600,
            channels: 3,
            background: { r: 20, g: 100, b: 160 },
          },
        })
          .toFormat(format)
          .withMetadata({ orientation: 6 })
          .toBuffer(),
      })),
    );
    const f = await syntheticMediaRuntimeFixture(
      fixtures.map(({ bytes }) => ({
        sha256: sha256(bytes),
        verdict: 'allow',
      })),
    );
    try {
      const actor = await f.actor(),
        other = await f.actor(),
        http = f.app.getHttpServer();
      const auth = `Bearer ${actor.accessToken}`;
      await seedReviewPolicy(f.pool);
      for (const fixture of fixtures)
        await t.test(fixture.mime, async () => {
          const input = prepareInput(
            f.scope.home.spaceId,
            fixture.bytes,
            fixture.mime,
          );
          const prepared = await request(http)
            .post('/v2/media/upload-intents')
            .set('Authorization', auth)
            .send(input);
          assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
          const id = prepared.body.intentId as string;
          assert.equal(
            prepared.body.requestHash,
            mediaRequestHash(actor.accountId, input),
          );
          const recovered = await request(http)
            .get(`/v2/media/upload-requests/${input.clientRequestId}`)
            .set('Authorization', auth);
          assert.equal(recovered.body.status.intentId, id);
          const cross = await request(http)
            .get(`/v2/media/upload-requests/${input.clientRequestId}`)
            .set('Authorization', `Bearer ${other.accessToken}`);
          assert.equal(cross.body.state, 'not_recorded');
          const grant = await request(http)
            .post(`/v2/media/upload-intents/${id}/grant`)
            .set('Authorization', auth)
            .send({});
          assert.equal(grant.status, 200, JSON.stringify(grant.body));
          const path = `/v2/media/upload-intents/${id}/uploads/${grant.body.grantId}`;
          const uploaded = await request(http)
            .post(path)
            .set('Authorization', auth)
            .attach('file', fixture.bytes, {
              filename: 'ignored-name',
              contentType: fixture.mime,
            });
          assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
          assert.equal(uploaded.body.status, 'uploadObserved');
          assert.equal(uploaded.body.sha256, sha256(fixture.bytes));
          const observed = await request(http)
            .get(`/v2/media/upload-intents/${id}`)
            .set('Authorization', auth);
          assert.equal(observed.body.status, 'uploaded');
          const replay = await request(http)
            .post(path)
            .set('Authorization', auth)
            .attach('file', fixture.bytes, {
              filename: 'ignored-name',
              contentType: fixture.mime,
            });
          assert.notEqual(replay.status, 200);
          const finalize = await request(http)
            .post(`/v2/media/upload-intents/${id}/finalize`)
            .set('Authorization', auth)
            .send({});
          assert.equal(finalize.status, 200, JSON.stringify(finalize.body));
          for (const stage of ['seal', 'process', 'review'] as const)
            assert.equal(await f.worker.runOne(stage), true);
          const ready = await request(http)
            .get(`/v2/media/upload-intents/${id}`)
            .set('Authorization', auth);
          assert.equal(
            ready.body.status,
            'ready_unbound',
            JSON.stringify(ready.body),
          );
          assert.equal(
            ready.body.bindBefore,
            Math.min(ready.body.readyRetentionUntil, ready.body.draftExpiresAt),
          );
          const assetId = ready.body.assetId as string;
          const body = {
            clientRequestId: randomUUID(),
            spaceId: f.scope.home.spaceId,
            category: 'discussion' as const,
            text: 'Actual multipart single image',
            imageAssetIds: [assetId],
            authorMode: 'named' as const,
            commentsPolicy: 'open' as const,
          };
          const unapproved = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send(body);
          assert.equal(unapproved.status, 503);
          const asset = (
            await f.pool.query<{ manifest_digest: string }>(
              'SELECT manifest_digest FROM whaleu_media.assets WHERE id=$1',
              [assetId],
            )
          ).rows[0]!;
          const envelope = await postApprovalEnvelope(
            f.app,
            f.pool,
            actor.accountId,
            body,
          );
          await approveEnvelope(f.pool, {
            ...envelope,
            images: [{ assetId, digest: asset.manifest_digest }],
          });
          const published = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send(body);
          assert.equal(published.status, 201, JSON.stringify(published.body));
          const replayPublication = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth)
            .send(body);
          assert.deepEqual(replayPublication.body, published.body);
          const history = await request(http)
            .get(`/v2/media/upload-intents/${id}`)
            .set('Authorization', auth);
          assert.equal(history.body.status, 'bound_history');
          const cancelled = await request(http)
            .post(`/v2/media/upload-intents/${id}/cancel`)
            .set('Authorization', auth)
            .send({});
          assert.equal(cancelled.body.result, 'bound_history');
          const download = await request(http)
            .get(`/v1/media/bindings/${history.body.bindingId}/display-v1`)
            .set('Authorization', auth);
          assert.equal(download.status, 200);
          const variant = (
            await f.pool.query<{ sha256: string }>(
              "SELECT sha256 FROM whaleu_media.variants WHERE asset_id=$1 AND variant_name='display-v1'",
              [assetId],
            )
          ).rows[0]!;
          assert.equal(sha256(download.body as Buffer), variant.sha256);
          const metadata = await sharp(download.body as Buffer).metadata();
          assert.equal(metadata.exif, undefined);
          assert.equal(metadata.orientation, undefined);
          await withCommunityScopeWriter(f.pool, async (tx) => {
            const revision =
              Number(
                (
                  await tx.query<{ revision: string }>(
                    'SELECT revision FROM whaleu_media.asset_safety_heads WHERE asset_id=$1 FOR UPDATE',
                    [assetId],
                  )
                ).rows[0]!.revision,
              ) + 1;
            const event = randomUUID();
            await tx.query(
              `INSERT INTO whaleu_media.asset_safety_events
          (id,asset_id,revision,state,manifest_digest,policy_revision,issuer,source_reference,provenance,effective_at,valid_until)
          VALUES($1,$2,$3,'revoked',$4,'media-static-v1','registered-synthetic-media',$5,'{}',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
              [
                event,
                assetId,
                revision,
                asset.manifest_digest,
                `revoked:${event}`,
              ],
            );
            await tx.query(
              'UPDATE whaleu_media.asset_safety_heads SET revision=$2,event_id=$3 WHERE asset_id=$1',
              [assetId, revision, event],
            );
          });
          const denied = await request(http)
            .get(`/v1/media/bindings/${history.body.bindingId}/display-v1`)
            .set('Authorization', auth);
          assert.notEqual(denied.status, 200);
          const afterRevocation = await request(http)
            .get(`/v2/media/upload-intents/${id}`)
            .set('Authorization', auth);
          assert.equal(afterRevocation.body.status, 'bound_history');
          assert.equal(afterRevocation.body.width, undefined);
          const binding = (
            await f.pool.query<{ resource_id: string }>(
              'SELECT resource_id FROM whaleu_media.bindings WHERE id=$1',
              [history.body.bindingId],
            )
          ).rows[0]!;
          const deleted = await request(http)
            .delete(`/v1/community/posts/${binding.resource_id}`)
            .set('Authorization', auth);
          assert.equal(deleted.status, 204, JSON.stringify(deleted.body));
          const detached = await request(http)
            .get(`/v2/media/upload-intents/${id}`)
            .set('Authorization', auth);
          assert.equal(detached.body.status, 'bound_history');
          assert.equal(detached.body.attachmentState, 'detached');
          const detachedCancel = await request(http)
            .post(`/v2/media/upload-intents/${id}/cancel`)
            .set('Authorization', auth)
            .send({});
          assert.equal(detachedCancel.body.result, 'bound_history');
        });
      await t.test(
        'cancel before prepare creates an actor/hash fence and late prepare cannot allocate',
        async () => {
          const input = prepareInput(f.scope.home.spaceId, fixtures[0]!.bytes);
          const hash = mediaRequestHash(actor.accountId, input);
          const cancel = await request(http)
            .post(`/v2/media/upload-requests/${input.clientRequestId}/cancel`)
            .set('Authorization', auth)
            .send({ requestHash: hash });
          assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
          assert.equal(cancel.body.state, 'terminal');
          const late = await request(http)
            .post('/v2/media/upload-intents')
            .set('Authorization', auth)
            .send(input);
          assert.notEqual(late.status, 200);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2',
                [actor.accountId, input.clientRequestId],
              )
            ).rowCount,
            0,
          );
          const conflict = await request(http)
            .post(`/v2/media/upload-requests/${input.clientRequestId}/cancel`)
            .set('Authorization', auth)
            .send({ requestHash: '0'.repeat(64) });
          assert.notEqual(conflict.status, 200);
        },
      );
      await t.test(
        'real parser rejects malformed endings, extra files, part headers and oversized wire',
        async () => {
          const image = fixtures[0]!.bytes;
          const boundary = 'whaleu-boundary-fixture';
          const prefix = Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored.png"\r\nContent-Type: image/png\r\n\r\n`,
          );
          const end = Buffer.from(`\r\n--${boundary}--\r\n`);
          const cases = [
            {
              name: 'missing-closing-boundary',
              body: Buffer.concat([prefix, image]),
            },
            {
              name: 'malformed-closing-boundary',
              body: Buffer.concat([
                prefix,
                image,
                Buffer.from(`\r\n--${boundary}-broken\r\n`),
              ]),
            },
            {
              name: 'second-file',
              body: Buffer.concat([
                prefix,
                image,
                Buffer.from('\r\n'),
                prefix,
                image,
                end,
              ]),
            },
            {
              name: 'part-header-over-16k',
              body: Buffer.concat([
                Buffer.from(
                  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored.png"\r\nX-Header: ${'a'.repeat(16 * 1024)}\r\nContent-Type: image/png\r\n\r\n`,
                ),
                image,
                end,
              ]),
            },
            {
              name: 'epilogue-over-wire-budget',
              body: Buffer.concat([
                prefix,
                image,
                end,
                Buffer.alloc(5242880 + 65536, 65),
              ]),
            },
            {
              name: 'file-over-5mib',
              body: Buffer.concat([prefix, Buffer.alloc(5242881, 65), end]),
            },
          ];
          for (const invalid of cases) {
            const malformedActor = await f.actor();
            const auth = `Bearer ${malformedActor.accessToken}`;
            const input = prepareInput(f.scope.home.spaceId, image);
            const prepared = await request(http)
              .post('/v2/media/upload-intents')
              .set('Authorization', auth)
              .send(input);
            assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
            const id = prepared.body.intentId as string;
            const grant = await request(http)
              .post(`/v2/media/upload-intents/${id}/grant`)
              .set('Authorization', auth)
              .send({});
            assert.equal(grant.status, 200, JSON.stringify(grant.body));
            await request(http)
              .post(
                `/v2/media/upload-intents/${id}/uploads/${grant.body.grantId}`,
              )
              .set('Authorization', auth)
              .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
              .send(invalid.body)
              .then(
                (response) =>
                  assert.notEqual(response.status, 200, invalid.name),
                () => undefined,
              );
            assert.equal(
              (
                await f.pool.query(
                  "SELECT 1 FROM whaleu_media.object_attempts WHERE intent_id=$1 AND state='observed'",
                  [id],
                )
              ).rowCount,
              0,
              invalid.name,
            );
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
                  [id],
                )
              ).rowCount,
              0,
              invalid.name,
            );
            const cancelled = await request(http)
              .post(`/v2/media/upload-intents/${id}/cancel`)
              .set('Authorization', auth)
              .send({});
            assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
          }
        },
      );
      await t.test(
        'trailing field, wrong field, empty and different same-size bytes never observe',
        async () => {
          for (const mode of [
            'trailing-field',
            'wrong-field',
            'empty',
            'wrong-digest',
          ] as const) {
            const malformedActor = await f.actor();
            const auth = `Bearer ${malformedActor.accessToken}`;
            const input = prepareInput(
              f.scope.home.spaceId,
              fixtures[0]!.bytes,
            );
            const prepared = await request(http)
              .post('/v2/media/upload-intents')
              .set('Authorization', auth)
              .send(input);
            assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
            const id = prepared.body.intentId as string;
            const grant = await request(http)
              .post(`/v2/media/upload-intents/${id}/grant`)
              .set('Authorization', auth)
              .send({});
            assert.equal(grant.status, 200, JSON.stringify(grant.body));
            const bytes =
              mode === 'empty'
                ? Buffer.alloc(0)
                : Buffer.from(fixtures[0]!.bytes);
            if (mode === 'wrong-digest')
              bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
            let upload = request(http)
              .post(
                `/v2/media/upload-intents/${id}/uploads/${grant.body.grantId}`,
              )
              .set('Authorization', auth)
              .attach(mode === 'wrong-field' ? 'other' : 'file', bytes, {
                filename: 'photo.png',
                contentType: 'image/png',
              });
            if (mode === 'trailing-field')
              upload = upload.field('key', 'forbidden');
            await upload.then(
              (response) => assert.notEqual(response.status, 200),
              () => undefined,
            );
            const attempts = await f.pool.query<{ state: string }>(
              'SELECT state FROM whaleu_media.object_attempts WHERE intent_id=$1',
              [id],
            );
            assert.equal(
              attempts.rows.some((row) => row.state === 'observed'),
              false,
            );
            const cancel = await request(http)
              .post(`/v2/media/upload-intents/${id}/cancel`)
              .set('Authorization', auth)
              .send({});
            assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
