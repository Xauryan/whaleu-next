import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { windowRatingFixture } from '../support/window-rating-fixture.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
const credentials = (actor: SessionCredentials): SessionCredentials => ({
  accountId: actor.accountId,
  sessionId: actor.sessionId,
  accessToken: actor.accessToken,
  refreshToken: actor.refreshToken,
  expiresAt: actor.expiresAt,
  refreshExpiresAt: actor.refreshExpiresAt,
});
test(
  'emitted W1 App/Page/WXML → signed scoring, mutable current aggregate, stale CAS, receipt-first restart, durable cancellation and lifecycle fences through real HTTP/PostgreSQL',
  { timeout: 180000 },
  async (t) => {
    const f = await windowRatingFixture();
    t.after(() => f.close());
    const actor = await f.actor(),
      other = await f.actor({ affiliation: 'unverified', identity: false });
    const window = f.add({ name: 'Synthetic Native Mutable Window' }),
      unknown = f.add({
        name: 'Synthetic Unknown Window History',
        history: 'unknown',
      }),
      second = f.add({
        name: 'Synthetic Other Canteen Window',
        canteenId: randomUUID(),
        canteenRevision: randomUUID(),
        floorId: randomUUID(),
        canteenName: 'Synthetic Other Canteen',
      });
    const catalog = await f.accept([
      window,
      unknown,
      second,
      ...Array.from({ length: 21 }, (_, i) =>
        f.add({ name: `Synthetic Native Paging Window ${i}` }),
      ),
    ]);
    const child = fork(
      fileURLToPath(
        new URL('../support/window-ratings-native-worker.mjs', import.meta.url),
      ),
      [],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        execArgv: ['--import', 'tsx'],
        env: { ...process.env },
      },
    );
    let logs = '';
    child.stdout?.on('data', (value) => (logs += String(value)));
    child.stderr?.on('data', (value) => (logs += String(value)));
    t.after(() => {
      if (!child.killed) child.kill();
    });
    const checkpoints: string[] = [];
    let firstRequestId: string | undefined,
      cancelledRequestId: string | undefined;
    const score = async (expectedOwnScoreRevision: string, value: number) => {
      const response = await request(f.app.getHttpServer())
        .post(`/v1/ratings/windows/${window.id}/score`)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .send(
          f.command(catalog, window, {
            expectedOwnScoreRevision,
            score: value,
          }),
        );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.outcome, 'applied');
      return response.body as { scoreRevision: string };
    };
    await new Promise<void>((resolve, reject) => {
      let done = false;
      child.on('message', (raw: unknown) => {
        void (async () => {
          const message = raw as Record<string, unknown>;
          if (message['event'] === 'failure')
            throw Error(String(message['message']) + '\n' + logs);
          if (message['event'] === 'checkpoint') {
            const name = String(message['name']);
            checkpoints.push(name);
            if (name === 'first-committed') {
              firstRequestId = String(message['requestId']);
              const result = (
                await f.pool.query<{
                  id: string;
                  score: number;
                  request_id: string;
                }>(
                  'SELECT id,score,request_id FROM whaleu_ratings.window_score_events WHERE window_id=$1 AND actor_id=$2',
                  [window.id, actor.accountId],
                )
              ).rows;
              assert.equal(result.length, 1);
              assert.equal(result[0]!.score, -10);
              assert.equal(result[0]!.request_id, firstRequestId);
              await score(result[0]!.id, 7);
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
              );
            } else if (name === 'first-recovered') {
              assert.equal(message['requestId'], firstRequestId);
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
              );
            } else if (name === 'concurrent-edit') {
              await score(String(message['expectedRevision']), -4);
            } else if (name === 'cancel-committed') {
              cancelledRequestId = String(message['requestId']);
              const row = (
                await f.pool.query<{ receipt: { code: string } }>(
                  'SELECT receipt FROM whaleu_ratings.window_commands WHERE actor_id=$1 AND request_id=$2',
                  [actor.accountId, cancelledRequestId],
                )
              ).rows[0]!;
              assert.equal(row.receipt.code, 'WINDOW_SCORE_CANCELLED');
              await f.certify(actor.accountId, {
                affiliation: 'unverified',
                phone: 'unverified',
                identity: false,
              });
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
              );
            } else if (name === 'cancel-recovered') {
              assert.equal(message['requestId'], cancelledRequestId);
              await f.certify(actor.accountId);
              await f.pool.query(
                "UPDATE whaleu_ratings.window_catalog_head SET state='accepted'",
              );
            } else throw Error('Unknown window-native checkpoint ' + name);
            child.send({ event: 'continue', name });
          } else if (message['event'] === 'done') {
            done = true;
            assert.equal(message['firstRequestId'], firstRequestId);
            assert.equal(message['cancelledRequestId'], cancelledRequestId);
            assert.equal(message['nativeCommands'], 7);
            assert.ok(Number(message['receiptReads']) >= 4);
            assert.deepEqual(checkpoints, [
              'first-committed',
              'first-recovered',
              'concurrent-edit',
              'cancel-committed',
              'cancel-recovered',
            ]);
            const events = (
              await f.pool.query<{ score: number }>(
                'SELECT score FROM whaleu_ratings.window_score_events WHERE window_id=$1 AND actor_id=$2 ORDER BY recorded_at,id',
                [window.id, actor.accountId],
              )
            ).rows;
            assert.deepEqual(
              events.map((row) => row.score),
              [-10, 7, 0, 10, -4, 5],
            );
            const current = (
              await f.pool.query<{ score: number }>(
                'SELECT e.score FROM whaleu_ratings.window_score_heads h JOIN whaleu_ratings.window_score_events e ON e.id=h.revision WHERE h.window_id=$1',
                [window.id],
              )
            ).rows;
            assert.deepEqual(current, [{ score: 5 }]);
            assert.equal(
              (
                await f.pool.query<{ n: number }>(
                  'SELECT count(*)::int n FROM whaleu_ratings.window_commands WHERE window_id=$1',
                  [window.id],
                )
              ).rows[0]!.n,
              9,
            );
            const detail = await request(f.app.getHttpServer())
              .get(`/v1/ratings/windows/${window.id}`)
              .set('Authorization', `Bearer ${actor.accessToken}`);
            assert.equal(detail.status, 200);
            assert.deepEqual(detail.body.window.summary, {
              kind: 'known',
              ratingCount: 1,
              mean: 5,
            });
            assert.equal(detail.body.myScore.score, 5);
            done = true;
            resolve();
          }
        })().catch(reject);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!done)
          reject(Error(`Native window worker exited ${code}: ${logs}`));
      });
      child.send({
        port: f.port,
        actor: credentials(actor),
        other: credentials(other),
        windowId: window.id,
        unknownId: unknown.id,
        canteenId: window.canteenId,
        floorId: window.floorId,
      });
    });
  },
);
