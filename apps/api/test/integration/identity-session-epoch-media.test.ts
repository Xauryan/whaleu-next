import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import type { PoolClient } from 'pg';
import { sha256 } from '../../src/media/processing/protocol.js';
import {
  privateMessageMediaFixture,
  readyPrivateMessageImage,
  approvePrivateMessageImage,
  privateMessageMediaPrefix,
  privateMessageMediaOk,
} from '../support/media/private-message-runtime-fixture.js';
import {
  rollbackOnly,
  sqlError,
  sqlRejected,
  staleEpoch,
} from '../support/epoch-authority-fixture.js';

// Existing local storage/provider harness, genuine persisted seal/process/review
// worker stages, real publication and participant binding. No old-ready upgrade.
test(
  '0180 private-message delivery hold rejects stale participant session after real worker publication',
  { timeout: 240000 },
  async (t) => {
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#39775d' },
    })
      .png()
      .toBuffer();
    const f = await privateMessageMediaFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    t.after(() => f.close());
    const sender = await f.actor(),
      peer = await f.actor();
    const opened = await f.open(sender, {
      kind: 'profile',
      profileId: peer.profileId,
    });
    const requestId = randomUUID();
    const ready = await readyPrivateMessageImage(
      f,
      sender,
      opened.conversationId,
      requestId,
      bytes,
    );
    await approvePrivateMessageImage(
      f,
      sender,
      opened.conversationId,
      requestId,
      ready.fact,
    );
    const sent = await f.post(
      sender,
      `conversations/${opened.conversationId}/images`,
      { clientRequestId: requestId, image: ready.fact },
    );
    privateMessageMediaOk(sent);
    assert.equal(sent.body.outcome, 'applied');
    const path = `${privateMessageMediaPrefix}/conversations/${opened.conversationId}/messages/${sent.body.messageId}`;
    const descriptor = await request(f.http)
      .get(path)
      .set('Authorization', `Bearer ${peer.accessToken}`);
    privateMessageMediaOk(descriptor);
    const binding = descriptor.body.bindingId as string;
    assert.ok(binding);
    const binary = await request(f.http)
      .get(`${path}/bindings/${binding}/display-v1`)
      .set('Authorization', `Bearer ${peer.accessToken}`);
    privateMessageMediaOk(binary);
    assert.match(String(binary.headers['content-type']), /^image\/png/);
    const persisted = (
      await f.pool.query(
        'SELECT to_jsonb(p) appearance,to_jsonb(b) binding,to_jsonb(m) message FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_messaging.messages m ON m.id=p.message_id WHERE p.binding_id=$1',
        [binding],
      )
    ).rows;
    assert.equal(persisted.length, 1);
    const hold = randomUUID();
    const write = (tx: PoolClient) =>
      tx.query(
        'INSERT INTO whaleu_media.private_message_delivery_holds(id,binding_id,account_id,session_id,plan_digest) VALUES($1,$2,$3,$4,$5)',
        [
          hold,
          binding,
          peer.accountId,
          peer.sessionId,
          sha256(Buffer.from('synthetic:epoch-hold-plan')),
        ],
      );
    await rollbackOnly(f.pool, async (tx) => {
      await tx.query('SAVEPOINT valid_participant');
      assert.equal((await write(tx)).rowCount, 1);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      await tx.query('ROLLBACK TO SAVEPOINT valid_participant');
      await tx.query('RELEASE SAVEPOINT valid_participant');
      await staleEpoch(tx, peer.accountId);
      await sqlRejected(
        tx,
        () => write(tx),
        sqlError(
          'Private delivery hold requires exact active participant binding',
        ),
      );
      assert.equal(
        (
          await tx.query(
            'SELECT 1 FROM whaleu_media.private_message_delivery_holds WHERE id=$1',
            [hold],
          )
        ).rowCount,
        0,
      );
    });
    assert.deepEqual(
      (
        await f.pool.query(
          'SELECT to_jsonb(p) appearance,to_jsonb(b) binding,to_jsonb(m) message FROM whaleu_media.private_message_appearances p JOIN whaleu_media.bindings b ON b.id=p.binding_id JOIN whaleu_messaging.messages m ON m.id=p.message_id WHERE p.binding_id=$1',
          [binding],
        )
      ).rows,
      persisted,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT 1 FROM whaleu_media.private_message_delivery_holds WHERE id=$1',
          [hold],
        )
      ).rowCount,
      0,
    );
  },
);
