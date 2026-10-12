/** Emitted ordinary App/Page/WXML -> real native gateway -> AppModule -> PG.
 * The only synthetic pieces are native platform callbacks and accepted fixture
 * sources. This does not assert WeChat physical-device/provider acceptance. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import request from 'supertest';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { postPinFixture } from '../support/post-pin-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

const credentials = (actor: SessionCredentials): SessionCredentials => ({
  accountId: actor.accountId,
  sessionId: actor.sessionId,
  accessToken: actor.accessToken,
  refreshToken: actor.refreshToken,
  expiresAt: actor.expiresAt,
  refreshExpiresAt: actor.refreshExpiresAt,
});

test(
  'emitted owner visibility: My Publications/detail, loss, independent cold recovery, exact retry/cancel and account/origin isolation',
  { timeout: 240000 },
  async (t) => {
    const f = await postPinFixture();
    t.after(() => f.close());
    const owner = await f.actor(),
      reader = await f.actor();
    const post = await f.publish(owner);
    for (const actor of [owner, reader]) {
      const profile = await request(f.app.getHttpServer())
        .get('/v1/me/profile')
        .set('Authorization', `Bearer ${actor.accessToken}`);
      assert.equal(profile.status, 200, JSON.stringify(profile.body));
      const campus = await request(f.app.getHttpServer())
        .put('/v1/me/campus')
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send({
          campusId: f.scope.home.campusId,
          expectedRevision: profile.body.revision,
        });
      assert.equal(campus.status, 200, JSON.stringify(campus.body));
    }
    const originalPost = (
      await f.pool.query(
        'SELECT to_jsonb(p) value FROM whaleu_community.posts p WHERE id=$1',
        [post.id],
      )
    ).rows[0]!.value;
    const originalReceipts = (
      await f.pool.query(
        'SELECT to_jsonb(r) value FROM whaleu_community.publication_requests r ORDER BY account_id,client_request_id',
      )
    ).rows;
    const originalOutbox = (
      await f.pool.query(
        'SELECT to_jsonb(o) value FROM whaleu_community.outbox o ORDER BY id',
      )
    ).rows;
    const child = fork(
      fileURLToPath(
        new URL('./owner-post-visibility-native-worker.mjs', import.meta.url),
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
    child.stdout?.resume();
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
            if (name !== 'moderation-hold' && name !== 'moderation-release') {
              reject(
                Error(
                  `Unexpected owner visibility checkpoint: ${String(name)}`,
                ),
              );
              return;
            }
            void withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'UPDATE whaleu_community.posts SET visibility=$2 WHERE id=$1',
                [post.id, name === 'moderation-hold' ? 'hidden' : 'approved'],
              ),
            ).then(() => child.send({ event: 'continue', name }), reject);
          } else if (value['event'] === 'failure') {
            finished = true;
            reject(Error(String(value['message'])));
          } else if (value['event'] === 'done') {
            finished = true;
            resolve(value);
          }
        });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (!finished)
            reject(Error(`Owner visibility native exit ${code}: ${logs}`));
        });
        child.send({
          port: f.port,
          owner: credentials(owner),
          reader: credentials(reader),
          postId: post.id,
        });
      },
    );
    assert.ok(Number(done['commands']) >= 7);
    assert.ok(Number(done['receiptReads']) >= 5);
    assert.ok(Number(done['httpCalls']) >= 30);
    const auth = `Bearer ${owner.accessToken}`;
    for (const key of ['cancelledRequestId', 'cancelRaceRequestId']) {
      const receipt = await request(f.app.getHttpServer())
        .get('/v1/me/community/owner-visibility-requests/' + String(done[key]))
        .set('Authorization', auth);
      assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
      if (key === 'cancelledRequestId')
        assert.equal(receipt.body.code, 'POST_OWNER_VISIBILITY_CANCELLED');
      else
        assert.equal(
          receipt.body.outcome,
          'applied',
          'Cancel racing an already committed command returns its original receipt',
        );
    }
    const state = await request(f.app.getHttpServer())
      .get(`/v1/me/community/posts/${post.id}/owner-visibility`)
      .set('Authorization', auth);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.equal(state.body.ownerHidden, false);
    assert.equal(
      (
        await f.pool.query(
          'SELECT to_jsonb(p) value FROM whaleu_community.posts p WHERE id=$1',
          [post.id],
        )
      ).rows[0]!.value.visibility,
      'approved',
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(p) value FROM whaleu_community.posts p WHERE id=$1',
          [post.id],
        )
      ).rows[0]!.value,
      originalPost,
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(r) value FROM whaleu_community.publication_requests r ORDER BY account_id,client_request_id',
        )
      ).rows,
      originalReceipts,
    );
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(o) value FROM whaleu_community.outbox o ORDER BY id',
        )
      ).rows,
      originalOutbox,
    );
    t.diagnostic(
      `Real emitted owner visibility journey: ${String(done['commands'])} command dispatches, ${String(done['receiptReads'])} original-key recovery reads, ${String(done['httpCalls'])} authenticated loopback requests.`,
    );
  },
);
