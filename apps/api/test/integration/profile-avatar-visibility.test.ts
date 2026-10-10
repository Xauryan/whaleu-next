import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { NamedBlockService } from '../../src/safety/service.js';
import {
  syntheticProfileRuntimeFixture,
  seedSyntheticAvatarCatalog,
  selectProfileAvatar,
  profileOk,
} from '../support/media/profile-runtime-fixture.js';

test(
  'real Profile avatar principal qualification, bilateral relationships, empty active gate and catalog revocation',
  { timeout: 90000 },
  async () => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 16, height: 12, channels: 3, background: '#b68439' },
    })
      .png()
      .toBuffer();
    const f = await syntheticProfileRuntimeFixture([
      {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        verdict: 'allow',
      },
    ]);
    const http = f.app.getHttpServer();
    try {
      const author = await f.actor(),
        reader = await f.actor(),
        unverified = await f.actor({
          phone: 'unverified',
          affiliation: 'unverified',
        });
      const catalog = await seedSyntheticAvatarCatalog(
        f,
        bytes,
        'image/png',
        16,
        12,
      );
      const selected = await selectProfileAvatar(f, author, {
        protocol: 'profile-media-v1',
        clientRequestId: randomUUID(),
        expectedRevision: 0,
        source: {
          kind: 'catalog',
          catalogVersion: catalog.catalogVersion,
          itemId: catalog.itemId,
        },
      });
      const profileId = selected.current.profileId!;
      const path = `/v1/profiles/${profileId}/avatar`;
      const image = `${path}/${selected.current.avatar.appearanceId}/thumb-v1`;
      for (const token of [
        null,
        author.accessToken,
        reader.accessToken,
        unverified.accessToken,
      ]) {
        const response = token
          ? await request(http)
              .get(path)
              .set('Authorization', `Bearer ${token}`)
          : await request(http).get(path);
        profileOk(response);
        assert.equal(response.body.avatar.state, 'available');
        for (const secret of [
          author.accountId,
          reader.accountId,
          author.sessionId,
          reader.sessionId,
          'accountId',
          'sessionId',
          'phone',
          'object',
          'bucket',
        ])
          assert.equal(JSON.stringify(response.body).includes(secret), false);
        const downloaded = token
          ? await request(http)
              .get(image)
              .set('Authorization', `Bearer ${token}`)
          : await request(http).get(image);
        profileOk(downloaded);
        assert.deepEqual(downloaded.body, bytes);
      }
      for (const invalid of [
        '',
        'Bearer invalid',
        'Basic opaque',
        `Bearer ${author.accessToken} extra`,
      ]) {
        assert.equal(
          (await request(http).get(path).set('Authorization', invalid)).status,
          401,
        );
        assert.equal(
          (await request(http).get(image).set('Authorization', invalid)).status,
          401,
        );
      }
      const hide = await request(http)
        .patch('/v1/me/preferences')
        .set('Authorization', `Bearer ${author.accessToken}`)
        .send({ expectedRevision: 1, preferences: { hideProfilePosts: true } });
      profileOk(hide);
      profileOk(await request(http).get(image));
      assert.equal(
        (await request(http).get(path)).body.avatar.state,
        'available',
        'hideProfilePosts does not hide public avatar basics',
      );

      const blocks = f.app.get(NamedBlockService);
      const outgoing = await blocks.block(reader.accessToken, {
        clientRequestId: randomUUID(),
        source: { kind: 'profile', id: profileId },
        blocked: true,
      });
      assert.equal(outgoing.receipt.outcome, 'applied');
      assert.ok(outgoing.current);
      assert.notEqual(
        (
          await request(http)
            .get(path)
            .set('Authorization', `Bearer ${reader.accessToken}`)
        ).status,
        200,
      );
      assert.notEqual(
        (
          await request(http)
            .get(image)
            .set('Authorization', `Bearer ${reader.accessToken}`)
        ).status,
        200,
      );
      profileOk(await request(http).get(image), 200); // Guest public policy is not identity-aware blocking.
      await blocks.unblock(
        reader.accessToken,
        outgoing.current.relationshipId,
        {
          clientRequestId: randomUUID(),
          expectedRevision: outgoing.current.revision,
          blocked: false,
        },
      );
      profileOk(
        await request(http)
          .get(image)
          .set('Authorization', `Bearer ${reader.accessToken}`),
      );
      profileOk(
        await request(http)
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${reader.accessToken}`)
          .send({ expectedRevision: 0, nickname: 'avatar_reader' }),
      );
      const readerProfile = (
        await request(http)
          .get('/v1/me/profile/avatar')
          .set('Authorization', `Bearer ${reader.accessToken}`)
      ).body.profileId as string;
      const incoming = await blocks.block(author.accessToken, {
        clientRequestId: randomUUID(),
        source: { kind: 'profile', id: readerProfile },
        blocked: true,
      });
      assert.equal(incoming.receipt.outcome, 'applied');
      assert.ok(incoming.current);
      assert.notEqual(
        (
          await request(http)
            .get(path)
            .set('Authorization', `Bearer ${reader.accessToken}`)
        ).status,
        200,
      );
      profileOk(await request(http).get(image));
      await blocks.unblock(
        author.accessToken,
        incoming.current.relationshipId,
        {
          clientRequestId: randomUUID(),
          expectedRevision: incoming.current.revision,
          blocked: false,
        },
      );
      assert.notEqual(
        (
          await request(http).get(
            `/v1/profiles/${readerProfile}/avatar/${selected.current.avatar.appearanceId}/thumb-v1`,
          )
        ).status,
        200,
        'appearance is bound to its exact Profile owner',
      );

      await f.pool.query(
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [reader.accountId],
      );
      assert.notEqual(
        (await request(http).get(`/v1/profiles/${readerProfile}/avatar`))
          .status,
        200,
        'empty avatar does not bypass active target eligibility',
      );
      await f.pool.query(
        "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
        [reader.accountId],
      );
      assert.equal(
        (await request(http).get(`/v1/profiles/${readerProfile}/avatar`)).body
          .avatar.state,
        'none',
      );

      const open = f.storage.openExact.bind(f.storage);
      let revoked = false;
      f.storage.openExact = async (locator, maximum) => {
        const opened = await open(locator, maximum);
        if (!revoked) {
          revoked = true;
          await f.pool.query(
            'UPDATE whaleu_profile.avatar_catalog_items SET available=false WHERE catalog_version=$1 AND item_id=$2',
            [catalog.catalogVersion, catalog.itemId],
          );
        }
        return opened;
      };
      try {
        const response = await request(http).get(image);
        assert.notEqual(response.status, 200);
        assert.equal(
          Buffer.isBuffer(response.body),
          false,
          'catalog revocation between authorizations prevents image delivery',
        );
      } finally {
        f.storage.openExact = open;
      }
      assert.equal(revoked, true);
      const unavailable = await request(http).get(path);
      profileOk(unavailable);
      assert.deepEqual(unavailable.body.avatar, { state: 'unavailable' });
      const basics = await request(http).get(`/v1/profiles/${profileId}`);
      profileOk(basics);
      assert.equal(
        basics.body.status,
        'available',
        'unavailable avatar cannot hide public profile basics',
      );
      assert.equal(
        basics.body.avatar,
        null,
        'historical embedded avatar contract remains explicit',
      );
    } finally {
      await f.close();
    }
  },
);
