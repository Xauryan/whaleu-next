import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import sharp from 'sharp';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import { sha256 } from '../../src/media/processing/protocol.js';

const boundary = 'whaleu-live-stream-boundary';
const prefix = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`,
);
const end = Buffer.from(`\r\n--${boundary}--\r\n`);
function socketUpload(port: number, path: string, token: string) {
  let finish!: (value: { status: number; body: string }) => void;
  const result = new Promise<{ status: number; body: string }>((resolve) => {
    finish = resolve;
  });
  const socket = nodeRequest(
    {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      agent: false,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Transfer-Encoding': 'chunked',
      },
    },
    (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', () => finish({ status: 0, body: '' }));
      response.on('end', () =>
        finish({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    },
  );
  socket.on('error', () => finish({ status: 0, body: '' }));
  socket.on('close', () => finish({ status: 0, body: '' }));
  return { socket, result };
}
async function until(
  predicate: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail(message);
}

test(
  'real chunked multipart fences wire completion, cancellation, idle time and process writer capacity',
  { timeout: 90000 },
  async (t) => {
    const bytes = await sharp({
      create: {
        width: 80,
        height: 60,
        channels: 3,
        background: { r: 23, g: 98, b: 166 },
      },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    const sockets: ReturnType<typeof socketUpload>[] = [];
    try {
      const http = f.app.getHttpServer(),
        port = (http.address() as AddressInfo).port;
      const prepare = async () => {
        const actor = await f.actor();
        const body = {
          clientRequestId: randomUUID(),
          purpose: 'community-post-image',
          draftId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          slot: 'images',
          ordinal: 0,
          declaration: {
            mime: 'image/png',
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        };
        const prepared = await request(http)
          .post('/v2/media/upload-intents')
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(body);
        assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
        const id = prepared.body.intentId as string;
        const grant = await request(http)
          .post(`/v2/media/upload-intents/${id}/grant`)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({});
        assert.equal(grant.status, 200, JSON.stringify(grant.body));
        const transfer = socketUpload(
          port,
          `/v2/media/upload-intents/${id}/uploads/${grant.body.grantId}`,
          actor.accessToken,
        );
        sockets.push(transfer);
        return { ...transfer, actor, id };
      };
      const noObservation = async (id: string) => {
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_media.object_attempts WHERE intent_id=$1 AND state='observed'",
              [id],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_media.assets WHERE intent_id=$1',
              [id],
            )
          ).rowCount,
          0,
        );
      };
      const stopped = async (id: string) =>
        until(async () => {
          const rows = await f.pool.query<{ state: string }>(
            'SELECT w.state FROM whaleu_media.upload_ingress_writers w JOIN whaleu_media.object_attempts a ON a.id=w.object_attempt_id WHERE a.intent_id=$1',
            [id],
          );
          return rows.rows.length === 1 && rows.rows[0]!.state === 'retired';
        }, 'Actual request/parser completion must retire the process-owned writer');

      await t.test(
        'chunked valid request observes only after full HTTP end',
        async () => {
          const transfer = await prepare();
          let wrote!: () => void;
          const written = new Promise<void>((resolve) => {
            wrote = resolve;
          });
          const original = f.ingressStorage.write.bind(f.ingressStorage);
          f.ingressStorage.write = async (...args) => {
            const measurement = await original(...args);
            wrote();
            return measurement;
          };
          try {
            transfer.socket.write(Buffer.concat([prefix, bytes, end]));
            await Promise.race([
              written,
              transfer.result.then(() =>
                assert.fail('Request ended before deliberate HTTP end'),
              ),
            ]);
            await noObservation(transfer.id);
            transfer.socket.end();
            const response = await transfer.result;
            assert.equal(response.status, 200, response.body);
            assert.equal(JSON.parse(response.body).status, 'uploadObserved');
            await stopped(transfer.id);
          } finally {
            f.ingressStorage.write = original;
          }
        },
      );
      await t.test(
        'cancel after exact file completion before HTTP end prevents late observation',
        async () => {
          const transfer = await prepare();
          let wrote!: () => void;
          const written = new Promise<void>((resolve) => {
            wrote = resolve;
          });
          const original = f.ingressStorage.write.bind(f.ingressStorage);
          f.ingressStorage.write = async (...args) => {
            const measurement = await original(...args);
            wrote();
            return measurement;
          };
          try {
            transfer.socket.write(Buffer.concat([prefix, bytes, end]));
            await Promise.race([
              written,
              transfer.result.then(() =>
                assert.fail('Request prematurely settled'),
              ),
            ]);
            const cancelled = await request(http)
              .post(`/v2/media/upload-intents/${transfer.id}/cancel`)
              .set('Authorization', `Bearer ${transfer.actor.accessToken}`)
              .send({});
            assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
            assert.equal(cancelled.body.status.cleanup, 'retained');
            transfer.socket.end();
            assert.notEqual((await transfer.result).status, 200);
            await stopped(transfer.id);
            await noObservation(transfer.id);
          } finally {
            f.ingressStorage.write = original;
          }
        },
      );
      await t.test(
        'chunked epilogue exceeding whole-wire cap cannot launder a completed file',
        async () => {
          const transfer = await prepare();
          transfer.socket.end(
            Buffer.concat([
              prefix,
              bytes,
              end,
              Buffer.alloc(5242880 + 65536, 65),
            ]),
          );
          assert.notEqual((await transfer.result).status, 200);
          await stopped(transfer.id);
          await noObservation(transfer.id);
        },
      );
      await t.test(
        'two live process writers reject a third; real 15-second idle cutoff retires incomplete input',
        async () => {
          const first = await prepare(),
            second = await prepare(),
            third = await prepare();
          first.socket.write(prefix);
          second.socket.write(prefix);
          for (const held of [first, second])
            await until(
              async () =>
                (
                  await f.pool.query(
                    "SELECT 1 FROM whaleu_media.upload_ingress WHERE intent_id=$1 AND writer_state='writing'",
                    [held.id],
                  )
                ).rowCount === 1,
              'Held socket must reach durable admission',
            );
          third.socket.end(Buffer.concat([prefix, bytes, end]));
          const denied = await third.result;
          assert.notEqual(denied.status, 200);
          await noObservation(third.id);
          const start = Date.now();
          first.socket.destroy();
          await first.result;
          await stopped(first.id);
          // No fake clock/abort claim: wait for the actual server idle timer to
          // terminate this still-open network stream and its actual writer.
          const idleResult = await second.result;
          assert.notEqual(idleResult.status, 200);
          assert.ok(Date.now() - start >= 14000);
          await stopped(second.id);
          await noObservation(second.id);
        },
      );
    } finally {
      for (const transfer of sockets) transfer.socket.destroy();
      await Promise.allSettled(sockets.map((transfer) => transfer.result));
      await f.close();
    }
  },
);
