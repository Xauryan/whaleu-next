import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { finished } from 'node:stream/promises';
import request from 'supertest';
import { adminPostRemovalFixture } from '../support/admin-post-removal-fixture.js';
import { profileOk } from '../support/media/profile-runtime-fixture.js';

test(
  'muted viewer receives existing media but suspension during paused storage denies final bytes without hiding the author',
  { timeout: 240000 },
  async (t) => {
    const f = await adminPostRemovalFixture(true);
    t.after(() => f.close());
    const admin = await f.actor(),
      viewer = await f.actor(),
      author = await f.actor(),
      other = await f.actor();
    await f.grant(admin, 'super_admin', null);
    const mediaPost = await f.publish(author, {}, true);
    const muteSource = await f.publish(viewer),
      suspensionSource = await f.publish(viewer);
    const binding = (
      await f.pool.query<{ id: string }>(
        "SELECT id FROM whaleu_media.bindings WHERE owner_kind='community' AND resource_id=$1 AND detached_at IS NULL",
        [mediaPost.id],
      )
    ).rows[0]!;
    const path = `/v1/media/bindings/${binding.id}/display-v1`;
    const read = (token: string) =>
      request(f.app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${token}`);
    const issue = async (
      source: typeof muteSource,
      kind: 'interaction_mute' | 'access_suspension',
    ) => {
      const view = await f.removalManagement(source, admin);
      const response = await request(f.http)
        .post('/v1/community/admin-post-removal/commands')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          ...f.removalCommand(source, view.targetVersion),
          version: 2,
          punishment: {
            kind,
            duration: { kind: 'finite', unit: 'hours', value: 2 },
            reason: 'Synthetic final media authorization race',
            expectedRevision: '0',
          },
        });
      profileOk(response);
      assert.equal(
        response.body.outcome,
        'applied',
        JSON.stringify(response.body),
      );
    };
    await issue(muteSource, 'interaction_mute');
    const muted = await read(viewer.accessToken);
    assert.equal(muted.status, 200, JSON.stringify(muted.body));
    assert.ok(Buffer.isBuffer(muted.body) && muted.body.length > 0);
    const originalOpen = f.storage.openExact.bind(f.storage);
    let entered = false,
      storageBytes = 0;
    let closedProbe: Promise<unknown> = Promise.resolve();
    const failures: unknown[] = [];
    f.storage.openExact = async (object, maximum) => {
      const opened = await originalOpen(object, maximum);
      if (!entered) {
        entered = true;
        opened.stream.pause();
        closedProbe = finished(opened.stream).catch(() => undefined);
        opened.stream.on('data', (chunk: Buffer) => {
          storageBytes += chunk.length;
        });
        // Storage has selected the bytes, but ExactMediaDelivery keeps them paused.
        // Record issuance failures separately: a swallowed provider error cannot pass.
        try {
          await issue(suspensionSource, 'access_suspension');
        } catch (error) {
          failures.push(error);
        }
      }
      return opened;
    };
    try {
      const denied = await read(viewer.accessToken);
      await closedProbe;
      assert.equal(entered, true);
      assert.deepEqual(failures, []);
      assert.equal(
        storageBytes,
        0,
        'Paused provider stream never emits selected bytes',
      );
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.equal(denied.body.error.code, 'SAFETY_ACCESS_SUSPENDED');
      assert.equal(
        Buffer.isBuffer(denied.body),
        false,
        'No previously selected bytes escape the second authorization',
      );
    } finally {
      f.storage.openExact = originalOpen;
    }
    const unaffected = await read(other.accessToken);
    assert.equal(unaffected.status, 200, JSON.stringify(unaffected.body));
    assert.deepEqual(
      unaffected.body,
      muted.body,
      'Viewer suspension does not revoke an unrelated author asset',
    );
    const fresh = await read(viewer.accessToken);
    assert.equal(fresh.status, 403, JSON.stringify(fresh.body));
    assert.equal(fresh.body.error.code, 'SAFETY_ACCESS_SUSPENDED');
    assert.equal(Buffer.isBuffer(fresh.body), false);
  },
);
