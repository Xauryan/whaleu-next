import { randomUUID } from 'node:crypto';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { postPinFixture } from '../support/post-pin-fixture.js';
const credentials = (a: SessionCredentials): SessionCredentials => ({
  accountId: a.accountId,
  sessionId: a.sessionId,
  accessToken: a.accessToken,
  refreshToken: a.refreshToken,
  expiresAt: a.expiresAt,
  refreshExpiresAt: a.refreshExpiresAt,
});
test(
  'emitted post-pin App/Page/WXML → ordinary AppModule/PG; distinct read/dismissal, renewal, lost response, restart/cancel and lifecycle',
  { timeout: 180000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const admin = await f.actor(),
      reader = await f.actor();
    await f.grant(admin.accountId, 'school_admin', f.scope.home.regionId);
    await f.bind(f.scope.home.spaceId, 'regional', f.scope.home.regionId);
    const post = await f.publish(admin);
    await f.publish(admin);
    const feedbackSpace = randomUUID();
    await withCommunityScopeWriter(f.pool, async (tx) => {
      await tx.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic feedback pins',true)",
        [feedbackSpace],
      );
      await tx.query(
        "INSERT INTO whaleu_community.feedback_topic(topic,space_id,provenance,source_reference) VALUES('feedback',$1,'accepted','synthetic-native-pin-topic')",
        [feedbackSpace],
      );
    });
    await f.bind(feedbackSpace, 'feedback', null);
    await f.grant(admin.accountId, 'super_admin');
    const feedback = await f.publish(admin, feedbackSpace, 'feedback');
    const feedbackPin = await request(f.app.getHttpServer())
      .post('/v1/community/post-pin-commands')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        clientRequestId: randomUUID(),
        operation: 'pin',
        postId: feedback.id,
      });
    assert.equal(feedbackPin.status, 200, JSON.stringify(feedbackPin.body));

    for (const actor of [admin, reader]) {
      const profile = await request(f.app.getHttpServer())
        .get('/v1/me/profile')
        .set('Authorization', `Bearer ${actor.accessToken}`);
      assert.equal(profile.status, 200, JSON.stringify(profile.body));
      const result = await request(f.app.getHttpServer())
        .put('/v1/me/campus')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({
          campusId: f.scope.home.campusId,
          expectedRevision: profile.body.revision,
        });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const child = fork(
      fileURLToPath(
        new URL('../support/post-pins-native-worker.mjs', import.meta.url),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
      },
    );
    t.after(() => {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) child.kill();
    });
    let logs = '';
    child.stderr?.on('data', (data) => {
      logs += String(data);
    });
    const done = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        let finished = false;
        child.on('message', (raw) => {
          const value = raw as Record<string, unknown>;
          if (value['event'] === 'checkpoint') {
            const name = value['name'];
            if (
              name !== 'hide-pending-target' &&
              name !== 'restore-pending-target'
            ) {
              reject(Error('Unknown pin-native checkpoint'));
              return;
            }
            void withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'UPDATE whaleu_community.posts SET visibility=$2 WHERE id=$1',
                [
                  post.id,
                  name === 'hide-pending-target' ? 'hidden' : 'approved',
                ],
              ),
            ).then(() => child.send({ event: 'continue', name }), reject);
            return;
          }
          if (value['event'] === 'failure') {
            finished = true;
            reject(Error(String(value['message'])));
          }
          if (value['event'] === 'done') {
            finished = true;
            resolve(value);
          }
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (!finished) reject(Error(`Post pin native exit ${code}: ${logs}`));
        });
        child.send({
          port: f.port,
          admin: credentials(admin),
          reader: credentials(reader),
          postId: post.id,
          feedbackPostId: feedback.id,
          feedbackPinId: feedbackPin.body.pinId,
        });
      },
    );
    assert.ok(Number(done['nativeCommands']) >= 8);
    assert.ok(Number(done['receiptReads']) >= 2);
    const cancelled = await request(f.app.getHttpServer())
      .get(
        '/v1/me/community/post-pin-requests/' +
          String(done['cancelledRequestId']),
      )
      .set('Authorization', `Bearer ${admin.accessToken}`);
    assert.equal(cancelled.body.code, 'POST_PIN_CANCELLED');
    const list = await request(f.app.getHttpServer())
      .get('/v1/community/post-pins')
      .query({ spaceId: f.scope.home.spaceId })
      .set('Authorization', `Bearer ${reader.accessToken}`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 0);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::integer n FROM whaleu_community.comment_pins',
        )
      ).rows[0].n,
      0,
    );
  },
);
