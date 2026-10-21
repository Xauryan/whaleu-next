import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  syntheticProfileCoverRuntimeFixture,
  readyProfileCover,
  selectProfileCover,
  currentProfileCover,
  profileCoverCommandEnvelope,
  approveProfileCover,
  setProfileCoverReview,
  profileCoverOk,
} from '../support/media/profile-cover-runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import type { CoverCommand } from '../../src/profile/cover/contracts.js';
const command = (
  revision: number,
  source: CoverCommand['source'],
): CoverCommand => ({
  protocol: 'profile-cover-v1',
  clientRequestId: randomUUID(),
  expectedRevision: revision,
  source,
});

test(
  'independent cover upload, exact review, delivery, replacement and recovery preserve avatar and privacy',
  { timeout: 360000 },
  async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({
      create: { width: 160, height: 90, channels: 3, background: '#758b9e' },
    })
      .png()
      .toBuffer();
    const f = await syntheticProfileCoverRuntimeFixture([
      { sha256: sha256(png), verdict: 'allow' },
    ]);
    try {
      const http = f.app.getHttpServer(),
        actor = await f.actor(),
        stranger = await f.actor(),
        auth = `Bearer ${actor.accessToken}`;
      assert.equal(
        (await request(http).get('/v1/me/profile/cover')).status,
        401,
      );
      const caps = await request(http)
        .get('/v1/me/profile/cover-capabilities')
        .set('Authorization', auth);
      profileCoverOk(caps);
      assert.equal(caps.body.upload, 'available');
      const empty = await currentProfileCover(f, actor);
      assert.equal(empty.cover.state, 'none');
      assert.equal(empty.revision, 0);
      const ready = await readyProfileCover(f, actor, png);
      // Avatar codec and ownership cannot consume an independent cover edit.
      assert.equal(
        (
          await request(http)
            .get(`/v1/me/profile/avatar-edits/${ready.status.editId}`)
            .set('Authorization', auth)
        ).status,
        503,
      );
      assert.notEqual(
        (
          await request(http)
            .get(`/v1/me/profile/cover-edits/${ready.status.editId}`)
            .set('Authorization', `Bearer ${stranger.accessToken}`)
        ).status,
        200,
      );
      const select = command(0, {
        kind: 'custom',
        editId: ready.status.editId,
        assetId: ready.status.assetId,
      });
      const unapproved = await request(http)
        .post('/v1/me/profile/cover-commands')
        .set('Authorization', auth)
        .send(select);
      assert.notEqual(
        unapproved.status,
        200,
        'sanitized image is not selection review approval',
      );
      assert.equal(
        (await currentProfileCover(f, actor)).revision,
        0,
        'failed selection rolls back independent CAS',
      );
      const selected = await selectProfileCover(f, actor, select);
      assert.equal(selected.current.revision, 1);
      assert.equal(selected.current.cover.state, 'available');
      const profile = await request(http)
        .get('/v1/me/profile')
        .set('Authorization', auth);
      profileCoverOk(profile);
      assert.equal(
        profile.body.revision,
        0,
        'cover does not bump avatar/nickname CAS',
      );
      const avatar = await request(http)
        .get('/v1/me/profile/avatar')
        .set('Authorization', auth);
      profileCoverOk(avatar);
      assert.equal(avatar.body.avatar.state, 'none');
      const url = `/v1/profiles/${selected.current.profileId}/cover/${selected.current.cover.appearanceId}/display-v1`;
      const image = await request(http).get(url);
      profileCoverOk(image);
      assert.match(String(image.headers['cache-control']), /no-store/);
      assert.equal(
        (await request(http).get(url).set('Authorization', 'Bearer invalid'))
          .status,
        401,
        'invalid credential is not downgraded to guest',
      );
      const replay = await request(http)
        .post('/v1/me/profile/cover-commands')
        .set('Authorization', auth)
        .send(select);
      profileCoverOk(replay);
      assert.deepEqual(replay.body, selected.receipt);
      const stale = await request(http)
        .post('/v1/me/profile/cover-commands')
        .set('Authorization', auth)
        .send({ ...select, clientRequestId: randomUUID() });
      assert.equal(stale.status, 409);
      const clear = command(1, { kind: 'clear' });
      await approveProfileCover(
        f.pool,
        await profileCoverCommandEnvelope(f, actor, clear),
      );
      const cleared = await Promise.all(
        [1, 2].map(() =>
          request(http)
            .post('/v1/me/profile/cover-commands')
            .set('Authorization', auth)
            .send(clear),
        ),
      );
      for (const result of cleared) profileCoverOk(result);
      assert.deepEqual(cleared[0]!.body, cleared[1]!.body);
      assert.equal((await currentProfileCover(f, actor)).cover.state, 'none');
      const detached = await f.pool.query<{ detached: boolean }>(
        'SELECT detached_at IS NOT NULL AS detached FROM whaleu_media.bindings WHERE id=$1',
        [selected.current.cover.source?.bindingId],
      );
      assert.equal(
        detached.rows[0]?.detached,
        true,
        'cover removal atomically retires its exact binding',
      );
      const history = await request(http)
        .get(`/v1/me/profile/cover-edits/${ready.status.editId}`)
        .set('Authorization', auth);
      profileCoverOk(history);
      assert.equal(history.body.status, 'bound_history');
      assert.equal(history.body.attachmentState, 'detached');

      assert.notEqual(
        (await request(http).get(url)).status,
        200,
        'detached historical appearance never delivers',
      );
      const historical = await request(http)
        .post('/v1/me/profile/cover-commands')
        .set('Authorization', auth)
        .send(select);
      profileCoverOk(historical);
      assert.deepEqual(historical.body, selected.receipt);
      assert.equal(
        (await currentProfileCover(f, actor)).cover.state,
        'none',
        'historical replay cannot restore removed cover',
      );
      const ready2 = await readyProfileCover(f, actor, png),
        selected2 = await selectProfileCover(
          f,
          actor,
          command(2, {
            kind: 'custom',
            editId: ready2.status.editId,
            assetId: ready2.status.assetId,
          }),
        );
      const visibleUrl = `/v1/profiles/${selected2.current.profileId}/cover/${selected2.current.cover.appearanceId}/display-v1`;
      const block = await request(http)
        .put('/v1/me/safety/blocks')
        .set('Authorization', `Bearer ${stranger.accessToken}`)
        .send({
          clientRequestId: randomUUID(),
          source: { kind: 'profile', id: selected2.current.profileId },
          blocked: true,
        });
      profileCoverOk(block);
      assert.notEqual(
        (
          await request(http)
            .get(visibleUrl)
            .set('Authorization', `Bearer ${stranger.accessToken}`)
        ).status,
        200,
        'outgoing block prevents cover bytes',
      );
      assert.notEqual(
        (
          await request(http)
            .get(`/v1/profiles/${selected2.current.profileId}/cover`)
            .set('Authorization', `Bearer ${stranger.accessToken}`)
        ).status,
        200,
        'blocked profile projection cannot disclose cover',
      );
      await setProfileCoverReview(
        f.pool,
        selected2.approved.decisionId,
        'revoked',
      );
      assert.equal(
        (await currentProfileCover(f, actor)).cover.state,
        'unavailable',
      );
      const revokedUrl = `/v1/profiles/${selected2.current.profileId}/cover/${selected2.current.cover.appearanceId}/display-v1`;
      assert.notEqual((await request(http).get(revokedUrl)).status, 200);
    } finally {
      await f.close();
    }
  },
);
