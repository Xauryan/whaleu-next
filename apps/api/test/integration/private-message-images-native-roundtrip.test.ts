import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import request from 'supertest';
import {
  privateMessageMediaFixture,
  privateMessageMediaOk,
  privateMessageMediaPrefix,
} from '../support/media/private-message-runtime-fixture.js';
import { approveDm } from '../support/dm-owner-fixture.js';
import { canonicalDmEnvelope } from '../../src/community/content-review/dm-contracts.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { dmSendImageSchema } from '../../src/messaging/contracts.js';

test(
  'PM3 emitted App/Page/WXML → source-authorized private multipart/static reencode → exact Review → two-participant pixels, dropped response/OS restart, watermark/recall/hide/block',
  { timeout: 300000 },
  async (t) => {
    const png = await sharp({
      create: { width: 48, height: 48, channels: 3, background: '#426780' },
    })
      .png()
      .toBuffer();
    const f = await privateMessageMediaFixture([
      { sha256: sha256(png), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const actors = {
      sender: await f.actor(),
      peer: await f.actor(),
      stranger: await f.actor(),
      admin: await f.actor(),
    };
    await withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-private-image-admin')`,
        [randomUUID(), actors.admin.accountId, f.scope.home.regionId],
      ),
    );
    const postId = await f.publish(actors.peer, 'anonymous'),
      conversationId = (
        await f.open(actors.sender, { kind: 'post', postId }, 'anonymous')
      ).conversationId;
    const child = fork(
      fileURLToPath(
        new URL(
          '../support/private-message-images-native-worker.mjs',
          import.meta.url,
        ),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    let logs = '';
    child.stdout?.on('data', (v) => (logs += String(v)));
    child.stderr?.on('data', (v) => (logs += String(v)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const bytesPath = (messageId: unknown, bindingId: unknown) =>
      `${privateMessageMediaPrefix}/conversations/${conversationId}/messages/${String(messageId)}/bindings/${String(bindingId)}/display-v1`;
    const finished = new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const m = raw as Record<string, unknown>;
          if (m['event'] === 'failure') throw Error(String(m['message']));
          if (m['event'] === 'checkpoint') {
            const name = String(m['name']);
            if (name === 'process-image') {
              for (const kind of ['seal', 'process', 'review'] as const)
                assert.equal(await f.worker.runOne(kind), true);
              const deleted = await f.auth(
                request(f.http).delete(`/v1/community/posts/${postId}`),
                actors.peer,
              );
              assert.equal(deleted.status, 204);
            } else if (name === 'review-image') {
              const body = dmSendImageSchema.parse(m['body']),
                c = (
                  await f.pool.query(
                    'SELECT * FROM whaleu_messaging.conversations WHERE id=$1',
                    [conversationId],
                  )
                ).rows[0];
              await approveDm(
                f.pool,
                canonicalDmEnvelope({
                  version: 2,
                  purpose: 'send_private_message',
                  accountId: actors.sender.accountId,
                  clientRequestId: body.clientRequestId,
                  conversationId,
                  contextDigest: c.context_digest,
                  senderSlot: c.account0 === actors.sender.accountId ? 0 : 1,
                  participantModes: [c.mode0, c.mode1],
                  kind: 'image',
                  image: body.image,
                }),
              );
            } else if (name === 'verify-one') {
              for (const table of ['messages', 'events', 'outbox'])
                assert.equal(
                  Number(
                    (
                      await f.pool.query(
                        `SELECT count(*) n FROM whaleu_messaging.${table}`,
                      )
                    ).rows[0].n,
                  ),
                  1,
                );
              assert.equal(
                Number(
                  (
                    await f.pool.query(
                      'SELECT count(*) n FROM whaleu_media.private_message_appearances',
                    )
                  ).rows[0].n,
                ),
                1,
              );
              const row = (
                await f.pool.query(
                  'SELECT lifetime_sent FROM whaleu_messaging.participants WHERE conversation_id=$1 AND account_id=$2',
                  [conversationId, actors.sender.accountId],
                )
              ).rows[0];
              assert.equal(row.lifetime_sent, '1');
              const receipt = await f.get(
                actors.sender,
                `requests/${String(m['requestId'])}`,
              );
              privateMessageMediaOk(receipt);
              assert.equal(receipt.body.outcome, 'applied');
              assert.equal(receipt.body.operation, 'send_image');
            } else if (name === 'deny-stranger-admin') {
              // An unrelated active account and an explicit administrator flag remain nonparticipants.
              for (const a of [actors.stranger, actors.admin]) {
                const r = await request(f.http)
                  .get(bytesPath(m['messageId'], m['bindingId']))
                  .set('Authorization', `Bearer ${a.accessToken}`);
                assert.notEqual(r.status, 200);
                assert.match(String(r.headers['cache-control']), /no-store/);
              }
            } else if (name === 'later-unread') {
              assert.equal((await f.get(actors.peer, 'unread')).body.count, 0);
              privateMessageMediaOk(
                (await f.send(actors.peer, conversationId, 'Synthetic reply'))
                  .response,
              );
              privateMessageMediaOk(
                (
                  await f.send(
                    actors.sender,
                    conversationId,
                    'Arrival after observed watermark',
                  )
                ).response,
              );
              assert.equal((await f.get(actors.peer, 'unread')).body.count, 1);
            } else if (name === 'verify-retired') {
              const binding = (
                await f.pool.query(
                  'SELECT detached_at FROM whaleu_media.bindings WHERE id=$1',
                  [m['bindingId']],
                )
              ).rows[0];
              assert.ok(binding.detached_at);
              for (const a of [actors.sender, actors.peer]) {
                const h = await f.get(
                  a,
                  `conversations/${conversationId}/messages`,
                );
                privateMessageMediaOk(h);
                const image = h.body.items.find(
                  (x: { id: string }) => x.id === m['messageId'],
                );
                assert.equal(image.state, 'recalled');
                assert.equal('image' in image, false);
                assert.equal(image.text, null);
                const r = await request(f.http)
                  .get(bytesPath(m['messageId'], m['bindingId']))
                  .set('Authorization', `Bearer ${a.accessToken}`);
                assert.notEqual(r.status, 200);
              }
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT state FROM whaleu_messaging.outbox WHERE message_id=$1',
                    [m['messageId']],
                  )
                ).rows[0].state,
                'suppressed',
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT lifetime_sent FROM whaleu_messaging.participants WHERE conversation_id=$1 AND account_id=$2',
                    [conversationId, actors.sender.accountId],
                  )
                ).rows[0].lifetime_sent,
                '2',
              );
            } else if (name === 'verify-block') {
              const p = await request(f.http)
                .post(`${privateMessageMediaPrefix}/upload-intents`)
                .set('Authorization', `Bearer ${actors.sender.accessToken}`)
                .send({
                  protocol: 'private-message-media-v1',
                  clientRequestId: randomUUID(),
                  conversationId,
                  messageRequestId: randomUUID(),
                  declaration: {
                    mime: 'image/png',
                    bytes: png.length,
                    sha256: sha256(png),
                  },
                });
              assert.notEqual(p.status, 200);
              const sent = await f.send(
                actors.sender,
                conversationId,
                'Blocked synthetic text',
              );
              privateMessageMediaOk(sent.response);
              assert.equal(sent.response.body.code, 'DM_SEND_UNAVAILABLE');
              const h = await f.get(
                actors.sender,
                `conversations/${conversationId}/messages`,
              );
              privateMessageMediaOk(h);
              assert.ok(
                h.body.items.some((x: { state: string }) => x.state === 'text'),
              );
            } else throw Error('Unknown checkpoint ' + name);
            child.send({ event: 'continue', name });
          } else if (m['event'] === 'done') {
            assert.equal(m['uploads'], 1);
            assert.ok(Number(m['reads']) >= 2);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!done) reject(Error(`PM native exited ${code}: ${logs}`));
      });
    });
    child.send({
      port: f.port,
      actors,
      conversationId,
      png: png.toString('base64'),
    });
    await finished;
  },
);
